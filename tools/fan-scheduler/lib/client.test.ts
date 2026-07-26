import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FanApiClient, FanApiError } from "./client.js";

const TOKEN = "test-token-123";
const BASE_URL = "http://localhost:3456";

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createClient(options: { baseUrl?: string; token?: string } = {}): FanApiClient {
	return new FanApiClient({ baseUrl: options.baseUrl ?? BASE_URL, token: options.token ?? TOKEN });
}

/** Returns the URL and RequestInit of the n-th fetch call (0-based). */
function callArgs(n = 0): { url: URL; init: RequestInit } {
	const [url, init] = fetchMock.mock.calls[n] as [URL, RequestInit];
	return { url: url instanceof URL ? url : new URL(String(url)), init };
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubEnv("FAN_API_TOKEN", TOKEN);
	vi.stubEnv("FAN_API_URL", BASE_URL);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("TC-F-4.2-1: createSession returns session object", () => {
	it("returns { id, cwd } and sends the correct Authorization header", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ id: "clxxx", title: "Session", createdAt: "t", updatedAt: "t", cwd: "/path" }, 201),
		);
		const client = createClient();

		const session = await client.createSession("/data/repos/my-project");

		expect(session.id).toBe("clxxx");
		expect(session.cwd).toBe("/path");

		const { url, init } = callArgs();
		expect(url.origin + url.pathname).toBe(`${BASE_URL}/api/sessions`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
		expect(JSON.parse(init.body as string)).toEqual({ cwd: "/data/repos/my-project" });
	});
});

describe("TC-F-4.2-2: setProjectBudget sets the cap", () => {
	it("sends a PUT request whose body contains the token limit", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ config: {} }));
		const client = createClient();

		await client.setProjectBudget("/data/repos/my-project", 500);

		const { url, init } = callArgs();
		expect(url.origin + url.pathname).toBe(`${BASE_URL}/api/budget`);
		expect(init.method).toBe("PUT");
		expect(url.searchParams.get("project")).toBe("/data/repos/my-project");
		expect(url.searchParams.get("limit")).toBe("500");
		const body = JSON.parse(init.body as string);
		expect(body.tokenLimit).toBe(500);
		expect(body.project).toBe("/data/repos/my-project");
	});
});

describe("getSessionList", () => {
	it("requests all sessions without a project filter", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ sessions: [{ id: "s1" }, { id: "s2" }] }));
		const client = createClient();

		const sessions = await client.getSessionList();

		expect(sessions).toHaveLength(2);
		const { url, init } = callArgs();
		expect(init.method).toBe("GET");
		expect(url.pathname).toBe("/api/sessions");
		expect(url.search).toBe("");
	});

	it("passes the project path as a query param", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
		const client = createClient();

		await client.getSessionList("/data/repos/my-project");

		const { url } = callArgs();
		expect(url.searchParams.get("project")).toBe("/data/repos/my-project");
	});
});

describe("sendMessage", () => {
	it("POSTs the content as `message` to /api/sessions/:id/messages", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));
		const client = createClient();

		await client.sendMessage("clxxx", "run the review");

		const { url, init } = callArgs();
		expect(url.origin + url.pathname).toBe(`${BASE_URL}/api/sessions/clxxx/messages`);
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ message: "run the review" });
	});
});

describe("getBudgetUsage", () => {
	it("returns the project-scoped { project, used, limit } from the gateway (F-4.9)", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ project: "/data/repos/my-project", used: 500, limit: 500 }));
		const client = createClient();

		const usage = await client.getBudgetUsage("/data/repos/my-project");

		expect(usage.project).toBe("/data/repos/my-project");
		expect(usage.used).toBe(500);
		expect(usage.limit).toBe(500);

		const { url, init } = callArgs();
		expect(init.method).toBe("GET");
		expect(url.pathname).toBe("/api/budget");
		expect(url.searchParams.get("project")).toBe("/data/repos/my-project");
	});

	it("reports limit=null when the project has no stored cap", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ project: "/p", used: 42, limit: null }));
		const client = createClient();

		const usage = await client.getBudgetUsage("/p");

		expect(usage.used).toBe(42);
		expect(usage.limit).toBeNull();
	});
});

describe("updateBudget", () => {
	it("sends a PUT with the partial update merged into the body", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ config: {} }));
		const client = createClient();

		await client.updateBudget("/data/repos/my-project", { tokenLimit: 1000, period: "monthly" });

		const { url, init } = callArgs();
		expect(url.origin + url.pathname).toBe(`${BASE_URL}/api/budget`);
		expect(init.method).toBe("PUT");
		expect(url.searchParams.get("project")).toBe("/data/repos/my-project");
		expect(JSON.parse(init.body as string)).toEqual({
			project: "/data/repos/my-project",
			tokenLimit: 1000,
			period: "monthly",
		});
	});
});

describe("configuration", () => {
	it("uses FAN_API_URL and FAN_API_TOKEN from the environment by default", async () => {
		vi.stubEnv("FAN_API_URL", "http://fan.example:9999/");
		vi.stubEnv("FAN_API_TOKEN", "env-token");
		fetchMock.mockResolvedValue(jsonResponse({ sessions: [] }));
		const client = new FanApiClient();

		await client.getSessionList();

		const { url, init } = callArgs();
		expect(url.origin).toBe("http://fan.example:9999");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer env-token");
	});

	it("falls back to http://localhost:3456 when FAN_API_URL is not set", () => {
		vi.stubEnv("FAN_API_URL", "");
		const client = new FanApiClient();
		expect(client.baseUrl).toBe("http://localhost:3456");
	});
});

describe("error handling", () => {
	it("throws a descriptive FanApiError on HTTP 401", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: "Invalid token", code: "UNAUTHORIZED" }, 401));
		const client = createClient();

		const error = await client.getSessionList().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FanApiError);
		expect((error as FanApiError).status).toBe(401);
		expect((error as FanApiError).code).toBe("UNAUTHORIZED");
		expect((error as FanApiError).message).toMatch(/GET \/api\/sessions failed with HTTP 401: Invalid token/);
	});

	it("throws a descriptive FanApiError on HTTP 500 with a non-JSON body", async () => {
		fetchMock.mockResolvedValue(new Response("boom", { status: 500, statusText: "Internal Server Error" }));
		const client = createClient();

		const error = await client.createSession("/w").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FanApiError);
		expect((error as FanApiError).status).toBe(500);
		expect((error as FanApiError).message).toMatch(/POST \/api\/sessions failed with HTTP 500/);
	});

	it("fails on the first call when FAN_API_TOKEN is missing", async () => {
		vi.stubEnv("FAN_API_TOKEN", "");
		const client = new FanApiClient({ baseUrl: BASE_URL });

		await expect(client.getSessionList()).rejects.toThrowError(/FAN_API_TOKEN/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
