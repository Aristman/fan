/**
 * Tests for the mcpExtension factory.
 *
 * F-1.3: Package structure + extension manifest + factory export.
 * Verifies the extension can be loaded without runtime errors when no servers
 * are configured.
 *
 * F2 F-5.4: session_start ctx.cwd is passed to the config loader so project-level
 * `.fan/mcp.json` is loaded for sessions whose cwd differs from process.cwd().
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@seaagents/fan-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { McpConfig } from "../src/config.js";
import { mcpExtension } from "../src/index.js";

let capturedConfig: McpConfig | undefined;

vi.mock("../src/manager.js", () => ({
	createMcpClientManager: vi.fn().mockReturnValue({
		connectAll: vi.fn().mockImplementation((config: McpConfig) => {
			capturedConfig = config;
		}),
		dispose: vi.fn(),
		_entries: vi.fn().mockReturnValue([]),
		getServers: vi.fn().mockReturnValue([]),
		connectOne: vi.fn(),
		disconnectOne: vi.fn(),
	}),
}));

function makeFakeApi() {
	// biome-ignore lint/complexity/noBannedTypes: test mock for event handlers
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

async function makeProjectDir(): Promise<string> {
	const dir = join(tmpdir(), `fan-mcp-cwd-test-${randomUUID()}`);
	await mkdir(join(dir, ".fan"), { recursive: true });
	await writeFile(
		join(dir, ".fan", "mcp.json"),
		JSON.stringify({ servers: [{ transport: "stdio", command: "project-server" }] }),
		"utf8",
	);
	return dir;
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
		await expect(start({} as any, { cwd: process.cwd() } as any)).resolves.not.toThrow();
	});

	it("F2 F-5.4: session_start uses ctx.cwd to load project mcp.json", async () => {
		capturedConfig = undefined;
		const projectDir = await makeProjectDir();
		const { api, handlers } = makeFakeApi();
		mcpExtension(api);

		const start = handlers.get("session_start")![0];
		const ctx: Partial<ExtensionContext> = { cwd: projectDir };
		await start({ type: "session_start", reason: "startup" }, ctx);

		expect(capturedConfig).toBeDefined();
		expect(capturedConfig!.servers).toHaveLength(1);
		expect(capturedConfig!.servers[0].command).toBe("project-server");
	});
});
