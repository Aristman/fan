import type { SearchProvider } from "./interface.js";
import type { SearchParams, SearchResult, BraveProviderConfig, TlsConfig } from "../types.js";
import { fetch, createTlsDispatcher } from "../tls.js";

export class BraveProvider implements SearchProvider {
  readonly id = "brave";
  readonly name = "Brave Search";
  readonly requiresConfig = true;

  private apiKey: string;
  private apiUrl: string;
  private tlsConfig: TlsConfig | undefined;

  constructor(apiKey: string, config: BraveProviderConfig) {
    this.apiKey = apiKey;
    this.apiUrl = config.url;
  }

  setTlsConfig(config: TlsConfig) { this.tlsConfig = config; }

  async probe(signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.apiUrl}?q=test&count=1`, {
      dispatcher: createTlsDispatcher(this.tlsConfig),
      signal,
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave probe failed: ${res.status}`);
    }
    return true;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
    if (!this.apiKey) {
      throw new Error("Brave API key not configured");
    }

    const searchParams = new URLSearchParams({
      q: params.query,
      count: String(params.count),
    });

    if (params.recencyFilter && params.recencyFilter !== "noLimit") {
      searchParams.set("freshness", params.recencyFilter);
    }

    if (params.domainFilter) {
      searchParams.set("domain", params.domainFilter);
    }

    const res = await fetch(`${this.apiUrl}?${searchParams.toString()}`, {
      dispatcher: createTlsDispatcher(this.tlsConfig),
      signal,
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`Brave auth error: ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`Brave API returned ${res.status}`);
    }

    const data = await res.json() as {
      web?: {
        results?: Array<{
          title: string; url: string; description: string;
          source?: string; age?: string;
        }>;
      };
    };

    const items = (data.web?.results ?? []).slice(0, params.count).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? "",
      source: r.source,
      date: r.age,
    }));

    return { items, provider: this.id, query: params.query };
  }
}
