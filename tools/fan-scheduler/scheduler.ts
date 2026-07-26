import { fileURLToPath, pathToFileURL } from "node:url";
import { UserActivityMonitor } from "./lib/activity-monitor.js";
import { FanApiClient } from "./lib/client.js";
import { loadTasks } from "./lib/config-loader.js";
import { type ControlServerHandle, startControlServer } from "./lib/control-server.js";
import { CronScheduler, createConfigWatcher, createShutdownHandler } from "./lib/cron-scheduler.js";
import { createTaskExecutor } from "./lib/executor.js";
import { validateGitHubIdentity } from "./lib/github-identity.js";
import { logger } from "./lib/logger.js";
import { defaultPendingQueuePath, loadPendingTasksDetailed, savePendingTasks } from "./lib/persistent-storage.js";
import { TaskQueue } from "./lib/queue.js";

/**
 * FAN Scheduler — main entry point (F-4.5 cron scheduling loop).
 *
 * Flow:
 * 1. loadTasks(config.yaml) — parse and validate the task list;
 * 2. FanApiClient — gateway client from FAN_API_URL / FAN_API_TOKEN env vars;
 * 3. TaskQueue with the F-4.4 execution pipeline (single-consumer);
 * 4. CronScheduler — each task is scheduled independently via Croner;
 *    on trigger the task is enqueued into the TaskQueue;
 * 5. Config watcher — periodic config.yaml mtime scan → hot-reload
 *    (old jobs stopped, new tasks scheduled);
 * 6. SIGINT/SIGTERM — graceful shutdown: cron stopped, queue paused,
 *    the in-flight task settles, clean exit(0).
 */

function resolveConfigPath(): string {
	const arg = process.argv[2];
	if (arg) return arg;
	// dist/scheduler.js -> ../config.yaml (package root)
	return fileURLToPath(new URL("../config.yaml", import.meta.url));
}

/** Truthy env check: "0"/"false"/"off"/"no" (case-insensitive) disable a feature. */
function envEnabled(name: string, defaultEnabled: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (raw === undefined || raw === "") return defaultEnabled;
	return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/** Positive integer env override with fallback. */
function envInt(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function main(): void {
	const configPath = resolveConfigPath();
	const tasks = loadTasks(configPath);

	// F-4.6: validate the GitHub bot identity (GITHUB_TOKEN) once at startup.
	// Never blocks or crashes the scheduler — a missing/invalid token only
	// marks git/PR-dependent actions as unavailable (gitEnabled=false).
	void validateGitHubIdentity().catch((error: unknown) => {
		logger.warn(
			"github_identity_validation_failed",
			`[github] identity validation failed: ${error instanceof Error ? error.message : String(error)} — git/PR-dependent actions unavailable`,
			{ error },
		);
	});

	const client = new FanApiClient();

	// F-4.13: persistent queue storage path (~/.fan/agent/scheduler-pending.json,
	// honoring FAN_CODING_AGENT_DIR / FAN_SCHEDULER_PENDING_FILE).
	const pendingQueuePath = defaultPendingQueuePath();

	// F-4.12: chat interruption — the monitor polls GET /api/sessions for live
	// chat activity (user messages in sessions NOT created by the scheduler)
	// and pauses/resumes the queue; chat has priority over autonomous tasks.
	// The executor registers each session it creates so task prompts are never
	// mistaken for user chat. Disabled via FAN_SCHEDULER_PAUSE_ON_USER_ACTIVITY=off.
	let activityMonitor: UserActivityMonitor | null = null;
	const queue = new TaskQueue(
		createTaskExecutor(client, {
			onSessionCreated: (sessionId) => activityMonitor?.registerSchedulerSession(sessionId),
		}),
		{
			// F-4.13: write-on-change durability — every enqueue/dequeue
			// persists the pending list, so graceful shutdown (F-4.5) needs
			// no extra flush and a kill never loses pending tasks.
			onPendingChange: (pending) => savePendingTasks(pendingQueuePath, pending),
		},
	);

	// F-4.13: restore pending tasks left over from the previous run and
	// resume processing (restored tasks wait in line behind the cron triggers).
	// F-4.14: a corrupt pending file marks the scheduler as degraded — tasks
	// were dropped and an operator should look at the logs.
	const restored = loadPendingTasksDetailed(pendingQueuePath);
	const pendingFileCorrupt = restored.corrupt;
	if (restored.tasks.length > 0) {
		queue.restore(restored.tasks);
		void queue.runNext();
	}
	activityMonitor = new UserActivityMonitor(client, queue, {
		pollIntervalMs: envInt("FAN_SCHEDULER_ACTIVITY_POLL_MS", 5000),
		activityWindowMs: envInt("FAN_SCHEDULER_ACTIVITY_WINDOW_MS", 60000),
	});
	const monitor = activityMonitor;
	if (envEnabled("FAN_SCHEDULER_PAUSE_ON_USER_ACTIVITY", true)) {
		monitor.start();
	}

	// F-4.12: localhost control server (POST /pause, POST /resume, GET /state)
	// — the external pause/resume signal channel. Disabled via FAN_SCHEDULER_CONTROL=off.
	// Bind host defaults to 127.0.0.1 (never exposed); FAN_SCHEDULER_CONTROL_HOST
	// overrides it (Docker compose: 0.0.0.0 so the gateway's
	// /api/scheduler/health proxy can reach it across the compose network —
	// the port is never published to the host).
	let controlServer: ControlServerHandle | null = null;
	if (envEnabled("FAN_SCHEDULER_CONTROL", true)) {
		startControlServer({
			queue,
			host: process.env.FAN_SCHEDULER_CONTROL_HOST?.trim() || undefined,
			port: envInt("FAN_SCHEDULER_CONTROL_PORT", 3457),
			extraState: () => ({ pausedForChat: monitor.pausedForChat }),
			degraded: () => pendingFileCorrupt,
		})
			.then((handle) => {
				controlServer = handle;
			})
			.catch((error: unknown) => {
				logger.warn(
					"control_server_failed",
					`[control] control server failed to start (scheduler continues without it): ` +
						(error instanceof Error ? error.message : String(error)),
					{ error },
				);
			});
	}

	const scheduler = new CronScheduler(queue);
	scheduler.schedule(tasks);

	const watcher = createConfigWatcher({
		configPath,
		onReload: (reloadedTasks) => scheduler.schedule(reloadedTasks),
	});
	watcher.start();

	const shutdown = createShutdownHandler({
		stopCron: () => {
			scheduler.stop();
			watcher.stop();
			monitor.stop();
			if (controlServer !== null) {
				void controlServer.close().catch(() => {});
			}
		},
		queue,
	});
	const onSignal = (signal: string): void => {
		void shutdown(signal).catch((error: unknown) => {
			logger.error(
				"shutdown_failed",
				`[scheduler] shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
				{ error },
			);
			process.exit(1);
		});
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	logger.info("scheduler_started", `Scheduler started — ${tasks.length} task(s) scheduled from ${configPath}`, {
		configPath,
		taskCount: tasks.length,
	});
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	main();
}
