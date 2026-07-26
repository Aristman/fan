import type { FanApiClient, FanSessionSummary } from "./client.js";
import { createLogger } from "./logger.js";
import type { TaskQueue } from "./queue.js";

const log = createLogger("scheduler");

/** Default interval between user-activity polls of GET /api/sessions (F-4.12). */
export const DEFAULT_ACTIVITY_POLL_INTERVAL_MS = 5000;

/**
 * Default window during which the most recent user chat message keeps the
 * autonomous queue paused (F-4.12). Covers the whole user turn: the message
 * itself plus the assistant's processing time (within reason).
 */
export const DEFAULT_ACTIVITY_WINDOW_MS = 60000;

export interface UserActivityMonitorOptions {
	/** Polling interval for GET /api/sessions (default 5000 ms). */
	pollIntervalMs?: number;
	/** How long a user message counts as "chat activity" (default 60000 ms). */
	activityWindowMs?: number;
	/** Clock override (default Date.now) — for tests. */
	now?: () => number;
}

/**
 * Chat interruption monitor (F-4.12) — pause autonomous tasks while the user
 * is chatting. Priority model: `chat > autonomous tasks`.
 *
 * Mechanism (chosen over the alternatives — documented decision):
 * The scheduler is a SEPARATE process from the api-gateway, so the gateway
 * cannot call TaskQueue directly. Options considered:
 *  (a) scheduler subscribes to the gateway WS as an observer — complex,
 *      fragile (auth, reconnects, per-session channels), and the WS protocol
 *      carries agent events, not a "user is typing" signal;
 *  (b) gateway → scheduler HTTP push — requires modifying the gateway and a
 *      new cross-process dependency both ways;
 *  (c) scheduler polls the read-only HTTP API — simple, testable, zero
 *      gateway changes, no new coupling.
 * Option (c) is implemented here: the monitor polls GET /api/sessions and
 * inspects sessions NOT created by the scheduler itself. A session whose
 * latest user-role message is younger than activityWindowMs counts as live
 * chat activity → queue.pauseCurrent(). When no recent user message remains,
 * the queue is resumed via runNext() (resume behavior, spec: "опционально" —
 * implemented as auto-resume of the NEXT pending task; the interrupted
 * in-flight task itself keeps running server-side, same no-abort limitation
 * as F-4.4/F-4.9).
 *
 * Scheduler-owned sessions (created per task by the execution pipeline) are
 * registered via registerSchedulerSession() and excluded — the task prompt is
 * itself a user-role message and would otherwise look like chat activity.
 *
 * Robustness: poll failures are best-effort (warning, state unchanged) — a
 * gateway hiccup must neither crash the scheduler nor flap the queue.
 */
export class UserActivityMonitor {
	private readonly client: FanApiClient;
	private readonly queue: TaskQueue;
	private readonly pollIntervalMs: number;
	private readonly activityWindowMs: number;
	private readonly now: () => number;

	private timer: ReturnType<typeof setInterval> | null = null;
	private pollInFlight = false;
	/** true while the queue is paused BY THIS MONITOR (it only resumes its own pauses). */
	private paused = false;

	/** Session ids created by the scheduler's execution pipeline (excluded from detection). */
	private readonly schedulerSessions = new Set<string>();
	/** sessionId → updatedAt seen at the last detail fetch (change detection). */
	private readonly knownUpdatedAt = new Map<string, string>();
	/** sessionId → timestamp (ms) of the latest user-role message observed. */
	private readonly lastUserActivityAt = new Map<string, number>();

	constructor(client: FanApiClient, queue: TaskQueue, options: UserActivityMonitorOptions = {}) {
		this.client = client;
		this.queue = queue;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ACTIVITY_POLL_INTERVAL_MS;
		this.activityWindowMs = options.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;
		this.now = options.now ?? (() => Date.now());
	}

	get isWatching(): boolean {
		return this.timer !== null;
	}

	/** true while the queue is paused due to detected chat activity. */
	get pausedForChat(): boolean {
		return this.paused;
	}

