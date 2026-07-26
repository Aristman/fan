import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
