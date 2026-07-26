import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	addToProjects,
	getProjectsPath,
	listProjects,
	PROJECT_TYPES,
	removeFromProjects,
	updateProjectType,
} from "../src/core/project-registry.js";

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

		test("structurally malformed entries are filtered out", () => {
			const valid = { path: "/data/repos/ok", name: "ok", type: "code", addedAt: new Date().toISOString() };
			writeFileSync(
				projectsPath,
				JSON.stringify([
					valid,
					{ name: "no-path" },
					null,
					{ path: "", name: "x", type: "code", addedAt: "t" },
					{ path: "/x", name: "x", type: "code" },
				]),
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

	describe("workspace types (F-3.1)", () => {
		test("TC-F-3.1-1: every entry exposes a string type; addToProjects defaults to 'unknown'", () => {
			addToProjects("/data/repos/a", "a", undefined, projectsPath);
			addToProjects("/data/repos/b", "b", "automation", projectsPath);

			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(2);
			for (const p of projects) {
				expect(typeof p.type).toBe("string");
				expect(PROJECT_TYPES).toContain(p.type);
			}
			expect(projects[0].type).toBe("unknown");
			expect(projects[1].type).toBe("automation");

			// PROJECT_TYPES contains exactly the 4 spec values
			expect([...PROJECT_TYPES].sort()).toEqual(["automation", "code", "research", "unknown"]);
		});

		test("TC-F-3.1-2: legacy entry without type reads back as 'unknown'", () => {
			// Simulate a registry written before the `type` field existed
			const legacy = { path: "/data/repos/legacy", name: "legacy", addedAt: new Date().toISOString() };
			writeFileSync(projectsPath, JSON.stringify([legacy]), "utf-8");

			const projects = listProjects(projectsPath);
			expect(projects).toEqual([{ ...legacy, type: "unknown" }]);
		});

		test("invalid type value in file is normalized to 'unknown'", () => {
			const addedAt = new Date().toISOString();
			writeFileSync(
				projectsPath,
				JSON.stringify([
					{ path: "/data/repos/bogus", name: "bogus", type: "bogus", addedAt },
					{ path: "/data/repos/nonstring", name: "nonstring", type: 42, addedAt },
					{ path: "/data/repos/nulltype", name: "nulltype", type: null, addedAt },
					{ path: "/data/repos/ok", name: "ok", type: "research", addedAt },
				]),
				"utf-8",
			);

			const projects = listProjects(projectsPath);
			expect(projects.map((p) => p.type)).toEqual(["unknown", "unknown", "unknown", "research"]);
		});

		test("addToProjects accepts each of the 4 project types", () => {
			for (const type of PROJECT_TYPES) {
				const { entry } = addToProjects(`/data/repos/t-${type}`, `t-${type}`, type, projectsPath);
				expect(entry.type).toBe(type);
			}
			expect(listProjects(projectsPath).map((p) => p.type)).toEqual([...PROJECT_TYPES]);
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

	describe("updateProjectType (F-3.10)", () => {
		// TC-F-3.10-1: PUT обновляет тип в реестре
		test("updates the type and persists atomically (TC-F-3.10-1)", () => {
			addToProjects("/data/repos/a", "a", "unknown", projectsPath);
			addToProjects("/data/repos/b", "b", "code", projectsPath);

			const result = updateProjectType("/data/repos/a", "research", projectsPath);

			expect(result.updated).toBe(true);
			expect(result.entry?.path).toBe(resolve("/data/repos/a"));
			expect(result.entry?.type).toBe("research");
			// name is preserved
			expect(result.entry?.name).toBe("a");

			const projects = listProjects(projectsPath);
			expect(projects.find((p) => p.name === "a")?.type).toBe("research");
			expect(projects.find((p) => p.name === "b")?.type).toBe("code");
			// File on disk matches and no tmp leftovers
			const onDisk = JSON.parse(readFileSync(projectsPath, "utf-8"));
			expect(onDisk.find((e: { name: string }) => e.name === "a").type).toBe("research");
			expect(readdirSync(tempDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		});

		test("returns updated:false for an unregistered path without touching the file", () => {
			addToProjects("/data/repos/a", "a", undefined, projectsPath);
			const before = readFileSync(projectsPath, "utf-8");

			const result = updateProjectType("/data/repos/never-added", "code", projectsPath);

			expect(result.updated).toBe(false);
			expect(result.entry).toBeUndefined();
			expect(readFileSync(projectsPath, "utf-8")).toBe(before);
		});

		test("matches by resolved absolute path (relative equivalent)", () => {
			addToProjects("sub/project", "rel", undefined, projectsPath);

			const result = updateProjectType(resolve("sub/project"), "automation", projectsPath);

			expect(result.updated).toBe(true);
			expect(listProjects(projectsPath)[0].type).toBe("automation");
		});

		test("no-op on a missing registry file", () => {
			const result = updateProjectType("/data/repos/a", "code", projectsPath);

			expect(result.updated).toBe(false);
			expect(existsSync(projectsPath)).toBe(false);
		});
	});

	describe("removeFromProjects (F-2.13)", () => {
		test("removes a registered entry and persists atomically", () => {
			addToProjects("/data/repos/a", "a", "code", projectsPath);
			addToProjects("/data/repos/b", "b", "research", projectsPath);

			const result = removeFromProjects("/data/repos/a", projectsPath);

			expect(result.removed).toBe(true);
			expect(result.entry?.path).toBe(resolve("/data/repos/a"));
			expect(result.entry?.name).toBe("a");

			const remaining = listProjects(projectsPath);
			expect(remaining).toHaveLength(1);
			expect(remaining[0].name).toBe("b");
			// File on disk matches and no tmp leftovers
			expect(JSON.parse(readFileSync(projectsPath, "utf-8"))).toHaveLength(1);
			expect(readdirSync(tempDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		});

		test("returns removed:false for an unregistered path without touching the file", () => {
			addToProjects("/data/repos/a", "a", undefined, projectsPath);
			const before = readFileSync(projectsPath, "utf-8");

			const result = removeFromProjects("/data/repos/never-added", projectsPath);

			expect(result.removed).toBe(false);
			expect(result.entry).toBeUndefined();
			expect(readFileSync(projectsPath, "utf-8")).toBe(before);
		});

		test("matches by resolved absolute path (relative equivalent)", () => {
			addToProjects("sub/project", "rel", undefined, projectsPath);

			const result = removeFromProjects(resolve("sub/project"), projectsPath);

			expect(result.removed).toBe(true);
			expect(listProjects(projectsPath)).toHaveLength(0);
		});

		test("no-op on a missing registry file", () => {
			const result = removeFromProjects("/data/repos/a", projectsPath);

			expect(result.removed).toBe(false);
			expect(existsSync(projectsPath)).toBe(false);
		});
	});
});
