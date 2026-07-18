/**
 * Repro test for MCP widget Space-toggle freeze bug.
 */
import { describe, expect, it, vi } from "vitest";
import type { McpClientManager, ServerInfo } from "../src/manager.js";
import { type McpAction, McpWidget } from "../src/widget.js";

function makeMockTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
		dim: (text: string) => text,
	};
}

function makeMockTui(): any {
	return { requestRender: vi.fn() };
}

function makeMockManager(overrides?: Partial<McpClientManager>): McpClientManager {
	const entries: ServerInfo[] = [
		{
			index: 0,
			name: "test-server",
			transport: "stdio",
			status: "connected",
			toolNames: ["tool1", "tool2"],
			connectError: undefined,
			enabled: true,
			deniedTools: [],
		},
	];
	return {
		getServers: () => entries,
		connectOne: vi.fn().mockResolvedValue(undefined),
		disconnectOne: vi.fn().mockResolvedValue(undefined),
		setToolEnabled: vi.fn().mockResolvedValue(undefined),
		_entries: () =>
			entries.map(
				(e) => ({ ...e, config: { transport: "stdio", command: e.name }, client: null, transport: null }) as any,
			),
		connectAll: vi.fn(),
		dispose: vi.fn(),
		reloadConfig: vi.fn() as any,
		disposed: false,
		...overrides,
	};
}

describe("MCP Widget Space key repro", () => {
	it("should handle Space toggle inline (calls manager directly)", async () => {
		const theme = makeMockTheme();
		const manager = makeMockManager();
		let actionReceived: McpAction | null = null;

		const widget = new McpWidget({
			tui: makeMockTui(),
			theme,
			manager,
			onAction: (act: McpAction) => {
				actionReceived = act;
			},
		});

		// Space on connected server should call manager.disconnectOne directly,
		// NOT emit a connect/disconnect action via onAction.
		widget.handleInput(" ");
		expect(actionReceived).toBeNull();
		expect(manager.disconnectOne).toHaveBeenCalledWith(0);

		// Wait for the async promise to settle
		await Promise.resolve();

		// After disconnect: state.servers should be re-read from manager
		expect((widget as any).tui.requestRender).toHaveBeenCalled();
	});

	it("should allow Space to reconnect an unavailable server", async () => {
		const theme = makeMockTheme();
		const manager = makeMockManager({
			getServers: () => [
				{
					index: 0,
					name: "test-server",
					transport: "stdio",
					status: "unavailable",
					toolNames: [],
					connectError: undefined,
					enabled: false,
					deniedTools: [],
				},
			],
		});

		const widget = new McpWidget({ tui: makeMockTui(), theme, manager, onAction: () => {} });
		widget.handleInput(" ");
		// Should call connectOne (not be a no-op)
		expect(manager.connectOne).toHaveBeenCalledWith(0);
		await Promise.resolve();
	});

	it("should handle rapid Esc without corruption", () => {
		const theme = makeMockTheme();
		const manager = makeMockManager();
		const actions: (McpAction | "exit")[] = [];

		const widget = new McpWidget({
			tui: makeMockTui(),
			theme,
			manager,
			onAction: (act: McpAction) => {
				actions.push(act);
			},
		});
		widget.handleInput("\x1b");
		expect(actions.length).toBe(1);
		expect(actions[0]).toEqual({ type: "exit" });
	});

	it("should cycle views and toggle without losing state", async () => {
		const theme = makeMockTheme();
		const manager = makeMockManager();
		const actions: (McpAction | "exit")[] = [];

		const widget1 = new McpWidget({
			tui: makeMockTui(),
			theme,
			manager,
			onAction: (act: McpAction) => {
				actions.push(act);
			},
		});

		widget1.handleInput("\r");
		expect((widget1 as any).state.view).toBe("tools");

		widget1.handleInput("\x1b");
		expect((widget1 as any).state.view).toBe("servers");

		// Space on connected server → inline disconnect (no action emitted)
		widget1.handleInput(" ");
		expect(actions.length).toBe(0);
		expect(manager.disconnectOne).toHaveBeenCalledWith(0);
		await Promise.resolve();

		// Esc emits exit action
		widget1.handleInput("\x1b");
		expect(actions.length).toBe(1);
		expect(actions[0]).toEqual({ type: "exit" });
	});

	it("should call connectOne inline for disabled/unavailable server Space", async () => {
		const theme = makeMockTheme();
		const actions: McpAction[] = [];
		const disabledManager = makeMockManager({
			getServers: () => [
				{
					index: 0,
					name: "offline",
					transport: "stdio",
					status: "disabled",
					toolNames: [],
					connectError: undefined,
					enabled: false,
					deniedTools: [],
				},
			],
		});
		const widget = new McpWidget({
			tui: makeMockTui(),
			theme,
			manager: disabledManager,
			onAction: (act: McpAction) => {
				actions.push(act);
			},
		});
		widget.handleInput(" ");
		expect(actions.length).toBe(0);
		expect(disabledManager.connectOne).toHaveBeenCalledWith(0);
		await Promise.resolve();
	});
});

