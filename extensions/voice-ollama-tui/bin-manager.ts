/**
 * Binary manager for voice-ollama-tui.
 *
 * Downloads platform-specific whisper-cli binaries from FAN Store asset
 * packages on demand during `/voice init`. Binaries are not bundled with the
 * extension; the user is asked for permission before download.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import * as tar from "tar";
import { getExtensionDir } from "./config.js";
import { VoiceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_BASE_URL = "https://fan.sea-agents.ru/fan-store/assets";

const SUPPORTED_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "windows-x64",
] as const;

type Platform = (typeof SUPPORTED_PLATFORMS)[number];

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

const FFMPEG_BINARY_NAMES: Record<Platform, string> = {
  "linux-x64": "ffmpeg",
  "linux-arm64": "ffmpeg",
  "darwin-arm64": "ffmpeg",
  "darwin-x64": "ffmpeg",
  "windows-x64": "ffmpeg.exe",
};

// Version of the ffmpeg binary asset packages. Should match the package
// versions published to FAN Store.
const FFMPEG_ASSET_VERSION = "7.0.2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BinaryInfo {
  platform: Platform;
  url: string;
  archiveName: string;
  binaryName: string;
  sizeBytes?: number;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  onStatus?: (message: string) => void;
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
 * Return the asset package name for a platform.
 */
export function getAssetName(platform: Platform): string {
  return `voice-ollama-tui-whisper-bin-${platform}`;
}

/**
 * Return download URL for a platform's asset package.
 */
export function getBinaryUrl(platform: Platform): string {
  const archiveExt = platform.startsWith("windows") ? "tar.gz" : "tar.gz";
  const archiveName = `${getAssetName(platform)}-${ASSET_VERSION}.${archiveExt}`;
  return `${STORE_BASE_URL}/${archiveName}`;
}

/**
 * Try to determine the asset package size via HEAD request.
 * Returns undefined if the server does not report Content-Length.
 */
export async function getBinarySize(platform: Platform): Promise<number | undefined> {
  const url = getBinaryUrl(platform);
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return undefined;
    const cl = response.headers.get("content-length");
    if (cl) return Number.parseInt(cl, 10);
  } catch {
    // Ignore network errors; the wizard will still offer the download.
  }
  return undefined;
}

/**
 * Build a human-readable description of the download for the user.
 */
