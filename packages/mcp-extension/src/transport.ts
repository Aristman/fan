/**
 * StdioClientTransport factory (F-1.4).
 *
 * Creates an @modelcontextprotocol/sdk StdioClientTransport from an McpServerConfig
 * with transport === "stdio". Resolves ${ENV} references in config.env, or falls
 * back to a minimal safe env vars whitelist when no env is configured.
 */

import {
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
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
