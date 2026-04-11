export { orchestratorExtension, default } from "./orchestrator-extension.js";

// Public types
export type {
    TaskType,
    TaskStatus,
    WorkerType,
    ExecutionMode,
    WorkerState,
    ProviderMode,
    SubagentTask,
    TaskClassification,
    UsageStats,
    SingleResult,
    SubagentDetails,
    OrchestratorState,
    OrchestratorConfig,
    AgentConfig,
    AgentDiscoveryResult,
    WorkerHandle,
    Waiter,
    ToolCallInfo,
    WorkerProgress,
} from "./types.js";

// Public classes
export { TaskManager } from "./task-manager.js";
export type { CreateTaskConfig } from "./task-manager.js";

// Agent discovery
export { discoverAgents, formatAgentList } from "./agents.js";
export type { AgentScope } from "./agents.js";

// Orchestrator prompts
export {
    COORDINATOR_PROMPT,
    PLANNING_PROMPT,
    formatTaskNotification,
    parseVerdict,
} from "./agents.js";

// Configuration
export {
    loadConfig,
    resolveModel,
    getCloudStatus,
    getCloudHealthCached,
    DEFAULTS,
} from "./config.js";

// Worker registry and slot pool
export {
    genWorkerId,
    registerWorker,
    getWorker,
    listWorkers,
    activeWorkers,
    hasActiveWriteWorker,
    updateWorker,
    acquireSlot,
    releaseSlot,
    getQueueLength,
    statusIcon,
    statusColor,
} from "./workers.js";

// Permissions
export { isDangerousCommand } from "./permissions.js";

// Task management utilities
export { formatTaskList } from "./task-manager.js";

// Subprocess runner utilities
export {
    runSingleAgent,
    runSingleAgentWithRetry,
    runSingleAgentWithFallback,
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
