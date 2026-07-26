import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to create stable mock references that persist across getPrismaClient() calls
const { mockClientToken, mockQueryRawUnsafe } = vi.hoisted(() => ({
	mockClientToken: {
		create: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		delete: vi.fn(),
	},
	mockQueryRawUnsafe: vi.fn(),
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
	listProjects: vi.fn().mockResolvedValue([]),
	removeProject: vi.fn().mockResolvedValue(false),
	getActiveSessionId: vi.fn().mockReturnValue(null),
};

vi.mock("@fan/model-manager", () => ({
	ModelManager: vi.fn(),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: mockClientToken,
		$queryRawUnsafe: mockQueryRawUnsafe,
	}),
}));

// Set FAN_NO_AUTH to bypass token auth in tests
process.env.FAN_NO_AUTH = "1";

// Mock crypto.randomBytes for token generation in the HTTP handler's auth calls
const mockRandomBytes = vi.fn().mockReturnValue({
	toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
});
beforeAll(() => {
	Object.defineProperty(globalThis, "crypto", {
		value: { randomBytes: mockRandomBytes },
		writable: true,
		configurable: true,
	});
});

import type { ModelManager } from "@fan/model-manager";
import { createApp } from "../http-server.js";

/** Type helper — Hono's Response.json() returns unknown in test types */
function json<T>(res: Response): Promise<T> {
	return res.json() as Promise<T>;
}

