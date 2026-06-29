/**
 * Task Manager — Orchestrator task lifecycle management
 *
 * Tracks tasks through their lifecycle: pending → in_progress → completed/failed/blocked
 * Provides CRUD operations, filtering, and session persistence hooks.
 */
import { randomUUID } from "node:crypto";
/** All valid task statuses */
const ALL_STATUSES = ["pending", "in_progress", "completed", "failed", "blocked"];
export class TaskManager {
    tasks = new Map();
    /**
     * Create a new task.
     */
    createTask(config) {
        const task = {
            id: randomUUID(),
            type: config.type ?? "coding",
            status: "pending",
            description: config.description,
            agentType: config.agentType,
            parentTaskId: config.parentTaskId,
            blocks: config.blocks,
            owner: config.owner,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.tasks.set(task.id, task);
        // Bidirectional linking: add this task to blockedBy of tasks it references in blocks[]
        if (task.blocks && task.blocks.length > 0) {
            for (const blockId of task.blocks) {
                const blocker = this.tasks.get(blockId);
                if (blocker) {
                    if (!blocker.blockedBy)
                        blocker.blockedBy = [];
                    if (!blocker.blockedBy.includes(task.id)) {
                        blocker.blockedBy.push(task.id);
                    }
                }
            }
            // Cycle detection: check if this task is referenced by any of its blockers
            const visited = new Set();
            const hasCycle = (taskId) => {
                if (visited.has(taskId)) return false;
                visited.add(taskId);
                const t = this.tasks.get(taskId);
                if (t && t.blocks) {
                    // If any blocker's blocks includes the new task's ID → cycle
                    if (t.blocks.includes(task.id)) return true;
                    for (const depId of t.blocks) {
                        if (depId !== taskId && hasCycle(depId)) return true;
                    }
                }
                return false;
            };
            for (const blockId of task.blocks) {
                if (hasCycle(blockId)) {
                    task.status = "failed";
                    task.error = `Circular dependency detected involving task ${task.id}`;
                    break;
                }
            }
            // Check if any blocking tasks are not completed → auto-block
            const hasIncompleteBlocker = task.blocks.some((blockId) => {
                const blocker = this.tasks.get(blockId);
                return !blocker || blocker.status !== "completed";
            });
            if (hasIncompleteBlocker) {
                task.status = "blocked";
            }
        }
        return task;
    }
    /**
     * Transition a task to in_progress status.
     */
    startTask(id) {
        const task = this.getTaskOrThrow(id);
        this.validateTransition(task.status, "in_progress");
        task.status = "in_progress";
        task.updatedAt = new Date();
        return task;
    }
    /**
     * Complete a task with a result.
     */
    completeTask(id, result, usage) {
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
    failTask(id, error) {
        const task = this.getTaskOrThrow(id);
        this.validateTransition(task.status, "failed");
        task.status = "failed";
        task.error = error;
        task.updatedAt = new Date();
        // Unblock dependent tasks (they may need to handle the failure)
        this.unblockDependents(id);
        return task;
    }
    /**
     * Cancel a running task.
     */
    cancelTask(id) {
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
    blockTask(id, reason) {
        const task = this.getTaskOrThrow(id);
        this.validateTransition(task.status, "blocked");
        task.status = "blocked";
        if (reason)
            task.error = reason;
        task.updatedAt = new Date();
        return task;
    }
    /**
     * Update a task's fields.
     * When status changes to "completed", auto-unblocks dependents.
     */
    updateTask(id, updates) {
        const task = this.getTaskOrThrow(id);
        if (updates.status !== undefined && updates.status !== task.status) {
            const oldStatus = task.status;
            task.status = updates.status;
            if (updates.status === "completed") {
                this.unblockDependents(id);
            }
        }
        if (updates.subject !== undefined) {
            task.description = updates.subject;
        }
        if (updates.description !== undefined) {
            task.description = updates.description;
        }
        if (updates.owner !== undefined) {
            task.owner = updates.owner;
        }
        if (updates.blocks !== undefined) {
            // Update blocks and relink blockedBy
            // Remove from old blockers' blockedBy
            if (task.blocks) {
                for (const oldBlockId of task.blocks) {
                    const oldBlocker = this.tasks.get(oldBlockId);
                    if (oldBlocker?.blockedBy) {
                        oldBlocker.blockedBy = oldBlocker.blockedBy.filter((bid) => bid !== task.id);
                    }
                }
            }
            task.blocks = updates.blocks;
            // Add to new blockers' blockedBy
            for (const newBlockId of updates.blocks) {
                const newBlocker = this.tasks.get(newBlockId);
                if (newBlocker) {
                    if (!newBlocker.blockedBy)
                        newBlocker.blockedBy = [];
                    if (!newBlocker.blockedBy.includes(task.id)) {
                        newBlocker.blockedBy.push(task.id);
                    }
                }
            }
        }
        task.updatedAt = new Date();
        return task;
    }
    /**
     * Get a task by ID.
     */
    getTask(id) {
        const task = this.tasks.get(id);
        if (task) return task;
        // Fallback: search by prefix (partial UUID match)
        return this.resolveByPrefix(id);
    }
    /**
     * Get all tasks, optionally filtered by status.
     */
    getTasks(filter) {
        let result = Array.from(this.tasks.values());
        if (filter?.status) {
            result = result.filter((t) => t.status === filter.status);
        }
        if (filter?.agentType) {
            result = result.filter((t) => t.agentType === filter.agentType);
        }
        if (filter?.owner) {
            result = result.filter((t) => t.owner === filter.owner);
        }
        // Sort by creation time, newest first
        return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    /**
     * Get tasks currently in progress.
     */
    getActiveTasks() {
        return this.getTasks({ status: "in_progress" });
    }
    /**
     * Get total count of tasks by status.
     */
    getStatusCounts() {
        const counts = {
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
    clearCompleted() {
        let removed = 0;
        const removedIds = [];
        for (const [id, task] of this.tasks) {
            if (task.status === "completed" || task.status === "failed") {
                removedIds.push(id);
                this.tasks.delete(id);
                removed++;
            }
        }
        // Scrub dead references from remaining tasks
        if (removedIds.length > 0) {
            for (const task of this.tasks.values()) {
                if (task.blocks) {
                    task.blocks = task.blocks.filter(bid => this.tasks.has(bid));
                }
                if (task.blockedBy) {
                    task.blockedBy = task.blockedBy.filter(bid => this.tasks.has(bid));
                }
            }
        }
        return removed;
    }
    /**
     * Clear all tasks.
     */
    clearAll() {
        this.tasks.clear();
    }
    /**
     * Get total number of tasks.
     */
    get size() {
        return this.tasks.size;
    }
    /**
     * Serialize tasks for session persistence.
     */
    serialize() {
        return this.getTasks().map((t) => ({
            id: t.id,
            status: t.status,
            description: t.description,
            agentType: t.agentType,
            result: t.result,
            error: t.error,
        }));
    }
    getTaskOrThrow(id) {
        const task = this.tasks.get(id);
        if (task) return task;
        // Fallback: search by prefix (partial UUID match)
        const resolved = this.resolveByPrefix(id);
        if (resolved) return resolved;
        throw new Error(`Task not found: ${id}`);
    }
    /**
     * Resolve a task by partial ID prefix.
     * Logs a warning when fallback resolution is used.
     * Throws if the prefix is ambiguous (matches multiple tasks).
     */
    resolveByPrefix(id) {
        if (!id || id.length < 8) return null;
        const prefix = id;
        let found = null;
        for (const [taskId, t] of this.tasks) {
            if (taskId.startsWith(prefix)) {
                if (found) {
                    throw new Error(`Task ID "${id}" is ambiguous (matches "${found.id}" and "${taskId}"). Use the full ID.`);
                }
                found = t;
            }
        }
        if (found) {
            console.warn(`[TaskManager] Resolved partial ID "${id}" → full ID "${found.id}"`);
        }
        return found;
    }
    unblockDependents(completedTaskId) {
        for (const task of this.tasks.values()) {
            if (task.status === "blocked" && task.blocks?.includes(completedTaskId)) {
                // Check if all blocking tasks are resolved (completed or failed)
                const allResolved = task.blocks.every((blockId) => {
                    const blocker = this.tasks.get(blockId);
                    return !blocker || blocker.status === "completed" || blocker.status === "failed";
                });
                if (allResolved) {
                    task.status = "pending";
                    // Note if any blocker failed
                    const failedBlockers = task.blocks.filter((blockId) => {
                        const blocker = this.tasks.get(blockId);
                        return blocker?.status === "failed";
                    });
                    if (failedBlockers.length > 0) {
                        task.error = `Dependency failed: ${failedBlockers.join(", ")}`;
                    }
                    task.updatedAt = new Date();
                }
            }
        }
    }
}
/**
 * Format a task list for display.
 */
export function formatTaskList(tasks) {
    if (tasks.length === 0)
        return "No tasks.";
    const statusIcons = {
        pending: "☐",
        in_progress: "◐",
        completed: "☑",
        blocked: "⛔",
        failed: "✗",
    };
    const isDone = (t) => t.status === "completed" || t.status === "failed";
    const order = {
        in_progress: 0,
        pending: 1,
        blocked: 2,
        completed: 3,
        failed: 4,
    };
    const sorted = [...tasks].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
    return sorted
        .map((t) => {
        const icon = statusIcons[t.status] ?? "?";
        const desc = t.description.length > 55 ? t.description.slice(0, 55) + "..." : t.description;
        const deps = t.blockedBy?.length ? ` (blocked by ${t.blockedBy.length})` : "";
        const owner = t.owner ? ` [${t.owner}]` : "";
        const status = t.status === "in_progress" ? " ⚡" : t.status === "blocked" ? " ⛔" : t.status === "failed" ? " ✗" : "";
        if (isDone(t)) {
            return `${icon} ~~${desc}${deps}${owner}~~`;
        }
        return `${icon}${status} ${desc}${deps}${owner}`;
    })
        .join("\n");
}
//# sourceMappingURL=task-manager.js.map