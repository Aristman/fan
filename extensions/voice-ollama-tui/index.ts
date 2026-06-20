import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@itone/fan-coding-agent";
import type { KeyId } from "@itone/fan-tui";
import { loadConfig } from "./config.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const handler = async (ctx: ExtensionContext) => {
    ctx.ui.notify("Voice input triggered — not yet implemented", "info");
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
    ctx.ui.setStatus("voice-ollama-tui", "🎙 Ready");
  });

  pi.on("session_shutdown", async () => {
    // Cleanup handled per-pipeline
  });
}