	/**
	 * Excludes a scheduler-created session from chat-activity detection.
	 * Called by the execution pipeline (TaskExecutorOptions.onSessionCreated)
	 * right after createSession. Any state recorded for the id before
	 * registration is dropped (registration wins).
	 */
	registerSchedulerSession(sessionId: string): void {
		this.schedulerSessions.add(sessionId);
		this.knownUpdatedAt.delete(sessionId);
		this.lastUserActivityAt.delete(sessionId);
	}

	/** Starts periodic polling (idempotent). */
	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			if (this.pollInFlight) return;
			this.pollInFlight = true;
			void this.checkOnce()
				.catch((error: unknown) => {
					log.warn(
						"activity_poll_failed",
						`[activity] poll failed (state unchanged): ${error instanceof Error ? error.message : String(error)}`,
						{ error },
					);
				})
				.finally(() => {
					this.pollInFlight = false;
				});
		}, this.pollIntervalMs);
		// Do not keep the process alive solely for the polling timer.
		if (typeof this.timer === "object" && typeof this.timer.unref === "function") this.timer.unref();
	}

	/** Stops periodic polling (the paused state, if any, is left as-is). */
	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * One polling cycle (public for tests; the interval timer drives it in
	 * production). Fetches the session list, refreshes changed non-scheduler
	 * sessions, evaluates chat activity and pauses/resumes the queue.
	 */
	async checkOnce(): Promise<void> {
		let sessions: FanSessionSummary[];
		try {
			sessions = await this.client.getSessionList();
		} catch (error) {
			// Best-effort: a failed list poll must not flap the queue.
			log.warn(
				"activity_poll_failed",
				`[activity] session list poll failed (state unchanged): ${error instanceof Error ? error.message : String(error)}`,
				{ error },
			);
			return;
		}

		// Drop state for sessions that no longer exist.
		const alive = new Set(sessions.map((s) => s.id));
		for (const id of [...this.knownUpdatedAt.keys()]) {
			if (!alive.has(id)) this.knownUpdatedAt.delete(id);
		}
		for (const id of [...this.lastUserActivityAt.keys()]) {
			if (!alive.has(id)) this.lastUserActivityAt.delete(id);
		}

		// Refresh details only for sessions that changed since the last poll.
		for (const summary of sessions) {
			if (this.schedulerSessions.has(summary.id)) continue;
			if (this.knownUpdatedAt.get(summary.id) === summary.updatedAt) continue;
			this.knownUpdatedAt.set(summary.id, summary.updatedAt);
			try {
				const detail = await this.client.getSession(summary.id);
				const messages = detail.messages ?? [];
				const lastUser = [...messages].reverse().find((m) => m.role === "user");
				if (lastUser !== undefined) {
					const ts = Date.parse(lastUser.createdAt);
					if (Number.isFinite(ts)) this.lastUserActivityAt.set(summary.id, ts);
				}
			} catch (error) {
				// Best-effort: skip this session, keep the previously known state.
				log.warn(
					"activity_session_poll_failed",
					`[activity] failed to inspect session ${summary.id} (skipped): ` +
						(error instanceof Error ? error.message : String(error)),
					{ error, sessionId: summary.id },
				);
			}
		}

		const cutoff = this.now() - this.activityWindowMs;
		const active = [...this.lastUserActivityAt.values()].some((ts) => ts >= cutoff);

		if (active && !this.paused) {
			this.paused = true;
			this.queue.pauseCurrent();
			log.info(
				"chat_interruption",
				"Paused autonomous task for live chat — chat has priority over autonomous tasks (F-4.12)",
				{ currentTask: this.queue.currentTask?.name ?? null },
			);
		} else if (!active && this.paused) {
			this.paused = false;
			log.info("chat_interruption_end", "Chat activity ended — resuming autonomous tasks (runNext)", {
				pending: this.queue.pending.length,
			});
			void this.queue.runNext();
		}
	}
}
