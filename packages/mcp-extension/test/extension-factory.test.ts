/**
 * Tests for the mcpExtension factory.
 *
 * F-1.3: Package structure + extension manifest + factory export.
 * Verifies the extension can be loaded without runtime errors when no servers
 * are configured.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { mcpExtension } from "../src/index.js";

function makeFakeApi() {
	const handlers = new Map<string, Function[]>();
	const events = { emit: vi.fn(), on: vi.fn() };
	const api: ExtensionAPI = {
		on(event: string, handler: any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: vi.fn(),
		unregisterTool: vi.fn(),
		updateTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		setSessionName: vi.fn(),
		getSessionName: vi.fn(),
		setLabel: vi.fn(),
		getActiveTools: vi.fn(),
		getAllTools: vi.fn(),
		setActiveTools: vi.fn(),
		getCommands: vi.fn(),
		setModel: vi.fn(),
		getThinkingLevel: vi.fn(),
		setThinkingLevel: vi.fn(),
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		events: events as any,
	} as any;
	return { api, handlers, events };
}

describe("F-1.3: mcpExtension factory", () => {
	it("exports an ExtensionFactory function", () => {
		expect(typeof mcpExtension).toBe("function");
	});

	it("registers session_start, tool_call, and session_shutdown handlers without throwing", () => {
		const { api, handlers } = makeFakeApi();
		expect(() => mcpExtension(api)).not.toThrow();
		expect(handlers.get("session_start")?.length ?? 0).toBeGreaterThan(0);
		expect(handlers.get("tool_call")?.length ?? 0).toBeGreaterThan(0);
		expect(handlers.get("session_shutdown")?.length ?? 0).toBeGreaterThan(0);
	});

	it("session_start is a no-op when config is empty", async () => {
		const { api, handlers } = makeFakeApi();
		mcpExtension(api);
		const start = handlers.get("session_start")![0];
		await expect(start({} as any)).resolves.not.toThrow();
	});
});