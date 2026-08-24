/**
 * Mission Delegate Endpoint Tests — F-3 (TDD Red phase)
 *
 * SPEC: docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md §F-3
 * Roadmap: docs/features/recursive-orchestrator-spawn/roadmap.md — Этап 3
 *
 * Tests for POST /api/mission-delegate — HTTP delegation endpoint for
 * recursive super-orchestrator spawn. The endpoint:
 *   - Authenticates via FAN_NODE_TOKEN env var (NOT DB-based tokenAuth)
 *   - Validates payload schema (parentReportId, packages required)
 *   - Emits "mission_delegate" event via api.events
 *   - Returns 200 { status: "queued", parentReportId }
 *
 * Expected Red-phase results (all 4 FAIL):
 *   TC-F3-1: FAIL — endpoint not registered → 404
 *   TC-F3-2: FAIL — endpoint not registered → 404 (not 401)
 *   TC-F3-3: FAIL — endpoint not registered → 404 (not 401)
 *   TC-F3-4: FAIL — endpoint not registered → 404 (not 400)
 *
 * Run: npx vitest run test/mission-delegate-endpoint.test.ts
 */

import type { EventEmitter } from "node:events";
import type { ModelManager } from "@fan/model-manager";
import type { SessionAdapter } from "../src/http-server.js";
import { apiEvents, startServer } from "../src/http-server.js";

// ─── Environment ────────────────────────────────────────────────────────────

const PREVIOUS_FAN_NO_AUTH = process.env.FAN_NO_AUTH;
const PREVIOUS_FAN_NODE_TOKEN = process.env.FAN_NODE_TOKEN;

// Disable DB-based auth (no Prisma needed for these tests)
process.env.FAN_NO_AUTH = "1";
// Set the node token for delegation auth
process.env.FAN_NODE_TOKEN = "test-token";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/** Minimal ModelManager stub — enough for server startup. */
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

/** Minimal SessionAdapter stub — enough for server startup. */
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get a pseudo-random high port to avoid conflicts with parallel test runs. */
function getTestPort(base: number): number {
	return base + Math.floor(Math.random() * 100);
}

// ─── TC-F3-1: Endpoint accepts delegation with valid token ──────────────────

describe("TC-F3-1: POST /api/mission-delegate — valid token", () => {
	const PORT = getTestPort(18400);
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualPort: number;
	let eventBus: EventEmitter;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		process.env.FAN_NODE_TOKEN = "test-token";
		eventBus = apiEvents;
		// Clean any listeners left over from previous tests in the same process
		eventBus.removeAllListeners("mission_delegate");
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: PORT,
			host: HOST,
		});
		actualPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		eventBus.removeAllListeners("mission_delegate");
		await stop();
	});

	it("should return 200 with { status: 'queued', parentReportId } for valid delegation", async () => {
		const payload = {
			parentReportId: "rep-1",
			parentCorrelationId: "corr-1",
			role: "super-orchestrator",
			role_profile: "pm",
			depth: 1,
			packages: [{ id: "pkg-1", type: "epic", title: "Test Epic" }],
			lineage: ["parent-node"],
		};

		const res = await fetch(`http://${HOST}:${actualPort}/api/mission-delegate`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(payload),
		});

		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body).toHaveProperty("status", "queued");
		expect(body).toHaveProperty("parentReportId", "rep-1");
	});

	it("should emit 'mission_delegate' event with the payload", async () => {
		// Set up listener before sending request
		const eventPromise = new Promise<Record<string, unknown>>((resolve) => {
			eventBus.once("mission_delegate", (data: Record<string, unknown>) => {
				resolve(data);
			});
		});

		const payload = {
			parentReportId: "rep-2",
			packages: [{ id: "pkg-2", type: "task", title: "Test Task" }],
		};

		const res = await fetch(`http://${HOST}:${actualPort}/api/mission-delegate`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(payload),
		});

		// Endpoint must exist first
		expect(res.status).toBe(200);

		// The implementation should emit the event on api.events (or equivalent).
		// For now, we verify the event was received (implementation wires eventBus).
		// In Red phase this will timeout/fail because no event is emitted.
		const emittedData = await Promise.race([
			eventPromise,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("mission_delegate event was not emitted within 2s")), 2000),
			),
		]);

		expect(emittedData).toHaveProperty("parentReportId", "rep-2");
		expect(emittedData).toHaveProperty("packages");
		expect(Array.isArray(emittedData.packages)).toBe(true);
	});
});

