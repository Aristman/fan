import type { WebSearchConfig, SearchParams, SearchResult, ReaderParams, ReaderResult, ProviderError } from "./types.js";
import type { SearchProvider, ReaderProvider } from "./providers/interface.js";
import type { MetaSearchEngineStatus } from "./providers/meta-search.js";
import { loadHealth, saveHealth, isHealthFresh, type ProviderHealthEntry } from "./config.js";

export class ProviderChainError extends Error {
  readonly errors: ProviderError[];
  readonly attempted: string[];

  constructor(errors: ProviderError[], attempted: string[]) {
    const msg = `All ${attempted.length} providers failed: ${errors.map(e => `${e.provider}: ${e.error}`).join("; ")}`;
    super(msg);
    this.name = "ProviderChainError";
    this.errors = errors;
    this.attempted = attempted;
  }
}

interface ProviderEntry<T> {
  provider: T;
  healthy: boolean;
  lastError?: string;
  priority: number;
}

// ── Status types ──

interface ProviderStatusEntry {
  id: string;
  status: "available" | "unavailable";
  lastError?: string;
}

export interface ChainStatus {
  search: ProviderStatusEntry[];
  reader: ProviderStatusEntry[];
  metaSearchEngines: MetaSearchEngineStatus[];
}

// ── Meta engine health map (passed from tools.ts after probing meta-search) ──

export type MetaEngineHealthMap = Map<
  string,
  {
    status: "available" | "unavailable";
    lastChecked: number;
    resultCount?: number;
    responseTimeMs?: number;
    error?: string;
  }
>;

export class ProviderChain {
  private config: WebSearchConfig;
  private searchProviders: ProviderEntry<SearchProvider>[] = [];
  private readerProviders: ProviderEntry<ReaderProvider>[] = [];
  private metaEngineStatuses: MetaEngineHealthMap = new Map();

  constructor(config: WebSearchConfig) {
    this.config = config;
  }

  registerSearchProvider(provider: SearchProvider, priority?: number): void {
    this.searchProviders.push({ provider, healthy: false, priority: priority ?? 99 });
  }

  registerReaderProvider(provider: ReaderProvider): void {
    this.readerProviders.push({ provider, healthy: false });
  }

  // ── Health persistence ──

  async initFromCache(metaEngineStatus?: MetaEngineHealthMap): Promise<boolean> {
    const health = loadHealth();
    if (!isHealthFresh(health, this.config)) return false;

    // Apply cached health to search providers
    if (health) {
      for (const entry of this.searchProviders) {
        const cached = health.providers[entry.provider.id];
        if (cached) {
          entry.healthy = cached.status === "available";
          entry.lastError = cached.error;
        }
      }

      // Apply cached meta engine statuses
      if (health.metaSearchEngines) {
        for (const [engineId, entry] of Object.entries(health.metaSearchEngines)) {
          this.metaEngineStatuses.set(engineId, {
            status: entry.status === "available" ? "available" : "unavailable",
            lastChecked: entry.lastChecked,
            resultCount: entry.resultCount,
            responseTimeMs: entry.responseTimeMs,
            error: entry.error,
          });
        }
      }
    }

    // Replace with freshly-probed meta engine status (takes priority over cache)
    if (metaEngineStatus) {
      this.metaEngineStatuses = new Map(metaEngineStatus);
    }

    return true;
  }

  // ── Probing ──

