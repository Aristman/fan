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

import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveEnvVars, type McpServerConfig } from "./config.js";

/**
 * Environment variables deemed safe to inherit when no custom env is provided.
 */
export const SAFE_ENV_VARS = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"USERPROFILE",
] as const;

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
		throw new Error(
			`createStdioTransport: expected transport "stdio", got "${config.transport}"`,
		);
	}
	if (!config.command) {
		throw new Error(
			`createStdioTransport: "command" is required for stdio transport`,
		);
	}

	const env: Record<string, string> = config.env
		? Object.fromEntries(
				Object.entries(config.env).map(([k, v]) => [
					k,
					resolveEnvVars(v, envSource),
				]),
			)
		: Object.fromEntries(
				SAFE_ENV_VARS.filter((k) => envSource[k] !== undefined).map((k) => [
					k,
					envSource[k]!,
				]),
			);

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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Build and validate URL parameters for a StreamableHTTP transport config.
 *
 * Validates:
 * - transport must be "streamable-http"
 * - url is required
 * - url must be a valid URL
 * - url must use https: protocol
 * - loopback addresses require allowLocal: true
 */
export function buildHttpParams(config: McpServerConfig): URL {
	if (config.transport !== "streamable-http") {
		throw new TransportConfigError(
			`createHttpTransport: expected transport "streamable-http", got "${config.transport}"`,
		);
	}
	if (!config.url) {
		throw new TransportConfigError(
			`createHttpTransport: "url" is required for streamable-http transport`,
		);
	}

	let url: URL;
	try {
		url = new URL(config.url);
	} catch {
		throw new TransportConfigError(
			`createHttpTransport: invalid URL "${config.url}"`,
		);
	}

	if (
		!config.allowLocal &&
		LOOPBACK_HOSTNAMES.has(url.hostname)
	) {
		throw new TransportConfigError(
			`createHttpTransport: loopback URL "${config.url}" requires allowLocal: true`,
		);
	}

	if (url.protocol !== "https:") {
		throw new TransportConfigError(
			`createHttpTransport: only https URLs allowed, got "${url.protocol}"`,
		);
	}

	return url;
}

/**
 * Create a StreamableHTTPClientTransport from an McpServerConfig.
 *
 * Validates the config, resolves ${ENV} references in headers,
 * and returns a ready-to-use transport instance.
 */
export function createHttpTransport(
	config: McpServerConfig,
	envSource: Record<string, string | undefined> = process.env,
): StreamableHTTPClientTransport {
	const url = buildHttpParams(config);

	const headers = config.headers
		? Object.fromEntries(
				Object.entries(config.headers).map(([k, v]) => [
					k,
					resolveEnvVars(v, envSource),
				]),
			)
		: undefined;

	return new StreamableHTTPClientTransport(url, {
		requestInit: { headers },
	});
}
