import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FanApiError,
	type CreateSessionResult,
	type FanApiClient,
	type FanSessionDetail,
	type FanSessionMessage,
} from "./client.js";
import type { TaskConfig } from "./config-loader.js";
import { createTaskExecutor } from "./executor.js";
import { TaskQueue, type TaskResult } from "./queue.js";

function makeTask(overrides: Partial<TaskConfig> = {}): TaskConfig {
	return {
		name: "sample-task",
		schedule: "* * * * *",
		workspace: "/workspaces/sample",
		message: "do the thing",
		budget_limit: 1000,
		timeout: 3600,
		...overrides,
	};
}

function makeMessage(role: FanSessionMessage["role"], tokens?: number): FanSessionMessage {
	return { id: `m-${role}-${tokens ?? 0}`, role, content: role, tokens, createdAt: new Date().toISOString() };
}

function makeSession(messages: FanSessionMessage[]): FanSessionDetail {
	return {
		id: "session-1",
		title: "t",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		messages,
	};
}

type MockClient = Pick<
	FanApiClient,
	"createSession" | "sendMessage" | "getSession" | "setProjectBudget" | "getBudgetUsage"
>;

/** Records call order across all mocked methods. */
function createMockClient(overrides: Partial<MockClient> = {}) {
	const callOrder: string[] = [];
	const session: CreateSessionResult = {
		id: "session-1",
		title: "t",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/workspaces/sample",
	};
	const client: MockClient = {
		createSession: vi.fn(async (_cwd: string) => {
			callOrder.push("createSession");
			return session;
		}),
		sendMessage: vi.fn(async (_id: string, _message: string) => {
			callOrder.push("sendMessage");
		}),
		getSession: vi.fn(async (_id: string) => {
			callOrder.push("getSession");
			return makeSession([makeMessage("user"), makeMessage("assistant", 150)]);
		}),
		setProjectBudget: vi.fn(async (_project: string, _limit: number) => {
			callOrder.push("setProjectBudget");
		}),
		getBudgetUsage: vi.fn(async (project: string) => {
			callOrder.push("getBudgetUsage");
			return { project, used: 0, limit: null };
		}),
		...overrides,
	};
	return { client: client as FanApiClient, mocks: client, callOrder };
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("createTaskExecutor (F-4.4)", () => {
	// TC-F-4.4-1: full pipeline runs in order.
	it("TC-F-4.4-1: executes createSession → setProjectBudget → sendMessage → poll → usage report in order, status completed", async () => {
		const task = makeTask();
		const { client, mocks, callOrder } = createMockClient();
		const execute = createTaskExecutor(client);

		const result = await execute(task);

		expect(result.status).toBe("completed");
		// F-4.9: the budget cap is set BEFORE sendMessage; the final getBudgetUsage
		// is the post-completion usage report.
		expect(callOrder).toEqual(["createSession", "setProjectBudget", "sendMessage", "getSession", "getBudgetUsage"]);
		// Step 1: session created with the task workspace as cwd.
		expect(mocks.createSession).toHaveBeenCalledWith(task.workspace);
		// Step 2: budget cap stored for the task workspace before any tokens are spent.
		expect(mocks.setProjectBudget).toHaveBeenCalledWith(task.workspace, task.budget_limit);
		// Step 3: full message text sent to the created session.
		expect(mocks.sendMessage).toHaveBeenCalledWith("session-1", task.message);
		// Result carries duration and token usage.
		expect(result.taskName).toBe(task.name);
		expect(result.tokensUsed).toBe(150);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(Date.parse(result.startedAt)).not.toBeNaN();
		expect(Date.parse(result.finishedAt)).not.toBeNaN();
		// Log contains the completed status.
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('status=completed'));
	});

	it("polls until the last message is an assistant reply", async () => {
		vi.useFakeTimers();
		const task = makeTask({ budget_limit: null });
		const { client, mocks } = createMockClient({
			getSession: vi
				.fn()
				.mockResolvedValueOnce(makeSession([makeMessage("user")]))
				.mockResolvedValueOnce(makeSession([makeMessage("user"), makeMessage("tool")]))
				.mockResolvedValue(makeSession([makeMessage("user"), makeMessage("tool"), makeMessage("assistant", 42)])),
		});
		const execute = createTaskExecutor(client, { pollIntervalMs: 100 });

		const promise = execute(task);
		await vi.advanceTimersByTimeAsync(0); // createSession + sendMessage + first poll
		await vi.advanceTimersByTimeAsync(100); // second poll
		await vi.advanceTimersByTimeAsync(100); // third poll → completed
		const result = await promise;

		expect(result.status).toBe("completed");
		expect(result.tokensUsed).toBe(42);
		expect(mocks.getSession).toHaveBeenCalledTimes(3);
		// budget_limit: null → no budget update call.
		expect(mocks.setProjectBudget).not.toHaveBeenCalled();
	});

	// TC-F-4.4-2: timeout marks the task and the queue continues.
	it("TC-F-4.4-2: timeout=2s with hanging sendMessage → status timeout, queue continues with next task", async () => {
		vi.useFakeTimers();
		const slowTask = makeTask({ name: "slow", timeout: 2, budget_limit: null });
		const fastTask = makeTask({ name: "fast", budget_limit: null });

		const never = new Promise<void>(() => {});
		const { client } = createMockClient({
			sendMessage: vi.fn(async (id: string) => {
				if (id === "session-1") await never; // slow task hangs here
			}),
			getSession: vi.fn(async () => makeSession([makeMessage("user"), makeMessage("assistant", 7)])),
		});
		(client.createSession as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ id: "session-1", title: "t", createdAt: "", updatedAt: "" })
			.mockResolvedValueOnce({ id: "session-2", title: "t", createdAt: "", updatedAt: "" });

		const results: TaskResult[] = [];
		const base = createTaskExecutor(client, { pollIntervalMs: 100 });
		const queue = new TaskQueue(async (task) => {
			const result = await base(task);
			results.push(result);
			return result;
		});

		queue.enqueue(slowTask);
		queue.enqueue(fastTask);

		await vi.advanceTimersByTimeAsync(2000); // slow task deadline fires
		await vi.advanceTimersByTimeAsync(0); // fast task pipeline
		await vi.advanceTimersByTimeAsync(100);

		expect(results).toHaveLength(2);
		expect(results[0].taskName).toBe("slow");
		expect(results[0].status).toBe("timeout");
		expect(results[0].durationMs).toBe(2000);
		expect(results[0].error).toContain("timeout");
		expect(results[1].taskName).toBe("fast");
		expect(results[1].status).toBe("completed");
	});

	it("marks the task failed when the API call rejects", async () => {
		const task = makeTask({ budget_limit: null });
		const { client, mocks } = createMockClient({
			createSession: vi.fn().mockRejectedValue(new Error("connection refused")),
		});
		// Injected sleep keeps the F-4.10 backoff delays (2s/4s/8s) instant.
		const execute = createTaskExecutor(client, { sleep: vi.fn(async () => {}) });

		const result = await execute(task);

		expect(result.status).toBe("failed");
		expect(result.error).toBe("connection refused");
		// Network errors are retryable (F-4.10): all 3 attempts are made.
		expect(result.attempts).toBe(3);
		expect(mocks.createSession).toHaveBeenCalledTimes(3);
	});

	it("ignores budget update errors with a warning (best-effort)", async () => {
		const task = makeTask({ budget_limit: 500 });
		const { client, mocks } = createMockClient({
			setProjectBudget: vi.fn().mockRejectedValue(new Error("budget endpoint unavailable")),
		});
		const execute = createTaskExecutor(client);

		const result = await execute(task);

		expect(result.status).toBe("completed");
		expect(mocks.setProjectBudget).toHaveBeenCalledWith(task.workspace, 500);
		// warn-level entries are routed to stderr (F-4.11).
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("budget update failed (ignored)"));
	});
});

