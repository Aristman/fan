/**
 * F-06: REST drain endpoint — Red-phase tests
 *
 * Feature: POST /api/sessions/:id/drain
 * Source: docs/features/super-orchestrator/mission-loop-0/roadmap.md (F-06)
 *
 * TC coverage:
 *   - TC-F06-1  Drain устанавливает флаг и возвращает 202 (status: "draining")
 *   - TC-F06-2  Drain без авторизации отклонён (401)
 *   - Idempotency: повторный drain возвращает 202 без ошибки
 *   - Edge:     drain при отсутствии активной генерации (не 500, осмысленный 2xx/4xx)
 *   - Error:    drain несуществующей сессии (404)
 *   - Semantic: drain НЕ вызывает abortSession (мягкая остановка vs hard-abort)
 *
 * Red expectation: endpoint does not exist yet (returns 404 from global notFound);
 * drainSession on SessionAdapter is never called. All assertions below should FAIL.
 *
 * Spec note: F-06 says "устанавливает флаг drainAfterCurrentTurn (F-05)" and
 * "Endpoint тонкий, делегирует F-05". At the API layer we only assert on
 * drainSession(id) being called — the flag semantics are tested in F-05 unit
 * tests for agent-session.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to create stable mock references that persist across getPrismaClient() calls.
// IMPORTANT: vi.mock factories are hoisted to top of file, so any variable referenced
// inside vi.mock() MUST be hoisted via vi.hoisted() too.
const { mockClientToken, mockRandomBytes } = vi.hoisted(() => ({
	mockClientToken: {
		create: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		delete: vi.fn(),
	},
	mockRandomBytes: vi.fn().mockReturnValue({
		toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
	}),
}));

const mockModelManager = {
	getAllModelSettings: vi.fn().mockResolvedValue([]),
	setModelSetting: vi.fn().mockResolvedValue(undefined),
	getModelSetting: vi.fn().mockReturnValue(null),
	getBudgetStatus: vi.fn().mockResolvedValue([]),
	configureBudget: vi.fn().mockResolvedValue(undefined),
	getRoutingRules: vi.fn().mockResolvedValue([]),
};

const mockSessionAdapter = {
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
	// F-01: abort action — must NOT be called by drain endpoint (semantic difference)
	abortSession: vi.fn(),
	// F-06: drain action on the adapter (will be called by the endpoint once implemented)
	drainSession: vi.fn(),
};

vi.mock("@fan/model-manager", () => ({
	ModelManager: vi.fn(),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: mockClientToken,
	}),
}));

// Mock node:crypto for token generation paths
vi.mock("node:crypto", () => ({
	randomBytes: mockRandomBytes,
}));

// Default: bypass token auth for the happy-path/edge tests.
// TC-F06-2 toggles this off to verify auth enforcement.
process.env.FAN_NO_AUTH = "1";

import type { ModelManager } from "@fan/model-manager";
import { createApp } from "../http-server.js";

/** Type helper — Hono's Response.json() returns unknown in test types */
function json<T>(res: Response): Promise<T> {
	return res.json() as Promise<T>;
}

type App = Awaited<ReturnType<typeof createApp>>;

