/**
 * F-01: WS abort command — Red-phase tests
 *
 * Feature: WebSocket command `{type:"abort"}` triggers session abort
 * Source: docs/features/super-orchestrator/mission-loop-0/roadmap.md (F-01, AC §3)
 *         docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.2
 *
 * Spec §6.1 "Изменения ядра" #1:
 *   "WS-команда `{ type: "abort" }` в `WsIncomingMessage` обрабатывается аналогично REST"
 *
 * Red expectation: the current WS handler only processes `ping` and silently drops
 * all other message types (ws-handler.ts:158-162 comment "Other message types can be
 * handled here in the future"). Sending `{type:"abort"}` must NOT trigger
 * abortSession → assertions below FAIL.
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

// Bypass token auth for WS in tests (simpler — auth covered by REST TC-F01-2)
process.env.FAN_NO_AUTH = "1";

describe("F-01: WS abort command ({type:'abort'})", () => {
	let server: Server;
	let port: number;
	let mockAdapter: {
		[key: string]: unknown;
		abortSession: ReturnType<typeof vi.fn>;
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
	// TC-F01-WS: WS-команда `{ type: "abort" }` обрабатывается аналогично REST
	// =========================================================================
	it("TC-F01-WS: WS abort message triggers abortSession on the adapter", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			// Cast: SessionAdapter doesn't yet declare abortSession (F-01 implementation)
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("test-session");

		// Send abort command
		ws.send(JSON.stringify({ type: "abort" }));

		// Allow handler to process the message
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: WS handler currently ignores non-ping messages → abortSession never called
		expect(mockAdapter.abortSession).toHaveBeenCalled();
		expect(mockAdapter.abortSession).toHaveBeenCalledWith("test-session");

		ws.close();
	});

	it("TC-F01-WS-shape: WS message with correct shape { type: 'abort' } reaches handler", async () => {
		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("another-session");

		// Verify the WS envelope is what the implementation expects (type: "abort")
		ws.send(JSON.stringify({ type: "abort" }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: passes only when WsIncomingMessage type is extended AND handler routes to abortSession
		expect(mockAdapter.abortSession).toHaveBeenCalledWith("another-session");

		ws.close();
	});

	it("TC-F01-WS-idle: WS abort on session with no active generation is idempotent", async () => {
		// Simulate "session exists but no active generation" — abortSession returns true (no-op)
		mockAdapter.abortSession.mockResolvedValue(true);

		const { attachWebSocketHandler } = await import("../ws-handler.js");
		handler = attachWebSocketHandler({
			server,
			sessionAdapter: mockAdapter as unknown as Parameters<typeof attachWebSocketHandler>[0]["sessionAdapter"],
		});

		const ws = await openWs("idle-session");
		ws.send(JSON.stringify({ type: "abort" }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Red: aborted even when there's no active generation (handler must not gate on isActive)
		expect(mockAdapter.abortSession).toHaveBeenCalledWith("idle-session");

		ws.close();
	});
});
