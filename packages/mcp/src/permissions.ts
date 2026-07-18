/**
 * Permission gate for MCP tool calls (F-1.9, F-1.10).
 * Filters tools via allowedTools/deniedTools and blocks denied calls via the
 * `tool_call` event hook.
 */

import type { ToolCallEvent, ToolCallEventResult } from "@seaagents/fan-coding-agent";
import type { McpServerConfig } from "./config.js";

// Regex matches mcp__<serverId>__<toolName>
// serverId is everything after the first "mcp__" up to the last "__"
// tool is everything after that last "__"
const MCP_TOOL_RE = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

/**
 * Validate that a server ID is a non-negative integer decimal string.
 * Prevents Number() coercion aliases like "0e0", "-0", "+1", "  ".
 */
export function isValidServerId(id: string): boolean {
	return /^\d+$/.test(id);
}

/**
 * Parse an MCP-normalized tool name into its server ID and tool name components.
 * Returns null if the name is not in MCP namespace format.
 */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
	const m = MCP_TOOL_RE.exec(name);
	if (!m) return null;
	return { serverId: m[1], tool: m[2] };
}

export interface PermissionGate {
	gate(event: ToolCallEvent): ToolCallEventResult;
	updateConfig(servers: McpServerConfig[]): void;
}

/**
 * Create a permission gate that blocks MCP tool calls based on server config.
 *
 * For each tool_call event with an MCP-namespaced tool name (mcp__<id>__<name>):
 * 1. Parse the server ID and tool name from the event.
 * 2. Look up the server config by array index (the server ID is the index as a string).
 * 3. If the server is not found in config, block defensively.
 * 4. Check deniedTools globs first and block if any match.
 * 5. Check allowedTools globs and block if no match (defaulting to ["*"]). *
 * 6. Non-MCP tool names pass through unmodified.
 *
 * Note: allowedTools/deniedTools use RAW tool names (without "mcp__<server>__" prefix).
 * Example: { deniedTools: ["delete_file"] } matches the tool name "delete_file" parsed
 * from the full name "mcp__0__delete_file".
 */
export function createPermissionGate(serverConfigs: McpServerConfig[] = []): PermissionGate {
	const byIndex = new Map<number, McpServerConfig>();
	for (let i = 0; i < serverConfigs.length; i++) {
		byIndex.set(i, serverConfigs[i]);
	}

	return {
		gate(event: ToolCallEvent): ToolCallEventResult {
			if (!("toolName" in event)) return {};
			const parsed = parseMcpToolName(event.toolName);
			if (!parsed) return {};
			if (!isValidServerId(parsed.serverId)) {
				return { block: true, reason: `Invalid server ID format: "${parsed.serverId}"` };
			}
			const cfg = byIndex.get(Number(parsed.serverId));
			if (!cfg) {
				// Server not registered in config — defensive block
				return { block: true, reason: `MCP server id "${parsed.serverId}" not found in mcp.json` };
			}
			const denied = cfg.deniedTools ?? [];
			const matchDenied = denied.some((pattern) => matchGlob(parsed.tool, pattern));
			if (matchDenied) {
				return {
					block: true,
					reason: `Tool ${parsed.tool} denied by server policy (deniedTools: ${denied.join(", ")})`,
				};
			}
			const allowed = cfg.allowedTools ?? ["*"];
			const matchAllowed = allowed.some((pattern) => matchGlob(parsed.tool, pattern));
			if (!matchAllowed) {
				return {
					block: true,
					reason: `Tool ${parsed.tool} not in allowedTools for server id ${parsed.serverId}`,
				};
			}
			return {};
		},
		updateConfig(servers: McpServerConfig[]): void {
			byIndex.clear();
			for (let i = 0; i < servers.length; i++) {
				byIndex.set(i, servers[i]);
			}
		},
	};
}

export function filterToolsByConfig<T extends { name: string }>(
	tools: T[],
	config: Pick<McpServerConfig, "allowedTools" | "deniedTools">,
): T[] {
	const allowed = config.allowedTools ?? ["*"];
	const denied = config.deniedTools ?? [];
	for (const t of tools) {
		if (t.name.includes("__") && !t.name.startsWith("mcp__")) {
			console.warn(
				`filterToolsByConfig: tool name "${t.name}" contains "__" — ` +
					`did you mean just "${t.name.split("__").pop()}"? ` +
					`(allowedTools/deniedTools use RAW tool names without mcp__ prefix)`,
			);
		}
	}
	return tools.filter((t) => {
		const rawName = t.name;
		if (denied.some((pattern) => matchGlob(rawName, pattern))) return false;
		if (allowed.includes("*")) return true;
		return allowed.some((pattern) => matchGlob(rawName, pattern));
	});
}

const MAX_GLOB_PATTERN_LENGTH = 256;
const MAX_GLOB_ASTERISKS = 10;

function matchGlob(name: string, pattern: string): boolean {
	if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
		console.warn(`matchGlob: pattern exceeds max length`);
		return false;
	}
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;

	// Count asterisks — too many wildcards can cause ReDoS via catastrophic backtracking
	const asteriskCount = (pattern.match(/\*/g) ?? []).length;
	if (asteriskCount > MAX_GLOB_ASTERISKS) {
		// Convert to safe (non-regex) matching: split by "*" and verify each part is a substring
		return pattern.split("*").every((part) => part === "" || name.includes(part));
	}

	const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
	return regex.test(name);
}
