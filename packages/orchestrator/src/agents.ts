/**
 * Agent discovery and configuration for FAN orchestrator
 *
 * Discovers agent definitions from:
 *   1. Built-in agents (packages/orchestrator/src/agents/*.md)
 *   2. User agents (~/.fan/agent/agents/*.md)
 *   3. Project agents (.fan/agents/*.md, walked up to git root)
 *
 * Priority (highest wins): project > user > builtin
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@itone/fan-coding-agent";
import { fileURLToPath } from "node:url";

export type AgentScope = "user" | "project" | "both";
export type { AgentConfig, AgentDiscoveryResult } from "./types.js";

function loadAgentsFromDir(dir: string, source: "user" | "project" | "builtin"): import("./types.js").AgentConfig[] {
	const agents: import("./types.js").AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".fan", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Get the directory containing built-in agent definitions.
 */
function getBuiltinAgentsDir(): string {
	// Resolve relative to this source file
	const currentFile = fileURLToPath(import.meta.url);
	const srcDir = path.dirname(currentFile);
	return path.join(srcDir, "agents");
}

/**
 * Load built-in FAN worker agents.
 */
function loadBuiltinAgents(): import("./types.js").AgentConfig[] {
	const dir = getBuiltinAgentsDir();
	return loadAgentsFromDir(dir, "builtin");
}

/**
 * Discover agents from all sources.
 *
 * @param cwd - Current working directory (for project agent lookup)
 * @param scope - Which directories to search
 * @returns Discovered agents and project agents directory path
 */
export function discoverAgents(cwd: string, scope: AgentScope): import("./types.js").AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const builtinAgents = loadBuiltinAgents();
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Merge: builtin → user → project (project overrides user overrides builtin)
	const agentMap = new Map<string, import("./types.js").AgentConfig>();

	for (const agent of builtinAgents) agentMap.set(agent.name, agent);
	if (scope !== "project") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope !== "user" && projectAgentsDir) {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Format agent list for display.
 */
export function formatAgentList(
	agents: import("./types.js").AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
