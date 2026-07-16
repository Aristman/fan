/**
 * UI Extension Template
 *
 * Extension with custom UI components: status bar, widget, overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@fan/fan-coding-agent";
import { Text, Spacer, Container, Component } from "@fan/fan-tui";

export default function (fan: ExtensionAPI) {
	// --- Status indicator in footer ---
	fan.on("session_start", async (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("my-ui", "Active");
			ctx.ui.setTitle("fan — my-ui extension");
		}
	});

	fan.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("my-ui", undefined);
	});

	// --- Widget above editor ---
	fan.on("turn_start", async (event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget("my-ui", [
				ctx.ui.theme.fg("accent", `Turn ${event.turnIndex + 1}`),
				ctx.ui.theme.fg("muted", "Processing..."),
			]);
		}
	});

	fan.on("turn_end", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget("my-ui", [
				ctx.ui.theme.fg("success", "✓ Done"),
			]);
		}
	});

	// --- Command with custom UI dialog ---
	fan.registerCommand("my-ui-demo", {
		description: "Demo custom UI components",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log("UI not available in this mode");
				return;
			}

			// Simple select
			const choice = await ctx.ui.select("Pick a demo:", [
				"Notification",
				"Input dialog",
				"Custom component",
			]);

			if (!choice) return;

			switch (choice) {
				case "Notification": {
					ctx.ui.notify("Hello from my-ui!", "info");
					break;
				}

				case "Input dialog": {
					const name = await ctx.ui.input("Enter your name:", "John Doe");
					if (name) {
						ctx.ui.notify(`Hello, ${name}!`, "success");
					}
					break;
				}

				case "Custom component": {
					// Custom overlay component
					const result = await ctx.ui.custom<string | null>(
						(tui, theme, keybindings, done) => {
							const container = new Container();
							const title = new Text(
								theme.fg("accent", "Custom Component Demo"),
								0,
								0,
							);
							const hint = new Text(
								theme.fg("muted", "Press Enter to confirm, Escape to cancel"),
								1,
								0,
							);

							hint.onKey = (key) => {
								if (key === "return") done("confirmed");
								if (key === "escape") done(null);
								return true; // consume key
							};

							container.addChild(title);
							container.addChild(new Spacer(1));
							container.addChild(hint);
							return container;
						},
						{ overlay: true },
					);

					if (result) {
						ctx.ui.notify(`Result: ${result}`, "success");
					}
					break;
				}
			}
		},
	});
}