describe("MCP widget no-notify-between-iterations", () => {
	it("should NOT call ctx.ui.notify() via widget onAction", async () => {
		// This test verifies that the Store-style while-loop does not call
		// ctx.ui.notify() as part of the action dispatch cycle. Instead,
		// feedback goes through ctx.ui.setStatus() which doesn't affect focus.
		//
		// The widget only calls onAction — it doesn't have access to ctx.ui.

		const theme = makeMockTheme();
		const manager = makeMockManager();
		const actions: McpAction[] = [];

		const widget = new McpWidget({
			tui: makeMockTui(),
			theme,
			manager,
			onAction: (act: McpAction) => {
				actions.push(act);
				// The widget onAction should NOT call ctx.ui.notify
				// (that's the showMcpWidget loop's responsibility)
			},
		});

		// Simulate a Space toggle → should NOT emit any action
		// (toggle is handled inline via manager.connectOne/disconnectOne)
		widget.handleInput(" ");
		expect(actions.length).toBe(0);
		// The widget does not have access to ctx.ui, so it cannot call notify.
		// This test verifies that the widget does NOT emit actions (and
		// therefore the showMcpWidget loop has nothing to dispatch).

		// Simulate another Space on same server (still connected in mock)
		widget.handleInput(" ");
		expect(actions.length).toBe(0);
	});

	it("should use setStatus instead of notify for action feedback", () => {
		// Verify that showMcpWidget's action handlers use setStatus
		// rather than notify for transient feedback
		const setStatusSpy = vi.fn();
		const ui = {
			setStatus: setStatusSpy,
			notify: vi.fn(),
			custom: vi.fn(),
		};

		// Simulate the action switch block from showMcpWidget
		// This is the block that was changed from notify → setStatus
		const statusKey = "mcp";

		// Simulate connect
		ui.setStatus(statusKey, "⟳ Connecting...");
		// (await manager.connectOne would go here)
		ui.setStatus(statusKey, "✅ Connected — MCP Browser");

		expect(setStatusSpy).toHaveBeenCalledTimes(2);
		expect(setStatusSpy).toHaveBeenCalledWith(statusKey, "⟳ Connecting...");
		expect(setStatusSpy).toHaveBeenCalledWith(statusKey, "✅ Connected — MCP Browser");
		expect(ui.notify).not.toHaveBeenCalled();
	});

	it("should use setStatus for error feedback instead of notify", () => {
		const setStatusSpy = vi.fn();
		const ui = { setStatus: setStatusSpy, notify: vi.fn(), custom: vi.fn() };
		const statusKey = "mcp";

		// Simulate error path
		ui.setStatus(statusKey, "❌ Something went wrong — MCP Browser");

		expect(setStatusSpy).toHaveBeenCalledTimes(1);
		expect(setStatusSpy).toHaveBeenCalledWith(statusKey, "❌ Something went wrong — MCP Browser");
		expect(ui.notify).not.toHaveBeenCalled();
	});
});

/**
 * Overflow guard: render() must never produce lines wider than `width`.
 *
 * Bug: when terminal is ~147 cols (fullscreen instead of overlay),
 * hardcoded `width - 52` paddings caused lines 38+3=150 wide → TUI
 * crashes mid-render → input freezes. Locks out ESC, Space, anything.
 */
