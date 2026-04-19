/**
 * FAN Store — Archive installer for packages.
 *
 * Handles extraction of .tar.gz and .zip archives, type detection,
 * bundle installation, and uninstall with cleanup.
 *
 * All I/O is non-blocking (async). Progress callbacks report stage transitions.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { InstalledPackage, RepoEntry, RepoPackage, ResourceType } from "./types.js";
import { StoreDatabase } from "./storage.js";
import { RepoClient } from "./repo-client.js";

// ──────────────────────────────────────────────
// Progress callback
// ──────────────────────────────────────────────

/** Called at each stage of an install/remove/update operation. */
export type ProgressCallback = (stage: string, detail?: string) => void;

export class ArchiveInstaller {
	constructor(
		private db: StoreDatabase,
		private repoClient: RepoClient,
		private archiveTempDir?: string,
	) {}

	/**
	 * Get target directory for a resource type and scope.
	 */
	getTargetDirectory(type: ResourceType, scope: "user" | "project", name: string): string {
		const homeDir = homedir();
		switch (type) {
			case "extension":
				if (scope === "project") {
					return join(process.cwd(), ".fan", "extensions", name);
				}
				return join(homeDir, ".fan", "agent", "extensions", name);
			case "skill":
				return join(homeDir, ".fan", "agent", "skills", name);
			case "theme":
				return join(homeDir, ".fan", "agent", "themes", `${name}.json`);
		}
	}

	/**
	 * Validate that a path stays within a base directory (path traversal protection).
	 */
	private validatePath(baseDir: string, filePath: string): string {
		const resolved = resolve(baseDir, filePath);
		const normalizedBase = resolve(baseDir);
		if (!resolved.startsWith(normalizedBase + "/") && resolved !== normalizedBase) {
			throw new Error(`Path traversal detected: ${filePath} escapes ${baseDir}`);
		}
		return resolved;
	}

	/**
	 * Detect the resource type of an extracted directory.
	 */
	private async detectType(extractedDir: string): Promise<ResourceType | "bundle" | undefined> {
		const entries = await readdir(extractedDir);

		// Check if it's a bundle (contains subdirectories matching resource types)
		const subdirs: string[] = [];
		for (const e of entries) {
			const p = join(extractedDir, e);
			try {
				if ((await stat(p)).isDirectory()) subdirs.push(e);
			} catch {
				// ignore
			}
		}

		if (subdirs.some((d) => d === "extensions" || d === "skills" || d === "themes")) {
			return "bundle";
		}

		// Single resource detection
		if (entries.includes("SKILL.md")) return "skill";
		if (entries.includes("theme.json")) return "theme";
		if (
			entries.includes("index.ts") ||
			entries.includes("index.js") ||
			entries.includes("package.json")
		) {
			return "extension";
		}

		return undefined;
	}

	/**
	 * Find the wrapper directory inside an extracted archive.
	 * Archives should contain a single top-level directory named after the package.
	 */
	private async findWrapperDir(extractedDir: string): Promise<{ dir: string; name: string | null }> {
		const entries = await readdir(extractedDir);
		const dirs: string[] = [];
		for (const e of entries) {
			try {
				if ((await stat(join(extractedDir, e))).isDirectory()) dirs.push(e);
			} catch {
				// ignore
			}
		}
		// Ignore hidden files for wrapper detection
		const visibleFiles = entries.filter(
			(e) => !dirs.includes(e) && !e.startsWith("."),
		);

		if (dirs.length === 1 && visibleFiles.length === 0) {
			return { dir: join(extractedDir, dirs[0]!), name: dirs[0] };
		}
		return { dir: extractedDir, name: null };
	}

	/**
	 * Backup existing installation before overwrite.
	 */
	private async backupExisting(targetPath: string): Promise<string | undefined> {
		if (!existsSync(targetPath)) return undefined;
		const backupPath = `${targetPath}.bak.${Date.now()}`;
		await cp(targetPath, backupPath, { recursive: true });
		return backupPath;
	}

