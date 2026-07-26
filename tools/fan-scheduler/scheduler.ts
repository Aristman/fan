import { fileURLToPath, pathToFileURL } from "node:url";
import { FanApiClient } from "./lib/client.js";
import { loadTasks } from "./lib/config-loader.js";
import { CronScheduler, createConfigWatcher, createShutdownHandler } from "./lib/cron-scheduler.js";
import { createTaskExecutor } from "./lib/executor.js";
import { validateGitHubIdentity } from "./lib/github-identity.js";
import { logger } from "./lib/logger.js";
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

export function main(): void {
	const configPath = resolveConfigPath();
	const tasks = loadTasks(configPath);

	// F-4.6: validate the GitHub bot identity (GITHUB_TOKEN) once at startup.
	// Never blocks or crashes the scheduler — a missing/invalid token only
	// marks git/PR-dependent actions as unavailable (gitEnabled=false).
	void validateGitHubIdentity().catch((error: unknown) => {
		logger.warn(
			`[github] identity validation failed: ${error instanceof Error ? error.message : String(error)} — git/PR-dependent actions unavailable`,
		);
	});

	const client = new FanApiClient();
	const queue = new TaskQueue(createTaskExecutor(client));

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
		},
		queue,
	});
	const onSignal = (signal: string): void => {
		void shutdown(signal).catch((error: unknown) => {
			logger.error(`[scheduler] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		});
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	logger.info(`Scheduler started — ${tasks.length} task(s) scheduled from ${configPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	main();
}
