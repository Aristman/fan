import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@fan/model-manager", () => ({
	ModelManager: vi.fn(),
}));

vi.mock("@fan/db", () => ({
	getPrismaClient: () => ({
		clientToken: {},
	}),
}));

// Bypass token auth — tests target CORS headers, not authentication
process.env.FAN_NO_AUTH = "1";

import type { ModelManager } from "@fan/model-manager";
import { DEFAULT_ALLOWED_ORIGINS, resolveAllowedOrigins, resolveCorsOrigin } from "../cors-config.js";
import { createApp } from "../http-server.js";

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

describe("resolveAllowedOrigins (F-0.4)", () => {
	const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

	afterEach(() => {
		if (originalAllowedOrigins === undefined) {
			delete process.env.ALLOWED_ORIGINS;
		} else {
			process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
		}
	});

	it("defaults to ['*'] when ALLOWED_ORIGINS is not set", () => {
		delete process.env.ALLOWED_ORIGINS;
		expect(resolveAllowedOrigins()).toEqual(DEFAULT_ALLOWED_ORIGINS);
		expect(resolveAllowedOrigins(undefined)).toEqual(["*"]);
	});

	it("parses a single origin", () => {
		process.env.ALLOWED_ORIGINS = "https://agent.sea-agents.ru";
		expect(resolveAllowedOrigins()).toEqual(["https://agent.sea-agents.ru"]);
	});

	it("parses multiple comma-separated origins, trimming whitespace and dropping empty entries", () => {
		expect(resolveAllowedOrigins("https://a.com, https://b.com")).toEqual(["https://a.com", "https://b.com"]);
		expect(resolveAllowedOrigins(" https://a.com ,,https://b.com, ")).toEqual(["https://a.com", "https://b.com"]);
	});

	it("falls back to ['*'] for empty/whitespace-only value", () => {
		expect(resolveAllowedOrigins("")).toEqual(["*"]);
		expect(resolveAllowedOrigins("   ,  ,")).toEqual(["*"]);
	});

	it("resolveCorsOrigin returns '*' string when wildcard is present, array otherwise", () => {
		expect(resolveCorsOrigin(undefined)).toBe("*");
		expect(resolveCorsOrigin("*, https://a.com")).toBe("*");
		expect(resolveCorsOrigin("https://a.com, https://b.com")).toEqual(["https://a.com", "https://b.com"]);
	});
});

describe("CORS headers via createApp (F-0.4)", () => {
	const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

	afterEach(() => {
		if (originalAllowedOrigins === undefined) {
			delete process.env.ALLOWED_ORIGINS;
		} else {
			process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
		}
	});

	async function getApp() {
		return createApp(mockModelManager as unknown as ModelManager, mockSessionAdapter);
	}

	it("TC-F-0.4-1: allowed origin gets Access-Control-Allow-Origin and 200", async () => {
		process.env.ALLOWED_ORIGINS = "https://agent.sea-agents.ru";
		const app = await getApp();
		const res = await app.request("/api/sessions", {
			headers: { Origin: "https://agent.sea-agents.ru" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://agent.sea-agents.ru");
	});

	it("TC-F-0.4-2: disallowed origin gets no Access-Control-Allow-Origin header", async () => {
		process.env.ALLOWED_ORIGINS = "https://agent.sea-agents.ru";
		const app = await getApp();
		const res = await app.request("/api/sessions", {
			headers: { Origin: "https://evil.com" },
		});
		const acao = res.headers.get("Access-Control-Allow-Origin");
		expect(acao === null || acao === "").toBe(true);
	});

	it("TC-F-0.4-3: without ALLOWED_ORIGINS any origin gets Access-Control-Allow-Origin: *", async () => {
		delete process.env.ALLOWED_ORIGINS;
		const app = await getApp();
		const res = await app.request("/api/sessions", {
			headers: { Origin: "https://anything.example" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("multiple comma-separated origins with spaces — all allowed", async () => {
		process.env.ALLOWED_ORIGINS = "https://a.com, https://b.com";
		const app = await getApp();
		for (const origin of ["https://a.com", "https://b.com"]) {
			const res = await app.request("/api/sessions", { headers: { Origin: origin } });
			expect(res.status).toBe(200);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
		}
		const blocked = await app.request("/api/sessions", { headers: { Origin: "https://c.com" } });
		const acao = blocked.headers.get("Access-Control-Allow-Origin");
		expect(acao === null || acao === "").toBe(true);
	});
});
