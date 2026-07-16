/**
 * Tests for filterToolsByConfig (F-1.9).
 */

import { describe, expect, it } from "vitest";
import { filterToolsByConfig } from "../src/permissions.js";

const sampleTools = [
	{ name: "mcp__fs__read_file" },
	{ name: "mcp__fs__write_file" },
	{ name: "mcp__fs__list_directory" },
	{ name: "mcp__github__search_repositories" },
	{ name: "mcp__github__create_issue" },
];

describe("F-1.9: filterToolsByConfig", () => {
	it("['*'] allows everything", () => {
		expect(filterToolsByConfig(sampleTools, { allowedTools: ["*"] })).toHaveLength(5);
	});

	it("no config allows everything (default)", () => {
		expect(filterToolsByConfig(sampleTools, {})).toHaveLength(5);
	});

	it("exact-name allowedTools", () => {
		const out = filterToolsByConfig(sampleTools, { allowedTools: ["mcp__fs__read_file"] });
		expect(out).toEqual([{ name: "mcp__fs__read_file" }]);
	});

	it("prefix glob allowedTools", () => {
		const out = filterToolsByConfig(sampleTools, { allowedTools: ["mcp__fs__*"] });
		expect(out.map((t) => t.name)).toEqual(["mcp__fs__read_file", "mcp__fs__write_file", "mcp__fs__list_directory"]);
	});

	it("deniedTools takes priority over allowedTools", () => {
		const out = filterToolsByConfig(sampleTools, {
			allowedTools: ["mcp__fs__*"],
			deniedTools: ["mcp__fs__write_file"],
		});
		expect(out.map((t) => t.name)).toEqual(["mcp__fs__read_file", "mcp__fs__list_directory"]);
	});

	it("deniedTools alone removes matches", () => {
		const out = filterToolsByConfig(sampleTools, {
			allowedTools: ["*"],
			deniedTools: ["*create_issue"],
		});
		expect(out.map((t) => t.name)).not.toContain("mcp__github__create_issue");
		expect(out).toHaveLength(4);
	});
});
