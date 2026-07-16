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
}

/**
 * Create a permission gate that blocks MCP tool calls based on server config.
 *
 * For each tool_call event with an MCP-namespaced tool name (mcp__<id>__<name>):
 * 1. Parse the server ID and tool name from the event.
 * 2. Look up the server config by array index (the server ID is the index as a string).
 * 3. If the server is not found in config, block defensively.
 * 4. Check deniedTools globs first and block if any match.
 * 5. Check allowedTools globs and block if no match (defaulting to ["*"]).
 * 6. Non-MCP tool names pass through unmodified.
 */
export function createPermissionGate(serverConfigs: McpServerConfig[] = []): PermissionGate {
	const byIndex = new Map<number, McpServerConfig>();
	serverConfigs.forEach((cfg, i) => byIndex.set(i, cfg));

	return {
		gate(event: ToolCallEvent): ToolCallEventResult {
			if (!("toolName" in event)) return {};
			const parsed = parseMcpToolName(event.toolName);
			if (!parsed) return {};
			const cfg = byIndex.get(Number(parsed.serverId));
			if (!cfg) {
				// Server not registered in config — defensive block
				return { block: true, reason: `MCP server id "${parsed.serverId}" not found in mcp.json` };
			}
			const denied = cfg.deniedTools ?? [];
			const matchDenied = denied.some((pattern) => matchGlob(event.toolName, pattern));
			if (matchDenied) {
				return {
					block: true,
					reason: `Tool ${parsed.tool} denied by server policy (deniedTools: ${denied.join(", ")})`,
				};
			}
			const allowed = cfg.allowedTools ?? ["*"];
			const matchAllowed = allowed.some((pattern) => matchGlob(event.toolName, pattern));
			if (!matchAllowed) {
				return {
					block: true,
					reason: `Tool ${parsed.tool} not in allowedTools for server id ${parsed.serverId}`,
				};
			}
			return {};
		},
	};
}

export function filterToolsByConfig<T extends { name: string }>(
	tools: T[],
	config: Pick<McpServerConfig, "allowedTools" | "deniedTools">,
): T[] {
	const allowed = config.allowedTools ?? ["*"];
	const denied = config.deniedTools ?? [];
	return tools.filter((t) => {
		const fullName = t.name;
		if (denied.some((pattern) => matchGlob(fullName, pattern))) return false;
		if (allowed.includes("*")) return true;
		return allowed.some((pattern) => matchGlob(fullName, pattern));
	});
}

function matchGlob(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return name === pattern;
	const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
	return regex.test(name);
}