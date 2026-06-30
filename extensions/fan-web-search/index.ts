import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { loadConfig } from "./config.js";
import { initProviderChain, registerTools, zaiProvider } from "./tools.js";

export default function (fan: ExtensionAPI) {
  // ── Safety net: catch unhandled network rejections ──

  const rejectionHandler = (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const networkErrors = [
      "ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT",
      "fetch failed", "socket hang up",
    ];

    if (networkErrors.some(e => msg.includes(e))) {
      if (zaiProvider) zaiProvider.invalidateSession();
      return;
    }

    console.error(`[fan-web-search] Unhandled rejection: ${msg}`);
  };

  process.on("unhandledRejection", rejectionHandler);

  // ── Session lifecycle ──

  fan.on("session_start", async () => {
    try {
      const config = loadConfig();
      await initProviderChain(config);
    } catch (err) {
      console.error(`[fan-web-search] Failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  fan.on("session_shutdown", () => {
    if (zaiProvider) zaiProvider.invalidateSession();
    process.off("unhandledRejection", rejectionHandler);
  });

  // ── Register tools ──
  registerTools(fan);
}
