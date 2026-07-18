/**
 * MCP Widget — TUI component for managing MCP servers interactively.
 *
 * 2-level state machine: servers → tools
 *
 * Fullscreen Store-style browser. State is fresh each time the widget
 * is opened via the while-loop pattern in showMcpWidget.
 */

import type { Theme } from "@seaagents/fan-coding-agent";
import type { Component, TUI } from "@seaagents/fan-tui";
import { matchesKey, visibleWidth } from "@seaagents/fan-tui";
import type { McpClientManager, ServerInfo } from "./manager.js";

// ── Types ───────────────────────────────────────────────────────────

export type McpWidgetView = "servers" | "tools";

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

/** Actions emitted via onAction. Only "exit" remains; connect/disconnect
 *  are now handled inline inside the widget (same pattern as tool toggle). */
export type McpAction = { type: "exit" };

// ── Helpers ─────────────────────────────────────────────────────────

function statusIcon(status: ServerInfo["status"]): string {
	switch (status) {
		case "connected":
			return "✓";
		case "connecting":
			return "⟳";
		case "unavailable":
			return "!";
		case "disabled":
			return "✗";
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
	return `${truncated}...`;
}

/** Truncate a line to fit within `width` visible chars, adding "…" at the end. */
function truncateLineToWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let truncated = line;
	while (visibleWidth(truncated) > width - 1) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}…`;
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

/**
 * Render a server name with status-colored BACKGROUND that reflects the
 * connection state — git-style:
 *   connected    → dim green bg     (✓ icon, green text)
 *   connecting   → no bg, warn text (⟳ icon, yellow text)
 *   disabled     → dim red bg       (✗ icon, dim red text)  — user disconnected
 *   unavailable  → bright red bg    (! icon, bright red text) — server crashed/error
 *
 * Uses ANSI 256-color bg escape codes via raw strings (theme.bg() only
 * exposes ThemeBg union, no "success" / "error" entries).
 */
const ANSI_BG_DIM_GREEN = "\x1b[48;5;22m";
const ANSI_BG_DIM_RED = "\x1b[48;5;52m";
const ANSI_BG_BRIGHT_RED = "\x1b[48;5;124m";
const ANSI_BG_RESET = "\x1b[49m";

function styledServerName(theme: Theme, status: ServerInfo["status"], text: string): string {
	switch (status) {
		case "connected":
			return `${ANSI_BG_DIM_GREEN}${theme.fg("success", text)}${ANSI_BG_RESET}`;
		case "connecting":
			return theme.fg("warning", text);
		case "disabled":
			return `${ANSI_BG_DIM_RED}${theme.fg("dim", theme.fg("error", text))}${ANSI_BG_RESET}`;
		case "unavailable":
			return `${ANSI_BG_BRIGHT_RED}${theme.fg("error", text)}${ANSI_BG_RESET}`;
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
	/** Tracks the last toggle timestamp for throttle (debounce F1/L7). */
	private lastToggleAt = 0;

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

	/**
	 * Dispose the widget — cancels pending operations.
	 * Currently no subscriptions or timers, but required for future-proof
	 * lifecycle management (D1).
	 */
	dispose(): void {
		// No subscriptions or timers to clean up yet.
		// If async ops are added, track them here for cancellation.
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	// ── render ────────────────────────────────────────────────────────

	render(width: number): string[] {
		switch (this.state.view) {
			case "servers":
				return this.renderServers(width);
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
				const styledName = styledServerName(this.theme, s.status, nameStr);
				const leftSide = `│ ${icon} ${styledName}`;
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

		lines.push(...renderFooter(this.theme, width, "↑↓ navigate · Enter tools · Space toggle · Esc close"));
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

		const styledName = styledServerName(this.theme, server.status, server.name);
		const title = `Tools: ${styledName}`;
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
					line = v + 1 < width ? `${line + " ".repeat(width - v - 1)}│` : `${line}│`;
				}
				lines.push(line);
			}
		}

		lines.push(...renderFooter(this.theme, width, "↑↓ navigate · Space toggle · Esc servers"));
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
			case "tools":
				this.handleToolsInput(data);
				break;
		}
	}

	private handleBackOrClose(): void {
		if (this.state.view === "servers") {
			this.onAction({ type: "exit" });
		} else if (this.state.view === "tools") {
			this.state.view = "servers";
			this.state.selectedIndex = this.state.selectedServerIndex;
			this.state.scrollOffset = Math.max(
				0,
				Math.min(this.state.scrollOffset, Math.max(0, this.state.servers.length - 15)),
			);
		}
	}

	private handleServersInput(data: string): void {
		// Guard: manager may have been disposed after reload (F4/R2)
		if ((this.manager as any).disposed) return;

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
			this.state.selectedToolIndex = 0;
			this.state.toolScrollOffset = 0;
			this.state.view = "tools";
		} else if (matchesKey(data, "space")) {
			// Debounce: throttle toggles to 1 per 300ms (F1/L7)
			const now = Date.now();
			if (this.lastToggleAt && now - this.lastToggleAt < 300) return;
			this.lastToggleAt = now;

			const s = servers[this.state.selectedIndex];
			// Toggle inline — same pattern as tool toggle. Stay on the
			// same view, no widget re-creation, no UI flicker.
			// Allow toggle even when status is unavailable/disabled —
			// the user expects Space to TOGGLE state, not be a no-op.
			const op = s.enabled ? this.manager.disconnectOne(s.index) : this.manager.connectOne(s.index);
			op.then(() => {
				this.state.servers = this.manager.getServers();
				this.tui.requestRender();
			}).catch((_e) => {
				// best-effort — next state read will reflect failure via
				// entry.connectError surfaced in the widget
			});
		}
	}

	private handleToolsInput(data: string): void {
		// Guard: manager may have been disposed after reload (F4/R2)
		if ((this.manager as any).disposed) return;

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
			// Debounce: throttle toggles to 1 per 300ms (F1/L7)
			const now = Date.now();
			if (this.lastToggleAt && now - this.lastToggleAt < 300) return;
			this.lastToggleAt = now;

			const toolName = server.toolNames[this.state.selectedToolIndex];
			const currentEnabled = !isToolDenied(server, toolName);
			const newEnabled = !currentEnabled;
			// Toggle inline — stay in the same view
			this.manager
				.setToolEnabled(server.index, toolName, newEnabled)
				.then(() => {
					this.state.servers = this.manager.getServers();
					this.tui.requestRender();
				})
				.catch((_e) => {
					// best-effort — next loop iteration will refresh
				});
		}
	}
}
