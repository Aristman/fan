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
        const tasks = taskManager.getTasks();
        const activeOrFailed = tasks.filter(
            (t) =>
                t.status === "in_progress" ||
                t.status === "pending" ||
                t.status === "blocked" ||
                t.status === "failed",
        );

        if (activeOrFailed.length === 0) {
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

        const sorted = [...activeOrFailed].sort((a, b) => {
            const order: Record<string, number> = {
                in_progress: 0,
                blocked: 1,
                pending: 2,
                failed: 3,
                completed: 4,
            };
            return (order[a.status] ?? 5) - (order[b.status] ?? 5);
        });

        const lines: string[] = taskWidgetCollapsed
            ? [`Orchestrator Tasks (${activeOrFailed.length}) — Alt+T to expand`]
            : [
                  `Orchestrator Tasks (${activeOrFailed.length}):`,
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
                      return `  ${icon} ${desc}${deps}${owner}`;
                  }),
              ];

        ctx.ui.setWidget("orchestrator-tasks", lines);
    }

    // ---- Helper: setCoordinatorStatus ----
    function setCoordinatorStatus(ctx: any, active: boolean): void {
        coordinatorActive = active;
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

    pi.on("before_agent_start", (event: any) => {
        if (coordinatorActive) {
            return {
                systemPrompt: event.systemPrompt + "\n\n" + COORDINATOR_PROMPT,
            };
        }
        return {};
    });

    // ---- Events ----

    pi.on("turn_end", () => {
        if (lastCtx) {
            updateTaskWidget(lastCtx);
        }
    });

    pi.on("session_start", (event: any) => {
        lastCtx = event.ctx ?? event;

        // Restore status bar and widget
        if (coordinatorActive) {
            lastCtx.ui.setStatus("2-orchestrator", "🔄 Coordinator");
        }
        updateTaskWidget(lastCtx);

        console.log("[FAN Orchestrator] Session started");
        console.log(
            "[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate",
        );
        if (coordinatorActive) {
            console.log("[FAN Orchestrator] Coordinator mode: ACTIVE");
        }
    });

    pi.on("session_shutdown", () => {
        // Abort all active workers
        const active = activeWorkers();
        for (const w of active) {
            updateWorker(w.id, { status: "aborted", endTime: Date.now() });
        }
        _resetRegistry();

        // Clear widgets and status
        if (lastCtx) {
            lastCtx.ui.setWidget("orchestrator-tasks", undefined);
            lastCtx.ui.setStatus("2-orchestrator", undefined);
        }

        const counts = taskManager.getStatusCounts();
        console.log(
            `[FAN Orchestrator] Session shut down. Tasks: ${JSON.stringify(counts)}`,
        );
    });

    // ---- Permission system ----

    pi.on("tool_call", (event: any) => {
        // Update widget on TaskCreate/TaskUpdate
        if (event.toolName === "TaskCreate" || event.toolName === "TaskUpdate") {
            queueMicrotask(() => {
                if (lastCtx) updateTaskWidget(lastCtx);
            });
        }

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

            ctx.ui.setWorkingMessage("Generating plan...");

            const workerId = genWorkerId();
            registerWorker({
                id: workerId,
                agentType: "plan",
                status: "spawning",
                startTime: Date.now(),
                task: taskDescription,
            });
            updateWorker(workerId, { status: "running" });

            try {
                const result = await runSingleAgent(
                    ctx.cwd,
                    [planAgent],
                    planAgent.name,
                    taskDescription,
                    undefined,
                    undefined,
                    ctx.signal,
                    undefined,
                );

                const output = getFinalOutput(result.messages);
                const isSuccess = result.exitCode === 0 && output;

                updateWorker(workerId, {
                    status: isSuccess ? "completed" : "failed",
                    endTime: Date.now(),
                    result: output,
                    error: isSuccess
                        ? undefined
                        : result.stderr || "No output from plan agent",
                });

                if (!isSuccess) {
                    ctx.ui.notify(
                        "Plan generation failed: " +
                            (result.stderr || "no output"),
                        "error",
                    );
                    return;
                }

                // Show plan to user
                ctx.ui.setWorkingMessage(undefined);
                pi.sendUserMessage(output);

                // Ask for approval
                const choice = await ctx.ui.select("Plan Review", [
                    "Approve",
                    "Revise",
                    "Reject",
                ]);

                if (choice === "Approve") {
                    setCoordinatorStatus(ctx, true);
                    ctx.ui.notify(
                        "Plan approved. Coordinator mode enabled. Decomposing into tasks...",
                    );
                    pi.sendUserMessage(
                        "The plan has been approved. Decompose it into tasks using TaskCreate, then implement step by step.",
                        { deliverAs: "steer" },
                    );
                } else if (choice === "Revise") {
                    const feedback = await ctx.ui.input(
                        "Revision Feedback",
                        "What should be changed in the plan?",
                    );
                    if (feedback) {
                        pi.sendUserMessage(
                            `Please revise the plan with this feedback: ${feedback}\n\nOriginal plan:\n${output}`,
                            { deliverAs: "steer" },
                        );
                    }
                } else {
                    ctx.ui.notify("Plan rejected.");
                }
            } catch (e: any) {
                updateWorker(workerId, {
                    status: "aborted",
                    endTime: Date.now(),
                    error: e.message,
                });
                ctx.ui.notify("Plan generation failed: " + e.message, "error");
            } finally {
                ctx.ui.setWorkingMessage(undefined);
            }
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
