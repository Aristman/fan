/**
 * Extension with npm Dependencies Template
 *
 * When your extension needs third-party packages, use this structure.
 *
 * Setup:
 *   1. Add dependencies to package.json
 *   2. Run `npm install` in the extension directory
 *   3. pi auto-discovers from package.json "pi.extensions" field
 *
 * Structure:
 *   my-extension/
 *   ├── package.json     — dependencies + pi manifest
 *   ├── package-lock.json
 *   ├── node_modules/    — after npm install
 *   └── src/
 *       └── index.ts     — entry point
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@fan/fan-ai";
// Third-party import (from package.json dependencies)
import { z } from "zod";

export default function (pi: ExtensionAPI) {
	// Example: use zod for validation alongside TypeBox schemas
	const itemSchema = z.object({
		name: z.string().min(1),
		value: z.number().optional(),
	});

	pi.registerTool({
		name: "my_validated_tool",
		label: "My Validated Tool",
		description: "Tool with Zod validation on top of TypeBox parameters",
		parameters: Type.Object({
			action: StringEnum(["validate", "parse"] as const),
			input: Type.String({ description: "JSON string to validate" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}

			try {
				const parsed = JSON.parse(params.input);
				const result = itemSchema.safeParse(parsed);

				if (result.success) {
					return {
						content: [
							{
								type: "text",
								text: `Valid: ${JSON.stringify(result.data)}`,
							},
						],
						details: { valid: true, data: result.data },
					};
				} else {
					return {
						content: [
							{
								type: "text",
								text: `Invalid: ${result.error.message}`,
							},
						],
						details: { valid: false, errors: result.error.issues },
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: "Failed to parse JSON input" }],
					details: { valid: false },
				};
			}
		},
	});
}
