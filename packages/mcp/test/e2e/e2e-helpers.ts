/**
 * Shared helpers for MCP e2e integration tests.
 *
 * Provides:
 * - createTestConfig() — builds a McpConfig pointing at a fixture server
 * - makeFakePi() — creates a mock ExtensionAPI suitable for e2e testing
 * - makePermissiveGate() — a PermissionGate that allows everything
 * - getFixturePath() — resolves the absolute path to a fixture server script
 * - createTempDir() — creates a temporary directory for test file operations
 * - fixtureToUrl() — resolves fixture path for import.meta.url
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { vi } from "vitest";
import type { McpConfig } from "../../src/config.js";
import type { PermissionGate } from "../../src/permissions.js";

/**
 * Resolve the absolute path to a fixture script relative to this file.
 */
export function getFixturePath(fixtureName: string): string {
	// In the e2e test, import.meta.url refers to the test file
	// We use a manual relative path calculation
	const fixtureUrl = new URL(`./fixtures/${fixtureName}`, import.meta.url);
	return fixtureUrl.pathname.replace(/^\/([A-Z]:)/, "$1");
}

/**
 * Create a temp directory for test isolation and clean it up.
 */
export async function createTempDir(): Promise<string> {
	const dir = join(tmpdir(), `fan-mcp-e2e-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Create a full McpConfig with a single stdio server running a fixture.
 */
export function buildTestConfig(fixtureName: string, overrides: Record<string, unknown> = {}): McpConfig {
	const fixturePath = getFixturePath(fixtureName);
	return {
		servers: [
			{
				transport: "stdio",
				command: "node",
				args: [fixturePath],
				timeout: 10_000,
				autoRestart: true,
				...overrides,
			},
		],
	};
}

/**
 * Create a full McpConfig pointing at the realistic-server fixture with
 * additional write/delete tools accessible.
 */
export function buildRealisticConfig(overrides: Record<string, unknown> = {}): McpConfig {
	return buildTestConfig("realistic-server.mjs", {
		timeout: 15_000,
		...overrides,
	});
}

/**
 * Create a mock ExtensionAPI for testing.
 * All tools are tracked in the `registered` map and `unregistered`/`updated` arrays.
 */
export function makeFakePi() {
	const registered = new Map<string, any>();
	const unregistered: string[] = [];
	const updated: string[] = [];
	const events: string[] = [];

	const api: Record<string, any> = {
		registerTool: vi.fn((def: any) => {
			registered.set(def.name, def);
		}),
		unregisterTool: vi.fn((name: string) => {
			registered.delete(name);
			unregistered.push(name);
		}),
		updateTool: vi.fn((name: string, def: any) => {
			registered.set(name, def);
			updated.push(name);
		}),
		on: vi.fn(),
		events: {
			emit(channel: string, _data: unknown) {
				events.push(channel);
			},
			on: vi.fn(),
			off: vi.fn(),
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
		unregistered,
		updated,
		events,
	};
}

/**
 * Create a PermissionGate that allows everything (permissive for most tests).
 */
export function makePermissiveGate(): PermissionGate {
	return {
		gate: () => ({}),
		updateConfig: () => {},
	};
}

/**
 * Create a PermissionGate that blocks access to specified patterns.
 */
export function makeRestrictiveGate(deniedTools: string[], allowedTools: string[] = ["*"]): PermissionGate {
	let currentDenied = [...deniedTools];
	let currentAllowed = [...allowedTools];
	return {
		gate: (event: any) => {
			if (!("toolName" in event)) return {};
			const fullName = event.toolName as string;
			// Parse tool name (mcp__<id>__<tool>)
			const match = fullName.match(/^mcp__(\d+)__(.+)$/);
			if (!match) return {};
			const tool = match[2];
			if (
				currentDenied.some((d) => {
					if (d === tool) return true;
					if (d.endsWith("*") && tool.startsWith(d.slice(0, -1))) return true;
					return false;
				})
			) {
				return { block: true, reason: `Tool ${tool} denied` };
			}
			if (
				!currentAllowed.includes("*") &&
				!currentAllowed.some((a) => {
					if (a === tool) return true;
					if (a.endsWith("*") && tool.startsWith(a.slice(0, -1))) return true;
					return false;
				})
			) {
				return { block: true, reason: `Tool ${tool} not in allowlist` };
			}
			return {};
		},
		updateConfig(servers: any[]) {
			currentDenied = servers[0]?.deniedTools ?? [];
			currentAllowed = servers[0]?.allowedTools ?? ["*"];
		},
	};
}

/**
 * Sleep helper (avoids importing from timers/promises which may not be available).
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