describe("budget monitor (F-4.9)", () => {
	// TC-F-4.9-1: the cap is set before the task starts spending tokens.
	it("TC-F-4.9-1: budget_limit=500 → setProjectBudget called before sendMessage, log entry recorded", async () => {
		const task = makeTask({ budget_limit: 500, workspace: "/proj" });
		const { client, mocks, callOrder } = createMockClient();
		const execute = createTaskExecutor(client);

		const result = await execute(task);

		expect(result.status).toBe("completed");
		expect(mocks.setProjectBudget).toHaveBeenCalledWith("/proj", 500);
		expect(callOrder.indexOf("setProjectBudget")).toBeGreaterThanOrEqual(0);
		expect(callOrder.indexOf("setProjectBudget")).toBeLessThan(callOrder.indexOf("sendMessage"));
		// Log entry recorded for the cap.
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("budget cap set: 500 tokens for /proj"));
	});

	// TC-F-4.9-2: usage reaching the limit stops the wait.
	it("TC-F-4.9-2: usage 500/500 → status budget_exceeded, warning + budget_monitor event logged", async () => {
		vi.useFakeTimers();
		const task = makeTask({ budget_limit: 500, workspace: "/proj" });
		const { client } = createMockClient({
			// The session never completes (no assistant reply).
			getSession: vi.fn(async () => makeSession([makeMessage("user")])),
			getBudgetUsage: vi.fn(async (project: string) => ({ project, used: 500, limit: 500 })),
		});
		const execute = createTaskExecutor(client, { pollIntervalMs: 100, budgetPollIntervalMs: 100 });

		const promise = execute(task);
		await vi.advanceTimersByTimeAsync(0); // createSession + setProjectBudget + sendMessage + first poll
		await vi.advanceTimersByTimeAsync(100); // second poll → budget check fires
		const result = await promise;

		expect(result.status).toBe("budget_exceeded");
		expect(result.tokensUsed).toBe(500);
		expect(result.error).toContain("budget exceeded");
		// Warning logged (warn → stderr, F-4.11).
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("budget exceeded (500/500 tokens)"));
		// budget_monitor event logged as a JSON line: { event, project, used, limit, percentage }.
		const monitorCall = (console.log as ReturnType<typeof vi.fn>).mock.calls
			.map((c) => String(c[0]))
			.find((line) => line.includes('"event":"budget_monitor"'));
		expect(monitorCall).toBeDefined();
		const payload = JSON.parse(monitorCall?.slice(monitorCall.indexOf("{")) ?? "{}");
		expect(payload).toMatchObject({ event: "budget_monitor", project: "/proj", used: 500, limit: 500, percentage: 100 });
	});

	// TC-F-4.9-3: usage below the limit → normal completion + usage report.
	it("TC-F-4.9-3: usage 200/500 → status completed + usage report 'used 200 / 500 tokens'", async () => {
		const task = makeTask({ budget_limit: 500, workspace: "/proj" });
		const { client } = createMockClient({
			getBudgetUsage: vi.fn(async (project: string) => ({ project, used: 200, limit: 500 })),
		});
		const execute = createTaskExecutor(client);

		const result = await execute(task);

		expect(result.status).toBe("completed");
		expect(result.tokensUsed).toBe(150);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("usage report: used 200 / 500 tokens"));
	});

	it("a failed budget poll is best-effort (warning, task continues)", async () => {
		vi.useFakeTimers();
		const task = makeTask({ budget_limit: 500 });
		const { client } = createMockClient({
			getSession: vi
				.fn()
				.mockResolvedValueOnce(makeSession([makeMessage("user")]))
				.mockResolvedValueOnce(makeSession([makeMessage("user")]))
				.mockResolvedValue(makeSession([makeMessage("user"), makeMessage("assistant", 42)])),
			getBudgetUsage: vi.fn().mockRejectedValue(new Error("gateway down")),
		});
		const execute = createTaskExecutor(client, { pollIntervalMs: 100, budgetPollIntervalMs: 100 });

		const promise = execute(task);
		await vi.advanceTimersByTimeAsync(0); // first poll (user-only)
		await vi.advanceTimersByTimeAsync(100); // second poll → budget check fires (fails, ignored)
		await vi.advanceTimersByTimeAsync(100); // third poll → completed
		const result = await promise;

		expect(result.status).toBe("completed");
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("budget poll failed (monitoring continues)"));
	});
});

