import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsSendMessagePayload } from "../ws-handler.js";

// Mock the 'ws' module — ws-handler does a dynamic import("ws")
vi.mock("ws", () => ({
	WebSocketServer: vi.fn().mockImplementation(() => ({
		on: vi.fn(),
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

describe("WebSocket Handler", () => {
	let server: Server;

	beforeEach(() => {
		server = createServer();
	});

	afterEach(() => {
		// Ensure server is closed after each test
		return new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

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

	describe("attachWebSocketHandler", () => {
		it("should attach upgrade handler to server and return close function", async () => {
			const { attachWebSocketHandler } = await import("../ws-handler.js");
			const mockAdapter = createMockAdapter();

			const handler = attachWebSocketHandler({
				server,
				sessionAdapter: mockAdapter,
			});

			// Verify close function exists
			expect(typeof handler.close).toBe("function");

			// Cleanup
			handler.close();
		});

		it("should clean up all clients on close", async () => {
			const { attachWebSocketHandler } = await import("../ws-handler.js");
			const mockAdapter = createMockAdapter();

			const handler = attachWebSocketHandler({
				server,
				sessionAdapter: mockAdapter,
			});

			// Close should not throw
			handler.close();

			// Second close should be a no-op (idempotent)
			handler.close();
		});

		it("should accept custom pathPrefix option", async () => {
			const { attachWebSocketHandler } = await import("../ws-handler.js");
			const mockAdapter = createMockAdapter();

			const handler = attachWebSocketHandler({
				server,
				sessionAdapter: mockAdapter,
				pathPrefix: "/ws/",
			});

			expect(typeof handler.close).toBe("function");
			handler.close();
		});
	});

	describe("F-2.5: enqueue on busy (Bun bridge)", () => {
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

		it("TC-F-2.5-1: busy engine + different session → queued notification, message enqueued", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const adapter = createMockAdapter();
			adapter.isExecuting.mockReturnValue(true);
			adapter.getActiveSessionId.mockReturnValue("sess-A");

			const bridge = createBunWebSocketBridge(adapter);
			const { ws, sent } = makeFakeWs("sess-B");
			bridge.websocket.open(ws);

			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "test" }));

			await vi.waitFor(() => {
				expect(sent.some((m) => m.type === "queued")).toBe(true);
			});
			const queued = sent.find((m) => m.type === "queued");
			expect(queued).toMatchObject({ type: "queued", sessionId: "sess-B", position: 1 });
			// Not dispatched while busy with another session
			expect(adapter.sendMessage).not.toHaveBeenCalled();
		});

		it("TC-F-2.5-2: idle engine → direct dispatch, no queued notification", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const adapter = createMockAdapter();
			adapter.isExecuting.mockReturnValue(false);
			adapter.getActiveSessionId.mockReturnValue("sess-B");

			const bridge = createBunWebSocketBridge(adapter);
			const { ws, sent } = makeFakeWs("sess-B");
			bridge.websocket.open(ws);

			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "hello" }));

			await vi.waitFor(() => {
				expect(adapter.sendMessage).toHaveBeenCalledWith("sess-B", "hello", undefined);
			});
			expect(sent.some((m) => m.type === "queued")).toBe(false);
		});

		it("TC-F-2.5-2b: two rapid sendMessage for inactive session queue the second while dispatch pending", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const adapter = createMockAdapter();
			adapter.isExecuting.mockReturnValue(false);
			adapter.getActiveSessionId.mockReturnValue(null);

			let releaseSend: () => void;
			const sendGate = new Promise<void>((resolve) => {
				releaseSend = resolve;
			});
			adapter.sendMessage.mockImplementation(async () => {
				await sendGate;
				return true;
			});

			const bridge = createBunWebSocketBridge(adapter);
			const { ws, sent } = makeFakeWs("sess-A");
			bridge.websocket.open(ws);

			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m1" }));
			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m2" }));

			// Wait until the first (and only) direct dispatch has entered sendMessage.
			await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(1));
			expect(adapter.sendMessage).toHaveBeenCalledWith("sess-A", "m1", undefined);

			// The second message must have been queued, not dispatched.
			const queued = sent.filter((m) => m.type === "queued");
			expect(queued).toHaveLength(1);
			expect(queued[0]).toMatchObject({ type: "queued", sessionId: "sess-A", position: 1 });

			releaseSend!();
			await vi.waitFor(() => expect(adapter.sendMessage).toHaveBeenCalledTimes(2));
			expect(adapter.sendMessage.mock.calls[1]).toEqual(["sess-A", "m2", undefined]);
		});

		it("busy engine + SAME active session → direct dispatch (prompt queues via followUp internally)", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const adapter = createMockAdapter();
			adapter.isExecuting.mockReturnValue(true);
			adapter.getActiveSessionId.mockReturnValue("sess-A");

			const bridge = createBunWebSocketBridge(adapter);
			const { ws, sent } = makeFakeWs("sess-A");
			bridge.websocket.open(ws);

			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "steer me" }));

			await vi.waitFor(() => {
				expect(adapter.sendMessage).toHaveBeenCalledWith("sess-A", "steer me", undefined);
			});
			expect(sent.some((m) => m.type === "queued")).toBe(false);
		});

		it("two queued messages → positions 1 and 2; dequeue on completion executes them in order", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const adapter = createMockAdapter();
			let executing = true;
			adapter.isExecuting.mockImplementation(() => executing);
			adapter.getActiveSessionId.mockReturnValue("sess-A");

			// Capture the session event handler registered on open()
			let eventHandler: ((event: unknown) => void) | null = null;
			adapter.subscribeToSession.mockImplementation((_id: string, handler: (event: unknown) => void) => {
				eventHandler = handler;
				return () => {};
			});

			const bridge = createBunWebSocketBridge(adapter);
			const { ws, sent } = makeFakeWs("sess-B");
			bridge.websocket.open(ws);

			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m1" }));
			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m2" }));

			await vi.waitFor(() => {
				const positions = sent.filter((m) => m.type === "queued").map((m) => m.position);
				expect(positions).toEqual([1, 2]);
			});
			expect(adapter.sendMessage).not.toHaveBeenCalled();

			// Task completes → engine idle → agent_end event triggers the dequeue processor
			executing = false;
			eventHandler!({ type: "agent_end" });

			await vi.waitFor(() => {
				expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
			});
			// FIFO order: m1 before m2, both for sess-B
			expect(adapter.sendMessage.mock.calls[0]).toEqual(["sess-B", "m1", undefined]);
			expect(adapter.sendMessage.mock.calls[1]).toEqual(["sess-B", "m2", undefined]);
		});

		it("global FIFO across sessions: oldest message (any session) dequeues first", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const adapter = createMockAdapter();
			let executing = true;
			adapter.isExecuting.mockImplementation(() => executing);
			adapter.getActiveSessionId.mockReturnValue("sess-A");

			let eventHandler: ((event: unknown) => void) | null = null;
			adapter.subscribeToSession.mockImplementation((_id: string, handler: (event: unknown) => void) => {
				eventHandler = handler;
				return () => {};
			});

			const bridge = createBunWebSocketBridge(adapter);
			const clientB = makeFakeWs("sess-B");
			const clientC = makeFakeWs("sess-C");
			bridge.websocket.open(clientB.ws);
			bridge.websocket.open(clientC.ws);

			// Enqueue: sess-C first, then sess-B
			bridge.websocket.message(clientC.ws, JSON.stringify({ type: "sendMessage", content: "from-C" }));
			await vi.waitFor(() => expect(clientC.sent.some((m) => m.type === "queued")).toBe(true));
			bridge.websocket.message(clientB.ws, JSON.stringify({ type: "sendMessage", content: "from-B" }));
			await vi.waitFor(() => expect(clientB.sent.some((m) => m.type === "queued")).toBe(true));

			executing = false;
			eventHandler!({ type: "agent_end" });

			await vi.waitFor(() => {
				expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
			});
			// Global timestamp order: from-C (enqueued first) executes before from-B
			expect(adapter.sendMessage.mock.calls[0]).toEqual(["sess-C", "from-C", undefined]);
			expect(adapter.sendMessage.mock.calls[1]).toEqual(["sess-B", "from-B", undefined]);
		});

		it("TC-F-2.15-2: full queue → queue_full notification with QUEUE_OVERFLOW and limit", async () => {
			const { createBunWebSocketBridge } = await import("../ws-handler.js");
			const { InMemoryMessageQueue } = await import("../message-queue.js");
			const adapter = createMockAdapter();
			adapter.isExecuting.mockReturnValue(true);
			adapter.getActiveSessionId.mockReturnValue("sess-A");

			// Small limit keeps the test fast; default is 50.
			const messageQueue = new InMemoryMessageQueue<WsSendMessagePayload>({ maxSize: 2 });
			const bridge = createBunWebSocketBridge(adapter, "/api/ws/", messageQueue);
			const { ws, sent } = makeFakeWs("sess-B");
			bridge.websocket.open(ws);

			// Fill the queue (positions 1 and 2).
			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m1" }));
			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m2" }));
			await vi.waitFor(() => {
				expect(sent.filter((m) => m.type === "queued").map((m) => m.position)).toEqual([1, 2]);
			});

			// Third message → rejected with queue_full instead of queued.
			bridge.websocket.message(ws, JSON.stringify({ type: "sendMessage", content: "m3" }));
			await vi.waitFor(() => {
				expect(sent.some((m) => m.type === "queue_full")).toBe(true);
			});
			const queueFull = sent.find((m) => m.type === "queue_full");
			expect(queueFull).toMatchObject({
				type: "queue_full",
				sessionId: "sess-B",
				error: "QUEUE_OVERFLOW",
				limit: 2,
			});
			// Rejected message was never queued or dispatched.
			expect(await messageQueue.size("sess-B")).toBe(2);
			expect(adapter.sendMessage).not.toHaveBeenCalled();
		});
	});
});
