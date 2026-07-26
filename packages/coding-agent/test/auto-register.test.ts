import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { autoRegisterProject, detectProjectType, isSystemPath } from "../src/core/project-auto-register.js";
import { listProjects } from "../src/core/project-registry.js";

// Workspace fixtures must live OUTSIDE os.tmpdir() — the temp dir itself is a
// system path excluded from auto-registration. Use a scratch dir next to the
// test file (inside the repo, cleaned up after each test).
const testDir = dirname(fileURLToPath(import.meta.url));

describe("project-auto-register (F-1.7)", () => {
	let workDir: string;
	let projectsPath: string;

	beforeEach(() => {
		workDir = mkdtempSync(join(testDir, ".tmp-auto-register-"));
		projectsPath = join(workDir, "registry", "projects.json");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (workDir && existsSync(workDir)) {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	function makeProject(name: string): string {
		const dir = join(workDir, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	describe("TC-F-1.7-1: git repo is registered as 'code'", () => {
		test("cwd with .git directory → registry entry type='code'", () => {
			const projectDir = makeProject("repo-with-git");
			mkdirSync(join(projectDir, ".git"));

			const result = autoRegisterProject(projectDir, { projectsPath });

			expect(result).not.toBeNull();
			expect(result?.added).toBe(true);
			expect(result?.entry.type).toBe("code");
			expect(result?.entry.path).toBe(resolve(projectDir));
			expect(result?.entry.name).toBe("repo-with-git");

			const projects = listProjects(projectsPath);
			expect(projects).toHaveLength(1);
			expect(projects[0].type).toBe("code");
		});

		test(".git file (worktree gitfile) also counts as 'code'", () => {
			const projectDir = makeProject("worktree");
			writeFileSync(join(projectDir, ".git"), "gitdir: /elsewhere\n", "utf-8");

			const result = autoRegisterProject(projectDir, { projectsPath });

			expect(result?.entry.type).toBe("code");
		});

		test("second registration of same path is a no-op (dedup)", () => {
			const projectDir = makeProject("dup");
			mkdirSync(join(projectDir, ".git"));

			const first = autoRegisterProject(projectDir, { projectsPath });
			const second = autoRegisterProject(projectDir, { projectsPath });

			expect(first?.added).toBe(true);
			expect(second?.added).toBe(false);
			expect(listProjects(projectsPath)).toHaveLength(1);
		});
	});

	describe("TC-F-1.7-2: system paths are excluded", () => {
		test("os.tmpdir() is not registered", () => {
			const result = autoRegisterProject(tmpdir(), { projectsPath });

			expect(result).toBeNull();
			expect(listProjects(projectsPath)).toEqual([]);
		});

		test("subdirectory of temp dir is not registered", () => {
			const tmpSub = mkdtempSync(join(tmpdir(), "fan-auto-register-"));
			try {
				const result = autoRegisterProject(tmpSub, { projectsPath });
				expect(result).toBeNull();
				expect(listProjects(projectsPath)).toEqual([]);
			} finally {
				rmSync(tmpSub, { recursive: true, force: true });
			}
		});

		test.skipIf(process.platform === "win32")("POSIX system dirs are not registered", () => {
			for (const p of ["/tmp", "/etc", "/usr", "/var", "/"]) {
				expect(isSystemPath(p)).toBe(true);
			}
			expect(isSystemPath("/etc/nginx")).toBe(true);
			expect(isSystemPath("/usr/local/bin")).toBe(true);
		});

		test.skipIf(process.platform !== "win32")("Windows system dirs are not registered", () => {
			const systemDrive = process.env.SystemDrive ?? "C:";
			expect(isSystemPath(`${systemDrive}\\`)).toBe(true);
			expect(isSystemPath(`${systemDrive}\\Windows`)).toBe(true);
			expect(isSystemPath(`${systemDrive}\\Windows\\System32`)).toBe(true);
			expect(isSystemPath(`${systemDrive}\\Program Files`)).toBe(true);
			expect(isSystemPath(`${systemDrive}\\Program Files (x86)`)).toBe(true);
			// Case-insensitive on Windows
			expect(isSystemPath(`${systemDrive.toLowerCase()}\\windows\\system32`)).toBe(true);
		});

		test("home directory itself is excluded, subdirectories are allowed", () => {
			expect(isSystemPath(homedir())).toBe(true);
			expect(isSystemPath(join(homedir(), "projects", "my-app"))).toBe(false);
		});

		test("regular project dir is not a system path", () => {
			expect(isSystemPath(workDir)).toBe(false);
		});
	});

	describe("type detection", () => {
		test("docs/ without .git → 'research'", () => {
			const projectDir = makeProject("research-notes");
			mkdirSync(join(projectDir, "docs"));

			const result = autoRegisterProject(projectDir, { projectsPath });

			expect(result?.entry.type).toBe("research");
			expect(listProjects(projectsPath)[0].type).toBe("research");
		});

		test(".git wins over docs/ → 'code'", () => {
			const projectDir = makeProject("both");
			mkdirSync(join(projectDir, ".git"));
			mkdirSync(join(projectDir, "docs"));

			expect(detectProjectType(projectDir)).toBe("code");
		});

		test("docs as a file (not directory) does not count", () => {
			const projectDir = makeProject("docs-file");
			writeFileSync(join(projectDir, "docs"), "not a dir", "utf-8");

			expect(detectProjectType(projectDir)).toBe("unknown");
		});

		test("neither .git nor docs/ → 'unknown'", () => {
			const projectDir = makeProject("plain");

			const result = autoRegisterProject(projectDir, { projectsPath });

			expect(result?.entry.type).toBe("unknown");
			expect(listProjects(projectsPath)).toHaveLength(1);
		});
	});

	describe("edge cases", () => {
		test("non-existent directory is not registered", () => {
			const missing = join(workDir, "does-not-exist");

			const result = autoRegisterProject(missing, { projectsPath });

			expect(result).toBeNull();
			expect(listProjects(projectsPath)).toEqual([]);
		});

		test("path to a file (not a directory) is not registered", () => {
			const filePath = join(workDir, "a-file.txt");
			writeFileSync(filePath, "content", "utf-8");

			const result = autoRegisterProject(filePath, { projectsPath });

			expect(result).toBeNull();
			expect(listProjects(projectsPath)).toEqual([]);
		});

		test("empty / null / undefined cwd is not registered", () => {
			expect(autoRegisterProject("", { projectsPath })).toBeNull();
			expect(autoRegisterProject("   ", { projectsPath })).toBeNull();
			expect(autoRegisterProject(null, { projectsPath })).toBeNull();
			expect(autoRegisterProject(undefined, { projectsPath })).toBeNull();
			expect(listProjects(projectsPath)).toEqual([]);
		});

		test("registry write failure returns null and does not throw", () => {
			const projectDir = makeProject("write-fails");
			// projectsPath whose parent is a FILE → mkdir/rename must fail
			const blockerFile = join(workDir, "blocker");
			writeFileSync(blockerFile, "not a dir", "utf-8");
			const badProjectsPath = join(blockerFile, "projects.json");
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			let result: ReturnType<typeof autoRegisterProject> | undefined;
			expect(() => {
				result = autoRegisterProject(projectDir, { projectsPath: badProjectsPath });
			}).not.toThrow();

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalled();
		});

		test("registry path default is used when not provided (no crash on dedup path)", () => {
			// Smoke test: with a real project dir the default registry path (~/.fan/agent)
			// may be written — skip touching user state, just verify the guard clauses
			// run before any registry access for invalid input.
			expect(autoRegisterProject(null)).toBeNull();
			expect(autoRegisterProject(join(workDir, "missing"))).toBeNull();
		});
	});

	describe("path normalization", () => {
		test("relative cwd resolves to absolute path in registry", () => {
			const projectDir = makeProject("relative-test");
			mkdirSync(join(projectDir, ".git"));
			const relative = `.${sep}${relativePath(process.cwd(), projectDir)}`;

			const result = autoRegisterProject(relative, { projectsPath });

			expect(result?.entry.path).toBe(resolve(projectDir));
			expect(result?.entry.type).toBe("code");
		});
	});
});
