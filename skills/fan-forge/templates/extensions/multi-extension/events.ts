/**
 * Events Module — Multi-File Extension Template
 *
 * All event handlers go here. Called from index.ts.
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";

export function registerEvents(fan: ExtensionAPI): void {
	// --- Session lifecycle ---
	fan.on("session_start", async (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`Extension loaded (${event.reason})`, "info");
		}
	});

	fan.on("session_shutdown", async () => {
		// Cleanup: close connections, flush state, etc.
	});

	// --- Agent lifecycle ---
	fan.on("before_agent_start", async () => {
		return {
			message: {
				customType: "my-multi-ext-context",
				content:
					"[my-multi-ext] Tools available: my_action. Use it to process items.",
				display: false,
			},
		};
	});

	// --- Turn tracking ---
	fan.on("turn_end", async (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"my-multi-ext",
				`Turn ${event.turnIndex + 1} complete`,
			);
		}
	});

	// --- Context cleanup ---
	fan.on("context", async (event) => {
		return {
			messages: event.messages.filter((m: any) => {
				if (m.customType === "my-multi-ext-context") {
					const idx = event.messages.indexOf(m);
					return idx >= event.messages.length - 10;
				}
				return true;
			}),
		};
	});
}
