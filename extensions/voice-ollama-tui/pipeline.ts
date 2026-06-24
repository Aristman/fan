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
import { recordAudio, setRecorderNotify } from "./audio-recorder.js";
import { getFfmpegPath, setDependencyNotify } from "./dependencies.js";
import { ensureWhisperModel } from "./model-downloader.js";
import { transcribe, setWhisperNotify } from "./whisper-service.js";
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
    ctx.ui.setStatus("voice-ollama-tui", `🎙 Не хватает: ${missingList}`);
    ctx.ui.notify(
      `🎙 Не установлены: ${missingList}. Выполните /voice init для настройки.`,
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
  // Wire diagnostic notifications first so dependency and recorder checks
  // can surface their internal path-resolution diagnostics in the TUI.
  setRecorderNotify(ctx.ui.notify);
  setDependencyNotify(ctx.ui.notify);
  setWhisperNotify(ctx.ui.notify);

  if (!ensureDependencies(ctx, config)) {
    return;
  }

  const abortController = new AbortController();
  let audioPath: string | undefined;
  let processingOverlay: ProcessingOverlayController | undefined;
  let modelOverlay: ProcessingOverlayController | undefined;

  try {
    // ── Step 1+2: Запись ─────────────────────────────────────────────
    const ffmpegPath = getFfmpegPath();

    const { accepted, audioFile } = await showRecordingOverlay(ctx, {
      duration: config.recordDurationMax,
      audioDevice: config.audioDevice,
      signal: abortController.signal,
      binPath: ffmpegPath,
    });

    if (!accepted || !audioFile) {
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Готов");
      return;
    }

    audioPath = audioFile;

    // ── Step 3: Проверка модели whisper ────────────────────────────────
    ctx.ui.setStatus("voice-ollama-tui", "🎙 Подготовка модели...");
    modelOverlay = showProcessingOverlay(ctx, "transcribing", { signal: abortController.signal });
    try {
      await ensureWhisperModel({
        modelPath: config.whisperModelPath,
        onProgress: (_downloaded, _total) => {
          // Overlay stays on "transcribing" during download
        },
      });
    } catch (modelErr) {
      safeCloseOverlay(modelOverlay);
      modelOverlay = undefined;
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Ошибка модели");
      ctx.ui.notify(`🎙 Не удалось загрузить модель: ${errorMessage(modelErr)}`, "error");
      return;
    }

    // ── Step 4: Транскрибация ───────────────────────────────────────
    ctx.ui.setStatus("voice-ollama-tui", "🎙 Распознавание...");

    let text: string;
    try {
      text = await transcribe(audioPath, {
        modelPath: config.whisperModelPath,
        language: config.whisperLanguage,
        binPath: config.whisperBinPath,
      });
    } catch (transcribeErr) {
      safeCloseOverlay(modelOverlay);
      safeCloseOverlay(processingOverlay);
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Ошибка распознавания");
      ctx.ui.notify(`🎙 Ошибка распознавания: ${errorMessage(transcribeErr)}`, "error");
      removePath(audioPath);
      return;
    }

    // ── Step 5: Опциональная постобработка Ollama ───────────────────
    if (config.ollamaEnabled) {
      processingOverlay = processingOverlay ?? showProcessingOverlay(ctx, "ollama", { signal: abortController.signal });
      processingOverlay.update("ollama");
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Постобработка (Ollama)...");

      let result: ImproveTextResult;
      try {
        result = await improveText(config, text, { signal: abortController.signal });
      } catch (ollamaErr) {
        ctx.ui.notify(`🎙 Ollama недоступен, вставляю исходный текст.`, "warning");
        result = { text, usedOllama: false };
      }

      if (result.usedOllama) {
        text = result.text;
      }
    }

    // ── Step 6: Готово ──────────────────────────────────────────────
    safeCloseOverlay(modelOverlay);
    safeCloseOverlay(processingOverlay);

    insertTranscript(ctx, text);
    ctx.ui.setStatus("voice-ollama-tui", "🎙 Готово");

    if (abortController.signal.aborted) {
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Отменено");
      return;
    }
  } catch (err) {
    // Глобальный catch — любая непредвиденная ошибка
    safeCloseOverlay(modelOverlay);
    safeCloseOverlay(processingOverlay);
    ctx.ui.setStatus("voice-ollama-tui", "🎙 Ошибка");
    try {
      ctx.ui.notify(`🎙 Ошибка голосового ввода: ${errorMessage(err)}`, "error");
    } catch {
      // Конвейер никогда не должен пробрасывать ошибку дальше.
    }
  } finally {
    // ── Очистка: удалить временный аудиофайл ────────────────────────
    removePath(audioPath);
  }
}
