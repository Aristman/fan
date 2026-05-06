/**
 * FAN Orchestrator v2 — Configuration
 *
 * Loads config.json with defaults, resolves model per agent type and provider mode.
 * Also handles cloud health checking for auto mode.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrchestratorConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Extension root — works whether running from dist/ or root. */
const EXTENSION_ROOT = __dirname.endsWith("/dist") || __dirname.endsWith("\\dist")
  ? join(__dirname, "..")
  : __dirname;

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULTS: OrchestratorConfig = {
  cloud: {
    defaultModel: "",
    defaultProvider: "",
    models: {},
    providers: {},
  },
  local: {
    defaultModel: "",
    defaultProvider: "ollama",
    models: {},
    providers: {},
  },
  providerMode: "auto",
  maxWorkers: 10,
  parallelWorkers: 3,
  maxRetries: 2,
  stallTimeout: 300_000,
  dangerousCommands: ["rm -rf /", "rm -rf .", "git push --force", "npm publish", "DROP TABLE"],
};

// ── Config loading ─────────────────────────────────────────────────────────

/**
 * Load configuration from config.json, falling back to defaults for missing fields.
 */
export function loadConfig(): OrchestratorConfig {
  const configPath = join(EXTENSION_ROOT, "config.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<OrchestratorConfig>;
    return {
      cloud: {
        defaultModel: raw.cloud?.defaultModel ?? DEFAULTS.cloud.defaultModel,
        defaultProvider: raw.cloud?.defaultProvider ?? DEFAULTS.cloud.defaultProvider,
        models: raw.cloud?.models ?? {},
        providers: raw.cloud?.providers ?? {},
      },
      local: {
        defaultModel: raw.local?.defaultModel ?? DEFAULTS.local.defaultModel,
        defaultProvider: raw.local?.defaultProvider ?? DEFAULTS.local.defaultProvider,
        models: raw.local?.models ?? {},
        providers: raw.local?.providers ?? {},
      },
      providerMode: raw.providerMode ?? DEFAULTS.providerMode,
      maxWorkers: raw.maxWorkers ?? DEFAULTS.maxWorkers,
      parallelWorkers: raw.parallelWorkers ?? DEFAULTS.parallelWorkers,
      maxRetries: raw.maxRetries ?? DEFAULTS.maxRetries,
      stallTimeout: raw.stallTimeout ?? DEFAULTS.stallTimeout,
      dangerousCommands: raw.dangerousCommands ?? DEFAULTS.dangerousCommands,
    };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

// ── Config persistence ───────────────────────────────────────────────────────

export function configExists(): boolean {
  return existsSync(join(EXTENSION_ROOT, "config.json"));
}

export function saveConfig(config: OrchestratorConfig): void {
  const configPath = join(EXTENSION_ROOT, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Model resolution ───────────────────────────────────────────────────────

/**
 * Resolve the model string for a given agent type and provider mode.
 * Agent-specific overrides take priority over provider default.
 */
export function resolveModel(
  agentType: string,
  config: OrchestratorConfig,
  mode: "cloud" | "local" = "cloud",
): string {
  if (mode === "local") {
    return config.local.models[agentType] ?? config.local.defaultModel;
  }
  return config.cloud.models[agentType] ?? config.cloud.defaultModel;
}

// ── Cloud health check ─────────────────────────────────────────────────────

let cloudHealthStatus: "unknown" | "available" | "unavailable" = "unknown";
let lastHealthCheck = 0;

/** Check if cloud provider is reachable (fan binary exists and responds) */
async function checkCloudHealth(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`${process.execPath} --version`, { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get cloud status with 5-minute cache.
 */
export async function getCloudStatus(): Promise<"available" | "unavailable"> {
  const now = Date.now();
  if (cloudHealthStatus !== "unknown" && (now - lastHealthCheck) < 300_000) {
    return cloudHealthStatus === "available" ? "available" : "unavailable";
  }
  lastHealthCheck = now;
  const healthy = await checkCloudHealth();
  cloudHealthStatus = healthy ? "available" : "unavailable";
  return cloudHealthStatus;
}

/** Get current cloud health status (cached value) */
export function getCloudHealthCached(): "unknown" | "available" | "unavailable" {
  return cloudHealthStatus;
}
