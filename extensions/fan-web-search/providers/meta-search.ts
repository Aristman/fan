import type { SearchProvider } from "./interface.js";
import type { SearchParams, SearchResult, MetaSearchProviderConfig, TlsConfig } from "../types.js";
import { fetch, createTlsDispatcher } from "../tls.js";

// ── Internal types ──

interface EngineResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface EngineProbeResult {
  id: string;
  available: boolean;
  resultCount: number;
  responseTimeMs: number;
  error?: string;
}

/** Backward-compatible alias for provider-chain.ts */
export interface MetaSearchEngineStatus {
  id: string;
  status: "available" | "unavailable";
  available: boolean;
  resultCount?: number;
  responseTimeMs?: number;
  error?: string;
}

interface SearchEngineConfig {
  id: string;
  searchUrl: string;
  userAgent: string;
  search(
    query: string,
    count: number,
    domainFilter?: string,
    signal?: AbortSignal,
    tlsConfig?: TlsConfig,
  ): Promise<EngineResult[]>;
  probe(signal?: AbortSignal, tlsConfig?: TlsConfig): Promise<EngineProbeResult>;
}

// ── Engine factory ──

function createMojeekEngine(config: MetaSearchProviderConfig): SearchEngineConfig {
  const engineConfig = config.engines.mojeek;
  const ua = config.userAgent;
  const probeTimeout = config.probeTimeoutMs;

  return {
    id: "mojeek",
    searchUrl: engineConfig.url,
    userAgent: ua,

    async search(query, count, domainFilter, signal, tlsConfig) {
      const searchQuery = domainFilter ? `site:${domainFilter} ${query}` : query;
      const res = await fetch(`${engineConfig.url}?q=${encodeURIComponent(searchQuery)}`, {
        dispatcher: createTlsDispatcher(tlsConfig),
        headers: {
          "User-Agent": ua,
          "Accept": "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal,
      });
      if (!res.ok) throw new Error(`Mojeek HTTP ${res.status}`);
      const html = await res.text();
      const results: EngineResult[] = [];

      // Parse result blocks: <!--rs--><li class="rN">...<!--re-->
      const blockRegex = /<!--rs--><li[^>]*>([\s\S]*?)<!--re-->/gi;
      let match: RegExpExecArray | null;

      while ((match = blockRegex.exec(html)) !== null && results.length < count) {
        const block = match[1];
        const obTagMatch = block.match(/<a[^>]*class="ob"[^>]*>/);
        if (!obTagMatch) continue;
        const hrefMatch = obTagMatch[0].match(/href="([^"]*)"/);
        if (!hrefMatch) continue;
        const url = hrefMatch[1];
        if (!url || url.startsWith("/") || url.includes("mojeek.com/search")) continue;
        const titleMatch = block.match(/<a[^>]*class="title"[^>]*>([\s\S]*?)<\/a>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        if (!title) continue;
        const snippetMatch = block.match(/<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/i);
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        results.push({ title, url, snippet, engine: "mojeek" });
      }

      return results;
    },

    async probe(signal, tlsConfig) {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), probeTimeout);
        const combinedSignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
        const results = await this.search("test query", 3, undefined, combinedSignal, tlsConfig);
        clearTimeout(timer);
        return {
          id: "mojeek", available: results.length > 0,
          resultCount: results.length, responseTimeMs: Date.now() - start,
        };
      } catch (err) {
        return {
          id: "mojeek", available: false, resultCount: 0,
          responseTimeMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ── URL normalization ──

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
    parsed.searchParams.delete("ref");
    let normalized = parsed.toString();
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized;
  } catch {
    return url.toLowerCase();
  }
}

// ── MetaSearchProvider ──

export class MetaSearchProvider implements SearchProvider {
  readonly id = "meta-search";
  readonly name = "Meta Search (Mojeek)";
  readonly requiresConfig = false;

  private engines: SearchEngineConfig[] = [];
  private engineProbeResults: Map<string, EngineProbeResult> = new Map();
  private availableEngineIds: Set<string> = new Set();
  private tlsConfig: TlsConfig | undefined;

  constructor(config: MetaSearchProviderConfig) {
    if (config.engines.mojeek.enabled) {
      this.engines.push(createMojeekEngine(config));
    }
  }

  setTlsConfig(config: TlsConfig) { this.tlsConfig = config; }

  async probe(signal?: AbortSignal): Promise<boolean> {
    const probes = await Promise.all(
      this.engines.map((engine) => engine.probe(signal, this.tlsConfig)),
    );

    this.engineProbeResults.clear();
    this.availableEngineIds.clear();

    for (const r of probes) {
      this.engineProbeResults.set(r.id, r);
      if (r.available) this.availableEngineIds.add(r.id);
    }

    return this.availableEngineIds.size > 0;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
    if (this.availableEngineIds.size === 0) {
      await this.probe(signal);
    }

    if (this.availableEngineIds.size === 0) {
      throw new Error("No meta-search engines available");
    }

    const availableEngines = this.engines.filter(e => this.availableEngineIds.has(e.id));
    const perEngine = Math.ceil(params.count / availableEngines.length);

    const settled = await Promise.allSettled(
      availableEngines.map(engine =>
        engine.search(params.query, perEngine, params.domainFilter, signal, this.tlsConfig),
      ),
    );

    const allResults: EngineResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        allResults.push(...outcome.value);
      }
    }

    // Count URL frequency for ranking
    const urlFrequency = new Map<string, number>();
    for (const r of allResults) {
      const norm = normalizeUrl(r.url);
      urlFrequency.set(norm, (urlFrequency.get(norm) ?? 0) + 1);
    }

    // Deduplicate by URL
    const seenUrls = new Set<string>();
    const uniqueResults: EngineResult[] = [];
    for (const r of allResults) {
      const norm = normalizeUrl(r.url);
      if (seenUrls.has(norm)) continue;
      seenUrls.add(norm);
      uniqueResults.push({ ...r, url: norm });
    }

    // Sort by frequency
    uniqueResults.sort((a, b) => {
      const freqA = urlFrequency.get(normalizeUrl(a.url)) ?? 0;
      const freqB = urlFrequency.get(normalizeUrl(b.url)) ?? 0;
      return freqB - freqA;
    });

    const finalResults = uniqueResults.slice(0, params.count);

    return {
      items: finalResults.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        source: r.engine,
      })),
      provider: this.id,
      query: params.query,
    };
  }

  getEngineStatus(): EngineProbeResult[] {
    return this.engines.map(e => ({
      id: e.id,
      ...this.engineProbeResults.get(e.id) ?? {
        available: false, resultCount: 0, responseTimeMs: 0,
      },
    }));
  }
}
