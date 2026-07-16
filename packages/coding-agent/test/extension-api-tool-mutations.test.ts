/**
 * Tests for dynamic tool mutation API on ExtensionAPI (MCP integration Phase 1).
 * Covers F-1.1 (unregisterTool) and F-1.2 (updateTool).
 */

import { describe, expect, it, vi } from "vitest";
import { createExtensionAPI, createExtensionRuntime } from "../src/core/extensions/loader.js";
import type { ExtensionAPI, Extension } from "../src/core/extensions/types.js";
import { createEventBus } from "../src/core/event-bus.js";

/**
 * Builds a minimal extension skeleton plus its ExtensionAPI. The extension is
 * not loaded into a runner — tests exercise the registration API directly.
 */
function buildTestExtension() {
	const runtime = createExtensionRuntime();
	const refreshSpy = vi.fn();
	runtime.refreshTools = refreshSpy;

	const eventBus = createEventBus();

	const extension: Extension = {
		path: "/virtual/ext.ts",
		resolvedPath: "/virtual/ext.ts",
		sourceInfo: { path: "/virtual/ext.ts", source: "test-ext", scope: "temporary" as const, origin: "top-level" as const },
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		messageRenderers: new Map(),
	};

	const api: ExtensionAPI = createExtensionAPI(extension, runtime, "/virtual", eventBus);
	return { api, extension, refreshSpy };
}

describe("F-1.1: unregisterTool", () => {
	it("removes a previously registered tool from the registry", () => {
		const { api, refreshSpy, extension } = buildTestExtension();

		api.registerTool({ name: "toolA", label: "toolA", description: "A", parameters: {} as any, execute: async () => ({ content: [], details: {} }) });
		api.registerTool({ name: "toolB", label: "toolB", description: "B", parameters: {} as any, execute: async () => ({ content: [], details: {} }) });
		expect(extension.tools.has("toolA")).toBe(true);
		expect(extension.tools.has("toolB")).toBe(true);
		expect(refreshSpy).toHaveBeenCalledTimes(2);

		api.unregisterTool("toolA");
		expect(extension.tools.has("toolA")).toBe(false);
		expect(extension.tools.has("toolB")).toBe(true);
		expect(refreshSpy).toHaveBeenCalledTimes(3);

		// Unregistering a non-existent tool is a no-op (no refresh, no throw)
		api.unregisterTool("doesNotExist");
		expect(refreshSpy).toHaveBeenCalledTimes(3);
	});
});

describe("F-1.2: updateTool", () => {
	it("replaces an existing tool definition", () => {
		const { api, extension, refreshSpy } = buildTestExtension();

		api.registerTool({
			name: "read_file",
			label: "read_file",
			description: "old description",
			parameters: {} as any,
			execute: async () => ({ content: [], details: {} }),
		});

		const newDef = {
			name: "read_file",
			label: "read_file",
			description: "new description",
			parameters: {} as any,
			execute: async () => ({ content: [{ type: "text" as const, text: "updated" }], details: {} }),
		};
		api.updateTool("read_file", newDef);

		expect(extension.tools.get("read_file")!.definition.description).toBe("new description");
		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});

	it("creates a tool when none exists yet (acts as register)", () => {
		const { api, extension, refreshSpy } = buildTestExtension();

		const def = {
			name: "fresh_tool",
			label: "fresh_tool",
			description: "fresh",
			parameters: {} as any,
			execute: async () => ({ content: [], details: {} }),
		};
		api.updateTool("fresh_tool", def);

		expect(extension.tools.has("fresh_tool")).toBe(true);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});
});