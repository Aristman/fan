/**
 * Command Extension Template
 *
 * Extension with a slash command and UI interaction.
 * Commands are invoked via /command-name in fan.
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";
import { Text } from "@fan/fan-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("my-cmd", {
		description: "What this command does",
		handler: async (args, ctx) => {
			// Example: parse arguments
			const inputArgs = args?.trim();

			// UI interactions
			if (ctx.hasUI) {
				// Select from options
				const choice = await ctx.ui.select("Pick an option:", [
					"Option A",
					"Option B",
					"Option C",
				]);

				if (!choice) {
					ctx.ui.notify("Cancelled", "warning");
					return;
				}

				// Confirm action
				const ok = await ctx.ui.confirm(
					"Confirm",
					`You selected: ${choice}. Proceed?`,
				);

				if (!ok) {
					ctx.ui.notify("Cancelled", "warning");
					return;
				}

				ctx.ui.notify(`Done: ${choice}`, "success");
			}

			// For non-interactive modes
			console.log(`Command executed with args: ${inputArgs}`);
		},

		// Optional: auto-complete arguments
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "option-a", label: "Option A" },
				{ value: "option-b", label: "Option B" },
				{ value: "option-c", label: "Option C" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
	});

	// Optional: register a keyboard shortcut for the command
	// import { Key } from "@fan/fan-tui";
	// pi.registerShortcut(Key.ctrlAlt("m"), {
	//   description: "Trigger my-cmd",
	//   handler: async (ctx) => { /* same logic */ },
	// });
}
