/**
 * FAN Store — Archive installer for packages.
 *
 * Handles extraction of .tar.gz and .zip archives, type detection,
 * bundle installation, and uninstall with cleanup.
 *
 * All I/O is non-blocking (async). Progress callbacks report stage transitions.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RepoClient } from "./repo-client.js";
import type { StoreDatabase } from "./storage.js";
import type { InstalledPackage, RepoEntry, RepoPackage, ResourceType } from "./types.js";

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
		if (!resolved.startsWith(`${normalizedBase}/`) && resolved !== normalizedBase) {
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
		if (entries.includes("index.ts") || entries.includes("index.js") || entries.includes("package.json")) {
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
		const visibleFiles = entries.filter((e) => !dirs.includes(e) && !e.startsWith("."));

		if (dirs.length === 1 && visibleFiles.length === 0) {
			return { dir: join(extractedDir, dirs[0]!), name: dirs[0] };
		}
		return { dir: extractedDir, name: null };
	}

	// ──────────────────────────────────────────────
	// Staging (all temp files outside extensions dir)
	// ──────────────────────────────────────────────

	/** Staging root for backups — never inside extensions directory. */
	private get stagingDir(): string {
		return join(this.archiveTempDir ?? tmpdir(), "fan-store-staging");
	}

	private async ensureStagingDir(): Promise<string> {
		const dir = this.stagingDir;
		await mkdir(dir, { recursive: true });
		return dir;
	}

	/** Move existing installation to staging backup. */
	private async backupExisting(targetPath: string): Promise<string | undefined> {
		if (!existsSync(targetPath)) return undefined;
		const staging = await this.ensureStagingDir();
		const backupName = `${basename(targetPath)}.bak.${Date.now()}`;
		const backupPath = join(staging, backupName);
		await cp(targetPath, backupPath, { recursive: true });
		return backupPath;
	}

	/** Remove backup from staging after successful install. */
	private async cleanupBackup(backupPath: string | undefined): Promise<void> {
		if (backupPath === undefined) return;
		try {
			await rm(backupPath, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	/** Restore backup to target location on failure. */
	private async restoreBackup(targetPath: string, backupPath: string | undefined): Promise<void> {
		if (backupPath === undefined) return;
		if (existsSync(targetPath)) {
			await rm(targetPath, { recursive: true, force: true });
		}
		await mkdir(dirname(targetPath), { recursive: true });
		await cp(backupPath, targetPath, { recursive: true });
	}

	/**
	 * Merge-copy files from source to target. Does NOT delete extra files in target.
	 * Used for updates — overlays new files while preserving user-created files.
	 */
	private async mergeCopy(sourceDir: string, targetDir: string): Promise<void> {
		await mkdir(targetDir, { recursive: true });
		const entries = await readdir(sourceDir);
		for (const entry of entries) {
			const src = join(sourceDir, entry);
			const dst = join(targetDir, entry);
			try {
				if ((await stat(src)).isDirectory()) {
					await cp(src, dst, { recursive: true, force: true });
				} else {
					await cp(src, dst, { force: true });
				}
			} catch {
				// skip individual file errors during merge
			}
		}
	}

	/**
	 * Apply update cleanup manifest. Reads update-cleanup.json from targetDir,
	 * deletes each listed path relative to targetDir, then removes the manifest.
	 */
	private async applyUpdateCleanup(targetDir: string): Promise<void> {
		const manifestPath = join(targetDir, "update-cleanup.json");
		if (!existsSync(manifestPath)) return;
		try {
			const raw = await readFile(manifestPath, "utf-8");
			const manifest = JSON.parse(raw) as { remove?: string[] };
			if (Array.isArray(manifest.remove)) {
				for (const relPath of manifest.remove) {
					const safePath = this.validatePath(targetDir, relPath);
					if (existsSync(safePath)) {
						await rm(safePath, { recursive: true, force: true });
					}
				}
			}
		} catch {
			// ignore corrupt manifest
		} finally {
			await rm(manifestPath, { force: true }).catch(() => {});
		}
	}

	/** Clean up entire staging directory. */
	async cleanupStaging(): Promise<void> {
		try {
			await rm(this.stagingDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	// ──────────────────────────────────────────────
	// Archive extraction
	// ──────────────────────────────────────────────

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
				{ timeout: 60_000, windowsHide: true },
				(err) => {
					if (err) reject(new Error(`Failed to extract ${archivePath}: ${err.message}`));
					else resolve();
				},
			);
		});
	}

	// ──────────────────────────────────────────────
	// Dependency installation
	// ──────────────────────────────────────────────

	/**
	 * Find or install bun CLI.
	 * Search order: PATH → ~/.bun/bin → <fan.exe dir>/.bun/bin → auto-install.
	 */
	private async ensureBun(onProgress?: ProgressCallback): Promise<string> {
		// 1. Check PATH via Bun.which
		try {
			const gBun = globalThis as Record<string, unknown>;
			const bunObj = gBun.Bun as Record<string, unknown> | undefined;
			if (bunObj?.which) {
				const found = (bunObj.which as (cmd: string) => string | null)("bun");
				if (found) return found;
			}
		} catch {
			/* ignore */
		}

		const home = homedir();
		const exe = process.platform === "win32" ? "bun.exe" : "bun";
		const candidates: string[] = [
			// 2. Standard bun install location
			join(home, ".bun", "bin", exe),
			// 3. Bundled with FAN binary (<fan.exe dir>/.bun/bin/)
			join(dirname(process.execPath), ".bun", "bin", exe),
		];

		for (const c of candidates) {
			if (existsSync(c)) return c;
		}

		// 4. Not found — install it
		onProgress?.("installing", "Bun CLI not found, installing...");
		await this.installBunCli();

		// 5. Re-check after install
		const stdPath = join(home, ".bun", "bin", exe);
		if (existsSync(stdPath)) return stdPath;

		try {
			const gBun = globalThis as Record<string, unknown>;
			const bunObj = gBun.Bun as Record<string, unknown> | undefined;
			if (bunObj?.which) {
				const found = (bunObj.which as (cmd: string) => string | null)("bun");
				if (found) return found;
			}
		} catch {
			/* ignore */
		}

		throw new Error("Failed to install bun CLI automatically. Install it manually: https://bun.sh");
	}

	/**
	 * Download and install bun CLI to ~/.bun/bin/.
	 */
	private async installBunCli(): Promise<void> {
		if (process.platform === "win32") {
			await new Promise<void>((resolve, reject) => {
				execFile(
					"powershell",
					["-NoProfile", "-Command", "irm bun.sh/install.ps1 | iex"],
					{ timeout: 120_000, windowsHide: true },
					(err) => {
						if (err) reject(new Error(`Failed to install bun: ${err.message}`));
						else resolve();
					},
				);
			});
		} else {
			await new Promise<void>((resolve, reject) => {
				execFile(
					"/bin/sh",
					["-c", "curl -fsSL https://bun.sh/install | bash"],
					{ timeout: 120_000, windowsHide: true },
					(err) => {
						if (err) reject(new Error(`Failed to install bun: ${err.message}`));
						else resolve();
					},
				);
			});
		}
	}

	/**
	 * Install dependencies in a directory using bun.
	 * Strips workspace:* and @seaagents/* bare * dependencies from package.json
	 * before install (not resolvable outside monorepo).
	 */
	private async installDeps(dir: string, onProgress?: ProgressCallback): Promise<void> {
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
					// Strip bare * version on @seaagents/* packages (workspace deps without workspace: protocol)
					if (val === "*" && key.startsWith("@seaagents/")) {
						delete (deps as Record<string, string>)[key];
						cleaned = true;
					}
				}
			}

			if (cleaned) {
				await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`, "utf-8");
			}
		} catch {
			// If we can't read/parse package.json, skip cleanup and try install anyway
		}

		const bunPath = await this.ensureBun(onProgress);
		await this.exec(bunPath, ["install", "--omit=dev", "--no-save", "--ignore-scripts"], dir, 120_000);
	}

	/**
	 * Helper to exec a command with a promise.
	 */
	private exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			execFile(cmd, args, { cwd, timeout }, (err) => {
				if (err) reject(new Error(`${cmd} failed in ${cwd}: ${err.message}`));
				else resolve();
			});
		});
	}

	// ──────────────────────────────────────────────
	// Public install methods
	// ──────────────────────────────────────────────

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
				throw new Error(`Unsupported archive format: ${archivePath}. Use .tar.gz, .tgz, or .zip`);
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

				onProgress?.("installing", `Installing dependencies for ${pkgName}...`);
				await this.installDeps(targetDir, onProgress);
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
				const pkgJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf-8")) as {
					version?: string;
				};
				if (pkgJson.version) installedPkg.version = pkgJson.version;
			} catch {
				// No package.json or no version — keep "unknown"
			}

			onProgress?.("saving", "Saving package metadata...");
			this.db.savePackage(installedPkg);

			// Success — clean up backup
			await this.cleanupBackup(backup);

			onProgress?.("done", `Installed ${pkgName}`);
			return installedPkg;
		} finally {
			onProgress?.("cleanup", "Cleaning up temporary files...");
			await rm(tempDir, { recursive: true, force: true });
			await this.cleanupStaging();
		}
	}

	/**
	 * Install a package from a repository.
	 */
	async installFromRepo(
		pkg: RepoPackage,
		_repos: RepoEntry[],
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

				onProgress?.("installing", `Installing dependencies for ${pkg.name}...`);
				await this.installDeps(targetDir, onProgress);
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

			// Success — clean up backup
			await this.cleanupBackup(backup);

			onProgress?.("done", `Installed ${pkg.name}`);
			return installedPkg;
		} finally {
			onProgress?.("cleanup", "Cleaning up temporary files...");
			await rm(tempDir, { recursive: true, force: true });
			await this.cleanupStaging();
		}
	}

	/**
	 * Update an installed package from a repository.
	 * Does NOT uninstall — uses merge-copy + cleanup manifest.
	 * This preserves user-created files in the extension directory.
	 */
	async updateFromRepo(
		pkg: InstalledPackage,
		repoPkg: RepoPackage,
		_repos: RepoEntry[],
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
	): Promise<InstalledPackage> {
		const targetDir = pkg.installedPath;
		const tempDir = join(this.archiveTempDir ?? tmpdir(), `fan-store-update-${Date.now()}`);
		const archivePath = join(tempDir, `${pkg.name}-${repoPkg.version}.tar.gz`);
		const extractDir = join(tempDir, "extract");
		await mkdir(tempDir, { recursive: true });

		try {
			onProgress?.("downloading", `Downloading ${pkg.name} v${repoPkg.version}...`);
			await this.repoClient.downloadPackage(repoPkg, archivePath, signal);

			onProgress?.("extracting", `Extracting ${pkg.name}...`);
			await mkdir(extractDir, { recursive: true });
			await this.extractTarGz(archivePath, extractDir);

			onProgress?.("detecting", "Detecting package structure...");
			const { dir: sourceDir } = await this.findWrapperDir(extractDir);
			const detectedType = (await this.detectType(sourceDir)) ?? pkg.type;

			if (detectedType === "bundle") {
				// Bundles contain multiple resources (extensions/skills/themes) spread
				// across real target directories. Re-sync each component with replace
				// semantics so removed files don't linger.
				//
				// NOTE: update of a bundle is DESTRUCTIVE for each component's target
				// directory — the bundle is the source of truth, managed by the store.
				// User files inside component directories are not expected.
				// On failure, a best-effort rollback from backups is attempted.
				const installedResources = await this.syncBundleComponents(sourceDir, pkg.scope ?? "user", onProgress, {
					replace: true,
				});
				if (installedResources.length === 0) {
					throw new Error(
						"Bundle contains no installable resources (extensions/, skills/, themes/ directories empty or missing)",
					);
				}
			} else {
				const backup = await this.backupExisting(targetDir);

				try {
					onProgress?.("installing", `Updating files for ${pkg.name}...`);
					await this.mergeCopy(sourceDir, targetDir);
					await this.applyUpdateCleanup(targetDir);

					onProgress?.("installing", `Installing dependencies for ${pkg.name}...`);
					await this.installDeps(targetDir, onProgress);
				} catch (err) {
					await this.restoreBackup(targetDir, backup);
					throw err;
				}

				// Success — clean up backup
				await this.cleanupBackup(backup);
			}

			onProgress?.("saving", "Updating package metadata...");
			this.db.updatePackage(pkg.name, {
				version: repoPkg.version,
				updateAvailable: false,
				updateVersion: undefined,
				downloadUrl: repoPkg.downloadUrl,
				hash: repoPkg.hash,
			});

			const updated = this.db.getPackage(pkg.name);
			onProgress?.("done", `Updated ${pkg.name} to v${repoPkg.version}`);
			return updated!;
		} finally {
			onProgress?.("cleanup", "Cleaning up temporary files...");
			await rm(tempDir, { recursive: true, force: true });
			await this.cleanupStaging();
		}
	}

	// ──────────────────────────────────────────────
	// Self-update (staged two-phase)
	// ──────────────────────────────────────────────

	/**
	 * Stage a self-update: download archive to data/ without applying.
	 * The update is applied on the next session_start via applyStagedUpdate().
	 */
	async stageUpdate(
		pkg: RepoPackage,
		extensionDir: string,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
	): Promise<{ version: string; stagedPath: string }> {
		const dataDir = join(extensionDir, "data");
		await mkdir(dataDir, { recursive: true });

		onProgress?.("downloading", `Downloading fan-store v${pkg.version}...`);
		const stagedPath = join(dataDir, `staged-update-${pkg.version}.tgz`);
		await this.repoClient.downloadPackage(pkg, stagedPath, signal);

		const markerPath = join(dataDir, "pending-update.json");
		await writeFile(
			markerPath,
			JSON.stringify(
				{
					version: pkg.version,
					stagedArchive: stagedPath,
					downloadedAt: Date.now(),
				},
				null,
				2,
			),
			"utf-8",
		);

		onProgress?.("done", `Staged fan-store update to v${pkg.version}`);
		return { version: pkg.version, stagedPath };
	}

	/**
	 * Check if a staged self-update is pending.
	 */
	getStagedUpdate(extensionDir: string): { version: string; stagedArchive: string } | null {
		const markerPath = join(extensionDir, "data", "pending-update.json");
		if (!existsSync(markerPath)) return null;
		try {
			return JSON.parse(readFileSync(markerPath, "utf-8")) as { version: string; stagedArchive: string };
		} catch {
			return null;
		}
	}

	/**
	 * Apply a staged self-update. Must be called BEFORE ctx.reload().
	 * Extracts staged archive, merge-copies over extension dir, applies cleanup.
	 */
	async applyStagedUpdate(extensionDir: string, onProgress?: ProgressCallback): Promise<string> {
		const marker = this.getStagedUpdate(extensionDir);
		if (!marker) throw new Error("No pending update found");

		onProgress?.("extracting", "Extracting staged update...");
		const tempDir = await this.extractArchiveOnly(marker.stagedArchive);
		const { dir: sourceDir } = await this.findWrapperDir(tempDir);

		try {
			const backup = await this.backupExisting(extensionDir);

			try {
				onProgress?.("installing", "Applying update...");
				await this.mergeCopy(sourceDir, extensionDir);
				await this.applyUpdateCleanup(extensionDir);
				onProgress?.("installing", "Installing dependencies...");
				await this.installDeps(extensionDir, onProgress);
			} catch (err) {
				await this.restoreBackup(extensionDir, backup);
				throw err;
			}

			// Clean up marker and staged archive
			await rm(join(extensionDir, "data", "pending-update.json"), { force: true });
			await rm(marker.stagedArchive, { force: true });

			// Update DB
			this.db.updatePackage("fan-store", {
				version: marker.version,
				updateAvailable: false,
				updateVersion: undefined,
			});

			onProgress?.("done", `Self-updated fan-store to v${marker.version}`);
			return marker.version;
		} finally {
			// Clean up temp extraction dir
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * Extract an archive to a temp directory (helper for self-update).
	 * Returns the temp directory path.
	 */
	private async extractArchiveOnly(archivePath: string): Promise<string> {
		const tempDir = join(this.archiveTempDir ?? tmpdir(), `fan-store-selfupdate-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });
		if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
			await this.extractTarGz(archivePath, tempDir);
		} else if (archivePath.endsWith(".zip")) {
			await this.extractZip(archivePath, tempDir);
		} else {
			await rm(tempDir, { recursive: true, force: true });
			throw new Error(`Unsupported archive format for self-update: ${archivePath}`);
		}
		return tempDir;
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

		const installedResources = await this.syncBundleComponents(extractedDir, scope, onProgress, {
			replace: false,
		});

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
	 * Sync bundle components (extensions/skills/themes) from an extracted source
	 * directory to their real target directories.
	 *
	 * @param replace When true, removes the existing target before copying so that
	 *   files deleted in the new bundle version don't linger (used by update).
	 *   When false, overlays on top (used by initial install).
	 */
	private async syncBundleComponents(
		extractedDir: string,
		scope: "user" | "project",
		onProgress: ProgressCallback | undefined,
		opts: { replace: boolean },
	): Promise<Array<{ type: ResourceType; path: string; name: string }>> {
		const installedResources: Array<{ type: ResourceType; path: string; name: string }> = [];
		// Track backups for all components so we can do all-or-nothing rollback.
		// Backups are only cleaned after ALL components succeed.
		const backups: Array<{ targetDir: string; backupPath: string | undefined }> = [];

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

				const action = opts.replace ? "Updating" : "Installing";
				onProgress?.("installing", `${action} ${entry} (${type})...`);
				const targetDir = this.getTargetDirectory(type, scope, entry);
				const backup = await this.backupExisting(targetDir);
				backups.push({ targetDir, backupPath: backup });
				try {
					if (opts.replace && existsSync(targetDir)) {
						await rm(targetDir, { recursive: true, force: true });
					}
					await mkdir(dirname(targetDir), { recursive: true });
					await cp(entryPath, targetDir, { recursive: true });
					if (type === "extension") {
						onProgress?.("installing", `Installing dependencies for ${entry}...`);
						await this.installDeps(targetDir, onProgress);
					}
				} catch (err) {
					// Best-effort rollback of ALL previously processed components
					// (including the one that just failed — restore what we can).
					for (const { targetDir: t, backupPath: b } of backups) {
						try {
							await this.restoreBackup(t, b);
						} catch (restoreErr) {
							// Log but don't swallow the original error
							console.error(`[syncBundleComponents] rollback failed for ${t}:`, restoreErr);
						}
					}
					throw err;
				}
				installedResources.push({ type, path: targetDir, name: entry });
			}
		}

		// All components succeeded — clean up all backups
		for (const { backupPath } of backups) {
			await this.cleanupBackup(backupPath);
		}

		return installedResources;
	}

	/**
	 * Detect package name from extracted directory contents.
	 */
	private async detectName(dir: string, _type: ResourceType): Promise<string> {
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

		onProgress?.("removing", "Cleaning up staging...");
		await this.cleanupStaging();

		onProgress?.("saving", "Updating package database...");
		this.db.removePackage(pkg.name);
		onProgress?.("done", `Removed ${pkg.name}`);
	}
}
