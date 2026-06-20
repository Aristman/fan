/**
 * Tests for voice-ollama-tui ui-overlay module (F-2.2)
 *
 * Roadmap test cases:
 *   TC-F-2.2-1: Overlay displays "Recording..." after /voice.
 *   TC-F-2.2-2: Enter finishes recording → accepted=true.
 *   TC-F-2.2-3: Escape cancels recording → accepted=false.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Constants for keyboard input simulation
//
// matchesKey(data, keyId) from @itone/fan-tui expects:
//   - data: raw terminal byte sequence
//   - keyId: string like "enter", "escape", "return"
//
// Real terminal sends:
//   - Enter: \r (0x0D) or \n (0x0A) → matchesKey(data, "enter") = true
//   - Escape: \x1b (0x1B)         → matchesKey(data, "escape") = true
// ---------------------------------------------------------------------------

const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

// ANSI color helper for the mock theme
function ansi(code: number, s: string): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const ansiFg = (code: number) => (s: string) => ansi(code, s);

// Mock theme that produces realistic ANSI escape codes
const mockTheme = {
  fg: (color: string, s: string) => {
    const codes: Record<string, number> = {
      accent: 36,   // cyan
      dim: 2,       // dim
      error: 31,    // red
      border: 90,   // bright black
    };
    return ansi(codes[color] ?? 0, s);
  },
  bold: (s: string) => ansi(1, s),
  dim: (s: string) => ansi(2, s),
  error: (s: string) => ansi(31, s),
};

// Helper to strip ANSI codes for content inspection
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockComponent {
  handleInput?: (data: string) => void;
  render?: (width: number) => string[];
  invalidate?: () => void;
  dispose?: () => void;
}

function createMockCustom() {
  const callHistory: Array<{
    component: MockComponent;
    options: unknown;
    resolve: (value: unknown) => void;
  }> = [];

  const mockRequestRender = vi.fn();

  const mock = vi.fn().mockImplementation(
    <T>(
      factory: (
        tui: unknown,
        theme: unknown,
        kb: unknown,
        done: (result: T) => void,
      ) => MockComponent,
      options?: { overlay?: boolean },
    ) => {
      return new Promise<T>((resolve) => {
        const done = (result: T) => {
          resolve(result);
        };

        const component = factory(
          { requestRender: mockRequestRender },
          mockTheme,
          {},
          done,
        );

        callHistory.push({
          component,
          options,
          resolve: resolve as (value: unknown) => void,
        });
      });
    },
  );

  return {
    mock,
    getLastCall: () => {
      const last = callHistory[callHistory.length - 1];
      return last
        ? {
            component: last.component,
            options: last.options,
            resolve: last.resolve,
          }
        : null;
    },
    clear: () => {
      callHistory.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// F-2.2: UI overlay tests
// ---------------------------------------------------------------------------

describe("voice-ollama-tui ui-overlay (F-2.2)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── TC-F-2.2-1: Overlay displays "Recording..." after /voice ──────────
  it("TC-F-2.2-1: recording overlay calls ctx.ui.custom and renders Recording...", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 10 });

    // Verify that ctx.ui.custom was called
    expect(customMock.mock).toHaveBeenCalledTimes(1);

    // Get the component that was created
    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // Render at a reasonable width
    const rendered = component.render!(40);
    const fullText = stripAnsi(rendered.join("\n"));

    // Should contain recording-related status
    expect(fullText).toContain("Recording");
    expect(fullText).toContain("🎙");

    // Should contain instructions
    expect(fullText).toContain("Enter");
    expect(fullText).toContain("Esc");

    // Should contain a timer (00:10)
    expect(fullText).toContain("00:10");

    // Cancel so the promise resolves
    component.handleInput!(KEY_ESCAPE);

    const result = await promise;
    expect(result.accepted).toBe(false);
  });

  // ── TC-F-2.2-2: Enter finishes recording → accepted=true ──────────
  it("TC-F-2.2-2: pressing Enter finishes recording with accepted=true", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 10 });

    // Get the component
    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // Simulate Enter press (keyboard data for Enter is \r)
    component.handleInput!(KEY_ENTER);

    const result = await promise;
    expect(result.accepted).toBe(true);
  });

  // ── TC-F-2.2-3: Escape cancels recording → accepted=false ────────────
  it("TC-F-2.2-3: pressing Escape cancels recording with accepted=false", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 10 });

    // Get the component
    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // Simulate Escape press (keyboard data for Escape is \x1b)
    component.handleInput!(KEY_ESCAPE);

    const result = await promise;
    expect(result.accepted).toBe(false);
  });

  // ── Timer auto-stops recording with accepted=true ─────────────────────
  it("auto-finishes with accepted=true when timer reaches zero", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 3 });

    // Advance time by 3 seconds (timer ticks every 1s)
    vi.advanceTimersByTime(3000);

    // The overlay should have auto-closed
    const result = await promise;
    expect(result.accepted).toBe(true);
  });

  // ── Timer display updates each second ─────────────────────────────────
  it("timer countdown updates each second", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 5 });
    const mockRequestRender = customMock.mock.mock.results[0]?.value;

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // Initial render should show 00:05
    let rendered = stripAnsi(component.render!(40).join("\n"));
    expect(rendered).toContain("00:05");

    // After 3 seconds, should show 00:02
    vi.advanceTimersByTime(3000);
    rendered = stripAnsi(component.render!(40).join("\n"));
    expect(rendered).toContain("00:02");

    // Cancel so the promise resolves
    component.handleInput!(KEY_ESCAPE);
    await promise;
  });

  // ── Default duration is 60 seconds ────────────────────────────────────
  it("uses default duration of 60 when none specified", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx);

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    const rendered = stripAnsi(component.render!(40).join("\n"));
    expect(rendered).toContain("01:00");

    // Cancel
    component.handleInput!(KEY_ESCAPE);
    await promise;
  });

  // ── Processing overlay: transcribing status ───────────────────────────
  it("processing overlay shows transcribing status", async () => {
    const customMock = createMockCustom();

    const mockCtx = { ui: { custom: customMock.mock }, hasUI: true } as any;

    const { showProcessingOverlay } = await import("./ui-overlay.js");

    const controller = showProcessingOverlay(mockCtx, "transcribing");

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    const rendered = stripAnsi(component.render!(40).join("\n"));
    expect(rendered).toContain("Transcribing");
    expect(rendered).toContain("🔊");

    // Controller can update status
    controller.update("ollama");
    const updated = stripAnsi(component.render!(40).join("\n"));
    expect(updated).toContain("Improving");

    // Controller close resolves the overlay
    controller.close();
  });

  // ── Processing overlay: ollama status ─────────────────────────────────
  it("processing overlay shows ollama status", async () => {
    const customMock = createMockCustom();

    const mockCtx = { ui: { custom: customMock.mock }, hasUI: true } as any;

    const { showProcessingOverlay } = await import("./ui-overlay.js");

    const controller = showProcessingOverlay(mockCtx, "ollama");

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    const rendered = stripAnsi(component.render!(40).join("\n"));
    expect(rendered).toContain("Improving");
    expect(rendered).toContain("Ollama");
    expect(rendered).toContain("🤖");

    controller.close();
  });

  // ── Processing overlay: close is idempotent ───────────────────────────
  it("processing overlay close is idempotent", async () => {
    const customMock = createMockCustom();

    const mockCtx = { ui: { custom: customMock.mock }, hasUI: true } as any;

    const { showProcessingOverlay } = await import("./ui-overlay.js");

    const controller = showProcessingOverlay(mockCtx, "transcribing");

    expect(() => {
      controller.close();
      controller.close();
    }).not.toThrow();
  });

  // ── Enter via "return" key also works ─────────────────────────────────
  it("return key also finishes recording", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 10 });

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // Simulate Enter via "\n" (newline also matches "enter")
    component.handleInput!("\n");

    const result = await promise;
    expect(result.accepted).toBe(true);
  });

  // ── Second key press after finish is ignored ──────────────────────────
  it("ignores key presses after recording is already finished", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 10 });

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // First Escape → finish with accepted=false
    component.handleInput!(KEY_ESCAPE);

    let result = await promise;
    expect(result.accepted).toBe(false);

    // After resolved, further key presses should not throw
    // (the done callback should already have been called)
    expect(() => component.handleInput!(KEY_ENTER)).not.toThrow();
  });

  // ── Render at narrow width ───────────────────────────────────────────
  it("renders at narrow width without errors", async () => {
    const customMock = createMockCustom();

    const mockCtx = {
      ui: { custom: customMock.mock },
      hasUI: true,
    } as any;

    const { showRecordingOverlay } = await import("./ui-overlay.js");

    const promise = showRecordingOverlay(mockCtx, { duration: 10 });

    const call = customMock.getLastCall();
    expect(call).not.toBeNull();
    const component = call!.component;

    // Should render at very narrow width without errors
    expect(() => component.render!(10)).not.toThrow();

    component.handleInput!(KEY_ESCAPE);
    await promise;
  });
});
