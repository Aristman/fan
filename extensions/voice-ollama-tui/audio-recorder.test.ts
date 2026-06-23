/**
 * Tests for voice-ollama-tui audio recorder (F-2.1 + F-2.3)
 *
 * Roadmap test cases:
 *   TC-F-2.1-1: Successful recording creates non-empty WAV file
 *   TC-F-2.1-2: When ffmpeg is missing, throws AudioRecorderError with RECORDER_NOT_FOUND
 *   TC-F-2.1-3: Abort signal correctly terminates the process
 *   TC-F-2.3-1: Fallback to sox when ffmpeg is missing
 *   TC-F-2.3-2: Fallback to arecord when ffmpeg and sox are missing (Linux)
 *
 * Strategy:
 *   Mock child_process.spawn to control recorder behaviour.
 *   Mock fs operations where needed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock types and helpers
// ---------------------------------------------------------------------------

type MockChild = ReturnType<typeof createMockChild>;

const handlerStore = new WeakMap<object, {
  on: Map<string, Function[]>;
  stderrData: Function[];
  stdoutData: Function[];
}>();

function createMockChild() {
  const mockOn = vi.fn();
  const mockStdoutOn = vi.fn();
  const mockStderrOn = vi.fn();
  const mockKill = vi.fn();

  const store = {
    on: new Map<string, Function[]>(),
    stderrData: [] as Function[],
    stdoutData: [] as Function[],
  };

  mockOn.mockImplementation((event: string, handler: Function) => {
    if (!store.on.has(event)) {
      store.on.set(event, []);
    }
    store.on.get(event)!.push(handler);
  });

  mockStderrOn.mockImplementation((event: string, handler: Function) => {
    if (event === "data") {
      store.stderrData.push(handler);
    }
  });

  mockStdoutOn.mockImplementation((event: string, handler: Function) => {
    if (event === "data") {
      store.stdoutData.push(handler);
    }
  });

  const child = {
    stdout: { on: mockStdoutOn },
    stderr: { on: mockStderrOn },
    on: mockOn,
    kill: mockKill,
  };

  handlerStore.set(child, store);

  return child;
}

function triggerEvent(
  child: MockChild,
  event: string,
  ...args: unknown[]
): void {
  const store = handlerStore.get(child);
  if (!store) return;
  const handlers = store.on.get(event);
  if (handlers) {
    for (const handler of handlers) {
      handler(...args);
    }
  }
}

function triggerStderrData(child: MockChild, data: string): void {
  const store = handlerStore.get(child);
  if (!store) return;
  for (const handler of store.stderrData) {
    handler(Buffer.from(data, "utf-8"));
  }
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    default: {
      ...actual,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(),
      statSync: vi.fn(),
      rmSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(),
    statSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Set up the spawn mock to produce a sequence of recorder responses.
 *
 * Each entry in `responses` describes what happens for one spawn call.
 * The mock returns a child process. For each entry a timeout fires the
 * appropriate events.
 */
function setupSpawnMock(
  responses: Array<
    | { kind: "success" }
    | { kind: "enoent" }
    | { kind: "failOther" }
    | { kind: "failCode"; code: number; stderr?: string }
    | { kind: "pending" }
  >,
) {
  let idx = 0;
  vi.mocked(spawn).mockImplementation((_command: string, _args: readonly string[]) => {
    const child = createMockChild();
    const resp = responses[idx] ?? { kind: "success" };
    idx++;

    if (resp.kind === "enoent") {
      setTimeout(() => {
        const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        triggerEvent(child, "error", err);
      }, 0);
    } else if (resp.kind === "failOther") {
      setTimeout(() => {
        const err = new Error("spawn failed: unknown error");
        triggerEvent(child, "error", err);
      }, 0);
    } else if (resp.kind === "failCode") {
      setTimeout(() => {
        if (resp.stderr) triggerStderrData(child, resp.stderr);
        triggerEvent(child, "close", resp.code);
      }, 0);
    } else if (resp.kind === "success") {
      setTimeout(() => {
        triggerEvent(child, "close", 0);
      }, 0);
    }
    // "pending": never fires events — useful for abort tests

    return child as unknown as ReturnType<typeof spawn>;
  });
}

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

function setupDefaultFsMocks(
  mockMkdtempSync: ReturnType<typeof vi.fn>,
  mockExistsSync: ReturnType<typeof vi.fn>,
  mockStatSync: ReturnType<typeof vi.fn>,
) {
  mockMkdtempSync.mockReturnValue("/tmp/voice-ollama-xxxxx");
  mockExistsSync.mockImplementation((p: unknown) => {
    const pStr = String(p);
    if (pStr === "/tmp/voice-ollama-xxxxx") return true;
    return true;
  });
  mockStatSync.mockReturnValue({ size: 12345 } as fs.Stats);
}

