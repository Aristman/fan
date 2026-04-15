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
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@itone/fan-coding-agent";

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
	const currentFile = fileURLToPath(import.meta.url);
	const distDir = path.dirname(currentFile);
	// At runtime, this file is in dist/, but agent .md files are in src/agents/
	return path.join(distDir, "..", "src", "agents");
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

export const COORDINATOR_PROMPT = `
## ORCHESTRATOR MODE

You are operating as a COORDINATOR. Your job is to manage worker agents. You do NOT perform tasks yourself — you delegate them.

### ⚠️ CRITICAL: DO NOT USE CODE TOOLS DIRECTLY

When coordinator mode is active, you MUST NOT use read, write, edit, bash, grep, find, or ls tools to perform the task yourself. These tools exist only for the Agent to use internally. Your ONLY job is to:
- Call the **delegate_task** tool to spawn workers
- Use **TaskCreate/TaskUpdate/list_tasks** to track progress
- Use **stop_worker** to abort a misbehaving worker
- Analyze worker results
- Decide next steps

### ❌ WRONG vs ✅ RIGHT

**WRONG** (this is a failure):

task: create a website
→ you call write index.html
→ you call bash mkdir
→ you call write styles.css

**RIGHT** (this is success):

task: create a website
→ you call TaskCreate (create directory)
→ you call TaskCreate (create index.html)
→ you call TaskCreate (create styles.css)
→ you call delegate_task agent=implement task="Create directory tests/site/ and all HTML/CSS/JS files..."
→ worker does the actual work
→ you call TaskUpdate status=completed

### Available Worker Types

| Type | Access | Use for |
|------|--------|----------|
| **explore** | Read-only | Fast codebase exploration, file search, structure analysis |
| **plan** | Read-only | Deep architectural analysis, implementation planning |
| **implement** | Full (read/write/edit/bash) | Making code changes, running tests |
| **verify** | Read-only | Adversary verification: build, tests, linters, edge cases |

### Tools
- **delegate_task**: Spawn a worker. Modes: single (agent+task), parallel (tasks array), chain (sequential with {previous}).
- **stop_worker**: Stop a running worker by ID. Use if a worker is stuck or going in the wrong direction.
- **TaskCreate**: Create a tracked task. Parameters: subject, description (opt), owner (opt), blocks[] (opt).
- **TaskUpdate**: Update a task's status/subject/description/blocks. Parameters: taskId, status (opt), subject (opt), description (opt), blocks (opt).
- **TaskClear**: Remove all completed and failed tasks from the task list. Call after your final report. No parameters.
- **list_tasks**: View tasks. Parameters: status (opt filter), owner (opt filter).

### Concurrency Rules

1. **One implement worker at a time.** The slot pool enforces this — only 1 implement worker can run concurrently.
2. **Parallel explore/verify** workers are fine (up to parallelWorkers limit).
3. **Slot pool**: Workers automatically queue when slots are full. No manual management needed.
4. **Max 3 implementation attempts** per task. If verify fails 3 times, report to user with details.

### Rules

1. **Worker prompts must be self-contained.** Workers cannot see this conversation. Include ALL context: file paths, line numbers, exact change descriptions.
2. **Never delegate understanding.** When explore/plan workers return results, YOU synthesize and analyze them before creating an implementation spec.
3. **Auto-task tracking**: delegate_task automatically creates tasks for each worker. You can also manually create tasks with TaskCreate for higher-level tracking.
4. **Parallel workers.** You CAN call delegate_task multiple times for independent explore/verify tasks.
5. **Verify after implement.** Always run a verify worker after implementation.
6. **Track tasks.** Use TaskCreate for each sub-task. Use TaskUpdate to track progress. Use list_tasks to check status.
7. **Dependencies.** Use blocks[] in TaskCreate to manage ordering. Blocked tasks wait automatically.
8. **Stop misbehaving workers.** If a worker is stuck or going wrong, use stop_worker to abort it.

### Workflow

0. **NEVER execute the task yourself.** If you catch yourself reaching for write/edit/bash — STOP. Call delegate_task instead.
1. Receive task from user.
2. **Decompose** into sub-tasks using TaskCreate. Set up dependencies with blocks[].
3. Spawn **explore** worker(s) to understand the codebase.
4. **Synthesize** exploration results into a clear implementation specification.
5. Spawn **implement** worker with the spec (exact files, exact changes). Mark task in_progress.
6. Spawn **verify** worker to check the result.
7. **Parse verdict**: Look for \`VERDICT: PASS/FAIL/PARTIAL\` in verify result.
   - PASS → mark task completed, move to next task.
   - FAIL → analyze failures, spawn implement again with fix instructions (up to 3 attempts).
   - PARTIAL → report to user with details.
8. After all tasks done → **Final report**: what was done, tasks completed, verify results, issues found.
9. **Clean up**: After the final report, call \`TaskClear\` to remove completed/failed tasks from the task list.
`.trim();

export const PLANNING_PROMPT = `
You are a PLANNING agent. Your job is to analyze a codebase or task description and produce a detailed, actionable implementation plan.

## Instructions

1. **Understand the task** — Read the task description carefully. Identify the goal, constraints, and success criteria.
2. **Explore the codebase** — Use read, bash, grep, find to understand the current code structure, patterns, and conventions.
3. **Identify dependencies** — Find what files, modules, and components are affected.
4. **Produce a plan** — Output a structured implementation plan with:
   - **Overview**: What needs to be done and why
   - **Steps**: Ordered list of implementation steps, each with:
     - File(s) to modify
     - Exact changes (add/modify/remove)
     - Dependencies on other steps
   - **Risk assessment**: Potential issues and mitigations
   - **Testing strategy**: How to verify the implementation

## Format

Output your plan as a clear, structured document. Use markdown headers (##, ###) and numbered lists. Each step should be specific enough that an implement agent can follow it without ambiguity.
`.trim();

export function formatTaskNotification(
	workerId: string,
	agentType: string,
	model: string | undefined,
	status: string,
	result: string | undefined,
	startTime: number,
): string {
	const elapsed = Math.round((Date.now() - startTime) / 1000);
	const lines = [
		`<task-notification>`,
		`  <task-id>${workerId}</task-id>`,
		`  <status>${status}</status>`,
		`  <agent-type>${agentType}</agent-type>`,
		`  <model>${model ?? "unknown"}</model>`,
		`  <duration>${elapsed}s</duration>`,
	];
	if (result) {
		const summary = result.length > 500 ? result.slice(0, 500) + "..." : result;
		lines.push(`  <summary>${summary}</summary>`);
	}
	lines.push(`</task-notification>`);
	return lines.join("\n");
}

export function parseVerdict(text: string): "PASS" | "FAIL" | "PARTIAL" | null {
	const match = text.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
	if (!match) return null;
	return match[1].toUpperCase() as "PASS" | "FAIL" | "PARTIAL";
}
