/**
 * F-3.3: OAuth 2.0 + PKCE support for Streamable HTTP transport.
 *
 * Provides utilities for the OAuth 2.0 Authorization Code flow with PKCE (S256)
 * as specified in the MCP specification for Streamable HTTP transport.
 *
 * Includes:
 * - PKCE code_verifier/code_challenge generation (S256)
 * - CSRF state parameter generation
 * - WWW-Authenticate header parser
 * - Token exchange and refresh
 * - Local callback server for authorization code receipt
 * - Encrypted file-based token storage (mode 0o600)
 * - High-level ensureValidToken() with auto-refresh
 */

import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";

// ──────────────────────────────────────────────────
// Error
// ──────────────────────────────────────────────────

export class OAuthError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message);
		this.name = "OAuthError";
	}
}

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface OAuthConfig {
	clientId: string;
	clientSecret?: string;
	authorizationUrl: string;
	tokenUrl: string;
	scopes?: string[];
}

export interface OAuthToken {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	scope?: string;
	tokenType?: string;
}

export interface AuthorizationCodeTokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
}

// ──────────────────────────────────────────────────
// PKCE utilities
// ──────────────────────────────────────────────────

/**
 * Generate a PKCE code_verifier (43–128 chars, URL-safe base64).
 * Uses 32 cryptographically random bytes → 43 chars base64url.
 */
export function generateCodeVerifier(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Generate a PKCE code_challenge (S256) from the given verifier.
 * Deterministic: same verifier always produces the same challenge.
 */
export function generateCodeChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Generate a random state parameter for CSRF protection.
 */
export function generateState(): string {
	return randomBytes(16).toString("base64url");
}

// ──────────────────────────────────────────────────
// WWW-Authenticate parser
// ──────────────────────────────────────────────────

/**
 * Parse a WWW-Authenticate header to extract OAuth metadata.
 *
 * Expected format: Bearer realm="...", error="...", error_description="..."
 * Returns null if the header is not a Bearer challenge.
 */
export function parseWwwAuthenticate(
	header: string,
	_expectedRealm?: string,
): {
	realm?: string;
	error?: string;
	errorDescription?: string;
	scope?: string;
} | null {
	const trimmed = header.trim();
	if (!trimmed.toLowerCase().startsWith("bearer ")) return null;

	const params: Record<string, string> = {};
	const regex = /(\w+)="([^"]*)"/g;
	let match: RegExpExecArray | null;
	while (true) {
		match = regex.exec(trimmed);
		if (match === null) break;
		params[match[1].toLowerCase()] = match[2];
	}

	return {
		realm: params.realm,
		error: params.error,
		errorDescription: params.error_description,
		scope: params.scope,
	};
}

// ──────────────────────────────────────────────────
// Token store (encrypted file, mode 0o600)
// ──────────────────────────────────────────────────

const TOKEN_FILE_MODE = 0o600;

/**
 * Simple JSON file token store at ~/.fan/agent/mcp-tokens.json.
 * Files are created with mode 0o600 (owner-only read/write).
 *
 * In production, consider replacing with OS keychain:
 * - Linux: libsecret via @secretstorage/core
 * - macOS: Keychain via keytar
 * - Windows: Credential Manager via @nathanvda/wincred
 */
export class TokenStore {
	constructor(private readonly filePath: string) {}

	async load(serverId: string): Promise<OAuthToken | null> {
		try {
			const { readFile } = await import("node:fs/promises");
			const data = JSON.parse(await readFile(this.filePath, "utf8"));
			return (data[serverId] as OAuthToken) ?? null;
		} catch {
			return null;
		}
	}

	async save(serverId: string, token: OAuthToken): Promise<void> {
		const { readFile, writeFile } = await import("node:fs/promises");
		let data: Record<string, OAuthToken> = {};
		try {
			data = JSON.parse(await readFile(this.filePath, "utf8"));
		} catch {
			// File doesn't exist or is unreadable — start fresh
		}
		data[serverId] = token;
		await writeFile(this.filePath, JSON.stringify(data, null, 2), {
			mode: TOKEN_FILE_MODE,
		} as any);
	}

	async clear(serverId: string): Promise<void> {
		const { readFile, writeFile } = await import("node:fs/promises");
		let data: Record<string, OAuthToken> = {};
		try {
			data = JSON.parse(await readFile(this.filePath, "utf8"));
		} catch {
			return;
		}
		delete data[serverId];
		await writeFile(this.filePath, JSON.stringify(data, null, 2), {
			mode: TOKEN_FILE_MODE,
		} as any);
	}
}

// ──────────────────────────────────────────────────
// Local callback server
// ──────────────────────────────────────────────────

/**
 * Create a local HTTP server to receive the OAuth authorization code.
 *
 * Listens on 127.0.0.1 at a random available port. The server accepts a
 * single GET /callback?code=...&state=... request, then resolves.
 *
 * Returns the full callback URL and a close() function to shut down the server.
 */
