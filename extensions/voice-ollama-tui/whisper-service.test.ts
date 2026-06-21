/**
 * Tests for whisper-service.ts (F-3.1)
 *
 * Roadmap test cases:
 *   TC-F-3.1-1: For a test WAV file, returns non-empty text.
 *   TC-F-3.1-2: When whisper-cli is missing, throws WhisperError with WHISPER_NOT_FOUND.
 *   TC-F-3.1-3: Invalid model path throws WhisperError with WHISPER_MODEL_NOT_FOUND.
 *
 * Strategy:
 *   Mock child_process.spawn to control whisper-cli behaviour.
 *   Mock fs.existsSync to control file existence checks.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock helpers
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

function triggerStdoutData(child: MockChild, data: string): void {
  const store = handlerStore.get(child);
  if (!store) return;
  for (const handler of store.stdoutData) {
    handler(Buffer.from(data, "utf-8"));
  }
}

function triggerStderrData(child: MockChild, data: string): void {
  const store = handlerStore.get(child);
  if (!store) return;
  for (const handler of store.stderrData) {
    handler(Buffer.from(data, "utf-8"));
  }
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  return {
    default: {
      ...actual,
      existsSync: vi.fn(),
    },
    existsSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-ollama-tui whisper service (F-3.1)", () => {
  const mockSpawn = vi.mocked(spawn);
  const mockExistsSync = vi.mocked(fs.existsSync);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // By default: audio file exists, model file exists
    mockExistsSync.mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (pStr === "/tmp/test-recording.wav") return true;
      if (pStr === "/home/user/.fan/models/speech/ggml-base.bin") return true;
      return false;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── TC-F-3.1-1: Successful transcription returns non-empty text ──────
  it("TC-F-3.1-1: returns non-empty text for a valid WAV file", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
      language: "ru",
    });

    // Simulate whisper-cli output
    triggerStdoutData(child, "Привет мир, это тест распознавания речи.\n");
    triggerEvent(child, "close", 0);

    const result = await promise;

    expect(result).toBe("Привет мир, это тест распознавания речи.");
    expect(result.length).toBeGreaterThan(0);
  });

  // ── Verifies spawn is called with correct flags ──────────────────────
  it("calls whisper-cli with -m, -l, -f, -nt flags", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
      language: "ru",
    });

    triggerStdoutData(child, "hello world\n");
    triggerEvent(child, "close", 0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "whisper-cli",
      expect.arrayContaining(["-m", "-l", "-f", "-nt"]),
      expect.any(Object),
    );

    const args = mockSpawn.mock.calls[0][1] as string[];

    // Check -m <model>
    const mIdx = args.indexOf("-m");
    expect(args[mIdx + 1]).toBe("/home/user/.fan/models/speech/ggml-base.bin");

    // Check -l <lang>
    const lIdx = args.indexOf("-l");
    expect(args[lIdx + 1]).toBe("ru");

    // Check -f <audio>
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("/tmp/test-recording.wav");

    // Check -nt is present
    expect(args).toContain("-nt");
  });

  // ── Default language is "auto" ───────────────────────────────────────
  it("uses 'auto' as default language when not specified", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    });

    triggerStdoutData(child, "some text\n");
    triggerEvent(child, "close", 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    const lIdx = args.indexOf("-l");
    expect(args[lIdx + 1]).toBe("auto");
  });

  // ── LOW-02: custom whisperFlags override defaults ────────────────────
  it("uses custom whisperFlags when provided", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const customFlags = ["--model", "/custom/model.bin", "--file", "/tmp/audio.wav", "--no-timestamps"];

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
      whisperFlags: customFlags,
    });

    triggerStdoutData(child, "hello\n");
    triggerEvent(child, "close", 0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "whisper-cli",
      customFlags,
      expect.any(Object),
    );
  });

  // ── Custom binPath is passed to spawn ────────────────────────────────
  it("uses custom binPath when provided", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
      binPath: "/usr/local/bin/whisper-cli",
    });

    triggerStdoutData(child, "hello\n");
    triggerEvent(child, "close", 0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/local/bin/whisper-cli",
      expect.any(Array),
      expect.any(Object),
    );
  });

  // ── TC-F-3.1-2: whisper-cli not found → WHISPER_NOT_FOUND ───────────
  it("TC-F-3.1-2: throws WhisperError with WHISPER_NOT_FOUND when whisper-cli is missing", async () => {
    const child = createMockChild();
    mockSpawn.mockImplementationOnce(() => {
      const err = new Error("spawn whisper-cli ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      setTimeout(() => {
        triggerEvent(child, "error", err);
      }, 0);
      return child as any;
    });

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    });

    await expect(promise).rejects.toMatchObject({
      name: "WhisperError",
      code: "WHISPER_NOT_FOUND",
    });
  });

  // ── TC-F-3.1-2: Error message mentions whisper-cli ──────────────────
  it("TC-F-3.1-2: error message mentions whisper-cli and installation", async () => {
    const child = createMockChild();
    mockSpawn.mockImplementationOnce(() => {
      const err = new Error("spawn whisper-cli ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      setTimeout(() => {
        triggerEvent(child, "error", err);
      }, 0);
      return child as any;
    });

    const { transcribe } = await import("./whisper-service.js");

    let caught: any;
    try {
      await transcribe("/tmp/test-recording.wav", {
        modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/whisper-cli/i);
  });

  // ── TC-F-3.1-3: Invalid model path → WHISPER_MODEL_NOT_FOUND ────────
  it("TC-F-3.1-3: throws WhisperError with WHISPER_MODEL_NOT_FOUND for nonexistent model", async () => {
    // Model file doesn't exist
    mockExistsSync.mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (pStr === "/tmp/test-recording.wav") return true;
      if (pStr === "/nonexistent/path/model.bin") return false;
      return false;
    });

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/nonexistent/path/model.bin",
    });

    await expect(promise).rejects.toMatchObject({
      name: "WhisperError",
      code: "WHISPER_MODEL_NOT_FOUND",
    });
  });

  // ── Audio file not found → WHISPER_FAILED ────────────────────────────
  it("throws WHISPER_FAILED when audio file does not exist", async () => {
    mockExistsSync.mockImplementation(() => false);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/nonexistent/audio.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    });

    await expect(promise).rejects.toMatchObject({
      name: "WhisperError",
      code: "WHISPER_FAILED",
      message: expect.stringContaining("Audio file not found"),
    });

    // spawn should not have been called
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  // ── whisper-cli exits with non-zero → WHISPER_FAILED ─────────────────
  it("throws WHISPER_FAILED when whisper-cli exits with non-zero code", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    });

    triggerStderrData(child, "error: failed to process audio");
    triggerEvent(child, "close", 1);

    await expect(promise).rejects.toMatchObject({
      name: "WhisperError",
      code: "WHISPER_FAILED",
      message: expect.stringContaining("exited with code 1"),
    });
  });

  // ── whisper-cli returns stdout with leading/trailing whitespace ─────
  it("trims stdout result", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    });

    triggerStdoutData(child, "  \n  hello world  \n  ");
    triggerEvent(child, "close", 0);

    const result = await promise;
    expect(result).toBe("hello world");
  });

  // ── Spawn error (non-ENOENT) → WHISPER_FAILED ────────────────────────
  it("throws WHISPER_FAILED on non-ENOENT spawn error", async () => {
    const child = createMockChild();
    mockSpawn.mockImplementationOnce(() => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      setTimeout(() => {
        triggerEvent(child, "error", err);
      }, 0);
      return child as any;
    });

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    });

    await expect(promise).rejects.toMatchObject({
      name: "WhisperError",
      code: "WHISPER_FAILED",
    });
  });

  // ── fs.existsSync throws → WHISPER_MODEL_NOT_FOUND ──────────────────
  it("handles fs.existsSync errors for model path gracefully", async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const pStr = String(p);
      if (pStr === "/tmp/test-recording.wav") return true;
      throw new Error("permission denied");
    });

    const { transcribe } = await import("./whisper-service.js");

    const promise = transcribe("/tmp/test-recording.wav", {
      modelPath: "/restricted/model.bin",
    });

    await expect(promise).rejects.toMatchObject({
      name: "WhisperError",
      code: "WHISPER_MODEL_NOT_FOUND",
    });
  });
});
