import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskConfig } from "./config-loader.js";
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
