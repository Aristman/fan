/**
 * FAN MCP Integration — Main extension factory.
 *
 * Connects FAN to external Model Context Protocol (MCP) servers and exposes
 * their tools as native FAN AgentTools.
 *
 * Configuration:
 *   - Global: ~/.fan/agent/mcp.json
 *   - Project: .fan/mcp.json (project wins per serverId)
 *
 * Tools registered: one AgentTool per MCP tool, named `mcp__<serverId>__<toolName>`.
 * Lifecycle: connect on session_start, disconnect on session_shutdown.
 *
 * Phase 1 (this file): Extension skeleton + lifecycle hooks. Tools are
 * registered in later sub-functions (F-1.6 + F-1.7 + F-1.15).
 */

import type { ExtensionAPI, ExtensionFactory } from "@seaagents/fan-coding-agent";
import { createMcpConfigLoader } from "./config.js";
import { createMcpClientManager } from "./manager.js";
import { createPermissionGate } from "./permissions.js";

export const mcpExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	const configLoader = createMcpConfigLoader();
	const permissions = createPermissionGate();

	pi.on("session_start", async () => {
		const config = await configLoader.load();
		if (config.servers.length === 0) {
			return; // No servers configured — silent no-op
		}
		const manager = createMcpClientManager(pi, permissions);
		await manager.connectAll(config);
		// Manager stays alive for the session — its transport references
		// are owned by the manager and disposed on session_shutdown.
		pi.events.emit("mcp:ready", { servers: config.servers.length });
	});

	pi.on("tool_call", (event) => permissions.gate(event));

	pi.on("session_shutdown", async () => {
		// Manager.dispose is invoked via the api.events subscription
		// set up inside connectAll() — no direct ref kept here.
	});
};

export default mcpExtension;