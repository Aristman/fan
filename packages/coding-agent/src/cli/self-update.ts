/**
 * Self-update module for FAN CLI.
 *
 * Supports checking for updates and downloading/installing new versions
 * from the FAN distribution server.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chalk from "chalk";
import { isBunBinary, VERSION } from "../config.js";
// extract-zip removed: used child_process unzip to avoid runtime dependency in bun binary

// =============================================================================
// Types
// =============================================================================

export interface UpdateManifest {
	latest: string;
	releasedAt: string;
	releaseNotes: string;
	platforms: Record<string, { url: string; hash: string; size: number }>;
}

export interface UpdateCheckResult {
	currentVersion: string;
	latestVersion: string;
	hasUpdate: boolean;
	releaseNotes: string;
}

// =============================================================================
// Constants
// =============================================================================

export const UPDATE_SERVER_URL = "http://185.219.41.46/fan/dist";

/** Directories/assets to copy from archive when updating */
const UPDATE_ASSETS = [
	"theme",
	"assets",
	"export-html",
	"orchestrator",
	"dashboard",
	"photon_rs_bg.wasm",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"node_modules",
];

// =============================================================================
// Platform detection
// =============================================================================

/** Detect current platform key for manifest */
export function detectPlatform(): string {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "darwin") {
		if (arch === "arm64") return "darwin-arm64";
		if (arch === "x64") return "darwin-x64";
	}

	if (platform === "linux") {
		if (arch === "x64") return "linux-x64";
		if (arch === "arm64") return "linux-arm64";
	}

	if (platform === "win32") {
		if (arch === "x64") return "windows-x64";
	}

	// Bun binary runtime detection fallback
	if (isBunBinary) {
		const execPath = process.execPath.toLowerCase();
		if (execPath.includes("darwin")) {
			return execPath.includes("arm64") ? "darwin-arm64" : "darwin-x64";
		}
		if (execPath.includes("linux")) {
			return execPath.includes("arm64") ? "linux-arm64" : "linux-x64";
		}
		if (execPath.includes("win")) {
			return "windows-x64";
		}
	}

	return "unknown";
}

// =============================================================================
// Manifest fetching
// =============================================================================

/** Fetch manifest from update server, returns null if offline/error */
export async function fetchManifest(signal?: AbortSignal): Promise<UpdateManifest | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);

		// Combine external signal with our timeout
		if (signal) {
			signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const response = await fetch(`${UPDATE_SERVER_URL}/manifest.json`, {
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) return null;

		const data = (await response.json()) as UpdateManifest;
		if (!data.latest || !data.platforms) return null;

		return data;
	} catch {
		return null;
	}
}

// =============================================================================
// Version comparison (simple semver)
// =============================================================================

/** Compare two semver-like version strings. Returns >0 if a>b, <0 if a<b, 0 if equal */
function compareVersions(a: string, b: string): number {
	const parse = (v: string): number[] =>
		v
			.replace(/^v/, "")
			.split(".")
			.map((s) => parseInt(s, 10) || 0);

	const pa = parse(a);
	const pb = parse(b);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const va = pa[i] ?? 0;
		const vb = pb[i] ?? 0;
		if (va !== vb) return va - vb;
	}

	return 0;
}

// =============================================================================
// Update checking
// =============================================================================

/** Check if update is available */
export async function checkForUpdate(
	currentVersion: string,
	signal?: AbortSignal,
): Promise<UpdateCheckResult | null> {
	const manifest = await fetchManifest(signal);
	if (!manifest) return null;

	const hasUpdate = compareVersions(manifest.latest, currentVersion) > 0;

	return {
		currentVersion,
		latestVersion: manifest.latest,
		hasUpdate,
		releaseNotes: manifest.releaseNotes || "",
	};
}

// =============================================================================
// Download and install
// =============================================================================

