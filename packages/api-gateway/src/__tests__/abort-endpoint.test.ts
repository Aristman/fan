/**
 * F-01: REST abort endpoint — Red-phase tests
 *
 * Feature: POST /api/sessions/:id/abort
 * Source: docs/features/super-orchestrator/mission-loop-0/roadmap.md (F-01)
 *         docs/specs/spec_super-orchestrator_v3_2026-08-10.md §6.1, §6.2
 *
 * TC coverage:
 *   - TC-F01-1  Abort останавливает активную генерацию (202 + { status: "aborted" } + <1 сек)
 *   - TC-F01-2  Abort без авторизации отклонён (401)
 *   - TC-F01-3  Повторный abort идемпотентен (202 без ошибки)
 *   - Edge:     abort при отсутствии активной генерации (не 500, осмысленный 2xx/4xx)
 *   - Error:    abort несуществующей сессии (404)
 *
 * Red expectation: endpoint does not exist yet (returns 404 from global notFound);
 * abortSession on SessionAdapter is never called. All assertions below should FAIL.
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
	// F-01: abort action on the adapter (will be called by the endpoint once implemented)
	abortSession: vi.fn(),
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
// TC-F01-2 toggles this off to verify auth enforcement.
process.env.FAN_NO_AUTH = "1";

import type { ModelManager } from "@fan/model-manager";
import { createApp } from "../http-server.js";

/** Type helper — Hono's Response.json() returns unknown in test types */
function json<T>(res: Response): Promise<T> {
	return res.json() as Promise<T>;
}

type App = Awaited<ReturnType<typeof createApp>>;

