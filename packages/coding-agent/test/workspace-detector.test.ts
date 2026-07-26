import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectWorkspaceType } from "../src/workspace/detector.js";

// The detector has no system-path exclusions (those live in
// project-auto-register), so fixtures can live in os.tmpdir().
describe("workspace detector (F-3.2)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "fan-ws-detect-"));
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	function makeWorkspace(name: string): string {
		const dir = join(workDir, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function touch(dir: string, ...segments: string[]): void {
		writeFileSync(join(dir, ...segments), "", "utf-8");
	}

	describe("TC-F-3.2-1: code project detection", () => {
		test(".git + src/ → 'code'", () => {
			const dir = makeWorkspace("code-src");
			mkdirSync(join(dir, ".git"));
			mkdirSync(join(dir, "src"));

			expect(detectWorkspaceType(dir)).toBe("code");
		});

		test(".git + package.json (no src/) → 'code'", () => {
			const dir = makeWorkspace("code-pkg");
			mkdirSync(join(dir, ".git"));
			touch(dir, "package.json");

			expect(detectWorkspaceType(dir)).toBe("code");
		});

		test(".git file (worktree gitfile) + src/ → 'code'", () => {
			const dir = makeWorkspace("code-worktree");
			touch(dir, ".git");
			mkdirSync(join(dir, "src"));

			expect(detectWorkspaceType(dir)).toBe("code");
		});
	});

	describe("TC-F-3.2-2: research workspace detection", () => {
		test("docs/research/ → 'research'", () => {
			const dir = makeWorkspace("research-docs");
			mkdirSync(join(dir, "docs", "research"), { recursive: true });

			expect(detectWorkspaceType(dir)).toBe("research");
		});

		test(".fan/prompts/ → 'research'", () => {
			const dir = makeWorkspace("research-prompts");
			mkdirSync(join(dir, ".fan", "prompts"), { recursive: true });

			expect(detectWorkspaceType(dir)).toBe("research");
		});

		test("bare docs/ (without research/) is NOT 'research'", () => {
			const dir = makeWorkspace("plain-docs");
			mkdirSync(join(dir, "docs"));

			expect(detectWorkspaceType(dir)).toBe("unknown");
		});
	});

	describe("TC-F-3.2-3: unknown for empty directory", () => {
		test("empty dir → 'unknown'", () => {
			const dir = makeWorkspace("empty");

			expect(detectWorkspaceType(dir)).toBe("unknown");
		});
	});

	describe("automation detection", () => {
		test("scripts/*.sh + config/ → 'automation'", () => {
			const dir = makeWorkspace("auto-scripts-dir");
			mkdirSync(join(dir, "scripts"));
			touch(dir, "scripts", "daily.sh");
			mkdirSync(join(dir, "config"));

			expect(detectWorkspaceType(dir)).toBe("automation");
		});

		test("root-level *.py + root-level *.yaml → 'automation'", () => {
			const dir = makeWorkspace("auto-root");
			touch(dir, "pipeline.py");
			touch(dir, "settings.yaml");

			expect(detectWorkspaceType(dir)).toBe("automation");
		});

		test("scripts without config → 'unknown'", () => {
			const dir = makeWorkspace("scripts-only");
			mkdirSync(join(dir, "scripts"));
			touch(dir, "scripts", "weekly.py");

			expect(detectWorkspaceType(dir)).toBe("unknown");
		});

		test("config without scripts → 'unknown'", () => {
			const dir = makeWorkspace("config-only");
			mkdirSync(join(dir, "config"));
			touch(dir, "app.toml");

			expect(detectWorkspaceType(dir)).toBe("unknown");
		});

		test("package.json is not a config file (no false 'automation')", () => {
			const dir = makeWorkspace("js-no-git");
			touch(dir, "run.sh");
			touch(dir, "package.json");

			expect(detectWorkspaceType(dir)).toBe("unknown");
		});
	});

	describe("priority and fallback", () => {
		test(".git without src/ or package.json → NOT 'code'", () => {
			const dir = makeWorkspace("bare-git");
			mkdirSync(join(dir, ".git"));

			expect(detectWorkspaceType(dir)).toBe("unknown");
		});

		test("code wins over research and automation", () => {
			const dir = makeWorkspace("priority-code");
			mkdirSync(join(dir, ".git"));
			mkdirSync(join(dir, "src"));
			mkdirSync(join(dir, "docs", "research"), { recursive: true });
			mkdirSync(join(dir, "scripts"));
			touch(dir, "scripts", "x.sh");
			mkdirSync(join(dir, "config"));

			expect(detectWorkspaceType(dir)).toBe("code");
		});

		test("research wins over automation", () => {
			const dir = makeWorkspace("priority-research");
			mkdirSync(join(dir, "docs", "research"), { recursive: true });
			mkdirSync(join(dir, "scripts"));
			touch(dir, "scripts", "x.sh");
			mkdirSync(join(dir, "config"));

			expect(detectWorkspaceType(dir)).toBe("research");
		});
	});

	describe("robustness", () => {
		test("non-existent directory → 'unknown' without crashing", () => {
			expect(detectWorkspaceType(join(workDir, "does-not-exist"))).toBe("unknown");
		});

		test("path to a file → 'unknown' without crashing", () => {
			const dir = makeWorkspace("file-target");
			touch(dir, "a-file.txt");

			expect(detectWorkspaceType(join(dir, "a-file.txt"))).toBe("unknown");
		});
	});
});
