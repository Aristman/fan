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
import { type McpClientManager } from "./manager.js";
import { createMcpClientManager } from "./manager.js";
import { createPermissionGate } from "./permissions.js";
import { McpWidget, type McpAction } from "./widget.js";

// Module-scope reference to the current session's manager.
// Used by the /mcp command handlers to inspect and reload.
let currentManager: McpClientManager | null = null;

// Track whether the MCP widget overlay is currently open (for toggle)
let widgetOpen = false;

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
 * Render a simplified list of MCP servers.
 */
function renderMcpList(): string {
	const servers = currentManager?.getServers() ?? [];
	if (servers.length === 0) {
		return "No MCP servers configured.";
	}

	const rows = servers.map(s => {
		const statusIcon = s.status === "connected" ? "✓" : s.status === "connecting" ? "⟳" : s.status === "disabled" ? "○" : "✗";
		const tools = s.toolNames.length > 0 ? `${s.toolNames.length} tools` : "0 tools";
		const error = s.connectError ? ` (${s.connectError})` : "";
		return `${statusIcon} [#${s.index}] ${s.name} — ${s.status} — ${tools}${error}`;
	});

	return ["MCP Servers:", ...rows].join("\n");
}

/**
 * Find a server by index (string or number) or by name.
 * Returns the index or -1 if not found.
 */
function findServer(servers: import("./manager.js").ServerInfo[], arg: string): number {
	// Try numeric index first
	const num = Number(arg);
	if (!Number.isNaN(num)) {
		const idx = servers.findIndex(s => s.index === num);
		if (idx !== -1) return idx;
	}
	// Try name match
	return servers.findIndex(s => s.name.toLowerCase() === arg.toLowerCase());
}

/**
 * Handle connect/disconnect subcommand for a specific server.
 */
async function handleConnectDisconnect(
	action: "connect" | "disconnect",
	target: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!currentManager) {
		ctx.ui.notify("No MCP servers configured.", "warning");
		return;
	}

	const servers = currentManager.getServers();
	const idx = findServer(servers, target);

	if (idx === -1 || idx >= servers.length) {
		ctx.ui.notify(`Server not found: ${target}`, "warning");
		return;
	}

	const server = servers[idx];

	try {
		if (action === "connect") {
			if (server.status === "connected") {
				ctx.ui.notify(`Server "${server.name}" is already connected.`, "info");
				return;
			}
			await currentManager.connectOne(server.index);
			ctx.ui.notify(`Connected: ${server.name}`, "info");
		} else {
			if (server.status === "unavailable" || server.status === "disabled") {
				ctx.ui.notify(`Server "${server.name}" is already disconnected.`, "info");
				return;
			}
			await currentManager.disconnectOne(server.index);
			ctx.ui.notify(`Disconnected: ${server.name}`, "info");
		}
	} catch (e: any) {
		ctx.ui.notify(`Failed to ${action} "${server.name}": ${e?.message ?? String(e)}`, "error");
	}
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
	if (config.servers.length > 0) {
		const manager = createMcpClientManager(fanInstance, permissions);
		await manager.connectAll(config);
		currentManager = manager;
		fanInstance.events.emit("mcp:ready", { servers: config.servers.length });
	}
	return `Reloaded: ${config.servers.length} servers`;
}

/**
 * Handler for the /mcp slash command.
 */
