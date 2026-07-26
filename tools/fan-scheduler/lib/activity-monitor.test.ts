import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserActivityMonitor } from "./activity-monitor.js";
import type { FanApiClient, FanSessionDetail, FanSessionSummary } from "./client.js";
import type { TaskConfig } from "./config-loader.js";
import { TaskQueue, type TaskResult } from "./queue.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeSummary(id: string, updatedAt: string): FanSessionSummary {
	return {
		id,
		title: `session ${id}`,
		createdAt: "2026-07-26T10:00:00.000Z",
		updatedAt,
		messageCount: 1,
	};
}

function makeDetail(id: string, messages: Array<{ role: "user" | "assistant"; createdAt: string }>): FanSessionDetail {
	return {
		id,
		title: `session ${id}`,
		createdAt: "2026-07-26T10:00:00.000Z",
		updatedAt: messages[messages.length - 1]?.createdAt ?? "2026-07-26T10:00:00.000Z",
		messages: messages.map((m, i) => ({ id: `${id}-m${i}`, role: m.role, content: "x", createdAt: m.createdAt })),
	};
}

/** Mock FAN API client: only the two reads used by the monitor. */
function createMockClient() {
	const sessions: FanSessionSummary[] = [];
	const details = new Map<string, FanSessionDetail>();
	const client = {
		getSessionList: vi.fn(async () => sessions),
		getSession: vi.fn(async (id: string) => {
			const detail = details.get(id);
			if (detail === undefined) throw new Error(`unknown session ${id}`);
			return detail;
		}),
	};
	return { client: client as unknown as FanApiClient, sessions, details };
}

/** Executor stub: never settles — keeps the queue in the running state. */
function hangingExecutor(): Promise<TaskResult> {
	return new Promise<TaskResult>(() => {});
}

/** Current time used by the monitor's clock (fixed unless overridden). */
const T0 = Date.parse("2026-07-26T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

let nowValue = T0;

beforeEach(() => {
	nowValue = T0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createMonitor(client: FanApiClient, queue: TaskQueue, activityWindowMs = 60000): UserActivityMonitor {
	return new UserActivityMonitor(client, queue, { activityWindowMs, now: () => nowValue });
}

// ---------------------------------------------------------------------------
// TC-F-4.12-1: chat activity pauses the running autonomous task
// ---------------------------------------------------------------------------

describe("TC-F-4.12-1: chat activity detected → pauseCurrent, isRunning=false, log", () => {
	it("running task + recent user message in a non-scheduler session → queue paused", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));
		expect(queue.isRunning).toBe(true);

		// User wrote in their own chat session 5 seconds ago.
		sessions.push(makeSummary("user-chat", iso(nowValue - 5000)));
		details.set(
			"user-chat",
			makeDetail("user-chat", [{ role: "user", createdAt: iso(nowValue - 5000) }]),
		);

		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();

		expect(queue.isRunning).toBe(false);
		expect(queue.state).toBe("paused");
		expect(monitor.pausedForChat).toBe(true);

		// Log line required by TC-F-4.12-1.
		const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("chat_interruption");
		expect(logged).toContain("Paused autonomous task for live chat");
	});

	it("scheduler-owned sessions never trigger a pause (task prompt is a user message too)", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));

		sessions.push(makeSummary("sched-session", iso(nowValue - 1000)));
		details.set(
			"sched-session",
			makeDetail("sched-session", [{ role: "user", createdAt: iso(nowValue - 1000) }]),
		);

		const monitor = createMonitor(client, queue);
		monitor.registerSchedulerSession("sched-session");
		await monitor.checkOnce();

		expect(queue.isRunning).toBe(true);
		expect(monitor.pausedForChat).toBe(false);
		// The session detail is never even fetched for scheduler-owned sessions.
		expect((client as unknown as { getSession: ReturnType<typeof vi.fn> }).getSession).not.toHaveBeenCalled();
	});

	it("stale user message (outside the activity window) does not pause", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));

		sessions.push(makeSummary("user-chat", iso(nowValue - 120000)));
		details.set(
			"user-chat",
			makeDetail("user-chat", [{ role: "user", createdAt: iso(nowValue - 120000) }]),
		);

		const monitor = createMonitor(client, queue, 60000);
		await monitor.checkOnce();

		expect(queue.isRunning).toBe(true);
		expect(monitor.pausedForChat).toBe(false);
	});

	it("idle queue + chat activity → pause is recorded but nothing breaks", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);

		sessions.push(makeSummary("user-chat", iso(nowValue - 1000)));
		details.set("user-chat", makeDetail("user-chat", [{ role: "user", createdAt: iso(nowValue - 1000) }]));

		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();

		expect(monitor.pausedForChat).toBe(true);
		expect(queue.state).toBe("idle");
	});
});

