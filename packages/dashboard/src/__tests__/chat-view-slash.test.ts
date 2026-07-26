// Tests for F-3.9: slash command autocomplete in <chat-view>
//
// Command source decision: STATIC list of skill commands (no /api/commands
// endpoint exists in api-gateway). Only `/skill:<name> args` actually works
// over the server path (agent-session._expandSkillCommand), so the dropdown
// inserts `/skill:...` — NOT `/idea-lab:analyze` as sketched in the roadmap
// TC (that syntax is not expanded by the runtime).
//
// Trigger decision: the dropdown opens only when "/" is the FIRST character
// of the input and no space has been typed yet (isSlashCommandContext).
// A "/" in the middle of text does not trigger autocomplete.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../components/chat-view.js";
import type { ChatView } from "../components/chat-view.js";
import { filterSlashCommands, getSlashCommands, isSlashCommandContext } from "../lib/slash-commands.js";

const SESSION_ID = "sess-1";

function createEl(projectType: string | null = null): { el: ChatView; apiClient: { sendMessage: ReturnType<typeof vi.fn> } } {
	const wsClient = {
		onMessage: vi.fn(() => () => {}),
		onStatusChange: vi.fn(() => () => {}),
		send: vi.fn(),
	};
	const apiClient = {
		getSession: vi.fn().mockResolvedValue({ id: SESSION_ID, messages: [] }),
		sendMessage: vi.fn().mockResolvedValue({}),
	};

	const el = document.createElement("chat-view") as ChatView;
	el.sessionId = SESSION_ID;
	el.wsClient = wsClient as any;
	el.apiClient = apiClient as any;
	el.projectType = projectType;
	document.body.appendChild(el);
	return { el, apiClient };
}

function textarea(el: ChatView): HTMLTextAreaElement {
	const ta = el.querySelector<HTMLTextAreaElement>("#message-input");
	if (!ta) throw new Error("textarea not rendered");
	return ta;
}

/** Simulate the user typing: set value + dispatch an input event. */
async function typeText(el: ChatView, text: string): Promise<void> {
	const ta = textarea(el);
	ta.value = text;
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	await el.updateComplete;
}

/** Dispatch a keydown on the textarea. */
async function pressKey(el: ChatView, key: string, opts: KeyboardEventInit = {}): Promise<void> {
	const ta = textarea(el);
	ta.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
	await el.updateComplete;
}

describe("slash-commands lib (F-3.9)", () => {
	it("getSlashCommands returns all skill commands for unknown type", () => {
		const cmds = getSlashCommands("unknown");
		expect(cmds.length).toBeGreaterThanOrEqual(8);
		expect(cmds[0].name).toBe("skill:idea-lab");
	});

	it("orders idea-lab / research-spec-generator first for research workspaces", () => {
		const cmds = getSlashCommands("research");
		expect(cmds[0].name).toBe("skill:idea-lab");
		expect(cmds[1].name).toBe("skill:research-spec-generator");
	});

	it("orders bug-fix / auto-tests first for code workspaces", () => {
		const cmds = getSlashCommands("code");
		expect(cmds[0].name).toBe("skill:bug-fix");
		expect(cmds[1].name).toBe("skill:auto-tests");
	});

	it("filterSlashCommands narrows by substring (case-insensitive)", () => {
		const cmds = getSlashCommands(null);
		const filtered = filterSlashCommands(cmds, "ID");
		expect(filtered.map((c) => c.name)).toEqual(["skill:idea-lab"]);
	});

	it("isSlashCommandContext: only leading '/' without a space", () => {
		expect(isSlashCommandContext("/")).toBe(true);
		expect(isSlashCommandContext("/idea")).toBe(true);
		expect(isSlashCommandContext("/skill:idea-lab do x")).toBe(false);
		expect(isSlashCommandContext("hello /world")).toBe(false);
		expect(isSlashCommandContext("")).toBe(false);
	});
});

