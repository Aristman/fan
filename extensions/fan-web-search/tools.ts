import type { ExtensionAPI, ExtensionCommandContext } from "@itone/fan-coding-agent";
import { StringEnum } from "@itone/fan-ai";
import { Type } from "@sinclair/typebox";
import type {
  WebSearchConfig, SearchParams, RecencyFilter,
  ReaderParams, ToolResult
} from "./types.js";
import { RECENCY_FILTERS } from "./types.js";
import { ProviderChain, ProviderChainError } from "./provider-chain.js";
import { MetaSearchProvider } from "./providers/meta-search.js";
import { SearXNGProvider } from "./providers/searxng.js";
import { BraveProvider } from "./providers/brave.js";
import { ZaiProvider } from "./providers/zai.js";
import { YandexProvider } from "./providers/yandex.js";
import { HtmlMarkdownReader } from "./providers/reader/html-markdown.js";
import { RawFetchReader } from "./providers/reader/raw-fetch.js";
import { formatSearchResults, formatReaderResult, formatSearchError, formatReaderError } from "./format.js";
import { existsSync } from "node:fs";
import { loadApiKeys, saveConfig, DEFAULT_CONFIG, CONFIG_FILE } from "./config.js";
import { createTlsDispatcher, isTlsStrict, fetch } from "./tls.js";

// ── Global config reference (set on init) ──

let currentConfig: WebSearchConfig | null = null;

// ── Singletons ──

export let chain: ProviderChain | null = null;
let metaSearchProvider: MetaSearchProvider | null = null;
export let zaiProvider: ZaiProvider | null = null;

export async function initProviderChain(config: WebSearchConfig): Promise<void> {
  chain = new ProviderChain(config);
  const keys = loadApiKeys(config);

  // 1. Meta-search (built-in, always available)
  metaSearchProvider = new MetaSearchProvider(config.search.providers["meta-search"]);
  if (config.tls) metaSearchProvider.setTlsConfig(config.tls);
  chain.registerSearchProvider(metaSearchProvider, config.search.providers["meta-search"]?.priority);

  // 2. SearXNG
  const searxngConfig = config.search.providers.searxng;
  if (searxngConfig?.enabled) {
    const searxngProvider = new SearXNGProvider(searxngConfig.url ?? keys.searxngUrl);
    if (config.tls) searxngProvider.setTlsConfig(config.tls);
    chain.registerSearchProvider(searxngProvider, config.search.providers.searxng?.priority);
  }

  // 3. API providers (optional, require keys)
  if (config.search.providers.brave?.enabled) {
    const braveProvider = new BraveProvider(keys.braveApiKey, config.search.providers.brave);
    if (config.tls) braveProvider.setTlsConfig(config.tls);
    chain.registerSearchProvider(braveProvider, config.search.providers.brave?.priority);
  }

  if (config.search.providers.yandex?.enabled) {
    const yandexProvider = new YandexProvider(keys.yandexApiKey, keys.yandexFolderId, config.search.providers.yandex);
    if (config.tls) yandexProvider.setTlsConfig(config.tls);
    chain.registerSearchProvider(yandexProvider, config.search.providers.yandex?.priority);
  }

  if (config.search.providers.zai?.enabled) {
    zaiProvider = new ZaiProvider(keys.zaiApiKey, config.search.providers.zai);
    if (config.tls) zaiProvider.setTlsConfig(config.tls);
    chain.registerSearchProvider(zaiProvider, config.search.providers.zai?.priority);
  }

  // Reader providers
  chain.registerReaderProvider(new HtmlMarkdownReader(config.reader));
  chain.registerReaderProvider(new RawFetchReader());

  currentConfig = config;

  // Log TLS status
  console.error(
    `[fan-web-search] TLS: ${isTlsStrict(config.tls) ? "strict (rejectUnauthorized=true)" : "relaxed (rejectUnauthorized=false)"}${config.tls.caPath ? `, CA: ${config.tls.caPath}` : ""}`
  );

  // Try loading from cache
  const metaEngineStatus = metaSearchProvider ? new Map(
    metaSearchProvider.getEngineStatus().map(e => [
      e.id,
      {
        status: e.available ? ("available" as const) : ("unavailable" as const),
        lastChecked: Date.now(),
        resultCount: e.resultCount,
        responseTimeMs: e.responseTimeMs,
        error: e.error,
      },
    ])
  ) : undefined;

  const usedCache = await chain.initFromCache(metaEngineStatus);
  if (usedCache) {
    const status = chain.getStatus();
    const available = status.search.filter(p => p.status === "available");
    console.error(
      `[fan-web-search] Using cached health: ${available.length} providers available: ` +
      available.map(p => p.id).join(", ")
    );
  } else {
    console.error("[fan-web-search] Health cache stale or missing, probing all providers...");
    await chain.probeAll(metaEngineStatus);

    const status = chain.getStatus();
    const available = status.search.filter(p => p.status === "available");
    const unavailable = status.search.filter(p => p.status === "unavailable");
    console.error(
      `[fan-web-search] Probed: ${available.length} available (${available.map(p => p.id).join(", ")})` +
      (unavailable.length > 0 ? `, ${unavailable.length} unavailable (${unavailable.map(p => p.id).join(", ")})` : "")
    );
    console.error(
      `[fan-web-search] Meta-search engines: ` +
      status.metaSearchEngines.map(e => `${e.id}=${e.status}(${e.responseTimeMs}ms)`).join(", ")
    );
  }
}

