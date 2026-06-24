import type { ExtensionAPI, ExtensionCommandContext } from "@itone/fan-coding-agent";
import type { KeyId } from "@itone/fan-tui";
import { loadConfig } from "./config.js";
import { checkDependencies, resetDependencyCache } from "./dependencies.js";
import { runVoicePipeline } from "./pipeline.js";
import { runVoiceInitWizard } from "./init-wizard.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const handler = async (ctx: any) => {
    try {
      await runVoicePipeline(ctx, config);
    } catch (err) {
      ctx.ui?.notify?.(
        `🎙 Ошибка голосового ввода: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      ctx.ui?.setStatus?.("voice-ollama-tui", "🎙 Ошибка");
      throw err;
    }
  };

  pi.registerCommand("voice", {
    description: "Start voice input (/voice) or setup wizard (/voice init).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const subcommand = args.trim().toLowerCase();
      if (subcommand === "init") {
        await runVoiceInitWizard(ctx);
      } else {
        await handler(ctx);
      }
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
      ctx.ui.setStatus("voice-ollama-tui", `🎙 Не хватает: ${missingList}`);
    } else {
      ctx.ui.setStatus("voice-ollama-tui", "🎙 Готов");
    }
  });

  pi.on("session_shutdown", async () => {
    resetDependencyCache();
  });
}
