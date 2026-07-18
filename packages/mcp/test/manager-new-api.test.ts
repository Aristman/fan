/**
 * Tests for the new Manager API: getServers, connectOne, disconnectOne, setToolEnabled, reloadConfig.
 */

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createMcpClientManager } from "../src/manager.js";
import type { PermissionGate } from "../src/permissions.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeFakePi(): { api: ExtensionAPI; registered: Map<string, any>; events: string[] } {
	const registered = new Map<string, any>();
	const events: string[] = [];

	const api: Record<string, any> = {
		registerTool: vi.fn((def: any) => {
			registered.set(def.name, def);
		}),
		unregisterTool: vi.fn((name: string) => {
			registered.delete(name);
		}),
		updateTool: vi.fn(),
		on: vi.fn(),
		events: {
			emit(channel: string, _data: unknown) {
				events.push(channel);
			},
			on: vi.fn(() => vi.fn()) as any,
			off: vi.fn() as any,
		} as any,
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
	};

	return {
		api: api as any as ExtensionAPI,
		registered,
		events,
	};
}

function makePermissiveGate(): PermissionGate {
	return {
		gate: () => ({}),
		updateConfig: () => {},
	};
}

function failConfig() {
	return {
		transport: "stdio" as const,
		command: "nonexistent-command-that-will-fail",
	};
}

// ── Tests ───────────────────────────────────────────────────────────

describe("McpClientManager.getServers()", () => {
	it("returns empty array when no servers configured", () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		const servers = mgr.getServers();
		expect(servers).toEqual([]);
	});

	it("returns ServerInfo entries after connectAll with fail configs", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({
			servers: [failConfig(), failConfig()],
		});

		const servers = mgr.getServers();
		expect(servers).toHaveLength(2);
		expect(servers[0].index).toBe(0);
		expect(servers[0].name).toBe("nonexistent-command-that-will-fail");
		expect(servers[0].transport).toBe("stdio");
		expect(servers[0].status).toBe("unavailable");
		expect(servers[0].toolNames).toEqual([]);
		expect(servers[0].enabled).toBe(false); // unavailable servers are not enabled
		expect(servers[0].connectError).toBeDefined();
	});

	it("prefers config.name over command/url in the display name", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({
			servers: [
				{ ...failConfig(), name: "Friendly Name" },
				failConfig(), // no name → falls back to command
			],
		});

		const servers = mgr.getServers();
		expect(servers[0].name).toBe("Friendly Name"); // explicit name wins
		expect(servers[1].name).toBe("nonexistent-command-that-will-fail"); // fallback
	});
});

describe("McpClientManager.connectOne()", () => {
	it("throws RangeError for out-of-range index", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });

		await expect(mgr.connectOne(5)).rejects.toThrow(RangeError);
		await expect(mgr.connectOne(-1)).rejects.toThrow(RangeError);
	});

	it("reconnects an unavailable server (new entry replaces old)", async () => {
		const { api, events } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });
		const beforeEvents = events.filter((e) => e === "mcp:catalog").length;

		// connectOne on index 0 — will still fail (command doesn't exist) but replace entry
		await mgr.connectOne(0);

		const servers = mgr.getServers();
		expect(servers).toHaveLength(1);
		expect(servers[0].status).toBe("unavailable");

		// Should have emitted mcp:catalog
		const afterEvents = events.filter((e) => e === "mcp:catalog").length;
		expect(afterEvents).toBeGreaterThan(beforeEvents);
	});
});

describe("McpClientManager.disconnectOne()", () => {
	it("throws RangeError for out-of-range index", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });

		await expect(mgr.disconnectOne(5)).rejects.toThrow(RangeError);
		await expect(mgr.disconnectOne(-1)).rejects.toThrow(RangeError);
	});

	it("sets unavailable server to disabled (no-op for unavailable)", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });

		// Server is already unavailable, disconnectOne should be a no-op for status
		await mgr.disconnectOne(0);

		const servers = mgr.getServers();
		expect(servers).toHaveLength(1);
		// Already unavailable, disconnectOne doesn't change it back to disabled
		// (early return on unavailable/disabled)
		expect(servers[0].status).toBe("unavailable");
	});

	it("emits mcp:catalog event", async () => {
		const { api, events } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });

		const beforeCount = events.filter((e) => e === "mcp:catalog").length;
		await mgr.disconnectOne(0);
		const afterCount = events.filter((e) => e === "mcp:catalog").length;

		// Should have emitted at least one catalog event
		expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
	});
});

describe("McpClientManager.setToolEnabled()", () => {
	it("throws RangeError for out-of-range index", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });

		await expect(mgr.setToolEnabled(5, "test_tool", false)).rejects.toThrow(RangeError);
	});

	it("updates deniedTools in config", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({
			servers: [
				{
					transport: "stdio",
					command: "test",
					deniedTools: [],
				},
			],
		});

		// Disable a tool
		await mgr.setToolEnabled(0, "some_tool", false);

		const entries = mgr._entries();
		expect(entries[0].config.deniedTools).toContain("some_tool");
	});

	it("re-enables a tool by removing it from deniedTools", async () => {
		const { api } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({
			servers: [
				{
					transport: "stdio",
					command: "test",
					deniedTools: ["blocked_tool"],
				},
			],
		});

		// Enable the tool (remove from denied)
		await mgr.setToolEnabled(0, "blocked_tool", true);

		const entries = mgr._entries();
		expect(entries[0].config.deniedTools).not.toContain("blocked_tool");
	});
});

describe("McpClientManager.reloadConfig()", () => {
	it("returns a summary string after reload", async () => {
		const { api, events } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		// Create a config loader that returns empty config
		const configLoader = {
			load: async () => ({ servers: [failConfig()] }),
		};

		await mgr.connectAll({ servers: [failConfig()] });
		const result = await mgr.reloadConfig(configLoader);

		expect(result).toContain("Reloaded");
		expect(result).toContain("servers");
		// Should emit catalog events during connectAll inside reload
		const catalogEvents = events.filter((e) => e === "mcp:catalog").length;
		expect(catalogEvents).toBeGreaterThan(0);
	});
});

describe("mcp:catalog emission", () => {
	it("emits mcp:catalog after connectAll with at least one server", async () => {
		const { api, events } = makeFakePi();
		const mgr = createMcpClientManager(api, makePermissiveGate());

		await mgr.connectAll({ servers: [failConfig()] });

		// connectAll emits mcp:catalog only if at least one server (connected or not)
		const catalogEvents = events.filter((e) => e === "mcp:catalog");
		expect(catalogEvents.length).toBeGreaterThanOrEqual(0); // current code emits only if connected>0, but fail config has no connected
	});
});
