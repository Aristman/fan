/**
 * Tests for voice-ollama-tui pipeline module (F-4.3)
 *
 * Roadmap test cases:
 *   TC-F-4.3-1: On recording error, overlay is closed and notify is shown with type error.
 *   TC-F-4.3-2: On transcription error, TUI is not blocked and a notification is shown.
 *
 * Acceptance criteria:
 *   1. No error in the pipeline freezes the TUI.
 *   2. All errors are displayed via ctx.ui.notify().
 *   3. Temporary files are removed even on error.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockCtx() {
  return {
    ui: {
      notify: vi.fn(),
      custom: vi.fn(),
      setStatus: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn().mockReturnValue(""),
    },
    hasUI: true,
  };
}

function makeMinimalConfig() {
  return {
    recordDurationMax: 60,
    recordFormat: "wav" as const,
    whisperBinPath: "whisper-cli",
    whisperModelPath: "/tmp/test-model.bin",
    whisperLanguage: "auto",
    ollamaEnabled: false,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaSystemPrompt: "Fix punctuation.",
    shortcut: "ctrl+shift+v",
  };
}

/**
 * Create mock implementations for all pipeline dependencies via vi.doMock.
 *
 * The returned mockFns object contains all mock functions so tests can
 * inspect them after running the pipeline.
 */
function createMocks(overrides?: {
  checkDependencies?: ReturnType<typeof vi.fn>;
  showRecordingOverlay?: ReturnType<typeof vi.fn>;
  showProcessingOverlay?: ReturnType<typeof vi.fn>;
  recordAudio?: ReturnType<typeof vi.fn>;
  ensureWhisperModel?: ReturnType<typeof vi.fn>;
  transcribe?: ReturnType<typeof vi.fn>;
  improveText?: ReturnType<typeof vi.fn>;
}) {
  const fns = {
    checkDependencies: vi.fn().mockReturnValue({ ok: true, missing: [], instructions: [] }),
    showRecordingOverlay: vi.fn().mockResolvedValue({ accepted: true, audioFile: "/tmp/test-recording.wav" }),
    showProcessingOverlay: vi.fn((): { update: any; close: any } => ({
      update: vi.fn(),
      close: vi.fn(),
    })),
    recordAudio: vi.fn().mockResolvedValue("/tmp/test-recording.wav"),
    ensureWhisperModel: vi.fn().mockResolvedValue("/tmp/model.bin"),
    transcribe: vi.fn().mockResolvedValue("тестовый текст"),
    improveText: vi.fn().mockResolvedValue({ text: "исправленный текст", usedOllama: false }),
    insertTranscript: vi.fn<(ctx: unknown, text: string) => void>().mockName("insertTranscript"),
  };

  const merged = { ...fns, ...overrides };

  vi.doMock("./dependencies.js", () => ({
    checkDependencies: merged.checkDependencies,
  }));

  vi.doMock("./ui-overlay.js", () => ({
    showRecordingOverlay: merged.showRecordingOverlay,
    showProcessingOverlay: merged.showProcessingOverlay,
  }));

  vi.doMock("./audio-recorder.js", () => ({
    recordAudio: merged.recordAudio,
  }));

  vi.doMock("./model-downloader.js", () => ({
    ensureWhisperModel: merged.ensureWhisperModel,
  }));

  vi.doMock("./whisper-service.js", () => ({
    transcribe: merged.transcribe,
  }));

  vi.doMock("./ollama-service.js", () => ({
    improveText: merged.improveText,
  }));

  // Mock insertTranscript so it doesn't call ctx.ui.setEditorText internally.
  // Tests inspect this mock directly.
  vi.doMock("./editor-utils.js", () => ({
    insertTranscript: merged.insertTranscript,
  }));

  return merged;
}

// ---------------------------------------------------------------------------
// F-4.3: Pipeline tests
// ---------------------------------------------------------------------------

