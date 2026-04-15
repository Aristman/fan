/**
 * FAN Orchestrator Extension
 *
 * Multi-agent task decomposition and coordination.
 * Features: coordinator mode, task widget, /plan, enhanced /orchestrator,
 * permission system, session lifecycle management.
 *
 * Shortcuts:
 *   Alt+O — Toggle coordinator mode
 *   Alt+T — Toggle task list collapse
 *
 * Slash commands:
 *   /orchestrator [on|off|stop|config|mode|status] — Orchestrator control
 *   /tasks [status]       — List tracked tasks
 *   /agents [scope]       — List available agents
 *   /plan [task]          — Generate implementation plan
 *   /delegate <agent> <task> — Quick delegate
 */

import type { ExtensionFactory } from "@itone/fan-coding-agent";
import { COORDINATOR_PROMPT, discoverAgents } from "./agents.js";
import { loadConfig } from "./config.js";
import { registerOrchestratorTools } from "./orchestrator-tools.js";
import { isDangerousCommand } from "./permissions.js";
import { getFinalOutput, runSingleAgent } from "./subagent-runner.js";
import { TaskManager } from "./task-manager.js";
import type { OrchestratorConfig } from "./types.js";
import { _resetRegistry, activeWorkers, genWorkerId, registerWorker, updateWorker } from "./workers.js";

