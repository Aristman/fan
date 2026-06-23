/**
 * UI overlay for voice recording and processing (F-2.2)
 *
 * Provides two overlay functions:
 *   - showRecordingOverlay(ctx, opts) — recording info with Enter/Esc, timer, auto-stop
 *   - showProcessingOverlay(ctx, status) — processing status updates, controllable via returned controller
 *
 * Roadmap TDD:
 *   TC-F-2.2-1: Overlay displays "Recording..." after /voice
 *   TC-F-2.2-2: Enter finishes recording → accepted=true
 *   TC-F-2.2-3: Escape cancels recording → accepted=false
 */

import type { ExtensionContext, Theme } from "@itone/fan-coding-agent";
import { matchesKey, type TUI, type KeybindingsManager, type Focusable } from "@itone/fan-tui";
import { recordAudio, type RecordAudioOptions } from "./audio-recorder.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordingOverlayResult {
  /** true if user pressed Enter (or auto-stopped), false if Escape */
  accepted: boolean;
  /** Path to the recorded WAV file when accepted, undefined otherwise */
  audioFile?: string;
}

export interface RecordingOverlayOptions {
  /** Maximum recording duration in seconds (auto-stop after this) */
  duration?: number;
  /** Optional audio device string passed to the recorder */
  audioDevice?: string;
  /** Optional AbortSignal to cancel recording in progress */
  signal?: AbortSignal;
}

export type ProcessingStatus = "transcribing" | "ollama" | "done";

export interface ProcessingOverlayController {
  /** Update the displayed status (e.g. transcribing → ollama → done) */
  update(status: ProcessingStatus): void;
  /** Close the overlay */
  close(): void;
  /** Whether the user aborted via Escape */
  wasAborted: boolean;
}

// ---------------------------------------------------------------------------
// Recording overlay
// ---------------------------------------------------------------------------

/**
 * Show a recording overlay with timer and Enter/Esc handling.
 *
 * Recording starts immediately when the overlay opens. The overlay displays
 * an animated activity indicator, a countdown timer, and a live progress bar.
 * Press Enter to stop and save, Esc to cancel.
 *
 * @param ctx - Extension context with UI access
 * @param opts - Duration, audio device, abort signal
 * @returns Promise with `{ accepted, audioFile }` — audioFile is set when accepted
 */