async function mcpCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
	configLoader: ConfigLoader,
): Promise<void> {
	const subcommand = args.trim().split(/\s+/)[0] || "status";

	if (subcommand === "status") {
		ctx.ui.notify(renderMcpStatus(), "info");
	} else if (subcommand === "reload") {
		const msg = await reloadMcp(configLoader);
		ctx.ui.notify(msg, "info");
	} else if (subcommand === "list") {
		const lines = renderMcpList();
		ctx.ui.notify(lines, "info");
	} else if (subcommand === "connect" || subcommand === "disconnect") {
		const target = args.trim().split(/\s+/).slice(1).join(" ");
		await handleConnectDisconnect(subcommand as "connect" | "disconnect", target, ctx);
	} else {
		ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use 'status', 'list', 'reload', '<name> connect', or '<name> disconnect'.`, "warning");
	}
}

/**
 * Show the MCP widget as a fullscreen Store-style browser.
 * Uses the while-loop pattern: each action dispatches, then re-opens
 * the browser with fresh state from the manager.
 *
 * IMPORTANT: No ctx.ui.notify() calls between loop iterations — that
 * causes focus races with the editor. Use ctx.ui.setStatus() instead
 * for transient feedback during operations.
 */
async function showMcpWidget(fan: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!currentManager) {
		ctx.ui.notify("No MCP servers configured.", "warning");
		return;
	}

	ctx.ui.setStatus("mcp", "MCP Browser — ↑↓ navigate · Enter detail · Space toggle · Esc close");
	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			// Guard: manager might be nulled during reload outside the loop
			if (!currentManager) break;

			const action = await ctx.ui.custom<McpAction>(
				(_tui, theme, _kb, done) => {
					const widget = new McpWidget({
						theme,
						manager: currentManager!,
						onAction: (act: McpAction) => {
							done(act);
						},
					});
					return widget;
				},
			);

			if (action.type === "exit") break;

			try {
				switch (action.type) {
					case "connect":
						ctx.ui.setStatus("mcp", "⟳ Connecting...");
						await currentManager.connectOne(action.serverIdx);
						ctx.ui.setStatus("mcp", "✅ Connected — MCP Browser");
						break;
					case "disconnect":
						ctx.ui.setStatus("mcp", "⟳ Disconnecting...");
						await currentManager.disconnectOne(action.serverIdx);
						ctx.ui.setStatus("mcp", "✅ Disconnected — MCP Browser");
						break;
					case "toggle-tool":
						ctx.ui.setStatus("mcp", `⟳ ${action.enabled ? "Enabling" : "Disabling"} ${action.toolName}...`);
						await currentManager.setToolEnabled(action.serverIdx, action.toolName, action.enabled);
						ctx.ui.setStatus("mcp", `✅ Tool ${action.toolName} ${action.enabled ? "enabled" : "disabled"} — MCP Browser`);
						break;
				}
			} catch (e: any) {
				ctx.ui.setStatus("mcp", `❌ ${e?.message ?? String(e)} — MCP Browser`);
				// Brief pause so user sees the error before the widget re-opens
				await new Promise(r => setTimeout(r, 1500));
				ctx.ui.setStatus("mcp", "MCP Browser — ↑↓ navigate · Enter detail · Space toggle · Esc close");
			}

			// Loop continues — widget re-opens with fresh data from manager.getServers()
		}
	} finally {
		ctx.ui.setStatus("mcp", undefined);
	}
}

// Module-scope reference to ExtensionAPI for use in reloadMcp
let fanInstance: ExtensionAPI;
let permissions: ReturnType<typeof createPermissionGate>;

export const mcpExtension: ExtensionFactory = (fan: ExtensionAPI) => {
	fanInstance = fan;
	const configLoader = createMcpConfigLoader();
	permissions = createPermissionGate();

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

	// Register global shortcuts: alt+m and f4 open/close the MCP widget
	// widgetOpen is set BEFORE showMcpWidget to prevent race on Alt+M double-press
	fan.registerShortcut("alt+m", {
		description: "MCP server manager",
		handler: async (ctx) => {
			if (widgetOpen) return;
			widgetOpen = true;
			try {
				await showMcpWidget(fan, ctx as any);
			} finally {
				widgetOpen = false;
			}
		},
	});

	fan.registerShortcut("f4", {
		description: "MCP server manager",
		handler: async (ctx) => {
			if (widgetOpen) return;
			widgetOpen = true;
			try {
				await showMcpWidget(fan, ctx as any);
			} finally {
				widgetOpen = false;
			}
		},
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
