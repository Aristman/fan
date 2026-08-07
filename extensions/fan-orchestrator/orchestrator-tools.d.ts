/**
 * FAN Orchestrator — Coordinator Tools
 *
 * LLM-callable tools for task delegation, tracking, and classification.
 * Uses the subagent runner to spawn fna subprocesses.
 */
import { type ExtensionAPI } from "@seaagents/fan-coding-agent";
import type { TaskManager } from "./task-manager.js";
import type { OrchestratorConfig } from "./types.js";
/** Worker lifecycle callbacks for live widget tracking */
export interface WorkerLifecycle {
    genWorkerId?: () => string;
    onWorkerStart?: (id: string, agentType: string, model: string) => void;
    onWorkerStop?: (id: string, success: boolean, result: import("./types.js").SingleResult | null) => void;
}

/**
 * Register all orchestrator tools with the extension API.
 */
export declare function registerOrchestratorTools(
    fan: ExtensionAPI,
    taskManager: TaskManager,
    config: OrchestratorConfig,
    workerLifecycle?: WorkerLifecycle
): void;
//# sourceMappingURL=orchestrator-tools.d.ts.map