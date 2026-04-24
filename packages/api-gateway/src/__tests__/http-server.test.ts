import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to create stable mock references that persist across getPrismaClient() calls
const { mockClientToken } = vi.hoisted(() => ({
	mockClientToken: {
		create: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		delete: vi.fn(),
	},
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
};

vi.mock("@fan/model-manager", () => ({
	ModelManager: vi.fn(),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: mockClientToken,
	}),
}));

// Set FAN_NO_AUTH to bypass token auth in tests
process.env["FAN_NO_AUTH"] = "1";

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

		it("DELETE /api/sessions/:id should return success if deleted", async () => {
			mockSessionAdapter.deleteSession.mockResolvedValueOnce(true);
			const app = await getApp();
			const res = await app.request("/api/sessions/s1", { method: "DELETE" });
			expect(res.status).toBe(200);
			const data = await json<{ success: boolean }>(res);
			expect(data.success).toBe(true);
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
});
