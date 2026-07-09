import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Get the agent config directory (e.g., ~/.fan/agent/).
 *
 * Respects the FAN_CODING_AGENT_DIR environment variable.
 * Agent-core isn't tied to a specific app name, but the `@seaagents/fan-coding-agent`
 * derives the default from its own package.json. This version uses ".fan" as default.
 */
export function getAgentDir(): string {
	const envDir = process.env.FAN_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), ".fan", "agent");
}
