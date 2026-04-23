/**
 * Gate Extension Template
 *
 * Extension that intercepts and optionally blocks tool calls.
 * Use for permission gates, path protection, command filtering, etc.
 */

import { isToolCallEventType } from "@fan/fan-coding-agent";
import type { ExtensionAPI } from "@fan/fan-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// --- Example 1: Block dangerous bash commands ---
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command as string;

			const dangerousPatterns = [
				"rm -rf /",
				"rm -rf ~",
				":(){ :|:& };:",
				"mkfs",
				"dd if=",
			];

			for (const pattern of dangerousPatterns) {
				if (command.includes(pattern)) {
					if (ctx.hasUI) {
						const ok = await ctx.ui.confirm(
							"Dangerous command!",
							`Blocked: ${command}\nAllow anyway?`,
						);
						if (!ok) {
							return { block: true, reason: `Blocked by gate: ${pattern}` };
						}
					} else {
						return { block: true, reason: `Blocked by gate: ${pattern}` };
					}
				}
			}
		}

		// --- Example 2: Mutate tool arguments ---
		if (isToolCallEventType("bash", event)) {
			// Prepend environment setup to every bash command
			event.input.command = `source ~/.profile\n${event.input.command}`;
		}

		// --- Example 3: Protect specific paths ---
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = event.input.path as string;
			const protectedPaths = [".env", "node_modules/", ".git/"];

			for (const protectedPath of protectedPaths) {
				if (path.includes(protectedPath)) {
					return {
						block: true,
						reason: `Path is protected: ${path} (matches ${protectedPath})`,
					};
				}
			}
		}

		// Pass through by default (return nothing or undefined)
	});
}