describe("F-01: REST abort endpoint (POST /api/sessions/:id/abort)", () => {
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
		mockRandomBytes.mockReturnValue({
			toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
		});

		app = await createApp(
			mockModelManager as unknown as ModelManager,
			mockSessionAdapter as unknown as Parameters<typeof createApp>[1],
		);
	});

	// =========================================================================
	// TC-F01-1: Abort останавливает активную генерацию
	// =========================================================================
	describe("TC-F01-1: Abort останавливает активную генерацию", () => {
		it("should return 202 with { status: 'aborted' }", async () => {
			mockSessionAdapter.abortSession.mockResolvedValueOnce(true);
			const res = await app.request("/api/sessions/s1/abort", { method: "POST" });
			// Red: endpoint doesn't exist → 404 from global notFound → assertion fails
			expect(res.status).toBe(202);
			const data = await json<{ status: string }>(res);
			expect(data.status).toBe("aborted");
		});

		it("should call abortSession on the session adapter with the session id", async () => {
			mockSessionAdapter.abortSession.mockResolvedValueOnce(true);
			await app.request("/api/sessions/s1/abort", { method: "POST" });
			// Red: endpoint doesn't call abortSession → assertion fails
			expect(mockSessionAdapter.abortSession).toHaveBeenCalled();
			expect(mockSessionAdapter.abortSession).toHaveBeenCalledWith("s1");
		});

		it("should respond in under 1 second (Abort < 1 сек, NFR §5.1)", async () => {
			mockSessionAdapter.abortSession.mockResolvedValueOnce(true);
			const start = Date.now();
			const res = await app.request("/api/sessions/s1/abort", { method: "POST" });
			const elapsed = Date.now() - start;
			// Status check + timing together — Red because status check fails
			expect(res.status).toBe(202);
			expect(elapsed).toBeLessThan(1000);
		});

		it("should accept POST without body (no body required for abort)", async () => {
			mockSessionAdapter.abortSession.mockResolvedValueOnce(true);
			const res = await app.request("/api/sessions/active-iter/abort", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			expect(res.status).toBe(202);
			expect(mockSessionAdapter.abortSession).toHaveBeenCalledWith("active-iter");
		});
	});

	// =========================================================================
	// TC-F01-2: Abort без авторизации отклонён (401) — covered positively
	//
	// The contract "abort requires ClientToken authentication" is verified in two
	// directions within a SINGLE test below:
	//   (a) WITHOUT a valid token → response must NOT reach the abort handler
	//       (abortSession never called for that request)
	//   (b) WITH a valid token   → response must reach the abort handler
	//       (abortSession called with the session id)
	//
	// Pure negative variants ("no auth → 401") cannot be Red tests because the
	// global tokenAuth middleware already blocks all /api/* requests — they pass
	// before implementation for an unrelated reason. The positive assertion (b)
	// is what makes this a real Red test: it fails until /api/sessions/:id/abort
	// is implemented (returns 404 today, 202 after implementation).
	// =========================================================================
	describe("TC-F01-2: Abort requires ClientToken authentication", () => {
		it("with valid ClientToken abort is reachable and aborts; without it the handler is not invoked", async () => {
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

				// (b) With valid ClientToken → abort must succeed.
				// Red: 404 (route missing) → assertion fails (expecting 202)
				const authedRes = await authedApp.request("/api/sessions/s1/abort", {
					method: "POST",
					headers: { Authorization: "Bearer valid-token" },
				});
				expect(authedRes.status).toBe(202);
				expect(mockSessionAdapter.abortSession).toHaveBeenCalledWith("s1");

				// (a) Without Authorization header → blocked, handler never reached.
				mockSessionAdapter.abortSession.mockClear();
				const noAuthRes = await authedApp.request("/api/sessions/s2/abort", { method: "POST" });
				expect(noAuthRes.status).toBe(401);
				expect(mockSessionAdapter.abortSession).not.toHaveBeenCalled();
			} finally {
				process.env.FAN_NO_AUTH = prevAuth;
			}
		});
	});

	// =========================================================================
	// TC-F01-3: Повторный abort идемпотентен
	// =========================================================================
	describe("TC-F01-3: Повторный abort идемпотентен", () => {
		it("should return 202 on a repeated call without throwing", async () => {
			// Both calls return true — simulating "already aborted" / no-op idempotent semantics
			mockSessionAdapter.abortSession.mockResolvedValue(true);
			const res1 = await app.request("/api/sessions/s1/abort", { method: "POST" });
			const res2 = await app.request("/api/sessions/s1/abort", { method: "POST" });
			// Red: no route → 404 → assertion fails
			expect(res1.status).toBe(202);
			expect(res2.status).toBe(202);
			const data1 = await json<{ status: string }>(res1);
			const data2 = await json<{ status: string }>(res2);
			expect(data1.status).toBe("aborted");
			expect(data2.status).toBe("aborted");
		});

		it("should call abortSession twice (idempotent — adapter invoked on every call)", async () => {
			mockSessionAdapter.abortSession.mockResolvedValue(true);
			await app.request("/api/sessions/s1/abort", { method: "POST" });
			await app.request("/api/sessions/s1/abort", { method: "POST" });
			// Red: not invoked at all → assertion fails
			expect(mockSessionAdapter.abortSession).toHaveBeenCalledTimes(2);
		});
	});

	// =========================================================================
	// Edge case: abort при отсутствии активной генерации
	// =========================================================================
	describe("Edge: abort при отсутствии активной генерации", () => {
		it("should return an interpretable status code (not 500)", async () => {
			// Session exists, abort is a no-op (already stopped) — adapter returns true (idempotent)
			mockSessionAdapter.abortSession.mockResolvedValueOnce(true);
			const res = await app.request("/api/sessions/idle-session/abort", { method: "POST" });
			// Red: 404 → assertion fails (the test expects not-500)
			expect(res.status).not.toBe(500);
			// Spec says abort endpoint returns 202; allow 200/409 as interpretable fallbacks
			expect([200, 202, 409]).toContain(res.status);
		});

		it("should still clear queues / invoke abortSession on adapter when generation is idle", async () => {
			// Spec §3.2.4: "При abort (I0): очереди очищаются с записью в журнал миссии"
			mockSessionAdapter.abortSession.mockResolvedValueOnce(true);
			await app.request("/api/sessions/idle-session/abort", { method: "POST" });
			// Red: not invoked → assertion fails
			expect(mockSessionAdapter.abortSession).toHaveBeenCalledWith("idle-session");
		});
	});

	// =========================================================================
	// Error: abort несуществующей сессии → 404
	// =========================================================================
	describe("Error: abort несуществующей сессии", () => {
		it("should return 404 when session does not exist", async () => {
			// adapter signals "session not found" via false
			mockSessionAdapter.abortSession.mockResolvedValueOnce(false);
			const res = await app.request("/api/sessions/does-not-exist/abort", { method: "POST" });
			// Red: 404 from notFound still matches BUT for the wrong reason;
			// assertion on abortSession being called is what truly validates behaviour
			expect(res.status).toBe(404);
			// Adapter must have been consulted to determine non-existence
			expect(mockSessionAdapter.abortSession).toHaveBeenCalledWith("does-not-exist");
		});

		it("should not return 500 on missing session", async () => {
			mockSessionAdapter.abortSession.mockResolvedValueOnce(false);
			const res = await app.request("/api/sessions/missing-12345/abort", { method: "POST" });
			expect(res.status).not.toBe(500);
			expect(res.status).toBe(404);
			// Red signal: adapter must be consulted to distinguish "missing" from "auth-failed"
			// — currently fails because endpoint doesn't exist (abortSession never called)
			expect(mockSessionAdapter.abortSession).toHaveBeenCalledWith("missing-12345");
		});
	});
});
