/**
 * FAN Orchestrator — Coordinator Tools
 *
 * LLM-callable tools for task delegation, tracking, and classification.
 * Uses the subagent runner to spawn fna subprocesses.
 */
import { type ExtensionAPI } from "@seaagents/fan-coding-agent";
import type { TaskManager } from "./task-manager.js";
import type { OrchestratorConfig } from "./types.js";
/**
 * Register all orchestrator tools with the extension API.
 */
export declare function registerOrchestratorTools(fan: ExtensionAPI, taskManager: TaskManager, config: OrchestratorConfig): void;
//# sourceMappingURL=orchestrator-tools.d.ts.map