// ---------------------------------------------------------------------------
// F-2.1: Audio recorder
// ---------------------------------------------------------------------------

describe("voice-ollama-tui audio recorder (F-2.1)", () => {
  const mockMkdtempSync = vi.mocked(fs.mkdtempSync);
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockStatSync = vi.mocked(fs.statSync);

  beforeEach(async () => {
    vi.clearAllMocks();
    // Use fresh imports per test
    vi.resetModules();
    setupDefaultFsMocks(mockMkdtempSync, mockExistsSync, mockStatSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC-F-2.1-1: successful recording creates non-empty WAV file ──────
  it("TC-F-2.1-1: resolves with a non-empty WAV file path when ffmpeg succeeds", async () => {
    setupSpawnMock([{ kind: "success" }]);

    const { recordAudio } = await import("./audio-recorder.js");

    const result = await recordAudio({ duration: 5 });

    expect(result).toContain(".wav");
    expect(mockStatSync).toHaveBeenCalledWith(result);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("ffmpeg");
  });

  // ── TC-F-2.1-2: all recorders missing → RECORDER_NOT_FOUND ─────────
  it("TC-F-2.1-2: throws AudioRecorderError with RECORDER_NOT_FOUND when all recorders missing", async () => {
    setupSpawnMock([
      { kind: "enoent" },
      { kind: "enoent" },
      { kind: "enoent" },
    ]);

    const mod = await import("./audio-recorder.js");
    const err = await mod.recordAudio({ duration: 5 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(mod.AudioRecorderError);
    expect(err).toMatchObject({
      code: "RECORDER_NOT_FOUND",
      message: expect.stringContaining("ffmpeg"),
    });
  });

  // ── TC-F-2.1-3: abort signal terminates recording with SIGINT ──────
  it("TC-F-2.1-3: abort signal correctly terminates the process", async () => {
    // Use "pending" so the spawn doesn't resolve on its own
    setupSpawnMock([{ kind: "pending" }]);

    const mod = await import("./audio-recorder.js");

    const controller = new AbortController();

    const promise = mod.recordAudio({ duration: 10, signal: controller.signal });

    // Let the async setup complete, then abort
    await vi.waitFor(() => {
      expect(vi.mocked(spawn)).toHaveBeenCalled();
    });

    // Override existsSync so the "abort + file exists" safety net does not
    // kick in — we want to verify the error path.
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (pStr.endsWith(".wav")) return false;
      return true;
    });

    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.AudioRecorderError);
    expect(err).toMatchObject({ code: "RECORDER_ABORTED" });

    // The child's kill should have been called with SIGINT
    const child = vi.mocked(spawn).mock.results[0]?.value as MockChild | undefined;
    if (child) {
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
    }
  });

  // ── RECORDER_ABORTED safety net: file exists after abort → return path ─
  it("TC-F-2.1-4: returns output path when abort leaves a non-empty file", async () => {
    // Use "pending" so the spawn doesn't resolve on its own
    setupSpawnMock([{ kind: "pending" }]);

    const mod = await import("./audio-recorder.js");

    // Patch existsSync AND statSync so that the output .wav file appears
    // to exist with content after the abort (the safety net).
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (pStr.endsWith(".wav")) return true;
      return true;
    });
    vi.mocked(fs.statSync).mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (pStr.endsWith(".wav")) return { size: 12345 } as fs.Stats;
      return { size: 0 } as fs.Stats;
    });

    const controller = new AbortController();

    const promise = mod.recordAudio({ duration: 10, signal: controller.signal });

    // Let the async setup complete, then abort
    await vi.waitFor(() => {
      expect(vi.mocked(spawn)).toHaveBeenCalled();
    });

    controller.abort();

    const result = await promise;
    expect(result).toContain(".wav");

    // The child's kill should still have been called with SIGINT
    const child = vi.mocked(spawn).mock.results[0]?.value as MockChild | undefined;
    if (child) {
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
    }
  });

  // ── FFmpeg succeeds → returns output path ────────────────────────────
  it("resolves with output path when ffmpeg completes successfully", async () => {
    setupSpawnMock([{ kind: "success" }]);

    const { recordAudio } = await import("./audio-recorder.js");

    const result = await recordAudio({ duration: 3 });

    expect(result).toContain(".wav");
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("ffmpeg");
  });

  // ── FFmpeg failure → tries sox, if all fail → RECORDER_FAILED ─────────
  it("throws RECORDER_FAILED when all recorders exit with non-zero code", async () => {
    setupSpawnMock([
      { kind: "failCode", code: 1, stderr: "ffmpeg error" },
      { kind: "failCode", code: 2, stderr: "sox error" },
      { kind: "failCode", code: 3, stderr: "arecord error" },
    ]);

    const { recordAudio, AudioRecorderError } = await import("./audio-recorder.js");

    try {
      await recordAudio({ duration: 3 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AudioRecorderError);
      expect(err).toMatchObject({
        code: "RECORDER_FAILED",
        message: expect.stringContaining("arecord exited with code 3"),
      });
    }
  });

  // ── Output file is empty → RECORDER_FAILED ──────────────────────────
  it("throws RECORDER_FAILED when output file is empty", async () => {
    setupSpawnMock([{ kind: "success" }]);
    mockStatSync.mockReturnValue({ size: 0 } as fs.Stats);

    const { recordAudio, AudioRecorderError } = await import("./audio-recorder.js");
    const err = await recordAudio().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AudioRecorderError);
    expect(err).toMatchObject({
      code: "RECORDER_FAILED",
      message: expect.stringContaining("empty file"),
    });
  });

  // ── ffmpeg args: verify WAV 16kHz mono 16-bit ────────────────────────
  it("passes correct ffmpeg args for WAV 16kHz mono 16-bit", async () => {
    setupSpawnMock([{ kind: "success" }]);

    const { recordAudio } = await import("./audio-recorder.js");

    await recordAudio({ duration: 5, audioDevice: "default" });

    const callArgs = vi.mocked(spawn).mock.calls[0];
    expect(callArgs[0]).toBe("ffmpeg");
    const args = callArgs[1] as string[];

    expect(args).toContain("-acodec");
    const codecIdx = args.indexOf("-acodec");
    expect(args[codecIdx + 1]).toBe("pcm_s16le");

    expect(args).toContain("-ac");
    const acIdx = args.indexOf("-ac");
    expect(args[acIdx + 1]).toBe("1");

    expect(args).toContain("-ar");
    const arIdx = args.indexOf("-ar");
    expect(args[arIdx + 1]).toBe("16000");

    expect(args).toContain("-t");
    const tIdx = args.indexOf("-t");
    expect(args[tIdx + 1]).toBe("5");

    const outputPath = args[args.length - 1];
    expect(outputPath).toContain(".wav");
  });

  // ── AbortSignal already aborted before start ─────────────────────────
  it("handles already-aborted signal before spawning", async () => {
    const { recordAudio } = await import("./audio-recorder.js");

    const controller = new AbortController();
    controller.abort();

    const err = await recordAudio({ signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "RECORDER_ABORTED",
      message: expect.stringContaining("aborted before starting"),
    });

    // spawn should NOT have been called
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F-2.3: Fallback recorder tests
// ---------------------------------------------------------------------------

describe("voice-ollama-tui audio recorder fallback (F-2.3)", () => {
  const mockMkdtempSync = vi.mocked(fs.mkdtempSync);
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockStatSync = vi.mocked(fs.statSync);

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    setupDefaultFsMocks(mockMkdtempSync, mockExistsSync, mockStatSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC-F-2.3-1: ffmpeg missing, sox available → success ──────────────
  it("TC-F-2.3-1: falls back to sox when ffmpeg is not found", async () => {
    setupSpawnMock([
      { kind: "enoent" },
      { kind: "success" },
    ]);

    const { recordAudio } = await import("./audio-recorder.js");

    const result = await recordAudio({ duration: 5 });

    expect(result).toContain(".wav");

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls[0][0]).toBe("ffmpeg");
    expect(calls[1][0]).toBe("sox");
  });

  // ── TC-F-2.3-2: ffmpeg + sox missing, arecord available (Linux) ──
  it("TC-F-2.3-2: falls back to arecord when ffmpeg and sox are not found", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      setupSpawnMock([
        { kind: "enoent" },
        { kind: "enoent" },
        { kind: "success" },
      ]);

      const { recordAudio } = await import("./audio-recorder.js");

      const result = await recordAudio({ duration: 5 });

      expect(result).toContain(".wav");

      const calls = vi.mocked(spawn).mock.calls;
      expect(calls[0][0]).toBe("ffmpeg");
      expect(calls[1][0]).toBe("sox");
      expect(calls[2][0]).toBe("arecord");
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  // ── skips arecord on non-Linux, falls to RECORDER_NOT_FOUND ───────────
  it("skips arecord on non-Linux, falls through to RECORDER_NOT_FOUND if sox also missing", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      setupSpawnMock([
        { kind: "enoent" },
        { kind: "enoent" },
        // arecord is skipped on darwin (buildArgs returns null)
      ]);

      const { recordAudio, AudioRecorderError } = await import("./audio-recorder.js");
      const err = await recordAudio({ duration: 5 }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AudioRecorderError);
      expect(err).toMatchObject({
        code: "RECORDER_NOT_FOUND",
        message: expect.stringContaining("ffmpeg"),
      });
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  // ── ffmpeg fails, sox succeeds → fallback works ─────────────────────
  it("falls back to sox when ffmpeg exits with non-zero code", async () => {
    setupSpawnMock([
      { kind: "failCode", code: 1, stderr: "ffmpeg: Invalid argument" },
      { kind: "success" },
    ]);

    const { recordAudio } = await import("./audio-recorder.js");

    const result = await recordAudio();
    expect(result).toContain(".wav");

    // ffmpeg was tried, sox was used
    const calls = vi.mocked(spawn).mock.calls;
    expect(calls[0][0]).toBe("ffmpeg");
    expect(calls[1][0]).toBe("sox");
    expect(calls).toHaveLength(2);
  });

  // ── All recorders found but fail → final RECORDER_FAILED ─────────────
  it("throws RECORDER_FAILED when all recorders are found but exit with error", async () => {
    setupSpawnMock([
      { kind: "failCode", code: 1, stderr: "ffmpeg error" },
      { kind: "failCode", code: 2, stderr: "sox error" },
      { kind: "failCode", code: 2, stderr: "arecord error" },
    ]);

    const { recordAudio, AudioRecorderError } = await import("./audio-recorder.js");
    const err = await recordAudio().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AudioRecorderError);
    expect(err).toMatchObject({
      code: "RECORDER_FAILED",
      message: expect.stringContaining("arecord exited with code 2"),
    });

    // All three were called
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
  });

  // ── sox args check ─────────────────────────────────────────────────
  it("uses sox args correctly on fallback", async () => {
    setupSpawnMock([
      { kind: "enoent" },
      { kind: "success" },
    ]);

    const { recordAudio } = await import("./audio-recorder.js");

    await recordAudio({ duration: 3 });

    const soxCall = vi.mocked(spawn).mock.calls[1];
    expect(soxCall[0]).toBe("sox");
    const soxArgs = soxCall[1] as string[];

    expect(soxArgs).toContain("-d");
    expect(soxArgs).toContain("-t");
    expect(soxArgs[soxArgs.indexOf("-t") + 1]).toBe("wav");
    expect(soxArgs).toContain("trim");
  });

  // ── arecord args on Linux ──────────────────────────────────────────
  it("passes correct arecord args on Linux", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      setupSpawnMock([
        { kind: "enoent" },
        { kind: "enoent" },
        { kind: "success" },
      ]);

      const { recordAudio } = await import("./audio-recorder.js");

      await recordAudio({ duration: 5 });

      const arecordCall = vi.mocked(spawn).mock.calls[2];
      expect(arecordCall[0]).toBe("arecord");
      const arecordArgs = arecordCall[1] as string[];

      expect(arecordArgs).toContain("-r");
      expect(arecordArgs[arecordArgs.indexOf("-r") + 1]).toBe("16000");
      expect(arecordArgs).toContain("-c");
      expect(arecordArgs[arecordArgs.indexOf("-c") + 1]).toBe("1");
      expect(arecordArgs).toContain("-f");
      expect(arecordArgs[arecordArgs.indexOf("-f") + 1]).toBe("S16_LE");
      expect(arecordArgs).toContain("-t");
      expect(arecordArgs[arecordArgs.indexOf("-t") + 1]).toBe("wav");
      expect(arecordArgs).toContain("--duration");
      expect(arecordArgs[arecordArgs.indexOf("--duration") + 1]).toBe("5");
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  // ── arecord with audioDevice ────────────────────────────────────────
  it("passes audioDevice to arecord as -D flag", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      setupSpawnMock([
        { kind: "enoent" },
        { kind: "enoent" },
        { kind: "success" },
      ]);

      const { recordAudio } = await import("./audio-recorder.js");

      await recordAudio({ duration: 3, audioDevice: "hw:0,0" });

      const arecordCall = vi.mocked(spawn).mock.calls[2];
      const arecordArgs = arecordCall[1] as string[];

      expect(arecordArgs).toContain("-D");
      expect(arecordArgs[arecordArgs.indexOf("-D") + 1]).toBe("hw:0,0");
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  // ── ffmpeg succeeds (no fallback needed) ─────────────────────────────
  it("does not try sox or arecord when ffmpeg succeeds", async () => {
    setupSpawnMock([{ kind: "success" }]);

    const { recordAudio } = await import("./audio-recorder.js");

    await recordAudio();

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("ffmpeg");
  });
});
