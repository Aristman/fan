/**
 * FAN Orchestrator — Core Types
 */

/** Worker agent type, maps to built-in agent definitions */
export type WorkerType = "explore" | "plan" | "implement" | "verify";

/** How tasks are executed */
export type ExecutionMode = "single" | "parallel" | "chain";

/** Task classification for model routing */
export type TaskType = "coding" | "quick" | "analysis" | "chat";

/** Task lifecycle status */
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

/** Agent definition loaded from .md file */
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	filePath: string;
}

/** Result of agent discovery */
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/** A single tracked task */
export interface SubagentTask {
	id: string;
	type: TaskType;
	status: TaskStatus;
	description: string;
	agentType: WorkerType;
	parentTaskId?: string;
	blocks?: string[];
	result?: string;
	error?: string;
	usage?: UsageStats;
	createdAt: Date;
	updatedAt: Date;
}

/** Task classification result */
export interface TaskClassification {
	taskType: TaskType;
	workerType: WorkerType;
	confidence: number;
	reasoning: string;
}

/** Usage stats for a single subagent execution */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent execution */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "builtin" | "unknown";
	task: string;
	exitCode: number;
	messages: any[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

/** Details attached to tool results for TUI rendering */
export interface SubagentDetails {
	mode: ExecutionMode;
	agentScope: "user" | "project" | "both";
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Orchestrator state (managed by extension) */
export interface OrchestratorState {
	enabled: boolean;
	tasks: Map<string, SubagentTask>;
}
