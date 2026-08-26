/**
 * FAN Orchestrator — shared TypeScript declarations
 */

/** Valid worker/agent types */
export type WorkerType =
  | "explore"
  | "plan"
  | "implement"
  | "verify"
  | "bug-fix"
  | "code-research"
  | "tests-impl"
  | "docs-impl";

/** Provider selection mode */
export type ProviderMode = "auto" | "cloud" | "local";

/** Task lifecycle status */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "blocked";

/** Per-agent model overrides */
export type AgentModelMap = Partial<Record<WorkerType, string>>;

/** Named snapshot of the model-related part of the config */
export interface ModelPreset {
  cloud: {
    model: string;
    models: AgentModelMap;
  };
  local: {
    model: string;
    models: AgentModelMap;
  };
  providerMode: ProviderMode;
}

/** Per-agent temperature overrides */
export type AgentTemperatureMap = Partial<Record<WorkerType, number | null>>;

/** Agent timeout overrides */
export type AgentTimeoutMap = Partial<Record<WorkerType, number>>;

/** Orchestrator configuration schema */
export interface OrchestratorConfig {
  cloud: {
    model: string;
    models: AgentModelMap;
  };
  local: {
    model: string;
    models: AgentModelMap;
  };
  providerMode: ProviderMode;
  /** Named model-config presets */
  presets: Record<string, ModelPreset>;
  /** Currently active preset name (null = none) */
  activePreset: string | null;
  coordinatorDefault: boolean;
  parallelWorkers: number;
  workerTimeout: number;
  stallTimeout: number;
  planTimeout: number;
  maxRetries: number;
  agentTimeouts: AgentTimeoutMap;
  /** Default temperature for all workers (0.0-1.0) */
  temperature: number;
  /**
   * Worker context enrichment settings.
   * When enabled, git state and project tree are auto-collected and merged
   * into the worker context (explicit coordinator context takes priority).
   */
  contextEnrichment: {
    enabled: boolean;
    includeGitState: boolean;
    includeProjectTree: boolean;
  };
  /** Per-agent temperature overrides */
  agentTemperature: AgentTemperatureMap;
  dangerousCommands: string[];
}

/** Result of discovering agents */
export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

/** Agent definition */
export interface AgentConfig {
  name: WorkerType | string;
  description: string;
  useFor?: string;
  icon?: string;
  tools?: string[];
  readOnly: boolean;
  model?: string;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath: string;
}

/** Single subagent execution result */
export interface SingleResult {
  agent: string;
  agentSource: string;
  task: string;
  exitCode: number;
  stopReason?: "error" | "aborted";
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  stderr: string;
  errorMessage?: string;
  usage: UsageStats;
  model?: string;
  text?: string;
  step?: number;
  startTime: number;
  endTime?: number;
  progress?: WorkerProgress;
}

/** Usage statistics */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Live worker progress */
export interface WorkerProgress {
  status: string;
  messageCount: number;
  toolCalls: ToolCallInfo[];
  model?: string;
}

/** Tool call info for progress display */
export interface ToolCallInfo {
  name: string;
  args?: unknown;
  preview?: string;
}

/** Subagent task descriptor */
export interface SubagentTask {
  agent: string;
  task: string;
  cwd?: string;
}

/** Subagent details passed to onUpdate */
export interface SubagentDetails {
  agent: string;
  agentSource: string;
  task: string;
  step?: number;
  startTime: number;
  endTime?: number;
  progress?: WorkerProgress;
}

/** Chain plan step descriptor (stored in details.plan) */
export interface ChainPlanStep {
  agent: string;
  task: string;
}

/** Additional chain-mode fields present in SubagentDetails when mode="chain" */
export interface ChainDetailsExtra {
  /** Total number of planned steps */
  totalSteps?: number;
  /** Full chain plan: agent + task for each step */
  plan?: ChainPlanStep[];
}

/** Task classification result */
export interface TaskClassification {
  workerType: WorkerType;
  confidence: number;
  reasoning: string;
}

/** Worker handle for registry */
export interface WorkerHandle {
  id: string;
  agentType?: string;
  model?: string;
  status: WorkerState;
  startTime?: number;
  endTime?: number;
  error?: string;
  stopReason?: string;
  abortController?: AbortController;
}

/** Worker runtime state */
export type WorkerState = "spawning" | "running" | "completed" | "failed" | "aborted";

/** Waiter state for slot queue */
export interface Waiter {
  id: string;
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
}

/** Orchestrator runtime state */
export interface OrchestratorState {
  coordinatorActive: boolean;
  configInitialized: boolean;
  taskWidgetCollapsed: boolean;
}

/** Execution mode for delegate_task */
export type ExecutionMode = "single" | "chain" | "parallel";

/**
 * Relevant file entry for worker context: a plain path or a structured descriptor.
 * Forward-compatible contract with super-orchestrator v3 work_package.context
 * (spec_super-orchestrator_v3_2026-08-10.md §3.3.2).
 */
export type RelevantFile =
  | string
  | {
      path: string;
      lines?: string;
      purpose?: string;
    };

/**
 * Context injected into a worker's prompt between the agent system prompt and the task.
 *
 * parentSummary / relevantFiles / constraints form the forward-compatible contract
 * with super-orchestrator v3 work_package.context (spec_super-orchestrator_v3_2026-08-10.md §3.3.2).
 * previousFindings / gitState / projectTree are an optional FAN-specific superset.
 */
export interface WorkerContext {
  /** Forward-compatible contract with super-orchestrator v3 work_package.context. */
  parentSummary?: string;
  /** Forward-compatible contract with super-orchestrator v3 work_package.context. */
  relevantFiles?: RelevantFile[];
  /** Forward-compatible contract with super-orchestrator v3 work_package.context. */
  constraints?: string[];
  /** Optional superset: condensed findings from previous workers. */
  previousFindings?: string;
  /** Optional superset: git status/recent commits (auto-collected when omitted). */
  gitState?: string;
  /** Optional superset: project directory tree (auto-collected when omitted). */
  projectTree?: string;
}