// ---------------------------------------------------------------------------
// TC-F-4.12-2: activity ended → runNext (resume)
// ---------------------------------------------------------------------------

describe("TC-F-4.12-2: chat activity ended → runNext (resume)", () => {
	it("window expiry resumes the queue and the next pending task starts", async () => {
		const { client, sessions, details } = createMockClient();
		const finished: string[] = [];
		const queue = new TaskQueue((task) => {
			finished.push(`started:${task.name}`);
			return new Promise<TaskResult>(() => {});
		});
		queue.enqueue(makeTask("auto-1"));
		expect(queue.isRunning).toBe(true);

		// Turn 1: user active → pause.
		sessions.push(makeSummary("user-chat", iso(nowValue - 5000)));
		details.set("user-chat", makeDetail("user-chat", [{ role: "user", createdAt: iso(nowValue - 5000) }]));
		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();
		expect(queue.state).toBe("paused");

		// Meanwhile a second autonomous task arrives and waits in pending.
		queue.enqueue(makeTask("auto-2"));
		expect(queue.pending).toHaveLength(1);

		// Turn 2: user message aged beyond the window → resume.
		nowValue = T0 + 70000;
		await monitor.checkOnce();

		expect(monitor.pausedForChat).toBe(false);
		expect(queue.state).toBe("running"); // auto-advance resumed
		expect(queue.isRunning).toBe(true);

		const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("chat_interruption_end");
	});

	it("transitions are logged once (no pause/resume flapping on repeated polls)", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));

		sessions.push(makeSummary("user-chat", iso(nowValue - 1000)));
		details.set("user-chat", makeDetail("user-chat", [{ role: "user", createdAt: iso(nowValue - 1000) }]));

		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();
		await monitor.checkOnce();
		await monitor.checkOnce();

		const interruptions = (console.log as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
			String(c[0]).includes('"chat_interruption"'),
		);
		expect(interruptions).toHaveLength(1);
		expect(queue.state).toBe("paused");
	});

	it("registration of a scheduler session clears previously recorded activity", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));

		// Session first seen as a user session (activity recorded)...
		sessions.push(makeSummary("s1", iso(nowValue - 1000)));
		details.set("s1", makeDetail("s1", [{ role: "user", createdAt: iso(nowValue - 1000) }]));
		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();
		expect(monitor.pausedForChat).toBe(true);

		// ...then turns out to be scheduler-owned → activity is dropped,
		// next poll resumes.
		monitor.registerSchedulerSession("s1");
		await monitor.checkOnce();
		expect(monitor.pausedForChat).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("robustness", () => {
	it("session list poll failure is best-effort (warning, state unchanged)", async () => {
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));
		const client = {
			getSessionList: vi.fn(async () => {
				throw new Error("gateway unreachable");
			}),
			getSession: vi.fn(),
		} as unknown as FanApiClient;

		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();

		expect(queue.isRunning).toBe(true);
		expect(monitor.pausedForChat).toBe(false);
		const warned = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("\n");
		expect(warned).toContain("activity_poll_failed");
	});

	it("a failing session detail fetch is skipped, other sessions still count", async () => {
		const { client, sessions, details } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		queue.enqueue(makeTask("auto-1"));

		sessions.push(makeSummary("broken", iso(nowValue - 1000))); // no detail → getSession throws
		sessions.push(makeSummary("user-chat", iso(nowValue - 1000)));
		details.set("user-chat", makeDetail("user-chat", [{ role: "user", createdAt: iso(nowValue - 1000) }]));

		const monitor = createMonitor(client, queue);
		await monitor.checkOnce();

		expect(queue.state).toBe("paused");
		const warned = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("\n");
		expect(warned).toContain("activity_session_poll_failed");
	});

	it("start/stop manage the polling timer (idempotent)", () => {
		const { client } = createMockClient();
		const queue = new TaskQueue(hangingExecutor);
		const monitor = createMonitor(client, queue);

		expect(monitor.isWatching).toBe(false);
		monitor.start();
		expect(monitor.isWatching).toBe(true);
		monitor.start(); // no-op
		expect(monitor.isWatching).toBe(true);
		monitor.stop();
		expect(monitor.isWatching).toBe(false);
	});
});
