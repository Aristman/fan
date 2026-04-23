/**
 * FAN Orchestrator v2 — Task Registry
 *
 * CRUD operations for tracked tasks with dependency management.
 */

import type { Task, TaskStatus } from "./types.js";

const taskRegistry = new Map<string, Task>();
let taskIdCounter = 0;

function genTaskId(): string {
  const ts = Date.now().toString(36);
  const hash = (++taskIdCounter).toString(36);
  return `task-${ts}-${hash}`;
}

/**
 * Create a new task and register it.
 * Lazy linking: blocks[] can reference not-yet-created tasks.
 */
export function createTask(params: {
  subject: string;
  description?: string;
  owner?: string;
  blocks?: string[];
}): Task {
  const now = Date.now();
  const id = genTaskId();
  const blocks = params.blocks ?? [];

  const task: Task = {
    id,
    subject: params.subject,
    description: params.description ?? "",
    status: "pending",
    owner: params.owner,
    blocks,
    blockedBy: [],
    createdAt: now,
    updatedAt: now,
  };

  for (const blockedId of blocks) {
    const blocked = taskRegistry.get(blockedId);
    if (blocked) {
      blocked.blockedBy.push(id);
      blocked.updatedAt = now;
      if (task.status === "pending" && blocked.status === "pending") {
        blocked.status = "blocked";
      }
    }
  }

  if (task.blockedBy.length > 0) {
    task.status = "blocked";
  }

  taskRegistry.set(id, task);
  return task;
}

/**
 * Update task fields. When status changes to "completed", dependent tasks
 * are automatically unblocked if all their blockers are completed.
 */
export function updateTask(
  taskId: string,
  updates: Partial<Pick<Task, "status" | "subject" | "description" | "blocks">>,
): Task | null {
  const task = taskRegistry.get(taskId);
  if (!task) return null;

  const now = Date.now();
  if (updates.subject !== undefined) task.subject = updates.subject;
  if (updates.description !== undefined) task.description = updates.description;

  if (updates.blocks !== undefined) {
    for (const oldBlockedId of task.blocks) {
      const oldBlocked = taskRegistry.get(oldBlockedId);
      if (oldBlocked) {
        oldBlocked.blockedBy = oldBlocked.blockedBy.filter((id) => id !== taskId);
        oldBlocked.updatedAt = now;
      }
    }
    task.blocks = updates.blocks;
    for (const blockedId of task.blocks) {
      const blocked = taskRegistry.get(blockedId);
      if (blocked) {
        if (!blocked.blockedBy.includes(taskId)) {
          blocked.blockedBy.push(taskId);
        }
        if (blocked.status === "pending" && task.status !== "completed") {
          blocked.status = "blocked";
        }
        blocked.updatedAt = now;
      }
    }
    const isBlocked = task.blockedBy.some(
      (depId) => taskRegistry.get(depId)?.status !== "completed",
    );
    if (isBlocked && task.status === "pending") {
      task.status = "blocked";
    }
    task.updatedAt = now;
  }

  if (updates.status !== undefined && updates.status !== task.status) {
    const oldStatus = task.status;
    task.status = updates.status;
    task.updatedAt = now;

    if (updates.status === "completed" && oldStatus !== "completed") {
      for (const bid of task.blocks) {
        const blocked = taskRegistry.get(bid);
        if (blocked && blocked.status === "blocked") {
          const stillBlocked = blocked.blockedBy.some(
            (depId) => taskRegistry.get(depId)?.status !== "completed",
          );
          if (!stillBlocked) {
            blocked.status = "pending";
            blocked.updatedAt = now;
          }
        }
      }
    }
  } else {
    task.updatedAt = now;
  }

  return task;
}

/**
 * List tasks, optionally filtered by status or owner.
 * Results sorted by creation time (oldest first).
 */
export function listTasks(filters?: { status?: TaskStatus; owner?: string }): Task[] {
  let tasks = Array.from(taskRegistry.values());
  if (filters?.status) tasks = tasks.filter((t) => t.status === filters.status);
  if (filters?.owner) tasks = tasks.filter((t) => t.owner === filters.owner);
  return tasks.sort((a, b) => a.createdAt - b.createdAt);
}

/** Format task list as human-readable text */
export function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks.";
  const icon = (s: TaskStatus) =>
    s === "completed" ? "✅" : s === "in_progress" ? "🔄" : s === "failed" ? "❌" : s === "blocked" ? "🚫" : "⏳";
  return tasks
    .map((t) => {
      const deps = t.blockedBy.length > 0 ? ` [blocked by ${t.blockedBy.length}]` : "";
      return `${icon(t.status)} ${t.id}: ${t.subject}${deps}`;
    })
    .join("\n");
}

/** Get total task count */
export function taskCount(): number {
  return taskRegistry.size;
}

/** Clear all tasks */
export function clearTasks(): void {
  taskRegistry.clear();
}

/** Parse verification verdict from worker output */
export function parseVerdict(text: string): "PASS" | "FAIL" | "PARTIAL" | null {
  const match = text.match(/VERDICT:\s*\b(PASS|FAIL|PARTIAL)\b/i);
  return (match?.[1]?.toUpperCase() as "PASS" | "FAIL" | "PARTIAL") ?? null;
}

/** Reset task registry (for test isolation) */
export function __resetTaskRegistry(): void {
  taskRegistry.clear();
  taskIdCounter = 0;
}