describe("F-06: REST drain endpoint (POST /api/sessions/:id/drain)", () => {
	let app: App;

	beforeEach(async () => {
		vi.clearAllMocks();
		// Restore default mock return values after clearAllMocks
		mockModelManager.getAllModelSettings.mockResolvedValue([]);
		mockModelManager.getBudgetStatus.mockResolvedValue([]);
		mockModelManager.getRoutingRules.mockResolvedValue([]);
		mockModelManager.getModelSetting.mockReturnValue(null);
		mockSessionAdapter.listSessions.mockResolvedValue([]);
		mockSessionAdapter.getSession.mockResolvedValue(null);
		mockSessionAdapter.createSession.mockResolvedValue({ id: "s1", title: "Test" });
		mockSessionAdapter.deleteSession.mockResolvedValue(false);
		mockSessionAdapter.sendMessage.mockResolvedValue(true);
		mockSessionAdapter.getAvailableModels.mockResolvedValue([]);
		mockSessionAdapter.whenReady.mockResolvedValue(undefined);
		mockSessionAdapter.listAnalyticsReports.mockResolvedValue([]);
		mockSessionAdapter.readAnalyticsReport.mockResolvedValue(null);
		mockSessionAdapter.abortSession.mockResolvedValue(true);
		mockSessionAdapter.drainSession.mockResolvedValue(true);
		mockRandomBytes.mockReturnValue({
			toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
		});

		app = await createApp(
			mockModelManager as unknown as ModelManager,
			mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
		);
	});

	// =========================================================================
	// TC-F06-1: Drain устанавливает флаг и возвращает 202
	// =========================================================================
	describe("TC-F06-1: Drain устанавливает флаг и возвращает 202", () => {
		it("should return 202 with { status: 'draining' }", async () => {
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			const res = await app.request("/api/sessions/s1/drain", { method: "POST" });
			// Red: endpoint doesn't exist → 404 from global notFound → assertion fails
			expect(res.status).toBe(202);
			const data = await json<{ status: string }>(res);
			expect(data.status).toBe("draining");
		});

		it("should call drainSession on the session adapter with the session id", async () => {
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			await app.request("/api/sessions/s1/drain", { method: "POST" });
			// Red: endpoint doesn't call drainSession → assertion fails
			expect(mockSessionAdapter.drainSession).toHaveBeenCalled();
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("s1");
		});

		it("should respond in under 1 second (drain flag is set synchronously, NFR §5.1)", async () => {
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			const start = Date.now();
			const res = await app.request("/api/sessions/s1/drain", { method: "POST" });
			const elapsed = Date.now() - start;
			// Status check + timing together — Red because status check fails
			expect(res.status).toBe(202);
			expect(elapsed).toBeLessThan(1000);
		});

		it("should accept POST without body (no body required for drain)", async () => {
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			const res = await app.request("/api/sessions/active-iter/drain", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			expect(res.status).toBe(202);
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("active-iter");
		});

		it("should NOT call abortSession (drain is graceful, not a hard abort)", async () => {
			// F-06 AC: drain ≠ abort. Drain lets the current turn finish, then pauses.
			// Abort kills the generation immediately. The endpoint must route to
			// drainSession only — abortSession stays untouched.
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			await app.request("/api/sessions/s1/drain", { method: "POST" });
			// Red: endpoint doesn't exist, so neither method is called today.
			// After implementation, drainSession must be called and abortSession must NOT.
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("s1");
			expect(mockSessionAdapter.abortSession).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// TC-F06-2: Drain без авторизации отклонён (401) — covered positively
	//
	// The contract "drain requires ClientToken authentication" is verified in two
	// directions within a SINGLE test below:
	//   (a) WITHOUT a valid token → response must NOT reach the drain handler
	//       (drainSession never called for that request)
	//   (b) WITH a valid token   → response must reach the drain handler
	//       (drainSession called with the session id)
	//
	// Pure negative variants ("no auth → 401") cannot be Red tests because the
	// global tokenAuth middleware already blocks all /api/* requests — they pass
	// before implementation for an unrelated reason. The positive assertion (b)
	// is what makes this a real Red test: it fails until /api/sessions/:id/drain
	// is implemented (returns 404 today, 202 after implementation).
	// =========================================================================
	describe("TC-F06-2: Drain requires ClientToken authentication", () => {
		it("with valid ClientToken drain is reachable; without it the handler is not invoked", async () => {
			const prevAuth = process.env.FAN_NO_AUTH;
			process.env.FAN_NO_AUTH = "0";
			try {
				// (b) Setup a valid token validation. auth.ts → validateToken → clientToken.update
				mockClientToken.update.mockResolvedValueOnce({
					id: "t1",
					name: "Test",
					token: "valid-token",
					createdAt: new Date("2026-01-01"),
					lastUsed: null,
				});

				const authedApp = await createApp(
					mockModelManager as unknown as ModelManager,
					mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
				);

				// (b) With valid ClientToken → drain must succeed.
				// Red: 404 (route missing) → assertion fails (expecting 202)
				const authedRes = await authedApp.request("/api/sessions/s1/drain", {
					method: "POST",
					headers: { Authorization: "Bearer valid-token" },
				});
				expect(authedRes.status).toBe(202);
				expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("s1");

				// (a) Without Authorization header → blocked, handler never reached.
				mockSessionAdapter.drainSession.mockClear();
				const noAuthRes = await authedApp.request("/api/sessions/s2/drain", { method: "POST" });
				expect(noAuthRes.status).toBe(401);
				expect(mockSessionAdapter.drainSession).not.toHaveBeenCalled();
			} finally {
				process.env.FAN_NO_AUTH = prevAuth;
			}
		});
	});

	// =========================================================================
	// Idempotency: повторный drain → 202 без ошибки
	// F-05: setDrainAfterCurrentTurn(true) is idempotent — второй вызов no-op.
	// Адаптер по-прежнему вызывается (делегирование проверки идемпотентности — F-05),
	// но endpoint не должен кидать ошибку.
	// =========================================================================
	describe("Idempotency: повторный drain", () => {
		it("should return 202 on a repeated call without throwing", async () => {
			// Both calls return true — simulating "already draining" / no-op idempotent semantics
			mockSessionAdapter.drainSession.mockResolvedValue(true);
			const res1 = await app.request("/api/sessions/s1/drain", { method: "POST" });
			const res2 = await app.request("/api/sessions/s1/drain", { method: "POST" });
			// Red: no route → 404 → assertion fails
			expect(res1.status).toBe(202);
			expect(res2.status).toBe(202);
			const data1 = await json<{ status: string }>(res1);
			const data2 = await json<{ status: string }>(res2);
			expect(data1.status).toBe("draining");
			expect(data2.status).toBe("draining");
		});

		it("should call drainSession twice (idempotent — adapter invoked on every call)", async () => {
			mockSessionAdapter.drainSession.mockResolvedValue(true);
			await app.request("/api/sessions/s1/drain", { method: "POST" });
			await app.request("/api/sessions/s1/drain", { method: "POST" });
			// Red: not invoked at all → assertion fails
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledTimes(2);
		});
	});

	// =========================================================================
	// Edge: drain при отсутствии активной генерации
	// =========================================================================
	describe("Edge: drain при отсутствии активной генерации", () => {
		it("should return an interpretable status code (not 500)", async () => {
			// Session exists, drain is a no-op (already idle or already drained) — adapter returns true
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			const res = await app.request("/api/sessions/idle-session/drain", { method: "POST" });
			// Red: 404 → assertion fails (the test expects not-500)
			expect(res.status).not.toBe(500);
			// Spec says drain endpoint returns 202; allow 200/409 as interpretable fallbacks
			expect([200, 202, 409]).toContain(res.status);
		});

		it("should still invoke drainSession on adapter when session is idle (drain is idempotent)", async () => {
			// F-05: setDrainAfterCurrentTurn(true) on idle session — skip "draining" phase,
			// go straight to "drained" (drain_started + drain_completed emitted synchronously).
			// Endpoint must still delegate to the adapter so the flag is set / state updated.
			mockSessionAdapter.drainSession.mockResolvedValueOnce(true);
			await app.request("/api/sessions/idle-session/drain", { method: "POST" });
			// Red: not invoked → assertion fails
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("idle-session");
		});
	});

	// =========================================================================
	// Error: drain несуществующей сессии → 404
	// =========================================================================
	describe("Error: drain несуществующей сессии", () => {
		it("should return 404 when session does not exist", async () => {
			// adapter signals "session not found" via false
			mockSessionAdapter.drainSession.mockResolvedValueOnce(false);
			const res = await app.request("/api/sessions/does-not-exist/drain", { method: "POST" });
			// Red: 404 from notFound still matches BUT for the wrong reason;
			// assertion on drainSession being called is what truly validates behaviour
			expect(res.status).toBe(404);
			// Adapter must have been consulted to determine non-existence
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("does-not-exist");
		});

		it("should not return 500 on missing session", async () => {
			mockSessionAdapter.drainSession.mockResolvedValueOnce(false);
			const res = await app.request("/api/sessions/missing-12345/drain", { method: "POST" });
			expect(res.status).not.toBe(500);
			expect(res.status).toBe(404);
			// Red signal: adapter must be consulted to distinguish "missing" from "auth-failed"
			// — currently fails because endpoint doesn't exist (drainSession never called)
			expect(mockSessionAdapter.drainSession).toHaveBeenCalledWith("missing-12345");
		});
	});
});
