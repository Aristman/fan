import type { ExtensionAPI, ExtensionCommandContext } from "@itone/fan-coding-agent";
import type { KeyId } from "@itone/fan-tui";
import { loadConfig } from "./config.js";
import { checkDependencies, resetDependencyCache } from "./dependencies.js";
import { runVoicePipeline } from "./pipeline.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const handler = async (ctx: any) => {
    await runVoicePipeline(ctx, config);
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
