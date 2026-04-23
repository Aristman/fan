/**
 * Events Module — Multi-File Extension Template
 *
 * All event handlers go here. Called from index.ts.
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";

export function registerEvents(pi: ExtensionAPI): void {
	// --- Session lifecycle ---
	pi.on("session_start", async (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`Extension loaded (${event.reason})`, "info");
		}
	});

	pi.on("session_shutdown", async () => {
		// Cleanup: close connections, flush state, etc.
	});

	// --- Agent lifecycle ---
	pi.on("before_agent_start", async () => {
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
	pi.on("turn_end", async (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"my-multi-ext",
				`Turn ${event.turnIndex + 1} complete`,
			);
		}
	});

	// --- Context cleanup ---
	pi.on("context", async (event) => {
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
