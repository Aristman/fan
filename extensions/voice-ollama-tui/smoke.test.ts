/**
 * Smoke test for voice-ollama-tui extension (index.ts default export).
 *
 * Verifies the main happy path:
 *   1. Config loads with defaults.
 *   2. /voice command is registered.
 *   3. ctrl+shift+v shortcut is registered.
 *   4. session_start / session_shutdown event handlers are registered.
 *   5. Running the /voice handler invokes the pipeline and inserts transcript.
 *
 * Uses mocks for all external dependencies (config, dependencies, pipeline).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/** Creates a minimal mock ExtensionAPI with spy functions. */
function mockAPI() {
  return {
    registerCommand: vi.fn<(name: string, opts: any) => void>(),
    registerShortcut: vi.fn<(key: string, opts: any) => void>(),
    on: vi.fn<(event: string, handler: (...args: any[]) => any) => void>(),
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
  };
}

/** Creates a minimal mock ExtensionContext with UI spies. */
function mockCtx() {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn().mockReturnValue(""),
    },
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {} as any,
    modelRegistry: {} as any,
    model: undefined,
    isIdle: vi.fn().mockReturnValue(true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
  };
}

/** Creates the default mock config object. */
function mockConfig(overrides?: Record<string, unknown>) {
  return {
    audioDevice: undefined,
    recordDurationMax: 60,
    recordFormat: "wav" as const,
    whisperBinPath: "whisper-cli",
    whisperModelPath: "/home/user/.fan/models/speech/ggml-base.bin",
    whisperLanguage: "auto",
    ollamaEnabled: false,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: undefined,
    ollamaSystemPrompt: "Fix punctuation.",
    shortcut: "ctrl+shift+v",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Smoke test
// ═══════════════════════════════════════════════════════════════════════════

describe("voice-ollama-tui smoke test", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers /voice command, shortcut, and session event handlers", async () => {
    const api = mockAPI();

    // Stub config to avoid touching the real filesystem
    vi.doMock("./config.js", () => ({
      loadConfig: vi.fn().mockReturnValue(mockConfig()),
    }));

    // Stub dependencies checker so it passes
    vi.doMock("./dependencies.js", () => ({
      checkDependencies: vi.fn().mockReturnValue({ ok: true, missing: [], instructions: [] }),
      resetDependencyCache: vi.fn(),
    }));

    // Stub pipeline to avoid real recording/transcription
    vi.doMock("./pipeline.js", () => ({
      runVoicePipeline: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import("./index.js");
    await mod.default(api as any);

    // ── Command registration ───────────────────────────────────────────
    expect(api.registerCommand).toHaveBeenCalledTimes(1);
    expect(api.registerCommand).toHaveBeenCalledWith(
      "voice",
      expect.objectContaining({
        description: expect.stringContaining("voice input"),
        handler: expect.any(Function),
      }),
    );

    // ── Shortcut registration ──────────────────────────────────────────
    expect(api.registerShortcut).toHaveBeenCalledTimes(1);
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+shift+v",
      expect.objectContaining({
        description: expect.stringContaining("voice input"),
        handler: expect.any(Function),
      }),
    );

    // ── Event handlers ──────────────────────────────────────────────────
    expect(api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("executes /voice command handler and invokes pipeline with ctx", async () => {
    const api = mockAPI();
    const runVoicePipeline = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./config.js", () => ({
      loadConfig: vi.fn().mockReturnValue(mockConfig()),
    }));

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: vi.fn().mockReturnValue({ ok: true, missing: [], instructions: [] }),
      resetDependencyCache: vi.fn(),
    }));

    vi.doMock("./pipeline.js", () => ({
      runVoicePipeline,
    }));

    const mod = await import("./index.js");
    await mod.default(api as any);

    // Extract the registered command handler and run it
    const cmdOpts = api.registerCommand.mock.calls[0][1];
    const handler = cmdOpts.handler;

    const ctx = mockCtx();
    await handler("", ctx);

    // The handler called runVoicePipeline with the extension context
    expect(runVoicePipeline).toHaveBeenCalledTimes(1);
    expect(runVoicePipeline).toHaveBeenCalledWith(ctx, mockConfig());
  });

  it("executes shortcut handler and invokes pipeline with ctx", async () => {
    const api = mockAPI();
    const runVoicePipeline = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./config.js", () => ({
      loadConfig: vi.fn().mockReturnValue(mockConfig()),
    }));

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: vi.fn().mockReturnValue({ ok: true, missing: [], instructions: [] }),
      resetDependencyCache: vi.fn(),
    }));

    vi.doMock("./pipeline.js", () => ({
      runVoicePipeline,
    }));

    const mod = await import("./index.js");
    await mod.default(api as any);

    // Extract the registered shortcut handler and run it
    const shortcutOpts = api.registerShortcut.mock.calls[0][1];
    const handler = shortcutOpts.handler;

    const ctx = mockCtx();
    await handler(ctx);

    // The handler called runVoicePipeline with the extension context
    expect(runVoicePipeline).toHaveBeenCalledTimes(1);
    expect(runVoicePipeline).toHaveBeenCalledWith(ctx, mockConfig());
  });

  it("session_start handler: sets status when dependencies are met", async () => {
    const api = mockAPI();

    vi.doMock("./config.js", () => ({
      loadConfig: vi.fn().mockReturnValue(mockConfig()),
    }));

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: vi.fn().mockReturnValue({ ok: true, missing: [], instructions: [] }),
      resetDependencyCache: vi.fn(),
    }));

    vi.doMock("./pipeline.js", () => ({
      runVoicePipeline: vi.fn(),
    }));

    const mod = await import("./index.js");
    await mod.default(api as any);

    // Extract the session_start handler
    const sessionStartHandler = api.on.mock.calls.find(
      (call: any) => call[0] === "session_start",
    )?.[1];
    expect(sessionStartHandler).toBeDefined();

    const ctx = mockCtx();
    await sessionStartHandler!({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("voice-ollama-tui", "🎙 Ready");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("session_start handler: warns when dependencies are missing", async () => {
    const api = mockAPI();

    vi.doMock("./config.js", () => ({
      loadConfig: vi.fn().mockReturnValue(mockConfig()),
    }));

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: vi.fn().mockReturnValue({
        ok: false,
        missing: ["ffmpeg", "whisper-cli"],
        instructions: ["Install ffmpeg", "Install whisper.cpp"],
      }),
      resetDependencyCache: vi.fn(),
    }));

    vi.doMock("./pipeline.js", () => ({
      runVoicePipeline: vi.fn(),
    }));

    const mod = await import("./index.js");
    await mod.default(api as any);

    const sessionStartHandler = api.on.mock.calls.find(
      (call: any) => call[0] === "session_start",
    )?.[1];
    expect(sessionStartHandler).toBeDefined();

    const ctx = mockCtx();
    await sessionStartHandler!({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Missing tools"),
      "warning",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "voice-ollama-tui",
      expect.stringContaining("Need"),
    );
  });

  it("session_shutdown handler resets dependency cache", async () => {
    const api = mockAPI();
    const resetDependencyCache = vi.fn();

    vi.doMock("./config.js", () => ({
      loadConfig: vi.fn().mockReturnValue(mockConfig()),
    }));

    vi.doMock("./dependencies.js", () => ({
      checkDependencies: vi.fn().mockReturnValue({ ok: true, missing: [], instructions: [] }),
      resetDependencyCache,
    }));

    vi.doMock("./pipeline.js", () => ({
      runVoicePipeline: vi.fn(),
    }));

    const mod = await import("./index.js");
    await mod.default(api as any);

    const shutdownHandler = api.on.mock.calls.find(
      (call: any) => call[0] === "session_shutdown",
    )?.[1];
    expect(shutdownHandler).toBeDefined();

    await shutdownHandler!({}, {} as any);

    expect(resetDependencyCache).toHaveBeenCalledTimes(1);
  });
});
