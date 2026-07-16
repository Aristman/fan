/**
 * F-3.3: OAuth 2.0 + PKCE tests for oauth.ts.
 *
 * Tests cover:
 * - PKCE utility functions (generation, determinism)
 * - WWW-Authenticate header parsing
 * - Authorization URL construction (PKCE params)
 * - Token exchange with fetch mock
 * - TokenStore persistence (file read/write)
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildAuthorizationUrl,
	exchangeCodeForToken,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	OAuthError,
	parseWwwAuthenticate,
	TokenStore,
} from "../src/oauth.js";

// ──────────────────────────────────────────────────
// PKCE utilities
// ──────────────────────────────────────────────────

describe("F-3.3: PKCE utilities", () => {
	it("generateCodeVerifier returns 43-char base64url string", () => {
		const v = generateCodeVerifier();
		expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("generateCodeVerifier produces different values each call", () => {
		const v1 = generateCodeVerifier();
		const v2 = generateCodeVerifier();
		expect(v1).not.toBe(v2);
	});

	it("generateCodeChallenge returns base64url string", () => {
		const v = "abc123def456";
		const c = generateCodeChallenge(v);
		expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("generateCodeChallenge is deterministic", () => {
		expect(generateCodeChallenge("test")).toBe(generateCodeChallenge("test"));
	});

	it("generateCodeChallenge differs for different inputs", () => {
		const c1 = generateCodeChallenge("input-a");
		const c2 = generateCodeChallenge("input-b");
		expect(c1).not.toBe(c2);
	});

	it("generateState returns random URL-safe string", () => {
		const s1 = generateState();
		const s2 = generateState();
		expect(s1).not.toBe(s2);
		expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

// ──────────────────────────────────────────────────
// WWW-Authenticate parser
// ──────────────────────────────────────────────────

describe("F-3.3: parseWwwAuthenticate", () => {
	it("parses Bearer with realm", () => {
		const parsed = parseWwwAuthenticate('Bearer realm="example.com"');
		expect(parsed).not.toBeNull();
		expect(parsed?.realm).toBe("example.com");
	});

	it("parses Bearer with error and error_description", () => {
		const parsed = parseWwwAuthenticate('Bearer realm="x", error="invalid_token", error_description="Token expired"');
		expect(parsed?.error).toBe("invalid_token");
		expect(parsed?.errorDescription).toBe("Token expired");
	});

	it("parses Bearer with scope", () => {
		const parsed = parseWwwAuthenticate('Bearer realm="x", scope="read write"');
		expect(parsed?.scope).toBe("read write");
	});

	it("returns null for non-Bearer header", () => {
		expect(parseWwwAuthenticate('Basic realm="x"')).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseWwwAuthenticate("")).toBeNull();
	});

	it("handles case-insensitive Bearer prefix", () => {
		const parsed = parseWwwAuthenticate('bearer realm="test"');
		expect(parsed?.realm).toBe("test");
	});
});

// ──────────────────────────────────────────────────
// Authorization URL builder
// ──────────────────────────────────────────────────

describe("F-3.3: buildAuthorizationUrl", () => {
	it("includes all PKCE params", () => {
		const url = buildAuthorizationUrl({
			authorizationUrl: "https://auth.example.com/authorize",
			clientId: "client-abc",
			redirectUri: "http://localhost:9000/callback",
			scope: "read:user",
			state: "state-xyz",
			codeChallenge: "challenge-123",
		});

		expect(url).toContain("response_type=code");
		expect(url).toContain("client_id=client-abc");
		expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A9000%2Fcallback");
		expect(url).toContain("state=state-xyz");
		expect(url).toContain("code_challenge=challenge-123");
		expect(url).toContain("code_challenge_method=S256");
		expect(url).toContain("scope=read%3Auser");
	});

	it("builds valid URL from authorizationUrl", () => {
		const url = buildAuthorizationUrl({
			authorizationUrl: "https://auth.example.com/authorize",
			clientId: "id",
			redirectUri: "http://localhost:9999/cb",
			state: "s1",
			codeChallenge: "cc1",
		});
		expect(() => new URL(url)).not.toThrow();
	});

	it("omits scope if not provided", () => {
		const url = buildAuthorizationUrl({
			authorizationUrl: "https://auth.example.com/authorize",
			clientId: "id",
			redirectUri: "http://localhost:9999/cb",
			state: "s1",
			codeChallenge: "cc1",
		});
		expect(url).not.toContain("scope=");
	});
});

// ──────────────────────────────────────────────────
// Token exchange
// ──────────────────────────────────────────────────

describe("F-3.3: exchangeCodeForToken", () => {
	it("sends PKCE verifier and returns token", async () => {
		const fakeFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "abc",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "def",
				scope: "read",
			}),
		});

		const origFetch = globalThis.fetch;
		(globalThis as any).fetch = fakeFetch;

		try {
			const token = await exchangeCodeForToken(
				"https://auth.example.com/token",
				"client-abc",
				"auth-code-xyz",
				"verifier-abc",
				"http://localhost:9000/callback",
			);

			expect(token.accessToken).toBe("abc");
			expect(token.refreshToken).toBe("def");
			expect(token.tokenType).toBe("Bearer");
			expect(token.scope).toBe("read");
			expect(token.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);

			const args = fakeFetch.mock.calls[0];
			expect(args[0]).toBe("https://auth.example.com/token");
			expect(args[1].method).toBe("POST");
			const body = new URLSearchParams(args[1].body);
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code_verifier")).toBe("verifier-abc");
			expect(body.get("code")).toBe("auth-code-xyz");
			expect(body.get("client_id")).toBe("client-abc");
		} finally {
			(globalThis as any).fetch = origFetch;
		}
	});

	it("includes client_secret when provided", async () => {
		const fakeFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "abc",
				expires_in: 3600,
			}),
		});

		const origFetch = globalThis.fetch;
		(globalThis as any).fetch = fakeFetch;

		try {
			await exchangeCodeForToken(
				"https://auth.example.com/token",
				"client-abc",
				"code",
				"verifier",
				"http://localhost/cb",
				"secret-456",
			);

			const body = new URLSearchParams(fakeFetch.mock.calls[0][1].body);
			expect(body.get("client_secret")).toBe("secret-456");
		} finally {
			(globalThis as any).fetch = origFetch;
		}
	});

	it("omits client_secret when not provided", async () => {
		const fakeFetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "abc",
				expires_in: 3600,
			}),
		});

		const origFetch = globalThis.fetch;
		(globalThis as any).fetch = fakeFetch;

		try {
			await exchangeCodeForToken(
				"https://auth.example.com/token",
				"client-abc",
				"code",
				"verifier",
				"http://localhost/cb",
			);

			const body = new URLSearchParams(fakeFetch.mock.calls[0][1].body);
			expect(body.get("client_secret")).toBeNull();
		} finally {
			(globalThis as any).fetch = origFetch;
		}
	});

	it("throws OAuthError on non-OK response", async () => {
		const fakeFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => "invalid_grant",
		});

		const origFetch = globalThis.fetch;
		(globalThis as any).fetch = fakeFetch;

		try {
			await expect(exchangeCodeForToken("url", "id", "code", "verifier", "redirect")).rejects.toThrow(
				/Token exchange failed/,
			);
		} finally {
			(globalThis as any).fetch = origFetch;
		}
	});

	it("throws OAuthError with error class", async () => {
		const fakeFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => "invalid_grant",
		});

		const origFetch = globalThis.fetch;
		(globalThis as any).fetch = fakeFetch;

		try {
			await expect(exchangeCodeForToken("url", "id", "code", "verifier", "redirect")).rejects.toBeInstanceOf(
				OAuthError,
			);
		} finally {
			(globalThis as any).fetch = origFetch;
		}
	});
});

// ──────────────────────────────────────────────────
// TokenStore persistence
// ──────────────────────────────────────────────────

describe("F-3.3: TokenStore", () => {
	it("save and load roundtrip", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmp = await mkdtemp(path.join(os.tmpdir(), "token-store-"));
		const filePath = path.join(tmp, "tokens.json");
		const store = new TokenStore(filePath);

		await store.save("server-1", {
			accessToken: "tok-1",
			expiresAt: Date.now() + 60000,
		});

		const loaded = await store.load("server-1");
		expect(loaded).not.toBeNull();
		expect(loaded?.accessToken).toBe("tok-1");

		const missing = await store.load("server-2");
		expect(missing).toBeNull();
	});

	it("load returns null for non-existent file", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmp = await mkdtemp(path.join(os.tmpdir(), "token-store-"));
		const filePath = path.join(tmp, "no-such-file.json");
		const store = new TokenStore(filePath);

		const result = await store.load("any-server");
		expect(result).toBeNull();
	});

	it("save overwrites existing entry for same serverId", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmp = await mkdtemp(path.join(os.tmpdir(), "token-store-"));
		const filePath = path.join(tmp, "tokens.json");
		const store = new TokenStore(filePath);

		await store.save("server-1", {
			accessToken: "tok-old",
			expiresAt: 0,
		});
		await store.save("server-1", {
			accessToken: "tok-new",
			expiresAt: 999,
		});

		const loaded = await store.load("server-1");
		expect(loaded?.accessToken).toBe("tok-new");
	});

	it("clear removes entry", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmp = await mkdtemp(path.join(os.tmpdir(), "token-store-"));
		const filePath = path.join(tmp, "tokens.json");
		const store = new TokenStore(filePath);

		await store.save("server-1", {
			accessToken: "tok-1",
			expiresAt: 123,
		});
		await store.save("server-2", {
			accessToken: "tok-2",
			expiresAt: 456,
		});

		await store.clear("server-1");

		const loaded1 = await store.load("server-1");
		expect(loaded1).toBeNull();

		const loaded2 = await store.load("server-2");
		expect(loaded2?.accessToken).toBe("tok-2");
	});
});

// ──────────────────────────────────────────────────
// OAuthError
// ──────────────────────────────────────────────────

describe("F-3.3: OAuthError", () => {
	it("has name 'OAuthError'", () => {
		const err = new OAuthError("test");
		expect(err.name).toBe("OAuthError");
	});

	it("carries optional code", () => {
		const err = new OAuthError("unauthorized", "invalid_token");
		expect(err.code).toBe("invalid_token");
	});

	it("defaults code to undefined", () => {
		const err = new OAuthError("test");
		expect(err.code).toBeUndefined();
	});
});
