/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   pi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { createBashTool } from "@seaagents/fan-coding-agent";

export default function (fan: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, FAN_SPAWN_HOOK: "1" },
		}),
	});

	fan.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
