/**
 * Permission gate for MCP tool calls (F-1.9, F-1.10).
 * Filters tools via allowedTools/deniedTools and blocks denied calls via the
 * `tool_call` event hook.
 */

import type { ToolCallEvent, ToolCallEventResult } from "@seaagents/fan-coding-agent";
import type { McpServerConfig } from "./config.js";

export interface PermissionGate {
	gate(event: ToolCallEvent): ToolCallEventResult;
}

export function createPermissionGate(): PermissionGate {
	return {
		gate(event: ToolCallEvent): ToolCallEventResult {
			// Implementation in F-1.10
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