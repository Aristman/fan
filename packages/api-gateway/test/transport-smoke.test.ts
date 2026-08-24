/**
 * Transport Smoke Tests — F-0 (TDD Red phase)
 *
 * SPEC: docs/features/super-orchestrator-v2/architecture.md §13 Transport pre-requisite
 * Roadmap: docs/features/super-orchestrator-v2/roadmap.md — Этап 0
 *
 * These tests verify the transport layer under Bun runtime:
 *   TC-F0-1: Health endpoint returns JSON (not Bun fallback HTML)
 *   TC-F0-2: WebSocket upgrade works on /api/ws
 *   TC-F0-3: Webhook port is configurable + dashboard endpoints survive webhook import
 *
 * Run: bun test packages/api-gateway/test/transport-smoke.test.ts
 *
 * Expected Red-phase results:
 *   TC-F0-1: PASS (health JSON works via Hono app.fetch in isolation)
 *   TC-F0-2: FAIL (Bun branch has no websocket config → 404 instead of 101)
 *   TC-F0-3: FAIL (importing @hono/node-server via webhook breaks Bun.serve()
 *            fetch handler → "Welcome to Bun!" fallback for subsequent requests)
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ModelManager } from "@fan/model-manager";
import type { SessionAdapter } from "../src/http-server.js";
import { startServer } from "../src/http-server.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get a pseudo-random high port to avoid conflicts with parallel test runs. */
function getTestPort(base: number): number {
	return base + Math.floor(Math.random() * 100);
}

/** Minimal ModelManager stub — enough for server startup + health endpoint. */
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

/** Minimal SessionAdapter stub — enough for server startup + health endpoint. */
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

// ─── Environment ────────────────────────────────────────────────────────────

// Disable auth for smoke tests (no DB/Prisma needed for transport checks)
const PREVIOUS_FAN_NO_AUTH = process.env.FAN_NO_AUTH;

// ─── TC-F0-1: Health JSON under Bun runtime ────────────────────────────────

describe("TC-F0-1: Transport smoke — health JSON", () => {
	const PORT = getTestPort(18100);
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualPort: number;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: PORT,
			host: HOST,
		});
		actualPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		await stop();
		process.env.FAN_NO_AUTH = PREVIOUS_FAN_NO_AUTH;
	});

	it("should return status 200", async () => {
		const res = await fetch(`http://${HOST}:${actualPort}/api/health`);
		expect(res.status).toBe(200);
	});

	it("should return content-type application/json (NOT text/html Bun fallback)", async () => {
		const res = await fetch(`http://${HOST}:${actualPort}/api/health`);
		const contentType = res.headers.get("content-type") ?? "";
		expect(contentType).toContain("application/json");
		// Explicit negative: must NOT be HTML fallback
		expect(contentType).not.toContain("text/html");
	});

	it("should return JSON body with status:'ok', version, uptime", async () => {
		const res = await fetch(`http://${HOST}:${actualPort}/api/health`);
		const body = await res.json();

		// Must NOT be the Bun default page
		expect(typeof body).toBe("object");
		expect(body).not.toBeNull();

		// Required fields per HealthResponse type
		expect(body.status).toBe("ok");
		expect(body).toHaveProperty("version");
		expect(body).toHaveProperty("uptime");
		expect(typeof body.uptime).toBe("number");
	});

	it("should NOT return 'Welcome to Bun!' HTML fallback", async () => {
		const res = await fetch(`http://${HOST}:${actualPort}/api/health`);
		const text = await res.text();
		expect(text).not.toContain("Welcome to Bun");
		expect(text).not.toContain("<!DOCTYPE");
	});
});

// ─── TC-F0-2: WebSocket upgrade on /api/ws under Bun runtime ───────────────

