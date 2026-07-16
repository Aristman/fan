/**
 * Tests for createPermissionGate and parseMcpToolName (F-1.10).
 */

import type { ToolCallEvent } from "@seaagents/fan-coding-agent";
import { describe, expect, it } from "vitest";
import { createPermissionGate, isValidServerId, parseMcpToolName } from "../src/permissions.js";

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

describe("isValidServerId (BUG-2 fix)", () => {
	it("allows positive integer strings", () => {
		expect(isValidServerId("0")).toBe(true);
		expect(isValidServerId("1")).toBe(true);
		expect(isValidServerId("99")).toBe(true);
	});

	it("blocks exponential notation that coerces to 0", () => {
		expect(isValidServerId("0e0")).toBe(false);
	});

	it("blocks negative zero", () => {
		expect(isValidServerId("-0")).toBe(false);
		expect(isValidServerId("+0")).toBe(false);
	});

	it("blocks whitespace strings that coerce to 0", () => {
		expect(isValidServerId("  ")).toBe(false);
		expect(isValidServerId("\t")).toBe(false);
	});

	it("blocks negative numbers", () => {
		expect(isValidServerId("-1")).toBe(false);
	});

	it("blocks non-numeric strings", () => {
		expect(isValidServerId("abc")).toBe(false);
		expect(isValidServerId("0x1")).toBe(false);
	});
});

describe("BUG-2: Server ID alias injection via gate()", () => {
	const configs = [
		{
			transport: "stdio" as const,
			command: "x",
			allowedTools: ["*"],
		},
	];

	it("blocks mcp__0e0__admin (exponential alias)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__0e0__admin"));
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/Invalid server ID/);
	});

	it("blocks mcp__-0__x (negative zero alias)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__-0__x"));
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/Invalid server ID/);
	});

	it("blocks mcp__+1__x (positive sign alias)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__+1__x"));
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/Invalid server ID/);
	});

	it("blocks mcp__  __x (whitespace alias)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__  __x"));
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/Invalid server ID/);
	});

	it("allows mcp__0__x (valid positive integer)", () => {
		const gate = createPermissionGate(configs);
		const result = gate.gate(makeEvent("mcp__0__x"));
		expect(result.block).toBeUndefined();
	});
});

// ──────────────────────────────────────────────────
// BUG-6: matchGlob ReDoS regression tests
// ──────────────────────────────────────────────────

describe("BUG-6: matchGlob ReDoS protection (tested via gate)", () => {
	const _configs = [
		{
			transport: "stdio" as const,
			command: "x",
			allowedTools: ["*"],
			deniedTools: [] as string[],
		},
	];

	it("rejects pattern exceeding MAX_GLOB_PATTERN_LENGTH (>256)", () => {
		const longPattern = `mcp__${"a".repeat(260)}__tool`;
		// Should not throw and should not match
		const gate = createPermissionGate([
			{
				transport: "stdio" as const,
				command: "x",
				allowedTools: [longPattern],
			},
		]);
		const result = gate.gate(makeEvent("mcp__anything__tool"));
		expect(result.block).toBe(true);
	});

	it("handles many asterisks safely (11 *a* patterns)", () => {
		const manyStars = "*".repeat(11).split("").join("x"); // "*x*x*x*x*x*x*x*x*x*x*x"
		const gate = createPermissionGate([
			{
				transport: "stdio" as const,
				command: "x",
				allowedTools: [manyStars],
			},
		]);
		// Should not hang or throw — the result is irrelevant, safety is the concern
		expect(() => gate.gate(makeEvent("some_target_tool"))).not.toThrow();
		expect(() => gate.gate(makeEvent("xxxxxxxxxxx"))).not.toThrow();
	});

	it("standard *read_* patterns still work", () => {
		const gate = createPermissionGate([
			{
				transport: "stdio" as const,
				command: "x",
				allowedTools: ["read_*"],
			},
		]);
		expect(gate.gate(makeEvent("mcp__0__read_file")).block).toBeUndefined();
		expect(gate.gate(makeEvent("mcp__0__write_file")).block).toBe(true);
	});
});

describe("F-1.10: createPermissionGate", () => {
	const configs = [
		{
			transport: "stdio" as const,
			command: "x",
			allowedTools: ["*"],
			deniedTools: ["delete_file"],
		},
		{
			transport: "streamable-http" as const,
			url: "https://api.example.com/mcp",
			allowedTools: ["search_*"],
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

	it("blocks tool using raw denied pattern without server prefix", () => {
		// BUG-8: deniedTools uses RAW tool names; full MCP name is parsed internally
		const gate = createPermissionGate([
			{
				transport: "stdio" as const,
				command: "x",
				allowedTools: ["*"],
				deniedTools: ["delete_file"],
			},
		]);
		// "mcp__0__delete_file" should be blocked because parsed.tool = "delete_file"
		// matches deniedTools pattern "delete_file"
		expect(gate.gate(makeEvent("mcp__0__delete_file")).block).toBe(true);
	});
});
