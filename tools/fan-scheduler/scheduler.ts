import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTasks, type TaskConfig } from "./lib/config-loader.js";
import { logger } from "./lib/logger.js";
import { TaskQueue } from "./lib/queue.js";

/**
 * FAN Scheduler — main entry point (F-4.1 skeleton).
 * Loads config.yaml, validates tasks and prepares the queue.
 * The cron scheduling loop, graceful shutdown and hot-reload land in F-4.5.
 */

function resolveConfigPath(): string {
	const arg = process.argv[2];
	if (arg) return arg;
	// dist/scheduler.js -> ../config.yaml (package root)
	return fileURLToPath(new URL("../config.yaml", import.meta.url));
}

export function createScheduler(configPath: string): { tasks: TaskConfig[]; queue: TaskQueue } {
	const tasks = loadTasks(configPath);
	const queue = new TaskQueue();
	for (const task of tasks) {
		queue.enqueue(task);
	}
	return { tasks, queue };
}

export function main(): void {
	const configPath = resolveConfigPath();
	const { tasks, queue } = createScheduler(configPath);
	logger.info("Scheduler started");
	logger.info(`Loaded ${tasks.length} task(s) from ${configPath}`);
	for (const task of queue.pending) {
		logger.info(`Scheduled task "${task.name}" [${task.schedule}] workspace=${task.workspace} timeout=${task.timeout}s`);
	}
	// TODO(F-4.5): cron scheduling loop + SIGINT/SIGTERM handlers
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	main();
}
