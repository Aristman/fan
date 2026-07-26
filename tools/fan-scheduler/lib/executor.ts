import type { BudgetUsage, FanApiClient, FanSessionMessage } from "./client.js";
import type { TaskConfig } from "./config-loader.js";
import { createLogger } from "./logger.js";

const log = createLogger("executor");
import type { TaskExecutor, TaskResult, TaskStatus } from "./queue.js";
import {
	DEFAULT_BASE_DELAY_MS,
	DEFAULT_MAX_RETRIES,
	RetryExhaustedError,
	isRetryableError,
	withRetry,
} from "./retry.js";

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
	/** Sleep override (default setTimeout-based) — for tests. Shared by polling
	 *  and the retry backoff (F-4.10). */
	sleep?: (ms: number) => Promise<void>;
	/** Retry config (F-4.10): total attempts per task (default 3). */
	maxRetries?: number;
	/** Retry config (F-4.10): base backoff delay in ms (default 2000). */
	retryBaseDelayMs?: number;
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
	log.info(
		"budget_monitor",
		`budget monitor: ${usage.project} used ${usage.used} / ${usage.limit ?? "unlimited"} tokens` +
			(percentage !== null ? ` (${percentage}%)` : ""),
		{
			project: usage.project,
			used: usage.used,
			limit: usage.limit,
			percentage,
		},
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
 * 6. TaskResult { status, durationMs, tokensUsed, attempts } is logged and returned.
 *
 * Retry (F-4.10): the whole pipeline (steps 1–4) is wrapped in withRetry —
 * up to maxRetries attempts (default 3) with exponential backoff
 * (baseDelayMs * 2^(attempt-1) = 2s, 4s, 8s). Retryable: network errors,
 * timeouts, HTTP 5xx and 429; HTTP 4xx (except 429) fails immediately.
 * The task's own timeout and budget_exceeded are never retried. After all
 * attempts are exhausted the task is marked "failed" (queue continues).
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
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_BASE_DELAY_MS;
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
					log.warn(
						"budget_poll_failed",
						`[executor] task "${task.name}" budget poll failed (monitoring continues): ` +
							(error instanceof Error ? error.message : String(error)),
						{ taskId: task.name, error },
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

		const buildResult = (status: TaskStatus, tokensUsed: number | null, attempts: number, error?: string): TaskResult => {
			const finishedAtMs = now();
			const result: TaskResult = {
				taskName: task.name,
				status,
				durationMs: finishedAtMs - startedAtMs,
				startedAt,
				finishedAt: new Date(finishedAtMs).toISOString(),
				tokensUsed,
				attempts,
			};
			if (error !== undefined) result.error = error;
			log.info(
				"task_result",
				`[executor] task "${task.name}" status=${status} durationMs=${result.durationMs} tokensUsed=${tokensUsed ?? "unknown"} attempts=${attempts}`,
				{
					taskId: task.name,
					status,
					durationMs: result.durationMs,
					tokensUsed: tokensUsed ?? null,
					attempts,
				},
			);
			return result;
		};

		const runPipeline = async (): Promise<number> => {
			// Step 1 — create a session bound to the task workspace.
			const session = await client.createSession(task.workspace);
			// Step 2 — set the per-project budget cap BEFORE any tokens are spent
			// (F-4.9). Best-effort: failures are logged and ignored.
			if (task.budget_limit !== null) {
				try {
					await client.setProjectBudget(task.workspace, task.budget_limit);
					log.info(
						"budget_cap_set",
						`[executor] task "${task.name}" budget cap set: ${task.budget_limit} tokens for ${task.workspace}`,
						{ taskId: task.name, limit: task.budget_limit, workspace: task.workspace },
					);
				} catch (error) {
					log.warn(
						"budget_update_failed",
						`[executor] task "${task.name}" budget update failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
						{ taskId: task.name, error },
					);
				}
			}
			// Step 3 — dispatch the prompt (REST bypass: never queued server-side).
			await client.sendMessage(session.id, task.message);
			// Step 4 — poll until the assistant finishes its turn (+ budget monitor).
			return await waitForCompletion(task, session.id, startedAtMs, deadlineMs);
		};

		// F-4.10: the whole pipeline is retried with exponential backoff
		// (2s, 4s, 8s, …). Each attempt runs the full pipeline with a fresh
		// session and a fresh per-attempt deadline. Retryable: network errors,
		// timeouts, HTTP 5xx and 429. Non-retryable (fail immediately): HTTP 4xx
		// other than 429, the task's own timeout (the deadline is already spent)
		// and budget_exceeded (a terminal business state). After all attempts
		// are exhausted the task is marked "failed" and the queue moves on.
		const retryingPipeline = withRetry(() => raceWithDeadline(task, runPipeline(), task.timeout * 1000), {
			maxRetries,
			baseDelayMs: retryBaseDelayMs,
			sleep,
			isRetryable: (error) =>
				!(error instanceof TaskTimeoutError) && !(error instanceof BudgetExceededError) && isRetryableError(error),
			onRetry: ({ attempt, delayMs, error, willRetry }) => {
				const message = error instanceof Error ? error.message : String(error);
				if (willRetry) {
					log.warn(
						"task_retry",
						`[executor] task "${task.name}" attempt ${attempt}/${maxRetries} failed (${message}) — retrying in ${delayMs}ms`,
						{ taskId: task.name, attempt, maxRetries, delayMs, error },
					);
				} else {
					log.warn(
						"task_attempts_exhausted",
						`[executor] task "${task.name}" attempt ${attempt}/${maxRetries} failed (${message}) — attempts exhausted`,
						{ taskId: task.name, attempt, maxRetries, error },
					);
				}
			},
		});

		let tokensUsed: number;
		let attempts = 1;
		try {
			const outcome = await retryingPipeline;
			tokensUsed = outcome.value;
			attempts = outcome.attempts;
		} catch (thrown) {
			let error: unknown = thrown;
			if (error instanceof RetryExhaustedError) {
				attempts = error.attempts;
				error = error.cause;
			}
			if (error instanceof TaskTimeoutError) {
				// No abort API exists — the agent keeps running server-side; we only
				// mark the result and let the queue move on (documented limitation).
				log.warn(
					"task_timeout",
					`[executor] task "${task.name}" timed out after ${task.timeout}s — ` +
						"no interruption endpoint in the gateway; the session continues running server-side",
					{ taskId: task.name, timeout: task.timeout },
				);
				return buildResult("timeout", null, attempts, error.message);
			}
			if (error instanceof BudgetExceededError) {
				// F-4.9: same no-interruption limitation as timeout (F-4.4) — the wait
				// stops, the task is marked, but the agent is NOT aborted server-side.
				log.warn(
					"budget_exceeded",
					`[executor] task "${task.name}" stopped: budget exceeded (${error.used}/${error.limit} tokens) — ` +
						"no interruption endpoint in the gateway; the session continues running server-side",
					{ taskId: task.name, used: error.used, limit: error.limit },
				);
				return buildResult("budget_exceeded", error.used, attempts, error.message);
			}
			const message = error instanceof Error ? error.message : String(error);
			log.error("task_failed", `[executor] task "${task.name}" failed: ${message}`, { taskId: task.name, error });
			return buildResult("failed", null, attempts, message);
		}

		// Step 5 — final usage report (F-4.9) when budget monitoring was active.
		if (task.budget_limit !== null) {
			try {
				const usage = await client.getBudgetUsage(task.workspace);
				logBudgetMonitor(usage);
				log.info(
					"usage_report",
					`[executor] task "${task.name}" usage report: used ${usage.used} / ${usage.limit ?? "unlimited"} tokens`,
					{ taskId: task.name, used: usage.used, limit: usage.limit },
				);
			} catch (error) {
				log.warn(
					"usage_report_failed",
					`[executor] task "${task.name}" final usage report failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
					{ taskId: task.name, error },
				);
			}
		}

		// Step 6 — result logging happens in buildResult.
		return buildResult("completed", tokensUsed, attempts);
	};
}
