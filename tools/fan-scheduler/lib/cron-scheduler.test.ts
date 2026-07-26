import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskConfig } from "./config-loader.js";
import {
	type CronFactory,
	type CronJobHandle,
	CronScheduler,
	createConfigWatcher,
	createShutdownHandler,
} from "./cron-scheduler.js";
import { logger } from "./logger.js";
import { TaskQueue, type TaskResult } from "./queue.js";

function makeTask(name: string, schedule = "0 9 * * *"): TaskConfig {
	return {
		name,
		schedule,
		workspace: `/workspaces/${name}`,
		message: `run ${name}`,
		budget_limit: null,
		timeout: 3600,
	};
}

function makeResult(taskName: string): TaskResult {
	const now = new Date().toISOString();
	return { taskName, status: "completed", durationMs: 5, startedAt: now, finishedAt: now };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MockJob extends CronJobHandle {
	pattern: string;
	trigger: () => void;
	stopped: boolean;
}

/** Mock cron factory: captures callbacks so triggers fire manually, records stops. */
function createMockCronFactory(): { factory: CronFactory; jobs: MockJob[] } {
	const jobs: MockJob[] = [];
	const factory: CronFactory = (pattern, onTrigger) => {
		const job: MockJob = {
			pattern,
			trigger: onTrigger,
			stopped: false,
			stop() {
				this.stopped = true;
			},
		};
		jobs.push(job);
		return job;
	};
	return { factory, jobs };
}

/** Minimal TaskQueue stub recording enqueued tasks. */
function createQueueStub() {
	const enqueued: TaskConfig[] = [];
	const queue = {
		enqueue: (task: TaskConfig) => {
			enqueued.push(task);
		},
	} as unknown as TaskQueue;
	return { queue, enqueued };
}

describe("CronScheduler (TC-F-4.5-1)", () => {
	let infoSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("enqueues the task into the queue on cron trigger (mock factory)", () => {
		const { factory, jobs } = createMockCronFactory();
		const { queue, enqueued } = createQueueStub();
		const scheduler = new CronScheduler(queue, factory);

		const task = makeTask("daily-code-review");
		scheduler.schedule([task]);

		expect(jobs).toHaveLength(1);
		expect(jobs[0].pattern).toBe("0 9 * * *");
		expect(enqueued).toHaveLength(0);

		jobs[0].trigger();

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].name).toBe("daily-code-review");
		expect(infoSpy).toHaveBeenCalledWith("task_triggered", "[scheduled] daily-code-review", {
			taskId: "daily-code-review",
		});

		scheduler.stop();
	});

	it("enqueues the task with a real Croner job (seconds pattern)", async () => {
		const { queue, enqueued } = createQueueStub();
		const scheduler = new CronScheduler(queue); // defaultCronFactory (Croner)

		scheduler.schedule([makeTask("every-second", "* * * * * *")]);
		try {
			// Wait for the next second boundary (~1.1s worst case).
			await vi.waitFor(() => expect(enqueued.length).toBeGreaterThan(0), { timeout: 3000, interval: 50 });
			expect(enqueued[0].name).toBe("every-second");
		} finally {
			scheduler.stop();
		}
	});

	it("suppresses triggers after stop()", async () => {
		const { queue, enqueued } = createQueueStub();
		const scheduler = new CronScheduler(queue);
		scheduler.schedule([makeTask("every-second", "* * * * * *")]);
		scheduler.stop();
		await sleep(1200);
		expect(enqueued).toHaveLength(0);
	});

	it("schedules each task independently through the cron factory", () => {
		const { factory, jobs } = createMockCronFactory();
		const { queue, enqueued } = createQueueStub();
		const scheduler = new CronScheduler(queue, factory);

		scheduler.schedule([makeTask("task-a", "0 9 * * *"), makeTask("task-b", "*/30 * * * *")]);

		expect(jobs).toHaveLength(2);
		expect(jobs.map((j) => j.pattern)).toEqual(["0 9 * * *", "*/30 * * * *"]);

		jobs[1].trigger();
		expect(enqueued.map((t) => t.name)).toEqual(["task-b"]);
	});
});

describe("CronScheduler hot-reload (rescheduling)", () => {
	it("schedule() stops old jobs and schedules the new task set", () => {
		vi.spyOn(logger, "info").mockImplementation(() => {});
		const { factory, jobs } = createMockCronFactory();
		const { queue, enqueued } = createQueueStub();
		const scheduler = new CronScheduler(queue, factory);

		scheduler.schedule([makeTask("task-a")]);
		expect(scheduler.size).toBe(1);

		scheduler.schedule([makeTask("task-a"), makeTask("task-b", "*/10 * * * *")]);

		expect(jobs).toHaveLength(3); // 1 old + 2 new
		expect(jobs[0].stopped).toBe(true); // old job stopped
		expect(jobs[1].stopped).toBe(false);
		expect(jobs[2].stopped).toBe(false);
		expect(scheduler.size).toBe(2);

		// Old trigger must not fire anymore (job stopped); new ones work.
		jobs[0].stopped = true;
		jobs[2].trigger();
		expect(enqueued.map((t) => t.name)).toEqual(["task-b"]);
		vi.restoreAllMocks();
	});
});