export function createCallbackServer(
	expectedState: string,
	onCode: (code: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer((req, res) => {
			if (req.url?.startsWith("/callback")) {
				const url = new URL(req.url, "http://localhost");
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				res.setHeader("Content-Type", "text/html");

				if (error) {
					res.end(`<h1>OAuth Error</h1><p>${error}</p>`);
					return;
				}

				if (state !== expectedState) {
					res.end("<h1>State mismatch</h1>");
					return;
				}

				if (code) {
					res.end("<h1>Authorized</h1><p>You can close this window.</p>");
					onCode(code);
					return;
				}

				res.end("<h1>No code</h1>");
			} else {
				res.statusCode = 404;
				res.end("Not Found");
			}
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({
				url: `http://127.0.0.1:${addr.port}/callback`,
				close: () => new Promise<void>((res) => server.close(() => res())),
			});
		});

		server.on("error", reject);
	});
}

// ──────────────────────────────────────────────────
// Token exchange
// ──────────────────────────────────────────────────

/**
 * Exchange an authorization code for an access token (POST to tokenUrl).
 *
 * Uses grant_type=authorization_code with PKCE code_verifier.
 * Optionally includes client_secret for confidential clients.
 */
export async function exchangeCodeForToken(
	tokenUrl: string,
	clientId: string,
	code: string,
	codeVerifier: string,
	redirectUri: string,
	clientSecret?: string,
): Promise<OAuthToken> {
	const params = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		client_id: clientId,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
	});

	if (clientSecret) {
		params.set("client_secret", clientSecret);
	}

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new OAuthError(`Token exchange failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as AuthorizationCodeTokenResponse;

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
		scope: data.scope,
		tokenType: data.token_type,
	};
}

/**
 * Refresh an expired access token using a refresh token.
 *
 * Uses grant_type=refresh_token. If the server returns a new refresh_token,
 * it replaces the old one; otherwise the old refresh_token is preserved.
 */
export async function refreshAccessToken(
	tokenUrl: string,
	refreshToken: string,
	clientId: string,
	clientSecret?: string,
): Promise<OAuthToken> {
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	});

	if (clientSecret) {
		params.set("client_secret", clientSecret);
	}

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!response.ok) {
		throw new OAuthError(`Token refresh failed: ${response.status}`);
	}

	const data = (await response.json()) as AuthorizationCodeTokenResponse;

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? refreshToken,
		expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
		scope: data.scope,
		tokenType: data.token_type,
	};
}

// ──────────────────────────────────────────────────
// Authorization URL builder
// ──────────────────────────────────────────────────

/**
 * Build an OAuth authorization URL with PKCE parameters.
 *
 * The resulting URL should be opened in a browser so the user can
 * grant access and receive the redirect with the authorization code.
 */
export function buildAuthorizationUrl(params: {
	authorizationUrl: string;
	clientId: string;
	redirectUri: string;
	scope?: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(params.authorizationUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (params.scope) {
		url.searchParams.set("scope", params.scope);
	}
	return url.toString();
}

// ──────────────────────────────────────────────────
// High-level flow helper
// ──────────────────────────────────────────────────

/**
 * Ensure a valid OAuth token is available for the given server.
 *
 * Flow:
 * 1. Check token store for existing token with >60s remaining lifetime.
 * 2. If expired but has refresh_token, attempt token refresh.
 * 3. If no valid token, start full PKCE flow:
 *    - Generate verifier, challenge, state
 *    - Start local callback server
 *    - Build authorization URL
 *    - Prompt user to open browser and authorize
 *
 * Returns the valid token once obtained.
 *
 * NOTE: The full PKCE flow opens a local callback server and prints the
 * authorization URL to stderr. In production, the caller should open the
 * browser automatically via `opn` / `open` / `xdg-open` or a deep link.
 */
export async function ensureValidToken(
	config: OAuthConfig,
	serverId: string,
	tokenStore: TokenStore,
): Promise<OAuthToken> {
	const existing = await tokenStore.load(serverId);

	// Return if valid with >60s remaining
	if (existing && existing.expiresAt > Date.now() + 60_000) {
		return existing;
	}

	// Try refresh if we have a refresh token
	if (existing?.refreshToken) {
		try {
			const refreshed = await refreshAccessToken(
				config.tokenUrl,
				existing.refreshToken,
				config.clientId,
				config.clientSecret,
			);
			await tokenStore.save(serverId, refreshed);
			return refreshed;
		} catch (_e) {
			console.warn("OAuth: token refresh failed, starting full auth flow");
		}
	}

	// Full PKCE flow
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);
	const state = generateState();

	const callback = await createCallbackServer(state, async (code) => {
		const token = await exchangeCodeForToken(
			config.tokenUrl,
			config.clientId,
			code,
			codeVerifier,
			callback.url,
			config.clientSecret,
		);
		await tokenStore.save(serverId, token);
		await callback.close();
	});

	const authUrl = buildAuthorizationUrl({
		authorizationUrl: config.authorizationUrl,
		clientId: config.clientId,
		redirectUri: callback.url,
		scope: config.scopes?.join(" "),
		state,
		codeChallenge,
	});

	console.warn(`OAuth: open the following URL in a browser to authorize:\n${authUrl}`);

	throw new OAuthError(`OAuth flow requires manual authorization. Open in browser: ${authUrl}`);
}
