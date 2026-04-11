/**
 * FAN Orchestrator — Configuration
 *
 * Loads config from config.json with fallback to defaults.
 * Provides model resolution and cloud health checking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { OrchestratorConfig, WorkerType } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default configuration values */
export const DEFAULTS: OrchestratorConfig = {
	cloud: { model: "zai/glm-4.5-air" },
	local: { model: "ollama/qwen3:32b" },
	providerMode: "cloud",
	parallelWorkers: 3,
	workerTimeout: 300_000,
	maxRetries: 2,
	planTimeout: 300_000,
	agentTimeouts: {
		explore: 120_000,
		plan: 180_000,
		implement: 300_000,
		verify: 180_000,
	},
	dangerousCommands: [
		"rm -rf",
		"git push --force",
		"npm publish",
		"DROP TABLE",
		"TRUNCATE",
		"DELETE FROM",
		"mkfs",
		"shutdown",
	],
};

/** Cloud health cache */
let cloudHealthCached: "unknown" | "available" | "unavailable" = "unknown";
let cloudHealthCheckTime = 0;
const CLOUD_HEALTH_CACHE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Deep merge two objects (target overrides source).
 */
function deepMerge<T extends Record<string, any>>(source: T, target: Partial<T>): T {
	const result = { ...source };
	for (const key of Object.keys(target) as (keyof T)[]) {
		const targetVal = target[key];
		if (
			targetVal &&
			typeof targetVal === "object" &&
			!Array.isArray(targetVal) &&
			typeof source[key] === "object" &&
			!Array.isArray(source[key])
		) {
			result[key] = deepMerge(source[key] as any, targetVal as any) as T[keyof T];
		} else if (targetVal !== undefined) {
			result[key] = targetVal as T[keyof T];
		}
	}
	return result;
}

/**
 * Load orchestrator configuration.
 * Reads from config.json next to this module (dist/ directory),
 * merges with defaults. Falls back to defaults on missing file or parse error.
 */
export function loadConfig(): OrchestratorConfig {
	// Try config.json in the same directory as this compiled file (dist/)
	const configPath = path.join(__dirname, "config.json");

	if (fs.existsSync(configPath)) {
		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			const userConfig = JSON.parse(raw);
			return deepMerge(DEFAULTS, userConfig);
		} catch (e) {
			console.warn(
				`[FAN Orchestrator] Failed to parse config.json: ${(e as Error).message}. Using defaults.`,
			);
		}
	}

	return { ...DEFAULTS };
}

/**
 * Resolve the model to use for a given agent type.
 * Returns the model for the current provider mode.
 */
export function resolveModel(
	agentType: WorkerType,
	config: OrchestratorConfig,
	mode?: "cloud" | "local" | "auto",
): string {
	const providerMode = mode ?? config.providerMode;
	const provider = providerMode === "local" ? config.local : config.cloud;
	return provider.model;
}

/**
 * Check if cloud provider is available by running a quick health check.
 */
async function checkCloudHealth(): Promise<"available" | "unavailable"> {
	try {
		const invocation = getFnaInvocation(["--version"]);
		execSync(`${invocation.command} ${invocation.args.join(" ")}`, {
			timeout: 5000,
			stdio: "pipe",
		});
		return "available";
	} catch {
		return "unavailable";
	}
}

/**
 * Get cloud provider status, with 5-minute cache.
 */
export async function getCloudStatus(): Promise<"available" | "unavailable"> {
	const now = Date.now();
	if (
		now - cloudHealthCheckTime < CLOUD_HEALTH_CACHE_MS &&
		cloudHealthCached !== "unknown"
	) {
		return cloudHealthCached === "available" ? "available" : "unavailable";
	}
	cloudHealthCached = await checkCloudHealth();
	cloudHealthCheckTime = now;
	return cloudHealthCached;
}

/**
 * Synchronous getter for cached cloud health value.
 * Returns "unknown" if no check has been performed yet.
 */
export function getCloudHealthCached(): "unknown" | "available" | "unavailable" {
	return cloudHealthCached;
}

/** Get the fna binary invocation — reuse from subagent-runner */
function getFnaInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "fan", args };
}
