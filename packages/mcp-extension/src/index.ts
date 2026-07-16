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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "@seaagents/fan-coding-agent";
import type { ConfigLoader } from "./config.js";
import { createMcpConfigLoader } from "./config.js";
import type { McpClientManager } from "./manager.js";
import { createMcpClientManager } from "./manager.js";
import { createPermissionGate } from "./permissions.js";

// Module-scope reference to the current session's manager.
// Used by the /mcp command handlers to inspect and reload.
let currentManager: McpClientManager | null = null;

/**
 * Render a status table of all MCP server connections.
 */
function renderMcpStatus(): string {
	const entries = currentManager?._entries() ?? [];
	if (entries.length === 0) {
		return "No MCP servers configured.";
	}

	const rows = entries.map((e) => {
		const status = e.status.padEnd(12);
		const transport = e.config.transport.padEnd(16);
		const toolCount = e.toolNames.length;
		const error = e.connectError ? ` (${e.connectError})` : "";
		return `${String(e.index).padStart(2)} | ${status} | ${transport} | ${toolCount} tools${error}`;
	});

	const header = " # | status       | transport        | tools";
	const sep = "---+--------------+------------------+-------";
	return [header, sep, ...rows].join("\n");
}

/**
 * Reload all MCP connections: dispose all clients, reload config,
 * and reconnect.
 */
async function reloadMcp(configLoader: ConfigLoader): Promise<string> {
	if (currentManager) {
		await currentManager.dispose();
		currentManager = null;
	}
	const config = await configLoader.load();
	return `Reloaded: ${config.servers.length} servers`;
}

/**
 * Handler for the /mcp slash command.
 */
async function mcpCommandHandler(
	args: string,
	_ctx: ExtensionCommandContext,
	configLoader: ConfigLoader,
): Promise<void> {
	const subcommand = args.trim().split(/\s+/)[0] || "status";

	if (subcommand === "status") {
		_ctx.ui.notify(renderMcpStatus(), "info");
	} else if (subcommand === "reload") {
		const msg = await reloadMcp(configLoader);
		_ctx.ui.notify(msg, "info");
	} else {
		_ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use 'status' or 'reload'.`, "warning");
	}
}

export const mcpExtension: ExtensionFactory = (fan: ExtensionAPI) => {
	const configLoader = createMcpConfigLoader();
	const permissions = createPermissionGate();

	fan.registerCommand("mcp", {
		description: "MCP server status and management",
		handler: (args, ctx) => mcpCommandHandler(args, ctx, configLoader),
	});

	fan.on("session_start", async () => {
		const config = await configLoader.load();
		permissions.updateConfig(config.servers);
		if (config.servers.length === 0) {
			currentManager = null;
			return; // No servers configured — silent no-op
		}
		const manager = createMcpClientManager(fan, permissions);
		await manager.connectAll(config);
		currentManager = manager;
		// Manager stays alive for the session — its transport references
		// are owned by the manager and disposed on session_shutdown.
		fan.events.emit("mcp:ready", { servers: config.servers.length });
	});

	fan.on("tool_call", (event) => permissions.gate(event));

	fan.on("session_shutdown", async () => {
		if (currentManager) {
			await currentManager.dispose();
			currentManager = null;
		}
	});
};

export default mcpExtension;
