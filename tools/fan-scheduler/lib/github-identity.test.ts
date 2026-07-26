import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isGitEnabled,
	maskedToken,
	resetGitHubIdentityCache,
	validateGitHubIdentity,
	validateToken,
} from "./github-identity.js";

const TOKEN = "ghp_secret-bot-token-abcdef123456";

type FetchMock = ReturnType<typeof vi.fn>;

let fetchMock: FetchMock;

function userResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	resetGitHubIdentityCache();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("TC-F-4.6-1: valid PAT is validated via GitHub API and cached", () => {
	it("returns gitEnabled=true with the extracted login on HTTP 200", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockResolvedValue(userResponse({ login: "fan-bot" }, 200, { "x-oauth-scopes": "repo, read:org" }));

		const identity = await validateToken();

		expect(identity.gitEnabled).toBe(true);
		expect(identity.login).toBe("fan-bot");
		expect(identity.scopes).toEqual(["repo", "read:org"]);
		expect(isGitEnabled()).toBe(true);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.github.com/user");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("serves repeat calls from the cache without another fetch", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockResolvedValue(userResponse({ login: "fan-bot" }));

		const first = await validateToken();
		const second = await validateToken();
		const third = await validateGitHubIdentity();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
		expect(third.gitEnabled).toBe(true);
		expect(third.login).toBe("fan-bot");
	});
});

describe("TC-F-4.6-2: missing GITHUB_TOKEN is handled gracefully", () => {
	it("returns gitEnabled=false without any network call and the scheduler keeps running", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const identity = await validateGitHubIdentity();

		expect(identity.gitEnabled).toBe(false);
		expect(identity.reason).toBe("GITHUB_TOKEN not configured");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(isGitEnabled()).toBe(false);

		// warning logged, no exception thrown — scheduler continues
		const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("WARN");
		expect(logged).toContain("GITHUB_TOKEN not configured");
		warnSpy.mockRestore();
	});
});

describe("invalid token (HTTP 401)", () => {
	it("returns gitEnabled=false with a descriptive error", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockResolvedValue(userResponse({ message: "Bad credentials" }, 401));

		const identity = await validateToken();

		expect(identity.gitEnabled).toBe(false);
		expect(identity.reason).toContain("HTTP 401");
		expect(identity.reason).toContain("repo");
		expect(isGitEnabled()).toBe(false);
	});
});

describe("network failure", () => {
	it("returns gitEnabled=false with the underlying error message", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

		const identity = await validateToken();

		expect(identity.gitEnabled).toBe(false);
		expect(identity.reason).toContain("ECONNREFUSED");
	});
});

describe("token masking — the raw token never appears in logs", () => {
	it("maskedToken keeps only the first 4 characters", () => {
		expect(maskedToken(TOKEN)).toBe("ghp_***");
		expect(maskedToken("abcd")).toBe("***");
		expect(maskedToken("ab")).toBe("***");
	});

	it("validateGitHubIdentity logs only the masked token on success", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockResolvedValue(userResponse({ login: "fan-bot" }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await validateGitHubIdentity();

		const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0])).join("\n");
		expect(logged).not.toContain(TOKEN);
		expect(logged).toContain("ghp_***");
		expect(logged).toContain("fan-bot");
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("no log line contains the raw token on failure either", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockResolvedValue(userResponse({ message: "Bad credentials" }, 401));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await validateGitHubIdentity();

		const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0])).join("\n");
		expect(logged).not.toContain(TOKEN);
		expect(logged).toContain("HTTP 401");
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

describe("scope check", () => {
	it("warns when the token lacks the minimum 'repo' scope", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		fetchMock.mockResolvedValue(userResponse({ login: "fan-bot" }, 200, { "x-oauth-scopes": "read:org" }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const identity = await validateGitHubIdentity();

		expect(identity.gitEnabled).toBe(true);
		expect(identity.reason).toContain("repo");
		const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(logged).toContain("WARN");
		expect(logged).not.toContain(TOKEN);
		logSpy.mockRestore();
	});
});
