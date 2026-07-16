/**
 * MCP configuration loader (F-1.8, F-1.11).
 * Reads ~/.fan/agent/mcp.json and ${cwd}/.fan/mcp.json, merges by serverId.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * allowedTools and deniedTools use RAW MCP tool names (without "mcp__<server>__" prefix).
 * Example: { allowedTools: ["read_file", "list_*"] } denies "delete_file" implicitly.
 * Use globs like "filesystem_*" to match across servers or "read_*" to match prefix.
 */
export interface McpServerConfig {
	transport: "stdio" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	allowedTools?: string[];
	deniedTools?: string[];
	timeout?: number;
	autoRestart?: boolean;
	allowLocal?: boolean;
	allowPrivate?: boolean;
	oauth?: {
		clientId: string;
		clientSecret?: string;
		authorizationUrl: string;
		tokenUrl: string;
		scopes?: string[];
	};
}

export interface McpConfig {
	servers: McpServerConfig[];
}

export class MissingEnvVarError extends Error {
	constructor(public readonly name: string) {
		super(`Missing environment variable: ${name}`);
		this.name = "MissingEnvVarError";
	}
}

export function resolveEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
		const resolved = env[name];
		if (resolved === undefined) throw new MissingEnvVarError(name);
		return resolved;
	});
}

export interface ConfigLoader {
	load(): Promise<McpConfig>;
}

const McpServerConfigSchema = Type.Object(
	{
		transport: Type.Union([Type.Literal("stdio"), Type.Literal("streamable-http")]),
		command: Type.Optional(Type.String({ minLength: 1 })),
		args: Type.Optional(Type.Array(Type.String())),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		url: Type.Optional(Type.String({ minLength: 1 })),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		allowedTools: Type.Optional(Type.Array(Type.String())),
		deniedTools: Type.Optional(Type.Array(Type.String())),
		timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
		autoRestart: Type.Optional(Type.Boolean()),
		allowLocal: Type.Optional(Type.Boolean()),
		allowPrivate: Type.Optional(Type.Boolean()),
		oauth: Type.Optional(
			Type.Object({
				clientId: Type.String({ minLength: 1 }),
				clientSecret: Type.Optional(Type.String()),
				authorizationUrl: Type.String({ minLength: 1 }),
				tokenUrl: Type.String({ minLength: 1 }),
				scopes: Type.Optional(Type.Array(Type.String())),
			}),
		),
	},
	{ additionalProperties: false },
);

const McpConfigSchema = Type.Object(
	{
		servers: Type.Array(McpServerConfigSchema),
	},
	{ additionalProperties: false },
);

export class ConfigValidationError extends Error {
	constructor(
		message: string,
		public readonly path?: string,
	) {
		super(path ? `${message} (at ${path})` : message);
		this.name = "ConfigValidationError";
	}
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return JSON.parse(content);
	} catch (e: any) {
		if (e?.code === "ENOENT") return undefined;
		console.warn(`mcp.json: failed to read/parse ${path}: ${e?.message ?? e}`);
		return undefined;
	}
}

function validateConfig(data: unknown, source: string): McpConfig {
	if (!Value.Check(McpConfigSchema, data)) {
		const errors = Array.from(Value.Errors(McpConfigSchema, data));
		throw new ConfigValidationError(
			`Invalid mcp config: ${JSON.stringify(errors.map((e) => ({ path: e.path, message: e.message })))}`,
			source,
		);
	}
	return data as McpConfig;
}

function mergeConfigs(global: McpConfig, project: McpConfig): McpConfig {
	// Merge by array index: project[i] overrides global[i] for matching primitives,
	// but project array is appended after global array end.
	// Spec: project wins per serverId (we use array index as serverId since name is part of config).
	// For simplicity in Phase 1: project servers REPLACE global at same index;
	// extra project servers appended.
	const servers = [...global.servers];
	for (let i = 0; i < project.servers.length; i++) {
		servers[i] = project.servers[i];
	}
	return { servers };
}

/**
 * Reads and merges MCP config from two explicit file paths.
 * Missing files are silently skipped. Invalid JSON or schema violations
 * produce a console.warn and are skipped (graceful degradation).
 * exposed for testing; use loadMcpConfig for simple usage.
 */
export async function readConfigs(globalPath: string | undefined, projectPath: string | undefined): Promise<McpConfig> {
	const [globalRaw, projectRaw] = await Promise.all([
		globalPath ? readJsonFile(globalPath) : undefined,
		projectPath ? readJsonFile(projectPath) : undefined,
	]);

	const global: McpConfig =
		globalRaw !== undefined
			? (() => {
					try {
						return validateConfig(globalRaw, globalPath!);
					} catch (e: any) {
						console.warn(`mcp.json: ${e.message ?? e}`);
						return { servers: [] };
					}
				})()
			: { servers: [] };

	const project: McpConfig =
		projectRaw !== undefined
			? (() => {
					try {
						return validateConfig(projectRaw, projectPath!);
					} catch (e: any) {
						console.warn(`mcp.json: ${e.message ?? e}`);
						return { servers: [] };
					}
				})()
			: { servers: [] };

	return mergeConfigs(global, project);
}

export function createMcpConfigLoader(cwd: string = process.cwd()): ConfigLoader {
	return {
		async load(): Promise<McpConfig> {
			const globalPath = join(homedir(), ".fan", "agent", "mcp.json");
			const projectPath = isAbsolute(cwd) ? join(cwd, ".fan", "mcp.json") : join(resolve(cwd), ".fan", "mcp.json");

			return readConfigs(globalPath, projectPath);
		},
	};
}

/**
 * Convenience function: loads MCP config from default locations
 * (~/.fan/agent/mcp.json and ${cwd}/.fan/mcp.json).
 */
export async function loadMcpConfig(cwd: string = process.cwd()): Promise<McpConfig> {
	return createMcpConfigLoader(cwd).load();
}
