import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsSendMessagePayload } from "../ws-handler.js";

// Mock the 'ws' module — ws-handler does a dynamic import("ws"). The mock
// captures the "connection" handler so tests can invoke it with a fake ws.
const wsMock = vi.hoisted(() => ({
	connectionHandlers: [] as Array<(ws: unknown, req: unknown) => void>,
}));

vi.mock("ws", () => ({
	WebSocketServer: vi.fn().mockImplementation(() => ({
		on: vi.fn((event: string, cb: (ws: unknown, req: unknown) => void) => {
			if (event === "connection") wsMock.connectionHandlers.push(cb);
		}),
		close: vi.fn(),
		handleUpgrade: vi.fn(),
		emit: vi.fn(),
	})),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: {
			create: vi.fn(),
			update: vi.fn(),
			findMany: vi.fn(),
			delete: vi.fn(),
		},
	}),
}));

process.env.FAN_NO_AUTH = "1";

function createMockAdapter() {
	return {
		listSessions: vi.fn().mockResolvedValue([]),
		getSession: vi.fn().mockResolvedValue(null),
		createSession: vi.fn().mockResolvedValue({ id: "s1", title: "Test" }),
		deleteSession: vi.fn().mockResolvedValue(false),
		sendMessage: vi.fn().mockResolvedValue(true),
		subscribeToSession: vi.fn().mockReturnValue(() => {}),
		getAvailableModels: vi.fn().mockResolvedValue([]),
		bindSessionExtensions: vi.fn().mockResolvedValue(undefined),
		listProjects: vi.fn().mockResolvedValue([]),
		getActiveSessionId: vi.fn().mockReturnValue(null),
		isExecuting: vi.fn().mockReturnValue(false),
	};
}

// Minimal BunWebSocket fake — only the surface the bridge touches.
function makeFakeWs(sessionId: string) {
	const sent: Array<Record<string, unknown>> = [];
	const ws = {
		data: { sessionId },
		send: (data: string) => sent.push(JSON.parse(data)),
		close: vi.fn(),
	};
	return { ws, sent };
}

