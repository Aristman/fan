/**
 * MCP configuration loader (F-1.8, F-1.11).
 * Reads ~/.fan/agent/mcp.json and ${cwd}/.fan/mcp.json, merges by serverId.
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

export function createMcpConfigLoader(cwd: string = process.cwd()): ConfigLoader {
	return {
		async load(): Promise<McpConfig> {
			// Implementation lives in F-1.8
			return { servers: [] };
		},
	};
}