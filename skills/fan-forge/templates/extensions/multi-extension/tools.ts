/**
 * Tools Module — Multi-File Extension Template
 *
 * All tool definitions go here. Exported as default so index.ts re-exports it.
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@fan/fan-ai";
import { Text } from "@fan/fan-tui";
import { processItem, formatResult } from "./utils.js";

export function registerTools(fan: ExtensionAPI): void {
	fan.registerTool({
		name: "my_action",
		label: "My Action",
		description: "Perform an action on an item",
		promptSnippet: "Perform actions on items using my_action tool",
		promptGuidelines: ["Use my_action when the user wants to process items."],
		parameters: Type.Object({
			action: StringEnum(["create", "update", "delete", "list"] as const, {
				description: "Action to perform",
			}),
			item: Type.String({ description: "Item to act on" }),
			value: Type.Optional(
				Type.String({ description: "Value for create/update" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}

			onUpdate?.({
				content: [{ type: "text", text: `Executing ${params.action}...` }],
			});

			const result = processItem(params.action, params.item, params.value);
			const formatted = formatResult(result);

			return {
				content: [{ type: "text", text: formatted }],
				details: { action: params.action, item: params.item, result },
			};
		},

		renderCall(args, theme, _context) {
			const text = new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("my_action ")) +
					theme.fg("accent", args.action) +
					" " +
					theme.fg("dim", `"${args.item}"`),
			);
			return text;
		},

		renderResult(result, { expanded }, theme, _context) {
			const text = new Text("", 0, 0);
			let content = theme.fg("success", "✓");
			if (expanded && result.details) {
				content += " " + theme.fg("dim", JSON.stringify(result.details, null, 2));
			}
			text.setText(content);
			return text;
		},
	});
}