export async function getBinaryDownloadInfo(platform?: Platform): Promise<BinaryInfo | undefined> {
  const p = platform ?? getCurrentPlatform();
  if (!p) return undefined;

  const url = getBinaryUrl(p);
  const sizeBytes = await getBinarySize(p);

  return {
    platform: p,
    url,
    archiveName: `${getAssetName(p)}-${ASSET_VERSION}.tar.gz`,
    binaryName: BINARY_NAMES[p],
    sizeBytes,
  };
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
 * Check whether whisper-cli is available in PATH.
 */
export function isWhisperCliInPath(): boolean {
  try {
    execSync("whisper-cli -h", { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// FFmpeg binary helpers (mirror whisper functions above)
// ---------------------------------------------------------------------------

/**
 * Return the asset package name for a platform's ffmpeg binary.
 */
export function getFfmpegAssetName(platform: Platform): string {
  return `voice-ollama-tui-ffmpeg-bin-${platform}`;
}

/**
 * Return download URL for a platform's ffmpeg asset package.
 */
export function getFfmpegBinaryUrl(platform: Platform): string {
  const archiveName = `${getFfmpegAssetName(platform)}-${FFMPEG_ASSET_VERSION}.tar.gz`;
  return `${STORE_BASE_URL}/${archiveName}`;
}

/**
 * Try to determine the ffmpeg asset package size via HEAD request.
 * Returns undefined if the server does not report Content-Length.
 */
export async function getFfmpegBinarySize(platform: Platform): Promise<number | undefined> {
  const url = getFfmpegBinaryUrl(platform);
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return undefined;
    const cl = response.headers.get("content-length");
    if (cl) return Number.parseInt(cl, 10);
  } catch {
    // Ignore network errors; the wizard will still offer the download.
  }
  return undefined;
}

/**
 * Build a human-readable description of the ffmpeg download for the user.
 */
export async function getFfmpegDownloadInfo(platform?: Platform): Promise<BinaryInfo | undefined> {
  const p = platform ?? getCurrentPlatform();
  if (!p) return undefined;

  const url = getFfmpegBinaryUrl(p);
  const sizeBytes = await getFfmpegBinarySize(p);

  return {
    platform: p,
    url,
    archiveName: `${getFfmpegAssetName(p)}-${FFMPEG_ASSET_VERSION}.tar.gz`,
    binaryName: FFMPEG_BINARY_NAMES[p],
    sizeBytes,
  };
}

/**
 * Return the local path where the ffmpeg binary should be cached.
 */
export function getLocalFfmpegPath(platform?: Platform): string {
  const p = platform ?? getCurrentPlatform();
  if (!p) {
    throw new VoiceError(
      `Unsupported platform: ${process.platform} ${process.arch}. No prebuilt ffmpeg binary is available.`,
    );
  }
  const extDir = getExtensionDir();
  return path.join(extDir, "bin", p, FFMPEG_BINARY_NAMES[p]);
}

/**
 * Check whether the local ffmpeg binary exists and is executable.
 */
export function hasLocalFfmpegBinary(platform?: Platform): boolean {
  try {
    const binPath = getLocalFfmpegPath(platform);
    const stat = fs.statSync(binPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Download and extract the ffmpeg binary for the given platform from
 * FAN Store asset packages.
 *
 * @param platform - Target platform. Defaults to current platform.
 * @param options.onProgress - Optional progress callback.
 * @returns Absolute path to the extracted ffmpeg binary.
 * @throws {VoiceError} On unsupported platform or download failure.
 */
export async function downloadFfmpegBinary(
  platform?: Platform,
  options?: DownloadOptions,
): Promise<string> {
  const p = platform ?? getCurrentPlatform();
  if (!p) {
    throw new VoiceError(
      `Unsupported platform: ${process.platform} ${process.arch}. ` +
        `Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.`,
    );
  }

  const info = await getFfmpegDownloadInfo(p);
  if (!info) {
    throw new VoiceError(`Could not resolve download info for platform ${p}.`);
  }

  const pkgName = getFfmpegAssetName(p);
  const url = info.url;

  const extDir = getExtensionDir();
  const tempDir = path.join(extDir, ".tmp-bin-download");
  const archivePath = path.join(tempDir, info.archiveName);
  const extractDir = path.join(tempDir, pkgName);
  const binDir = path.join(extDir, "bin", p);
  const binPath = path.join(binDir, FFMPEG_BINARY_NAMES[p]);

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const status = (msg: string) => options?.onStatus?.(`[ffmpeg] ${msg}`);

  try {
    status(`Скачивание архива: ${url}`);
    await downloadFile(url, archivePath, options);
    const archiveSize = fs.statSync(archivePath).size;
    status(`Архив скачан: ${archiveSize} байт`);

    status("Распаковка архива...");
    await extractArchive(archivePath, extractDir, p, status);
    status("Архив распакован");

    const extractedBinPath = path.join(extractDir, FFMPEG_BINARY_NAMES[p]);
    status(`Поиск бинарника: ${extractedBinPath}`);
    if (!fs.existsSync(extractedBinPath)) {
      throw new VoiceError(
        `Binary not found inside downloaded archive: ${extractedBinPath}`,
      );
    }

    status("Копирование бинарника...");
    fs.copyFileSync(extractedBinPath, binPath);
    if (process.platform !== "win32") {
      fs.chmodSync(binPath, 0o755);
    }
    status(`Бинарник сохранён: ${binPath}`);

    return binPath;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    status(`Ошибка: ${detail}\n${stack}`);
    if (err instanceof VoiceError) {
      throw err;
    }
    throw new VoiceError(
      `Failed to download ffmpeg binary from ${url}: ${detail}`,
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Download and extract the whisper-cli binary for the given platform from
 * FAN Store asset packages.
 *
 * @param platform - Target platform. Defaults to current platform.
 * @param options.onProgress - Optional progress callback.
 * @returns Absolute path to the extracted whisper-cli binary.
 * @throws {VoiceError} On unsupported platform or download failure.
 */
export async function downloadWhisperBinary(
  platform?: Platform,
  options?: DownloadOptions,
): Promise<string> {
  const p = platform ?? getCurrentPlatform();
  if (!p) {
    throw new VoiceError(
      `Unsupported platform: ${process.platform} ${process.arch}. ` +
        `Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.`,
    );
  }

  const info = await getBinaryDownloadInfo(p);
  if (!info) {
    throw new VoiceError(`Could not resolve download info for platform ${p}.`);
  }

  const pkgName = getAssetName(p);
  const url = info.url;

  const extDir = getExtensionDir();
  const tempDir = path.join(extDir, ".tmp-bin-download");
  const archivePath = path.join(tempDir, info.archiveName);
  const extractDir = path.join(tempDir, pkgName);
  const binDir = path.join(extDir, "bin", p);
  const binPath = path.join(binDir, BINARY_NAMES[p]);

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const status = (msg: string) => options?.onStatus?.(`[whisper] ${msg}`);

  try {
    status(`Скачивание архива: ${url}`);
    await downloadFile(url, archivePath, options);
    const archiveSize = fs.statSync(archivePath).size;
    status(`Архив скачан: ${archiveSize} байт`);

    status("Распаковка архива...");
    await extractArchive(archivePath, extractDir, p, status);
    status("Архив распакован");

    const extractedBinPath = path.join(extractDir, BINARY_NAMES[p]);
    status(`Поиск бинарника: ${extractedBinPath}`);
    if (!fs.existsSync(extractedBinPath)) {
      throw new VoiceError(
        `Binary not found inside downloaded archive: ${extractedBinPath}`,
      );
    }

    status("Копирование бинарника...");
    fs.copyFileSync(extractedBinPath, binPath);
    if (process.platform !== "win32") {
      fs.chmodSync(binPath, 0o755);
    }
    status(`Бинарник сохранён: ${binPath}`);

    return binPath;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    status(`Ошибка: ${detail}\n${stack}`);
    if (err instanceof VoiceError) {
      throw err;
    }
    throw new VoiceError(
      `Failed to download whisper-cli binary from ${url}: ${detail}`,
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function downloadFile(
  url: string,
  destination: string,
  options?: DownloadOptions,
): Promise<void> {
  options?.onStatus?.(`[download] GET ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? Number.parseInt(contentLength, 10) : 0;
  options?.onStatus?.(`[download] content-length=${total}`);

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
        // Use Buffer.from(Uint8Array) to preserve byte offset/length.
        // Buffer.from(value.buffer) would use the entire backing ArrayBuffer
        // and corrupt archives whose chunks are views into a larger buffer.
        writeStream.write(Buffer.from(value), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      options?.onProgress?.({ downloaded, total });
    }

    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
    options?.onStatus?.(`[download] finished, wrote ${downloaded} bytes`);
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
  _platform: Platform,
  onStatus?: (message: string) => void,
): Promise<void> {
  fs.mkdirSync(extractDir, { recursive: true });

  // Use the 'tar' npm package for cross-platform tar.gz extraction.
  // It is the same battle-tested library used by npm itself and works on
  // Windows without relying on the system tar CLI.
  onStatus?.("[extract] extracting archive with tar package");
  await tar.x({
    file: archivePath,
    cwd: extractDir,
    strip: 1,
    gzip: true,
    onwarn: (code, message) => {
      onStatus?.(`[extract] tar warn ${code}: ${message}`);
    },
  });
  onStatus?.("[extract] extraction complete");
}