/** Download a URL to a file with progress reporting */
async function downloadFile(
	url: string,
	destPath: string,
	options?: {
		onProgress?: (downloaded: number, total: number) => void;
		signal?: AbortSignal;
	},
): Promise<void> {
	const response = await fetch(url, { signal: options?.signal });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: Failed to download ${url}`);
	}

	const total = Number(response.headers.get("content-length") || 0);
	let downloaded = 0;

	const fileStream = (await import("node:fs")).createWriteStream(destPath);

	if (response.body && total > 0) {
		// Transform the web ReadableStream to a Node stream
		const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);

		let lastReported = 0;
		nodeStream.on("data", (chunk: Buffer) => {
			downloaded += chunk.length;
			if (options?.onProgress && downloaded - lastReported > 102400) {
				options.onProgress(downloaded, total);
				lastReported = downloaded;
			}
		});

		await pipeline(nodeStream, fileStream);
	} else {
		// No content-length or no body — just pipe
		const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
		await pipeline(nodeStream, fileStream);
		downloaded = statSync(destPath).size;
	}

	options?.onProgress?.(downloaded, downloaded);
}

/** Verify SHA-256 hash of a file */
function verifySha256(filePath: string, expectedHash: string): void {
	const expected = expectedHash.replace(/^sha256:/, "");
	const actual = createHash("sha256").update(require("node:fs").readFileSync(filePath)).digest("hex");

	if (actual !== expected) {
		throw new Error(
			`SHA-256 checksum mismatch!\n  Expected: ${expected}\n  Actual:   ${actual}`,
		);
	}
}

/** Extract .tar.gz archive using system tar command */
function extractTarGz(archivePath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("tar", ["xzf", archivePath, "-C", destDir], {
			stdio: "pipe",
		});
		let stderr = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`tar extraction failed (exit code ${code}): ${stderr}`));
		});
		child.on("error", reject);
	});
}

/** Copy a file or directory recursively */
function copyRecursive(src: string, dest: string): void {
	const stat = statSync(src);
	if (stat.isDirectory()) {
		mkdirSync(dest, { recursive: true });
		for (const entry of readdirSync(src)) {
			copyRecursive(join(src, entry), join(dest, entry));
		}
	} else {
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(src, dest);
	}
}

/** Extract .zip archive using system tools (no extract-zip dependency needed in bun binary) */
function extractZipArchive(archivePath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: import("child_process").ChildProcess;
		if (process.platform === "win32") {
			// Windows: use PowerShell Expand-Archive
			child = spawn(
				"powershell.exe",
				["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`],
				{ stdio: "pipe", windowsHide: true },
			);
		} else {
			// Unix: use unzip
			child = spawn("unzip", ["-q", "-o", archivePath, "-d", destDir], {
				stdio: "pipe",
			});
		}
		let stderr = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`zip extraction failed (exit code ${code}): ${stderr}`));
		});
		child.on("error", reject);
	});
}

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// =============================================================================
// performUpdate
// =============================================================================

