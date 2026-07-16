/**
 * MCP client manager (F-1.4, F-1.5, F-1.6, F-1.7, F-1.14, F-1.15, F-1.16, F-1.17).
 * Owns MCP Client instances per server, handles transport lifecycle, and
 * forwards tool calls to the FAN agent loop via the ExtensionAPI.
 */

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import type { McpConfig } from "./config.js";
import type { PermissionGate } from "./permissions.js";

export interface McpClientManager {
	connectAll(config: McpConfig): Promise<void>;
	dispose(): Promise<void>;
}

export function createMcpClientManager(pi: ExtensionAPI, permissions: PermissionGate): McpClientManager {
	return {
		async connectAll(_config) {
			// Implementation in F-1.4..F-1.17
		},
		async dispose() {
			// Implementation in F-1.14
		},
	};
}