describe("HTTP Server", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Restore default mock return values after clearAllMocks
		mockModelManager.getModelSetting.mockReturnValue(null);
		mockModelManager.getAllModelSettings.mockResolvedValue([]);
		mockModelManager.getRoutingRules.mockResolvedValue([]);
		mockModelManager.getBudgetStatus.mockResolvedValue([]);
		mockSessionAdapter.listSessions.mockResolvedValue([]);
		mockSessionAdapter.getSession.mockResolvedValue(null);
		mockSessionAdapter.createSession.mockResolvedValue({ id: "s1", title: "Test" });
		mockSessionAdapter.deleteSession.mockResolvedValue(false);
		mockSessionAdapter.sendMessage.mockResolvedValue(true);
		mockSessionAdapter.getAvailableModels.mockResolvedValue([]);
		mockSessionAdapter.listProjects.mockResolvedValue([]);
		mockSessionAdapter.removeProject.mockResolvedValue(false);
		mockSessionAdapter.getActiveSessionId.mockReturnValue(null);
		mockQueryRawUnsafe.mockResolvedValue([{ 1: 1 }]);
		mockRandomBytes.mockReturnValue({
			toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
		});
	});

	async function getApp() {
		return createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter);
	}

	describe("GET /api/health", () => {
		it("should return health status", async () => {
			const app = await getApp();
			const res = await app.request("/api/health");
			expect(res.status).toBe(200);
			const data = await json<{ status: string; version: string; uptime: number }>(res);
			expect(data.status).toBe("ok");
			expect(data).toHaveProperty("version");
			expect(data).toHaveProperty("uptime");
		});

		// TC-F-0.9-1: server up, DB reachable → 200 with readiness fields
		it("should return 200 with db:'up' and session info when DB is reachable", async () => {
			mockQueryRawUnsafe.mockResolvedValueOnce([{ 1: 1 }]);
			mockSessionAdapter.getActiveSessionId.mockReturnValueOnce("sess-42");
			const app = await getApp();
			const res = await app.request("/api/health");
			expect(res.status).toBe(200);
			const data = await json<{
				status: string;
				db: string;
				session: { active: boolean; id: string | null };
			}>(res);
			expect(data.status).toBe("ok");
			expect(data.db).toBe("up");
			expect(data.session).toEqual({ active: true, id: "sess-42" });
		});

		// TC-F-0.9-2: DB unreachable → db:'down', status 'degraded', HTTP 503
		// (docker healthcheck uses r.ok → container becomes unhealthy)
		it("should return 503 with db:'down' when DB probe fails", async () => {
			mockQueryRawUnsafe.mockRejectedValueOnce(new Error("SQLITE_CANTOPEN: unable to open database file"));
			const app = await getApp();
			const res = await app.request("/api/health");
			expect(res.status).toBe(503);
			const data = await json<{
				status: string;
				db: string;
				session: { active: boolean; id: string | null };
			}>(res);
			expect(data.status).toBe("degraded");
			expect(data.db).toBe("down");
			expect(data.session).toEqual({ active: false, id: null });
		});

		// TC-F-0.9-2 (variant): DB probe throws synchronously (broken client) → db:'down'
		it("should return 503 with db:'down' when Prisma client is broken", async () => {
			mockQueryRawUnsafe.mockImplementationOnce(() => {
				throw new Error("PrismaClientInitializationError");
			});
			const app = await getApp();
			const res = await app.request("/api/health");
			expect(res.status).toBe(503);
			const data = await json<{ status: string; db: string }>(res);
			expect(data.status).toBe("degraded");
			expect(data.db).toBe("down");
		});
	});

	describe("Sessions", () => {
		it("GET /api/sessions should list sessions", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce([
				{ id: "s1", title: "Test", createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: 5 },
			]);
			const app = await getApp();
			const res = await app.request("/api/sessions");
			expect(res.status).toBe(200);
			const data = await json<{ sessions: unknown[] }>(res);
			expect(data.sessions).toHaveLength(1);
		});

		// --- F-1.2: GET /api/sessions с фильтром ?project= ---
		const projectSessions = [
			{
				id: "a1",
				title: "A1",
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
				messageCount: 1,
				cwd: "/data/repos/a",
			},
			{
				id: "a2",
				title: "A2",
				createdAt: "2026-01-02",
				updatedAt: "2026-01-02",
				messageCount: 2,
				cwd: "/data/repos/a",
			},
			{
				id: "a3",
				title: "A3",
				createdAt: "2026-01-03",
				updatedAt: "2026-01-03",
				messageCount: 3,
				cwd: "/data/repos/a",
			},
			{
				id: "b1",
				title: "B1",
				createdAt: "2026-01-04",
				updatedAt: "2026-01-04",
				messageCount: 4,
				cwd: "/data/repos/b",
			},
			{
				id: "b2",
				title: "B2",
				createdAt: "2026-01-05",
				updatedAt: "2026-01-05",
				messageCount: 5,
				cwd: "/data/repos/b",
			},
		];

		// TC-F-1.2-1: ?project=/data/repos/a → только сессии проекта A, все с cwd === /data/repos/a
		it("GET /api/sessions?project= should return only sessions of that project", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce(projectSessions);
			const app = await getApp();
			const res = await app.request(`/api/sessions?project=${encodeURIComponent("/data/repos/a")}`);
			expect(res.status).toBe(200);
			const data = await json<{ sessions: Array<{ id: string; cwd: string }> }>(res);
			expect(data.sessions).toHaveLength(3);
			for (const s of data.sessions) {
				expect(s.cwd).toBe("/data/repos/a");
			}
		});

		// TC-F-1.2-1 (variant): normalized comparison — trailing slash, backslashes, . segments
		it("GET /api/sessions?project= should match normalized paths", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce([
				{
					id: "w1",
					title: "W1",
					createdAt: "2026-01-01",
					updatedAt: "2026-01-01",
					messageCount: 1,
					cwd: "C:\\repos\\proj",
				},
				{
					id: "x1",
					title: "X1",
					createdAt: "2026-01-02",
					updatedAt: "2026-01-02",
					messageCount: 1,
					cwd: "/data/repos/a",
				},
			]);
			const app = await getApp();
			// Windows-style path with trailing backslash + different case → same project
			const res = await app.request(`/api/sessions?project=${encodeURIComponent("c:\\repos\\proj\\")}`);
			expect(res.status).toBe(200);
			const data = await json<{ sessions: Array<{ id: string; cwd: string }> }>(res);
			expect(data.sessions).toHaveLength(1);
			expect(data.sessions[0].id).toBe("w1");
		});

		// TC-F-1.2-2: без параметра → все сессии (backward compatible)
		it("GET /api/sessions without ?project= should return all sessions", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce(projectSessions);
			const app = await getApp();
			const res = await app.request("/api/sessions");
			expect(res.status).toBe(200);
			const data = await json<{ sessions: Array<{ id: string; cwd: string }> }>(res);
			expect(data.sessions).toHaveLength(5);
		});

		// TC-F-1.2-3: ?project=/unknown → 200, пустой массив
		it("GET /api/sessions?project= with unknown project should return empty array", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce(projectSessions);
			const app = await getApp();
			const res = await app.request(`/api/sessions?project=${encodeURIComponent("/data/repos/unknown")}`);
			expect(res.status).toBe(200);
			const data = await json<{ sessions: unknown[] }>(res);
			expect(data.sessions).toHaveLength(0);
		});

		// F-1.9: ?project= is pushed down into the adapter (defense-in-depth:
		// the handler-side filter stays for adapters that ignore the param).
		it("GET /api/sessions?project= should pass projectPath to adapter.listSessions", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce([]);
			const app = await getApp();
			await app.request(`/api/sessions?project=${encodeURIComponent("/data/repos/a")}`);
			expect(mockSessionAdapter.listSessions).toHaveBeenCalledWith("/data/repos/a");
		});

		// F-1.9 (TC-F-1.9-2): without ?project= the adapter receives no filter
		// and the full list is returned (global operation, backward compat).
		it("GET /api/sessions without ?project= should call adapter.listSessions without a filter", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce(projectSessions);
			const app = await getApp();
			await app.request("/api/sessions");
			expect(mockSessionAdapter.listSessions).toHaveBeenCalledWith(undefined);
		});

		// --- F-1.12: listAll() → проброс cwd в API responses ---
		// TC-F-1.12-1: каждый элемент response.sessions содержит cwd; для legacy-сессий
		// (без cwd в JSONL header) поле отсутствует — не "" и не null.
		it("GET /api/sessions should include cwd in every element and omit it for legacy sessions (TC-F-1.12-1)", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce([
				{
					id: "a1",
					title: "A1",
					createdAt: "2026-01-01",
					updatedAt: "2026-01-01",
					messageCount: 1,
					cwd: "/data/repos/a",
				},
				{
					id: "b1",
					title: "B1",
					createdAt: "2026-01-02",
					updatedAt: "2026-01-02",
					messageCount: 2,
					cwd: "/data/repos/b",
				},
				// legacy session: adapter omits cwd (no cwd in JSONL header)
				{ id: "legacy1", title: "Old", createdAt: "2025-12-31", updatedAt: "2025-12-31", messageCount: 0 },
			]);
			const app = await getApp();
			const res = await app.request("/api/sessions");
			expect(res.status).toBe(200);
			const data = await json<{ sessions: Array<Record<string, unknown>> }>(res);
			expect(data.sessions).toHaveLength(3);
			expect(data.sessions[0].cwd).toBe("/data/repos/a");
			expect(data.sessions[1].cwd).toBe("/data/repos/b");
			// legacy: field omitted entirely, not "" / null
			expect(data.sessions[2].cwd).toBeUndefined();
			expect("cwd" in data.sessions[2]).toBe(false);
		});

		// TC-F-1.12-2: фильтр ?project= применяется после listAll (in-memory в handler);
		// отфильтрованные сессии сохраняют cwd; cwd-less сессии исключены.
		// The mock adapter ignores the projectPath arg (returns all) — the handler-side
		// in-memory filter after listAll does the work.
		it("GET /api/sessions?project= should filter after listAll and keep cwd in filtered results (TC-F-1.12-2)", async () => {
			mockSessionAdapter.listSessions.mockResolvedValueOnce([
				...projectSessions,
				{ id: "legacy1", title: "Old", createdAt: "2025-12-31", updatedAt: "2025-12-31", messageCount: 0 },
			]);
			const app = await getApp();
			const res = await app.request(`/api/sessions?project=${encodeURIComponent("/data/repos/b")}`);
			expect(res.status).toBe(200);
			const data = await json<{ sessions: Array<{ id: string; cwd?: string }> }>(res);
			expect(data.sessions).toHaveLength(2);
			for (const s of data.sessions) {
				expect(s.cwd).toBe("/data/repos/b");
			}
		});

		it("POST /api/sessions should create a session", async () => {
			mockSessionAdapter.createSession.mockResolvedValueOnce({
				id: "s2",
				title: "New Session",
				createdAt: "2026-01-01",
			});
			const app = await getApp();
			const res = await app.request("/api/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "New Session" }),
			});
			expect(res.status).toBe(201);
			const data = await json<{ id: string }>(res);
			expect(data.id).toBe("s2");
		});

		// TC-F-1.3-1: POST { cwd } → 201, response.cwd === нормализованный путь
		it("POST /api/sessions with cwd should create session in that directory", async () => {
			mockSessionAdapter.createSession.mockImplementationOnce(async (opts?: { cwd?: string }) => ({
				id: "s3",
				title: "New Session",
				cwd: opts?.cwd,
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
			}));
			const app = await getApp();
			const res = await app.request("/api/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: "/data/repos/my-project/" }),
			});
			expect(res.status).toBe(201);
			const data = await json<{ id: string; cwd: string }>(res);
			expect(data.cwd).toBe("/data/repos/my-project");
			// cwd is passed to the adapter in normalized form
			expect(mockSessionAdapter.createSession).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: "/data/repos/my-project" }),
			);
		});

		// TC-F-1.3-2: POST {} → 201, response.cwd = process.cwd() (backward compat)
		it("POST /api/sessions without cwd should fall back to process cwd", async () => {
			mockSessionAdapter.createSession.mockImplementationOnce(async (opts?: { cwd?: string }) => ({
				id: "s4",
				title: "New Session",
				cwd: opts?.cwd ?? process.cwd(),
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
			}));
			const app = await getApp();
			const res = await app.request("/api/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(201);
			const data = await json<{ id: string; cwd: string }>(res);
			expect(data.cwd).toBe(process.cwd());
		});

		// TC-F-1.3-3: malformed JSON → 400 с сообщением
		it("POST /api/sessions with malformed JSON should return 400", async () => {
			const app = await getApp();
			const res = await app.request("/api/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{invalid json",
			});
			expect(res.status).toBe(400);
			const data = await json<{ error: string; code: string }>(res);
			expect(data.error).toBeTruthy();
		});

		it("GET /api/sessions/:id should return 404 for unknown session", async () => {
			mockSessionAdapter.getSession.mockResolvedValueOnce(null);
			const app = await getApp();
			const res = await app.request("/api/sessions/nonexistent");
			expect(res.status).toBe(404);
		});

		it("GET /api/sessions/:id should return session when found", async () => {
			mockSessionAdapter.getSession.mockResolvedValueOnce({
				id: "s1",
				title: "Found",
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
				messages: [],
			});
			const app = await getApp();
			const res = await app.request("/api/sessions/s1");
			expect(res.status).toBe(200);
			const data = await json<{ id: string }>(res);
			expect(data.id).toBe("s1");
		});

		it("DELETE /api/sessions/:id should return 404 if not deleted", async () => {
			mockSessionAdapter.deleteSession.mockResolvedValueOnce(false);
			const app = await getApp();
			const res = await app.request("/api/sessions/nonexistent", { method: "DELETE" });
			expect(res.status).toBe(404);
		});

		// TC-F-1.4-3: без ?project — глобальное удаление, 204
		it("DELETE /api/sessions/:id without ?project should return 204 and delete globally (TC-F-1.4-3)", async () => {
			mockSessionAdapter.deleteSession.mockResolvedValueOnce(true);
			const app = await getApp();
			const res = await app.request("/api/sessions/s1", { method: "DELETE" });
			expect(res.status).toBe(204);
			expect(mockSessionAdapter.deleteSession).toHaveBeenCalledWith("s1", undefined);
			expect(mockSessionAdapter.getSession).not.toHaveBeenCalled();
		});

		// TC-F-1.4-1: совпадающий ?project → 204, сессия удалена
		it("DELETE /api/sessions/:id?project=<match> should return 204 and delete (TC-F-1.4-1)", async () => {
			mockSessionAdapter.getSession.mockResolvedValueOnce({
				id: "s1",
				title: "Session A",
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
				messages: [],
				cwd: "/data/repos/a",
			});
			mockSessionAdapter.deleteSession.mockResolvedValueOnce(true);
			const app = await getApp();
			const res = await app.request("/api/sessions/s1?project=/data/repos/a", { method: "DELETE" });
			expect(res.status).toBe(204);
			expect(mockSessionAdapter.deleteSession).toHaveBeenCalledWith("s1", "/data/repos/a");
		});

		// TC-F-1.4-2: чужой ?project → 403, сессия НЕ удалена
		it("DELETE /api/sessions/:id?project=<other> should return 403 and not delete (TC-F-1.4-2)", async () => {
			mockSessionAdapter.getSession.mockResolvedValueOnce({
				id: "s1",
				title: "Session A",
				createdAt: "2026-01-01",
				updatedAt: "2026-01-01",
				messages: [],
				cwd: "/data/repos/a",
			});
			const app = await getApp();
			const res = await app.request("/api/sessions/s1?project=/data/repos/b", { method: "DELETE" });
			expect(res.status).toBe(403);
			const data = await json<{ error: string }>(res);
			expect(data.error).toBe("session does not belong to this project");
			expect(mockSessionAdapter.deleteSession).not.toHaveBeenCalled();
		});
	});

	describe("Projects (F-1.5)", () => {
		const sessionOf = (id: string, cwd: string) => ({
			id,
			title: id,
			createdAt: "2026-01-01",
			updatedAt: "2026-01-01",
			messageCount: 1,
			cwd,
		});

		// TC-F-1.5-1: 2 проекта (3 и 7 сессий) → sessionCount корректный
		it("GET /api/projects should return projects with correct session counts (TC-F-1.5-1)", async () => {
			mockSessionAdapter.listProjects.mockResolvedValueOnce([
				{ path: "/data/repos/a", name: "a", type: "code" },
				{ path: "/data/repos/b", name: "b", type: "research" },
			]);
			mockSessionAdapter.listSessions.mockResolvedValueOnce([
				sessionOf("a1", "/data/repos/a"),
				sessionOf("a2", "/data/repos/a"),
				sessionOf("a3", "/data/repos/a"),
				sessionOf("b1", "/data/repos/b"),
				sessionOf("b2", "/data/repos/b"),
				sessionOf("b3", "/data/repos/b"),
				sessionOf("b4", "/data/repos/b"),
				sessionOf("b5", "/data/repos/b"),
				sessionOf("b6", "/data/repos/b"),
				sessionOf("b7", "/data/repos/b"),
				// sessions outside the registry must not affect counts
				sessionOf("x1", "/data/repos/other"),
			]);
			const app = await getApp();
			const res = await app.request("/api/projects");
			expect(res.status).toBe(200);
			const data = await json<{
				projects: Array<{ path: string; name: string; type: string; sessionCount: number }>;
			}>(res);
			expect(data.projects).toHaveLength(2);
			// F-2.13: /data/repos/* does not exist on the test machine → entries are
			// flagged available:false + PROJECT_NOT_FOUND (but NOT excluded).
			expect(data.projects[0]).toEqual({
				path: "/data/repos/a",
				name: "a",
				type: "code",
				sessionCount: 3,
				available: false,
				error: "PROJECT_NOT_FOUND",
			});
			expect(data.projects[1]).toEqual({
				path: "/data/repos/b",
				name: "b",
				type: "research",
				sessionCount: 7,
				available: false,
				error: "PROJECT_NOT_FOUND",
			});
		});

		// TC-F-1.5-2: пустой/отсутствующий projects.json → { projects: [] }, 200
		it("GET /api/projects with empty registry should return empty array (TC-F-1.5-2)", async () => {
			mockSessionAdapter.listProjects.mockResolvedValueOnce([]);
			const app = await getApp();
			const res = await app.request("/api/projects");
			expect(res.status).toBe(200);
			const data = await json<{ projects: unknown[] }>(res);
			expect(data.projects).toEqual([]);
		});

		// TC-F-1.5-3: name из basename, если в реестре нет name
		it("GET /api/projects should derive name from path basename when missing (TC-F-1.5-3)", async () => {
			mockSessionAdapter.listProjects.mockResolvedValueOnce([
				{ path: "/data/repos/my-project", name: "", type: "unknown" },
			]);
			mockSessionAdapter.listSessions.mockResolvedValueOnce([sessionOf("s1", "/data/repos/my-project")]);
			const app = await getApp();
			const res = await app.request("/api/projects");
			expect(res.status).toBe(200);
			const data = await json<{ projects: Array<{ name: string; sessionCount: number }> }>(res);
			expect(data.projects[0].name).toBe("my-project");
			expect(data.projects[0].sessionCount).toBe(1);
		});

		// Session count matches project path after normalization (trailing slash, backslashes)
		it("GET /api/projects should count sessions by normalized cwd", async () => {
			mockSessionAdapter.listProjects.mockResolvedValueOnce([
				{ path: "C:\\repos\\proj", name: "proj", type: "code" },
			]);
			mockSessionAdapter.listSessions.mockResolvedValueOnce([
				sessionOf("w1", "c:\\repos\\proj\\"),
				sessionOf("w2", "C:/repos/proj"),
			]);
			const app = await getApp();
			const res = await app.request("/api/projects");
			expect(res.status).toBe(200);
			const data = await json<{ projects: Array<{ path: string; sessionCount: number }> }>(res);
			expect(data.projects[0].sessionCount).toBe(2);
		});

		// TC-F-2.13-1: проект удалён с диска → entry с available:false + error
		// PROJECT_NOT_FOUND, проект НЕ исключается из списка
		it("GET /api/projects flags missing directories as PROJECT_NOT_FOUND (TC-F-2.13-1)", async () => {
			mockSessionAdapter.listProjects.mockResolvedValueOnce([
				{ path: "/deleted-proj", name: "deleted-proj", type: "code" },
				{ path: process.cwd(), name: "existing", type: "code" },
			]);
			mockSessionAdapter.listSessions.mockResolvedValueOnce([]);
			const app = await getApp();
			const res = await app.request("/api/projects");
			expect(res.status).toBe(200);
			const data = await json<{
				projects: Array<{ path: string; available: boolean; error?: string }>;
			}>(res);
			// Both entries stay in the list — the user must see the broken one
			expect(data.projects).toHaveLength(2);
			expect(data.projects[0]).toMatchObject({
				path: "/deleted-proj",
				available: false,
				error: "PROJECT_NOT_FOUND",
			});
			expect(data.projects[1].available).toBe(true);
			expect(data.projects[1].error).toBeUndefined();
		});

		it("DELETE /api/projects without ?path= should return 400", async () => {
			const app = await getApp();
			const res = await app.request("/api/projects", { method: "DELETE" });
			expect(res.status).toBe(400);
			const data = await json<{ error: string; code: string }>(res);
			expect(data.code).toBe("BAD_REQUEST");
		});

		it("DELETE /api/projects?path= should remove a registered project (204)", async () => {
			mockSessionAdapter.removeProject.mockResolvedValueOnce(true);
			const app = await getApp();
			const res = await app.request(`/api/projects?path=${encodeURIComponent("/deleted-proj")}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(204);
			expect(mockSessionAdapter.removeProject).toHaveBeenCalledWith("/deleted-proj");
		});

		it("DELETE /api/projects?path= should return 404 for an unregistered path", async () => {
			mockSessionAdapter.removeProject.mockResolvedValueOnce(false);
			const app = await getApp();
			const res = await app.request(`/api/projects?path=${encodeURIComponent("/never-registered")}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(404);
			const data = await json<{ error: string; code: string }>(res);
			expect(data.code).toBe("NOT_FOUND");
		});

		it("DELETE /api/projects should return 501 when the adapter lacks removeProject", async () => {
			const saved = mockSessionAdapter.removeProject;
			Reflect.deleteProperty(mockSessionAdapter, "removeProject");
			try {
				const app = await getApp();
				const res = await app.request(`/api/projects?path=${encodeURIComponent("/x")}`, { method: "DELETE" });
				expect(res.status).toBe(501);
				const data = await json<{ error: string; code: string }>(res);
				expect(data.code).toBe("NOT_IMPLEMENTED");
			} finally {
				mockSessionAdapter.removeProject = saved;
			}
		});
	});

	describe("Messages", () => {
		it("POST /api/sessions/:id/messages should send message", async () => {
			mockSessionAdapter.sendMessage.mockResolvedValueOnce(true);
			const app = await getApp();
			const res = await app.request("/api/sessions/s1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Hello" }),
			});
			expect(res.status).toBe(200);
			const data = await json<{ success: boolean }>(res);
			expect(data.success).toBe(true);
		});

		it("POST /api/sessions/:id/messages should return 404 if session unavailable", async () => {
			mockSessionAdapter.sendMessage.mockResolvedValueOnce(false);
			const app = await getApp();
			const res = await app.request("/api/sessions/unknown/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Hello" }),
			});
			expect(res.status).toBe(404);
		});

		it("POST /api/sessions/:id/messages should pass streamingBehavior", async () => {
			mockSessionAdapter.sendMessage.mockResolvedValueOnce(true);
			const app = await getApp();
			await app.request("/api/sessions/s1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Hello", streamingBehavior: "steer" }),
			});
			expect(mockSessionAdapter.sendMessage).toHaveBeenCalledWith("s1", "Hello", "steer");
		});
	});

	describe("Models", () => {
		it("GET /api/models should return models and routing rules", async () => {
			mockSessionAdapter.getAvailableModels.mockResolvedValueOnce([
				{ provider: "anthropic", model: "claude-sonnet" },
			]);
			mockModelManager.getRoutingRules.mockResolvedValueOnce([
				{
					id: "r1",
					name: "coding",
					provider: "anthropic",
					model: "claude-sonnet",
					fallback: undefined,
					enabled: true,
				},
			]);
			const app = await getApp();
			const res = await app.request("/api/models");
			expect(res.status).toBe(200);
			const data = await json<{ models: unknown[]; routingRules: unknown[] }>(res);
			expect(data.models).toHaveLength(1);
			expect(data.routingRules).toHaveLength(1);
		});

		it("GET /api/models/settings should return settings", async () => {
			mockModelManager.getAllModelSettings.mockResolvedValueOnce([
				{
					id: "ms1",
					provider: "anthropic",
					model: "claude-sonnet",
					temperature: 0.7,
					maxTokens: null,
					thinking: null,
					isDefault: false,
					priority: 0,
				},
			]);
			const app = await getApp();
			const res = await app.request("/api/models/settings");
			expect(res.status).toBe(200);
			const data = await json<{ settings: unknown[] }>(res);
			expect(data.settings).toHaveLength(1);
		});

		it("PUT /api/models/settings should update setting", async () => {
			const updatedSetting = {
				id: "ms1",
				provider: "anthropic",
				model: "claude-sonnet",
				temperature: 0.5,
				maxTokens: null,
				thinking: null,
				isDefault: false,
				priority: 0,
			};
			mockModelManager.getModelSetting.mockReturnValueOnce(updatedSetting);
			const app = await getApp();
			const res = await app.request("/api/models/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet", temperature: 0.5 }),
			});
			expect(res.status).toBe(200);
			expect(mockModelManager.setModelSetting).toHaveBeenCalledWith({
				provider: "anthropic",
				model: "claude-sonnet",
				temperature: 0.5,
				maxTokens: undefined,
				thinking: undefined,
			});
			const data = await json<{ setting: { temperature: number } }>(res);
			expect(data.setting.temperature).toBe(0.5);
		});

		it("PUT /api/models/settings should return 500 if setting not found after update", async () => {
			mockModelManager.getModelSetting.mockReturnValueOnce(null);
			const app = await getApp();
			const res = await app.request("/api/models/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet", temperature: 0.5 }),
			});
			expect(res.status).toBe(500);
		});
	});

	describe("Budget", () => {
		it("GET /api/budget should return budgets", async () => {
			mockModelManager.getBudgetStatus.mockResolvedValueOnce([
				{ provider: "anthropic", period: "daily", tokensUsed: 1000, costUsed: 0.05, exceeded: false },
			]);
			const app = await getApp();
			const res = await app.request("/api/budget");
			expect(res.status).toBe(200);
			const data = await json<{ budgets: unknown[] }>(res);
			expect(data.budgets).toHaveLength(1);
		});

		it("GET /api/budget should wrap non-array budgets in array", async () => {
			mockModelManager.getBudgetStatus.mockResolvedValueOnce({
				provider: "anthropic",
				period: "daily",
				tokensUsed: 1000,
				costUsed: 0.05,
				exceeded: false,
			} as any);
			const app = await getApp();
			const res = await app.request("/api/budget");
			expect(res.status).toBe(200);
			const data = await json<{ budgets: unknown[] }>(res);
			expect(data.budgets).toHaveLength(1);
		});

		it("PUT /api/budget should configure budget", async () => {
			const app = await getApp();
			const res = await app.request("/api/budget", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ period: "daily", costLimit: 10 }),
			});
			expect(res.status).toBe(200);
			expect(mockModelManager.configureBudget).toHaveBeenCalledWith({ period: "daily", costLimit: 10 });
			const data = await json<{ config: Record<string, unknown> }>(res);
			expect(data.config).toEqual({ period: "daily", costLimit: 10 });
		});
	});

	describe("Tokens", () => {
		it("POST /api/tokens should generate a token", async () => {
			const mockToken = {
				id: "t1",
				name: "Test",
				token: "hex-token",
				createdAt: new Date("2026-01-01"),
				lastUsed: null,
			};
			mockClientToken.create.mockResolvedValueOnce(mockToken);
			const app = await getApp();
			const res = await app.request("/api/tokens", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Test" }),
			});
			expect(res.status).toBe(201);
			const data = await json<{ token: { id: string; name: string; token: string } }>(res);
			expect(data.token.id).toBe("t1");
			expect(data.token.name).toBe("Test");
			expect(data.token.token).toBe("hex-token");
		});

		it("POST /api/tokens should return 400 without name", async () => {
			const app = await getApp();
			const res = await app.request("/api/tokens", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		});

		it("GET /api/tokens should list tokens", async () => {
			mockClientToken.findMany.mockResolvedValueOnce([
				{ id: "t1", name: "Test", token: "secret", createdAt: new Date("2026-01-01"), lastUsed: null },
			]);
			const app = await getApp();
			const res = await app.request("/api/tokens");
			expect(res.status).toBe(200);
			const data = await json<{ tokens: Array<Record<string, unknown>> }>(res);
			expect(data.tokens).toHaveLength(1);
			// Token value should be stripped
			expect(data.tokens[0]).not.toHaveProperty("token");
			expect(data.tokens[0].name).toBe("Test");
		});

		it("DELETE /api/tokens/:id should revoke token", async () => {
			mockClientToken.delete.mockResolvedValueOnce({});
			const app = await getApp();
			const res = await app.request("/api/tokens/t1", { method: "DELETE" });
			expect(res.status).toBe(200);
			const data = await json<{ success: boolean }>(res);
			expect(data.success).toBe(true);
		});

		it("DELETE /api/tokens/:id should return 404 for non-existent token", async () => {
			mockClientToken.delete.mockRejectedValueOnce(new Error("Not found"));
			const app = await getApp();
			const res = await app.request("/api/tokens/nonexistent", { method: "DELETE" });
			expect(res.status).toBe(404);
		});
	});

	describe("Error handling", () => {
		it("should return 404 for unknown routes", async () => {
			const app = await getApp();
			const res = await app.request("/api/nonexistent");
			expect(res.status).toBe(404);
		});

		it("should return 404 for non-api routes", async () => {
			const app = await getApp();
			const res = await app.request("/random-path");
			expect(res.status).toBe(404);
		});
	});

	describe("Logger token scrubbing (F-0.10)", () => {
		let logLines: string[] = [];
		let logSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			logLines = [];
			logSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
				logLines.push(String(msg));
			});
		});

		afterEach(() => {
			logSpy.mockRestore();
		});

		it("masks token query parameter values in access logs", async () => {
			const app = await getApp();
			const secret = "deadbeef".repeat(8);
			const res = await app.request(`/api/sessions?token=${secret}`);
			expect(res.status).toBe(200);
			const pathLogs = logLines.filter((line) => line.includes("/api/sessions"));
			expect(pathLogs.length).toBeGreaterThan(0);
			for (const line of pathLogs) {
				expect(line).toContain("token=***");
				expect(line).not.toContain(secret);
			}
		});

		it("leaves other query parameters unchanged when no token is present", async () => {
			const app = await getApp();
			const res = await app.request("/api/sessions?sessionId=my-session");
			expect(res.status).toBe(200);
			const pathLogs = logLines.filter((line) => line.includes("/api/sessions"));
			expect(pathLogs.length).toBeGreaterThan(0);
			for (const line of pathLogs) {
				expect(line).toContain("sessionId=my-session");
				expect(line).not.toContain("token=");
			}
		});
	});
});
