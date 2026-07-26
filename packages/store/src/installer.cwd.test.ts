import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveInstaller } from "./installer.js";
import type { RepoClient } from "./repo-client.js";
import type { StoreDatabase } from "./storage.js";

const dummyDB = {} as StoreDatabase;
const dummyRepoClient = {} as RepoClient;

describe("ArchiveInstaller project-scope cwd", () => {
	it("uses explicit cwd instead of process.cwd()", () => {
		const projectDir = mkdtempSync(join(tmpdir(), "fan-store-installer-cwd-"));
		const installer = new ArchiveInstaller(dummyDB, dummyRepoClient, undefined, projectDir);

		expect(installer.getTargetDirectory("extension", "project", "demo")).toBe(
			join(projectDir, ".fan", "extensions", "demo"),
		);
	});

	it("falls back to process.cwd() when cwd is omitted", () => {
		const installer = new ArchiveInstaller(dummyDB, dummyRepoClient);

		expect(installer.getTargetDirectory("extension", "project", "demo")).toBe(
			join(process.cwd(), ".fan", "extensions", "demo"),
		);
	});
});
