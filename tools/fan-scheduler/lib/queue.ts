import type { TaskConfig } from "./config-loader.js";

/**
 * Task queue skeleton (F-4.1).
 * Single-consumer execution, state machine and auto-run of the next task
 * are implemented in F-4.3; execution pipeline in F-4.4.
 */
export class TaskQueue {
	readonly pending: TaskConfig[] = [];
	isRunning = false;

	enqueue(task: TaskConfig): void {
		this.pending.push(task);
	}

	/** TODO(F-4.3): run the next pending task if idle. */
	async runNext(): Promise<void> {
		// skeleton — no execution yet
	}

	/** TODO(F-4.3): pause the currently running task, preserving the queue. */
	pauseCurrent(): void {
		// skeleton — no execution yet
	}
}
