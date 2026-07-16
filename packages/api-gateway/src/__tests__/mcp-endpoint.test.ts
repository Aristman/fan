import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to create stable mock references
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
process.env.FAN_NO_AUTH = "1";

// Mock crypto.randomBytes for token generation in the HTTP handler's auth calls
const mockRandomBytes = vi.fn().mockReturnValue({
	toString: vi.fn().mockReturnValue("mocked-random-token-hex"),
});
vi.mock("node:crypto", () => ({
	randomBytes: mockRandomBytes,
}));

import type { McpServerStatus, ApiMcpStatusResponse } from "../types.js";

describe("F-3.6: McpServerStatus types", () => {
	it("McpServerStatus has all required fields", () => {
		const status: McpServerStatus = {
			index: 0,
			name: "filesystem",
			status: "connected",
			transport: "stdio",
			toolCount: 3,
			toolNames: ["mcp__0__read_file", "mcp__0__write_file"],
			lastUpdated: new Date().toISOString(),
		};
		expect(status.status).toBe("connected");
		expect(status.toolCount).toBe(3);
		expect(status.transport).toBe("stdio");
	});

	it("McpServerStatus can represent an unavailable server", () => {
		const status: McpServerStatus = {
			index: 1,
			name: "github",
			status: "unavailable",
			transport: "streamable-http",
			toolCount: 0,
			toolNames: [],
			connectError: "ECONNREFUSED",
			lastUpdated: new Date().toISOString(),
		};
		expect(status.status).toBe("unavailable");
		expect(status.connectError).toBe("ECONNREFUSED");
	});

	it("McpServerStatus accepts optional serverInfo", () => {
		const status: McpServerStatus = {
			index: 2,
			name: "brave-search",
			status: "connected",
			transport: "stdio",
			toolCount: 1,
			toolNames: ["mcp__2__brave_web_search"],
			serverInfo: { name: "Brave Search MCP", version: "1.0.0" },
			lastUpdated: new Date().toISOString(),
		};
		expect(status.serverInfo?.name).toBe("Brave Search MCP");
		expect(status.serverInfo?.version).toBe("1.0.0");
	});

	it("ApiMcpStatusResponse aggregates correctly", () => {
		const response: ApiMcpStatusResponse = {
			servers: [
				{
					index: 0,
					name: "fs",
					status: "connected",
					transport: "stdio",
					toolCount: 2,
					toolNames: [],
					lastUpdated: new Date().toISOString(),
				},
				{
					index: 1,
					name: "gh",
					status: "unavailable",
					transport: "streamable-http",
					toolCount: 0,
					toolNames: [],
					connectError: "ECONNREFUSED",
					lastUpdated: new Date().toISOString(),
				},
			],
			totalConnected: 1,
			totalUnavailable: 1,
			lastUpdate: new Date().toISOString(),
		};
		expect(response.totalConnected).toBe(1);
		expect(response.totalUnavailable).toBe(1);
		expect(response.servers).toHaveLength(2);
	});
});

describe("F-3.6: GET /api/mcp/servers endpoint", () => {
	it("returns correct stub response structure", async () => {
		// Dynamic import to avoid hoisting issues
		const { createApp } = await import("../http-server.js");

		// Use the real ModelManager mock (already set up via vi.mock)
		const { ModelManager } = await import("@fan/model-manager");

		const app = await createApp(
			new (ModelManager as any)(),
			mockSessionAdapter as any,
		);

		const res = await app.request("/api/mcp/servers");
		expect(res.status).toBe(200);

		const body = (await res.json()) as ApiMcpStatusResponse;
		expect(body).toHaveProperty("servers");
		expect(body).toHaveProperty("totalConnected");
		expect(body).toHaveProperty("totalUnavailable");
		expect(body).toHaveProperty("lastUpdate");
		expect(Array.isArray(body.servers)).toBe(true);
		expect(body.servers).toHaveLength(0);
		expect(body.totalConnected).toBe(0);
		expect(body.totalUnavailable).toBe(0);
		expect(typeof body.lastUpdate).toBe("string");
	});

	it("returns valid ISO 8601 lastUpdate", async () => {
		const { createApp } = await import("../http-server.js");
		const { ModelManager } = await import("@fan/model-manager");

		const app = await createApp(
			new (ModelManager as any)(),
			mockSessionAdapter as any,
		);

		const res = await app.request("/api/mcp/servers");
		const body = (await res.json()) as ApiMcpStatusResponse;
		const date = new Date(body.lastUpdate);
		expect(date.getTime()).not.toBeNaN();
	});
});