	/**
	 * Restore from backup on failure.
	 */
	private async restoreBackup(targetPath: string, backupPath: string | undefined): Promise<void> {
		if (backupPath === undefined) return;
		if (existsSync(targetPath)) {
			await rm(targetPath, { recursive: true, force: true });
		}
		await rename(backupPath, targetPath);
	}

	/**
	 * Extract .tar.gz archive to a directory.
	 */
	private async extractTarGz(archivePath: string, targetDir: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			execFile("tar", ["-xzf", archivePath, "-C", targetDir], { timeout: 30_000 }, (err) => {
				if (err) reject(new Error(`Failed to extract ${archivePath}: ${err.message}`));
				else resolve();
			});
		});
	}

	/**
	 * Extract .zip archive to a directory.
	 */
	private async extractZip(archivePath: string, targetDir: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			execFile(
				"powershell",
				["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${targetDir}' -Force`],
				{ timeout: 60_000 },
				(err) => {
					if (err) reject(new Error(`Failed to extract ${archivePath}: ${err.message}`));
					else resolve();
				},
			);
		});
	}

	/**
	 * Run npm install in a directory if package.json exists.
	 * Strips workspace:* dependencies before install (not resolvable by npm).
	 */
	private async npmInstall(dir: string): Promise<void> {
		const pkgJsonPath = join(dir, "package.json");
		if (!existsSync(pkgJsonPath)) return;

		try {
			const raw = await readFile(pkgJsonPath, "utf-8");
			const pkgJson = JSON.parse(raw) as Record<string, unknown>;
			let cleaned = false;

			for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
				const deps = pkgJson[field];
				if (typeof deps !== "object" || deps === null) continue;
				for (const [key, val] of Object.entries(deps as Record<string, string>)) {
					if (typeof val !== "string") continue;
					// Strip workspace:* references (can't resolve outside monorepo)
					if (val.startsWith("workspace:")) {
						delete (deps as Record<string, string>)[key];
						cleaned = true;
						continue;
					}
					// Strip bare * version on @itone/* packages (workspace deps without workspace: protocol)
					if (val === "*" && key.startsWith("@itone/")) {
						delete (deps as Record<string, string>)[key];
						cleaned = true;
					}
				}
			}

			if (cleaned) {
				await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n", "utf-8");
			}
		} catch {
			// If we can't read/parse package.json, skip cleanup and try install anyway
		}

		return new Promise<void>((resolve, reject) => {
			execFile("npm", ["install", "--omit=dev"], { cwd: dir, timeout: 120_000 }, (err) => {
				if (err) reject(new Error(`npm install failed in ${dir}: ${err.message}`));
				else resolve();
			});
		});
	}

	/**
	 * Install a package from a local archive file (.tar.gz or .zip).
	 */
	async installFromArchive(
		archivePath: string,
		scope: "user" | "project",
		type?: ResourceType,
		onProgress?: ProgressCallback,
	): Promise<InstalledPackage> {
		if (!existsSync(archivePath)) {
			throw new Error(`Archive not found: ${archivePath}`);
		}

		const tempDir = join(this.archiveTempDir ?? tmpdir(), `fan-store-install-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });

		try {
			// Extract based on extension
			if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
				onProgress?.("extracting", `Extracting ${basename(archivePath)}...`);
				await this.extractTarGz(archivePath, tempDir);
			} else if (archivePath.endsWith(".zip")) {
				onProgress?.("extracting", `Extracting ${basename(archivePath)}...`);
				await this.extractZip(archivePath, tempDir);
			} else {
				throw new Error(
					`Unsupported archive format: ${archivePath}. Use .tar.gz, .tgz, or .zip`,
				);
			}

			onProgress?.("detecting", "Detecting package type...");
			const { dir: sourceDir, name: wrapperName } = await this.findWrapperDir(tempDir);
			const detectedType = type ?? (await this.detectType(sourceDir));
			if (!detectedType) {
				throw new Error(
					`Cannot determine package type from ${archivePath}. ` +
						`Specify type explicitly (extension, skill, theme).`,
				);
			}

			if (detectedType === "bundle") {
				return await this.installBundle(sourceDir, scope, "archive", undefined, onProgress);
			}

			const pkgName = wrapperName ?? (await this.detectName(sourceDir, detectedType));

			// Check for existing installation
			const existing = this.db.getPackage(pkgName);
			if (existing) {
				throw new Error(
					`Package "${pkgName}" is already installed (version ${existing.version}, from ${existing.source}). ` +
						`Remove it first with /store remove ${pkgName}`,
				);
			}

			const targetDir = this.getTargetDirectory(detectedType, scope, pkgName);

			const backup = await this.backupExisting(targetDir);
			try {
				onProgress?.("installing", `Copying files for ${pkgName}...`);
				await mkdir(dirname(targetDir), { recursive: true });
				await cp(sourceDir, targetDir, { recursive: true });

				onProgress?.("installing", `Running npm install for ${pkgName}...`);
				await this.npmInstall(targetDir);
			} catch (err) {
				await this.restoreBackup(targetDir, backup);
				throw err;
			}

			const installedPkg: InstalledPackage = {
				name: pkgName,
				version: "unknown",
				type: detectedType,
				source: "archive",
				installedAt: Date.now(),
				installedPath: targetDir,
				scope,
			};

			// Try to read version from package.json
			try {
				const pkgJson = JSON.parse(
					await readFile(join(targetDir, "package.json"), "utf-8"),
				) as { version?: string };
				if (pkgJson.version) installedPkg.version = pkgJson.version;
			} catch {
				// No package.json or no version — keep "unknown"
			}

			onProgress?.("saving", "Saving package metadata...");
			this.db.savePackage(installedPkg);
			onProgress?.("done", `Installed ${pkgName}`);
			return installedPkg;
		} finally {
			onProgress?.("cleanup", "Cleaning up temporary files...");
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	/**
	 * Install a package from a repository.
	 */
	async installFromRepo(
		pkg: RepoPackage,
		repos: RepoEntry[],
		scope: "user" | "project",
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
	): Promise<InstalledPackage> {
		// Check for existing installation
		const existing = this.db.getPackage(pkg.name);
		if (existing) {
			throw new Error(
				`Package "${pkg.name}" is already installed (version ${existing.version}, from ${existing.source}). ` +
					`Use /store update ${pkg.name} to update or /store remove ${pkg.name} first.`,
			);
		}

		const tempDir = join(this.archiveTempDir ?? tmpdir(), `fan-store-install-${Date.now()}`);
		const archivePath = join(tempDir, `${pkg.name}-${pkg.version}.tar.gz`);
		const extractDir = join(tempDir, "extract");
		await mkdir(tempDir, { recursive: true });

		try {
			onProgress?.("downloading", `Downloading ${pkg.name} v${pkg.version}...`);
			await this.repoClient.downloadPackage(pkg, archivePath, signal);

			onProgress?.("extracting", `Extracting ${pkg.name}...`);
			await mkdir(extractDir, { recursive: true });
			await this.extractTarGz(archivePath, extractDir);

			onProgress?.("detecting", "Detecting package type...");
			const { dir: sourceDir } = await this.findWrapperDir(extractDir);
			const detectedType = (await this.detectType(sourceDir)) ?? pkg.type;

			if (detectedType === "bundle") {
				return await this.installBundle(sourceDir, scope, "repo", pkg, onProgress);
			}

			const targetDir = this.getTargetDirectory(detectedType, scope, pkg.name);

			const backup = await this.backupExisting(targetDir);
			try {
				onProgress?.("installing", `Copying files for ${pkg.name}...`);
				await mkdir(dirname(targetDir), { recursive: true });
				await cp(sourceDir, targetDir, { recursive: true });

				onProgress?.("installing", `Running npm install for ${pkg.name}...`);
				await this.npmInstall(targetDir);
			} catch (err) {
				await this.restoreBackup(targetDir, backup);
				throw err;
			}

			const installedPkg: InstalledPackage = {
				name: pkg.name,
				version: pkg.version,
				type: detectedType,
				source: "repo",
				installedAt: Date.now(),
				installedPath: targetDir,
				scope,
				repoName: pkg.repoName,
				repoUrl: pkg.repoUrl,
				downloadUrl: pkg.downloadUrl,
				hash: pkg.hash,
			};

			onProgress?.("saving", "Saving package metadata...");
			this.db.savePackage(installedPkg);
			onProgress?.("done", `Installed ${pkg.name}`);
			return installedPkg;
		} finally {
			onProgress?.("cleanup", "Cleaning up temporary files...");
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	/**
	 * Install a bundle (multi-resource package).
	 */
	private async installBundle(
		extractedDir: string,
		scope: "user" | "project",
		source: "repo" | "archive",
		pkg?: RepoPackage,
		onProgress?: ProgressCallback,
	): Promise<InstalledPackage> {
		const pkgName = pkg?.name ?? (await this.detectName(extractedDir, "extension"));
		const bundleVersion = pkg?.version ?? "unknown";

		const installedResources: Array<{ type: ResourceType; path: string; name: string }> = [];

		for (const type of ["extension", "skill", "theme"] as const) {
			const subDir = join(extractedDir, `${type}s`);
			if (!existsSync(subDir)) continue;

			const entries = await readdir(subDir);
			for (const entry of entries) {
				const entryPath = join(subDir, entry);
				let isDir = false;
				try {
					isDir = (await stat(entryPath)).isDirectory();
				} catch {
					// ignore
				}
				if (!isDir) continue;

				onProgress?.("installing", `Installing ${entry} (${type})...`);
				const targetDir = this.getTargetDirectory(type, scope, entry);
				const backup = await this.backupExisting(targetDir);
				try {
					await mkdir(dirname(targetDir), { recursive: true });
					await cp(entryPath, targetDir, { recursive: true });
					if (type === "extension") {
						onProgress?.("installing", `Running npm install for ${entry}...`);
						await this.npmInstall(targetDir);
					}
				} catch (err) {
					await this.restoreBackup(targetDir, backup);
					throw err;
				}
				installedResources.push({ type, path: targetDir, name: entry });
			}
		}

		if (installedResources.length === 0) {
			throw new Error(
				"Bundle contains no installable resources (extensions/, skills/, themes/ directories empty or missing)",
			);
		}

		const installedPkg: InstalledPackage = {
			name: pkgName,
			version: bundleVersion,
			type: "bundle",
			source,
			installedAt: Date.now(),
			installedPath: extractedDir,
			scope,
			...(pkg?.repoName != null ? { repoName: pkg.repoName } : {}),
			...(pkg?.repoUrl != null ? { repoUrl: pkg.repoUrl } : {}),
			...(pkg?.downloadUrl != null ? { downloadUrl: pkg.downloadUrl } : {}),
			...(pkg?.hash != null ? { hash: pkg.hash } : {}),
		};

		onProgress?.("saving", "Saving package metadata...");
		this.db.savePackage(installedPkg);
		onProgress?.("done", `Installed bundle ${pkgName}`);
		return installedPkg;
	}

	/**
	 * Detect package name from extracted directory contents.
	 */
	private async detectName(dir: string, type: ResourceType): Promise<string> {
		const pkgJsonPath = join(dir, "package.json");
		if (existsSync(pkgJsonPath)) {
			try {
				const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8")) as { name?: string };
				if (pkgJson.name) return pkgJson.name;
			} catch {
				// ignore
			}
		}
		return basename(dir);
	}

	/**
	 * Uninstall a package.
	 */
	async uninstall(pkg: InstalledPackage, onProgress?: ProgressCallback): Promise<void> {
		const targetPath = pkg.installedPath;

		onProgress?.("removing", `Removing ${pkg.name}...`);
		if (existsSync(targetPath)) {
			await rm(targetPath, { recursive: true, force: true });
		}

		// Clean up .bak files too
		onProgress?.("removing", "Cleaning up backups...");
		const parentDir = dirname(targetPath);
		if (existsSync(parentDir)) {
			const siblings = await readdir(parentDir);
			const targetBase = basename(targetPath);
			for (const sibling of siblings) {
				if (sibling.startsWith(targetBase + ".bak.")) {
					await rm(join(parentDir, sibling), { recursive: true, force: true });
				}
			}
		}

		onProgress?.("saving", "Updating package database...");
		this.db.removePackage(pkg.name);
		onProgress?.("done", `Removed ${pkg.name}`);
	}
}
