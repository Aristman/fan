/**
 * Voice pipeline orchestrator (F-4.3)
 *
 * Centralised voice pipeline that coordinates recording, transcription,
 * optional Ollama post-processing, and text insertion — all with proper
 * error handling, overlay management, and cleanup.
 *
 * Roadmap TDD:
 *   TC-F-4.3-1: On recording error, overlay is closed and notify is shown with type error.
 *   TC-F-4.3-2: On transcription error, TUI is not blocked and a notification is shown.
 *
 * Acceptance criteria:
 *   1. No error in the pipeline freezes the TUI.
 *   2. All errors are displayed via ctx.ui.notify().
 *   3. Temporary files are deleted even on error.
 */

import fs from "node:fs";
import type { ExtensionContext } from "@itone/fan-coding-agent";
import type { VoiceOllamaConfig } from "./config.js";
import { checkDependencies } from "./dependencies.js";
import { showRecordingOverlay, showProcessingOverlay } from "./ui-overlay.js";
import type { ProcessingOverlayController } from "./ui-overlay.js";
import { recordAudio } from "./audio-recorder.js";
import { ensureWhisperModel } from "./model-downloader.js";
import { transcribe } from "./whisper-service.js";
import { improveText } from "./ollama-service.js";
import type { ImproveTextResult } from "./ollama-service.js";
import { insertTranscript } from "./editor-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove a file or directory, best-effort (never throws).
 */
function removePath(p: string | undefined): void {
  if (p === undefined) return;
  try {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        fs.unlinkSync(p);
      }
    }
  } catch {
    // Best-effort
  }
}

/**
 * Safe-closes a processing overlay controller if defined (never throws).
 */
function safeCloseOverlay(overlay: ProcessingOverlayController | undefined): void {
  try {
    overlay?.close();
  } catch {
    // Best-effort
  }
}

/**
 * Extract a human-readable message from an unknown error value.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Check dependencies and notify the user if tools are missing.
 * Returns true if all dependencies are satisfied.
 */
function ensureDependencies(ctx: ExtensionContext, config: VoiceOllamaConfig): boolean {
  const status = checkDependencies(config);
  if (!status.ok) {
    const missingList = status.missing.join(", ");
    ctx.ui.notify(
      `Missing tools: ${missingList}. /voice will not work until installed. See instructions.`,
      "warning",
    );
  }
  return status.ok;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full voice pipeline.
 *
 * Steps:
 *   1. Check dependencies (ffmpeg/sox/arecord, whisper-cli).
 *   2. Show recording overlay with Enter/Esc handling.
 *   3. Record audio via the first available recorder.
 *   4. Ensure / download the whisper model.
 *   5. Transcribe the audio with whisper.cpp.
 *   6. Optionally improve the transcript via Ollama.
 *   7. Insert the final transcript into the TUI editor.
 *
 * On any error:
 *   - Closes any open overlay.
 *   - Removes temporary audio files.
 *   - Shows a user-facing notification with type "error".
 *   - Does NOT re-throw, so the TUI never crashes.
 *
 * @param ctx - Extension context with UI access
 * @param config - Resolved extension configuration
 */
export async function runVoicePipeline(
  ctx: ExtensionContext,
  config: VoiceOllamaConfig,
): Promise<void> {
  if (!ensureDependencies(ctx, config)) {
    return;
  }

  const abortController = new AbortController();
  let audioPath: string | undefined;
  let processingOverlay: ProcessingOverlayController | undefined;
  let modelOverlay: ProcessingOverlayController | undefined;

  try {
    // ── Step 1+2: Recording overlay + record audio simultaneously ───
    // Recording starts immediately; the overlay shows live progress and
    // the user can press Enter to stop or Escape to cancel.
    const { accepted, audioFile } = await showRecordingOverlay(ctx, {
      duration: config.recordDurationMax,
      audioDevice: config.audioDevice,
      signal: abortController.signal,
    });

    if (!accepted || !audioFile) {
      // User cancelled with Escape or recording failed to produce a file
      return;
    }

    audioPath = audioFile;

    // ── Step 3: Ensure whisper model ─────────────────────────────────
    ctx.ui.notify("🎙 Проверяю модель whisper...", "info");
    try {
      modelOverlay = showProcessingOverlay(ctx, "transcribing", { signal: abortController.signal });

      await ensureWhisperModel({
        modelPath: config.whisperModelPath,
        onProgress: (_downloaded, _total) => {
          // Overlay stays on "transcribing" during download
        },
      });

      safeCloseOverlay(modelOverlay);
      modelOverlay = undefined;
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Ready");
      ctx.ui.notify("🎙 Модель whisper готова", "info");
    } catch (modelErr) {
      safeCloseOverlay(modelOverlay);
      modelOverlay = undefined;
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Model download failed");
      ctx.ui.notify(`Model download failed: ${errorMessage(modelErr)}`, "error");
      return;
    }

    // ── Step 4: Transcribe ──────────────────────────────────────────
    ctx.ui.notify("🎙 Начинаю транскрибацию...", "info");
    processingOverlay = showProcessingOverlay(ctx, "transcribing", { signal: abortController.signal });

    let text: string;
    try {
      text = await transcribe(audioPath, {
        modelPath: config.whisperModelPath,
        language: config.whisperLanguage,
        binPath: config.whisperBinPath,
      });
    } catch (transcribeErr) {
      safeCloseOverlay(processingOverlay);
      processingOverlay = undefined;
      ctx.ui.notify(`Transcription failed: ${errorMessage(transcribeErr)}`, "error");

      // Cleanup temp audio
      removePath(audioPath);
      return;
    }

    ctx.ui.notify(`🎙 Распознано: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`, "info");

    // ── Step 5: Optional Ollama improvement (F-4.2) ─────────────────
    if (config.ollamaEnabled) {
      ctx.ui.notify(`🎙 Отправляю в Ollama (${config.ollamaModel})...`, "info");
      processingOverlay.update("ollama");

      let result: ImproveTextResult;
      try {
        result = await improveText(config, text, { signal: abortController.signal });
      } catch (ollamaErr) {
        // improveText already has internal try/catch fallback, but
        // wrap just in case of unexpected synchronous errors
        ctx.ui.notify(`Ollama improvement failed: ${errorMessage(ollamaErr)}`, "warning");
        result = { text, usedOllama: false };
      }

      if (result.usedOllama) {
        text = result.text;
        ctx.ui.notify(`🎙 Ollama исправил текст: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`, "info");
      } else {
        ctx.ui.notify("🎙 Ollama не использовался, вставляю исходный текст", "info");
      }
    }

    // ── Step 6: Done ────────────────────────────────────────────────
    processingOverlay.update("done");
    safeCloseOverlay(processingOverlay);
    processingOverlay = undefined;

    ctx.ui.notify("🎙 Вставляю результат в строку ввода...", "info");
    insertTranscript(ctx, text);
    ctx.ui.notify("🎙 Готово", "info");

    // Check if user or external signal aborted during processing
    if (abortController.signal.aborted) {
      ctx.ui.notify("Voice input was cancelled.", "warning");
      return;
    }
  } catch (err) {
    // Global catch — any unexpected error in the entire pipeline
    safeCloseOverlay(modelOverlay);
    safeCloseOverlay(processingOverlay);
    try {
      ctx.ui.notify(`Voice input failed: ${errorMessage(err)}`, "error");
    } catch {
      // Best-effort notification. The pipeline itself must never propagate an error.
    }
  } finally {
    // ── Cleanup: remove temporary audio file if it exists ───────────
    removePath(audioPath);
  }
}
