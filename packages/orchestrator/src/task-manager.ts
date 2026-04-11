/**
 * Task Manager — Orchestrator task lifecycle management
 *
 * Tracks tasks through their lifecycle: pending → in_progress → completed/failed/blocked
 * Provides CRUD operations, filtering, and session persistence hooks.
 */

import { randomUUID } from "node:crypto";
import type { SubagentTask, TaskStatus, TaskType, WorkerType, UsageStats } from "./types.js";

/** Valid status transitions */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	pending: ["in_progress", "blocked"],
	in_progress: ["completed", "failed", "blocked"],
	blocked: ["in_progress", "failed"],
	completed: [],
	failed: [],
};

export interface CreateTaskConfig {
	type?: TaskType;
	description: string;
	agentType: WorkerType;
	parentTaskId?: string;
	blocks?: string[];
}

export class TaskManager {
	private tasks = new Map<string, SubagentTask>();

	/**
	 * Create a new task.
	 */
	createTask(config: CreateTaskConfig): SubagentTask {
		const task: SubagentTask = {
			id: randomUUID(),
			type: config.type ?? "coding",
			status: "pending",
			description: config.description,
			agentType: config.agentType,
			parentTaskId: config.parentTaskId,
			blocks: config.blocks,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		this.tasks.set(task.id, task);
		return task;
	}

	/**
	 * Transition a task to in_progress status.
	 */
	startTask(id: string): SubagentTask {
		const task = this.getTaskOrThrow(id);
		this.validateTransition(task.status, "in_progress");
		task.status = "in_progress";
		task.updatedAt = new Date();
		return task;
	}

	/**
	 * Complete a task with a result.
	 */
	completeTask(id: string, result: string, usage?: UsageStats): SubagentTask {
		const task = this.getTaskOrThrow(id);
		this.validateTransition(task.status, "completed");
		task.status = "completed";
		task.result = result;
		task.usage = usage;
		task.updatedAt = new Date();
		// Unblock dependent tasks
		this.unblockDependents(id);
		return task;
	}

	/**
	 * Mark a task as failed.
	 */
	failTask(id: string, error: string): SubagentTask {
		const task = this.getTaskOrThrow(id);
		this.validateTransition(task.status, "failed");
		task.status = "failed";
		task.error = error;
		task.updatedAt = new Date();
		return task;
	}

	/**
	 * Cancel a running task.
	 */
	cancelTask(id: string): SubagentTask {
		const task = this.getTaskOrThrow(id);
		// Allow cancel from any active state
		if (task.status !== "in_progress" && task.status !== "pending" && task.status !== "blocked") {
			throw new Error(`Cannot cancel task ${id}: status is "${task.status}"`);
		}
		task.status = "failed";
		task.error = "Cancelled";
		task.updatedAt = new Date();
		return task;
	}

	/**
	 * Block a task (e.g., waiting for dependencies).
	 */
	blockTask(id: string, reason?: string): SubagentTask {
		const task = this.getTaskOrThrow(id);
		this.validateTransition(task.status, "blocked");
		task.status = "blocked";
		if (reason) task.error = reason;
		task.updatedAt = new Date();
		return task;
	}

	/**
	 * Get a task by ID.
	 */
	getTask(id: string): SubagentTask | undefined {
		return this.tasks.get(id);
	}

	/**
	 * Get all tasks, optionally filtered by status.
	 */
	getTasks(filter?: { status?: TaskStatus; agentType?: WorkerType }): SubagentTask[] {
		let result = Array.from(this.tasks.values());
		if (filter?.status) {
			result = result.filter((t) => t.status === filter.status);
		}
		if (filter?.agentType) {
			result = result.filter((t) => t.agentType === filter.agentType);
		}
		// Sort by creation time, newest first
		return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	}

	/**
	 * Get tasks currently in progress.
	 */
	getActiveTasks(): SubagentTask[] {
		return this.getTasks({ status: "in_progress" });
	}

	/**
	 * Get total count of tasks by status.
	 */
	getStatusCounts(): Record<TaskStatus, number> {
		const counts: Record<TaskStatus, number> = {
			pending: 0,
			in_progress: 0,
			completed: 0,
			blocked: 0,
			failed: 0,
		};
		for (const task of this.tasks.values()) {
			counts[task.status]++;
		}
		return counts;
	}

	/**
	 * Remove completed and failed tasks from memory.
	 */
	clearCompleted(): number {
		let removed = 0;
		for (const [id, task] of this.tasks) {
			if (task.status === "completed" || task.status === "failed") {
				this.tasks.delete(id);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Clear all tasks.
	 */
	clearAll(): void {
		this.tasks.clear();
	}

	/**
	 * Get total number of tasks.
	 */
	get size(): number {
		return this.tasks.size;
	}

	/**
	 * Serialize tasks for session persistence.
	 */
	serialize(): Array<{ id: string; status: string; description: string; agentType: string; result?: string; error?: string }> {
		return this.getTasks().map((t) => ({
			id: t.id,
			status: t.status,
			description: t.description,
			agentType: t.agentType,
			result: t.result,
			error: t.error,
		}));
	}

	private getTaskOrThrow(id: string): SubagentTask {
		const task = this.tasks.get(id);
		if (!task) {
			throw new Error(`Task not found: ${id}`);
		}
		return task;
	}

	private validateTransition(current: TaskStatus, target: TaskStatus): void {
		const allowed = VALID_TRANSITIONS[current];
		if (!allowed.includes(target)) {
			throw new Error(`Invalid task transition: ${current} → ${target}`);
		}
	}

	private unblockDependents(completedTaskId: string): void {
		for (const task of this.tasks.values()) {
			if (task.status === "blocked" && task.blocks?.includes(completedTaskId)) {
				// Check if all blocking tasks are completed
				const allCompleted = task.blocks.every((blockId) => {
					const blocker = this.tasks.get(blockId);
					return blocker?.status === "completed";
				});
				if (allCompleted) {
					task.status = "pending";
					task.updatedAt = new Date();
				}
			}
		}
	}
}
