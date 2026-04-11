export { orchestratorExtension, default } from "./orchestrator-extension.js";

// Public types
export type {
	TaskType,
	TaskStatus,
	WorkerType,
	ExecutionMode,
	SubagentTask,
	TaskClassification,
	UsageStats,
	SingleResult,
	SubagentDetails,
	OrchestratorState,
	AgentConfig,
	AgentDiscoveryResult,
} from "./types.js";

// Public classes
export { TaskManager } from "./task-manager.js";
export type { CreateTaskConfig } from "./task-manager.js";

// Agent discovery
export { discoverAgents, formatAgentList } from "./agents.js";
export type { AgentScope } from "./agents.js";

// Subprocess runner utilities
export {
	runSingleAgent,
	getFinalOutput,
	getDisplayItems,
	formatUsageStats,
	formatTokens,
	mapWithConcurrencyLimit,
	getFnaInvocation,
	MAX_PARALLEL_TASKS,
	MAX_CONCURRENCY,
} from "./subagent-runner.js";
export type { DisplayItem } from "./subagent-runner.js";
