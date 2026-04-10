/** Task types the orchestrator can classify and route */
export type TaskType = "coding" | "quick" | "analysis" | "chat";

/** Status of a sub-agent task */
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

/** A task to be delegated to a sub-agent */
export interface SubagentTask {
	id: string;
	type: TaskType;
	status: TaskStatus;
	description: string;
	agentType: "explore" | "plan" | "implement" | "verify";
	parentTaskId?: string;
	blocks?: string[];
	result?: string;
	createdAt: Date;
	updatedAt: Date;
}

/** Result of classifying a user message into a task type */
export interface TaskClassification {
	taskType: TaskType;
	confidence: number;
	reasoning: string;
}
