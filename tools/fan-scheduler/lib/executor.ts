import type { BudgetUsage, FanApiClient, FanSessionMessage } from "./client.js";
import type { TaskConfig } from "./config-loader.js";
import { logger } from "./logger.js";
import type { TaskExecutor, TaskResult, TaskStatus } from "./queue.js";

/** Default delay between completion polls of GET /api/sessions/:id. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Default delay between budget polls of GET /api/budget?project= (F-4.9). */
export const DEFAULT_BUDGET_POLL_INTERVAL_MS = 30000;

/** Internal marker: the task deadline expired (distinct from API/logic failures). */
class TaskTimeoutError extends Error {
	constructor(taskName: string, timeoutSeconds: number) {
		super(`Task "${taskName}" exceeded its timeout of ${timeoutSeconds}s`);
		this.name = "TaskTimeoutError";
	}
}

/** Internal marker: the per-project budget cap was reached (F-4.9). */
class BudgetExceededError extends Error {
	constructor(
		taskName: string,
		readonly used: number,
		readonly limit: number,
	) {
		super(`Task "${taskName}" stopped: budget exceeded (${used}/${limit} tokens)`);
		this.name = "BudgetExceededError";
	}
}

export interface TaskExecutorOptions {
	/** Polling interval for waitForCompletion (default 5000 ms). */
	pollIntervalMs?: number;
	/** Polling interval for the budget monitor (default 30000 ms, F-4.9). */
	budgetPollIntervalMs?: number;
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

/** Emits the F-4.9 budget_monitor log event: { event, project, used, limit, percentage }. */
function logBudgetMonitor(usage: BudgetUsage): void {
	const percentage =
		usage.limit !== null && usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : null;
	logger.info(
		JSON.stringify({
			event: "budget_monitor",
			project: usage.project,
			used: usage.used,
			limit: usage.limit,
			percentage,
		}),
	);
}

/**
 * Execution pipeline (F-4.4) + budget monitor (F-4.9, part B).
 *
 * Per task:
 * 1. session = client.createSession(task.workspace)
 * 2. client.setProjectBudget(task.workspace, task.budget_limit) — BEFORE
 *    sendMessage (F-4.9: the cap must be in place before tokens are spent).
 *    Best-effort: failures are logged as warnings and ignored (documented —
 *    a misconfigured gateway must not silently block the queue).
 * 3. client.sendMessage(session.id, task.message)
 * 4. waitForCompletion(session.id, task.timeout) — polls GET /api/sessions/:id
 *    (see completion-signal note below) and, when budget_limit is set, polls
 *    client.getBudgetUsage(task.workspace) every budgetPollIntervalMs
 *    (default 30s, configurable via TaskExecutorOptions). Each budget poll is
 *    logged as { event: 'budget_monitor', project, used, limit, percentage }.
 *    used >= limit → the wait stops and the task is marked "budget_exceeded"
 *    with a warning. NOTE (same limitation as timeout, F-4.4): the gateway has
 *    no interruption/abort endpoint, so the agent keeps running server-side —
 *    only the scheduler's wait is aborted. Budget poll failures are
 *    best-effort (warning, monitoring continues) — a transient network error
 *    must not fail the task.
 * 5. After completion: a final usage report is logged ("used X / Y tokens")
 *    when budget monitoring was active.
 * 6. TaskResult { status, durationMs, tokensUsed } is logged and returned.
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
 * Limitation: the gateway has no interruption/abort endpoint. On timeout (and
 * on budget_exceeded) the task is only MARKED — the agent keeps running
 * server-side.
 */
export function createTaskExecutor(client: FanApiClient, options: TaskExecutorOptions = {}): TaskExecutor {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const budgetPollIntervalMs = options.budgetPollIntervalMs ?? DEFAULT_BUDGET_POLL_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? defaultSleep;

	async function waitForCompletion(
		task: TaskConfig,
		sessionId: string,
		startedAtMs: number,
		deadlineMs: number,
	): Promise<number> {
		const budgetEnabled = task.budget_limit !== null;
		let nextBudgetPollAt = startedAtMs + budgetPollIntervalMs;
		for (;;) {
			const session = await client.getSession(sessionId);
			const messages = session.messages ?? [];
			const last = messages[messages.length - 1];
			if (last !== undefined && last.role === "assistant") {
				return sumTokens(messages);
			}
			// F-4.9: budget monitor — poll usage every budgetPollIntervalMs.
			if (budgetEnabled && now() >= nextBudgetPollAt) {
				nextBudgetPollAt = now() + budgetPollIntervalMs;
				try {
					const usage = await client.getBudgetUsage(task.workspace);
					logBudgetMonitor(usage);
					if (usage.limit !== null && usage.used >= usage.limit) {
						throw new BudgetExceededError(task.name, usage.used, usage.limit);
					}
				} catch (error) {
					if (error instanceof BudgetExceededError) throw error;
					// Best-effort monitoring: a failed poll must not fail the task.
					logger.warn(
						`[executor] task "${task.name}" budget poll failed (monitoring continues): ` +
							(error instanceof Error ? error.message : String(error)),
					);
				}
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
			// Step 2 — set the per-project budget cap BEFORE any tokens are spent
			// (F-4.9). Best-effort: failures are logged and ignored.
			if (task.budget_limit !== null) {
				try {
					await client.setProjectBudget(task.workspace, task.budget_limit);
					logger.info(
						`[executor] task "${task.name}" budget cap set: ${task.budget_limit} tokens for ${task.workspace}`,
					);
				} catch (error) {
					logger.warn(
						`[executor] task "${task.name}" budget update failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			// Step 3 — dispatch the prompt (REST bypass: never queued server-side).
			await client.sendMessage(session.id, task.message);
			// Step 4 — poll until the assistant finishes its turn (+ budget monitor).
			return await waitForCompletion(task, session.id, startedAtMs, deadlineMs);
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
			if (error instanceof BudgetExceededError) {
				// F-4.9: same no-interruption limitation as timeout (F-4.4) — the wait
				// stops, the task is marked, but the agent is NOT aborted server-side.
				logger.warn(
					`[executor] task "${task.name}" stopped: budget exceeded (${error.used}/${error.limit} tokens) — ` +
						"no interruption endpoint in the gateway; the session continues running server-side",
				);
				return buildResult("budget_exceeded", error.used, error.message);
			}
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`[executor] task "${task.name}" failed: ${message}`);
			return buildResult("failed", null, message);
		}

		// Step 5 — final usage report (F-4.9) when budget monitoring was active.
		if (task.budget_limit !== null) {
			try {
				const usage = await client.getBudgetUsage(task.workspace);
				logBudgetMonitor(usage);
				logger.info(
					`[executor] task "${task.name}" usage report: used ${usage.used} / ${usage.limit ?? "unlimited"} tokens`,
				);
			} catch (error) {
				logger.warn(
					`[executor] task "${task.name}" final usage report failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Step 6 — result logging happens in buildResult.
		return buildResult("completed", tokensUsed);
	};
}