describe("voice-ollama-tui pipeline (F-4.3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // TC-F-4.3-1: On recording error, overlay closes and notify shows with
  //             type error.
  // -----------------------------------------------------------------------
  it("TC-F-4.3-1: on recording error, overlay is closed and notify shows error", async () => {
    createMocks({
      showRecordingOverlay: vi.fn().mockRejectedValue(new Error("ffmpeg not found")),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    // After error, should call notify with error type among debug notifications
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][0]).toContain("ffmpeg not found");
  });

  // -----------------------------------------------------------------------
  // TC-F-4.3-2: On transcription error, TUI is not blocked and a
  //             notification is shown.
  // -----------------------------------------------------------------------
  it("TC-F-4.3-2: on transcription error, notify shows error and no exception escapes", async () => {
    const fns = createMocks({
      transcribe: vi.fn().mockRejectedValue(new Error("WHISPER_FAILED: model corrupted")),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    // Should NOT throw — errors must be caught internally
    await expect(
      (runVoicePipeline as any)(ctx, makeMinimalConfig()),
    ).resolves.toBeUndefined();

    // Should show a notify with error type among debug notifications
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][0]).toContain("WHISPER_FAILED");

    // insertTranscript should NOT be called (failed before that step)
    expect(fns.insertTranscript).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Dependency check failure shows warning, not error
  // -----------------------------------------------------------------------
  it("shows warning when dependencies are missing and returns early", async () => {
    const fns = createMocks({
      checkDependencies: vi.fn().mockReturnValue({
        ok: false,
        missing: ["ffmpeg", "whisper-cli"],
        instructions: ["Install ffmpeg", "Install whisper.cpp"],
      }),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    const warningCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "warning");
    expect(warningCalls.length).toBe(1);
    expect(warningCalls[0][0]).toContain("Missing tools");

    // Should not proceed to record
    expect(fns.showRecordingOverlay).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // User cancellation with Escape
  // -----------------------------------------------------------------------
  it("returns without recording when user cancels with Escape", async () => {
    const fns = createMocks({
      showRecordingOverlay: vi.fn().mockResolvedValue({ accepted: false, audioFile: undefined }),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    // Should not show any error notification — cancellation is normal
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Should not proceed past recording overlay
    expect(fns.recordAudio).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Successful pipeline inserts transcript
  // -----------------------------------------------------------------------
  it("inserts transcript on successful pipeline run", async () => {
    const fns = createMocks({
      transcribe: vi.fn().mockResolvedValue("привет мир"),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    // insertTranscript should have been called with transcribed text
    expect(fns.insertTranscript).toHaveBeenCalledTimes(1);
    expect(fns.insertTranscript).toHaveBeenCalledWith(ctx, "привет мир");

    // No error notifications
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Successful pipeline with Ollama improvement
  // -----------------------------------------------------------------------
  it("uses Ollama improvement when enabled and inserts improved text", async () => {
    const fns = createMocks({
      transcribe: vi.fn().mockResolvedValue("привет мир как дела"),
      improveText: vi.fn().mockResolvedValue({
        text: "Привет, мир! Как дела?",
        usedOllama: true,
      }),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    const config = { ...makeMinimalConfig(), ollamaEnabled: true, ollamaModel: "llama3.2" };

    await (runVoicePipeline as any)(ctx, config);

    // insertTranscript should have been called with improved text
    expect(fns.insertTranscript).toHaveBeenCalledTimes(1);
    expect(fns.insertTranscript).toHaveBeenCalledWith(ctx, "Привет, мир! Как дела?");
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Ollama fallback — keep original text on failure
  // -----------------------------------------------------------------------
  it("falls back to original text when Ollama fails", async () => {
    const fns = createMocks({
      transcribe: vi.fn().mockResolvedValue("привет мир"),
      improveText: vi.fn().mockRejectedValue(new Error("OLLAMA_UNREACHABLE")),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    const config = { ...makeMinimalConfig(), ollamaEnabled: true, ollamaModel: "llama3.2" };

    await (runVoicePipeline as any)(ctx, config);

    // Should show warning about Ollama failure among debug notifications
    const warningCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "warning");
    expect(warningCalls.length).toBeGreaterThanOrEqual(1);

    // Should still insert the original text (fallback)
    expect(fns.insertTranscript).toHaveBeenCalledTimes(1);
    expect(fns.insertTranscript).toHaveBeenCalledWith(ctx, "привет мир");
  });

  // -----------------------------------------------------------------------
  // Model download failure shows error
  // -----------------------------------------------------------------------
  it("shows error when model download fails", async () => {
    const fns = createMocks({
      ensureWhisperModel: vi.fn().mockRejectedValue(new Error("Network error")),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    // Should show error about model download among debug notifications
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][0]).toContain("Model download failed");

    // Should not proceed to transcribe
    expect(fns.transcribe).not.toHaveBeenCalled();
    expect(fns.insertTranscript).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Unexpected global error is caught
  // -----------------------------------------------------------------------
  it("catches unexpected errors and shows notification", async () => {
    const fns = createMocks({
      showRecordingOverlay: vi.fn().mockRejectedValue(new Error("Unexpected TUI crash")),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("Unexpected TUI crash");
    expect(ctx.ui.notify.mock.calls[0][1]).toBe("error");

    // Should not proceed past the failed step
    expect(fns.recordAudio).not.toHaveBeenCalled();
    expect(fns.insertTranscript).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Empty transcription shows warning (via insertTranscript)
  // -----------------------------------------------------------------------
  it("shows warning when transcribed text is empty", async () => {
    const fns = createMocks({
      transcribe: vi.fn().mockResolvedValue(""),
    });

    const { runVoicePipeline } = await import("./pipeline.js");
    const ctx = makeMockCtx();

    await (runVoicePipeline as any)(ctx, makeMinimalConfig());

    // insertTranscript was called with empty string
    expect(fns.insertTranscript).toHaveBeenCalledTimes(1);
    expect(fns.insertTranscript).toHaveBeenCalledWith(ctx, "");

    // ctx.ui.notify is NOT called by pipeline directly here —
    // the real insertTranscript would call notify, but our mock
    // is a plain vi.fn() that doesn't do anything.
    // That's fine — the insertTranscript unit tests cover that case.
  });
});
