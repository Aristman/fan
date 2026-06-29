import type { SearchProvider } from "./interface.js";
import type { SearchParams, SearchResult, ZaiProviderConfig, TlsConfig } from "../types.js";
import { fetch, createTlsDispatcher } from "../tls.js";

interface McpSession {
  sessionId: string;
}

export class ZaiProvider implements SearchProvider {
  readonly id = "zai";
  readonly name = "Z.AI MCP";
  readonly requiresConfig = true;

  private apiKey: string;
  private config: ZaiProviderConfig;
  private session: McpSession | null = null;
  private tlsConfig: TlsConfig | undefined;

  constructor(apiKey: string, config: ZaiProviderConfig) {
    this.apiKey = apiKey;
    this.config = config;
  }

  setTlsConfig(config: TlsConfig) { this.tlsConfig = config; }

  async probe(signal?: AbortSignal): Promise<boolean> {
    if (!this.apiKey) throw new Error("No API key configured");
    try {
      await this.ensureSession(signal);
      return true;
    } catch (err) {
      this.session = null;
      throw err;
    }
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
    const text = await this.callTool({
      search_query: params.query,
      location: this.config.location,
      content_size: this.config.contentSize,
      ...(params.recencyFilter && params.recencyFilter !== "noLimit"
        ? { search_recency_filter: params.recencyFilter }
        : {}),
      ...(params.domainFilter
        ? { search_domain_filter: params.domainFilter }
        : {}),
    }, signal);

    const parsed = this.parseResponse(text);
    return this.extractResults(parsed, params);
  }

  invalidateSession(): void {
    this.session = null;
  }

  // ── MCP session management ──

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.session?.sessionId) return;

    const initResponse = await fetch(this.config.url, {
      method: "POST",
      dispatcher: createTlsDispatcher(this.tlsConfig),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: this.config.mcpProtocol,
          capabilities: {},
          clientInfo: { name: this.config.clientName, version: this.config.clientVersion },
        },
      }),
      signal,
    });

    const sessionId = initResponse.headers.get("mcp-session-id") || "";
    await initResponse.text().catch(() => {});

    if (!sessionId) {
      throw new Error("Z.AI MCP init failed: no session ID");
    }

    this.session = { sessionId };

    // Send initialized notification
    await fetch(this.config.url, {
      method: "POST",
      dispatcher: createTlsDispatcher(this.tlsConfig),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal,
    }).catch(() => {
      // Notification is optional — session is still usable
    });
  }

  // ── MCP tools/call ──

  private async callTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    await this.ensureSession(signal);
    if (!this.session) throw new Error("Z.AI: no active session");

    let res: Response;
    try {
      res = await fetch(this.config.url, {
        method: "POST",
        dispatcher: createTlsDispatcher(this.tlsConfig),
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "Accept": "application/json, text/event-stream",
          "mcp-session-id": this.session.sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: this.config.mcpTool,
            arguments: args,
          },
        }),
        signal,
      });
    } catch (err) {
      this.session = null;
      throw new Error(`Z.AI MCP network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.session = null;
      throw new Error(`Z.AI MCP HTTP ${res.status}: ${body}`);
    }

    const raw = await res.text().catch(() => "");
    const lines = raw.split("\n");
    let dataLine = "";
    for (const line of lines) {
      if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }

    if (!dataLine) throw new Error("Z.AI MCP: no data in SSE response");

    const json = JSON.parse(dataLine);
    if (json.error) {
      this.session = null;
      throw new Error(`Z.AI MCP error ${json.error.code}: ${json.error.message}`);
    }

    const result = json.result;
    if (!result?.content) throw new Error("Z.AI MCP: empty result");

    const content = result.content[0];
    if (!content?.text) throw new Error("Z.AI MCP: no text in result");

    return typeof content.text === "string" ? content.text : JSON.stringify(content.text);
  }

  // ── Triple-encoded JSON parsing ──

  private parseResponse(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return { content: "" };

    if (trimmed === '"[]"' || trimmed === "[]" || trimmed === "" ||
        trimmed.includes("Insufficient balance") || trimmed.includes("quota")) {
      return { content: [] };
    }

    try {
      let decoded: unknown = JSON.parse(trimmed);
      if (typeof decoded === "string") {
        try { decoded = JSON.parse(decoded); } catch { /* stop */ }
      }
      if (typeof decoded === "string") {
        try { decoded = JSON.parse(decoded); } catch { /* stop */ }
      }
      return decoded;
    } catch {
      return { content: text };
    }
  }

  // ── Result extraction ──

  private extractResults(parsed: unknown, params: SearchParams): SearchResult {
    const count = params.count;

    if (Array.isArray(parsed)) {
      return {
        items: this.mapItems(parsed).slice(0, count),
        provider: this.id,
        query: params.query,
      };
    }

    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Z.AI: unexpected response format");
    }

    const obj = parsed as Record<string, unknown>;

    if ("web_search" in obj && Array.isArray(obj.web_search)) {
      return {
        items: this.mapItems(obj.web_search).slice(0, count),
        provider: this.id,
        query: params.query,
      };
    }

    if ("data" in obj) {
      const data = obj.data;
      if (Array.isArray(data)) {
        return { items: this.mapItems(data).slice(0, count), provider: this.id, query: params.query };
      }
      if (data && typeof data === "object" && "results" in data && Array.isArray((data as Record<string, unknown>).results)) {
        return { items: this.mapItems((data as Record<string, unknown>).results as unknown[]).slice(0, count), provider: this.id, query: params.query };
      }
    }

    if ("results" in obj && Array.isArray(obj.results)) {
      return { items: this.mapItems(obj.results).slice(0, count), provider: this.id, query: params.query };
    }

    if ("content" in obj) {
      const content = obj.content;
      if (Array.isArray(content) && content.length > 0) {
        return this.extractResults(content[0], params);
      }
    }

    throw new Error("Z.AI: no parseable results in response");
  }

  private mapItems(items: unknown[]): Array<{ title: string; url: string; snippet: string; source?: string; date?: string }> {
    return items.map((item) => {
      if (!item || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      return {
        title: String(r.title ?? ""),
        url: String(r.url ?? r.link ?? ""),
        snippet: String(r.snippet ?? r.description ?? r.content ?? ""),
        source: r.source ? String(r.source) : undefined,
        date: r.date ?? r.publishedDate ? String(r.date ?? r.publishedDate) : undefined,
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
  }
}
