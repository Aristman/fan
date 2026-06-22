/**
 * Binary manager for voice-ollama-tui.
 *
 * Downloads platform-specific whisper-cli binaries from FAN Store asset
 * packages and caches them inside the extension directory.
 */

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getExtensionDir } from "./config.js";
import { VoiceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_BASE_URL = "https://fan.sea-agents.ru/fan-store/packages";

const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "windows-x64",
] as const;

type Platform = (typeof SUPPORTED_PLATFORMS)[number];

// Map Node process identifiers to our platform keys.
const PLATFORM_MAP: Record<string, Platform> = {
  "linuxx64": "linux-x64",
  "linuxarm64": "linux-arm64",
  "darwinarm64": "darwin-arm64",
  "darwinx64": "darwin-x64",
  "win32x64": "windows-x64",
};

const BINARY_NAMES: Record<Platform, string> = {
  "linux-x64": "whisper-cli",
  "linux-arm64": "whisper-cli",
  "darwin-arm64": "whisper-cli",
  "darwin-x64": "whisper-cli",
  "windows-x64": "whisper-cli.exe",
};

// Version of the whisper binary asset packages. Should match the package
// versions published to FAN Store.
const ASSET_VERSION = "1.9.1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  downloaded: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine the current platform key based on Node's process.platform and
 * process.arch. Returns undefined for unsupported combinations.
 */
export function getCurrentPlatform(): Platform | undefined {
  const key = `${process.platform}${process.arch}`.toLowerCase();
  return PLATFORM_MAP[key];
}

/**
 * Check whether a prebuilt binary for the current platform is supported.
 */
export function isPrebuiltBinarySupported(): boolean {
  return getCurrentPlatform() !== undefined;
}

/**
 * Return the local path where the whisper-cli binary should be cached.
 */
export function getLocalBinaryPath(platform?: Platform): string {
  const p = platform ?? getCurrentPlatform();
  if (!p) {
    throw new VoiceError(
      `Unsupported platform: ${process.platform} ${process.arch}. No prebuilt whisper-cli binary is available.`,
    );
  }
  const extDir = getExtensionDir();
  return path.join(extDir, "bin", p, BINARY_NAMES[p]);
}

/**
 * Check whether the local whisper-cli binary exists and is executable.
 */
export function hasLocalBinary(platform?: Platform): boolean {
  try {
    const binPath = getLocalBinaryPath(platform);
    const stat = fs.statSync(binPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Download and extract the whisper-cli binary for the current platform from
 * FAN Store asset packages.
 *
 * @param options.onProgress - Optional progress callback.
 * @returns Absolute path to the extracted whisper-cli binary.
 * @throws {VoiceError} On unsupported platform or download failure.
 */
export async function downloadWhisperBinary(
  options?: {
    onProgress?: (progress: DownloadProgress) => void;
  },
): Promise<string> {
  const platform = getCurrentPlatform();
  if (!platform) {
    throw new VoiceError(
      `Unsupported platform: ${process.platform} ${process.arch}. ` +
        `Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.`,
    );
  }

  const pkgName = `voice-ollama-tui-whisper-bin-${platform}`;
  const archiveExt = platform.startsWith("windows") ? "zip" : "tar.gz";
  const archiveName = `${pkgName}-${ASSET_VERSION}.${archiveExt}`;
  const url = `${STORE_BASE_URL}/${archiveName}`;

  const extDir = getExtensionDir();
  const tempDir = path.join(extDir, ".tmp-bin-download");
  const archivePath = path.join(tempDir, archiveName);
  const extractDir = path.join(tempDir, pkgName);
  const binDir = path.join(extDir, "bin", platform);
  const binPath = path.join(binDir, BINARY_NAMES[platform]);

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  try {
    await downloadFile(url, archivePath, options?.onProgress);
    await extractArchive(archivePath, extractDir, platform);

    const extractedBinPath = path.join(extractDir, pkgName, BINARY_NAMES[platform]);
    if (!fs.existsSync(extractedBinPath)) {
      throw new VoiceError(
        `Binary not found inside downloaded archive: ${extractedBinPath}`,
      );
    }

    // Move binary to final location.
    fs.copyFileSync(extractedBinPath, binPath);
    fs.chmodSync(binPath, 0o755);

    // Cleanup temp files.
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }

    return binPath;
  } catch (err) {
    // Cleanup on failure.
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }

    if (err instanceof VoiceError) {
      throw err;
    }
    throw new VoiceError(
      `Failed to download whisper-cli binary from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? Number.parseInt(contentLength, 10) : 0;

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  const writeStream = fs.createWriteStream(destination);
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      downloaded += value.byteLength;
      await new Promise<void>((resolve, reject) => {
        writeStream.write(Buffer.from(value.buffer), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      onProgress?.({ downloaded, total });
    }

    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
  } catch (err) {
    writeStream.destroy();
    throw err;
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort */ }
  }
}

async function extractArchive(
  archivePath: string,
  extractDir: string,
  platform: Platform,
): Promise<void> {
  fs.mkdirSync(extractDir, { recursive: true });

  if (platform.startsWith("windows")) {
    // Windows: use unzip via child_process (available on most systems).
    const { execFileSync } = await import("node:child_process");
    execFileSync("unzip", ["-o", archivePath, "-d", extractDir], { stdio: "ignore" });
  } else {
    // Unix: tar.
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "ignore" });
  }
}
