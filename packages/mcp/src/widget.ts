/**
 * MCP Widget — TUI component for managing MCP servers interactively.
 *
 * 3-level state machine: servers → server-detail → tools
 *
 * This component does NOT import manager.ts directly. It receives data
 * and actions through callbacks to avoid circular dependencies.
 */

import type { Component } from "@seaagents/fan-tui";
import { matchesKey, visibleWidth } from "@seaagents/fan-tui";
import type { Theme } from "@seaagents/fan-coding-agent";
import type { ServerInfo } from "./manager.js";

// ── Types ───────────────────────────────────────────────────────────

export type McpWidgetView = "servers" | "server-detail" | "tools";

export interface McpWidgetState {
	view: McpWidgetView;
	servers: ServerInfo[];
	selectedIndex: number;
	scrollOffset: number;
	selectedServerIndex: number;
	selectedToolIndex: number;
	toolScrollOffset: number;
	/** Per-tool enabled state: key is "<serverIndex>:<toolName>" → boolean */
	toolEnabled: Map<string, boolean>;
}

export interface McpWidgetCallbacks {
	onConnect(serverIdx: number): Promise<void>;
	onDisconnect(serverIdx: number): Promise<void>;
	onToggleTool(serverIdx: number, toolName: string, enabled: boolean): Promise<void>;
	onClose(): void;
}

