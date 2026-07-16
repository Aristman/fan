/**
 * Tests for createPermissionGate and parseMcpToolName (F-1.10).
 */

import { describe, expect, it } from "vitest";
import { createPermissionGate, parseMcpToolName } from "../src/permissions.js";
import type { ToolCallEvent } from "@seaagents/fan-coding-agent";

function makeEvent(toolName: string, input: unknown = {}): ToolCallEvent {
	return { type: "tool_call", toolCallId: "id1", toolName, input } as any;
}

describe("F-1.10: parseMcpToolName", () => {
	it("parses mcp__fs__read_file", () => {
		expect(parseMcpToolName("mcp__fs__read_file")).toEqual({ serverId: "fs", tool: "read_file" });
	});

	it("parses mcp__0__delete_file (numeric serverId)", () => {
		expect(parseMcpToolName("mcp__0__delete_file")).toEqual({ serverId: "0", tool: "delete_file" });
	});

	it("parses mcp__1__search_repositories (numeric serverId)", () => {
		expect(parseMcpToolName("mcp__1__search_repositories")).toEqual({ serverId: "1", tool: "search_repositories" });
	});

	it("returns null for non-MCP names", () => {
		expect(parseMcpToolName("read_file")).toBeNull();
		expect(parseMcpToolName("bash")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseMcpToolName("")).toBeNull();
	});
});

describe("F-1.10: createPermissionGate", () => {
	const configs = [
		{
			transport: "stdio" as const,
			command: "x",
			allowedTools: ["*"],
			deniedTools: ["mcp__0__delete_file"],
		},
		{
			transport: "streamable-http" as const,
			url: "https://api.example.com/mcp",
			allowedTools: ["mcp__1__search_*"],
		},
	];

	it("passes allowed tool (server 0)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__0__read_file"));
		expect(result.block).toBeUndefined();
	});

	it("blocks denied tool (server 0)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__0__delete_file"));
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/delete_file/);
	});

	it("blocks tool not in allowlist (server 1)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__1__create_issue"));
		expect(result.block).toBe(true);
	});

	it("allows tool matching prefix glob (server 1)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__1__search_repositories"));
		expect(result.block).toBeUndefined();
	});

	it("passes non-MCP tool through with no action", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("bash"));
		expect(result.block).toBeUndefined();
	});

	it("blocks server index not in config", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__99__anything"));
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/not found/);
	});

	it("blocks when deniedTools glob matches despite allowedTools", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__0__delete_file"));
		expect(result.block).toBe(true);
	});
});
