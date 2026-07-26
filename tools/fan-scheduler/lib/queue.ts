import type { TaskConfig } from "./config-loader.js";
import { logger } from "./logger.js";

/**
 * Terminal status of an executed task.
 * "timeout" and "budget_exceeded" are produced by the execution pipeline (F-4.4)
 * and budget monitor (F-4.9); the queue itself only emits "completed"/"failed".
 */
export type TaskStatus = "completed" | "failed" | "timeout" | "budget_exceeded";

/**
 * Result of a single task execution, produced by the TaskExecutor (F-4.4).
 * Optional fields are forward-compatible with budget monitoring (F-4.9)
 * and retry/backoff (F-4.10).
 */
export interface TaskResult {
	/** Name of the executed task (TaskConfig.name) */
	taskName: string;
	status: TaskStatus;
	/** Wall-clock execution time in milliseconds */
	durationMs: number;
	/** ISO 8601 execution start timestamp */
	startedAt: string;
	/** ISO 8601 execution finish timestamp */
	finishedAt: string;
	/** Tokens consumed; null/undefined = unknown or not metered */
	tokensUsed?: number | null;
	/** Error description when status is "failed" or "timeout" */
	error?: string;
	/** Number of execution attempts (1 = no retries; used by F-4.10) */
	attempts?: number;
}

/**
 * Executes a single task end-to-end (session + message + budget — F-4.4).
 * Implementations should resolve with a TaskResult instead of throwing;
 * thrown errors are treated as unexpected failures and do not break the queue.
 */
export type TaskExecutor = (task: TaskConfig) => Promise<TaskResult>;

/** Queue state machine: idle ↔ running ↔ paused. */
export type QueueState = "idle" | "running" | "paused";

const notConfiguredExecutor: TaskExecutor = () =>
	Promise.reject(new Error("TaskQueue: no TaskExecutor configured — pass one to the constructor (see F-4.4)"));

/**
 * Single-consumer task queue (F-4.3).
 *
 * Guarantees strictly one task executing at a time:
 * - enqueue() appends to the pending list and kicks runNext() when idle;
 * - runNext() starts the next pending task only when nothing is executing;
 * - after the executor settles (success or failure), finally{} chains runNext();
 * - pauseCurrent() stops auto-advance: the in-flight task is allowed to settle,
 *   but the next pending task does not start until runNext() is called again.
 */
export class TaskQueue {
	readonly pending: TaskConfig[] = [];

	private readonly executor: TaskExecutor;
	private queueState: QueueState = "idle";
	private activeTask: TaskConfig | null = null;
	private activeStartedAt = 0;
	private lastTaskResult: TaskResult | null = null;

	constructor(executor: TaskExecutor = notConfiguredExecutor) {
		this.executor = executor;
	}

	get state(): QueueState {
		return this.queueState;
	}

	get isRunning(): boolean {
		return this.queueState === "running";
	}

	/** Task currently being executed (null when idle or paused-and-settled). */
	get currentTask(): TaskConfig | null {
		return this.activeTask;
	}

	/** Result of the most recently finished task (null before the first one). */
	get lastResult(): TaskResult | null {
		return this.lastTaskResult;
	}

	/** Appends a task to the pending list; starts it immediately if the queue is idle. */
	enqueue(task: TaskConfig): void {
		this.pending.push(task);
		void this.runNext();
	}

	/**
	 * Starts the next pending task if the queue is not already executing one.
	 * When called while paused, resumes auto-advance: the next task starts as soon
	 * as the in-flight (paused) task settles, or immediately if it already has.
	 */
	async runNext(): Promise<void> {
		if (this.queueState === "running") return;
		if (this.activeTask !== null) {
			// A paused task is still settling — resume auto-advance; its finally{} block
			// will pick up the next pending task. Single-flight invariant preserved.
			this.queueState = "running";
			return;
		}
		const task = this.pending.shift();
		if (task === undefined) {
			this.queueState = "idle";
			return;
		}
		this.queueState = "running";
		this.activeTask = task;
		this.activeStartedAt = Date.now();
		logger.info(`[queue] task "${task.name}" started (${this.pending.length} pending)`);
		try {
			this.lastTaskResult = await this.executor(task);
			logger.info(
				`[queue] task "${task.name}" finished status=${this.lastTaskResult.status} durationMs=${this.lastTaskResult.durationMs}`,
			);
		} catch (error) {
			// Executor threw unexpectedly — record a failure and keep the queue alive.
			const message = error instanceof Error ? error.message : String(error);
			this.lastTaskResult = {
				taskName: task.name,
				status: "failed",
				durationMs: Date.now() - this.activeStartedAt,
				startedAt: new Date(this.activeStartedAt).toISOString(),
				finishedAt: new Date().toISOString(),
				error: message,
			};
			logger.error(`[queue] task "${task.name}" failed with an unexpected error: ${message}`);
		} finally {
			this.activeTask = null;
			if (this.queueState === "running") {
				this.queueState = "idle";
				await this.runNext();
			}
			// If paused: stay paused — a later runNext() call resumes the queue.
		}
	}

	/**
	 * Pauses the queue: isRunning becomes false, the pending list is left untouched,
	 * and the next task will not auto-start when the in-flight task settles.
	 * No-op when the queue is idle or already paused.
	 */
	pauseCurrent(): void {
		if (this.queueState === "running") {
			this.queueState = "paused";
			logger.info(`[queue] paused — task "${this.activeTask?.name}" will settle, next task will not auto-start`);
		}
	}
}
