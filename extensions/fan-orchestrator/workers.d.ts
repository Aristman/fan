/**
 * FAN Orchestrator — Worker Registry and Slot Pool
 *
 * Manages worker lifecycle (registry) and concurrency (slot pool).
 * Only one implement worker can run at a time.
 * Explore/plan/verify workers share a separate parallel pool.
 */
import type { WorkerHandle, WorkerState, WorkerType } from "./types.js";
/** Generate a unique worker ID */
export declare function genWorkerId(): string;
/** Register a new worker */
export declare function registerWorker(handle: WorkerHandle): void;
/** Get a worker by ID */
export declare function getWorker(id: string): WorkerHandle | undefined;
/** List all workers */
export declare function listWorkers(): WorkerHandle[];
/** Get workers with active (non-terminal) status */
export declare function activeWorkers(): WorkerHandle[];
/** Check if any write (implement) worker is currently active */
export declare function hasActiveWriteWorker(): boolean;
/** Update a worker's fields */
export declare function updateWorker(id: string, updates: Partial<WorkerHandle>): void;
/**
 * Acquire a slot for a worker of the given type.
 * Blocks if the pool is full.
 * - Implement workers: max 1 at a time (exclusive write slot)
 * - Other workers: limited by maxParallel
 */
export declare function acquireSlot(agentType: WorkerType, maxParallel: number): Promise<void>;
/**
 * Release a slot after a worker completes.
 * Wakes the next waiter in the queue if applicable.
 */
export declare function releaseSlot(agentType: WorkerType, _maxParallel: number): void;
/** Get the current queue length */
export declare function getQueueLength(): number;
/** Status icon for worker states */
export declare function statusIcon(status: WorkerState): string;
/** Status text with color (plain text fallback if no theme) */
export declare function statusColor(status: WorkerState, text: string, theme?: {
    fg: (color: string, t: string) => string;
}): string;
export declare function _resetRegistry(): void;
/** Reset only the slot pool and FIFO queue, preserving the workers registry */
export declare function resetSlots(): void;
/**
 * Remove workers that reached a terminal state (completed/failed/aborted)
 * longer than maxAgeMs ago. Keeps active workers and recently terminated ones.
 */
export declare function pruneOldWorkers(maxAgeMs?: number): void;
/**
 * Finalize a worker after its run ends. No-op if the worker is unknown
 * or already in the terminal "aborted" state (never overwrites aborted).
 */
export declare function finalizeWorker(id: string, success: boolean, result?: {
    errorMessage?: string;
    stderr?: string;
    stopReason?: string;
}): void;
//# sourceMappingURL=workers.d.ts.map