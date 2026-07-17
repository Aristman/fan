/**
 * MCP Widget — TUI component for managing MCP servers interactively.
 *
 * 3-level state machine: servers → server-detail → tools
 *
 * Fullscreen Store-style browser. State is fresh each time the widget
 * is opened via the while-loop pattern in showMcpWidget.
 */

import type { Component, TUI } from "@seaagents/fan-tui";
import { matchesKey, visibleWidth } from "@seaagents/fan-tui";
import type { Theme } from "@seaagents/fan-coding-agent";
import type { McpClientManager, ServerInfo } from "./manager.js";

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
}

export interface McpWidgetOptions {
	theme: Theme;
	manager: McpClientManager;
	tui: TUI;
	onAction(action: McpAction): void;
}

/** Actions that close the widget to run externally. */
export type McpAction =
	| { type: "exit" }
	| { type: "connect"; serverIdx: number }
	| { type: "disconnect"; serverIdx: number };

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

/** Truncate a line to fit within `width` visible chars, adding "…" at the end. */
function truncateLineToWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let truncated = line;
	while (visibleWidth(truncated) > width - 1) {
		truncated = truncated.slice(0, -1);
	}
	return truncated + "…";
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
	const titleVisible = visibleWidth(title);
	// Truncate title if too long for the available width
	const maxTitleWidth = Math.max(0, width - 4);
	const finalTitle = titleVisible > maxTitleWidth ? truncateToWidth(title, maxTitleWidth) : title;
	const finalTitleVisible = visibleWidth(finalTitle);
	return [
		theme.fg("dim", `╭${sep}╮`),
		`│ ${theme.bold(finalTitle)}${" ".repeat(Math.max(0, width - finalTitleVisible - 3))}│`,
	];
}

function renderFooter(theme: Theme, width: number, text: string): string[] {
	const sep = theme.fg("dim", "─".repeat(Math.max(2, width - 2)));
	// Truncate footer text if too long for the available width
	const maxTextWidth = Math.max(0, width - 4);
	const finalText = visibleWidth(text) > maxTextWidth ? truncateToWidth(text, maxTextWidth) : text;
	const textVisible = visibleWidth(finalText);
	return [
		theme.fg("dim", `├${sep}┤`),
		`│ ${theme.fg("dim", finalText)}${" ".repeat(Math.max(0, width - textVisible - 3))}│`,
		theme.fg("dim", `╰${sep}╯`),
	];
}

/**
 * Check whether a specific tool is denied for a server.
 * Uses the server's deniedTools config.
 */
function isToolDenied(server: ServerInfo, toolName: string): boolean {
	return server.deniedTools?.includes(toolName) ?? false;
}

// ── McpWidget component ─────────────────────────────────────────────

export class McpWidget implements Component {
	private state: McpWidgetState;
	private theme: Theme;
	private manager: McpClientManager;
	private tui: TUI;
	private onAction: (action: McpAction) => void;

	constructor(options: McpWidgetOptions) {
		this.theme = options.theme;
		this.manager = options.manager;
		this.tui = options.tui;
		this.onAction = options.onAction;
		this.state = {
			view: "servers",
			servers: options.manager.getServers(),
			selectedIndex: 0,
			scrollOffset: 0,
			selectedServerIndex: 0,
			selectedToolIndex: 0,
			toolScrollOffset: 0,
		};
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
			const t = "No MCP servers configured.";
			lines.push(`│ ${this.theme.fg("dim", t)}${" ".repeat(Math.max(0, width - visibleWidth(t) - 3))}│`);
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
				// line = leftSide + padding + rightSide + " │" (2 visible suffix)
				// so padding = width - leftVisible - rightVisible - 2
				const paddingNeeded = Math.max(0, width - leftVisible - rightVisible - 2);
				let line = `${leftSide}${" ".repeat(paddingNeeded)}${rightSide} │`;

				if (visibleWidth(line) > width) {
					line = truncateLineToWidth(line, width);
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
			const t = "Server not found.";
			lines.push(`│ ${this.theme.fg("dim", t)}${" ".repeat(Math.max(0, width - visibleWidth(t) - 3))}│`);
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
			// pad using visible width since `dl` may contain ANSI escape codes
			const dlVisible = visibleWidth(dl);
			let padded = dl;
			if (dlVisible + 1 < width) {
				// reserve 1 char for trailing "│"
				padded = dl + " ".repeat(width - dlVisible - 1);
			}
			padded = padded + "│";
			if (visibleWidth(padded) > width) padded = truncateLineToWidth(padded, width);
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
			const t = "Server not found.";
			lines.push(`│ ${this.theme.fg("dim", t)}${" ".repeat(Math.max(0, width - visibleWidth(t) - 3))}│`);
			lines.push(...renderFooter(this.theme, width, "Esc back to servers"));
			return lines;
		}

		const title = `Tools: ${server.name}`;
		lines.push(...renderHeader(this.theme, width, title));

		const allTools = server.toolNames;

		if (allTools.length === 0) {
			lines.push(
				(() => {
					const t = "No tools available. Connect the server to see tools.";
					return `│ ${this.theme.fg("dim", t)}${" ".repeat(Math.max(0, width - visibleWidth(t) - 3))}│`;
				})(),
			);
		} else {
			const maxVisible = Math.max(1, 15);
			const maxIdx = Math.min(allTools.length, this.state.toolScrollOffset + maxVisible);

			for (let i = this.state.toolScrollOffset; i < maxIdx; i++) {
				const toolName = allTools[i];
				const selected = i === this.state.selectedToolIndex;
				const enabled = !isToolDenied(server, toolName);
				let line = `│ ${renderToolName(this.theme, toolName, enabled, selected)}`;

				if (visibleWidth(line) > width) {
					line = truncateLineToWidth(line, width);
				} else {
					// pad using visible width since line may contain ANSI codes;
					// reserve 1 char for trailing "│"
					const v = visibleWidth(line);
					line = v + 1 < width ? line + " ".repeat(width - v - 1) + "│" : line + "│";
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
			this.onAction({ type: "exit" });
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
				// No-op for unavailable/disabled servers
				return;
			}
			if (s.enabled) {
				this.onAction({ type: "disconnect", serverIdx: s.index });
			} else {
				this.onAction({ type: "connect", serverIdx: s.index });
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
				this.onAction({ type: "disconnect", serverIdx: server.index });
			} else {
				this.onAction({ type: "connect", serverIdx: server.index });
			}
		} else if (matchesKey(data, "c")) {
			if (server.status !== "connected") {
				this.onAction({ type: "connect", serverIdx: server.index });
			}
		} else if (matchesKey(data, "d")) {
			if (server.status === "connected") {
				this.onAction({ type: "disconnect", serverIdx: server.index });
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
			const currentEnabled = !isToolDenied(server, toolName);
			const newEnabled = !currentEnabled;
			// Toggle inline — stay in the same view
			this.manager.setToolEnabled(server.index, toolName, newEnabled).then(() => {
				this.state.servers = this.manager.getServers();
				this.tui.requestRender();
			}).catch(_e => {
				// best-effort — next loop iteration will refresh
			});
		}
	}
}
