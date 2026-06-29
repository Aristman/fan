import type { SearchProvider } from "./interface.js";
import type { SearchParams, SearchResult, RecencyFilter, YandexProviderConfig, TlsConfig } from "../types.js";
import { fetch, createTlsDispatcher } from "../tls.js";

export class YandexProvider implements SearchProvider {
  readonly id = "yandex";
  readonly name = "Yandex Search API";
  readonly requiresConfig = true;

  private apiKey: string;
  private folderId: string;
  private apiUrl: string;
  private maxPassages: number;
  private groupsOnPage: number;
  private tlsConfig: TlsConfig | undefined;

  constructor(apiKey: string, folderId: string, config: YandexProviderConfig) {
    this.apiKey = apiKey;
    this.folderId = folderId;
    this.apiUrl = config.url;
    this.maxPassages = config.maxPassages;
    this.groupsOnPage = config.groupsOnPage;
  }

  setTlsConfig(config: TlsConfig) { this.tlsConfig = config; }

  async probe(signal?: AbortSignal): Promise<boolean> {
    if (!this.apiKey || !this.folderId) throw new Error("Yandex: API key and folder ID required");
    try {
      const result = await this.doSearch("test query", 2, undefined, undefined, signal);
      return result.items.length > 0;
    } catch (err) {
      throw err;
    }
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
    return this.doSearch(params.query, params.count, params.domainFilter, params.recencyFilter, signal);
  }

  private async doSearch(
    query: string,
    count: number,
    domainFilter?: string,
    recencyFilter?: RecencyFilter,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    // Build query text with optional domain filter
    let queryText = query;
    if (domainFilter) {
      queryText = `host:"${domainFilter}" ${query}`;
    }

    // Sort by time for recency
    const sortByTime = recencyFilter && recencyFilter !== "noLimit";

    const body = {
      query: {
        searchType: "SEARCH_TYPE_COM" as const,
        queryText,
        familyMode: "FAMILY_MODE_MODERATE" as const,
      },
      sortSpec: {
        sortMode: sortByTime ? "SORT_MODE_BY_TIME" as const : "SORT_MODE_BY_RELEVANCE" as const,
        sortOrder: "SORT_ORDER_DESC" as const,
      },
      groupSpec: {
        groupMode: "GROUP_MODE_DEEP" as const,
        groupsOnPage: Math.min(count, this.groupsOnPage),
        docsInGroup: 1,
      },
      maxPassages: this.maxPassages,
      folderId: this.folderId,
      responseFormat: "FORMAT_XML" as const,
    };

    const res = await fetch(this.apiUrl, {
      method: "POST",
      dispatcher: createTlsDispatcher(this.tlsConfig),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Api-Key ${this.apiKey}`,
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Yandex HTTP ${res.status}: ${errBody}`);
    }

    const json = await res.json();

    if (json.error) {
      throw new Error(`Yandex API error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }

    const rawData = json.rawData;
    if (!rawData) throw new Error("Yandex: empty response (no rawData)");

    // Decode base64 XML
    const xml = Buffer.from(rawData, "base64").toString("utf-8");
    return this.parseXml(xml, query, count);
  }

  private parseXml(xml: string, query: string, count: number): SearchResult {
    const items: SearchResult["items"] = [];

    // Parse <doc> elements
    const docRegex = /<doc[^>]*>([\s\S]*?)<\/doc>/gi;
    let match: RegExpExecArray | null;

    while ((match = docRegex.exec(xml)) !== null && items.length < count) {
      const doc = match[1];

      const url = this.extractTag(doc, "url");
      const rawTitle = this.extractTag(doc, "title");
      const rawPassage = this.extractTag(doc, "passage");
      const modtime = this.extractTag(doc, "modtime");

      if (!url || !rawTitle) continue;

      const title = this.stripHtml(rawTitle);
      const passage = rawPassage ? this.stripHtml(rawPassage) : "";

      items.push({
        title,
        url,
        snippet: passage ?? "",
        date: modtime ? this.formatModtime(modtime) : undefined,
      });
    }

    return { items, provider: this.id, query };
  }

  private extractTag(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = regex.exec(xml);
    return match ? match[1].trim() : null;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, "").trim();
  }

  private formatModtime(modtime: string): string | undefined {
    // Format: 20060814T040000 → 2006-08-14
    const match = modtime.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!match) return undefined;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
}
