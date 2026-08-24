/**
 * Task Manager — Orchestrator task lifecycle management
 *
 * Tracks tasks through their lifecycle: pending → in_progress → completed/failed/blocked
 * Provides CRUD operations, filtering, and session persistence hooks.
 */
import type { SubagentTask, TaskStatus, TaskType, UsageStats, WorkerType } from "./types.js";
export interface CreateTaskConfig {
    type?: TaskType;
    description: string;
    agentType: WorkerType;
    parentTaskId?: string;
    blocks?: string[];
    owner?: string;
}
export declare class TaskManager {
    private tasks;
    /**
     * Create a new task.
     */
    createTask(config: CreateTaskConfig): SubagentTask;
    /**
     * Transition a task to in_progress status.
     */
    startTask(id: string): SubagentTask;
    /**
     * Complete a task with a result.
     */
    completeTask(id: string, result: string, usage?: UsageStats): SubagentTask;
    /**
     * Mark a task as failed.
     */
    failTask(id: string, error: string): SubagentTask;
    /**
     * Cancel a running task.
     */
    cancelTask(id: string): SubagentTask;
    /**
     * Block a task (e.g., waiting for dependencies).
     */
    blockTask(id: string, reason?: string): SubagentTask;
    /**
     * Update a task's fields.
     * When status changes to "completed", auto-unblocks dependents.
     */
    updateTask(id: string, updates: {
        status?: TaskStatus;
        subject?: string;
        description?: string;
        blocks?: string[];
        owner?: string;
    }): SubagentTask;
    /**
     * Get a task by ID.
     */
    getTask(id: string): SubagentTask | undefined;
    /**
     * Get all tasks, optionally filtered by status.
     */
    getTasks(filter?: {
        status?: TaskStatus;
        agentType?: WorkerType;
        owner?: string;
    }): SubagentTask[];
    /**
     * Get tasks currently in progress.
     */
    getActiveTasks(): SubagentTask[];
    /**
     * Get total count of tasks by status.
     */
    getStatusCounts(): Record<TaskStatus, number>;
    /**
     * Remove completed and failed tasks from memory.
     */
    clearCompleted(): number;
    /**
     * Clear all tasks.
     */
    clearAll(): void;
    /**
     * Get total number of tasks.
     */
    get size(): number;
    /**
     * Serialize tasks for session persistence.
     * Full per-task snapshot including links, owner, timestamps and metadata.
     */
    serialize(): Array<{
        id: string;
        type: string;
        status: string;
        description: string;
        agentType?: string;
        parentTaskId?: string;
        owner?: string;
        blocks: string[];
        blockedBy: string[];
        createdAt?: string;
        updatedAt?: string;
        result?: string;
        error?: string;
        metadata?: Record<string, unknown>;
    }>;
    /**
     * Replace the current task board from snapshot entries (see serialize()).
     * Skips garbage entries (never throws). in_progress tasks are restored as
     * pending with metadata.recovered = true; blocks/blockedBy links are rebuilt.
     */
    deserialize(entries: unknown): void;
    private getTaskOrThrow;
    private validateTransition;
    private unblockDependents;
}
/**
 * Format a task list for display.
 */
export declare function formatTaskList(tasks: SubagentTask[]): string;
//# sourceMappingURL=task-manager.d.ts.map