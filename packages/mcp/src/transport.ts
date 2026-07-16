/**
 * StdioClientTransport factory (F-1.4) and StreamableHTTPClientTransport factory (F-1.5).
 *
 * F-1.4: Creates an @modelcontextprotocol/sdk StdioClientTransport from an McpServerConfig
 *        with transport === "stdio". Resolves ${ENV} references in config.env, or falls
 *        back to a minimal safe env vars whitelist when no env is configured.
 *
 * F-1.5: Creates an @modelcontextprotocol/sdk StreamableHTTPClientTransport from an
 *        McpServerConfig with transport === "streamable-http". Validates URL scheme
 *        (https only), loopback protection (allowLocal required for localhost/127.0.0.1/::1),
 *        and resolves ${ENV} references in config.headers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type McpServerConfig, resolveEnvVars } from "./config.js";
import { ensureValidToken, type OAuthToken, TokenStore } from "./oauth.js";

/**
 * Environment variables deemed safe to inherit when no custom env is provided.
 */
export const SAFE_ENV_VARS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USERPROFILE"] as const;

/**
 * Build the StdioServerParameters object from an McpServerConfig.
 *
 * Separated from `createStdioTransport` for easier unit testing.
 */
export function buildStdioParams(
	config: McpServerConfig,
	envSource: Record<string, string | undefined> = process.env,
): StdioServerParameters {
	if (config.transport !== "stdio") {
		throw new Error(`createStdioTransport: expected transport "stdio", got "${config.transport}"`);
	}
	if (!config.command) {
		throw new Error(`createStdioTransport: "command" is required for stdio transport`);
	}

	const env: Record<string, string> = config.env
		? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, resolveEnvVars(v, envSource)]))
		: Object.fromEntries(SAFE_ENV_VARS.filter((k) => envSource[k] !== undefined).map((k) => [k, envSource[k]!]));

	return {
		command: config.command,
		args: config.args,
		env,
	};
}

/**
 * Create a StdioClientTransport from an McpServerConfig.
 *
 * Validates that transport is "stdio" and command is provided, resolves
 * environment variables, and returns a ready-to-use transport instance.
 */
export function createStdioTransport(
	config: McpServerConfig,
	envSource: Record<string, string | undefined> = process.env,
): StdioClientTransport {
	const params = buildStdioParams(config, envSource);
	return new StdioClientTransport(params);
}

// ──────────────────────────────────────────────────
// F-1.5: StreamableHTTP transport
// ──────────────────────────────────────────────────

/**
 * Error thrown when transport configuration validation fails.
 */
export class TransportConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TransportConfigError";
	}
}

/**
 * Check if a hostname is a loopback address (127.0.0.0/8, ::1, localhost, 0.0.0.0).
 * Handles full IPv4 (4 octets), shorthand (2 or 3 octets like 127.1, 127.0.1),
 * and known hostname aliases.
 */
export function isLoopbackHostname(hostname: string): boolean {
	const LOOPBACK_SET = new Set(["localhost", "127.0.0.1", "::1"]);
	if (LOOPBACK_SET.has(hostname)) return true;
	if (hostname === "0.0.0.0" || hostname === "0") return true;
	// Parse dotted decimal: support 2-4 octet forms like 127.1 (shorthand for 127.0.0.1)
	const ipMatch = /^(\d+)(?:\.(\d+)(?:\.(\d+)(?:\.(\d+))?)?)?$/.exec(hostname);
	if (ipMatch) {
		const a = Number(ipMatch[1]);
		if (a === 127) return true;
		// 0.x.x.x is also treated as loopback on some systems
		if (a === 0) return true;
	}
	return false;
}

/**
 * Check if a hostname is a private network address.
 * RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * Also includes 169.254.0.0/16 (link-local) and 100.64.0.0/10 (CGNAT).
 */
export function isPrivateAddress(hostname: string): boolean {
	const ipMatch = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
	if (!ipMatch) return false;
	const a = Number(ipMatch[1]);
	const b = Number(ipMatch[2]);
	// 10.0.0.0/8
	if (a === 10) return true;
	// 172.16.0.0/12
	if (a === 172 && b >= 16 && b <= 31) return true;
	// 192.168.0.0/16
	if (a === 192 && b === 168) return true;
	// 169.254.0.0/16 (link-local)
	if (a === 169 && b === 254) return true;
	// 100.64.0.0/10 (CGNAT)
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

/**
 * Build and validate URL parameters for a StreamableHTTP transport config.
 *
 * Validates:
 * - transport must be "streamable-http"
 * - url is required
 * - url must be a valid URL
 * - url must use https: protocol
 * - loopback addresses require allowLocal: true
 * - private network addresses require allowPrivate: true (or allowLocal: true)
 */
export function buildHttpParams(config: McpServerConfig): URL {
	if (config.transport !== "streamable-http") {
		throw new TransportConfigError(
			`createHttpTransport: expected transport "streamable-http", got "${config.transport}"`,
		);
	}
	if (!config.url) {
		throw new TransportConfigError(`createHttpTransport: "url" is required for streamable-http transport`);
	}

	let url: URL;
	try {
		url = new URL(config.url);
	} catch {
		throw new TransportConfigError(`createHttpTransport: invalid URL "${config.url}"`);
	}

	if (!config.allowLocal && isLoopbackHostname(url.hostname)) {
		throw new TransportConfigError(`createHttpTransport: loopback URL "${config.url}" requires allowLocal: true`);
	}

	if (!config.allowLocal && !config.allowPrivate && isPrivateAddress(url.hostname)) {
		throw new TransportConfigError(
			`createHttpTransport: private network URL "${config.url}" requires allowPrivate: true or allowLocal: true`,
		);
	}

	if (url.protocol !== "https:") {
		throw new TransportConfigError(`createHttpTransport: only https URLs allowed, got "${url.protocol}"`);
	}

	return url;
}

/**
 * Get the path to the MCP tokens file.
 * Default: ~/.fan/agent/mcp-tokens.json
 */
export function getTokensPath(): string {
	return join(homedir(), ".fan", "agent", "mcp-tokens.json");
}

/**
 * Create a StreamableHTTPClientTransport from an McpServerConfig.
 *
 * Validates the config, resolves ${ENV} references in headers,
 * optionally acquires OAuth tokens for the server,
 * and returns a ready-to-use transport instance.
 */
export async function createHttpTransport(
	config: McpServerConfig,
	envSource: Record<string, string | undefined> = process.env,
): Promise<StreamableHTTPClientTransport> {
	const url = buildHttpParams(config);

	let accessToken: string | undefined;
	if (config.oauth) {
		const store = new TokenStore(getTokensPath());
		try {
			const token: OAuthToken = await ensureValidToken(config.oauth, url.hostname, store);
			accessToken = token.accessToken;
		} catch (e) {
			throw new TransportConfigError(`OAuth required for ${url.hostname}: ${e instanceof Error ? e.message : e}`);
		}
	}

	const headers = {
		...config.headers,
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	} as Record<string, string> | undefined;

	const resolvedHeaders = headers
		? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolveEnvVars(v, envSource)]))
		: undefined;

	return new StreamableHTTPClientTransport(url, {
		requestInit: { headers: resolvedHeaders },
	});
}