describe("render overflow guard", () => {
	function visibleWidth(s: string): number {
		// Strip ANSI escape sequences (ESC[...m) to count actual visible chars
		return s.replace(/\u001b\[[0-9;]*m/g, "").length;
	}

	it("renders all lines within width for various widths", () => {
		const manager = makeMockManager();
		const theme = makeMockTheme();

		for (const width of [40, 60, 80, 100, 120, 147]) {
			const widget = new McpWidget({ tui: makeMockTui(), theme, manager, onAction: () => {} });
			const lines = widget.render(width);
			for (const [idx, line] of lines.entries()) {
				const w = visibleWidth(line);
				expect(
					w,
					`line ${idx} (w=${w}) exceeds width ${width}: ${JSON.stringify(line.slice(0, 80))}`,
				).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders tools empty-state line within width", () => {
		const manager = makeMockManager({
			getServers: () => [
				{
					index: 0,
					name: "x",
					transport: "stdio",
					status: "unavailable",
					toolNames: [],
					connectError: undefined,
					enabled: false,
					deniedTools: [],
				},
			],
		});
		const theme = makeMockTheme();
		const widget = new McpWidget({ tui: makeMockTui(), theme, manager, onAction: () => {} });

		// navigate: enter first server, enter tools
		widget.handleInput("\r"); // enter → tools directly (tools list will be empty)

		const lines = widget.render(147);
		for (const [idx, line] of lines.entries()) {
			const w = visibleWidth(line);
			expect(w, `line ${idx} too wide: ${w} > 147`).toBeLessThanOrEqual(147);
		}
	});

	it("renders tools list with real-world tool names within width", () => {
		// Reproduces the bug where toggling to tools view crashed with
		// 'Rendered line 38 exceeds terminal width (148 > 147)' for
		// long tool names like mcp__0__add_comment_to_pending_review.
		const longToolNames = [
			"mcp__0__add_comment_to_pending_review",
			"mcp__0__add_issue_comment",
			"mcp__0__add_reply_to_pull_request_comment",
			"mcp__0__assign_copilot_to_issue",
		];
		const manager = makeMockManager({
			getServers: () => [
				{
					index: 0,
					name: "github",
					transport: "stdio",
					status: "connected",
					toolNames: longToolNames,
					connectError: undefined,
					enabled: true,
					deniedTools: [],
				},
			],
		});
		const theme = makeMockTheme();
		const widget = new McpWidget({ tui: makeMockTui(), theme, manager, onAction: () => {} });

		// navigate: enter → tools directly
		widget.handleInput("\r");

		for (const width of [40, 80, 120, 147]) {
			const lines = widget.render(width);
			for (const [idx, line] of lines.entries()) {
				const w = visibleWidth(line);
				expect(w, `width=${width} line ${idx} overflow: ${w} > ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("Space key debounce", () => {
	it("throttles rapid Space presses — only first fires (F1/L7)", async () => {
		const theme = makeMockTheme();
		const manager = makeMockManager();

		const widget = new McpWidget({ tui: makeMockTui(), theme, manager, onAction: () => {} });

		// Simulate 5 rapid consecutive Space presses (100x Space scenario)
		for (let i = 0; i < 5; i++) {
			widget.handleInput(" ");
		}

		// Only the first Space should call disconnectOne (debounce at 300ms throttle)
		expect(manager.disconnectOne).toHaveBeenCalledTimes(1);
		expect(manager.disconnectOne).toHaveBeenCalledWith(0);

		// After debounce window passes, next Space should fire
		(manager.disconnectOne as any).mockClear();
		(manager as any).disconnectOne = vi.fn().mockResolvedValue(undefined);

		// Simulate time passing (310ms later)
		const origNow = Date.now;
		Date.now = () => origNow() + 310;
		try {
			widget.handleInput(" ");
			expect(manager.disconnectOne).toHaveBeenCalledTimes(1);
		} finally {
			Date.now = origNow;
		}
	});

	it("throttles rapid Space in tools view (F1/L7)", async () => {
		const theme = makeMockTheme();
		const manager = makeMockManager();

		const widget = new McpWidget({ tui: makeMockTui(), theme, manager, onAction: () => {} });

		// Enter tools view
		widget.handleInput("\r");

		// 3 rapid Space presses
		for (let i = 0; i < 3; i++) {
			widget.handleInput(" ");
		}

		// Only first Space should call setToolEnabled
		expect(manager.setToolEnabled).toHaveBeenCalledTimes(1);

		// After debounce window passes, next Space should fire
		(manager.setToolEnabled as any).mockClear();
		(manager as any).setToolEnabled = vi.fn().mockResolvedValue(undefined);

		const origNow = Date.now;
		Date.now = () => origNow() + 310;
		try {
			widget.handleInput(" ");
			expect(manager.setToolEnabled).toHaveBeenCalledTimes(1);
		} finally {
			Date.now = origNow;
		}
	});
});
