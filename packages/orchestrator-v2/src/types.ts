/**
 * FAN Orchestrator v2 — Type definitions
 */

/** Types of worker agents */
export type AgentType = string;

/** Worker lifecycle states */
export type WorkerState = "spawning" | "running" | "completed" | "failed" | "aborted";

/** Orchestrator configuration */
export interface OrchestratorConfig {
  cloud: {
    defaultModel: string;
    defaultProvider: string;
    models: Record<string, string>;
    providers: Record<string, { name: string; models: string[]; apiBase?: string }>;
  };
  local: {
    defaultModel: string;
    defaultProvider: string;
    models: Record<string, string>;
    providers: Record<string, { name: string; models: string[]; apiBase?: string }>;
  };
  providerMode: "cloud" | "local" | "auto";
  maxWorkers: number;
  parallelWorkers: number;
  maxRetries: number;
  stallTimeout: number;
  dangerousCommands: string[];
}

/** Result returned by a worker after completion */
export interface WorkerResult {
  text: string;
  messageCount: number;
}

/** Handle for a spawned worker */
export interface WorkerHandle {
  id: string;
  agentType: AgentType;
  model: string;
  status: WorkerState;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
}

/** Parsed task notification from worker XML */
export interface TaskNotification {
  taskId: string;
  status: string;
  agentType: string;
  model: string;
  summary: string;
  result: string;
  messageCount: number;
  durationMs: number;
}

/** Task status values */
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

/** Tracked task with dependencies */
export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Agent definition with prompt, tools, and flags */
export interface AgentDefinition {
  type: AgentType;
  label: string;
  prompt: string;
  tools: string[];
  readOnly: boolean;
  description: string;
  useFor: string;
  icon: string;
}

/** Waiter in the worker slot queue */
export type Waiter = { agentType: AgentType; resolve: () => void };

/** Tool call info extracted from worker events */
export interface ToolCallInfo {
  name: string;
  preview: string;
}

/** Progress info passed from rpc.ts to index.ts via onProgress */
export interface WorkerProgress {
  status: string;
  messageCount: number;
  toolCalls?: ToolCallInfo[];
  model?: string;
}

/**
 * For colors, use theme.fg("muted", text), theme.fg("success", text), etc.
 */