describe("chat-view slash command autocomplete (F-3.9)", () => {
	let el: ChatView;
	let apiClient: { sendMessage: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		({ el, apiClient } = createEl());
	});

	afterEach(() => {
		el.remove();
	});

	// TC-F-3.9-1: typing '/' → dropdown visible with available commands
	it("TC-F-3.9-1: shows the dropdown with commands when '/' is typed", async () => {
		await el.updateComplete;
		await typeText(el, "/");

		const dropdown = el.querySelector<HTMLElement>('[data-testid="slash-dropdown"]');
		expect(dropdown).not.toBeNull();
		const items = dropdown!.querySelectorAll('[role="option"]');
		expect(items.length).toBeGreaterThanOrEqual(8);
		expect(dropdown!.textContent).toContain("/skill:idea-lab");
	});

	// TC-F-3.9-2: selecting a command inserts '/skill:idea-lab ' into the input
	// (roadmap sketched '/idea-lab:analyze' — see header note; /skill: is the
	// only syntax the runtime expands)
	it("TC-F-3.9-2: Enter inserts the selected command with a trailing space", async () => {
		await el.updateComplete;
		await typeText(el, "/");
		await pressKey(el, "Enter");

		expect(el.inputValue).toBe("/skill:idea-lab ");
		// The message must NOT be sent — Enter selected a command instead
		expect(apiClient.sendMessage).not.toHaveBeenCalled();
		// Dropdown closed (input now contains a space)
		expect(el.querySelector('[data-testid="slash-dropdown"]')).toBeNull();
	});

	it("clicking an item inserts the command into the input", async () => {
		await el.updateComplete;
		await typeText(el, "/repo");

		const item = el.querySelector<HTMLButtonElement>('[data-testid="slash-item-skill:repo-explorer"]');
		expect(item).not.toBeNull();
		item!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		await el.updateComplete;

		expect(el.inputValue).toBe("/skill:repo-explorer ");
	});

	it("filters commands as text is typed ('/id' → only idea-lab)", async () => {
		await el.updateComplete;
		await typeText(el, "/id");

		const items = el.querySelectorAll('[data-testid="slash-dropdown"] [role="option"]');
		expect(items.length).toBe(1);
		expect(items[0].textContent).toContain("/skill:idea-lab");
	});

	it("Escape closes the dropdown without clearing the input", async () => {
		await el.updateComplete;
		await typeText(el, "/");
		expect(el.querySelector('[data-testid="slash-dropdown"]')).not.toBeNull();

		await pressKey(el, "Escape");
		expect(el.querySelector('[data-testid="slash-dropdown"]')).toBeNull();
		expect(el.inputValue).toBe("/");
	});

	it("'/' in the middle of text does NOT open the dropdown", async () => {
		await el.updateComplete;
		await typeText(el, "hello /world");

		expect(el.querySelector('[data-testid="slash-dropdown"]')).toBeNull();
	});

	it("dropdown closes once a space is typed (command already complete)", async () => {
		await el.updateComplete;
		await typeText(el, "/skill:idea-lab analyze this");

		expect(el.querySelector('[data-testid="slash-dropdown"]')).toBeNull();
	});

	it("ArrowDown + Enter selects the second command", async () => {
		await el.updateComplete;
		await typeText(el, "/");
		await pressKey(el, "ArrowDown");
		await pressKey(el, "Enter");

		// Default (unknown) order: [idea-lab, research-spec-generator, ...]
		expect(el.inputValue).toBe("/skill:research-spec-generator ");
	});

	it("Enter sends the message when the dropdown is closed", async () => {
		await el.updateComplete;
		await typeText(el, "plain message");
		await pressKey(el, "Enter");

		expect(apiClient.sendMessage).toHaveBeenCalledWith(SESSION_ID, "plain message");
	});

	it("research project type orders idea-lab and research-spec-generator first", async () => {
		el.remove();
		({ el, apiClient } = createEl("research"));
		await el.updateComplete;
		await typeText(el, "/");

		const items = el.querySelectorAll('[data-testid="slash-dropdown"] [role="option"]');
		expect(items[0].textContent).toContain("/skill:idea-lab");
		expect(items[1].textContent).toContain("/skill:research-spec-generator");
	});
});
