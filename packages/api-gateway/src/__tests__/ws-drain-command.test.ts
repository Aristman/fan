/**
 * F-06: WS drain command — Red-phase tests
 *
 * Feature: WebSocket command `{type:"drain"}` triggers session drain
 * Source: docs/features/super-orchestrator/mission-loop-0/roadmap.md (F-06, AC §3)
 *
 * Spec §AC:
 *   "WS-команда `{ type: "drain" }` обрабатывается аналогично REST"
 *
 * Red expectation: the current WS handler only processes `ping` and `abort` and
 * silently drops all other message types (ws-handler.ts:158-162 comment
 * "Other message types can be handled here in the future"). Sending
 * `{type:"drain"}` must NOT trigger drainSession → assertions below FAIL.
 *
 * Semantic difference from abort: drain is graceful — it does NOT clear the
 * queue or interrupt the current turn. The endpoint must call drainSession
 * (not abortSession) when the WS message arrives.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

// Mock @fan/db — auth.ts uses getPrismaClient().clientToken.update for validateToken.
// Note: this file does NOT mock "ws" — we want a real WebSocketServer + real client
// so the message handler path is genuinely exercised.
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

// Bypass token auth for WS in tests (simpler — auth covered by REST TC-F06-2)
process.env.FAN_NO_AUTH = "1";

describe("F-06: WS drain command ({type:'drain'})", () => {
	let server: Server;
	let port: number;
	let mockAdapter: {
		[key: string]: unknown;
		abortSession: ReturnType<typeof vi.fn>;
		drainSession: ReturnType<typeof vi.fn>;
	};
	let handler: { close: () => void } | null = null;

	beforeEach(async () => {
		mockAdapter = {
			listSessions: vi.fn().mockResolvedValue([]),
			getSession: vi.fn().mockResolvedValue(null),
			createSession: vi.fn().mockResolvedValue({ id: "s1", title: "Test" }),
			deleteSession: vi.fn().mockResolvedValue(false),
			sendMessage: vi.fn().mockResolvedValue(true),
			subscribeToSession: vi.fn().mockReturnValue(() => {}),
			getAvailableModels: vi.fn().mockResolvedValue([]),
			bindSessionExtensions: vi.fn().mockResolvedValue(undefined),
			whenReady: vi.fn().mockResolvedValue(undefined),
			listAnalyticsReports: vi.fn().mockResolvedValue([]),
			readAnalyticsReport: vi.fn().mockResolvedValue(null),
			abortSession: vi.fn().mockResolvedValue(true),
			drainSession: vi.fn().mockResolvedValue(true),
		};

		server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = server.address();
		port = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterEach(async () => {
		if (handler) {
			handler.close();
			handler = null;
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	/**
	 * Open a real WebSocket connection to the test server.
	 * Resolves on `open`, rejects on error / timeout.
	 */
	async function openWs(sessionId: string): Promise<WebSocket> {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/${sessionId}`);
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("WS connection timeout")), 5000);
			ws.once("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.once("error", (err: Error) => {
				clearTimeout(timeout);
				reject(err);
			});
		});
		return ws;
	}

	// =========================================================================
	// TC-F06-WS: WS-команда `{ type: "drain" }` обрабатывается аналогично REST
	// =========================================================================
	it("TC-F06-WS: WS drain message triggers drainSession on the adapter", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			// Cast: SessionAdapter doesn't yet declare drainSession (F-06 implementation)
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("test-session");

		// Send drain command
		ws.send(JSON.stringify({ type: "drain" }));

		// Allow handler to process the message
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: WS handler currently ignores non-ping/non-abort messages → drainSession never called
		expect(mockAdapter.drainSession).toHaveBeenCalled();
		expect(mockAdapter.drainSession).toHaveBeenCalledWith("test-session");

		ws.close();
	});

	it("TC-F06-WS-shape: WS message with correct shape { type: 'drain' } reaches handler", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("another-session");

		// Verify the WS envelope is what the implementation expects (type: "drain")
		ws.send(JSON.stringify({ type: "drain" }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: passes only when WsIncomingMessage type is extended AND handler routes to drainSession
		expect(mockAdapter.drainSession).toHaveBeenCalledWith("another-session");

		ws.close();
	});

	it("TC-F06-WS-idle: WS drain on session with no active generation is idempotent", async () => {
		// Simulate "session exists but no active generation" — drainSession returns true (no-op)
		mockAdapter.drainSession.mockResolvedValue(true);

		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("idle-session");
		ws.send(JSON.stringify({ type: "drain" }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: drained even when there's no active generation (handler must not gate on isActive)
		expect(mockAdapter.drainSession).toHaveBeenCalledWith("idle-session");

		ws.close();
	});

	// =========================================================================
	// Semantic difference: drain must NOT call abortSession
	// =========================================================================
	it("TC-F06-WS-semantic: WS drain must NOT trigger abortSession (graceful vs hard)", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("semantic-session");

		// Send drain command — endpoint must route to drainSession, NOT abortSession.
		// F-05: drain lets the current turn finish, then pauses. Abort kills immediately.
		ws.send(JSON.stringify({ type: "drain" }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: handler currently ignores "drain" → neither method is called.
		// After implementation: drainSession called, abortSession untouched.
		expect(mockAdapter.drainSession).toHaveBeenCalledWith("semantic-session");
		expect(mockAdapter.abortSession).not.toHaveBeenCalled();

		ws.close();
	});
});