export async function showRecordingOverlay(
  ctx: ExtensionContext,
  opts: RecordingOverlayOptions = {},
): Promise<RecordingOverlayResult> {
  const maxDuration = opts.duration ?? 60;

  return ctx.ui.custom<RecordingOverlayResult>(
    (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (result: RecordingOverlayResult) => void) => {
      const component = new RecordingOverlayComponent(
        theme,
        tui,
        maxDuration,
        done,
        { audioDevice: opts.audioDevice, signal: opts.signal },
        ctx.ui.notify,
      );
      return component;
    },
    {
      overlay: true,
      onHandle: (handle) => {
        // Ensure the overlay has focus so it receives keyboard input.
        handle.focus();
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Processing overlay
// ---------------------------------------------------------------------------

/**
 * Show a processing overlay with a status message.
 *
 * The overlay remains open until {@link ProcessingOverlayController.close} is called.
 * Use the returned controller to update the status text in-place:
 *
 *   const overlay = showProcessingOverlay(ctx, "transcribing");
 *   // ... do work ...
 *   overlay.update("ollama");
 *   // ... do work ...
 *   overlay.close();
 *
 * @param ctx - Extension context with UI access
 * @param status - Initial processing step
 * @returns Controller to update or close the overlay
 */
export function showProcessingOverlay(
  ctx: ExtensionContext,
  status: ProcessingStatus,
  options?: { signal?: AbortSignal },
): ProcessingOverlayController {
  let component: ProcessingOverlayComponent | undefined;

  const abortSignal = options?.signal;
  const abortController = new AbortController();

  // If an external signal is provided, forward aborts to our local controller
  if (abortSignal) {
    if (abortSignal.aborted) {
      abortController.abort();
    } else {
      const onExternalAbort = () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };
      abortSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const promise = ctx.ui.custom<void>(
    (_tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (result: void) => void) => {
      component = new ProcessingOverlayComponent(theme, status, done, () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });
      return component;
    },
    { overlay: true },
  );

  // Prevent unhandled rejection if the overlay is closed normally.
  promise.catch(() => undefined);

  return {
    update(nextStatus: ProcessingStatus) {
      component?.update(nextStatus);
    },
    close() {
      component?.close();
    },
    get wasAborted(): boolean {
      return component?.wasAborted ?? false;
    },
  };
}

// ---------------------------------------------------------------------------
// Component: RecordingOverlayComponent
// ---------------------------------------------------------------------------

class RecordingOverlayComponent implements Focusable {
  public focused = false;
  public wantsKeyRelease = false;
  private remaining: number;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private pulseTick = 0;
  private recordingPromise: Promise<string | undefined> | null = null;
  private localAbortController = new AbortController();
  private externalAbortCleanup: (() => void) | undefined;

  constructor(
    private theme: Theme,
    private tui: TUI,
    private maxDuration: number,
    private done: (result: RecordingOverlayResult) => void,
    private recorderOpts: { audioDevice?: string; signal?: AbortSignal },
    private notify?: (message: string, type?: "info" | "warning" | "error") => void,
  ) {
    this.remaining = maxDuration;
    this.startRecording();
    this.startTimer();

    // Listen for external abort signal (e.g. from pipeline's AbortController)
    const signal = recorderOpts.signal;
    if (signal) {
      if (signal.aborted) {
        this.abortRecording();
        void this.finish({ accepted: false });
      } else {
        const onExternalAbort = () => {
          this.localAbortController.abort();
          void this.finish({ accepted: false });
        };
        signal.addEventListener("abort", onExternalAbort, { once: true });
        this.externalAbortCleanup = () => signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * Create a combined AbortSignal from the local overlay controller and the
   * external pipeline signal. Stopping the local controller lets us stop the
   * recording on Enter while still respecting an external abort.
   */
  private recordingSignal(): AbortSignal {
    if (!this.recorderOpts.signal) {
      return this.localAbortController.signal;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();

    if (this.localAbortController.signal.aborted || this.recorderOpts.signal.aborted) {
      controller.abort();
      return controller.signal;
    }

    this.localAbortController.signal.addEventListener("abort", onAbort, { once: true });
    this.recorderOpts.signal.addEventListener("abort", onAbort, { once: true });

    return controller.signal;
  }

  /**
   * Start recording audio in the background as soon as the overlay opens.
   */
  private startRecording(): void {
    const recordOptions: RecordAudioOptions = {
      duration: this.maxDuration,
      audioDevice: this.recorderOpts.audioDevice,
      signal: this.recordingSignal(),
    };

    this.recordingPromise = recordAudio(recordOptions)
      .then((path) => path)
      .catch((err) => {
        // Recording errors are surfaced to the user by the recorder itself.
        // For the overlay, treat this as a cancellation.
        return undefined;
      });
  }

  /**
   * Abort the in-progress recording. Used when Enter/Escape is pressed or
   * the external signal aborts.
   */
  private abortRecording(): void {
    if (!this.localAbortController.signal.aborted) {
      this.localAbortController.abort();
    }
  }

  /**
   * Pulsing visual indicator to show recording activity (MEDIUM-02).
   * Cycles through ▁▂▃▄▅▆▇██▇▆▅▄▃▂▁ on each render call.
   */
  private activityIndicator(): string {
    const bars = ["▁","▂","▃","▄","▅","▆","▇","█","▇","▆","▅","▄","▃","▂"];
    const idx = this.pulseTick % bars.length;
    this.pulseTick = (this.pulseTick + 1) % bars.length;
    return this.theme.fg("accent", bars[idx]);
  }

  private startTimer(): void {
    this.timerId = setInterval(() => {
      this.remaining--;
      if (this.remaining <= 0) {
        this.stopTimer();
        void this.finish({ accepted: true });
      } else {
        this.tui.requestRender();
      }
    }, 1000);
    // Increase animation speed for smoother activity indicator
    this.animationTimer = setInterval(() => {
      this.pulseTick = (this.pulseTick + 1) % 24;
      this.tui.requestRender();
    }, 120);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.animationTimer !== null) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }
  }

  private async finish(result: { accepted: boolean }): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.stopTimer();
    this.externalAbortCleanup?.();

    let audioFile: string | undefined;

    if (result.accepted) {
      this.notify?.("🎙 Завершаю запись...");
      // Stop the recorder so it finalizes the file, then wait for the path.
      this.abortRecording();
      audioFile = (await this.recordingPromise) ?? undefined;
      if (!audioFile) {
        this.notify?.("🎙 Запись не удалась — файл не создан");
        // Recording did not produce a file — treat as cancelled.
        this.done({ accepted: false });
        return;
      }
      this.notify?.("🎙 Файл записан: " + audioFile);
    } else {
      // User cancelled; abort the recorder and ignore the resulting error.
      this.abortRecording();
      this.recordingPromise?.catch(() => undefined);
    }

    this.done({ accepted: result.accepted, audioFile });
  }

  handleInput(data: string): void {
    if (this.finished) return;

    // Also accept raw key sequences as a fallback when matchesKey does not
    // recognize the terminal encoding.
    const isEnter = matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n";
    const isEscape = matchesKey(data, "escape") || data === "\x1b";

    if (isEnter) {
      void this.finish({ accepted: true });
    } else if (isEscape) {
      void this.finish({ accepted: false });
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 4);
    const padLine = (s: string) => {
      const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
      const pad = innerW - visible.length;
      if (pad <= 0) return s.slice(0, s.length + pad);
      return s + " ".repeat(pad);
    };

    const mins = Math.floor(this.remaining / 60);
    const secs = this.remaining % 60;
    const timerStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    // Progress bar fills from left as recording approaches maxDuration
    const progress = Math.max(0, Math.min(1, 1 - this.remaining / this.maxDuration));
    const barLen = Math.max(1, innerW - 4);
    const filled = Math.round(barLen * progress);
    const empty = barLen - filled;
    const progressBar =
      th.fg("accent", "█".repeat(filled)) + th.fg("dim", "░".repeat(empty));

    const lines: string[] = [];

    // Top border
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

    // Title row
    lines.push(
      th.fg("border", "│") +
        padLine(` ${th.fg("error", "🎙")} ${th.fg("accent", "Запись...")}    ${th.fg("dim", timerStr)} `) +
        th.fg("border", "│"),
    );

    // Activity indicator (pulsing bar — MEDIUM-02)
    const bar = this.activityIndicator();
    lines.push(
      th.fg("border", "│") + padLine(` ${bar}  Идёт запись `) + th.fg("border", "│"),
    );

    // Progress bar
    lines.push(
      th.fg("border", "│") + padLine(` ${progressBar} `) + th.fg("border", "│"),
    );

    // Instructions
    lines.push(
      th.fg("border", "│") +
        padLine(` ${th.fg("dim", "Enter — завершить, Esc — отменить")} `) +
        th.fg("border", "│"),
    );

    // Bottom border
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  invalidate(): void {
    // No caching to clear
  }

  dispose(): void {
    this.stopTimer();
    this.externalAbortCleanup?.();
    this.abortRecording();
  }
}

// ---------------------------------------------------------------------------
// Component: ProcessingOverlayComponent
// ---------------------------------------------------------------------------

class ProcessingOverlayComponent {
  private closed = false;
  private externalAborted = false;

  constructor(
    private theme: Theme,
    private status: ProcessingStatus,
    private done: (result: void) => void,
    private onAbort?: () => void,
  ) {}

  update(status: ProcessingStatus): void {
    this.status = status;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(undefined);
  }

  handleInput(data: string): void {
    // Allow Escape to abort processing (HIGH-01)
    if (matchesKey(data, "escape")) {
      this.externalAborted = true;
      this.onAbort?.();
      this.close();
    }
  }

  get wasAborted(): boolean {
    return this.externalAborted;
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 4);
    const padLine = (s: string) => {
      const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
      const pad = innerW - visible.length;
      if (pad <= 0) return s.slice(0, s.length + pad);
      return s + " ".repeat(pad);
    };

    const statusInfo = this.getStatusInfo();

    const lines: string[] = [];

    // Top border
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

    // Status row
    lines.push(
      th.fg("border", "│") +
        padLine(` ${statusInfo.icon}  ${th.fg("accent", statusInfo.text)} `) +
        th.fg("border", "│"),
    );

    // Spinner / progress indication
    lines.push(
      th.fg("border", "│") + padLine(` ${th.fg("dim", statusInfo.subtext)} `) + th.fg("border", "│"),
    );

    // Bottom border
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  private getStatusInfo(): { icon: string; text: string; subtext: string } {
    switch (this.status) {
      case "transcribing":
        return {
          icon: "🔊",
          text: "Transcribing...",
          subtext: "Processing audio via whisper.cpp",
        };
      case "ollama":
        return {
          icon: "🤖",
          text: "Improving text via Ollama...",
          subtext: "Post-processing with language model",
        };
      case "done":
        return {
          icon: "✅",
          text: "Done!",
          subtext: "Text inserted into editor",
        };
    }
  }

  invalidate(): void {
    // No caching to clear
  }

  dispose(): void {
    // Nothing to clean up
  }
}
