import type { FanApiClient, FanSessionMessage } from "./client.js";
import type { TaskConfig } from "./config-loader.js";
import { logger } from "./logger.js";
import type { TaskExecutor, TaskResult, TaskStatus } from "./queue.js";

/** Default delay between completion polls of GET /api/sessions/:id. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Internal marker: the task deadline expired (distinct from API/logic failures). */
class TaskTimeoutError extends Error {
	constructor(taskName: string, timeoutSeconds: number) {
		super(`Task "${taskName}" exceeded its timeout of ${timeoutSeconds}s`);
		this.name = "TaskTimeoutError";
	}
}

export interface TaskExecutorOptions {
	/** Polling interval for waitForCompletion (default 5000 ms). */
	pollIntervalMs?: number;
	/** Clock override (default Date.now) — for tests. */
	now?: () => number;
	/** Sleep override (default setTimeout-based) — for tests. */
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sumTokens(messages: FanSessionMessage[]): number {
	return messages.reduce((sum, m) => sum + (typeof m.tokens === "number" ? m.tokens : 0), 0);
}

/**
 * Execution pipeline (F-4.4): creates a real TaskExecutor for the TaskQueue.
 *
 * Per task:
 * 1. session = client.createSession(task.workspace)
 * 2. client.sendMessage(session.id, task.message)
 * 3. waitForCompletion(session.id, task.timeout) — see completion-signal note below
 * 4. client.setProjectBudget(task.workspace, task.budget_limit) — best-effort;
 *    errors are logged as warnings and ignored (per-project budget params are
 *    ignored by the current gateway anyway — see client.ts F-4.9 blocker note)
 * 5. TaskResult { status, durationMs, tokensUsed } is logged and returned.
 *
 * Completion signal (gateway reality check — packages/api-gateway):
 * - GetSessionResponse has NO streaming/isExecuting field;
 * - /api/health only reports the GLOBALLY active session id (not per-session,
 *   and "active" ≠ "streaming");
 * - SessionAdapter.isExecuting() exists but is only used by the WS handler,
 *   never exposed over HTTP.
 * Working signal: poll GET /api/sessions/:id; the turn is complete when the
 * last message has role "assistant". Safe because the executor always creates
 * a fresh session (no stale assistant messages) and JSONL messages are
 * persisted as whole entries.
 *
 * Limitation: the gateway has no interruption/abort endpoint. On timeout the
 * task is only MARKED as "timeout" — the agent keeps running server-side.
 */
export function createTaskExecutor(client: FanApiClient, options: TaskExecutorOptions = {}): TaskExecutor {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? defaultSleep;

	async function waitForCompletion(task: TaskConfig, sessionId: string, deadlineMs: number): Promise<number> {
		for (;;) {
			const session = await client.getSession(sessionId);
			const messages = session.messages ?? [];
			const last = messages[messages.length - 1];
			if (last !== undefined && last.role === "assistant") {
				return sumTokens(messages);
			}
			const remainingMs = deadlineMs - now();
			if (remainingMs <= 0) {
				throw new TaskTimeoutError(task.name, task.timeout);
			}
			await sleep(Math.min(pollIntervalMs, remainingMs));
		}
	}

	/**
	 * Hard deadline around the whole pipeline: polling alone cannot fire while
	 * a client call (e.g. sendMessage) hangs, so the pipeline is raced against
	 * a timer. The losing pipeline promise keeps running in the background —
	 * harmless (Promise.race keeps handlers attached, no unhandled rejection).
	 */
	function raceWithDeadline<T>(task: TaskConfig, promise: Promise<T>, deadlineMs: number): Promise<T> {
		const timer = new Promise<never>((_resolve, reject) => {
			const handle = setTimeout(() => reject(new TaskTimeoutError(task.name, task.timeout)), deadlineMs);
			// Do not keep the process alive solely for the deadline timer.
			if (typeof handle === "object" && typeof handle.unref === "function") handle.unref();
		});
		return Promise.race([promise, timer]);
	}

	return async function executeTask(task: TaskConfig): Promise<TaskResult> {
		const startedAtMs = now();
		const startedAt = new Date(startedAtMs).toISOString();
		const deadlineMs = startedAtMs + task.timeout * 1000;

		const buildResult = (status: TaskStatus, tokensUsed: number | null, error?: string): TaskResult => {
			const finishedAtMs = now();
			const result: TaskResult = {
				taskName: task.name,
				status,
				durationMs: finishedAtMs - startedAtMs,
				startedAt,
				finishedAt: new Date(finishedAtMs).toISOString(),
				tokensUsed,
			};
			if (error !== undefined) result.error = error;
			logger.info(
				`[executor] task "${task.name}" status=${status} durationMs=${result.durationMs} tokensUsed=${tokensUsed ?? "unknown"}`,
			);
			return result;
		};

		const pipeline = (async (): Promise<number> => {
			// Step 1 — create a session bound to the task workspace.
			const session = await client.createSession(task.workspace);
			// Step 2 — dispatch the prompt (REST bypass: never queued server-side).
			await client.sendMessage(session.id, task.message);
			// Step 3 — poll until the assistant finishes its turn.
			return await waitForCompletion(task, session.id, deadlineMs);
		})();

		let tokensUsed: number;
		try {
			tokensUsed = await raceWithDeadline(task, pipeline, task.timeout * 1000);
		} catch (error) {
			if (error instanceof TaskTimeoutError) {
				// No abort API exists — the agent keeps running server-side; we only
				// mark the result and let the queue move on (documented limitation).
				logger.warn(
					`[executor] task "${task.name}" timed out after ${task.timeout}s — ` +
						"no interruption endpoint in the gateway; the session continues running server-side",
				);
				return buildResult("timeout", null, error.message);
			}
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`[executor] task "${task.name}" failed: ${message}`);
			return buildResult("failed", null, message);
		}

		// Step 4 — budget update, best-effort: per-project scoping is ignored by
		// the current gateway (F-4.2/F-4.9 blocker), so failures are non-fatal.
		if (task.budget_limit !== null) {
			try {
				await client.setProjectBudget(task.workspace, task.budget_limit);
			} catch (error) {
				logger.warn(
					`[executor] task "${task.name}" budget update failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Step 5 — result logging happens in buildResult.
		return buildResult("completed", tokensUsed);
	};
}
