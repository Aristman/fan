import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskConfig } from "./config-loader.js";
import { loadPendingTasks, PENDING_QUEUE_VERSION, savePendingTasks } from "./persistent-storage.js";
import { TaskQueue, type TaskResult } from "./queue.js";

function makeTask(name: string): TaskConfig {
	return {
		name,
		schedule: "* * * * *",
		workspace: `/workspaces/${name}`,
		message: `run ${name}`,
		budget_limit: null,
		timeout: 3600,
	};
}

function makeResult(taskName: string, status: TaskResult["status"] = "completed"): TaskResult {
	const now = new Date().toISOString();
	return { taskName, status, durationMs: 5, startedAt: now, finishedAt: now };
}

interface Deferred {
	promise: Promise<TaskResult>;
	resolve: (result: TaskResult) => void;
	reject: (error: unknown) => void;
}

function deferred(): Deferred {
	let resolve!: (result: TaskResult) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<TaskResult>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Executor stub: each call returns a manually controlled promise. */
function createStubExecutor() {
	const calls: Deferred[] = [];
	const executor = vi.fn((_task: TaskConfig): Promise<TaskResult> => {
		const d = deferred();
		calls.push(d);
		return d.promise;
	});
	return { executor, calls };
}

/** Flushes microtasks (and a macrotask) so chained finally{} blocks can run. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	// Silence queue logging during tests.
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TC-F-4.3-1: simultaneous execution is forbidden", () => {
	it("two consecutive enqueues: first runs, second waits in pending", () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		const t1 = makeTask("t1");
		const t2 = makeTask("t2");

		queue.enqueue(t1);
		expect(queue.isRunning).toBe(true);
		expect(queue.state).toBe("running");
		expect(queue.pending).toHaveLength(0);

		queue.enqueue(t2);
		expect(queue.isRunning).toBe(true);
		expect(queue.pending).toHaveLength(1);
		expect(queue.pending[0].name).toBe("t2");

		// Only one execution in flight.
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor).toHaveBeenCalledWith(t1);
		expect(queue.currentTask?.name).toBe("t1");
		expect(calls).toHaveLength(1);
	});

	it("runNext() while running is a no-op", async () => {
		const { executor } = createStubExecutor();
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));

		await queue.runNext();

		expect(executor).toHaveBeenCalledTimes(1);
		expect(queue.pending).toHaveLength(1);
	});
});

describe("TC-F-4.3-2: next task auto-starts after completion", () => {
	it("resolving the first task starts the second automatically", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		const t1 = makeTask("t1");
		const t2 = makeTask("t2");
		queue.enqueue(t1);
		queue.enqueue(t2);

		calls[0].resolve(makeResult("t1"));
		await flush();

		expect(executor).toHaveBeenCalledTimes(2);
		expect(executor).toHaveBeenNthCalledWith(2, t2);
		expect(queue.pending).toHaveLength(0);
		expect(queue.isRunning).toBe(true);
		expect(queue.currentTask?.name).toBe("t2");

		calls[1].resolve(makeResult("t2"));
		await flush();

		expect(queue.isRunning).toBe(false);
		expect(queue.state).toBe("idle");
		expect(queue.currentTask).toBeNull();
		expect(queue.lastResult?.status).toBe("completed");
		expect(queue.lastResult?.taskName).toBe("t2");
	});

	it("a task enqueued after completion starts immediately", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		calls[0].resolve(makeResult("t1"));
		await flush();
		expect(queue.state).toBe("idle");

		queue.enqueue(makeTask("t2"));
		expect(queue.isRunning).toBe(true);
		expect(executor).toHaveBeenCalledTimes(2);
	});
});

describe("TC-F-4.3-3: pauseCurrent stops the current task, preserving the queue", () => {
	it("pause sets isRunning=false and leaves pending unchanged", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));

		queue.pauseCurrent();

		expect(queue.isRunning).toBe(false);
		expect(queue.state).toBe("paused");
		expect(queue.pending).toHaveLength(1);
		expect(queue.pending[0].name).toBe("t2");

		// The in-flight task settles, but the next task must NOT auto-start.
		calls[0].resolve(makeResult("t1"));
		await flush();

		expect(executor).toHaveBeenCalledTimes(1);
		expect(queue.state).toBe("paused");
		expect(queue.pending).toHaveLength(1);
		expect(queue.pending[0].name).toBe("t2");
	});

	it("runNext() after pause resumes the queue", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));
		queue.pauseCurrent();
		calls[0].resolve(makeResult("t1"));
		await flush();
		expect(queue.state).toBe("paused");

		const resume = queue.runNext();
		expect(queue.isRunning).toBe(true);
		expect(executor).toHaveBeenCalledTimes(2);
		expect(queue.pending).toHaveLength(0);

		calls[1].resolve(makeResult("t2"));
		await resume;
		await flush();
		expect(queue.state).toBe("idle");
	});

	it("resume while the paused task is still in flight keeps single-flight", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));
		queue.pauseCurrent();

		// Resume before t1 settles — t2 must not start until t1 finishes.
		void queue.runNext();
		expect(queue.isRunning).toBe(true);
		expect(executor).toHaveBeenCalledTimes(1);

		calls[0].resolve(makeResult("t1"));
		await flush();
		expect(executor).toHaveBeenCalledTimes(2);

		calls[1].resolve(makeResult("t2"));
		await flush();
		expect(queue.state).toBe("idle");
	});

	it("pauseCurrent on an idle queue is a no-op", () => {
		const { executor } = createStubExecutor();
		const queue = new TaskQueue(executor);

		queue.pauseCurrent();

		expect(queue.state).toBe("idle");
		expect(queue.isRunning).toBe(false);
	});
});

describe("executor failures", () => {
	it("a thrown executor error does not break the queue — next task starts", async () => {
		const executor = vi
			.fn((_task: TaskConfig): Promise<TaskResult> => Promise.resolve(makeResult("unused")))
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(makeResult("t2"));
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));

		await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
		await flush();

		expect(queue.state).toBe("idle");
		expect(queue.isRunning).toBe(false);
		expect(queue.pending).toHaveLength(0);
		// The thrown error is recorded as a failed TaskResult...
		// (then overwritten by the second task's result — check via executor order)
		expect(executor).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "t1" }));
		expect(executor).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "t2" }));
		expect(queue.lastResult?.taskName).toBe("t2");
	});

	it("a thrown executor error is recorded as a failed TaskResult with the error message", async () => {
		const executor = vi.fn((_task: TaskConfig): Promise<TaskResult> => Promise.reject(new Error("network down")));
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));

		await vi.waitFor(() => expect(queue.lastResult).not.toBeNull());
		await flush();

		expect(queue.state).toBe("idle");
		expect(queue.lastResult?.taskName).toBe("t1");
		expect(queue.lastResult?.status).toBe("failed");
		expect(queue.lastResult?.error).toBe("network down");
		expect(queue.lastResult?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("the default executor fails the task without crashing the queue", async () => {
		const queue = new TaskQueue();
		queue.enqueue(makeTask("t1"));

		await vi.waitFor(() => expect(queue.lastResult).not.toBeNull());
		await flush();

		expect(queue.state).toBe("idle");
		expect(queue.lastResult?.status).toBe("failed");
		expect(queue.lastResult?.error).toMatch(/no TaskExecutor configured/);
	});
});

describe("F-4.13: persistence hooks (onPendingChange / restore)", () => {
	let tmpRoot: string;
	let filePath: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "fan-scheduler-queue-persist-"));
		filePath = join(tmpRoot, "scheduler-pending.json");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("enqueue fires onPendingChange with a snapshot of the pending list", () => {
		const { executor } = createStubExecutor();
		const snapshots: string[][] = [];
		const queue = new TaskQueue(executor, {
			onPendingChange: (pending) => snapshots.push(pending.map((t) => t.name)),
		});

		queue.enqueue(makeTask("t1")); // picked up immediately — pending back to []
		queue.enqueue(makeTask("t2"));
		queue.enqueue(makeTask("t3"));

		expect(snapshots).toEqual([
			["t1"], // enqueue t1
			[], // dequeue t1 (runNext shift)
			["t2"], // enqueue t2
			["t2", "t3"], // enqueue t3
		]);
	});

	it("dequeue (runNext shift) fires onPendingChange with the remaining tasks", async () => {
		const { executor, calls } = createStubExecutor();
		const snapshots: string[][] = [];
		const queue = new TaskQueue(executor, {
			onPendingChange: (pending) => snapshots.push(pending.map((t) => t.name)),
		});

		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));
		expect(queue.pending).toHaveLength(1);

		calls[0].resolve(makeResult("t1"));
		await flush(); // t2 dequeued — snapshot []

		expect(snapshots.at(-1)).toEqual([]);
		expect(queue.pending).toHaveLength(0);
	});

	it("the hook receives a copy — mutating it does not corrupt the queue", () => {
		const { executor } = createStubExecutor();
		const queue = new TaskQueue(executor, {
			onPendingChange: (pending) => {
				pending.length = 0; // sabotage the snapshot
			},
		});
		queue.enqueue(makeTask("t1"));
		queue.enqueue(makeTask("t2"));
		expect(queue.pending).toHaveLength(1);
		expect(queue.pending[0].name).toBe("t2");
	});

	it("a throwing hook is swallowed and logged — the queue keeps working", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor, {
			onPendingChange: () => {
				throw new Error("disk full");
			},
		});

		queue.enqueue(makeTask("t1"));
		expect(queue.isRunning).toBe(true);
		calls[0].resolve(makeResult("t1"));
		await flush();
		expect(queue.state).toBe("idle");
	});

	it("restore() sets pending in order without starting tasks or firing the hook", () => {
		const { executor } = createStubExecutor();
		const onPendingChange = vi.fn();
		const queue = new TaskQueue(executor, { onPendingChange });

		queue.restore([makeTask("r1"), makeTask("r2")]);

		expect(queue.pending.map((t) => t.name)).toEqual(["r1", "r2"]);
		expect(queue.state).toBe("idle");
		expect(executor).not.toHaveBeenCalled();
		expect(onPendingChange).not.toHaveBeenCalled();
	});

	it("TC-F-4.13-1: 2 pending tasks survive a kill+restart, order preserved", () => {
		// First scheduler run: t1 executing, t2+t3 pending.
		const { executor } = createStubExecutor();
		const queue1 = new TaskQueue(executor, {
			onPendingChange: (pending) => savePendingTasks(filePath, pending),
		});
		queue1.enqueue(makeTask("t1"));
		queue1.enqueue(makeTask("t2"));
		queue1.enqueue(makeTask("t3"));
		expect(queue1.pending.map((t) => t.name)).toEqual(["t2", "t3"]);

		// The file on disk reflects exactly the pending list at "kill" time.
		const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; tasks: TaskConfig[] };
		expect(onDisk.version).toBe(PENDING_QUEUE_VERSION);
		expect(onDisk.tasks.map((t) => t.name)).toEqual(["t2", "t3"]);

		// "Restart": a brand-new queue restores from the file.
		const queue2 = new TaskQueue(createStubExecutor().executor);
		queue2.restore(loadPendingTasks(filePath));

		expect(queue2.pending).toHaveLength(2);
		expect(queue2.pending.map((t) => t.name)).toEqual(["t2", "t3"]);
	});

	it("TC-F-4.13-2: drained queue persists an empty tasks array (no stale tasks)", async () => {
		// Stale data from a previous run.
		savePendingTasks(filePath, [makeTask("stale")]);
		expect(loadPendingTasks(filePath)).toHaveLength(1);

		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor, {
			onPendingChange: (pending) => savePendingTasks(filePath, pending),
		});
		queue.enqueue(makeTask("t1"));
		calls[0].resolve(makeResult("t1"));
		await flush();

		expect(queue.state).toBe("idle");
		const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; tasks: unknown[] };
		expect(onDisk.version).toBe(PENDING_QUEUE_VERSION);
		expect(onDisk.tasks).toEqual([]);
		expect(loadPendingTasks(filePath)).toEqual([]);
	});

	it("without a persistence hook the queue behaves exactly as before", async () => {
		const { executor, calls } = createStubExecutor();
		const queue = new TaskQueue(executor);
		queue.enqueue(makeTask("t1"));
		calls[0].resolve(makeResult("t1"));
		await flush();
		expect(queue.state).toBe("idle");
		expect(existsSync(filePath)).toBe(false);
	});
});
