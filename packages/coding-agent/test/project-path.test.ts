import { describe, expect, it } from "vitest";
import { normalizeProjectPath, sessionBelongsToProject } from "../src/core/project-path.js";

describe("normalizeProjectPath (F-1.9)", () => {
	it("normalizes backslashes to forward slashes", () => {
		expect(normalizeProjectPath("C:\\Users\\User\\projects")).toBe("c:/users/user/projects");
	});

	it("collapses duplicate slashes and strips trailing slash", () => {
		expect(normalizeProjectPath("/data//repos/a/")).toBe("/data/repos/a");
	});

	it("resolves . and .. segments", () => {
		expect(normalizeProjectPath("/data/repos/./a/../b")).toBe("/data/repos/b");
	});

	it("lowercases Windows drive letter (and the rest of the path — case-insensitive FS)", () => {
		expect(normalizeProjectPath("D:/Repos/App")).toBe("d:/repos/app");
	});

	it("trims whitespace", () => {
		expect(normalizeProjectPath("  /data/repos/a  ")).toBe("/data/repos/a");
	});

	it("keeps POSIX paths case-sensitive beyond the drive letter", () => {
		expect(normalizeProjectPath("/Data/Repos")).toBe("/Data/Repos");
	});
});

describe("sessionBelongsToProject (F-1.9)", () => {
	it("returns true for exact match", () => {
		expect(sessionBelongsToProject("/data/repos/a", "/data/repos/a")).toBe(true);
	});

	it("returns true for equivalent paths (different separators/trailing slash)", () => {
		expect(sessionBelongsToProject("C:\\Repos\\App\\", "c:/Repos/App")).toBe(true);
	});

	it("returns false for a different project", () => {
		expect(sessionBelongsToProject("/data/repos/a", "/data/repos/b")).toBe(false);
	});

	it("returns false for a subdirectory (no prefix matching)", () => {
		expect(sessionBelongsToProject("/data/repos/a/sub", "/data/repos/a")).toBe(false);
	});

	it("returns false when the session has no cwd", () => {
		expect(sessionBelongsToProject(undefined, "/data/repos/a")).toBe(false);
	});
});
