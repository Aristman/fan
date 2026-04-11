/**
 * FAN Orchestrator Extension
 *
 * Multi-agent task decomposition and coordination.
 * Spawns fna subprocesses for isolated subagent execution.
 *
 * Slash commands:
 *   /orchestrator [on|off] — Toggle orchestrator mode
 *   /tasks [status]        — List tracked tasks
 *   /agents                — List available agents
 *   /delegate <agent> <task> — Quick delegate
 */

import type { ExtensionFactory } from "@itone/fan-coding-agent";
import { TaskManager } from "./task-manager.js";
import { discoverAgents, formatAgentList } from "./agents.js";
import { registerOrchestratorTools } from "./orchestrator-tools.js";

export const orchestratorExtension: ExtensionFactory = (pi) => {
	// Initialize task manager
	const taskManager = new TaskManager();

	// Register coordinator tools
	registerOrchestratorTools(pi, taskManager);

	// ---- Event: session_start ----
	pi.on("session_start", () => {
		console.log(`[FAN Orchestrator] Session started`);
		console.log(`[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task`);
	});

	// ---- Event: session_shutdown ----
	pi.on("session_shutdown", () => {
		const counts = taskManager.getStatusCounts();
		console.log(`[FAN Orchestrator] Session shut down. Tasks: ${JSON.stringify(counts)}`);
	});

	// ---- Slash Command: /orchestrator ----
	pi.registerCommand("orchestrator", {
		description: "Toggle orchestrator mode or show status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "on") {
				ctx.ui.notify("FAN Orchestrator active. Use delegate_task tool to spawn subagents.");
				return;
			}

			if (arg === "off") {
				ctx.ui.notify("Orchestrator mode disabled.");
				return;
			}

			// Show status
			const counts = taskManager.getStatusCounts();
			const discovery = discoverAgents(ctx.cwd, "both");
			const active = taskManager.getActiveTasks();
			const text = [
				"FAN Orchestrator — Status",
				`Tasks: ${taskManager.size} total`,
				`  Pending: ${counts.pending} | In Progress: ${counts.in_progress} | Completed: ${counts.completed} | Failed: ${counts.failed} | Blocked: ${counts.blocked}`,
				`Available agents: ${discovery.agents.length}`,
				...discovery.agents.map((a) => `  ${a.name} (${a.source}): ${a.description}`),
			].join("\n");
			ctx.ui.notify(text);
		},
	});

	// ---- Slash Command: /tasks ----
	pi.registerCommand("tasks", {
		description: "List orchestrator tasks (optional: filter by status)",
		handler: async (args, ctx) => {
			const statusFilter = args.trim() || undefined;
			const tasks = taskManager.getTasks(statusFilter ? { status: statusFilter as any } : undefined);
			const counts = taskManager.getStatusCounts();

			if (tasks.length === 0) {
				ctx.ui.notify(`No tasks found. Counts: pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}`);
				return;
			}

			const lines = tasks.map((t) => {
				const result = t.result ? ` → ${t.result.slice(0, 60)}` : "";
				const error = t.error ? ` [${t.error}]` : "";
				return `[${t.status}] ${t.id.slice(0, 8)} ${t.agentType}: ${t.description.slice(0, 80)}${error}${result}`;
			});

			ctx.ui.notify([`Tasks (${tasks.length}):`, ...lines, "", `Counts: ${JSON.stringify(counts)}`].join("\n"));
		},
	});

	// ---- Slash Command: /agents ----
	pi.registerCommand("agents", {
		description: "List available agents (built-in, user, project)",
		handler: async (args, ctx) => {
			const scope = (args.trim() === "project" ? "project" : args.trim() === "user" ? "user" : "both") as "user" | "project" | "both";
			const discovery = discoverAgents(ctx.cwd, scope);
			const formatted = formatAgentList(discovery.agents, 20);

			const lines = [
				`Available agents (${discovery.agents.length}):`,
				formatted.text,
			];

			if (formatted.remaining > 0) {
				lines.push(`  ... +${formatted.remaining} more`);
			}

			if (discovery.projectAgentsDir) {
				lines.push(`\nProject agents dir: ${discovery.projectAgentsDir}`);
			}

			ctx.ui.notify(lines.join("\n"));
		},
	});

	// ---- Slash Command: /delegate ----
	pi.registerCommand("delegate", {
		description: "Quick delegate a task to an agent: /delegate <agent> <task>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /delegate <agent> <task description...>\n\nAgents: explore, plan, implement, verify\nExample: /delegate explore Find all API endpoints in the project");
				return;
			}

			const agentName = parts[0];
			const task = parts.slice(1).join(" ");

			// Verify agent exists
			const discovery = discoverAgents(ctx.cwd, "both");
			const agent = discovery.agents.find((a) => a.name === agentName);
			if (!agent) {
				const available = discovery.agents.map((a) => a.name).join(", ");
				ctx.ui.notify(`Unknown agent: "${agentName}". Available: ${available}`);
				return;
			}

			// Use the delegate_task tool via programmatic invocation
			ctx.ui.notify(`Delegating to ${agentName}: ${task.slice(0, 80)}...`);
			// The actual delegation happens through the LLM calling delegate_task tool.
			// This command just prepares the context.
			ctx.ui.notify(`Task queued for delegation:\n  Agent: ${agentName}\n  Task: ${task}\n\nThe delegate_task tool will be used on the next turn.`);
		},
	});
};

export default orchestratorExtension;