  async probeAll(metaEngineStatus?: MetaEngineHealthMap): Promise<void> {
    const probeTimeoutMs = this.config.search.probeTimeout ?? 15000;
    const probeWithTimeout = async (entry: ProviderEntry<SearchProvider>): Promise<void> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
      try {
        entry.healthy = await entry.provider.probe(controller.signal);
      } catch (err) {
        entry.healthy = false;
        entry.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timeout);
      }
    };

    // Search providers have probe; reader providers are assumed healthy
    await Promise.all(this.searchProviders.map(probeWithTimeout));
    for (const entry of this.readerProviders) {
      entry.healthy = true;
    }

    // Store meta engine status
    if (metaEngineStatus) {
      this.metaEngineStatuses = new Map(metaEngineStatus);
    }

    // Persist health to disk
    this.persistHealth();
  }

  async reprobeAll(metaEngineStatus?: MetaEngineHealthMap): Promise<void> {
    // Reset all health
    for (const entry of this.searchProviders) {
      entry.healthy = false;
      entry.lastError = undefined;
    }

    // Re-probe
    await this.probeAll(metaEngineStatus);
  }

  // ── Status ──

  getStatus(): ChainStatus {
    return {
      search: this.searchProviders.map(e => ({
        id: e.provider.id,
        status: e.healthy ? "available" : "unavailable",
        lastError: e.lastError,
      })),
      reader: this.readerProviders.map(e => ({
        id: e.provider.id,
        status: e.healthy ? "available" : "unavailable",
        lastError: e.lastError,
      })),
      metaSearchEngines: this.buildMetaSearchEngineStatuses(),
    };
  }

  // ── Execution ──

  async executeSearch(
    params: SearchParams,
    signal?: AbortSignal,
  ): Promise<{ result: SearchResult; fallbackFrom: ProviderError[] }> {
    const errors: ProviderError[] = [];
    const attempted: string[] = [];

    // Try healthy providers first (sorted by priority asc), then unhealthy as fallback
    const healthy = this.searchProviders
      .filter(e => e.healthy)
      .sort((a, b) => a.priority - b.priority);
    const unhealthy = this.searchProviders
      .filter(e => !e.healthy)
      .sort((a, b) => a.priority - b.priority);
    const ordered = [...healthy, ...unhealthy];

    for (const entry of ordered) {
      attempted.push(entry.provider.id);
      try {
        const searchTimeout = this.config.search.timeout ?? 30000;
        const searchController = new AbortController();
        const searchTimer = setTimeout(() => searchController.abort(), searchTimeout);
        const searchSignal = signal
          ? AbortSignal.any([signal, searchController.signal])
          : searchController.signal;

        const result = await entry.provider.search(params, searchSignal);
        clearTimeout(searchTimer);
        entry.healthy = true;
        return { result, fallbackFrom: errors };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        entry.healthy = false;
        entry.lastError = msg;
        errors.push({ provider: entry.provider.id, error: msg });
      }
    }

    throw new ProviderChainError(errors, attempted);
  }

  async executeRead(
    params: ReaderParams,
    html: string,
    signal?: AbortSignal,
  ): Promise<ReaderResult> {
    // Try providers in order (html-markdown first, then raw-fetch fallback)
    const ordered = [
      ...this.readerProviders.filter(e => e.healthy),
      ...this.readerProviders.filter(e => !e.healthy),
    ];

    for (const entry of ordered) {
      try {
        const result = await entry.provider.read(params, html, signal);
        entry.healthy = true;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        entry.healthy = false;
        entry.lastError = msg;
      }
    }

    throw new Error("All reader providers failed");
  }

  // ── Internal ──

  private buildMetaSearchEngineStatuses(): MetaSearchEngineStatus[] {
    const statuses: MetaSearchEngineStatus[] = [];
    for (const [engineId, entry] of this.metaEngineStatuses) {
      statuses.push({
        id: engineId,
        status: entry.status,
        available: entry.status === "available",
        resultCount: entry.resultCount,
        responseTimeMs: entry.responseTimeMs,
        error: entry.error,
      });
    }
    return statuses;
  }

  private persistHealth(): void {
    const providers: Record<string, ProviderHealthEntry> = {};
    for (const entry of this.searchProviders) {
      providers[entry.provider.id] = {
        status: entry.healthy ? "available" : "unavailable",
        lastChecked: Date.now(),
        error: entry.lastError,
      };
    }

    const metaSearchEngines: Record<string, ProviderHealthEntry> = {};
    for (const [engineId, entry] of this.metaEngineStatuses) {
      metaSearchEngines[engineId] = {
        status: entry.status,
        lastChecked: entry.lastChecked,
        resultCount: entry.resultCount,
        responseTimeMs: entry.responseTimeMs,
        error: entry.error,
      };
    }

    saveHealth({
      providers,
      metaSearchEngines,
      updatedAt: Date.now(),
    });
  }
}