export const orchestratorExtension: ExtensionFactory = (pi) => {
	// ---- Infrastructure setup ----
	const config: OrchestratorConfig = loadConfig();
	const taskManager = new TaskManager();

	// Register tools (delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate)
	registerOrchestratorTools(pi, taskManager, config);

	// ---- State ----
	let coordinatorActive = false;
	let taskWidgetCollapsed = false;
	let lastCtx: any;

	// ---- Helper: updateTaskWidget ----
	function updateTaskWidget(ctx: any): void {
		if (!ctx?.ui?.setWidget) return;

		const tasks = taskManager.getTasks();

		// Auto-hide + auto-clear: if no active/pending tasks, hide widget and clean up
		const activeOrPending = tasks.filter((t: any) => t.status !== "completed" && t.status !== "failed");
		if (tasks.length === 0 || activeOrPending.length === 0) {
			if (tasks.length > 0) taskManager.clearCompleted();
			ctx.ui.setWidget("orchestrator-tasks", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const bold = (text: string) => theme?.bold?.(text) ?? text;
	 const strikethrough = (text: string) => theme?.strikethrough?.(text) ?? text;

		const sorted = [...tasks].sort((a: any, b: any) => {
			const order: Record<string, number> = { in_progress: 0, pending: 1, blocked: 2, completed: 3, failed: 4 };
			return (order[a.status] ?? 5) - (order[b.status] ?? 5);
		});

		const doneCount = tasks.filter((t: any) => t.status === "completed" || t.status === "failed").length;
		const totalCount = activeOrPending.length + doneCount;

		// Collapsed: compact format
		if (taskWidgetCollapsed) {
			const lines = [`📋 ${doneCount}/${totalCount} tasks  [Alt+T to expand]`];
			ctx.ui.setWidget("orchestrator-tasks", lines);
			return;
		}

		// Expanded: themed task list
		const lines: string[] = [
			`📋 ${doneCount}/${totalCount} tasks:`,
			...sorted
				.filter((t: any) => t.status !== "completed" && t.status !== "failed")
				.map((t: any) => {
					const desc = t.description.length > 60 ? t.description.slice(0, 60) + "..." : t.description;
					const deps = t.blockedBy?.length ? ` (blocked by ${t.blockedBy.length})` : "";
					const owner = t.owner ? ` [${t.owner}]` : "";
					if (t.status === "in_progress") {
						return `  ${fg("warning", bold("◐ "))}${fg("warning", bold(desc))}${fg("dim", deps + owner)}`;
					}
					if (t.status === "blocked") {
						return `  ${fg("muted", "⛔ ")}${fg("dim", desc)}${fg("dim", deps + owner)}`;
					}
					if (t.status === "failed") {
						return `  ${fg("error", "✗ ")}${fg("error", desc)}${fg("dim", deps + owner)}`;
					}
					return `  ${fg("muted", "☐ ")}${desc}${fg("dim", deps + owner)}`;
				}),
		];

		// Show completed/failed at bottom (dimmed + strikethrough)
		const doneTasks = sorted.filter((t: any) => t.status === "completed" || t.status === "failed");
		if (doneTasks.length > 0 && doneTasks.length <= 3) {
			lines.push("", fg("dim", "── done ──"));
			for (const t of doneTasks) {
				const desc = t.description.length > 50 ? t.description.slice(0, 50) + "..." : t.description;
				const icon = t.status === "completed" ? "☑" : "✗";
				lines.push(`  ${fg("muted", strikethrough(`${icon} ${desc}`))}`);
			}
		} else if (doneTasks.length > 3) {
			lines.push("", fg("muted", `  ── ${doneTasks.length} completed/failed ──`));
		}

		ctx.ui.setWidget("orchestrator-tasks", lines);
	}

	// ---- Helper: setCoordinatorStatus ----
	function setCoordinatorStatus(ctx: any, active: boolean): void {
		coordinatorActive = active;
		if (!ctx?.ui?.setStatus) return;
		if (active) {
			ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
		} else {
			ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
		}
	}

	// ---- Shortcuts ----

	pi.registerShortcut("alt+o", {
		description: "Toggle coordinator mode",
		handler: async (ctx) => {
			setCoordinatorStatus(ctx, !coordinatorActive);
			ctx.ui.notify(
				coordinatorActive
					? "Coordinator mode ENABLED — delegate via delegate_task, track via TaskCreate/TaskUpdate"
					: "Coordinator mode DISABLED",
			);
		},
	});

	pi.registerShortcut("alt+t", {
		description: "Toggle task list collapse",
		handler: async (ctx) => {
			taskWidgetCollapsed = !taskWidgetCollapsed;
			updateTaskWidget(ctx);
		},
	});

	// ---- Coordinator mode: inject prompt ----

	pi.on("before_agent_start", (event: any, ctx: any) => {
		lastCtx = ctx;
		if (coordinatorActive) {
			return {
				systemPrompt: event.systemPrompt + "\n\n" + COORDINATOR_PROMPT,
			};
		}
		return {};
	});

	// ---- Events ----

	pi.on("turn_end", (_event: any, ctx: any) => {
		updateTaskWidget(ctx);
	});

	pi.on("session_start", (_event: any, ctx: any) => {
		lastCtx = ctx;

		// Restore status bar and widget
		if (coordinatorActive) {
			ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
		} else {
			ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
		}
		updateTaskWidget(ctx);

		console.log("[FAN Orchestrator] Session started");
		console.log(
			"[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate, TaskClear",
		);
		if (coordinatorActive) {
			console.log("[FAN Orchestrator] Coordinator mode: ACTIVE");
		}
	});

	pi.on("session_shutdown", (_event: any, ctx: any) => {
		lastCtx = ctx;

		// Abort all active workers
		const active = activeWorkers();
		for (const w of active) {
			updateWorker(w.id, { status: "aborted", endTime: Date.now() });
		}
		_resetRegistry();

		// Clear widgets and status
		ctx.ui.setWidget("orchestrator-tasks", undefined);
		ctx.ui.setStatus("2-orchestrator", undefined);

		const counts = taskManager.getStatusCounts();
		console.log(`[FAN Orchestrator] Session shut down. Tasks: ${JSON.stringify(counts)}`);
	});

	// ---- Permission system ----

	pi.on("tool_call", (event: any, _ctx: any) => {
		// Block dangerous bash commands
		if (event.toolName === "bash") {
			const cmd = event.args?.command as string | undefined;
			if (cmd) {
				const reason = isDangerousCommand(cmd);
				if (reason) {
					return { block: true, reason: `⚠️ Dangerous command: ${reason}` };
				}
			}
		}

		return {};
	});

	// Update widget AFTER tool execution (tool_result), when state has actually changed
	pi.on("tool_result", (event: any, ctx: any) => {
		if (
			event.toolName === "TaskCreate" ||
			event.toolName === "TaskUpdate" ||
			event.toolName === "TaskClear" ||
			event.toolName === "delegate_task" ||
			event.toolName === "cancel_task"
		) {
			queueMicrotask(() => {
				updateTaskWidget(ctx);
			});
		}
	});

	// ---- Slash Command: /orchestrator (enhanced) ----

	pi.registerCommand("orchestrator", {
		description: "Orchestrator control: on, off, stop, config, mode, status",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			switch (sub) {
				case "on": {
					setCoordinatorStatus(ctx, true);
					ctx.ui.notify("FAN Orchestrator active. Coordinator mode ENABLED.");
					return;
				}

				case "off": {
					setCoordinatorStatus(ctx, false);
					ctx.ui.notify("Coordinator mode DISABLED.");
					return;
				}

				case "stop": {
					const active = activeWorkers();
					if (active.length === 0) {
						ctx.ui.notify("No active workers to stop.");
						return;
					}
					for (const w of active) {
						updateWorker(w.id, {
							status: "aborted",
							endTime: Date.now(),
						});
					}
					_resetRegistry();
					ctx.ui.notify(`Stopped ${active.length} worker(s).`);
					return;
				}

				case "config": {
					const configLines: string[] = [
						`📊 ${config.providerMode.toUpperCase()} | Parallel: ${config.parallelWorkers} | Queue: 10 | Worker: ${config.workerTimeout / 1000}s | Plan: ${config.planTimeout / 1000}s | Retries: ${config.maxRetries}`,
						`☁️ ${config.cloud.model} (cloud)`,
						`🏠 ${config.local.model} (local)`,
						"Agent timeouts:",
						...Object.entries(config.agentTimeouts).map(
							([k, v]) => `  ${k}: ${typeof v === "number" ? (v as number) / 1000 + "s" : "default"}`,
						),
						`🚫 Dangerous: ${config.dangerousCommands.length} patterns`,
					];
					ctx.ui.setWidget("orchestrator", configLines);
					setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 10_000);
					return;
				}

				case "mode": {
					const mode = parts[1]?.toLowerCase();
					if (mode !== "cloud" && mode !== "local" && mode !== "auto") {
						ctx.ui.notify("Usage: /orchestrator mode cloud|local|auto");
						return;
					}
					config.providerMode = mode;
					ctx.ui.notify(`Provider mode set to: ${mode}`);
					return;
				}

					case "retry": {
						const failed = taskManager.getTasks().filter((t: any) => t.status === "failed");
						if (failed.length === 0) {
							ctx.ui.notify("No failed tasks to retry.");
							return;
						}
						const last = failed[failed.length - 1];
						if (last.description) {
							ctx.ui.notify(`Retrying failed task: ${last.description.slice(0, 80)}`);
							taskManager.updateTask(last.id, { status: "pending" });
						} else {
							ctx.ui.notify("No retryable task found.");
						}
						return;
					}

				case "status": {
					const counts = taskManager.getStatusCounts();
					const workers = activeWorkers();
					const discovery = discoverAgents(ctx.cwd, "both");
					const statusLines: string[] = [
						`🎭 Orchestration: ${coordinatorActive ? "ON" : "OFF"}`,
						`📡 Provider: ${config.providerMode}`,
						`👷 Active: ${counts.in_progress} / ${config.parallelWorkers} | Queue: ${workers.length}`,
					];

					if (workers.length > 0) {
						statusLines.push("", "── Workers ──");
						for (const w of workers) {
							const elapsed = w.startTime ? Math.round((Date.now() - w.startTime) / 1000) : 0;
							statusLines.push(`  🔄 ${w.id.slice(0, 8)} ${w.agentType} (${w.model ?? "?"}) — ${w.status} [${elapsed}s]`);
						}
					}

					if (taskManager.size > 0) {
						const done = counts.completed + counts.failed;
						statusLines.push("", "── Tasks ──");
						statusLines.push(`  📊 ${done}/${taskManager.size} done`);
						const pending = taskManager.getTasks().filter((t: any) => t.status === "pending" || t.status === "in_progress");
						for (const t of pending.slice(0, 5)) {
							statusLines.push(`  ${t.status === "in_progress" ? "🔄" : "⏳"} ${t.id.slice(0, 8)}: ${t.description.slice(0, 50)}`);
						}
						if (pending.length > 5) statusLines.push(`  ... +${pending.length - 5} more`);
					}

					statusLines.push("", `── Agents ──`);
					statusLines.push(`  Available: ${discovery.agents.length}`);
					for (const a of discovery.agents.slice(0, 4)) {
						statusLines.push(`  • ${a.name} (${a.source})`);
					}
					if (discovery.agents.length > 4) statusLines.push(`  ... +${discovery.agents.length - 4} more`);

					ctx.ui.setWidget("orchestrator", statusLines);
					setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 10_000);
					return;
				}

				default: {
					// No subcommand or unknown — show status summary
					const counts = taskManager.getStatusCounts();
					const lines = [
						"FAN Orchestrator — Controls",
						`Coordinator: ${coordinatorActive ? "ON (Alt+O to toggle)" : "OFF (Alt+O to enable)"}`,
						`Tasks: ${taskManager.size} total (pending=${counts.pending}, active=${counts.in_progress}, done=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked})`,
						"",
						"Subcommands:",
						"  on       — Enable coordinator mode",
						"  off      — Disable coordinator mode",
						"  stop     — Stop all active workers",
						"  config   — Show configuration (widget)",
						"  mode     — Switch provider mode (cloud|local|auto)",
						"  status   — Extended status (widget, 10s)",
						"  retry    — Retry last failed task",
						"",
						"Shortcuts: Alt+O (coordinator), Alt+T (task list)",
						"Commands: /plan, /tasks, /agents, /delegate",
					];
					ctx.ui.notify(lines.join("\n"));
					return;
				}
			}
		},
	});

	// ---- Slash Command: /plan ----

	pi.registerCommand("plan", {
		description: "Generate an implementation plan using a planning worker",
		handler: async (args, ctx) => {
			const taskDescription =
				args.trim() || "Analyze this codebase and create an implementation plan for the current task.";

			const discovery = discoverAgents(ctx.cwd, "both");
			const planAgent = discovery.agents.find((a) => a.name === "plan");

			if (!planAgent) {
				ctx.ui.notify('No "plan" agent found. Make sure agent definitions are available.', "error");
				return;
			}

			/** Extract tool call previews from accumulated messages */
			function extractToolCalls(messages: any[]): string[] {
				const calls: string[] = [];
				for (const msg of messages) {
					if (msg.role !== "assistant" || !msg.content) continue;
					for (const part of msg.content) {
						if (part.type === "toolCall") {
							const name = part.name;
							const args = part.arguments;
							let preview = name;
							if (name === "bash") preview = `${name} ${((args?.command as string) ?? "").slice(0, 50)}`;
							else if (name === "read")
								preview = `${name} ${(args?.file_path ?? args?.path ?? "...").slice(0, 50)}`;
							else if (name === "grep") preview = `${name} /${(args?.pattern as string) ?? ""}/`;
							else if (name === "find") preview = `${name} ${args?.pattern ?? "*"}`;
							else if (name === "ls") preview = `${name} ${args?.path ?? "."}`;
							else if (name === "edit") preview = `${name} ${args?.file_path ?? args?.path ?? "..."}`;
							else if (name === "write")
								preview = `${name} ${args?.file_path ?? args?.path ?? "..."} (${(args?.content as string)?.split("\n").length ?? 0} lines)`;
							if (preview.length > 60) preview = preview.slice(0, 60) + "...";
							calls.push(`  → ${preview}`);
						}
					}
				}
				return calls.slice(-8);
			}

			/** Run plan worker with live progress widget */
			async function runPlanWorker(
				agentCfg: any,
				task: string,
				signal: AbortSignal | undefined,
				headerPrefix: string,
			): Promise<{ output: string; exitCode: number; stderr: string }> {
				const planStartTime = Date.now();
				const statusTimer = setInterval(() => {
					const elapsed = Math.round((Date.now() - planStartTime) / 1000);
					ctx.ui.setStatus("2-orchestrator", `⏳ ${headerPrefix}... ${elapsed}s`);
				}, 3000);

				try {
					let result: any;
					await runSingleAgent(
						ctx.cwd,
						[agentCfg],
						agentCfg.name,
						task,
						undefined,
						undefined,
						signal,
						// onUpdate — live progress callback
						(partial: any) => {
							const details = Array.isArray(partial.details)
								? partial.details[0]
								: partial.details?.results?.[0];
							const msgs = details?.messages ?? [];
							const elapsed = Math.round((Date.now() - planStartTime) / 1000);
							const toolLines = extractToolCalls(msgs);

							const widgetLines: string[] = [
								`📋 ${headerPrefix} · ⏳ ${toolLines.length > 0 ? "Working" : "Thinking"} · ${elapsed}s`,
							];
							if (toolLines.length > 0) {
								widgetLines.push(...toolLines);
							}
							ctx.ui.setWidget("orchestrator-plan", widgetLines);
						},
					).then((r) => {
						result = r;
					});

					return { output: getFinalOutput(result.messages), exitCode: result.exitCode, stderr: result.stderr };
				} finally {
					clearInterval(statusTimer);
				}
			}

			async function approveOrRevise(planText: string, signal: AbortSignal | undefined): Promise<boolean> {
				// Show plan in UI + conversation context WITHOUT triggering an LLM turn
				pi.sendMessage(
					{ customType: "orchestrator-plan-draft", content: planText, display: true },
					{ triggerTurn: false },
				);

				const choice = await ctx.ui.select!("Plan Review", ["✅ Approve", "✏️ Revise", "❌ Reject"]);

				if (choice === "✅ Approve") {
					return true;
				}

				if (choice === "✏️ Revise") {
					const feedback = await ctx.ui.input!("Revision Feedback", "What should be changed in the plan?");
					if (feedback) {
						const revised = await runPlanWorker(
							planAgent!,
							`${taskDescription}\n\n--- Revision Feedback ---\n${feedback}\n\n--- Original Plan ---\n${planText}`,
							signal,
							"Re-plan",
						);
						if (revised.output) {
							return await approveOrRevise(revised.output, signal);
						}
					}
				}

				ctx.ui.notify("Plan rejected.");
				ctx.ui.setWidget("orchestrator-plan", undefined);
				ctx.ui.setStatus("2-orchestrator", coordinatorActive ? "🎭 Coordinator ON" : "");
				return false;
			}

			// Run planning worker with live progress
			const { output, exitCode, stderr } = await runPlanWorker(planAgent, taskDescription, ctx.signal, "Plan");

			ctx.ui.setWidget("orchestrator-plan", undefined);
			ctx.ui.setWorkingMessage(undefined);

			if (exitCode !== 0 || !output) {
				ctx.ui.notify("Plan generation failed: " + (stderr || "no output"), "error");
				return;
			}

			// Approval flow
			const approved = await approveOrRevise(output, ctx.signal);

			if (!approved) return;

			// Enable coordinator, then trigger a new turn with coordinator prompt active
			setCoordinatorStatus(ctx, true);
			pi.sendUserMessage(
				"The plan has been approved. Review the plan above and start implementing it step by step. Use delegate_task to spawn workers for each task. Decompose the plan into tasks using TaskCreate, then implement each one.",
				{ deliverAs: "followUp" },
			);
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
				ctx.ui.notify(
					`No tasks found. Counts: pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}`,
				);
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
			const scope = (args.trim() === "project" ? "project" : args.trim() === "user" ? "user" : "both") as
				| "user"
				| "project"
				| "both";
			const discovery = discoverAgents(ctx.cwd, scope);

			const lines = [
				`Available agents (${discovery.agents.length}):`,
				...discovery.agents.map((a) => `  ${a.name} (${a.source}): ${a.description}`),
			];

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
				ctx.ui.notify(
					"Usage: /delegate <agent> <task description...>\n\nAgents: explore, plan, implement, verify\nExample: /delegate explore Find all API endpoints in the project",
				);
				return;
			}

			const agentName = parts[0];
			const task = parts.slice(1).join(" ");

			const discovery = discoverAgents(ctx.cwd, "both");
			const agent = discovery.agents.find((a) => a.name === agentName);
			if (!agent) {
				const available = discovery.agents.map((a) => a.name).join(", ");
				ctx.ui.notify(`Unknown agent: "${agentName}". Available: ${available}`);
				return;
			}

			ctx.ui.notify(`Delegating to ${agentName}: ${task.slice(0, 80)}...`);
			ctx.ui.notify(
				`Task queued for delegation:\n  Agent: ${agentName}\n  Task: ${task}\n\nThe delegate_task tool will be used on the next turn.`,
			);
		},
	});
};

export default orchestratorExtension;