export interface McpWidgetOptions {
	theme: Theme;
	callbacks: McpWidgetCallbacks;
	initialServers?: ServerInfo[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function statusIcon(status: ServerInfo["status"]): string {
	switch (status) {
		case "connected":
			return "✓";
		case "connecting":
			return "⟳";
		case "unavailable":
			return "✗";
		case "disabled":
			return "○";
	}
}

/** Strip ANSI escape codes to get plain text width. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Truncate a string to fit within maxWidth visible characters. */
function truncateToWidth(s: string, maxWidth: number): string {
	if (visibleWidth(s) <= maxWidth) return s;
	let truncated = s.slice(0, maxWidth - 1);
	while (visibleWidth(truncated) > maxWidth - 3) truncated = truncated.slice(0, -1);
	return truncated + "...";
}

function statusColor(theme: Theme, status: ServerInfo["status"], text: string): string {
	switch (status) {
		case "connected":
			return theme.fg("success", text);
		case "connecting":
			return theme.fg("warning", text);
		case "unavailable":
			return theme.fg("dim", theme.fg("error", text));
		case "disabled":
			return theme.fg("dim", theme.fg("warning", text));
	}
}

function renderToolName(theme: Theme, name: string, enabled: boolean, selected: boolean): string {
	const prefix = enabled ? theme.fg("success", "✓") : theme.fg("dim", theme.fg("error", "✗"));
	const line = `${prefix} ${name}`;
	return selected ? theme.inverse(line) : line;
}

function renderHeader(theme: Theme, width: number, title: string): string[] {
	const sep = theme.fg("dim", "─".repeat(Math.max(2, width - 2)));
	return [
		theme.fg("dim", `╭${sep}╮`),
		`│ ${theme.bold(title)}${" ".repeat(Math.max(0, width - title.length - 3))}│`,
	];
}

function renderFooter(theme: Theme, width: number, text: string): string[] {
	const sep = theme.fg("dim", "─".repeat(Math.max(2, width - 2)));
	return [
		theme.fg("dim", `├${sep}┤`),
		`│ ${theme.fg("dim", text)}${" ".repeat(Math.max(0, width - text.length - 3))}│`,
		theme.fg("dim", `╰${sep}╯`),
	];
}

// ── McpWidget component ─────────────────────────────────────────────

export class McpWidget implements Component {
	private state: McpWidgetState;
	private theme: Theme;
	private callbacks: McpWidgetCallbacks;

	constructor(options: McpWidgetOptions) {
		this.theme = options.theme;
		this.callbacks = options.callbacks;
		this.state = {
			view: "servers",
			servers: options.initialServers ?? [],
			selectedIndex: 0,
			scrollOffset: 0,
			selectedServerIndex: 0,
			selectedToolIndex: 0,
			toolScrollOffset: 0,
			toolEnabled: new Map<string, boolean>(),
		};
		// Initialize tool enabled state from initial servers
		for (const s of this.state.servers) {
			for (const t of s.toolNames) {
				this.state.toolEnabled.set(`${s.index}:${t}`, true);
			}
		}
	}

	/**
	 * Update the server list from external events (mcp:catalog).
	 */
	updateServers(servers: ServerInfo[]): void {
		this.state.servers = servers;
		// Clamp selection to valid range
		this.state.selectedIndex = Math.min(this.state.selectedIndex, Math.max(0, servers.length - 1));
		this.state.selectedToolIndex = Math.min(this.state.selectedToolIndex, 0);
		this.state.toolScrollOffset = Math.min(this.state.toolScrollOffset, 0);
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	// ── render ────────────────────────────────────────────────────────

	render(width: number): string[] {
		switch (this.state.view) {
			case "servers":
				return this.renderServers(width);
			case "server-detail":
				return this.renderServerDetail(width);
			case "tools":
				return this.renderTools(width);
		}
	}

	private renderServers(width: number): string[] {
		const lines: string[] = [];
		lines.push(...renderHeader(this.theme, width, "MCP Servers"));

		const servers = this.state.servers;
		if (servers.length === 0) {
			lines.push(`│ ${this.theme.fg("dim", "No MCP servers configured.")}${" ".repeat(Math.max(0, width - 28))}│`);
		} else {
			const maxVisible = Math.max(1, 15);
			const maxIdx = Math.min(servers.length, this.state.scrollOffset + maxVisible);

			for (let i = this.state.scrollOffset; i < maxIdx; i++) {
				const s = servers[i];
				const selected = i === this.state.selectedIndex;
				const icon = statusColor(this.theme, s.status, statusIcon(s.status));
				const toolStr = this.theme.fg("dim", `${s.toolNames.length} tools`);
				const errorStr = s.connectError ? this.theme.fg("dim", ` (${s.connectError})`) : "";
				const nameStr = truncateToWidth(s.name, 27);
				const leftSide = `│ ${icon} ${nameStr}`;
				const rightSide = `${toolStr}${errorStr}`;
				const leftVisible = visibleWidth(stripAnsi(leftSide));
				const rightVisible = visibleWidth(stripAnsi(rightSide));
				const paddingNeeded = Math.max(1, width - leftVisible - rightVisible - 3);
				let line = `${leftSide}${" ".repeat(paddingNeeded)}${rightSide} │`;

				if (line.length > width) {
					line = line.slice(0, width - 1) + "│";
				}

				if (selected) {
					line = this.theme.inverse(line);
				}
				lines.push(line);
			}
		}

		lines.push(...renderFooter(this.theme, width, "↑↓ navigate · Enter detail · Space toggle · Esc close"));
		return lines;
	}

	private renderServerDetail(width: number): string[] {
		const lines: string[] = [];
		const serverIdx = this.state.selectedServerIndex;
		const server = this.state.servers[serverIdx];

		if (!server) {
			lines.push(...renderHeader(this.theme, width, "MCP Servers"));
			lines.push(`│ ${this.theme.fg("dim", "Server not found.")}${" ".repeat(Math.max(0, width - 18))}│`);
			lines.push(...renderFooter(this.theme, width, "Esc back to servers"));
			return lines;
		}

		const title = `Server: ${server.name}`;
		lines.push(...renderHeader(this.theme, width, title));

		const statusStr = statusColor(this.theme, server.status, server.status);
		const transportStr = server.transport;
		const toolsStr = `${server.toolNames.length} tools`;
		const errorStr = server.connectError ? `Error: ${server.connectError}` : "";
		const enabledStr = server.enabled ? this.theme.fg("success", "Enabled") : this.theme.fg("error", "Disabled");

		const detailLines = [
			`│ Status: ${statusStr}   Transport: ${transportStr}   ${toolsStr}   ${enabledStr}`,
			errorStr ? `│ ${this.theme.fg("dim", errorStr)}` : "",
			"│",
			`│  ${statusColor(this.theme, server.status, statusIcon(server.status))} ${this.theme.bold("[Toggle enable/disable]")} — press Space`,
			`│  ${this.theme.fg("dim", "Enter")} ${this.theme.bold("Tools")} — press Enter`,
			"│",
			`│  Connect:   press ${this.theme.fg("dim", "c")}`,
			`│  Disconnect: press ${this.theme.fg("dim", "d")}`,
		].filter(Boolean);

		for (const dl of detailLines) {
			let padded = (dl as string).padEnd(width - 1, " ") + "│";
			if (padded.length > width) padded = padded.slice(0, width - 1) + "│";
			lines.push(padded);
		}

		lines.push(...renderFooter(this.theme, width, "Enter tools · Space toggle · c/d connect/disconnect · Esc back"));
		return lines;
	}

	private renderTools(width: number): string[] {
		const lines: string[] = [];
		const serverIdx = this.state.selectedServerIndex;
		const server = this.state.servers[serverIdx];

		if (!server) {
			lines.push(...renderHeader(this.theme, width, "MCP Servers"));
			lines.push(`│ ${this.theme.fg("dim", "Server not found.")}${" ".repeat(Math.max(0, width - 18))}│`);
			lines.push(...renderFooter(this.theme, width, "Esc back to servers"));
			return lines;
		}

		const title = `Tools: ${server.name}`;
		lines.push(...renderHeader(this.theme, width, title));

		const allTools = server.toolNames;

		if (allTools.length === 0) {
			lines.push(
				`│ ${this.theme.fg("dim", "No tools available. Connect the server to see tools.")}${" ".repeat(Math.max(0, width - 52))}│`,
			);
		} else {
			const maxVisible = Math.max(1, 15);
			const maxIdx = Math.min(allTools.length, this.state.toolScrollOffset + maxVisible);

			for (let i = this.state.toolScrollOffset; i < maxIdx; i++) {
				const toolName = allTools[i];
				const selected = i === this.state.selectedToolIndex;
				const enabled = this.state.toolEnabled.get(`${server.index}:${toolName}`) ?? true;
				let line = `│ ${renderToolName(this.theme, toolName, enabled, selected)}`;

				if (line.length > width) {
					line = line.slice(0, width - 1) + "│";
				} else {
					line = line.padEnd(width - 1, " ") + "│";
				}
				lines.push(line);
			}
		}

		lines.push(...renderFooter(this.theme, width, "↑↓ navigate · Space toggle · Esc back"));
		return lines;
	}

	// ── handleInput ──────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.handleBackOrClose();
			return;
		}

		switch (this.state.view) {
			case "servers":
				this.handleServersInput(data);
				break;
			case "server-detail":
				this.handleServerDetailInput(data);
				break;
			case "tools":
				this.handleToolsInput(data);
				break;
		}
	}

	private handleBackOrClose(): void {
		if (this.state.view === "servers") {
			this.callbacks.onClose();
		} else if (this.state.view === "server-detail") {
			this.state.view = "servers";
			this.state.selectedIndex = this.state.selectedServerIndex;
		} else if (this.state.view === "tools") {
			this.state.view = "server-detail";
		}
	}

	private handleServersInput(data: string): void {
		const servers = this.state.servers;
		if (servers.length === 0) return;

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.state.selectedIndex > 0) {
				this.state.selectedIndex--;
				if (this.state.selectedIndex < this.state.scrollOffset) {
					this.state.scrollOffset = this.state.selectedIndex;
				}
			}
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.state.selectedIndex < servers.length - 1) {
				this.state.selectedIndex++;
				const maxVisible = 15;
				if (this.state.selectedIndex >= this.state.scrollOffset + maxVisible) {
					this.state.scrollOffset = this.state.selectedIndex - maxVisible + 1;
				}
			}
		} else if (matchesKey(data, "enter")) {
			this.state.selectedServerIndex = this.state.selectedIndex;
			this.state.view = "server-detail";
		} else if (matchesKey(data, "space")) {
			const s = servers[this.state.selectedIndex];
			if (s.status === "unavailable" || s.status === "disabled") {
				// No-op for unavailable/disabled servers; no visual change needed
				return;
			}
			if (s.enabled) {
				this.callbacks.onDisconnect(s.index);
			} else {
				this.callbacks.onConnect(s.index);
			}
		}
	}

	private handleServerDetailInput(data: string): void {
		const serverIdx = this.state.selectedServerIndex;
		const server = this.state.servers[serverIdx];
		if (!server) return;

		if (matchesKey(data, "enter")) {
			this.state.view = "tools";
			this.state.selectedToolIndex = 0;
			this.state.toolScrollOffset = 0;
		} else if (matchesKey(data, "space")) {
			if (server.enabled) {
				this.callbacks.onDisconnect(server.index);
			} else {
				this.callbacks.onConnect(server.index);
			}
		} else if (matchesKey(data, "c")) {
			if (server.status !== "connected") {
				this.callbacks.onConnect(server.index);
			}
		} else if (matchesKey(data, "d")) {
			if (server.status === "connected") {
				this.callbacks.onDisconnect(server.index);
			}
		}
	}

	private handleToolsInput(data: string): void {
		const serverIdx = this.state.selectedServerIndex;
		const server = this.state.servers[serverIdx];
		if (!server || server.toolNames.length === 0) return;

		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.state.selectedToolIndex > 0) {
				this.state.selectedToolIndex--;
				if (this.state.selectedToolIndex < this.state.toolScrollOffset) {
					this.state.toolScrollOffset = this.state.selectedToolIndex;
				}
			}
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.state.selectedToolIndex < server.toolNames.length - 1) {
				this.state.selectedToolIndex++;
				const maxVisible = 15;
				if (this.state.selectedToolIndex >= this.state.toolScrollOffset + maxVisible) {
					this.state.toolScrollOffset = this.state.selectedToolIndex - maxVisible + 1;
				}
			}
		} else if (matchesKey(data, "space")) {
			const toolName = server.toolNames[this.state.selectedToolIndex];
			const key = `${server.index}:${toolName}`;
			const currentEnabled = this.state.toolEnabled.get(key) ?? true;
			// Flip the local state and notify backend
			this.state.toolEnabled.set(key, !currentEnabled);
			this.callbacks.onToggleTool(server.index, toolName, !currentEnabled);
		}
	}
}
