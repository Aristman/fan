/**
 * Tests for voice-ollama-tui editor-utils module (F-3.3)
 *
 * Roadmap test cases:
 *   TC-F-3.3-1: setEditorText called with recognised text.
 *   TC-F-3.3-2: If editor not empty, text appended with a space.
 *   TC-F-3.3-3: Empty recognised text shows a notification.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// F-3.3: editor-utils tests
// ---------------------------------------------------------------------------

describe("voice-ollama-tui editor-utils (F-3.3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ── TC-F-3.3-1: setEditorText called with recognised text ────────────
  it("TC-F-3.3-1: calls setEditorText with recognised text", async () => {
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const getEditorText = vi.fn().mockReturnValue("");

    const mockCtx = {
      ui: { notify, setEditorText, getEditorText },
      hasUI: true,
    } as any;

    const { insertTranscript } = await import("./editor-utils.js");

    insertTranscript(mockCtx, "привет мир");

    expect(setEditorText).toHaveBeenCalledTimes(1);
    expect(setEditorText).toHaveBeenCalledWith("привет мир");
    // notify should NOT be called for non-empty text
    expect(notify).not.toHaveBeenCalled();
  });

  // ── TC-F-3.3-2: text appended with space when editor not empty ────────
  it("TC-F-3.3-2: appends text with a space when editor is not empty", async () => {
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const getEditorText = vi.fn().mockReturnValue("Hello");

    const mockCtx = {
      ui: { notify, setEditorText, getEditorText },
      hasUI: true,
    } as any;

    const { insertTranscript } = await import("./editor-utils.js");

    insertTranscript(mockCtx, "мир");

    expect(setEditorText).toHaveBeenCalledTimes(1);
    expect(setEditorText).toHaveBeenCalledWith("Hello мир");
    expect(notify).not.toHaveBeenCalled();
  });

  // ── TC-F-3.3-3: empty text shows warning, no setEditorText ───────────
  it("TC-F-3.3-3: empty recognised text shows notification and does not call setEditorText", async () => {
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const getEditorText = vi.fn();

    const mockCtx = {
      ui: { notify, setEditorText, getEditorText },
      hasUI: true,
    } as any;

    const { insertTranscript } = await import("./editor-utils.js");

    insertTranscript(mockCtx, "");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Ничего не распознано", "warning");
    expect(setEditorText).not.toHaveBeenCalled();
    expect(getEditorText).not.toHaveBeenCalled();
  });

  // ── whitespace-only text also triggers the notification ───────────────
  it("shows notification for whitespace-only text", async () => {
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const getEditorText = vi.fn();

    const mockCtx = {
      ui: { notify, setEditorText, getEditorText },
      hasUI: true,
    } as any;

    const { insertTranscript } = await import("./editor-utils.js");

    insertTranscript(mockCtx, "   ");

    expect(notify).toHaveBeenCalledWith("Ничего не распознано", "warning");
    expect(setEditorText).not.toHaveBeenCalled();
  });

  // ── insertTranscript trims whitespace from recognised text ────────────
  it("trims whitespace from recognised text", async () => {
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const getEditorText = vi.fn().mockReturnValue("");

    const mockCtx = {
      ui: { notify, setEditorText, getEditorText },
      hasUI: true,
    } as any;

    const { insertTranscript } = await import("./editor-utils.js");

    insertTranscript(mockCtx, "  привет мир  ");

    expect(setEditorText).toHaveBeenCalledWith("привет мир");
    expect(notify).not.toHaveBeenCalled();
  });
});
