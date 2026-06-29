/**
 * FAN Orchestrator — Configuration
 *
 * Loads config from config.json with fallback to defaults.
 * Provides model resolution and cloud health checking.
 */
import type { OrchestratorConfig, WorkerType } from "./types.js";
/** Default configuration values */
export declare const DEFAULTS: OrchestratorConfig;
/**
 * Load orchestrator configuration.
 * Reads from config.json next to this module (dist/ directory),
 * merges with defaults. Falls back to defaults on missing file or parse error.
 */
export declare function loadConfig(): OrchestratorConfig;
/**
 * Resolve the model to use for a given agent type.
 * Returns the model for the current provider mode.
 */
export declare function resolveModel(agentType: WorkerType, config: OrchestratorConfig, mode?: "cloud" | "local" | "auto"): string;
/**
 * Get cloud provider status, with 5-minute cache.
 */
export declare function getCloudStatus(): Promise<"available" | "unavailable">;
/**
 * Synchronous getter for cached cloud health value.
 * Returns "unknown" if no check has been performed yet.
 */
export declare function getCloudHealthCached(): "unknown" | "available" | "unavailable";
//# sourceMappingURL=config.d.ts.map