import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { addToProjects, getProjectsPath, listProjects } from "../src/core/project-registry.js";

describe("project-registry (F-1.6)", () => {
	let tempDir: string;
	let projectsPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `fan-test-project-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		projectsPath = join(tempDir, "projects.json");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("getProjectsPath", () => {
		test("resolves inside the agent dir", () => {
			expect(getProjectsPath()).toMatch(/projects\.json$/);
			expect(getProjectsPath()).toContain("agent");
		});
	});

	describe("TC-F-1.6-1: addToProjects writes valid JSON with correct fields", () => {
		test("adds entry with explicit name, default type and ISO timestamp", () => {
			const { added, entry } = addToProjects("/data/repos/new", "new", undefined, projectsPath);

			expect(added).toBe(true);
			expect(entry.path).toBe(resolve("/data/repos/new"));
			expect(entry.name).toBe("new");
			expect(entry.type).toBe("unknown");
			expect(new Date(entry.addedAt).toISOString()).toBe(entry.addedAt);

			// File contains valid JSON matching the entry
			const onDisk = JSON.parse(readFileSync(projectsPath, "utf-8"));
			expect(onDisk).toEqual([entry]);
		});

		test("derives name from path basename when name is omitted", () => {
			const { entry } = addToProjects("/data/repos/my-project", undefined, "code", projectsPath);
			expect(entry.name).toBe("my-project");
			expect(entry.type).toBe("code");
		});

		test("creates parent directory when missing", () => {
			const nestedPath = join(tempDir, "nested", "agent", "projects.json");
			const { added } = addToProjects("/data/repos/x", "x", undefined, nestedPath);
			expect(added).toBe(true);
			expect(existsSync(nestedPath)).toBe(true);
		});

		test("listProjects returns previously added entries", () => {
			addToProjects("/data/repos/a", "a", "code", projectsPath);
			addToProjects("/data/repos/b", "b", "research", projectsPath);

			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(2);
			expect(projects.map((p) => p.name)).toEqual(["a", "b"]);
			expect(projects.map((p) => p.type)).toEqual(["code", "research"]);
		});
	});

	describe("TC-F-1.6-2: duplicate path is ignored", () => {
		test("second add of same path does not duplicate or overwrite", () => {
			const first = addToProjects("/data/repos/dup", "original", "code", projectsPath);
			const second = addToProjects("/data/repos/dup", "new-name", "automation", projectsPath);

			expect(first.added).toBe(true);
			expect(second.added).toBe(false);
			// Existing entry returned unchanged — name/type NOT overwritten
			expect(second.entry).toEqual(first.entry);

			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(1);
			expect(projects[0].name).toBe("original");
			expect(projects[0].type).toBe("code");
		});

		test("dedup works on equivalent relative/absolute paths", () => {
			addToProjects("sub/project", "first", undefined, projectsPath);
			const result = addToProjects(resolve("sub/project"), "second", undefined, projectsPath);

			expect(result.added).toBe(false);
			expect(listProjects(projectsPath)).toHaveLength(1);
		});
	});

	describe("TC-F-1.6-3: corrupted file handled without crash", () => {
		test("invalid JSON returns empty array and logs warning", () => {
			writeFileSync(projectsPath, "{ not valid json !!!", "utf-8");
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const projects = listProjects(projectsPath);

			expect(projects).toEqual([]);
			expect(warnSpy).toHaveBeenCalledOnce();
		});

		test("non-array JSON returns empty array and logs warning", () => {
			writeFileSync(projectsPath, JSON.stringify({ path: "/data/repos/x" }), "utf-8");
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(listProjects(projectsPath)).toEqual([]);
			expect(warnSpy).toHaveBeenCalledOnce();
		});

		test("missing file returns empty array without warning", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(listProjects(projectsPath)).toEqual([]);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		test("malformed entries are filtered out", () => {
			const valid = { path: "/data/repos/ok", name: "ok", type: "code", addedAt: new Date().toISOString() };
			writeFileSync(
				projectsPath,
				JSON.stringify([valid, { name: "no-path" }, null, { path: "/x", name: "x", type: "bogus", addedAt: "t" }]),
				"utf-8",
			);

			expect(listProjects(projectsPath)).toEqual([valid]);
		});

		test("addToProjects recovers from corrupted file", () => {
			writeFileSync(projectsPath, "broken", "utf-8");
			vi.spyOn(console, "warn").mockImplementation(() => {});

			const { added, entry } = addToProjects("/data/repos/fresh", "fresh", undefined, projectsPath);

			expect(added).toBe(true);
			expect(JSON.parse(readFileSync(projectsPath, "utf-8"))).toEqual([entry]);
		});
	});

	describe("atomic writes", () => {
		test("no tmp files remain after write", () => {
			addToProjects("/data/repos/a", "a", undefined, projectsPath);
			addToProjects("/data/repos/b", "b", undefined, projectsPath);

			const tmpFiles = readdirSync(tempDir).filter((f) => f.endsWith(".tmp"));
			expect(tmpFiles).toEqual([]);
		});

		test("registry stays valid across many sequential adds", () => {
			for (let i = 0; i < 50; i++) {
				addToProjects(`/data/repos/p${i}`, `p${i}`, undefined, projectsPath);
			}

			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(50);
			// File is valid JSON
			expect(JSON.parse(readFileSync(projectsPath, "utf-8"))).toHaveLength(50);
			// No tmp leftovers
			expect(readdirSync(tempDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		});
	});
});
