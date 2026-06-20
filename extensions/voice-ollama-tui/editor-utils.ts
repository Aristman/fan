/**
 * Editor utilities for voice-ollama-tui (F-3.3)
 *
 * Provides insertTranscript() to place recognised speech into the TUI editor.
 *
 * Roadmap TDD:
 *   TC-F-3.3-1: setEditorText called with recognised text.
 *   TC-F-3.3-2: If editor not empty, text appended with a space.
 *   TC-F-3.3-3: Empty recognised text shows a notification.
 */

import type { ExtensionContext } from "@itone/fan-coding-agent";

/**
 * Insert a recognised transcript into the TUI editor.
 *
 * - If `text` is empty or whitespace-only → shows a warning notification
 *   and does NOT call setEditorText.
 * - Otherwise reads the current editor content via getEditorText(),
 *   appends the transcript with a leading space (if the editor is non-empty),
 *   and writes the result via setEditorText().
 *
 * @param ctx - Extension context with UI access
 * @param text - The recognised transcript string
 */
// Zero-width / invisible characters that whisper.cpp occasionally emits.
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

export function insertTranscript(ctx: ExtensionContext, text: string): void {
  const cleaned = text.replace(ZERO_WIDTH_RE, "").trim();

  if (cleaned.length === 0) {
    ctx.ui.notify("Ничего не распознано", "warning");
    return;
  }

  const currentText = ctx.ui.getEditorText().trim();

  if (currentText.length > 0) {
    ctx.ui.setEditorText(`${currentText} ${cleaned}`);
  } else {
    ctx.ui.setEditorText(cleaned);
  }
}
