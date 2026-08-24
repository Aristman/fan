import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveInstaller } from "./installer.js";
import type { RepoClient } from "./repo-client.js";
import type { StoreDatabase } from "./storage.js";

/**
 * Tests for bundle component sync (install + update paths).
 *
 * We test syncBundleComponents indirectly via installBundle (replace=false)
 * and a direct cast call (replace=true) to verify update semantics.
 */

function noopRepoClient(): RepoClient {
	return {
		downloadPackage: async () => {},
		checkUpdates: async () => new Map(),
		fetchIndex: async () => ({ repository: { name: "", url: "", updatedAt: "" }, packages: [] }),
		resolveDownloadUrl: (pkg: { downloadUrl: string }) => pkg.downloadUrl,
	} as unknown as RepoClient;
}

function noopDb(): StoreDatabase {
	const store = new Map<string, any>();
	return {
		savePackage: (pkg: any) => {
			store.set(pkg.name, pkg);
		},
		getPackage: (name: string) => store.get(name),
		updatePackage: (name: string, data: any) => {
			const existing = store.get(name);
			if (existing) store.set(name, { ...existing, ...data });
		},
		removePackage: (name: string) => {
			store.delete(name);
		},
		getPackages: () => [...store.values()],
	} as unknown as StoreDatabase;
}

