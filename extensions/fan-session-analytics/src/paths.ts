import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { AnalyticsConfig } from "./types.js";

// ============================================================================
// Global FAN root resolution
// ============================================================================

let cachedFanRoot: string | undefined;

/**
 * Initialise the FAN root by trying to import getAgentDir() from
 * @seaagents/fan-agent-core.  The result is cached so subsequent
 * calls are synchronous (getFanRoot / resolveReportsDir).
 *
 * Call once at extension load time (index.ts) — safe to call multiple times.
 */
export async function initFanRoot(): Promise<string> {
	if (cachedFanRoot) return cachedFanRoot;
	try {
		const mod = await import("@seaagents/fan-agent-core");
		if (typeof mod.getAgentDir === "function") {
			cachedFanRoot = join(mod.getAgentDir(), "..");
			return cachedFanRoot;
		}
	} catch {
		// Import unavailable — fallback
	}
	cachedFanRoot = join(homedir(), ".fan");
	return cachedFanRoot;
}

/**
 * Return the cached FAN root.  If initFanRoot() has not been called yet,
 * falls back to join(os.homedir(), ".fan") synchronously.
 */
export function getFanRoot(): string {
	if (cachedFanRoot) return cachedFanRoot;
	return join(homedir(), ".fan");
}

/**
 * Global reports directory: <fanRoot>/reports/session-analytics.
 */
export function getReportsRoot(): string {
	return join(getFanRoot(), "reports", "session-analytics");
}

// ============================================================================
// reports.dir resolution
// ============================================================================

/**
 * Resolve the effective reports directory from config.
 *
 * | cfg.reports.dir | Result |
 * |-----------------|--------|
 * | `"global"` (default) | `getReportsRoot()` → `~/.fan/reports/session-analytics` |
 * | Absolute path | Used as-is |
 * | Relative path | Resolved relative to `cwd` (backward-compat) |
 */
export function resolveReportsDir(cfg: AnalyticsConfig, cwd: string): string {
	const dir = cfg.reports.dir;
	if (dir === "global") return getReportsRoot();
	if (isAbsolute(dir)) return dir;
	return join(cwd, dir);
}

/**
 * Reset the cached fan root (for testing only).
 */
export function _resetCache(): void {
	cachedFanRoot = undefined;
}
