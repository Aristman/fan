import { statSync } from "node:fs";
import { Cron } from "croner";
import { loadTasks, type TaskConfig } from "./config-loader.js";
import { logger } from "./logger.js";
import type { TaskQueue } from "./queue.js";

/**
 * Cron scheduling loop primitives (F-4.5).
 *
 * - CronScheduler: plans each task via a cron library (Croner by default) and
 *   enqueues it into the single-consumer TaskQueue on every trigger.
 * - createConfigWatcher: hot-reload — polls config.yaml mtime and calls
 *   onReload() with the freshly parsed tasks when the file changes.
 * - createShutdownHandler: SIGINT/SIGTERM graceful shutdown — stops cron jobs,
 *   pauses the queue, waits for the in-flight task to settle, then exits.
 *   (Persistent queue state across restarts is F-4.13 — out of scope here.)
 */

/** Minimal handle over a scheduled cron job (structural subset of Croner's Cron). */
export interface CronJobHandle {
	stop(): void;
}

/**
 * Factory creating a cron job for a pattern. Injectable for tests: the default
 * implementation uses Croner; tests pass a mock that captures the callback so
 * triggers can be fired manually without waiting for wall-clock time.
 */
export type CronFactory = (pattern: string, onTrigger: () => void) => CronJobHandle;

export const defaultCronFactory: CronFactory = (pattern, onTrigger) =>
	new Cron(pattern, () => {
		onTrigger();
	});

/**
 * Plans tasks on cron schedules and feeds the TaskQueue.
 *
 * schedule() is idempotent w.r.t. previous state: it stops all currently
 * scheduled jobs first, which makes it directly usable for hot-reload
 * (config watcher → schedule(newTasks)).
 */
export class CronScheduler {
	private jobs: CronJobHandle[] = [];

	constructor(
		private readonly queue: TaskQueue,
		private readonly cronFactory: CronFactory = defaultCronFactory,
	) {}

	/** Number of currently active cron jobs. */
	get size(): number {
		return this.jobs.length;
	}

	/**
	 * Stops previously scheduled jobs and schedules every task via the cron
	 * factory. On each trigger the task is enqueued into the TaskQueue
	 * (concurrent schedules are serialized by the queue itself — F-4.3).
	 */
	schedule(tasks: TaskConfig[]): void {
		this.stop();
		for (const task of tasks) {
			const job = this.cronFactory(task.schedule, () => {
				logger.info("task_triggered", `[scheduled] ${task.name}`, { taskId: task.name });
				this.queue.enqueue(task);
			});
			this.jobs.push(job);
			logger.info(
				"task_scheduled",
				`[scheduler] task "${task.name}" scheduled [${task.schedule}] workspace=${task.workspace}`,
				{ taskId: task.name, schedule: task.schedule, workspace: task.workspace },
			);
		}
	}

	/** Stops all scheduled cron jobs (future triggers are suppressed). */
	stop(): void {
		for (const job of this.jobs) {
			try {
				job.stop();
			} catch (error) {
				logger.warn(
					"cron_job_stop_failed",
					`[scheduler] failed to stop a cron job (ignored): ${error instanceof Error ? error.message : String(error)}`,
					{ error },
				);
			}
		}
		this.jobs = [];
	}
}

// ---------------------------------------------------------------------------
// Hot-reload: periodic config.yaml mtime scan
// ---------------------------------------------------------------------------

export const DEFAULT_RELOAD_INTERVAL_MS = 5000;

export interface ConfigWatcherOptions {
	configPath: string;
	/** Called with freshly parsed tasks when the config file changes. */
	onReload: (tasks: TaskConfig[]) => void;
	/** Polling interval (default 5000 ms). */
	intervalMs?: number;
	/** mtime source override (default: statSync().mtimeMs) — for tests. */
	statMtimeMs?: (path: string) => number;
	/** Config loader override (default: loadTasks) — for tests. */
	loadFn?: (path: string) => TaskConfig[];
}

export interface ConfigWatcher {
	start(): void;
	stop(): void;
	readonly isWatching: boolean;
}

/**
 * Polls the config file mtime and reloads tasks when it changes.
 * A broken intermediate state (file unreadable or invalid YAML/cron) is logged
 * and the previous schedule is kept — the watcher never throws.
 */
