import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@itone/fan-coding-agent";
import type { KeyId } from "@itone/fan-tui";
import { loadConfig } from "./config.js";
import { checkDependencies, resetDependencyCache } from "./dependencies.js";
import { recordAudio } from "./audio-recorder.js";
import { showRecordingOverlay, showProcessingOverlay } from "./ui-overlay.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  /**
   * Check dependencies — returns true if all good, false if missing tools.
   * Shows a warning notification if tools are missing.
   */
  const ensureDependencies = (ctx: ExtensionContext): boolean => {
    const status = checkDependencies(config);
    if (!status.ok) {
      const missingList = status.missing.join(", ");
      ctx.ui.notify(
        `Missing tools: ${missingList}. /voice will not work until installed. See instructions.`,
        "warning",
      );
    }
    return status.ok;
  };

  const handler = async (ctx: ExtensionContext) => {
    if (!ensureDependencies(ctx)) {
      return;
    }

    try {
      // Step 1: Show recording overlay with Enter/Esc handling
      const { accepted } = await showRecordingOverlay(ctx, {
        duration: config.recordDurationMax,
      });

      if (!accepted) {
        // User cancelled — nothing more to do
        return;
      }

      // Step 2: Record audio (user pressed Enter or timer expired)
      const audioPath = await recordAudio({
        duration: config.recordDurationMax,
        audioDevice: config.audioDevice,
      });

      // Step 3: Show processing overlay while transcribing (placeholder)
      // Full transcribing integration (F-3.1) will go here
      const processingOverlay = showProcessingOverlay(ctx, "transcribing");
      // Simulate work; close overlay when done
      processingOverlay.close();

      ctx.ui.notify(`Audio recorded: ${audioPath}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Recording failed: ${msg}`, "error");
    }
  };

  pi.registerCommand("voice", {
    description: "Start voice input: record audio, transcribe with whisper.cpp, insert text into editor.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await handler(ctx);
    },
  });

  pi.registerShortcut(config.shortcut as KeyId, {
    description: "Start voice input",
    handler,
  });

  pi.on("session_start", async (_event, ctx) => {
    const status = checkDependencies(config);
    if (!status.ok) {
      const missingList = status.missing.join(", ");
      ctx.ui.notify(
        `Missing tools: ${missingList}. Install them for voice input to work.`,
        "warning",
      );
      ctx.ui.setStatus("voice-ollama-tui", `🎙 Need: ${missingList}`);
    } else {
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Ready");
    }
  });

  pi.on("session_shutdown", async () => {
    resetDependencyCache();
  });
}