/** Download and apply update */
export async function performUpdate(options?: {
	onProgress?: (downloaded: number, total: number) => void;
	signal?: AbortSignal;
}): Promise<void> {
	// 1. Detect platform
	const platform = detectPlatform();
	if (platform === "unknown") {
		throw new Error("Cannot detect current platform. Self-update is not supported.");
	}

	// 2. Fetch manifest
	const manifest = await fetchManifest(options?.signal);
	if (!manifest) {
		throw new Error("Failed to fetch update manifest. Check your internet connection.");
	}

	// 3. Check update available
	if (compareVersions(manifest.latest, VERSION) <= 0) {
		throw new Error(`Already on the latest version (${VERSION}). No update needed.`);
	}

	// 4. Get URL and hash from manifest for platform
	const platformInfo = manifest.platforms[platform];
	if (!platformInfo) {
		throw new Error(`Platform '${platform}' is not available in the latest release.`);
	}

	// 5. Download archive to temp directory
	const workDir = join(tmpdir(), `fan-update-${Date.now()}`);
	mkdirSync(workDir, { recursive: true });

	const archiveFileName = basename(platformInfo.url);
	const archivePath = join(workDir, archiveFileName);

	console.log(chalk.dim(`Downloading ${archiveFileName}...`));
	await downloadFile(platformInfo.url, archivePath, {
		onProgress: options?.onProgress,
		signal: options?.signal,
	});

	// 6. Verify SHA-256 hash
	console.log(chalk.dim("Verifying checksum..."));
	verifySha256(archivePath, platformInfo.hash);

	// 7. Extract archive to temp directory
	const extractDir = join(workDir, "extract");
	mkdirSync(extractDir, { recursive: true });

	console.log(chalk.dim("Extracting archive..."));
	if (archiveFileName.endsWith(".zip")) {
		await extractZipArchive(archivePath, extractDir);
	} else if (archiveFileName.endsWith(".tar.gz")) {
		await extractTarGz(archivePath, extractDir);
	} else {
		throw new Error(`Unsupported archive format: ${archiveFileName}`);
	}

	// The archive contains a 'fan' directory
	const sourceDir = join(extractDir, "fan");
	if (!existsSync(sourceDir)) {
		throw new Error(`Archive does not contain expected 'fan' directory.`);
	}

	// 8. Determine current install directory (resolve symlinks)
	const installDir = dirname(realpathSync(process.execPath));
	const backupDir = join(workDir, "backup");
	mkdirSync(backupDir, { recursive: true });

	const binaryName = process.platform === "win32" ? "fan.exe" : "fan";
	const currentBinary = join(installDir, binaryName);
	const newBinary = join(sourceDir, binaryName);

	// 9. Backup current files (binary + assets)
	console.log(chalk.dim("Backing up current installation..."));
	if (existsSync(currentBinary)) {
		copyFileSync(currentBinary, join(backupDir, binaryName));
	}
	for (const asset of UPDATE_ASSETS) {
		const currentAsset = join(installDir, asset);
		if (existsSync(currentAsset)) {
			copyRecursive(currentAsset, join(backupDir, asset));
		}
	}

	// 10. Install new binary
	console.log(chalk.dim("Installing new binary..."));

	if (process.platform === "win32") {
		// Windows: cannot overwrite a running .exe (EBUSY).
		// Spawn a detached batch helper that waits for this process to exit,
		// then copies the new binary and cleans up temp files.
		const helperPath = join(workDir, "apply-update.bat");
		const bat = [
			"@echo off",
			"chcp 65001 >NUL 2>&1",
			`set "PID=${process.pid}"`,
			`set "SRC=${newBinary.replace(/\//g, "\\")}"`,
			`set "DST=${currentBinary.replace(/\//g, "\\")}"`,
			`set "WORK=${workDir.replace(/\//g, "\\")}"`,
			":waitloop",
			`tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL`,
			"if not errorlevel 1 (",
			"  timeout /t 1 /nobreak >NUL",
			"  goto waitloop",
			")",
			`copy /Y "%SRC%" "%DST%" >NUL 2>&1`,
			"if errorlevel 1 (",
			`  echo Failed to apply update: could not copy binary. > "%WORK%\\\\update-error.log"`,
			"  exit /b 1",
			")",
			`rd /S /Q "%WORK%" >NUL 2>&1`,
			"exit /b 0",
		].join("\r\n");
		writeFileSync(helperPath, bat, "utf-8");
		spawn("cmd.exe", ["/C", helperPath], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		}).unref();
	} else {
		// Linux/macOS: rename() atomically replaces the running binary.
		// The kernel keeps the old inode alive for the running process;
		// the path now points to the new binary.
		try {
			renameSync(newBinary, currentBinary);
		} catch (renameErr) {
			// Cross-filesystem rename fails with EXDEV — copy to staging then rename
			if ((renameErr as NodeJS.ErrnoException).code === "EXDEV") {
				const staging = join(installDir, `.fan-update-${Date.now()}`);
				try {
					copyFileSync(newBinary, staging);
					renameSync(staging, currentBinary);
				} catch (innerErr) {
					try {
						rmSync(staging, { force: true });
					} catch {
						/* ignore */
					}
					throw innerErr;
				}
			} else {
				throw renameErr;
			}
		}
		require("node:fs").chmodSync(currentBinary, 0o755);
	}

	// 11. Copy new assets (not locked by the running process)
	console.log(chalk.dim("Installing assets..."));
	for (const asset of UPDATE_ASSETS) {
		const newAsset = join(sourceDir, asset);
		if (existsSync(newAsset)) {
			const destAsset = join(installDir, asset);
			// Remove old version first
			if (existsSync(destAsset)) {
				rmSync(destAsset, { recursive: true, force: true });
			}
			copyRecursive(newAsset, destAsset);
		}
	}

	// 12. Clean up temp + backup (skip on Windows — helper script handles it)
	if (process.platform !== "win32") {
		try {
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			// Non-critical: temp files will be cleaned by OS eventually
		}
	}

	// 13. Print result
	console.log("");
	if (process.platform === "win32") {
		console.log(chalk.green.bold("✓ Update staged!"));
		console.log(chalk.dim(`  ${chalk.white(VERSION)} → ${chalk.white(manifest.latest)}`));
		console.log(chalk.dim("  The new binary will be installed when this process exits."));
		console.log(chalk.dim(`  Installed to: ${chalk.white(installDir)}`));
	} else {
		console.log(chalk.green.bold("✓ Update complete!"));
		console.log(chalk.dim(`  Updated from ${chalk.white(VERSION)} to ${chalk.white(manifest.latest)}`));
		console.log(chalk.dim(`  Installed to: ${chalk.white(installDir)}`));
	}
	console.log("");
}

