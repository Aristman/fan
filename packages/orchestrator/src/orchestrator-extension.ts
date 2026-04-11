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
import { TaskManager } from "./task-manager.js";
import { discoverAgents } from "./agents.js";
import { COORDINATOR_PROMPT } from "./agents.js";
import { registerOrchestratorTools } from "./orchestrator-tools.js";
import { loadConfig } from "./config.js";
import { isDangerousCommand } from "./permissions.js";
import {
    genWorkerId,
    registerWorker,
    activeWorkers,
    updateWorker,
    _resetRegistry,
} from "./workers.js";
import {
    runSingleAgent,
    getFinalOutput,
} from "./subagent-runner.js";
import type { OrchestratorConfig } from "./types.js";

export const orchestratorExtension: ExtensionFactory = (pi) => {
    // ---- Infrastructure setup ----
    const config: OrchestratorConfig = loadConfig();
    const taskManager = new TaskManager();

    // Register tools (delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate)
    registerOrchestratorTools(pi, taskManager);

    // ---- State ----
    let coordinatorActive = false;
    let taskWidgetCollapsed = false;
    let lastCtx: any = undefined;

    // ---- Helper: updateTaskWidget ----
    function updateTaskWidget(ctx: any): void {
        if (!ctx?.ui?.setWidget) return;

        const tasks = taskManager.getTasks();

        if (tasks.length === 0) {
            ctx.ui.setWidget("orchestrator-tasks", undefined);
            return;
        }

        const statusIcons: Record<string, string> = {
            pending: "☐",
            in_progress: "◐",
            completed: "☑",
            blocked: "⛔",
            failed: "✗",
        };

        const isDone = (t: any) => t.status === "completed" || t.status === "failed";

        const sorted = [...tasks].sort((a, b) => {
            const order: Record<string, number> = {
                in_progress: 0,
                pending: 1,
                blocked: 2,
                completed: 3,
                failed: 4,
            };
            return (order[a.status] ?? 5) - (order[b.status] ?? 5);
        });

        const activeCount = tasks.filter((t) => !isDone(t)).length;
        const doneCount = tasks.filter((t) => isDone(t)).length;

        const lines: string[] = taskWidgetCollapsed
            ? [`Orchestrator Tasks (${activeCount} active, ${doneCount} done) — Alt+T to expand`]
            : [
                  `Orchestrator Tasks (${activeCount} active, ${doneCount} done):`,
                  ...sorted.map((t) => {
                      const icon = statusIcons[t.status] ?? "?";
                      const desc =
                          t.description.length > 55
                              ? t.description.slice(0, 55) + "..."
                              : t.description;
                      const deps = t.blockedBy?.length
                          ? ` (blocked by ${t.blockedBy.length})`
                          : "";
                      const owner = t.owner ? ` [${t.owner}]` : "";

                      if (isDone(t)) {
                          return `  \x1b[2m\x1b[9m${icon} ${desc}${deps}${owner}\x1b[0m`;
                      }
                      if (t.status === "in_progress") {
                          return `  \x1b[92m${icon} ${desc}${deps}${owner}\x1b[0m`;
                      }
                      return `  ${icon} ${desc}${deps}${owner}`;
                  }),
              ];

        ctx.ui.setWidget("orchestrator-tasks", lines);
    }

    // ---- Helper: setCoordinatorStatus ----
    function setCoordinatorStatus(ctx: any, active: boolean): void {
        coordinatorActive = active;
        if (!ctx?.ui?.setStatus) return;
        if (active) {
            ctx.ui.setStatus("2-orchestrator", "🔄 Coordinator");
        } else {
            ctx.ui.setStatus("2-orchestrator", undefined);
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
            ctx.ui.setStatus("2-orchestrator", "🔄 Coordinator");
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
        console.log(
            `[FAN Orchestrator] Session shut down. Tasks: ${JSON.stringify(counts)}`,
        );
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
        description:
            "Orchestrator control: on, off, stop, config, mode, status",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0]?.toLowerCase();

            switch (sub) {
                case "on": {
                    setCoordinatorStatus(ctx, true);
                    ctx.ui.notify(
                        "FAN Orchestrator active. Coordinator mode ENABLED.",
                    );
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
                    const lines = [
                        "FAN Orchestrator — Configuration",
                        `Provider mode: ${config.providerMode}`,
                        `Cloud model: ${config.cloud.model}`,
                        `Local model: ${config.local.model}`,
                        `Parallel workers: ${config.parallelWorkers}`,
                        `Worker timeout: ${config.workerTimeout / 1000}s`,
                        `Max retries: ${config.maxRetries}`,
                        `Plan timeout: ${config.planTimeout / 1000}s`,
                        "Agent timeouts:",
                        ...Object.entries(config.agentTimeouts).map(
                            ([k, v]) =>
                                `  ${k}: ${typeof v === "number" ? (v as number) / 1000 + "s" : "default"}`,
                        ),
                        `Dangerous commands: ${config.dangerousCommands.length} patterns`,
                    ];
                    ctx.ui.notify(lines.join("\n"));
                    return;
                }

                case "mode": {
                    const mode = parts[1]?.toLowerCase();
                    if (
                        mode !== "cloud" &&
                        mode !== "local" &&
                        mode !== "auto"
                    ) {
                        ctx.ui.notify(
                            "Usage: /orchestrator mode cloud|local|auto",
                        );
                        return;
                    }
                    config.providerMode = mode;
                    ctx.ui.notify(`Provider mode set to: ${mode}`);
                    return;
                }

                case "status": {
                    const counts = taskManager.getStatusCounts();
                    const workers = activeWorkers();
                    const discovery = discoverAgents(ctx.cwd, "both");
                    const lines = [
                        "FAN Orchestrator — Status",
                        `Coordinator: ${coordinatorActive ? "ON" : "OFF"}`,
                        `Provider mode: ${config.providerMode}`,
                        "",
                        `Tasks: ${taskManager.size} total`,
                        `  Pending: ${counts.pending} | In Progress: ${counts.in_progress} | Completed: ${counts.completed} | Failed: ${counts.failed} | Blocked: ${counts.blocked}`,
                        "",
                        `Active workers: ${workers.length}`,
                        ...workers.map(
                            (w) =>
                                `  [${w.status}] ${w.id.slice(0, 8)} ${w.agentType}: ${w.task?.slice(0, 60) ?? "(no task)"}`,
                        ),
                        "",
                        `Available agents: ${discovery.agents.length}`,
                        ...discovery.agents
                            .slice(0, 5)
                            .map(
                                (a) =>
                                    `  ${a.name} (${a.source}): ${a.description}`,
                            ),
                        discovery.agents.length > 5
                            ? `  ... +${discovery.agents.length - 5} more`
                            : "",
                    ];
                    ctx.ui.notify(lines.join("\n"));
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
                        "  config   — Show configuration",
                        "  mode     — Switch provider mode (cloud|local|auto)",
                        "  status   — Extended status with workers + tasks",
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
        description:
            "Generate an implementation plan using a planning worker",
        handler: async (args, ctx) => {
            const taskDescription =
                args.trim() ||
                "Analyze this codebase and create an implementation plan for the current task.";

            const discovery = discoverAgents(ctx.cwd, "both");
            const planAgent = discovery.agents.find((a) => a.name === "plan");

            if (!planAgent) {
                ctx.ui.notify(
                    'No "plan" agent found. Make sure agent definitions are available.',
                    "error",
                );
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
                            else if (name === "read") preview = `${name} ${((args?.file_path ?? args?.path) ?? "...").slice(0, 50)}`;
                            else if (name === "grep") preview = `${name} /${((args?.pattern as string) ?? "")}/`;
                            else if (name === "find") preview = `${name} ${(args?.pattern ?? "*")}`;
                            else if (name === "ls") preview = `${name} ${(args?.path ?? ".")}`;
                            else if (name === "edit") preview = `${name} ${(args?.file_path ?? args?.path) ?? "..."}`;
                            else if (name === "write") preview = `${name} ${(args?.file_path ?? args?.path) ?? "..."} (${((args?.content as string)?.split("\n").length ?? 0)} lines)`;
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
                        undefined, undefined, signal,
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
                    ).then((r) => { result = r; });

                    return { output: getFinalOutput(result.messages), exitCode: result.exitCode, stderr: result.stderr };
                } finally {
                    clearInterval(statusTimer);
                }
            }

            async function approveOrRevise(
                planText: string,
                signal: AbortSignal | undefined,
            ): Promise<boolean> {
                // Show plan in UI + conversation context WITHOUT triggering an LLM turn
                pi.sendMessage(
                    { customType: "orchestrator-plan-draft", content: planText, display: true },
                    { triggerTurn: false },
                );

                const choice = await ctx.ui.select!("Plan Review", [
                    "✅ Approve",
                    "✏️ Revise",
                    "❌ Reject",
                ]);

                if (choice === "✅ Approve") {
                    return true;
                }

                if (choice === "✏️ Revise") {
                    const feedback = await ctx.ui.input!(
                        "Revision Feedback",
                        "What should be changed in the plan?",
                    );
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
            const { output, exitCode, stderr } = await runPlanWorker(
                planAgent, taskDescription, ctx.signal, "Plan",
            );

            ctx.ui.setWidget("orchestrator-plan", undefined);
            ctx.ui.setWorkingMessage(undefined);

            if (exitCode !== 0 || !output) {
                ctx.ui.notify(
                    "Plan generation failed: " + (stderr || "no output"),
                    "error",
                );
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
            const tasks = taskManager.getTasks(
                statusFilter ? { status: statusFilter as any } : undefined,
            );
            const counts = taskManager.getStatusCounts();

            if (tasks.length === 0) {
                ctx.ui.notify(
                    `No tasks found. Counts: pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}`,
                );
                return;
            }

            const lines = tasks.map((t) => {
                const result = t.result
                    ? ` → ${t.result.slice(0, 60)}`
                    : "";
                const error = t.error ? ` [${t.error}]` : "";
                return `[${t.status}] ${t.id.slice(0, 8)} ${t.agentType}: ${t.description.slice(0, 80)}${error}${result}`;
            });

            ctx.ui.notify(
                [
                    `Tasks (${tasks.length}):`,
                    ...lines,
                    "",
                    `Counts: ${JSON.stringify(counts)}`,
                ].join("\n"),
            );
        },
    });

    // ---- Slash Command: /agents ----

    pi.registerCommand("agents", {
        description: "List available agents (built-in, user, project)",
        handler: async (args, ctx) => {
            const scope =
                (args.trim() === "project"
                    ? "project"
                    : args.trim() === "user"
                      ? "user"
                      : "both") as "user" | "project" | "both";
            const discovery = discoverAgents(ctx.cwd, scope);

            const lines = [
                `Available agents (${discovery.agents.length}):`,
                ...discovery.agents.map(
                    (a) =>
                        `  ${a.name} (${a.source}): ${a.description}`,
                ),
            ];

            if (discovery.projectAgentsDir) {
                lines.push(
                    `\nProject agents dir: ${discovery.projectAgentsDir}`,
                );
            }

            ctx.ui.notify(lines.join("\n"));
        },
    });

    // ---- Slash Command: /delegate ----

    pi.registerCommand("delegate", {
        description:
            "Quick delegate a task to an agent: /delegate <agent> <task>",
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
                const available = discovery.agents
                    .map((a) => a.name)
                    .join(", ");
                ctx.ui.notify(
                    `Unknown agent: "${agentName}". Available: ${available}`,
                );
                return;
            }

            ctx.ui.notify(
                `Delegating to ${agentName}: ${task.slice(0, 80)}...`,
            );
            ctx.ui.notify(
                `Task queued for delegation:\n  Agent: ${agentName}\n  Task: ${task}\n\nThe delegate_task tool will be used on the next turn.`,
            );
        },
    });
};

export default orchestratorExtension;