// ── web_search tool ──

function registerSearchTool(fan: ExtensionAPI) {
  fan.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using multiple provider backends with automatic fallback. Returns titles, URLs, summaries, and metadata. Use for finding documentation, articles, best practices, and any web content.",
    promptSnippet: "Search the web using multi-provider fallback (meta-search → SearXNG → API providers)",
    promptGuidelines: [
      "Use web_search when you need information from the internet",
      "Use web_reader after web_search to read specific pages in detail",
      "For official documentation, use domain_filter to limit results",
      "Use recency_filter for time-sensitive queries",
    ],

    parameters: Type.Object({
      query: Type.String({ description: "Search query text" }),
      count: Type.Optional(Type.Integer({
        description: "Number of results (1-50)",
        minimum: 1,
        maximum: 50,
      })),
      recency_filter: Type.Optional(StringEnum(RECENCY_FILTERS)),
      domain_filter: Type.Optional(Type.String({
        description: "Limit results to specific domain(s), e.g. docs.python.org",
      })),
    }),

    async execute(_toolCallId, params, signal): Promise<ToolResult> {
      if (!chain) {
        return {
          content: [{ type: "text", text: "Provider chain not initialized. Reload the extension." }],
          details: { isError: true },
          isError: true,
        };
      }

      const searchParams: SearchParams = {
        query: params.query as string,
        count: (params.count as number) ?? 10,
        recencyFilter: params.recency_filter as RecencyFilter | undefined,
        domainFilter: params.domain_filter as string | undefined,
      };

      try {
        const { result, fallbackFrom } = await chain.executeSearch(searchParams, signal);
        const text = formatSearchResults(result, fallbackFrom, currentConfig?.format);

        return {
          content: [{ type: "text", text }],
          details: {
            provider: result.provider,
            count: result.items.length,
            fallbackFrom: fallbackFrom.map(e => e.provider),
          },
        };
      } catch (err) {
        if (err instanceof ProviderChainError) {
          return {
            content: [{ type: "text", text: formatSearchError(err.errors, err.attempted) }],
            details: {
              isError: true,
              errors: err.errors,
              attempted: err.attempted,
            },
            isError: true,
          };
        }

        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Search failed: ${msg}` }],
          details: { isError: true, error: msg },
          isError: true,
        };
      }
    },
  });
}

// ── web_reader tool ──

function registerReaderTool(fan: ExtensionAPI) {
  fan.registerTool({
    name: "web_reader",
    label: "Web Reader",
    description: "Read and parse the content of a web page by URL. Returns structured content (markdown or text) with title, description, and metadata. Use after web_search to read specific pages.",
    promptSnippet: "Read and parse web page content into structured markdown or text",
    promptGuidelines: [
      "Use web_reader after web_search to read specific pages in detail",
      "Set return_format to 'text' for plain text without markdown formatting",
      "Use with_links_summary to get a list of all links on the page",
      "Use with_images_summary to get a list of all images on the page",
    ],

    parameters: Type.Object({
      url: Type.String({ description: "URL to read" }),
      return_format: Type.Optional(StringEnum(["markdown", "text"] as const)),
      with_links_summary: Type.Optional(Type.Boolean({
        description: "Include summary of links on page",
      })),
      with_images_summary: Type.Optional(Type.Boolean({
        description: "Include summary of images on page",
      })),
      no_cache: Type.Optional(Type.Boolean({
        description: "Bypass cache",
      })),
    }),

    async execute(_toolCallId, params, signal): Promise<ToolResult> {
      if (!chain) {
        return {
          content: [{ type: "text", text: "Provider chain not initialized. Reload the extension." }],
          details: { isError: true },
          isError: true,
        };
      }

      const readerParams: ReaderParams = {
        url: params.url as string,
        returnFormat: (params.return_format ?? "markdown") as "markdown" | "text",
        withLinksSummary: (params.with_links_summary as boolean) ?? false,
        withImagesSummary: (params.with_images_summary as boolean) ?? false,
      };

      try {
        const fetchController = new AbortController();
        const readerTimeout = currentConfig?.reader.timeout ?? 60000;
        const fetchTimeout = setTimeout(() => fetchController.abort(), readerTimeout);
        const combinedSignal = signal
          ? AbortSignal.any([signal, fetchController.signal])
          : fetchController.signal;

        const res = await fetch(readerParams.url, {
          dispatcher: createTlsDispatcher(currentConfig?.tls),
          signal: combinedSignal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        clearTimeout(fetchTimeout);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (
          !contentType.includes("text/html") &&
          !contentType.includes("text/plain") &&
          !contentType.includes("application/xhtml") &&
          !contentType.includes("text/xml") &&
          !contentType.includes("application/xml")
        ) {
          throw new Error(`Unsupported content type: ${contentType}. Only HTML/text pages are supported.`);
        }

        const html = await res.text();
        const result = await chain.executeRead(readerParams, html, signal);
        const text = formatReaderResult(result, currentConfig?.format);

        return {
          content: [{ type: "text", text }],
          details: {
            provider: result.provider,
            title: result.title,
            contentLength: result.content.length,
            hasLinks: Boolean(result.links?.length),
            hasImages: Boolean(result.images?.length),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: formatReaderError(msg) }],
          details: { isError: true, error: msg },
          isError: true,
        };
      }
    },
  });
}

const HELP_TEXT = [
  "🔍 FAN Web Search — Commands",
  "",
  "/web-search init    — Interactive configuration wizard",
  "/web-search check   — Check provider health and update cache",
  "/web-search searxng — Install SearXNG search engine in Docker",
  "/web-search         — Show this help",
].join("\n");

// ── /web-search command ──

async function handleInit(ctx: ExtensionCommandContext): Promise<void> {
  // Only work if config.json does NOT exist
  if (existsSync(CONFIG_FILE)) {
    ctx.ui.notify(
      `Config already exists at ${CONFIG_FILE}. Edit it manually or delete to re-run init.`,
      "warning"
    );
    return;
  }

  // Build config from defaults — do NOT call loadConfig() as it creates the file
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as WebSearchConfig;

  ctx.ui.notify("🔍 FAN Web Search — Interactive Configuration", "info");

  // ── Step 1: SearXNG ──
  const searxngAnswer = ctx.ui.select("Enable SearXNG?", ["Yes", "No"]);
  if (searxngAnswer === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  const enableSearXNG = searxngAnswer === "Yes";
  config.search.providers.searxng.enabled = enableSearXNG;
  if (enableSearXNG) {
    const url = ctx.ui.input("SearXNG URL", "http://127.0.0.1:8888");
    if (url === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
    config.search.providers.searxng.url = url || "http://127.0.0.1:8888";
  }

  // ── Step 2: Brave Search ──
  const braveAnswer = ctx.ui.select("Enable Brave Search?", ["Yes", "No"]);
  if (braveAnswer === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  const enableBrave = braveAnswer === "Yes";
  config.search.providers.brave.enabled = enableBrave;
  if (enableBrave) {
    const braveKey = ctx.ui.input("Brave API Key", "");
    if (braveKey === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
    config.apiKeys.braveApiKey = braveKey;
  }

  // ── Step 3: Yandex Search ──
  const yandexAnswer = ctx.ui.select("Enable Yandex Search?", ["Yes", "No"]);
  if (yandexAnswer === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  const enableYandex = yandexAnswer === "Yes";
  config.search.providers.yandex.enabled = enableYandex;
  if (enableYandex) {
    const yandexKey = ctx.ui.input("Yandex API Key", "");
    if (yandexKey === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
    config.apiKeys.yandexApiKey = yandexKey;

    const yandexFolder = ctx.ui.input("Yandex Folder ID", "");
    if (yandexFolder === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
    config.apiKeys.yandexFolderId = yandexFolder;
  }

  // ── Step 4: Z.AI Search ──
  const zaiAnswer = ctx.ui.select("Enable Z.AI Search?", ["Yes", "No"]);
  if (zaiAnswer === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  const enableZai = zaiAnswer === "Yes";
  config.search.providers.zai.enabled = enableZai;
  if (enableZai) {
    const zaiKey = ctx.ui.input("Z.AI API Key", "");
    if (zaiKey === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
    config.apiKeys.zaiApiKey = zaiKey;
  }

  // ── Step 5: Reader output format ──
  const readerFormat = ctx.ui.select("Reader output format", ["markdown", "text"]);
  if (readerFormat === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  config.reader.defaultFormat = readerFormat;

  // ── Step 6: TLS verification ──
  const tlsChoice = ctx.ui.select("TLS verification", ["Relaxed (recommended)", "Strict"]);
  if (tlsChoice === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  config.tls.rejectUnauthorized = tlsChoice === "Strict";

  // ── Step 7: Default search results count ──
  const countStr = ctx.ui.input("Default search results count", "10");
  if (countStr === undefined) { ctx.ui.notify("Cancelled", "warning"); return; }
  const count = parseInt(countStr, 10);
  config.search.defaultCount = isNaN(count) ? 10 : Math.max(1, Math.min(50, count));

  // ── Save immediately ──
  saveConfig(config);

  // ── Success summary ──
  const providers = ["meta-search"];
  if (enableSearXNG) providers.push("SearXNG");
  if (enableBrave) providers.push("Brave");
  if (enableYandex) providers.push("Yandex");
  if (enableZai) providers.push("Z.AI");

  ctx.ui.notify(
    "✅ Configuration saved!\n\n" +
    `  Providers: ${providers.join(", ")}\n` +
    `  Reader: ${readerFormat}\n` +
    `  TLS: ${config.tls.rejectUnauthorized ? "strict" : "relaxed"}\n` +
    `  Results: ${config.search.defaultCount}\n\n` +
    "Reload the extension to apply changes.",
    "info"
  );
}

async function handleCheck(ctx: ExtensionCommandContext): Promise<void> {
  if (!chain || !metaSearchProvider) {
    ctx.ui.notify("Provider chain not initialized", "error");
    return;
  }

  ctx.ui.setStatus("fan-web-search", "Re-probing all search providers...");

  try {
    await metaSearchProvider.probe();
    const metaEngineStatus = new Map(
      metaSearchProvider.getEngineStatus().map(e => [
        e.id,
        {
          status: e.available ? ("available" as const) : ("unavailable" as const),
          lastChecked: Date.now(),
          resultCount: e.resultCount,
          responseTimeMs: e.responseTimeMs,
          error: e.error,
        },
      ])
    );

    await chain.reprobeAll(metaEngineStatus);

    const status = chain.getStatus();
    const available = status.search.filter(p => p.status === "available");
    const unavailable = status.search.filter(p => p.status !== "available");

    const lines: string[] = ["## Web Search Provider Status", ""];

    lines.push("### Meta-Search Engines");
    for (const e of status.metaSearchEngines) {
      const icon = e.status === "available" ? "✅" : "❌";
      lines.push(`- ${icon} **${e.id}**: ${e.responseTimeMs}ms, ${e.resultCount} results${e.error ? ` (${e.error})` : ""}`);
    }

    lines.push("");
    lines.push("### Provider Chain");
    for (const p of available) {
      lines.push(`- ✅ **${p.id}**: available`);
    }
    for (const p of unavailable) {
      lines.push(`- ❌ **${p.id}**: ${p.lastError ?? "unknown"}`);
    }

    lines.push("");
    lines.push(`**${available.length}** of **${status.search.length}** providers available. Health cache updated.`);

    ctx.ui.setStatus("fan-web-search", undefined);
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.setStatus("fan-web-search", undefined);
    ctx.ui.notify(`❌ Re-probe failed: ${msg}`, "error");
  }
}

async function handleSearXNG(ctx: ExtensionCommandContext): Promise<void> {
  const { execFile } = await import("node:child_process");

  const dockerCheck = (cmd: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
    });

  const hasDocker = await dockerCheck("docker", ["--version"]);
  const hasDockerCompose = await dockerCheck("docker", ["compose", "version"])
    .catch(() => dockerCheck("docker-compose", ["--version"]));

  if (!hasDocker) {
    ctx.ui.notify(
      [
        "🐳 Docker is not installed or not in PATH.",
        "",
        "To install Docker:",
        "  • Linux:   https://docs.docker.com/engine/install/",
        "  • macOS:   brew install --cask docker",
        "  • Windows: https://docs.docker.com/desktop/setup/install/windows-install/",
        "",
        "After installing Docker, run /web-search searxng again.",
      ].join("\n"),
      "warning"
    );
    return;
  }

  if (!hasDockerCompose) {
    ctx.ui.notify(
      [
        "⚠️ Docker is installed but docker compose is not available.",
        "Install Docker Compose plugin: https://docs.docker.com/compose/install/",
      ].join("\n"),
      "warning"
    );
    return;
  }

  ctx.ui.setStatus("fan-web-search", "Starting SearXNG container...");

  try {
    const COMPOSE_FILE = `
version: "3.8"
services:
  searxng:
    image: searxng/searxng:latest
    container_name: fan-searxng
    ports:
      - "8888:8080"
    restart: unless-stopped
    environment:
      - SEARXNG_SECRET=changeme
      - BASE_URL=http://localhost:8888/
    volumes:
      - searxng-data:/etc/searxng
volumes:
  searxng-data:
`;
    const { join: pathJoin } = await import("node:path");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    const workDir = await mkdtemp(pathJoin(tmpdir(), "fan-searxng-"));
    await writeFile(pathJoin(workDir, "docker-compose.yml"), COMPOSE_FILE, "utf-8");

    const runDocker = (cmd: string, args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd: workDir, timeout: 120_000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout.trim());
        });
      });

    await runDocker("docker", ["compose", "-f", pathJoin(workDir, "docker-compose.yml"), "up", "-d", "--pull", "always"]);

    // Cleanup temp dir
    await rm(workDir, { recursive: true, force: true });

    ctx.ui.setStatus("fan-web-search", undefined);
    ctx.ui.notify(
      [
        "✅ SearXNG is running!",
        "",
        "  URL:      http://localhost:8888",
        "  Instance: fan-searxng (Docker container)",
        "",
        "The SearXNG provider is already enabled in config.",
        "Run /web-search check to verify it's available.",
      ].join("\n"),
      "info"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.setStatus("fan-web-search", undefined);
    ctx.ui.notify(
      [
        `❌ Failed to start SearXNG: ${msg}`,
        "",
        "You can start it manually:",
        "  docker run -d --name fan-searxng -p 8888:8080 searxng/searxng:latest",
      ].join("\n"),
      "error"
    );
  }
}

function registerWebSearchCommand(fan: ExtensionAPI) {
  fan.registerCommand("web-search", {
    description: "Web search extension commands",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const sub = args.trim().toLowerCase();

      switch (sub) {
        case "init":
          return handleInit(ctx);
        case "check":
          return handleCheck(ctx);
        case "searxng":
          return handleSearXNG(ctx);
        case "":
        default:
          ctx.ui.notify(HELP_TEXT, "info");
      }
    },
  });
}

// ── Exports ──

export function registerTools(fan: ExtensionAPI): void {
  registerSearchTool(fan);
  registerReaderTool(fan);
  registerWebSearchCommand(fan);
}
