/**
 * Tool Extension Template
 *
 * Minimal extension with a single custom tool callable by the LLM.
 * Copy this template and adapt to your needs.
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@fan/fan-ai";
import { Text } from "@fan/fan-tui";

export default function (fan: ExtensionAPI) {
	fan.registerTool({
		name: "my_tool",
		label: "My Tool",
		description:
			"What this tool does. This description is shown to the LLM to decide when to use it.",
		promptSnippet: "Do X with Y using my_tool",
		promptGuidelines: [
			"Use this tool when the user asks to perform X.",
			"Always confirm the result after using this tool.",
		],
		parameters: Type.Object({
			action: StringEnum(["do", "undo", "list"] as const, {
				description: "What action to perform",
			}),
			target: Type.String({ description: "Target to apply action to" }),
			option: Type.Optional(
				Type.String({ description: "Optional additional parameter" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Handle cancellation
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: {},
				};
			}

			// Stream progress
			onUpdate?.({
				content: [{ type: "text", text: `Processing ${params.action} on ${params.target}...` }],
				details: { progress: 50 },
			});

			// --- Your logic here ---
			const result = `${params.action} applied to ${params.target}`;
			// -------------------------

			return {
				content: [{ type: "text", text: result }],
				details: {
					action: params.action,
					target: params.target,
					option: params.option,
				},
			};
		},

		renderCall(args, theme, _context) {
			const text = new Text("", 0, 0);
			let content =
				theme.fg("toolTitle", theme.bold("my_tool ")) +
				theme.fg("accent", args.action) +
				" " +
				theme.fg("dim", `"${args.target}"`);
			if (args.option) {
				content += " " + theme.fg("muted", `[${args.option}]`);
			}
			text.setText(content);
			return text;
		},

		renderResult(result, { expanded }, theme, _context) {
			if (result.details?.error) {
				return new Text(
					theme.fg("error", `Error: ${result.details.error}`),
					0,
					0,
				);
			}

			const text = new Text("", 0, 0);
			let content = theme.fg("success", "✓ Done");
			if (expanded && result.details) {
				content += "\n" + theme.fg("dim", `Action: ${result.details.action}`);
				content += "\n" + theme.fg("dim", `Target: ${result.details.target}`);
				if (result.details.option) {
					content += "\n" + theme.fg("dim", `Option: ${result.details.option}`);
				}
			}
			text.setText(content);
			return text;
		},
	});
}