// =============================================================================
// CLI command handler
// =============================================================================

/** Run self-update as CLI command */
export async function runSelfUpdate(args: string[]): Promise<boolean> {
	if (args[0] !== "update") return false;

	const flags = {
		check: args.includes("--check"),
		force: args.includes("--force"),
		json: args.includes("--json"),
	};

	// If there are non-flag arguments after "update", it's a package command (e.g. "fan update some-pkg")
	const nonFlagArgs = args.slice(1).filter((a) => !a.startsWith("--"));
	if (nonFlagArgs.length > 0 && !flags.check && !flags.force && !flags.json) {
		return false; // Let handlePackageCommand handle it
	}

	// 1. Show current version
	if (!flags.json) {
		console.log(chalk.dim(`Current version: ${chalk.white(VERSION)}`));
	}

	// 2. Check for update
	const result = await checkForUpdate(VERSION);

	if (!result) {
		if (flags.json) {
			console.log(JSON.stringify({ error: "Could not check for updates", currentVersion: VERSION }));
		} else {
			console.log(chalk.yellow("Could not check for updates. Check your internet connection."));
		}
		return true;
	}

	// Machine-readable JSON output
	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		return true;
	}

	if (!result.hasUpdate) {
		console.log(chalk.green("You're already on the latest version."));
		return true;
	}

	console.log(chalk.cyan(`New version available: ${chalk.bold(result.latestVersion)}`));
	if (result.releaseNotes) {
		console.log(chalk.dim(`  ${result.releaseNotes}`));
	}
	console.log("");

	// 3. If --check only, stop here
	if (flags.check) {
		console.log(chalk.dim("Run 'fan update' to install the update."));
		return true;
	}

	// 4. Confirm (unless --force)
	if (!flags.force) {
		const { createInterface } = await import("node:readline");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise<string>((resolve) => {
			rl.question(chalk.yellow(`Update to ${result.latestVersion}? [y/N] `), (a) => {
				rl.close();
				resolve(a);
			});
		});
		if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
			console.log(chalk.dim("Update cancelled."));
			return true;
		}
	}

	// 5 & 6. Download and apply update with progress
	let lastLine = "";
	function showProgress(downloaded: number, total: number): void {
		const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
		const line = `  Downloading: ${formatBytes(downloaded)} / ${formatBytes(total)} (${percent}%)`;
		if (line !== lastLine) {
			// Erase previous line
			if (lastLine) process.stdout.write("\r\x1b[K");
			process.stdout.write(chalk.dim(line));
			lastLine = line;
		}
	}

	try {
		await performUpdate({
			onProgress: showProgress,
		});
		// Clear the progress line
		if (lastLine) process.stdout.write("\r\x1b[K");
	} catch (err) {
		if (lastLine) process.stdout.write("\r\x1b[K");
		const message = err instanceof Error ? err.message : String(err);
		console.error(chalk.red(`Update failed: ${message}`));
		return true;
	}

	return true;
}

/** Convenience alias for use in main.ts */
export const handleUpdateCommand = runSelfUpdate;
