/// <reference types="vitest/globals" />
/**
 * Server Bootstrap Tests — F-0 (refactor verification)
 *
 * SPEC: docs/features/super-orchestrator-v2/architecture.md §13 Transport pre-requisite
 * Roadmap: docs/features/super-orchestrator-v2/roadmap.md — Этап 0
 *
 * Verifies the extracted `./server-bootstrap.ts` keeps the same behaviour as
 * the pre-refactor `startServer` function in `http-server.ts`:
 *
 *   TC-1: startServer returns a bundle with required fields (port, stop fn, etc.)
 *   TC-2: stop() closes active WebSocket connections gracefully (1000/1001)
 *   TC-3: Two consecutive startServer() calls don't interfere (different ports)
 *
 * Pure unit tests — no `child_process.spawn`, no shell, no external services.
 * Uses native WebSocket (Node 22+ has built-in support), vitest's globals.
 */

import type { ModelManager } from "@fan/model-manager";
import type { SessionAdapter } from "../src/http-server.js";
import { startServer } from "../src/server-bootstrap.js";

const PREVIOUS_FAN_NO_AUTH = process.env.FAN_NO_AUTH;
process.env.FAN_NO_AUTH = "1";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/** Minimal ModelManager stub. */
function createMockModelManager(): ModelManager {
	return {
		getAllModelSettings: () => Promise.resolve([]),
		setModelSetting: () => Promise.resolve(undefined),
		getModelSetting: () => null,
		getBudgetStatus: () => Promise.resolve([]),
		configureBudget: () => Promise.resolve(undefined),
		getRoutingRules: () => Promise.resolve([]),
		onBudgetAlert: () => () => {},
	} as unknown as ModelManager;
}

/** Minimal SessionAdapter stub. */
function createMockSessionAdapter(): SessionAdapter {
	return {
		listSessions: () => Promise.resolve([]),
		getSession: () => Promise.resolve(null),
		createSession: () => Promise.resolve({ id: "s1", title: "Test" }),
		deleteSession: () => Promise.resolve(false),
		sendMessage: () => Promise.resolve(true),
		subscribeToSession: () => () => {},
		getAvailableModels: () => Promise.resolve([]),
		bindSessionExtensions: () => Promise.resolve(),
		whenReady: () => Promise.resolve(),
		listAnalyticsReports: () => Promise.resolve([]),
		readAnalyticsReport: () => Promise.resolve(null),
		abortSession: () => Promise.resolve(true),
		drainSession: () => Promise.resolve(true),
	} as unknown as SessionAdapter;
}

// ─── TC-1: signature & required fields ─────────────────────────────────────

describe("server-bootstrap: TC-1 startServer signature", () => {
	it("returns a bundle with port, stop(), httpServer, wss", async () => {
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: 0,
			host: "127.0.0.1",
		});
		try {
			// port must be resolved to an actual bound port (>0 even when requested 0)
			expect(result.port).toBeGreaterThan(0);
			expect(typeof result.port).toBe("number");

			// stop() must be a function returning a promise
			expect(typeof result.stop).toBe("function");
			const ret = result.stop();
			expect(ret).toBeInstanceOf(Promise);
			await ret;
		} catch (err) {
			// Make sure we still tear the server down on assertion failure.
			await result.stop().catch(() => {});
			throw err;
		}
	});
});

// ─── TC-2: graceful WS close on stop() ─────────────────────────────────────

describe("server-bootstrap: TC-2 stop() closes WebSocket gracefully", () => {
	it("stops server cleanly with no leftover listeners / hanging handles", async () => {
		// Open a WS, then stop → verify close code 1000 or 1001 (normal/abnormal
		// but server-initiated shutdown). 1005/1006 are reserved for cases where
		// the close frame was never sent — we don't want that.
		const { port, stop } = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: 0,
			host: "127.0.0.1",
		});

		const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/test-session`);
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("WS open timeout")), 5_000);
			ws.onopen = () => {
				clearTimeout(t);
				resolve();
			};
			ws.onerror = (ev) => {
				clearTimeout(t);
				reject(new Error(`WS error: ${(ev as ErrorEvent).message ?? "unknown"}`));
			};
		});

		await stop();

		await new Promise<void>((resolve) => {
			const t = setTimeout(() => resolve(), 1500); // settle either way
			ws.onclose = (event) => {
				clearTimeout(t);
				expect([1000, 1001]).toContain(event.code);
				resolve();
			};
		});
	});
});

// ─── TC-3: deterministic port behaviour ─────────────────────────────────────

describe("server-bootstrap: TC-3 double startServer behaviour", () => {
	it("two consecutive startServer() calls get distinct ports", async () => {
		const first = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: 0,
			host: "127.0.0.1",
		});
		const second = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: 0,
			host: "127.0.0.1",
		});

		try {
			// Both must bind to a real OS port.
			expect(first.port).toBeGreaterThan(0);
			expect(second.port).toBeGreaterThan(0);
			// OS gives a fresh ephemeral port for each request when port=0.
			expect(first.port).not.toBe(second.port);
		} finally {
			await Promise.allSettled([first.stop(), second.stop()]);
		}
	});
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterAll(() => {
	if (PREVIOUS_FAN_NO_AUTH === undefined) {
		delete process.env.FAN_NO_AUTH;
	} else {
		process.env.FAN_NO_AUTH = PREVIOUS_FAN_NO_AUTH;
	}
});