// ─── TC-F3-2: Endpoint rejects request without token ────────────────────────

describe("TC-F3-2: POST /api/mission-delegate — missing token", () => {
	const PORT = getTestPort(18500);
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualPort: number;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		process.env.FAN_NODE_TOKEN = "test-token";
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: PORT,
			host: HOST,
		});
		actualPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		await stop();
	});

	it("should return 401 with { error: 'missing_token' } when no Authorization header", async () => {
		const payload = {
			parentReportId: "rep-1",
			packages: [{ id: "pkg-1", type: "epic", title: "Test" }],
		};

		const res = await fetch(`http://${HOST}:${actualPort}/api/mission-delegate`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// No Authorization header
			},
			body: JSON.stringify(payload),
		});

		expect(res.status).toBe(401);

		const body = await res.json();
		expect(body).toHaveProperty("error", "missing_token");
	});
});

// ─── TC-F3-3: Endpoint rejects invalid token ────────────────────────────────

describe("TC-F3-3: POST /api/mission-delegate — invalid token", () => {
	const PORT = getTestPort(18600);
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualPort: number;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		process.env.FAN_NODE_TOKEN = "test-token";
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: PORT,
			host: HOST,
		});
		actualPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		await stop();
	});

	it("should return 401 with { error: 'invalid_token' } for wrong token", async () => {
		const payload = {
			parentReportId: "rep-1",
			packages: [{ id: "pkg-1", type: "epic", title: "Test" }],
		};

		const res = await fetch(`http://${HOST}:${actualPort}/api/mission-delegate`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify(payload),
		});

		expect(res.status).toBe(401);

		const body = await res.json();
		expect(body).toHaveProperty("error", "invalid_token");
	});
});

// ─── TC-F3-4: Endpoint validates payload schema ─────────────────────────────

describe("TC-F3-4: POST /api/mission-delegate — invalid payload", () => {
	const PORT = getTestPort(18700);
	const HOST = "127.0.0.1";
	let stop: () => Promise<void>;
	let actualPort: number;

	beforeAll(async () => {
		process.env.FAN_NO_AUTH = "1";
		process.env.FAN_NODE_TOKEN = "test-token";
		const result = await startServer(createMockModelManager(), createMockSessionAdapter(), {
			port: PORT,
			host: HOST,
		});
		actualPort = result.port;
		stop = result.stop;
	});

	afterAll(async () => {
		await stop();
	});

	it("should return 400 with { error: 'invalid_payload', field: 'packages' } when packages is not an array", async () => {
		const payload = {
			parentReportId: "valid",
			packages: "not-array", // Should be an array
		};

		const res = await fetch(`http://${HOST}:${actualPort}/api/mission-delegate`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer test-token",
			},
			body: JSON.stringify(payload),
		});

		expect(res.status).toBe(400);

		const body = await res.json();
		expect(body).toHaveProperty("error", "invalid_payload");
		expect(body).toHaveProperty("field", "packages");
	});
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

afterAll(() => {
	if (PREVIOUS_FAN_NO_AUTH === undefined) {
		delete process.env.FAN_NO_AUTH;
	} else {
		process.env.FAN_NO_AUTH = PREVIOUS_FAN_NO_AUTH;
	}
	if (PREVIOUS_FAN_NODE_TOKEN === undefined) {
		delete process.env.FAN_NODE_TOKEN;
	} else {
		process.env.FAN_NODE_TOKEN = PREVIOUS_FAN_NODE_TOKEN;
	}
});
