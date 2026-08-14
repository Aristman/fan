import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	TOTAL_CONTEXT_LIMIT,
	clearContextCache,
	collectProjectContext,
	filterTreeLines,
	formatContextBlock,
	mergeContext,
	truncate,
} from "../context-builder.js";

describe("context-builder.js: truncate", () => {
	it("returns short strings unchanged", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("marks truncated strings with omitted char count", () => {
		const input = "a".repeat(100);
		const out = truncate(input, 40);
		expect(out.startsWith("a".repeat(40))).toBe(true);
		expect(out).toContain("... (truncated, 60 chars omitted)");
	});
});

describe("context-builder.js: formatContextBlock", () => {
	it("returns empty string for undefined context", () => {
		expect(formatContextBlock(undefined)).toBe("");
	});

	it("returns empty string for an empty context object", () => {
		expect(formatContextBlock({})).toBe("");
	});

	it("renders only non-empty sections", () => {
		const block = formatContextBlock({ parentSummary: "We are adding retry logic." });
		expect(block).toContain("## Project Context");
		expect(block).toContain("### Summary");
		expect(block).toContain("We are adding retry logic.");
		expect(block).not.toContain("### Relevant Files");
		expect(block).not.toContain("### Previous Findings");
		expect(block).not.toContain("### Constraints");
		expect(block).not.toContain("### Git State");
		expect(block).not.toContain("### Project Structure");
	});

	it("renders relevantFiles as strings and as {path, lines, purpose}", () => {
		const block = formatContextBlock({
			relevantFiles: [
				"src/index.ts",
				{ path: "src/rpc.ts", lines: "10-42", purpose: "worker spawn logic" },
				{ path: "src/config.ts" },
			],
		});
		expect(block).toContain("### Relevant Files");
		expect(block).toContain("- `src/index.ts`");
		expect(block).toContain("- `src/rpc.ts` (lines 10-42) — worker spawn logic");
		expect(block).toContain("- `src/config.ts`");
	});

	it("truncates oversized sections with a marker", () => {
		const block = formatContextBlock({ previousFindings: "x".repeat(20000) });
		expect(block).toContain("... (truncated,");
		expect(block).toContain("chars omitted)");
	});

	it("renders all sections when all fields are present", () => {
		const block = formatContextBlock({
			parentSummary: "summary text",
			relevantFiles: ["a.ts"],
			previousFindings: "findings text",
			constraints: ["no breaking changes"],
			gitState: "M file.ts",
			projectTree: "src/\n  core/",
		});
		expect(block).toContain("### Summary");
		expect(block).toContain("### Relevant Files");
		expect(block).toContain("### Previous Findings");
		expect(block).toContain("### Constraints");
		expect(block).toContain("- no breaking changes");
		expect(block).toContain("### Git State");
		expect(block).toContain("### Project Structure");
	});

	it("keeps the total block within TOTAL_CONTEXT_LIMIT (plus marker)", () => {
		const block = formatContextBlock({
			parentSummary: "p".repeat(50000),
			relevantFiles: Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`),
			previousFindings: "f".repeat(50000),
			constraints: Array.from({ length: 200 }, (_, i) => `constraint ${i}`),
			gitState: "g".repeat(50000),
			projectTree: "t".repeat(50000),
		});
		expect(block.length).toBeLessThanOrEqual(TOTAL_CONTEXT_LIMIT + 60);
	});
});

describe("context-builder.js: filterTreeLines", () => {
	it("drops lines where any path segment is an excluded directory", () => {
		const raw = [
			"./packages",
			"./packages/core",
			"./node_modules",
			"./node_modules/.bin",
			"./node_modules/@types",
			"./node_modules/express",
			"./dist",
			"./dist/extensions",
			"./.git",
			"./.git/objects",
			"./.fan",
			"./.fan/reports",
			"./extensions",
			"./extensions/fan-orchestrator",
		].join("\n");
		const result = filterTreeLines(raw);
		expect(result).toContain("./packages");
		expect(result).toContain("./packages/core");
		expect(result).toContain("./extensions");
		expect(result).toContain("./extensions/fan-orchestrator");
		expect(result).not.toContain("node_modules");
		expect(result).not.toContain(".bin");
		expect(result).not.toContain("@types");
		expect(result).not.toContain("express");
		expect(result).not.toContain("./dist");
		expect(result).not.toContain("./.git");
		expect(result).not.toContain("./.fan");
	});

	it("handles backslash paths (win32 style)", () => {
		const raw = [
			".\\packages",
			".\\packages\\core",
			".\\node_modules",
			".\\node_modules\\.bin",
			".\\node_modules\\@types",
		].join("\n");
		const result = filterTreeLines(raw);
		expect(result).toContain("packages");
		expect(result).not.toContain("node_modules");
		expect(result).not.toContain(".bin");
		expect(result).not.toContain("@types");
	});

	it("filters out the bare '.' root entry", () => {
		const raw = ".\n./packages\n./packages/core";
		const result = filterTreeLines(raw);
		expect(result).not.toMatch(/^\.$/m);
		expect(result).toContain("./packages");
	});

	it("returns empty string for empty input", () => {
		expect(filterTreeLines("")).toBe("");
		expect(filterTreeLines("\n\n")).toBe("");
	});
});

describe("context-builder.js: collectProjectContext", () => {
	beforeEach(() => {
		clearContextCache();
	});

	it("returns gitState and projectTree fields for the current repo", () => {
		const ctx = collectProjectContext(process.cwd());
		expect(typeof ctx.gitState).toBe("string");
		expect(ctx.gitState.length).toBeGreaterThan(0);
		expect(typeof ctx.projectTree).toBe("string");
		expect(ctx.projectTree.length).toBeGreaterThan(0);
		// Auto-collected context never carries coordinator-owned fields
		expect(ctx.parentSummary).toBeUndefined();
		expect(ctx.relevantFiles).toBeUndefined();
		expect(ctx.constraints).toBeUndefined();
	}, 30000);

	it("handles a non-git directory gracefully (never throws)", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fan-ctx-test-"));
		try {
			const ctx = collectProjectContext(tmpDir);
			expect(typeof ctx.gitState).toBe("string");
			expect(ctx.gitState.length).toBeGreaterThan(0);
			expect(typeof ctx.projectTree).toBe("string");
			expect(ctx.projectTree.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 30000);

	it("respects includeGitState / includeProjectTree flags", () => {
		const ctx = collectProjectContext(process.cwd(), {
			includeGitState: false,
			includeProjectTree: false,
		});
		expect(ctx.gitState).toBeUndefined();
		expect(ctx.projectTree).toBeUndefined();
	});

	it("projectTree does not contain node_modules children", () => {
		// Use repo root (two levels up from extensions/fan-orchestrator) to get a rich tree
		const repoRoot = path.resolve(process.cwd(), "../..");
		const ctx = collectProjectContext(repoRoot);
		const tree = ctx.projectTree || "";
		// Must not contain any node_modules path segment or its children
		const lines = tree.split("\n");
		const nmLines = lines.filter((l) => l.includes("node_modules"));
		expect(nmLines).toHaveLength(0);
		// Must not contain well-known node_modules children
		expect(tree).not.toContain(".bin");
		expect(tree).not.toContain("@types");
		// Must contain known root directories (present in the FAN repo)
		expect(tree).toMatch(/packages/);
		expect(tree).toMatch(/extensions/);
	}, 30000);

	it("projectTree shows hierarchy via relative paths", () => {
		const repoRoot = path.resolve(process.cwd(), "../..");
		const ctx = collectProjectContext(repoRoot);
		const tree = ctx.projectTree || "";
		// Should contain relative path prefixes showing hierarchy
		expect(tree).toMatch(/\.\/|\.\\/);
		// Children should be distinguishable from roots (deeper paths)
		const lines = tree.split("\n").filter(Boolean);
		const deepLines = lines.filter((l) => {
			const segments = l.replace(/\\/g, "/").split("/").filter(Boolean);
			return segments.length >= 3; // e.g. ./packages/core = 3 segments
		});
		expect(deepLines.length).toBeGreaterThan(0);
	}, 30000);

	it("caches results: second call returns same object without re-exec", () => {
		const ctx1 = collectProjectContext(process.cwd());
		const ctx2 = collectProjectContext(process.cwd());
		// Must be the exact same object reference (cached)
		expect(ctx2).toBe(ctx1);
	}, 30000);

	it("cache differentiates by flags", () => {
		const ctxAll = collectProjectContext(process.cwd());
		const ctxNoGit = collectProjectContext(process.cwd(), { includeGitState: false });
		// Different flags → different cache entries
		expect(ctxNoGit).not.toBe(ctxAll);
		expect(ctxNoGit.gitState).toBeUndefined();
		expect(ctxAll.gitState).toBeDefined();
	}, 30000);

	it("clearContextCache forces re-collection", () => {
		const ctx1 = collectProjectContext(process.cwd());
		clearContextCache();
		const ctx2 = collectProjectContext(process.cwd());
		// After clearing, should be a new object (not cached)
		expect(ctx2).not.toBe(ctx1);
		// But same shape
		expect(typeof ctx2.gitState).toBe("string");
		expect(typeof ctx2.projectTree).toBe("string");
	}, 30000);

	it("git uses independent placeholders when git is unavailable", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fan-ctx-nogit-"));
		try {
			const ctx = collectProjectContext(tmpDir);
			// gitState should still be a string with placeholders, not the old misleading message
			expect(ctx.gitState).toBeDefined();
			expect(ctx.gitState).not.toContain("not a git repository");
			// Should contain per-command placeholders
			expect(ctx.gitState).toContain("(git status unavailable)");
			expect(ctx.gitState).toContain("(git log unavailable)");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 30000);
});

describe("context-builder.js: mergeContext", () => {
	it("returns undefined when both inputs are undefined", () => {
		expect(mergeContext(undefined, undefined)).toBeUndefined();
	});

	it("returns the explicit context when auto is undefined", () => {
		const explicit = { parentSummary: "s" };
		expect(mergeContext(explicit, undefined)).toBe(explicit);
	});

	it("returns the auto context when explicit is undefined", () => {
		const auto = { gitState: "clean" };
		expect(mergeContext(undefined, auto)).toBe(auto);
	});

	it("explicit fields take priority over auto-collected ones", () => {
		const merged = mergeContext(
			{ parentSummary: "s", gitState: "explicit git" },
			{ gitState: "auto git", projectTree: "auto tree" }
		);
		expect(merged.parentSummary).toBe("s");
		expect(merged.gitState).toBe("explicit git");
		expect(merged.projectTree).toBe("auto tree");
	});

	it("merges non-overlapping fields from both sources", () => {
		const merged = mergeContext(
			{ parentSummary: "s", constraints: ["keep minimal"] },
			{ gitState: "auto git", projectTree: "auto tree" }
		);
		expect(merged).toEqual({
			parentSummary: "s",
			constraints: ["keep minimal"],
			gitState: "auto git",
			projectTree: "auto tree",
		});
	});
});