export function createConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
	const intervalMs = options.intervalMs ?? DEFAULT_RELOAD_INTERVAL_MS;
	const statMtimeMs = options.statMtimeMs ?? ((path: string) => statSync(path).mtimeMs);
	const loadFn = options.loadFn ?? loadTasks;

	let timer: ReturnType<typeof setInterval> | null = null;
	let lastMtimeMs: number | null = null;

	function tick(): void {
		let mtimeMs: number;
		try {
			mtimeMs = statMtimeMs(options.configPath);
		} catch (error) {
			logger.warn(
				"config_stat_failed",
				`[watcher] failed to stat "${options.configPath}": ${error instanceof Error ? error.message : String(error)}`,
				{ error, configPath: options.configPath },
			);
			return;
		}
		if (lastMtimeMs === null) {
			lastMtimeMs = mtimeMs;
			return;
		}
		if (mtimeMs === lastMtimeMs) return;
		lastMtimeMs = mtimeMs;

		let tasks: TaskConfig[];
		try {
			tasks = loadFn(options.configPath);
		} catch (error) {
			logger.error(
				"config_reload_failed",
				`[watcher] failed to reload "${options.configPath}" — keeping the previous schedule: ` +
					(error instanceof Error ? error.message : String(error)),
				{ error, configPath: options.configPath },
			);
			return;
		}
		logger.info("config_reloaded", `[watcher] config change detected — rescheduling ${tasks.length} task(s)`, {
			taskCount: tasks.length,
		});
		options.onReload(tasks);
	}

	return {
		start(): void {
			if (timer !== null) return;
			try {
				lastMtimeMs = statMtimeMs(options.configPath);
			} catch (error) {
				logger.warn(
					"config_stat_failed",
					`[watcher] failed to stat "${options.configPath}" on start: ${error instanceof Error ? error.message : String(error)}`,
					{ error, configPath: options.configPath },
				);
				lastMtimeMs = null;
			}
			timer = setInterval(tick, intervalMs);
		},
		stop(): void {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		get isWatching(): boolean {
			return timer !== null;
		},
	};
}

// ---------------------------------------------------------------------------
// Graceful shutdown (SIGINT/SIGTERM)
// ---------------------------------------------------------------------------

export const DEFAULT_SHUTDOWN_POLL_MS = 100;

export interface ShutdownHandlerOptions {
	/** Stops cron jobs and the config watcher. */
	stopCron: () => void;
	queue: TaskQueue;
	/** Exit override (default: process.exit) — for tests. */
	exit?: (code: number) => void;
	/** Poll interval while waiting for the running task to settle (default 100 ms). */
	pollIntervalMs?: number;
	/** Sleep override (default setTimeout-based) — for tests. */
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a signal handler implementing graceful shutdown:
 * 1. stop cron jobs and the config watcher (no new triggers/reloads);
 * 2. pause the queue so no new task starts after the current one;
 * 3. wait for the in-flight task to settle (it is NOT killed);
 * 4. log final state and exit(0).
 *
 * Repeated signals during shutdown are ignored. Pending tasks are left in
 * memory — persisting them across restarts is F-4.13.
 */
export function createShutdownHandler(options: ShutdownHandlerOptions): (signal: string) => Promise<void> {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SHUTDOWN_POLL_MS;
	const sleep = options.sleep ?? defaultSleep;
	let shuttingDown = false;

	return async function shutdown(signal: string): Promise<void> {
		if (shuttingDown) {
			logger.warn("shutdown_signal_ignored", `[scheduler] received ${signal} during shutdown — ignoring`);
			return;
		}
		shuttingDown = true;
		logger.info("shutdown_started", `[scheduler] received ${signal} — starting graceful shutdown`);

		options.stopCron();
		options.queue.pauseCurrent();

		const active = options.queue.currentTask;
		if (active !== null) {
			logger.info("shutdown_waiting", `[scheduler] waiting for running task "${active.name}" to settle...`, {
				taskId: active.name,
			});
			while (options.queue.currentTask !== null) {
				await sleep(pollIntervalMs);
			}
		}

		logger.info(
			"shutdown_complete",
			`[scheduler] shutdown complete — ${options.queue.pending.length} task(s) left pending ` +
				"(persistent queue state is F-4.13)",
			{ pending: options.queue.pending.length },
		);
		exit(0);
	};
}
