import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

/**
 * FNA Orchestrator Extension
 *
 * Skeleton implementation — registers lifecycle hooks and a slash command.
 * Full multi-agent orchestration will be implemented in Phase 4.
 */
export const orchestratorExtension: ExtensionFactory = (pi) => {
	// Register session lifecycle hooks
	pi.on("session_start", (event) => {
		console.log(`[FNA Orchestrator] Session started: ${event.reason}`);
	});

	pi.on("session_shutdown", () => {
		console.log("[FNA Orchestrator] Session shut down");
	});

	// Register slash command
	pi.registerCommand("orchestrator", {
		description: "Show FNA orchestrator status",
		handler: async (_args, ctx) => {
			await ctx.ui.notify("FNA Orchestrator v0.1.0 — skeleton active. Full orchestration coming in Phase 4.");
		},
	});
};

export default orchestratorExtension;