describe("createConfigWatcher (hot-reload)", () => {
	it("calls onReload with reparsed tasks when the config mtime changes", async () => {
		vi.spyOn(logger, "info").mockImplementation(() => {});
		let mtime = 1000;
		let loadedTasks = [makeTask("task-a")];
		const onReload = vi.fn();

		const watcher = createConfigWatcher({
			configPath: "/fake/config.yaml",
			intervalMs: 20,
			statMtimeMs: () => mtime,
			loadFn: () => loadedTasks,
			onReload,
		});
		watcher.start();
		expect(watcher.isWatching).toBe(true);

		await sleep(60); // baseline ticks, no change
		expect(onReload).not.toHaveBeenCalled();

		mtime = 2000;
		loadedTasks = [makeTask("task-a"), makeTask("task-b")];

		await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
		expect(onReload.mock.calls[0][0].map((t: TaskConfig) => t.name)).toEqual(["task-a", "task-b"]);

		watcher.stop();
		expect(watcher.isWatching).toBe(false);
		vi.restoreAllMocks();
	});

	it("keeps the previous schedule when the reloaded config is invalid", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		let mtime = 1000;
		let shouldThrow = false;
		const onReload = vi.fn();

		const watcher = createConfigWatcher({
			configPath: "/fake/config.yaml",
			intervalMs: 20,
			statMtimeMs: () => mtime,
			loadFn: () => {
				if (shouldThrow) throw new Error("Invalid YAML in config file");
				return [makeTask("task-a")];
			},
			onReload,
		});
		watcher.start();
		await sleep(50);

		shouldThrow = true;
		mtime = 2000;
		await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
		expect(onReload).not.toHaveBeenCalled();

		// Watcher survives the bad state and reloads once the config is fixed.
		shouldThrow = false;
		mtime = 3000;
		await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });

		watcher.stop();
		vi.restoreAllMocks();
	});
});

describe("createShutdownHandler (TC-F-4.5-2)", () => {
	beforeEach(() => {
		vi.spyOn(logger, "info").mockImplementation(() => {});
		vi.spyOn(logger, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops cron, pauses the queue, waits for the running task, then exits cleanly", async () => {
		// Real queue with a manually controlled executor — the task stays in-flight.
		let resolveExecution!: (result: TaskResult) => void;
		const queue = new TaskQueue(
			() =>
				new Promise<TaskResult>((resolve) => {
					resolveExecution = resolve;
				}),
		);
		queue.enqueue(makeTask("long-task"));
		await sleep(10); // let runNext pick up the task
		expect(queue.currentTask?.name).toBe("long-task");

		const stopCron = vi.fn();
		const exit = vi.fn();
		const shutdown = createShutdownHandler({ stopCron, queue, exit, pollIntervalMs: 5 });

		const shutdownPromise = shutdown("SIGTERM");

		// Immediately after the signal: cron stopped, queue paused, still running.
		expect(stopCron).toHaveBeenCalledTimes(1);
		expect(queue.state).toBe("paused");
		expect(queue.currentTask?.name).toBe("long-task");
		expect(exit).not.toHaveBeenCalled();

		// The in-flight task settles — shutdown completes with a clean exit.
		resolveExecution(makeResult("long-task"));
		await shutdownPromise;

		expect(queue.currentTask).toBeNull();
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("exits immediately when the queue is idle", async () => {
		const queue = new TaskQueue(() => Promise.resolve(makeResult("x")));
		const stopCron = vi.fn();
		const exit = vi.fn();
		const shutdown = createShutdownHandler({ stopCron, queue, exit, pollIntervalMs: 5 });

		await shutdown("SIGINT");

		expect(stopCron).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("ignores repeated signals during shutdown", async () => {
		const queue = new TaskQueue(() => Promise.resolve(makeResult("x")));
		const stopCron = vi.fn();
		const exit = vi.fn();
		const warnSpy = vi.spyOn(logger, "warn");
		const shutdown = createShutdownHandler({ stopCron, queue, exit, pollIntervalMs: 5 });

		await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM")]);

		expect(stopCron).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			"shutdown_signal_ignored",
			"[scheduler] received SIGTERM during shutdown — ignoring",
		);
	});
});