describe("TC-F0-2: WebSocket upgrade on /api/ws", () => {
	const PORT = getTestPort(18200);
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualPort: number;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: PORT,
			host: HOST,
		});
		actualPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		await stop();
		process.env.FAN_NO_AUTH = PREVIOUS_FAN_NO_AUTH;
	});

	it("should accept WebSocket upgrade on /api/ws/<sessionId>", async () => {
		const wsUrl = `ws://${HOST}:${actualPort}/api/ws/smoke-test-session`;

		const openPromise = new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timed out after 10s — upgrade not supported"));
			}, 10_000);

			ws.onopen = () => {
				clearTimeout(timeout);
				resolve();
				ws.close();
			};
			ws.onerror = (_ev: Event) => {
				clearTimeout(timeout);
				reject(
					new Error(
						"WebSocket error during upgrade — Bun branch has no websocket config in Bun.serve(), " +
							"request falls through to Hono 404 instead of HTTP 101 upgrade",
					),
				);
			};
		});

		// This should resolve if WS upgrade works, reject if it doesn't
		await expect(openPromise).resolves.toBeUndefined();
	}, 15_000);

	it("should support send+receive on WebSocket", async () => {
		const wsUrl = `ws://${HOST}:${actualPort}/api/ws/smoke-test-session`;

		const echoPromise = new Promise<string>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket send+receive timed out after 10s"));
			}, 10_000);

			ws.onopen = () => {
				// Send a subscribe message (matches WsIncomingMessage schema)
				ws.send(JSON.stringify({ type: "subscribe", sessionId: "smoke-test-session" }));
			};
			ws.onmessage = (ev: MessageEvent) => {
				clearTimeout(timeout);
				resolve(String(ev.data));
				ws.close();
			};
			ws.onerror = () => {
				clearTimeout(timeout);
				reject(new Error("WebSocket error during send+receive — no WS handler in Bun branch"));
			};
		});

		await expect(echoPromise).resolves.toBeDefined();
	}, 15_000);

	it("should close WebSocket gracefully (code 1000)", async () => {
		const wsUrl = `ws://${HOST}:${actualPort}/api/ws/smoke-test-session`;

		const closePromise = new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			const timeout = setTimeout(() => {
				reject(new Error("WebSocket graceful close timed out after 10s"));
			}, 10_000);

			ws.onopen = () => {
				ws.close(1000, "smoke test done");
			};
			ws.onclose = (ev: CloseEvent) => {
				clearTimeout(timeout);
				// 1000 = normal closure. Currently gets 1002 (protocol error)
				// because server returns 404 instead of 101 upgrade.
				expect(ev.code).toBe(1000);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timeout);
				reject(new Error("WebSocket error during graceful close — no WS handler in Bun branch"));
			};
		});

		await expect(closePromise).resolves.toBeUndefined();
	}, 15_000);
});

// ─── TC-F0-3: Webhook port fix + dashboard regression ──────────────────────
//
// KEY INSIGHT (Red): Importing the webhook extension (which imports
// @hono/node-server) while Bun.serve() is running breaks the fetch handler.
// Subsequent HTTP requests return "Welcome to Bun!" instead of Hono responses.
// This is the core transport bug F-0 must fix by removing the Bun-branch
// and always using @hono/node-server.

describe("TC-F0-3: Webhook port fix + dashboard regression", () => {
	const API_PORT = getTestPort(18300);
	const WEBHOOK_PORT = getTestPort(19095); // Explicitly NOT 9090
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualApiPort: number;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: API_PORT,
			host: HOST,
		});
		actualApiPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		await stop();
		process.env.FAN_NO_AUTH = PREVIOUS_FAN_NO_AUTH;
	});

	it("(a) webhook should listen on explicit port (not hardcoded 9090)", async () => {
		const { startWebhookServer } = await import("../../../extensions/fan-webhook/webhook-server.js");

		const handle = await startWebhookServer({
			actions: {
				sendMessage: async () => {},
			},
			port: WEBHOOK_PORT,
		});

		try {
			// Verify the handle reports the correct port
			expect(handle.port).toBe(WEBHOOK_PORT);

			// Verify the webhook health endpoint responds on that port
			const res = await fetch(`http://${HOST}:${WEBHOOK_PORT}/health`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.status).toBe("ok");
		} finally {
			await handle.stop();
		}
	});

	it("(b) GET /api/sessions should return 200 + JSON after webhook module loaded", async () => {
		// NOTE: By this point, the webhook module (and @hono/node-server) have
		// been imported by test (a). Under Bun runtime with Bun.serve(), this
		// breaks the fetch handler → returns "Welcome to Bun!" instead of JSON.
		const res = await fetch(`http://${HOST}:${actualApiPort}/api/sessions`);
		expect(res.status).toBe(200);

		// Check body is NOT the Bun fallback
		const text = await res.text();
		expect(text).not.toContain("Welcome to Bun");

		// Parse as JSON and verify structure
		const body = JSON.parse(text);
		expect(body).toHaveProperty("sessions");
		expect(Array.isArray(body.sessions)).toBe(true);
	});

	it("(c) GET /api/models should return 200 + JSON after webhook module loaded", async () => {
		const res = await fetch(`http://${HOST}:${actualApiPort}/api/models`);
		expect(res.status).toBe(200);

		// Check body is NOT the Bun fallback
		const text = await res.text();
		expect(text).not.toContain("Welcome to Bun");

		// Parse as JSON and verify structure
		const body = JSON.parse(text);
		expect(body).toHaveProperty("models");
		expect(body).toHaveProperty("routingRules");
	});
});
