import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	formatProjectsTable,
	parseRegisterArgs,
	registerProject,
	runProjectCommand,
} from "../src/cli/project-command.js";
import { listProjects } from "../src/core/project-registry.js";

// Scratch dir next to the test file (inside the repo), cleaned up after each test —
// same pattern as auto-register.test.ts.
const testDir = dirname(fileURLToPath(import.meta.url));

describe("fan project CLI (F-1.8)", () => {
	let workDir: string;
	let projectsPath: string;
	let outLines: string[];
	let errLines: string[];

	beforeEach(() => {
		workDir = mkdtempSync(join(testDir, ".tmp-project-command-"));
		projectsPath = join(workDir, "registry", "projects.json");
		outLines = [];
		errLines = [];
	});

	afterEach(() => {
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	function run(args: string[]): number {
		return runProjectCommand(args, {
			projectsPath,
			log: (line) => outLines.push(line),
			error: (line) => errLines.push(line),
		});
	}

	describe("parseRegisterArgs", () => {
		test("parses path without --type", () => {
			expect(parseRegisterArgs(["/data/repos/x"])).toEqual({ path: "/data/repos/x", type: undefined });
		});

		test("parses --type with separate and inline value", () => {
			expect(parseRegisterArgs(["/x", "--type", "code"])).toEqual({ path: "/x", type: "code" });
			expect(parseRegisterArgs(["/x", "--type=research"])).toEqual({ path: "/x", type: "research" });
		});

		test("missing path → error", () => {
			expect(parseRegisterArgs([]).error).toMatch(/<path>/);
			expect(parseRegisterArgs(["--type", "code"]).error).toMatch(/<path>/);
		});

		test("invalid --type → error", () => {
			expect(parseRegisterArgs(["/x", "--type", "bogus"]).error).toMatch(/--type/);
			expect(parseRegisterArgs(["/x", "--type"]).error).toMatch(/--type/);
		});

		test("unknown option and extra positional → error", () => {
			expect(parseRegisterArgs(["/x", "--verbose"]).error).toMatch(/Unknown option/);
			expect(parseRegisterArgs(["/x", "/y"]).error).toMatch(/Unexpected argument/);
		});
	});

	describe("TC-F-1.8-1: register", () => {
		test("existing git repo → exit 0, registry entry type=code, confirmation output", () => {
			const projectDir = join(workDir, "manual-test");
			mkdirSync(join(projectDir, ".git"), { recursive: true });

			const code = run(["register", projectDir]);

			expect(code).toBe(0);
			expect(errLines).toEqual([]);
			expect(outLines.join("\n")).toContain("Registered project:");

			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(1);
			expect(projects[0].path).toBe(resolve(projectDir));
			expect(projects[0].name).toBe("manual-test");
			expect(projects[0].type).toBe("code");
		});

		test("existing dir without .git/docs → type auto-detected as unknown", () => {
			const projectDir = join(workDir, "plain");
			mkdirSync(projectDir);

			const code = run(["register", projectDir]);

			expect(code).toBe(0);
			expect(listProjects(projectsPath)[0].type).toBe("unknown");
		});

		test("--type overrides auto-detection", () => {
			const projectDir = join(workDir, "with-docs");
			mkdirSync(join(projectDir, "docs"), { recursive: true });

			const code = run(["register", projectDir, "--type", "automation"]);

			expect(code).toBe(0);
			expect(listProjects(projectsPath)[0].type).toBe("automation");
		});

		test("non-existent path → registered with warning, type unknown (documented decision)", () => {
			const futurePath = join(workDir, "not-yet-cloned");

			const code = run(["register", futurePath]);

			expect(code).toBe(0);
			expect(errLines.join("\n")).toContain("does not exist");
			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(1);
			expect(projects[0].path).toBe(resolve(futurePath));
			expect(projects[0].type).toBe("unknown");
		});

		test("non-existent path with explicit --type keeps the given type", () => {
			const futurePath = join(workDir, "future-research");

			const code = run(["register", futurePath, "--type", "research"]);

			expect(code).toBe(0);
			expect(errLines.join("\n")).toContain("does not exist");
			expect(listProjects(projectsPath)[0].type).toBe("research");
		});

		test("re-registering same path is a no-op (dedup)", () => {
			const projectDir = join(workDir, "dup");
			mkdirSync(projectDir);

			expect(run(["register", projectDir])).toBe(0);
			expect(run(["register", projectDir])).toBe(0);

			expect(outLines.join("\n")).toContain("already registered");
			expect(listProjects(projectsPath)).toHaveLength(1);
		});

		test("registerProject returns outcome without touching the CLI", () => {
			const projectDir = join(workDir, "direct");
			mkdirSync(join(projectDir, ".git"), { recursive: true });

			const outcome = registerProject(projectDir, undefined, projectsPath);

			expect(outcome.warning).toBeUndefined();
			expect(outcome.result.added).toBe(true);
			expect(outcome.result.entry.type).toBe("code");
		});

		test("missing path → exit 1 with usage", () => {
			const code = run(["register"]);

			expect(code).toBe(1);
			expect(errLines.join("\n")).toContain("<path>");
			expect(errLines.join("\n")).toContain("Usage:");
			expect(listProjects(projectsPath)).toEqual([]);
		});

		test("invalid --type → exit 1", () => {
			expect(run(["register", join(workDir, "x"), "--type", "bogus"])).toBe(1);
			expect(listProjects(projectsPath)).toEqual([]);
		});

		test("unknown subcommand / missing subcommand → exit 1", () => {
			expect(run(["bogus"])).toBe(1);
			expect(run([])).toBe(1);
		});
	});

	describe("TC-F-1.8-2: list", () => {
		test("prints table with all registered projects", () => {
			const a = join(workDir, "project-a");
			const b = join(workDir, "project-b");
			mkdirSync(join(a, ".git"), { recursive: true });
			mkdirSync(join(b, "docs"), { recursive: true });
			expect(run(["register", a])).toBe(0);
			expect(run(["register", b])).toBe(0);
			outLines = [];

			const code = run(["list"]);

			expect(code).toBe(0);
			const output = outLines.join("\n");
			// Header: PATH | NAME | TYPE | ADDED AT
			expect(output).toContain("PATH");
			expect(output).toContain("NAME");
			expect(output).toContain("TYPE");
			expect(output).toContain("ADDED AT");
			// Both projects appear
			expect(output).toContain(resolve(a));
			expect(output).toContain("project-a");
			expect(output).toContain("code");
			expect(output).toContain(resolve(b));
			expect(output).toContain("project-b");
			expect(output).toContain("research");
		});

		test("formatProjectsTable aligns columns and contains every entry", () => {
			const projects = listProjects(projectsPath);
			expect(projects).toEqual([]);

			expect(formatProjectsTable(projects)).toBe("No projects registered.");

			run(["register", join(workDir, "one")]);
			const table = formatProjectsTable(listProjects(projectsPath));
			const lines = table.split("\n");
			expect(lines[0]).toMatch(/^PATH\s+NAME\s+TYPE\s+ADDED AT$/);
			expect(lines).toHaveLength(3); // header + separator + 1 row
		});

		test("empty registry → friendly message, exit 0", () => {
			const code = run(["list"]);

			expect(code).toBe(0);
			expect(outLines.join("\n")).toContain("No projects registered.");
		});
	});
});
