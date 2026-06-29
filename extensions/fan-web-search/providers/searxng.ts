import type { SearchProvider } from "./interface.js";
import type { SearchParams, SearchResult, TlsConfig } from "../types.js";
import { fetch, createTlsDispatcher } from "../tls.js";

export class SearXNGProvider implements SearchProvider {
  readonly id = "searxng";
  readonly name = "SearXNG";
  readonly requiresConfig = true;

  private url: string;
  private tlsConfig: TlsConfig | undefined;

  constructor(url: string) {
    this.url = url;
  }

  setTlsConfig(config: TlsConfig) { this.tlsConfig = config; }

  async probe(signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.url}`, {
      method: "GET",
      dispatcher: createTlsDispatcher(this.tlsConfig),
      signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      throw new Error(`SearXNG probe failed: ${res.status}`);
    }
    return true;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
    const searchParams = new URLSearchParams({
      q: params.query,
      format: "json",
      categories: "general",
    });

    if (params.recencyFilter && params.recencyFilter !== "noLimit") {
      const timeRangeMap: Record<string, string> = {
        oneDay: "day",
        oneWeek: "week",
        oneMonth: "month",
        oneYear: "year",
      };
      const timeRange = timeRangeMap[params.recencyFilter];
      if (timeRange) searchParams.set("time_range", timeRange);
    }

    if (params.domainFilter) {
      searchParams.set("q", `site:${params.domainFilter} ${params.query}`);
    }

    const res = await fetch(`${this.url}/search?${searchParams.toString()}`, {
      dispatcher: createTlsDispatcher(this.tlsConfig),
      signal,
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      throw new Error(`SearXNG returned ${res.status}`);
    }

    const data = await res.json() as { results?: Array<{ title: string; url: string; content: string; engine?: string; publishedDate?: string }> };

    const items = (data.results ?? []).slice(0, params.count).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? "",
      source: r.engine,
      date: r.publishedDate,
    }));

    return { items, provider: this.id, query: params.query };
  }
}
