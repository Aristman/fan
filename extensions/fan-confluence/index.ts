import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@seaagents/fan-ai";
import { loadConfig, saveConfig, configExists, getEnvPath, type ConfluenceConfig } from "./config.js";
import { initClient, healthCheck, type ConfluenceClient } from "./client.js";
import { convertStorageToMarkdown } from "./converters/storage-to-md.js";
import { convertMarkdownToStorage, truncateContent } from "./converters/md-to-storage.js";
import { formatConfluenceError } from "./tools/errors.js";

// ── Read cache ──────────────────────────────────────────────
const readCache = new Map<number, string>();
const CACHE_MAX_ENTRIES = 50;

function cacheGet(pageId: number): string | undefined {
  return readCache.get(pageId);
}

function cacheSet(pageId: number, content: string): void {
  if (readCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = readCache.keys().next().value;
    if (firstKey !== undefined) readCache.delete(firstKey);
  }
  readCache.set(pageId, content);
}

function cacheInvalidate(pageId: number): void {
  readCache.delete(pageId);
}

function cacheClear(): void {
  readCache.clear();
}

// ── Extension ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let _config: ConfluenceConfig | null = null;
  let _client: ConfluenceClient | null = null;
  let _initError: string | null = null;

  async function ensureClient(): Promise<ConfluenceClient> {
    if (_client) return _client;
    // Retry: maybe .env was created after session_start
    try {
      _config = await loadConfig();
      _client = initClient(_config);
      _initError = null;
      return _client;
    } catch (err: unknown) {
 _initError = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Confluence не настроен. Выполните /confluence init.\nПричина: ${_initError}`,
      );
    }
  }

  pi.on("session_start", async () => {
    cacheClear();
    try {
      _config = await loadConfig();
      _client = initClient(_config);
    } catch (err: unknown) {
      _initError = err instanceof Error ? err.message : String(err);
      _client = null;
    }
  });

  pi.on("session_shutdown", async () => {
    _client = null;
    _config = null;
    cacheClear();
  });

  // ── Single unified tool ──────────────────────────────────

  pi.registerTool({
    name: "fan_confluence",
    label: "Confluence",
    description:
      "Confluence Data Center integration — read, write, and search pages. Commands: list_spaces, list_pages, read_page, search, create_page, update_page.",
    promptSnippet: "Read/write/search Confluence pages",
    promptGuidelines: [
      "Use fan_confluence to interact with Confluence Data Center.",
      "For reading: list_spaces, list_pages, read_page, search (CQL).",
      "For writing: create_page, update_page — pass Markdown content.",
      "Storage Format ↔ Markdown conversion is automatic.",
    ],
    parameters: Type.Object({
      command: StringEnum([
        "list_spaces",
        "list_pages",
        "read_page",
        "search",
        "create_page",
        "update_page",
      ] as const),
      // list_pages
      space_key: Type.Optional(Type.String({ description: "Space key (default from config)" })),
      limit: Type.Optional(Type.Integer({ description: "Max results (default: 25)", minimum: 1, maximum: 200 })),
      start: Type.Optional(Type.Integer({ description: "Pagination offset (default: 0)", minimum: 0 })),
      title: Type.Optional(Type.String({ description: "Filter by page title (list_pages) or page title (read_page)" })),
      // read_page
      page_id: Type.Optional(Type.Integer({ description: "Numeric page ID (read_page, update_page)" })),
      // search
      cql: Type.Optional(Type.String({ description: 'CQL query for search, e.g. text~"architecture"' })),
      // create_page / update_page
      content: Type.Optional(Type.String({ description: "Page content in Markdown (create_page, update_page)" })),
      parent_id: Type.Optional(Type.Integer({ description: "Parent page ID for child page (create_page)" })),
    }),

    async execute(_toolCallId, params) {
      switch (params.command) {
        case "list_spaces":
          return cmdListSpaces(await ensureClient(), params.limit);
        case "list_pages":
          return cmdListPages(await ensureClient(), _config, params);
        case "read_page":
          return cmdReadPage(await ensureClient(), params);
        case "search":
          return cmdSearch(await ensureClient(), params);
        case "create_page":
          return cmdCreatePage(await ensureClient(), _config, params);
        case "update_page":
          return cmdUpdatePage(await ensureClient(), params);
        default:
          throw new Error(`Unknown command: ${params.command}`);
      }
    },
  });

  // ── Slash command ─────────────────────────────────────────

  pi.registerCommand("confluence", {
    description: "Confluence integration — init, status",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["init", "status"];
      const filtered = cmds.filter((c) => c.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((v) => ({ value: v, label: v }))
        : null;
    },
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase() || "status";

      if (sub === "init") {
        await cmdInit(ctx);
        return;
      }

      // status (default)
      try {
        if (!_client) {
          _config = await loadConfig();
          _client = initClient(_config);
        }

        const hc = await healthCheck(_client);

        if (hc.ok) {
          ctx.ui.notify(
            `Confluence: подключено (${_config!.baseUrl})`,
            "info",
          );
        } else {
          ctx.ui.notify(`Confluence: ошибка подключения — ${hc.error}`, "error");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Confluence: ошибка — ${message}`, "error");
      }
    },
  });

  // ── Init wizard ──────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function cmdInit(ctx: any) {
    try {
      const envPath = getEnvPath();
      const exists = await configExists();

      if (exists) {
        const overwrite = await ctx.ui.confirm(
          "Файл .env уже существует",
          "Перезаписать текущую конфигурацию?",
        );
        if (!overwrite) {
          ctx.ui.notify("Инициализация отменена.", "warning");
          return;
        }
      }

      ctx.ui.setStatus("confluence", "Настройка Confluence...");

      // Step 1: Base URL
      const baseUrl = await ctx.ui.input(
        "Шаг 1/2: URL Confluence",
        "https://confluence.example.com",
      );
      if (!baseUrl) {
        ctx.ui.notify("Инициализация отменена — не указан URL.", "warning");
        ctx.ui.setStatus("confluence");
        return;
      }

      // Step 2: PAT
      ctx.ui.notify("Personal Access Token (PAT) — Settings → Personal Access Tokens в Confluence", "info");
      const pat = await ctx.ui.input(
        "Шаг 2/2: Personal Access Token",
        "",
      );
      if (!pat) {
        ctx.ui.notify("Инициализация отменена — не указан PAT.", "warning");
        ctx.ui.setStatus("confluence");
        return;
      }

      const config: ConfluenceConfig = {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        pat,
      };

      // Test connection before saving
      ctx.ui.setStatus("confluence", "Проверка подключения...");
      const testClient = initClient(config);
      const hc = await healthCheck(testClient);

      if (!hc.ok) {
        const proceed = await ctx.ui.confirm(
          "Ошибка подключения",
          `Не удалось подключиться: ${hc.error}\nСохранить конфигурацию всё равно?`,
        );
        if (!proceed) {
          ctx.ui.notify("Инициализация отменена.", "warning");
          ctx.ui.setStatus("confluence");
          return;
        }
      }

      // Save
      await saveConfig(config);

      // Reinitialize client
      _config = config;
      _client = testClient;
      cacheClear();

      ctx.ui.setStatus("confluence");
      if (hc.ok) {
        ctx.ui.notify(
          `Confluence настроен: ${config.baseUrl}. Конфигурация сохранена в ${envPath}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Конфигурация сохранена в ${envPath}, но подключение не прошло. Проверьте настройки и выполните /confluence status.`,
          "warning",
        );
      }
    } catch (err: unknown) {
      ctx.ui.setStatus("confluence");
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Ошибка инициализации: ${message}`, "error");
    }
  }

  // ── Command handlers ──────────────────────────────────────

  async function cmdListSpaces(client: ConfluenceClient, limit?: number) {
    try {
      const res = await client.space.getSpaces({ limit: limit ?? 25 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spaces = (res as any).results || [];

      const formatted = spaces
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((s: any) => `- **${s.name}** (key: \`${s.key}\`, id: ${s.id}, type: ${s.type})`)
        .join("\n");

      return {
        content: [{ type: "text", text: `## Confluence Spaces (${spaces.length})\n\n${formatted}` }],
        details: { command: "list_spaces", count: spaces.length },
      };
    } catch (err) {
      throw formatConfluenceError(err);
    }
  }

  async function cmdListPages(
    client: ConfluenceClient,
    config: ConfluenceConfig | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
  ) {
    try {
      const spaceKey = params.space_key || config?.spaceKey;
      if (!spaceKey) {
        throw new Error("Укажите space_key для списка страниц.");
      }
      const limit = params.limit ?? 25;
      const start = params.start ?? 0;

      const args: Record<string, unknown> = {
        spaceKey,
        limit,
        start,
        type: "page",
        status: "current",
      };
      if (params.title) args.title = params.title;

      const res = await client.content.getContent(args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages = (res as any).results || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = (res as any).size || pages.length;

      const formatted = pages
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => `- **${p.title}** (id: ${p.id}, version: ${p.version?.number || "?"})`)
        .join("\n");

      let text = `## Pages in \`${spaceKey}\` (${start + 1}–${start + pages.length} of ${total})\n\n${formatted}`;

      if (start + pages.length < total) {
        text += `\n\n_Ещё ${total - start - pages.length} страниц. Укажите start=${start + limit} для продолжения._`;
      }

      return {
        content: [{ type: "text", text }],
        details: { command: "list_pages", count: pages.length, total },
      };
    } catch (err) {
      throw formatConfluenceError(err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function cmdReadPage(client: ConfluenceClient, params: any) {
    if (!params.page_id && !params.title) {
      throw new Error("Укажите page_id или title для чтения страницы.");
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let page: any;

      if (params.page_id) {
        page = await client.content.getContentById({
          id: String(params.page_id),
          expand: "body.storage,version,space",
        });
      } else {
        const res = await client.content.getContent({
          title: params.title,
          expand: "body.storage,version,space",
          limit: 1,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = (res as any).results || [];
        if (results.length === 0) {
          throw new Error(`Страница с заголовком "${params.title}" не найдена.`);
        }
        page = results[0];
      }

      const pageId = Number(page.id);
      const cacheHit = cacheGet(pageId);
      if (cacheHit) {
        return {
          content: [{ type: "text", text: `${formatPageMeta(page)}\n\n${cacheHit}\n\n_(from cache)_` }],
          details: { command: "read_page", pageId, cached: true },
        };
      }

      const bodyStorage = page.body?.storage?.value || "";
      const { content: markdown, truncated, originalLength } = truncateContent(
        convertStorageToMarkdown(bodyStorage),
      );

      cacheSet(pageId, markdown);

      let text = formatPageMeta(page) + `\n\n${markdown}`;

      if (truncated) {
        const webUrl = page._links?.webui || "";
        text += `\n\n_⚠️ Страница обрезана (~${Math.round(originalLength / 1024)} KB). [Полная версия](${webUrl})_`;
      }

      return {
        content: [{ type: "text", text }],
        details: { command: "read_page", pageId, cached: false, truncated },
      };
    } catch (err) {
      throw formatConfluenceError(err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function cmdSearch(client: ConfluenceClient, params: any) {
    if (!params.cql) {
      throw new Error("Укажите cql для поиска.");
    }

    try {
      const limit = params.limit ?? 25;
      const start = params.start ?? 0;

      const res = await client.search.search({
        cql: params.cql,
        limit,
        start,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = (res as any).results || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = (res as any).totalSize || results.length;

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: `По запросу \`${params.cql}\` ничего не найдено. Попробуйте изменить запрос.\n\n_Советы: оператор ~ для нечёткого поиска, type=page для фильтра по типу._`,
          }],
          details: { command: "search", count: 0 },
        };
      }

      const formatted = results
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => {
          const title = r.title || "Untitled";
          const excerpt = r.excerpt || "";
          const space = r.space?.key || "?";
          const url = r.url || r._links?.webui || "";
          const id = r.content?.id || r.id || "?";
          return `- **${title}** (id: ${id}, space: \`${space}\`)${url ? ` — [открыть](${url})` : ""}\n  ${excerpt}`;
        })
        .join("\n\n");

      let text = `## Search: \`${params.cql}\` (${start + 1}–${start + results.length} of ${total})\n\n${formatted}`;

      if (start + results.length < total) {
        text += `\n\n_Ещё ${total - start - results.length} результатов. Укажите start=${start + limit} для продолжения._`;
      }

      return {
        content: [{ type: "text", text }],
        details: { command: "search", count: results.length, total },
      };
    } catch (err) {
      throw formatConfluenceError(err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function cmdCreatePage(client: ConfluenceClient, config: ConfluenceConfig | null, params: any) {
    if (!params.title || !params.content) {
      throw new Error("Укажите title и content для создания страницы.");
    }

    const parentId = params.parent_id || config?.defaultParentId;
    if (!parentId) {
      throw new Error(
        "Создание страниц запрещено: не задан CONFLUENCE_DEFAULT_PARENT_ID в .env. Страницы можно создавать только как дочерние к родительской странице.",
      );
    }

    try {
      const spaceKey = params.space_key || config?.spaceKey;
      if (!spaceKey) {
        throw new Error("Укажите space_key для создания страницы.");
      }
      const storage = convertMarkdownToStorage(params.content);

      const args: Record<string, unknown> = {
        space: { key: spaceKey },
        title: params.title,
        body: { storage: { value: storage, representation: "storage" } },
        type: "page",
        status: "current",
        ancestors: [{ id: String(parentId) }],
      };

      const page = await client.content.createContent(args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = page as any;

      return {
        content: [{
          type: "text",
          text: `Страница **"${params.title}"** создана (id: ${p.id}, version: ${p.version?.number || 1})${p._links?.webui ? ` — [открыть](${p._links.webui})` : ""}`,
        }],
        details: { command: "create_page", pageId: p.id, spaceKey, parentId: parentId || null },
      };
    } catch (err) {
      throw formatConfluenceError(err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function cmdUpdatePage(client: ConfluenceClient, params: any) {
    if (!params.page_id || !params.content) {
      throw new Error("Укажите page_id и content для обновления страницы.");
    }

    try {
      const current = await client.content.getContentById({
        id: String(params.page_id),
        expand: "version",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = current as any;
      const currentVersion = cur.version?.number || 1;

      const storage = convertMarkdownToStorage(params.content);

      const page = await client.content.updateContentById({
        id: params.page_id,
        version: { number: currentVersion + 1, minorEdit: false },
        title: params.title || cur.title,
        type: "page",
        body: { storage: { value: storage, representation: "storage" } },
        status: "current",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = page as any;

      cacheInvalidate(params.page_id);

      return {
        content: [{
          type: "text",
          text: `Страница **"${p.title}"** обновлена (id: ${params.page_id}, version: ${currentVersion} → ${p.version?.number || currentVersion + 1})${p._links?.webui ? ` — [открыть](${p._links.webui})` : ""}`,
        }],
        details: { command: "update_page", pageId: params.page_id, version: p.version?.number },
      };
    } catch (err) {
      throw formatConfluenceError(err);
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function formatPageMeta(page: any): string {
    const title = page.title || "Untitled";
    const spaceKey = page.space?.key || "?";
    const spaceName = page.space?.name || "?";
    const version = page.version?.number || "?";
    const webUrl = page._links?.webui || "";
    return `**${title}** | space: \`${spaceKey}\` (${spaceName}) | version: ${version}${webUrl ? ` | [web](${webUrl})` : ""}`;
  }
}
