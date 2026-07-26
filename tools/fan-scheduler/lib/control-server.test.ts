import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startControlServer, type ControlServerHandle, type ControlState } from "./control-server.js";
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

/** Executor stub: never settles — keeps the queue in the running state. */
function hangingExecutor(): Promise<TaskResult> {
	return new Promise<TaskResult>(() => {});
}

let server: ControlServerHandle | null = null;
let baseUrl = "";

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (server !== null) {
		await server.close();
		server = null;
	}
});

async function startWith(queue: TaskQueue, extraState?: () => Record<string, unknown>): Promise<void> {
	server = await startControlServer({ queue, port: 0, extraState });
	baseUrl = `http://127.0.0.1:${server.port}`;
}

describe("control server (F-4.12)", () => {
	it("GET /state reports the queue state", async () => {
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));
		await startWith(queue, () => ({ pausedForChat: false }));

		const res = await fetch(`${baseUrl}/state`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ControlState;
		expect(body.state).toBe("running");
		expect(body.isRunning).toBe(true);
		expect(body.pendingCount).toBe(0);
		expect(body.currentTask).toBe("auto-1");
		expect(body.pausedForChat).toBe(false);
	});

	it("POST /pause pauses the running queue", async () => {
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));
		expect(queue.isRunning).toBe(true);
		await startWith(queue);

		const res = await fetch(`${baseUrl}/pause`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as ControlState & { ok: boolean };
		expect(body.ok).toBe(true);
		expect(body.state).toBe("paused");
		expect(queue.isRunning).toBe(false);
		expect(queue.state).toBe("paused");
	});

	it("POST /resume resumes auto-advance (runNext)", async () => {
		let resolveTask!: (r: TaskResult) => void;
		const queue = new TaskQueue(
			() =>
				new Promise<TaskResult>((res) => {
					resolveTask = res;
				}),
		);
		queue.enqueue(makeTask("auto-1"));
		queue.pauseCurrent();
		expect(queue.state).toBe("paused");
		await startWith(queue);

		const res = await fetch(`${baseUrl}/resume`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as ControlState & { ok: boolean };
		expect(body.ok).toBe(true);
		// Paused task still in flight → runNext resumes the running state.
		expect(queue.state).toBe("running");
		expect(queue.isRunning).toBe(true);

		// Cleanup: settle the task so no dangling promise survives the test.
		resolveTask({
			taskName: "auto-1",
			status: "completed",
			durationMs: 1,
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
		});
	});

	it("unknown routes answer 404 with the route list", async () => {
		const queue = new TaskQueue(hangingExecutor);
		await startWith(queue);

		const res = await fetch(`${baseUrl}/nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; routes: string[] };
		expect(body.routes).toEqual(["GET /state", "POST /pause", "POST /resume"]);
	});

	it("GET /state on an idle queue reports idle with null currentTask", async () => {
		const queue = new TaskQueue(hangingExecutor);
		await startWith(queue);

		const res = await fetch(`${baseUrl}/state`);
		const body = (await res.json()) as ControlState;
		expect(body.state).toBe("idle");
		expect(body.isRunning).toBe(false);
		expect(body.currentTask).toBeNull();
		expect(body.lastResult).toBeNull();
	});
});
