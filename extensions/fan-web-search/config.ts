import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WebSearchConfig, SearchConfig, ReaderConfig, FormatConfig,
  MetaSearchProviderConfig, SearXNGProviderConfig,
  BraveProviderConfig, YandexProviderConfig, ZaiProviderConfig,
} from "./types.js";

// ── Paths ──

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(EXTENSION_DIR, "config.json");
const HEALTH_FILE = join(EXTENSION_DIR, "health.json");

// ── Defaults (API keys are empty — fill them in config.json) ──

export const DEFAULT_CONFIG: WebSearchConfig = {
  search: {
    defaultCount: 10,
    timeout: 30000,
    probeTimeout: 15000,
    providers: {
      "meta-search": {
        enabled: true,
        priority: 2,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        probeTimeoutMs: 15000,
        engines: {
          mojeek: { enabled: true, url: "https://www.mojeek.com/search" },
        },
      },
      searxng: {
        enabled: true,
        url: "http://127.0.0.1:8888",
        priority: 4,
      },
      brave: {
        enabled: true,
        url: "https://api.search.brave.com/res/v1/web/search",
        priority: 5,
      },
      yandex: {
        enabled: true,
        url: "https://searchapi.api.cloud.yandex.net/v2/web/search",
        priority: 1,
        maxPassages: 2,
        groupsOnPage: 50,
      },
      zai: {
        enabled: true,
        url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
        priority: 3,
        mcpTool: "web_search_prime",
        mcpProtocol: "2024-11-05",
        location: "us",
        contentSize: "medium",
        clientName: "fan-agent",
        clientVersion: "1.0",
      },
    },
  },
  reader: {
    defaultFormat: "markdown",
    timeout: 60000,
    minContentLength: 50,
    maxLinks: 50,
    maxImages: 30,
    maxConsecutiveNewlines: 3,
    userAgent: "Mozilla/5.0 (compatible; fan-web-search/1.0)",
  },
  format: {
    maxLinks: 20,
    maxImages: 10,
  },
  tls: {
    rejectUnauthorized: false,
  },
  apiKeys: {
    braveApiKey: "",
    zaiApiKey: "",
    yandexApiKey: "",
    yandexFolderId: "",
  },
  healthCacheTtlMs: 300000,
};

// ── Config loading ──

export function loadConfig(): WebSearchConfig {
  const config: WebSearchConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      const userConfig = JSON.parse(raw);
      deepMerge(config as unknown as Record<string, unknown>, userConfig as Record<string, unknown>);
    } catch (err) {
      console.error(`[fan-web-search] Failed to parse ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      ensureConfigFile();
    } catch (err) {
      console.error(`[fan-web-search] Failed to create default config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return config;
}

function ensureConfigFile(): void {
  if (existsSync(CONFIG_FILE)) return;

  const defaultContent = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
  writeFileSync(CONFIG_FILE, defaultContent, "utf-8");
  console.error(`[fan-web-search] Created default config at ${CONFIG_FILE}`);
}

// ── API key resolution ──

export interface ApiKeys {
  braveApiKey: string;
  zaiApiKey: string;
  searxngUrl: string;
  yandexApiKey: string;
  yandexFolderId: string;
}

export function loadApiKeys(config: WebSearchConfig): ApiKeys {
  return {
    braveApiKey: config.apiKeys.braveApiKey ?? "",
    zaiApiKey: config.apiKeys.zaiApiKey ?? "",
    searxngUrl: config.search.providers.searxng.url,
    yandexApiKey: config.apiKeys.yandexApiKey ?? "",
    yandexFolderId: config.apiKeys.yandexFolderId ?? "",
  };
}

// ── Health persistence ──

export interface ProviderHealthEntry {
  status: "available" | "unavailable" | "unknown";
  lastChecked: number;
  resultCount?: number;
  responseTimeMs?: number;
  error?: string;
}

export interface HealthCache {
  providers: Record<string, ProviderHealthEntry>;
  metaSearchEngines?: Record<string, ProviderHealthEntry>;
  updatedAt: number;
}

export function loadHealth(): HealthCache | null {
  if (!existsSync(HEALTH_FILE)) return null;
  try {
    const raw = readFileSync(HEALTH_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data.updatedAt) return data;
    return null;
  } catch {
    return null;
  }
}

export function saveHealth(health: HealthCache): void {
  writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2) + "\n", "utf-8");
}

export function isHealthFresh(health: HealthCache | null, config: WebSearchConfig): boolean {
  if (!health) return false;
  return (Date.now() - health.updatedAt) < config.healthCacheTtlMs;
}

// ── Config saving ──

export function saveConfig(config: WebSearchConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Utility ──

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else if (sourceVal !== undefined) {
      target[key] = sourceVal;
    }
  }
}

export { EXTENSION_DIR, CONFIG_FILE };