describe("ArchiveInstaller — bundle sync", () => {
	let tempRoot: string;
	let fakeHome: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "fan-store-test-"));
		fakeHome = join(tempRoot, "home");
		await mkdir(join(fakeHome, ".fan", "agent", "extensions"), { recursive: true });
		await mkdir(join(fakeHome, ".fan", "agent", "skills"), { recursive: true });
		await mkdir(join(fakeHome, ".fan", "agent", "themes"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
	});

	/**
	 * Helper: create a bundle source directory with given extensions/skills.
	 */
	async function createBundleSource(structure: {
		extensions?: Record<string, Record<string, string>>;
		skills?: Record<string, Record<string, string>>;
	}): Promise<string> {
		const bundleDir = join(tempRoot, "bundle-source");
		await mkdir(bundleDir, { recursive: true });

		if (structure.extensions) {
			for (const [name, files] of Object.entries(structure.extensions)) {
				const extDir = join(bundleDir, "extensions", name);
				await mkdir(extDir, { recursive: true });
				for (const [fileName, content] of Object.entries(files)) {
					await writeFile(join(extDir, fileName), content);
				}
			}
		}

		if (structure.skills) {
			for (const [name, files] of Object.entries(structure.skills)) {
				const skillDir = join(bundleDir, "skills", name);
				await mkdir(skillDir, { recursive: true });
				for (const [fileName, content] of Object.entries(files)) {
					await writeFile(join(skillDir, fileName), content);
				}
			}
		}

		return bundleDir;
	}

	/**
	 * Create an installer that targets our fake home directory.
	 */
	function createInstaller(): ArchiveInstaller {
		const db = noopDb();
		const rc = noopRepoClient();
		const installer = new ArchiveInstaller(db, rc, tempRoot);

		// Override getTargetDirectory to use fakeHome instead of real homedir
		const origGetTarget = installer.getTargetDirectory.bind(installer);
		installer.getTargetDirectory = (type, scope, name) => {
			switch (type) {
				case "extension":
					return join(fakeHome, ".fan", "agent", "extensions", name);
				case "skill":
					return join(fakeHome, ".fan", "agent", "skills", name);
				case "theme":
					return join(fakeHome, ".fan", "agent", "themes", `${name}.json`);
				default:
					return origGetTarget(type, scope, name);
			}
		};

		return installer;
	}

	it("installBundle copies extensions and skills to target directories", async () => {
		const installer = createInstaller();
		const sourceDir = await createBundleSource({
			extensions: {
				"ext-alpha": { "index.js": "console.log('alpha v1')" },
				"ext-beta": { "index.js": "console.log('beta v1')" },
			},
			skills: {
				"skill-gamma": { "SKILL.md": "# Gamma v1" },
			},
		});

		// Call installBundle via cast (private method)
		const result = await (installer as any).installBundle(sourceDir, "user", "repo", {
			name: "test-bundle",
			version: "1.0.0",
			type: "bundle",
		});

		expect(result.type).toBe("bundle");
		expect(result.version).toBe("1.0.0");

		// Verify extensions were copied
		expect(existsSync(join(fakeHome, ".fan", "agent", "extensions", "ext-alpha", "index.js"))).toBe(true);
		expect(existsSync(join(fakeHome, ".fan", "agent", "extensions", "ext-beta", "index.js"))).toBe(true);
		expect(readFileSync(join(fakeHome, ".fan", "agent", "extensions", "ext-alpha", "index.js"), "utf-8")).toBe(
			"console.log('alpha v1')",
		);

		// Verify skill was copied
		expect(existsSync(join(fakeHome, ".fan", "agent", "skills", "skill-gamma", "SKILL.md"))).toBe(true);
	});

	it("syncBundleComponents with replace=true removes stale files from old version", async () => {
		const installer = createInstaller();

		// Simulate v1 installed: ext-alpha has index.js + old-file.js
		const extTarget = join(fakeHome, ".fan", "agent", "extensions", "ext-alpha");
		await mkdir(extTarget, { recursive: true });
		await writeFile(join(extTarget, "index.js"), "console.log('v1')");
		await writeFile(join(extTarget, "old-file.js"), "should be removed in v2");

		// v2 bundle: ext-alpha only has index.js (old-file.js removed from bundle)
		const sourceDir = await createBundleSource({
			extensions: {
				"ext-alpha": { "index.js": "console.log('v2')" },
			},
		});

		// Call syncBundleComponents with replace=true (update path)
		const resources = await (installer as any).syncBundleComponents(sourceDir, "user", undefined, {
			replace: true,
		});

		expect(resources).toHaveLength(1);
		expect(resources[0].name).toBe("ext-alpha");

		// index.js should be updated
		expect(readFileSync(join(extTarget, "index.js"), "utf-8")).toBe("console.log('v2')");

		// old-file.js should be REMOVED (replace semantics)
		expect(existsSync(join(extTarget, "old-file.js"))).toBe(false);
	});

	it("syncBundleComponents with replace=false preserves extra files (install semantics)", async () => {
		const installer = createInstaller();

		// Pre-existing extension dir with an extra user file
		const extTarget = join(fakeHome, ".fan", "agent", "extensions", "ext-alpha");
		await mkdir(extTarget, { recursive: true });
		await writeFile(join(extTarget, "user-config.json"), "{}");

		const sourceDir = await createBundleSource({
			extensions: {
				"ext-alpha": { "index.js": "console.log('v1')" },
			},
		});

		// replace=false (install path) — overlays, doesn't remove
		await (installer as any).syncBundleComponents(sourceDir, "user", undefined, {
			replace: false,
		});

		// New file copied
		expect(existsSync(join(extTarget, "index.js"))).toBe(true);
		// Pre-existing file preserved
		expect(existsSync(join(extTarget, "user-config.json"))).toBe(true);
	});

	it("update path: bundle with 2 extensions updates both component versions", async () => {
		const installer = createInstaller();

		// Install v1 first
		const v1Source = await createBundleSource({
			extensions: {
				"ext-a": { "package.json": '{"name":"ext-a","version":"1.0.0"}' },
				"ext-b": { "package.json": '{"name":"ext-b","version":"1.0.0"}' },
			},
		});
		await (installer as any).installBundle(v1Source, "user", "repo", {
			name: "my-bundle",
			version: "1.0.0",
			type: "bundle",
		});

		// Verify v1 installed
		const extA = join(fakeHome, ".fan", "agent", "extensions", "ext-a");
		const extB = join(fakeHome, ".fan", "agent", "extensions", "ext-b");
		expect(JSON.parse(readFileSync(join(extA, "package.json"), "utf-8")).version).toBe("1.0.0");
		expect(JSON.parse(readFileSync(join(extB, "package.json"), "utf-8")).version).toBe("1.0.0");

		// Now simulate update to v2: new bundle source with updated versions
		// Clean up old source dir to create fresh v2
		await rm(v1Source, { recursive: true, force: true });
		const v2Source = await createBundleSource({
			extensions: {
				"ext-a": { "package.json": '{"name":"ext-a","version":"2.0.0"}' },
				"ext-b": { "package.json": '{"name":"ext-b","version":"2.0.0"}' },
			},
		});

		// Update: syncBundleComponents with replace=true
		await (installer as any).syncBundleComponents(v2Source, "user", undefined, {
			replace: true,
		});

		// Both extensions should now have v2
		expect(JSON.parse(readFileSync(join(extA, "package.json"), "utf-8")).version).toBe("2.0.0");
		expect(JSON.parse(readFileSync(join(extB, "package.json"), "utf-8")).version).toBe("2.0.0");
	});

	it("updateFromRepo throws on empty bundle and does not update DB version", async () => {
		const db = noopDb();
		const rc = noopRepoClient();
		const installer = new ArchiveInstaller(db, rc, tempRoot);

		// Override getTargetDirectory to use fakeHome
		installer.getTargetDirectory = (type, _scope, name) => {
			switch (type) {
				case "extension":
					return join(fakeHome, ".fan", "agent", "extensions", name);
				case "skill":
					return join(fakeHome, ".fan", "agent", "skills", name);
				case "theme":
					return join(fakeHome, ".fan", "agent", "themes", `${name}.json`);
				default:
					return "";
			}
		};

		// Pre-populate DB with v1.0.0
		db.savePackage({
			name: "test-bundle",
			version: "1.0.0",
			type: "bundle",
			source: "repo",
			installedAt: Date.now(),
			installedPath: join(fakeHome, ".fan", "agent", "bundles", "test-bundle"),
		});

		// Create a bundle source with empty resource dirs (detected as bundle, but no installable components)
		const emptyBundleDir = join(tempRoot, "empty-bundle");
		await mkdir(join(emptyBundleDir, "extensions"), { recursive: true });
		await mkdir(join(emptyBundleDir, "skills"), { recursive: true });
		await writeFile(join(emptyBundleDir, "package.json"), '{"name":"test-bundle","version":"2.0.0"}');

		// Override extractTarGz to place our empty bundle into the extract dir
		(installer as any).extractTarGz = async (_archivePath: string, extractDir: string) => {
			const wrapperDir = join(extractDir, "test-bundle");
			await mkdir(wrapperDir, { recursive: true });
			await cp(emptyBundleDir, wrapperDir, { recursive: true });
		};

		const installedPkg = db.getPackage("test-bundle");
		const repoPkg = {
			name: "test-bundle",
			version: "2.0.0",
			description: "",
			type: "bundle" as const,
			source: "repo" as const,
			repoName: "test",
			repoUrl: "",
			downloadUrl: "",
			hash: "",
		};

		await expect((installer as any).updateFromRepo(installedPkg, repoPkg, [], undefined, undefined)).rejects.toThrow(
			"Bundle contains no installable resources",
		);

		// DB version should NOT have been updated
		expect(db.getPackage("test-bundle")!.version).toBe("1.0.0");
	});

	it("syncBundleComponents rolls back all components when component N fails", async () => {
		const installer = createInstaller();

		// Pre-install v1 of 3 extensions (so backups will have v1 content)
		const extA = join(fakeHome, ".fan", "agent", "extensions", "ext-1");
		const extB = join(fakeHome, ".fan", "agent", "extensions", "ext-2");
		const extC = join(fakeHome, ".fan", "agent", "extensions", "ext-3");
		await mkdir(extA, { recursive: true });
		await mkdir(extB, { recursive: true });
		await mkdir(extC, { recursive: true });
		await writeFile(join(extA, "index.js"), "console.log('v1-ext-1')");
		await writeFile(join(extB, "index.js"), "console.log('v1-ext-2')");
		await writeFile(join(extC, "index.js"), "console.log('v1-ext-3')");

		// Create v2 bundle source with 3 extensions
		const sourceDir = await createBundleSource({
			extensions: {
				"ext-1": { "index.js": "console.log('v2-ext-1')" },
				"ext-2": { "index.js": "console.log('v2-ext-2')" },
				"ext-3": { "index.js": "console.log('v2-ext-3')" },
			},
		});

		// Override installDeps to throw on the 2nd call (ext-2)
		let installDepsCallCount = 0;
		const origInstallDeps = (installer as any).installDeps.bind(installer);
		(installer as any).installDeps = async (dir: string, onProgress?: any) => {
			installDepsCallCount++;
			if (installDepsCallCount === 2) {
				throw new Error("simulated installDeps failure on ext-2");
			}
			return origInstallDeps(dir, onProgress);
		};

		// syncBundleComponents should throw
		await expect(
			(installer as any).syncBundleComponents(sourceDir, "user", undefined, { replace: true }),
		).rejects.toThrow("simulated installDeps failure on ext-2");

		// ext-1 should be rolled back to v1 content (it was already replaced, then restored)
		expect(readFileSync(join(extA, "index.js"), "utf-8")).toBe("console.log('v1-ext-1')");

		// ext-2 should also be rolled back to v1 (the one that failed)
		expect(readFileSync(join(extB, "index.js"), "utf-8")).toBe("console.log('v1-ext-2')");

		// ext-3 should be untouched (never processed)
		expect(readFileSync(join(extC, "index.js"), "utf-8")).toBe("console.log('v1-ext-3')");
	});
});
