/**
 * Tests for voice-ollama-tui binary manager (bin-manager.ts)
 *
 * Covers both whisper-cli and ffmpeg binary management functions.
 *
 * Strategy:
 *   - Pure function tests (asset name, URL) are run directly.
 *   - Platform-dependent tests mock process.platform / process.arch.
 *   - File-system-dependent tests (hasLocalBinary, hasLocalFfmpegBinary)
 *     are integration-level and avoided here in favour of unit-level tests.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

function mockProcessPlatform(platform: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// FFmpeg binary functions
// ═══════════════════════════════════════════════════════════════════════════

describe("bin-manager ffmpeg functions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getFfmpegAssetName ──────────────────────────────────────────────
  it.each([
    ["linux-x64", "voice-ollama-tui-ffmpeg-bin-linux-x64"],
    ["linux-arm64", "voice-ollama-tui-ffmpeg-bin-linux-arm64"],
    ["darwin-arm64", "voice-ollama-tui-ffmpeg-bin-darwin-arm64"],
    ["darwin-x64", "voice-ollama-tui-ffmpeg-bin-darwin-x64"],
    ["windows-x64", "voice-ollama-tui-ffmpeg-bin-windows-x64"],
  ])("getFfmpegAssetName(%s) returns %s", async (platform, expected) => {
    const { getFfmpegAssetName } = await import("./bin-manager.js");
    expect(getFfmpegAssetName(platform as any)).toBe(expected);
  });

  // ── getFfmpegBinaryUrl ──────────────────────────────────────────────
  it.each([
    ["linux-x64", "https://fan.sea-agents.ru/fan-store/assets/voice-ollama-tui-ffmpeg-bin-linux-x64-7.0.2.tar.gz"],
    ["darwin-arm64", "https://fan.sea-agents.ru/fan-store/assets/voice-ollama-tui-ffmpeg-bin-darwin-arm64-7.0.2.tar.gz"],
    ["windows-x64", "https://fan.sea-agents.ru/fan-store/assets/voice-ollama-tui-ffmpeg-bin-windows-x64-7.0.2.tar.gz"],
  ])("getFfmpegBinaryUrl(%s) returns correct URL", async (platform, expected) => {
    const { getFfmpegBinaryUrl } = await import("./bin-manager.js");
    expect(getFfmpegBinaryUrl(platform as any)).toBe(expected);
  });

  // ── getLocalFfmpegPath ──────────────────────────────────────────────
  it.each([
    ["linux-x64", "ffmpeg"],
    ["darwin-arm64", "ffmpeg"],
    ["windows-x64", "ffmpeg.exe"],
  ])("getLocalFfmpegPath(%s) ends with %s", async (platform, expectedBinary) => {
    const { getLocalFfmpegPath } = await import("./bin-manager.js");
    const binPath = getLocalFfmpegPath(platform as any);

    // Should be under /bin/<platform>/<binary>
    expect(binPath).toContain("bin");
    expect(binPath).toContain(platform);
    expect(binPath.endsWith(expectedBinary)).toBe(true);
    expect(path.isAbsolute(binPath)).toBe(true);
  });

  // ── getLocalFfmpegPath throws for unsupported platform ──────────────
  it("getLocalFfmpegPath throws for unsupported platform", async () => {
    mockProcessPlatform("freebsd", "x64");
    const { getLocalFfmpegPath } = await import("./bin-manager.js");
    expect(() => getLocalFfmpegPath()).toThrow();
  });

  // ── getLocalFfmpegPath returns path in extension bin dir ────────────
  it("getLocalFfmpegPath returns path under extension bin dir", async () => {
    const { getLocalFfmpegPath } = await import("./bin-manager.js");
    const binPath = getLocalFfmpegPath("linux-x64");

    // The path should be rooted at the extension directory
    expect(binPath.startsWith(EXT_DIR)).toBe(true);
    expect(binPath).toContain(path.join("bin", "linux-x64"));
    expect(binPath.endsWith("ffmpeg")).toBe(true);
  });

  // ── hasLocalFfmpegBinary returns false when file does not exist ─────
  it("hasLocalFfmpegBinary returns false when file does not exist", async () => {
    vi.doMock("./config.js", () => ({
      getExtensionDir: () => "/tmp/nonexistent-extension-dir",
    }));
    const { hasLocalFfmpegBinary } = await import("./bin-manager.js");
    expect(hasLocalFfmpegBinary("linux-x64")).toBe(false);
  });

  // ── getFfmpegDownloadInfo returns undefined for unsupported ─────────
  it("getFfmpegDownloadInfo returns undefined for unsupported platform", async () => {
    mockProcessPlatform("freebsd", "x64");
    const { getFfmpegDownloadInfo } = await import("./bin-manager.js");
    const info = await getFfmpegDownloadInfo();
    expect(info).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Whisper-cli functions (complementary to ffmpeg tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bin-manager whisper functions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getAssetName returns correct name for each platform", async () => {
    const { getAssetName } = await import("./bin-manager.js");
    expect(getAssetName("linux-x64")).toBe("voice-ollama-tui-whisper-bin-linux-x64");
    expect(getAssetName("darwin-arm64")).toBe("voice-ollama-tui-whisper-bin-darwin-arm64");
    expect(getAssetName("windows-x64")).toBe("voice-ollama-tui-whisper-bin-windows-x64");
  });

  it("getBinaryUrl returns correct URL", async () => {
    const { getBinaryUrl } = await import("./bin-manager.js");
    const url = getBinaryUrl("linux-x64");
    expect(url).toContain("voice-ollama-tui-whisper-bin-linux-x64");
    expect(url).toContain("1.9.1");
    expect(url).toContain("fan.sea-agents.ru");
  });

  it("getLocalBinaryPath returns absolute path ending with binary name", async () => {
    const { getLocalBinaryPath } = await import("./bin-manager.js");
    const binPath = getLocalBinaryPath("linux-x64");
    expect(path.isAbsolute(binPath)).toBe(true);
    expect(binPath).toContain("whisper-cli");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Platform detection
// ═══════════════════════════════════════════════════════════════════════════

describe("bin-manager platform detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getCurrentPlatform returns known platform for linux-x64", async () => {
    mockProcessPlatform("linux", "x64");
    vi.resetModules();
    const { getCurrentPlatform } = await import("./bin-manager.js");
    expect(getCurrentPlatform()).toBe("linux-x64");
  });

  it("getCurrentPlatform returns known platform for darwin-arm64", async () => {
    mockProcessPlatform("darwin", "arm64");
    vi.resetModules();
    const { getCurrentPlatform } = await import("./bin-manager.js");
    expect(getCurrentPlatform()).toBe("darwin-arm64");
  });

  it("getCurrentPlatform returns undefined for unsupported", async () => {
    mockProcessPlatform("freebsd", "x64");
    vi.resetModules();
    const { getCurrentPlatform } = await import("./bin-manager.js");
    expect(getCurrentPlatform()).toBeUndefined();
  });
});