describe("retry with exponential backoff (F-4.10)", () => {
	/** Injected sleep that records backoff delays instead of waiting — fast tests. */
	function createSleepRecorder() {
		const delays: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			delays.push(ms);
		});
		return { sleep, delays };
	}

	// TC-F-4.10-1: the pipeline fails once, then succeeds on the second attempt.
	it("TC-F-4.10-1: HTTP 500 on first attempt, success on second → attempts=2, backoff delay ~2s", async () => {
		const { sleep, delays } = createSleepRecorder();
		const task = makeTask({ budget_limit: null });
		const { client, mocks } = createMockClient({
			createSession: vi
				.fn()
				.mockRejectedValueOnce(new FanApiError(500, "FAN API POST /api/sessions failed with HTTP 500: boom"))
				.mockResolvedValue({ id: "session-1", title: "t", createdAt: "", updatedAt: "" }),
		});
		const execute = createTaskExecutor(client, { sleep });

		const result = await execute(task);

		expect(result.status).toBe("completed");
		expect(result.attempts).toBe(2);
		expect(mocks.createSession).toHaveBeenCalledTimes(2);
		// Exactly one backoff delay between attempts: baseDelayMs * 2^(1-1) = 2s.
		expect(delays).toEqual([2000]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("attempt 1/3 failed"));
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("retrying in 2000ms"));
	});

	// TC-F-4.10-2: all attempts fail → task failed, queue advances.
	it("TC-F-4.10-2: always HTTP 500 → 3 attempts, delays 2s/4s/8s, status failed, queue continues", async () => {
		const { sleep, delays } = createSleepRecorder();
		const failingTask = makeTask({ name: "flaky", budget_limit: null });
		const nextTask = makeTask({ name: "next", budget_limit: null });

		const { client } = createMockClient();
		const createSessionMock = client.createSession as ReturnType<typeof vi.fn>;
		// First three calls = the 3 attempts of the failing task; the 4th serves the next task.
		createSessionMock.mockReset();
		createSessionMock
			.mockRejectedValueOnce(new FanApiError(500, "boom"))
			.mockRejectedValueOnce(new FanApiError(500, "boom"))
			.mockRejectedValueOnce(new FanApiError(500, "boom"))
			.mockResolvedValue({ id: "session-2", title: "t", createdAt: "", updatedAt: "" });

		const results: TaskResult[] = [];
		const base = createTaskExecutor(client, { sleep });
		const queue = new TaskQueue(async (task) => {
			const result = await base(task);
			results.push(result);
			return result;
		});

		queue.enqueue(failingTask);
		queue.enqueue(nextTask);
		// Wait until the queue drains (backoff sleeps are injected — no real waiting).
		await vi.waitFor(() => {
			expect(results).toHaveLength(2);
		});

		expect(results[0].taskName).toBe("flaky");
		expect(results[0].status).toBe("failed");
		expect(results[0].attempts).toBe(3);
		expect(results[0].error).toContain("boom");
		// Exponential backoff: 2s, 4s, 8s — one delay per failed attempt.
		expect(delays).toEqual([2000, 4000, 8000]);
		// The queue moved on to the pending task.
		expect(results[1].taskName).toBe("next");
		expect(results[1].status).toBe("completed");
		expect(results[1].attempts).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("attempts exhausted"));
	});

	it("HTTP 400 → 1 attempt, fails immediately without backoff", async () => {
		const { sleep, delays } = createSleepRecorder();
		const task = makeTask({ budget_limit: null });
		const { client, mocks } = createMockClient({
			createSession: vi.fn().mockRejectedValue(new FanApiError(400, "bad request")),
		});
		const execute = createTaskExecutor(client, { sleep });

		const result = await execute(task);

		expect(result.status).toBe("failed");
		expect(result.attempts).toBe(1);
		expect(result.error).toContain("bad request");
		expect(mocks.createSession).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});

	it("HTTP 429 → retryable: succeeds on the 2nd attempt", async () => {
		const { sleep, delays } = createSleepRecorder();
		const task = makeTask({ budget_limit: null });
		const { client, mocks } = createMockClient({
			createSession: vi
				.fn()
				.mockRejectedValueOnce(new FanApiError(429, "rate limited"))
				.mockResolvedValue({ id: "session-1", title: "t", createdAt: "", updatedAt: "" }),
		});
		const execute = createTaskExecutor(client, { sleep });

		const result = await execute(task);

		expect(result.status).toBe("completed");
		expect(result.attempts).toBe(2);
		expect(mocks.createSession).toHaveBeenCalledTimes(2);
		expect(delays).toEqual([2000]);
	});

	it("task timeout and budget_exceeded are NOT retried (attempts=1)", async () => {
		vi.useFakeTimers();
		const { sleep, delays } = createSleepRecorder();
		const task = makeTask({ name: "slow", timeout: 2, budget_limit: null });
		const never = new Promise<void>(() => {});
		const { client, mocks } = createMockClient({
			sendMessage: vi.fn(async () => {
				await never;
			}),
		});
		const execute = createTaskExecutor(client, { sleep, pollIntervalMs: 100 });

		const promise = execute(task);
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.status).toBe("timeout");
		expect(result.attempts).toBe(1);
		expect(mocks.createSession).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});
});
