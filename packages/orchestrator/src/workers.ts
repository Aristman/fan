/**
 * FAN Orchestrator — Worker Registry and Slot Pool
 *
 * Manages worker lifecycle (registry) and concurrency (slot pool).
 * Only one implement worker can run at a time.
 * Explore/plan/verify workers share a separate parallel pool.
 */

import { randomUUID } from "node:crypto";
import type { WorkerHandle, WorkerState, WorkerType, Waiter } from "./types.js";

// ---- Worker Registry ----

const workers = new Map<string, WorkerHandle>();

/** Generate a unique worker ID */
export function genWorkerId(): string {
    return randomUUID();
}

/** Register a new worker */
export function registerWorker(handle: WorkerHandle): void {
    workers.set(handle.id, handle);
}

/** Get a worker by ID */
export function getWorker(id: string): WorkerHandle | undefined {
    return workers.get(id);
}

/** List all workers */
export function listWorkers(): WorkerHandle[] {
    return Array.from(workers.values());
}

/** Get workers with active (non-terminal) status */
export function activeWorkers(): WorkerHandle[] {
    const terminalStates: WorkerState[] = ["completed", "failed", "aborted"];
    return listWorkers().filter((w) => !terminalStates.includes(w.status));
}

/** Check if any write (implement) worker is currently active */
export function hasActiveWriteWorker(): boolean {
    return activeWorkers().some((w) => w.agentType === "implement");
}

/** Update a worker's fields */
export function updateWorker(id: string, updates: Partial<WorkerHandle>): void {
    const worker = workers.get(id);
    if (worker) {
        Object.assign(worker, updates);
    }
}

// ---- Slot Pool ----

// Track current slot usage per agent type
const slotCount = new Map<WorkerType, number>();

// FIFO queue of waiting workers
const queue: Waiter[] = [];

/**
 * Acquire a slot for a worker of the given type.
 * Blocks if the pool is full.
 * - Implement workers: max 1 at a time (exclusive write slot)
 * - Other workers: limited by maxParallel
 */
export function acquireSlot(agentType: WorkerType, maxParallel: number): Promise<void> {
    const current = slotCount.get(agentType) ?? 0;
    const effectiveMax = agentType === "implement" ? 1 : maxParallel;

    if (current < effectiveMax) {
        // Additional check: if implement, also check no other write workers
        if (agentType === "implement" && hasActiveWriteWorker()) {
            // Must wait
            return new Promise<void>((resolve) => {
                queue.push({ agentType, resolve });
            });
        }

        slotCount.set(agentType, current + 1);
        return Promise.resolve();
    }

    // Pool full, queue up
    return new Promise<void>((resolve) => {
        queue.push({ agentType, resolve });
    });
}

/**
 * Release a slot after a worker completes.
 * Wakes the next waiter in the queue if applicable.
 */
export function releaseSlot(agentType: WorkerType, _maxParallel: number): void {
    const current = slotCount.get(agentType) ?? 0;
    if (current > 0) {
        slotCount.set(agentType, current - 1);
    }

    // Wake next waiter in queue (FIFO)
    while (queue.length > 0) {
        const waiter = queue[0];
        const waiterCurrent = slotCount.get(waiter.agentType) ?? 0;
        const effectiveMax = waiter.agentType === "implement" ? 1 : _maxParallel;

        if (waiter.agentType === "implement" && hasActiveWriteWorker()) {
            break; // Can't release write slot yet
        }

        if (waiterCurrent < effectiveMax) {
            queue.shift();
            slotCount.set(waiter.agentType, waiterCurrent + 1);
            waiter.resolve();
        } else {
            break; // Pool still full for this type
        }
    }
}

/** Get the current queue length */
export function getQueueLength(): number {
    return queue.length;
}

// ---- Display Helpers ----

/** Status icon for worker states */
export function statusIcon(status: WorkerState): string {
    const icons: Record<WorkerState, string> = {
        spawning: "⏳",
        running: "▶",
        completed: "✓",
        failed: "✗",
        aborted: "⊘",
    };
    return icons[status] ?? "?";
}

/** Status text with color (plain text fallback if no theme) */
export function statusColor(status: WorkerState, text: string, theme?: { fg: (color: string, t: string) => string }): string {
    if (!theme) return text;
    const colors: Record<WorkerState, string> = {
        spawning: "warning",
        running: "accent",
        completed: "success",
        failed: "error",
        aborted: "muted",
    };
    return theme.fg(colors[status], text);
}

// For testing: reset state
export function _resetRegistry(): void {
    workers.clear();
    slotCount.clear();
    queue.length = 0;
}