describe("F-5.6: queue restoration on server startup", () => {
	let queuesDir: string;
	let fs: typeof import("node:fs/promises");

	beforeEach(async () => {
		fs = await import("node:fs/promises");
		const os = await import("node:os");
		const path = await import("node:path");
		queuesDir = await fs.mkdtemp(path.join(os.tmpdir(), "fan-qrestore-"));
		wsMock.connectionHandlers.length = 0;
	});

	afterEach(async () => {
		await fs.rm(queuesDir, { recursive: true, force: true });
	});

	it("TC-F-5.6-1: pending queues on disk → restore → client receives queues_restored with N and sessions", async () => {
		const { PersistentMessageQueue } = await import("../message-queue.js");
		const { createBunWebSocketBridge, restoreQueuesOnStartup } = await import("../ws-handler.js");

		// Previous server run: two sessions with pending messages.
		const previous = new PersistentMessageQueue<WsSendMessagePayload>({ queuesDir });
		await previous.enqueue("sess-a", { content: "a1" });
		await previous.enqueue("sess-a", { content: "a2" });
		await previous.enqueue("sess-b", { content: "b1" });

		// Server restart: fresh queue instance over the same directory.
		const queue = new PersistentMessageQueue<WsSendMessagePayload>({ queuesDir });
		const info = await restoreQueuesOnStartup(queue);

		expect(info).not.toBeNull();
		expect(info!.restoredCount).toBe(2);
		expect(info!.sessions).toHaveLength(2);
		expect(info!.sessions).toEqual(expect.arrayContaining(["sess-a", "sess-b"]));

		// A WS client connecting after startup gets the notification right
		// after the welcome frame.
		const adapter = createMockAdapter();
		const bridge = createBunWebSocketBridge(adapter as never, "/api/ws/", queue, info!);
		const client = makeFakeWs("sess-a");
		bridge.websocket.open(client.ws as never);

		expect(client.sent[0].type).toBe("connected");
		const restored = client.sent.find((m) => m.type === "queues_restored");
		expect(restored).toBeDefined();
		expect(restored!.restoredCount).toBe(2);
		expect(restored!.sessions).toEqual(expect.arrayContaining(["sess-a", "sess-b"]));
		expect(typeof restored!.timestamp).toBe("string");

		// A late-connecting client (different session) is notified too —
		// per-client-on-connect delivery, not a one-time broadcast.
		const lateClient = makeFakeWs("sess-b");
		bridge.websocket.open(lateClient.ws as never);
		expect(lateClient.sent.some((m) => m.type === "queues_restored")).toBe(true);
	});

	it("TC-F-5.6-1 (Node ws path): attachWebSocketHandler delivers queues_restored on connect", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");

		const server = createServer();
		const adapter = createMockAdapter();
		const handler = attachWebSocketHandler({
			server: server as never,
			sessionAdapter: adapter as never,
			restoredQueues: { restoredCount: 2, sessions: ["sess-a", "sess-b"] },
		});
		try {
			const socket = { write: vi.fn(), destroy: vi.fn() };
			server.emit("upgrade", { url: "/api/ws/sess-a", headers: { host: "localhost" } }, socket, Buffer.alloc(0));
			await vi.waitFor(() => expect(wsMock.connectionHandlers.length).toBe(1));

			const sent: Array<Record<string, unknown>> = [];
			const fakeWs = {
				readyState: 1,
				send: (d: string) => sent.push(JSON.parse(d)),
				on: vi.fn(),
				close: vi.fn(),
			};
			wsMock.connectionHandlers[0](fakeWs, {
				url: "/api/ws/sess-a",
				headers: { host: "localhost" },
			});

			expect(sent[0].type).toBe("connected");
			expect(sent[1].type).toBe("queues_restored");
			expect(sent[1].restoredCount).toBe(2);
			expect(sent[1].sessions).toEqual(["sess-a", "sess-b"]);
		} finally {
			handler.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("TC-F-5.6-2: empty start → restoredCount=0, NO queues_restored frame, no errors", async () => {
		const { PersistentMessageQueue } = await import("../message-queue.js");
		const { createBunWebSocketBridge, restoreQueuesOnStartup } = await import("../ws-handler.js");

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const queue = new PersistentMessageQueue<WsSendMessagePayload>({ queuesDir });
			const info = await restoreQueuesOnStartup(queue);

			expect(info).toEqual({ restoredCount: 0, sessions: [] });

			const adapter = createMockAdapter();
			const bridge = createBunWebSocketBridge(adapter as never, "/api/ws/", queue, info ?? undefined);
			const client = makeFakeWs("sess-x");
			bridge.websocket.open(client.ws as never);

			expect(client.sent).toHaveLength(1);
			expect(client.sent[0].type).toBe("connected");
			expect(client.sent.some((m) => m.type === "queues_restored")).toBe(false);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("restoration failure is logged and non-fatal (returns null)", async () => {
		const { restoreQueuesOnStartup } = await import("../ws-handler.js");

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const brokenQueue = {
				maxSize: 50,
				enqueue: vi.fn(),
				dequeue: vi.fn(),
				peek: vi.fn(),
				size: vi.fn(),
				dequeueOldest: vi.fn(),
				getAllActive: vi.fn().mockRejectedValue(new Error("disk on fire")),
			};
			const info = await restoreQueuesOnStartup(brokenQueue as never);
			expect(info).toBeNull();
			expect(errorSpy).toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("in-memory queue is not restorable (returns null, no disk access)", async () => {
		const { InMemoryMessageQueue } = await import("../message-queue.js");
		const { restoreQueuesOnStartup } = await import("../ws-handler.js");

		const queue = new InMemoryMessageQueue();
		await queue.enqueue("sess-a", { content: "m1" });
		expect(await restoreQueuesOnStartup(queue as never)).toBeNull();
	});
});
