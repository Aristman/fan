/**
 * Tests for voice-ollama-tui audio recorder (F-2.1)
 *
 * Roadmap test cases:
 *   TC-F-2.1-2: When ffmpeg is missing, throws AudioRecorderError with RECORDER_NOT_FOUND
 *   TC-F-2.1-3: Abort signal correctly terminates the process
 *
 * Strategy:
 *   Mock child_process.spawn to control ffmpeg behaviour.
 *   Mock fs operations where needed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
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

  // Track handlers registered via .on()
  mockOn.mockImplementation((event: string, handler: Function) => {
    if (!store.on.has(event)) {
      store.on.set(event, []);
    }
    store.on.get(event)!.push(handler);
  });

  // Track data handlers on stderr
  mockStderrOn.mockImplementation((event: string, handler: Function) => {
    if (event === "data") {
      store.stderrData.push(handler);
    }
  });

  // Track data handlers on stdout
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

function triggerStdoutData(child: MockChild, data: string): void {
  const store = handlerStore.get(child);
  if (!store) return;
  for (const handler of store.stdoutData) {
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
// F-2.1: Audio recorder
// ---------------------------------------------------------------------------

describe("voice-ollama-tui audio recorder (F-2.1)", () => {
  const mockSpawn = vi.mocked(spawn);
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockMkdirSync = vi.mocked(fs.mkdirSync);
  const mockMkdtempSync = vi.mocked(fs.mkdtempSync);
  const mockStatSync = vi.mocked(fs.statSync);
  const mockRmSync = vi.mocked(fs.rmSync);
  const mockUnlinkSync = vi.mocked(fs.unlinkSync);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default mocks for fs operations
    mockMkdtempSync.mockReturnValue("/tmp/voice-ollama-xxxxx");
    mockExistsSync.mockImplementation((p: unknown) => {
      const pStr = String(p);
      // /tmp/voice-ollama-xxxxx created by mkdtempSync
      if (pStr === "/tmp/voice-ollama-xxxxx") return true;
      return false;
    });
    mockStatSync.mockReturnValue({ size: 12345 } as fs.Stats);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC-F-2.1-1: successful recording creates non-empty WAV file ──────
  it("TC-F-2.1-1: resolves with a non-empty WAV file path when ffmpeg succeeds", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 12345 } as fs.Stats);

    const { recordAudio } = await import("./audio-recorder.js");

    const promise = recordAudio({ duration: 5 });
    triggerEvent(child, "close", 0);

    const result = await promise;

    expect(result).toContain(".wav");
    expect(mockStatSync).toHaveBeenCalledWith(result);
  });

  // ── TC-F-2.1-2: ffmpeg missing → RECORDER_NOT_FOUND ─────────────────
  it("TC-F-2.1-2: throws AudioRecorderError with RECORDER_NOT_FOUND when ffmpeg is missing", async () => {
    const child = createMockChild();
    mockSpawn.mockImplementationOnce(() => {
      // Simulate ENOENT error (ffmpeg not found)
      const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      // Trigger the 'error' event
      setTimeout(() => {
        triggerEvent(child, "error", err);
      }, 0);
      return child as any;
    });

    const { recordAudio, AudioRecorderError } = await import(
      "./audio-recorder.js"
    );

    const promise = recordAudio({ duration: 5 });

    await expect(promise).rejects.toThrow(AudioRecorderError);

    expect(mockSpawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining([expect.any(String)]),
      expect.any(Object),
    );
  });

  it("TC-F-2.1-2: error has code RECORDER_NOT_FOUND and mentions ffmpeg", async () => {
    const child = createMockChild();
    mockSpawn.mockImplementationOnce(() => {
      const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      setTimeout(() => {
        triggerEvent(child, "error", err);
      }, 0);
      return child as any;
    });

    const { recordAudio } = await import("./audio-recorder.js");

    let caught: any;
    try {
      await recordAudio({ duration: 5 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught).toMatchObject({
      code: "RECORDER_NOT_FOUND",
      message: expect.stringContaining("ffmpeg"),
    });
  });

  // ── TC-F-2.1-3: abort signal terminates recording ───────────────────
  it("TC-F-2.1-3: abort signal correctly terminates the process", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 } as fs.Stats); // Will be overwritten on resolve

    const { recordAudio, AudioRecorderError } = await import(
      "./audio-recorder.js"
    );

    const controller = new AbortController();

    // Start recording, then abort after a tick
    const promise = recordAudio({ duration: 10, signal: controller.signal });

    controller.abort();

    // Wait for the promise to settle
    await expect(promise).rejects.toThrow(AudioRecorderError);
    await expect(promise).rejects.toMatchObject({
      code: "RECORDER_ABORTED",
    });

    // Verify the child process was killed
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── FFmpeg succeeds → returns output path ────────────────────────────
  it("resolves with output path when ffmpeg completes successfully", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 12345 } as fs.Stats);

    const { recordAudio } = await import("./audio-recorder.js");

    const promise = recordAudio({ duration: 3 });

    // Simulate ffmpeg success (exit code 0)
    triggerEvent(child, "close", 0);

    const result = await promise;

    expect(result).toContain(".wav");
    expect(mockSpawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.any(Array),
      expect.any(Object),
    );
  });

  // ── FFmpeg failure → RECORDER_FAILED ─────────────────────────────────
  it("throws RECORDER_FAILED when ffmpeg exits with non-zero code", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { recordAudio, AudioRecorderError } = await import(
      "./audio-recorder.js"
    );

    const promise = recordAudio({ duration: 3 });

    // Simulate stderr output
    triggerStderrData(child, "ffmpeg error: invalid audio device");

    // Simulate ffmpeg failure
    triggerEvent(child, "close", 1);

    await expect(promise).rejects.toThrow(AudioRecorderError);
    await expect(promise).rejects.toMatchObject({
      code: "RECORDER_FAILED",
      message: expect.stringContaining("ffmpeg exited with code 1"),
    });
  });

  // ── Output file is empty → RECORDER_FAILED ──────────────────────────
  it("throws RECORDER_FAILED when output file is empty", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);
    mockStatSync.mockReturnValue({ size: 0 } as fs.Stats);

    const { recordAudio, AudioRecorderError } = await import(
      "./audio-recorder.js"
    );

    const promise = recordAudio();

    triggerEvent(child, "close", 0);

    await expect(promise).rejects.toThrow(AudioRecorderError);
    await expect(promise).rejects.toMatchObject({
      code: "RECORDER_FAILED",
      message: expect.stringContaining("empty file"),
    });
  });

  // ── ffmpeg args: verify WAV 16kHz mono 16-bit ────────────────────────
  it("passes correct ffmpeg args for WAV 16kHz mono 16-bit", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);
    mockStatSync.mockReturnValue({ size: 12345 } as fs.Stats);

    const { recordAudio } = await import("./audio-recorder.js");

    const promise = recordAudio({ duration: 5, audioDevice: "default" });

    triggerEvent(child, "close", 0);

    await promise;

    const callArgs = mockSpawn.mock.calls[0];
    expect(callArgs[0]).toBe("ffmpeg");
    const args = callArgs[1] as string[];

    // Check audio format flags
    expect(args).toContain("-acodec");
    const codecIdx = args.indexOf("-acodec");
    expect(args[codecIdx + 1]).toBe("pcm_s16le");

    expect(args).toContain("-ac");
    const acIdx = args.indexOf("-ac");
    expect(args[acIdx + 1]).toBe("1");

    expect(args).toContain("-ar");
    const arIdx = args.indexOf("-ar");
    expect(args[arIdx + 1]).toBe("16000");

    // Check duration flag
    expect(args).toContain("-t");
    const tIdx = args.indexOf("-t");
    expect(args[tIdx + 1]).toBe("5");

    // Check output path ends with .wav
    const outputPath = args[args.length - 1];
    expect(outputPath).toContain(".wav");
  });

  // ── Supports audioDevice parameter ────────────────────────────────────
  it("passes audioDevice to ffmpeg arguments", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);
    mockStatSync.mockReturnValue({ size: 12345 } as fs.Stats);

    const { recordAudio } = await import("./audio-recorder.js");

    const promise = recordAudio({ audioDevice: "2" });

    triggerEvent(child, "close", 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];

    // For macOS the device arg would be :2 with avfoundation
    // We just check the device value appears somewhere in the args
    expect(args.some((a) => a.includes("2"))).toBe(true);
  });

  // ── AbortSignal already aborted before start ─────────────────────────
  it("handles already-aborted signal before spawning", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { recordAudio, AudioRecorderError } = await import(
      "./audio-recorder.js"
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      recordAudio({ signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "RECORDER_ABORTED",
      message: expect.stringContaining("aborted before starting"),
    });
  });
});
