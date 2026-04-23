/**
 * FAN Orchestrator v2 — Multi-agent orchestration for FAN
 *
 * Architecture: Extension (coordinator) → child_process.spawn("fan --rpc") → workers
 *
 * Adapted from pi-orchestrator for FAN platform:
 * - Uses @itone/fan-coding-agent ExtensionAPI
 * - Uses @itone/fan-tui for TUI components
 * - Uses @sinclair/typebox for parameter schemas
 * - Spawns "fan" binary instead of "pi"
 * - Uses StringEnum from @itone/fan-ai for Google API compatibility
 */

import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@itone/fan-coding-agent";
import { StringEnum } from "@itone/fan-ai";
import { Type } from "@sinclair/typebox";
import { Markdown, Text, Container } from "@itone/fan-tui";
import type { TaskStatus, WorkerProgress } from "./types.js";

import { loadConfig, resolveModel, getCloudHealthCached, configExists, saveConfig } from "./config.js";
import { createTask, updateTask, listTasks, formatTaskList, taskCount, parseVerdict, clearTasks } from "./tasks.js";
import {
  genWorkerId, registerWorker, getWorker, listWorkers, activeWorkers,
  updateWorker, acquireSlot, releaseSlot, getQueueLength,
  statusIcon, statusColor,
} from "./workers.js";
import { isDangerousCommand } from "./permissions.js";
import { AGENT_DEFINITIONS, buildCoordinatorPrompt, PLANNING_PROMPT, formatTaskNotification } from "./agents.js";
import { runWorkerWithFallback } from "./rpc.js";

// ============================================================================
// Entry Point
// ============================================================================

const coordinatorPrompt = buildCoordinatorPrompt();

// ── Worker widget helpers ─────────────────────────────────────────────────

function formatToolCallsForWidget(
  toolCalls: { name: string; preview: string }[] | undefined,
  maxItems: number = 12,
): string[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const lines: string[] = [];
  const toShow = toolCalls.filter(tc => tc.preview).slice(-maxItems);
  const skipped = toolCalls.filter(tc => tc.preview).length - toShow.length;
  if (skipped > 0) lines.push(`  ... ${skipped} earlier`);
  for (const tc of toShow) {
    lines.push(`  → ${tc.preview}`);
  }
  return lines;
}

function buildWorkerStatusText(
  agentType: string,
  task: string,
  model: string,
  progress?: WorkerProgress,
  startTimeMs?: number,
): string {
  const icon = AGENT_DEFINITIONS[agentType]?.icon ?? "🤖";
  const statusText = progress?.status ?? "Spawning";
  const toolCallCount = progress?.toolCalls?.length ?? 0;
  const messageCount = progress?.messageCount ?? 0;

  const elapsed = Math.max(0, startTimeMs != null ? Math.floor((Date.now() - startTimeMs) / 1000) : 0);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const elapsedStr = mins >= 60
    ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  const lines: string[] = [
    `${icon} ${agentType.toUpperCase()} worker (${model})`,
    task.length > 80 ? `${task.slice(0, 80)}...` : task,
    `${statusText} · ${toolCallCount} tool calls · ${messageCount} messages · ${elapsedStr}`,
  ];

  const toolLines = formatToolCallsForWidget(progress?.toolCalls);
  if (toolLines.length > 0) {
    lines.push("", "Tools:");
    lines.push(...toolLines);
  }

  return lines.join("\n");
}

// ── Entry Point ─────────────────────────────────────────────────────────────

export default function (fan: ExtensionAPI) {
  let config = loadConfig();
  let coordinatorActive = true;
  let taskWidgetCollapsed = false;

  /** Update the task checklist widget */
  function updateTaskWidget(ctx: ExtensionContext | null): void {
    if (!ctx) return;
    const tasks = listTasks();

    const activeOrPending = tasks.filter((t) => t.status !== "completed" && t.status !== "failed");
    if (tasks.length === 0 || activeOrPending.length === 0) {
      clearTasks();
      ctx.ui.setWidget("orchestrator-tasks", undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const total = tasks.length;

    if (taskWidgetCollapsed) {
      ctx.ui.setWidget("orchestrator-tasks", [
        `📋 ${completed}/${total} tasks  ${theme.fg("dim", "[Alt+T to expand]")}`,
      ]);
      return;
    }

    const lines: string[] = [
      `📋 ${completed}/${total} tasks  ${theme.fg("dim", "[Alt+T to collapse]")}`,
    ];

    const activeTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "failed");
    const failedTasks = tasks.filter((t) => t.status === "failed");
    const completedTasks = tasks.filter((t) => t.status === "completed");

    for (const task of activeTasks) {
      switch (task.status) {
        case "in_progress":
          lines.push(
            theme.fg("warning", theme.bold("◐ ")) + theme.fg("warning", theme.bold(truncate(task.subject, 55))),
          );
          break;
        case "blocked":
          lines.push(
            theme.fg("muted", "⛔ ") + theme.fg("dim", truncate(task.subject, 55)),
          );
          break;
        default:
          lines.push(
            theme.fg("muted", "☐ ") + truncate(task.subject, 55),
          );
          break;
      }
    }

    for (const task of failedTasks) {
      lines.push(
        theme.fg("error", "✗ ") + theme.fg("error", truncate(task.subject, 55)),
      );
    }

    for (const task of completedTasks) {
      lines.push(
        theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(truncate(task.subject, 55))),
      );
    }

    ctx.ui.setWidget("orchestrator-tasks", lines);
  }

  function truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  // ── Shortcuts ────────────────────────────────────────────────────────────

  fan.registerShortcut("alt+o", {
    description: "Toggle orchestrator coordinator",
    handler: (ctx) => {
      coordinatorActive = !coordinatorActive;
      if (coordinatorActive) {
        ctx.ui.notify("Coordinator ON ⚡");
        ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
      } else {
        ctx.ui.notify("Coordinator OFF");
        ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
      }
    },
  });

  fan.registerShortcut("alt+t", {
    description: "Toggle task list collapse",
    handler: (ctx) => {
      taskWidgetCollapsed = !taskWidgetCollapsed;
      updateTaskWidget(ctx);
    },
  });

  // ── Tools: TaskCreate, TaskUpdate, TaskList ───────────────────────────────

  fan.registerTool({
    name: "TaskCreate",
    label: "Create Task",
    description: "Create a tracked task for decomposition. Tasks can block each other via the blocks parameter.",
    promptSnippet: "Create a tracked task",
    parameters: Type.Object({
      subject: Type.String({ description: "Short description of the task" }),
      description: Type.Optional(Type.String({ description: "Detailed description" })),
      owner: Type.Optional(Type.String({ description: "Worker ID that owns this task" })),
      blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks (creates dependency)" })),
    }),
    async execute(_toolCallId, params) {
      const task = createTask({ subject: params.subject, description: params.description, owner: params.owner, blocks: params.blocks });
      return { content: [{ type: "text", text: `✅ Task created: ${task.id} [${task.status}] — ${task.subject}` }], details: { taskId: task.id } };
    },
  });

  fan.registerTool({
    name: "TaskUpdate",
    label: "Update Task",
    description: "Update a task's status, subject, description, or blocks. Completing a task auto-unblocks dependents.",
    promptSnippet: "Update a task status, details, or add dependency blocks",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "blocked", "failed"] as const, { description: "New status" })),
      subject: Type.Optional(Type.String({ description: "New subject" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
    }),
    async execute(_toolCallId, params) {
      const updated = updateTask(params.taskId, {
        status: params.status as TaskStatus | undefined,
        subject: params.subject,
        description: params.description,
        blocks: params.blocks,
      });
      if (!updated) return { content: [{ type: "text", text: `Task "${params.taskId}" not found.` }], details: {} };
      const unblocked = updated.status === "completed"
        ? listTasks({ status: "pending" }).filter((t) => !t.blockedBy.includes(params.taskId))
        : [];
      let text = `✅ ${updated.id} → ${updated.status} — ${updated.subject}`;
      if (unblocked.length > 0) {
        text += `\n🔓 Unblocked: ${unblocked.map((t) => t.id).join(", ")}`;
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  fan.registerTool({
    name: "TaskList",
    label: "List Tasks",
    description: "List all tracked tasks, optionally filtered by status or owner.",
    promptSnippet: "List tracked tasks",
    parameters: Type.Object({
      status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "blocked", "failed"] as const, { description: "Filter by status" })),
      owner: Type.Optional(Type.String({ description: "Filter by worker ID" })),
    }),
    async execute(_toolCallId, params) {
      const tasks = listTasks({
        status: params.status as TaskStatus | undefined,
        owner: params.owner,
      });
      const text = formatTaskList(tasks);
      const summary = `Total: ${taskCount()} | Showing: ${tasks.length}`;
      return { content: [{ type: "text", text: `${text}\n\n${summary}` }], details: {} };
    },
  });

  // ── Tools: Agent, SendMessage, StopAgent ──────────────────────────────────

  fan.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Spawn a worker agent for a task. Types: explore, plan, implement, verify, bug-fix, code-research, tests-impl, docs-impl. Workers don't see this conversation — make prompts self-contained.",
    promptSnippet: "Spawn a worker agent (explore/plan/implement/verify/bug-fix/code-research)",
    parameters: Type.Object({
      agentType: StringEnum(Object.keys(AGENT_DEFINITIONS) as [string, ...string[]]),
      task: Type.String({ description: "Detailed task description for the worker" }),
      context: Type.Optional(
        Type.String({ description: "Additional context (file paths, prior findings, etc.)" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!coordinatorActive) {
        return {
          content: [{ type: "text", text: "Coordinator mode is off. Use /orchestrator on to enable." }],
          details: {},
        };
      }

      // Acquire slot — waits in queue if pool is full
      await acquireSlot(params.agentType, config.parallelWorkers);

      const def = AGENT_DEFINITIONS[params.agentType];
      const workerId = genWorkerId();
      const model = resolveModel(params.agentType, config);

      // Auto-create a task for this worker
      const taskSubject = params.task.slice(0, 80);
      const task = createTask({ subject: taskSubject, description: params.task.slice(0, 500), owner: workerId });
      updateTask(task.id, { status: "in_progress" });

      const startTime = Date.now();
      registerWorker({ id: workerId, agentType: params.agentType, model, status: "spawning", startTime });
      updateWorker(workerId, { status: "running" });

      const sendUpdate = (progress?: WorkerProgress) => {
        onUpdate?.({ content: [{ type: "text", text: buildWorkerStatusText(params.agentType, params.task, model, progress, startTime) }], details: {} });
      };
      sendUpdate();

      try {
        const cwd = ctx.cwd;
        const scopedTask = `Working directory: ${cwd}\n\n${params.task}`;
        const fullTask = params.context
          ? `${scopedTask}\n\n## Additional Context\n${params.context}`
          : scopedTask;

        const result = await runWorkerWithFallback(
          params.agentType,
          def.prompt,
          def.tools,
          fullTask,
          config,
          {
            signal,
            cwd,
            onProgress: (progress: WorkerProgress) => {
              sendUpdate(progress);
            },
          },
          config.stallTimeout,
        );

        updateWorker(workerId, { status: "completed", endTime: Date.now(), result: result.text });
        releaseSlot(params.agentType, config.parallelWorkers);

        updateTask(task.id, { status: "completed" });
        let verdictLine = "";
        if (params.agentType === "verify") {
          const verdict = parseVerdict(result.text);
          if (verdict) verdictLine = `\n🔍 Verification verdict: **VERDICT: ${verdict}**`;
        }

        const notification = formatTaskNotification(workerId, params.agentType, model, "completed", result, startTime);
        return {
          content: [{ type: "text", text: notification + verdictLine }],
          details: { workerId, agentType: params.agentType, messageCount: result.messageCount, taskId: task.id },
        };
      } catch (err: any) {
        updateWorker(workerId, { status: "failed", endTime: Date.now(), error: err.message });
        releaseSlot(params.agentType, config.parallelWorkers);

        updateTask(task.id, { status: "failed" });
        const notification = formatTaskNotification(
          workerId, params.agentType, model, "failed",
          { text: `Error: ${err.message}`, messageCount: 0 }, startTime,
        );
        return {
          content: [{ type: "text", text: notification }],
          details: { workerId, error: err.message },
        };
      }
    },

    renderCall(args, theme, context) {
      const agentType = args.agentType as string;
      context.state.agentType = agentType;
      context.state.model = resolveModel(agentType, config);
      const icon = AGENT_DEFINITIONS[agentType]?.icon ?? "🤖";
      const task = args.task as string;
      const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
      return new Text(
        `${icon} ${theme.bold(agentType.toUpperCase())} worker  ${theme.fg("dim", preview)}`,
        0, 0,
      );
    },

    renderResult(result, options, theme, context) {
      const { isPartial } = options ?? {};
      const raw = typeof result.content?.[0] === "string"
        ? result.content[0]
        : result.content?.[0]?.type === "text"
          ? result.content[0].text
          : "";

      const agentType = context?.state?.agentType ?? "";
      const model = context?.state?.model ?? "";
      const icon = AGENT_DEFINITIONS[agentType]?.icon ?? "🤖";

      // In-progress: show the worker status text directly
      if (isPartial) {
        if (!raw) return new Container();
        return new Text(raw, 0, 0);
      }

      // Completed/failed: extract from XML notification
      if (!raw) return new Text("(no output)", 0, 0);

      const status = raw.match(/<status>([^<]*)<\/status>/)?.[1] ?? "failed";
      const messageCount = raw.match(/<message_count>([^<]*)<\/message_count>/)?.[1] ?? "";
      const duration = raw.match(/<duration_ms>([^<]*)<\/duration_ms>/)?.[1] ?? "";

      // Extract worker output directly from <result> tag
      const workerOutput = raw.match(/<result>([\s\S]*)<\/result>/)?.[1]?.trim() ?? "";

      const isSuccess = status === "completed";
      const statusIconText = isSuccess ? theme.fg("success", "✓") : theme.fg("error", "✗");

      const header = `${statusIconText} ${icon} ${theme.bold(agentType.toUpperCase())} ${theme.fg("dim", `(${model})`)}`;
      const footer = messageCount ? (() => {
        let text = `${messageCount} messages`;
        if (duration) {
          const totalSecs = Math.max(0, Math.floor(parseInt(duration, 10) / 1000));
          const mins = Math.floor(totalSecs / 60);
          const secs = totalSecs % 60;
          const elapsedStr = mins >= 60
            ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
            : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
          text += ` · ${elapsedStr}`;
        }
        return theme.fg("dim", text);
      })() : "";

      const headerComp = new Text(`${header}\n`, 0, 0);
      const container = new Container();
      container.addChild(headerComp);

      if (workerOutput) {
        container.addChild(new Markdown(workerOutput, 0, 0, getMarkdownTheme()));
      }

      if (footer) {
        container.addChild(new Text(`\n${footer}`, 0, 0));
      }

      return container;
    },
  });

  fan.registerTool({
    name: "SendMessage",
    label: "Send Message to Worker",
    description: "Send a follow-up message to a running worker via RPC steer command.",
    parameters: Type.Object({
      workerId: Type.String({ description: "Worker ID (from task-notification)" }),
      message: Type.String({ description: "Message to send" }),
    }),
    async execute(_toolCallId, params) {
      const w = getWorker(params.workerId);
      if (!w) {
        return { content: [{ type: "text", text: `Worker not found. Only running workers can receive messages.` }], details: {} };
      }
      if (w.status !== "running") {
        return { content: [{ type: "text", text: `Worker ${w.id} is ${w.status}, not running.` }], details: {} };
      }
      return {
        content: [{ type: "text", text: `Worker ${w.id} received steer message. (Note: synchronous workers complete before this can be called.)` }],
        details: {},
      };
    },
  });

  fan.registerTool({
    name: "StopAgent",
    label: "Stop Agent",
    description: "Stop a running or spawning worker immediately.",
    parameters: Type.Object({
      workerId: Type.String({ description: "Worker ID to stop" }),
      reason: Type.Optional(Type.String({ description: "Reason for stopping" })),
    }),
    async execute(_toolCallId, params) {
      const id = params.workerId;
      const reason = params.reason;
      const w = getWorker(id);
      if (!w) {
        return { content: [{ type: "text", text: `Worker "${id}" not found.` }], details: {} };
      }
      if (w.status !== "running" && w.status !== "spawning") {
        return { content: [{ type: "text", text: `Worker "${id}" is already ${w.status}.` }], details: {} };
      }
      updateWorker(id, { status: "aborted", endTime: Date.now() });
      const reasonText = reason ? ` Reason: ${reason}` : "";
      return { content: [{ type: "text", text: `Worker ${id} aborted.${reasonText}` }], details: {} };
    },
  });

  // ── Coordinator mode: inject system prompt ────────────────────────────────

  fan.on("before_agent_start", (event) => {
    if (!coordinatorActive) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + coordinatorPrompt,
    };
  });

  // ── /plan command ────────────────────────────────────────────────────────

  async function approveOrRevise(
    fan: ExtensionAPI,
    ctx: ExtensionContext,
    planText: string,
    task: string,
    onApprove?: () => void,
  ): Promise<boolean> {
    fan.sendMessage(
      { customType: "orchestrator-plan-draft", content: planText, display: true },
      { triggerTurn: false },
    );

    ctx.ui.setWidget("orchestrator", [
      "📋 ORCHESTRATOR — Plan Ready",
      "",
      `Mode: ${config.providerMode}`,
      `Plan: ${planText.length} chars`,
      "",
      "↓ Select action",
    ]);

    const choice = await ctx.ui.select("What to do with this plan?", [
      "✅ Approve — inject into conversation",
      "✏️ Revise — provide feedback",
      "❌ Reject — discard",
    ]);

    if (choice === "✅ Approve — inject into conversation") {
      ctx.ui.notify("Plan approved ✅");
      onApprove?.();
      fan.sendUserMessage(
        "The plan has been approved. Review the plan above and start implementing it step by step. Use the Agent tool to spawn workers for each task. Decompose the plan into tasks using TaskCreate, then implement each one.",
        { deliverAs: "followUp" },
      );
      return true;
    }

    if (choice === "✏️ Revise — provide feedback") {
      const feedback = await ctx.ui.input("Revision feedback:", "e.g., add more detail on error handling...");
      if (feedback?.trim()) {
        ctx.ui.setWidget("orchestrator", [
          "📋 ORCHESTRATOR — Re-planning...",
          `Mode: ${config.providerMode}`,
          "",
          "⏳ Generating revised plan...",
        ]);
        ctx.ui.setStatus("2-orchestrator", "⏳ Re-planning...");

        const revisedTask = `Working directory: ${ctx.cwd}\n\n${task}\n\n## Revision Request\nThe previous plan needs changes:\n${feedback.trim()}`;
        const revised = await runWorkerWithFallback(
          "explore", PLANNING_PROMPT, ["read", "bash", "grep", "find", "ls"], revisedTask, config,
          {
            cwd: ctx.cwd,
            onProgress: (p) => {
              const toolCount = p.toolCalls?.length ?? 0;
              const lines: string[] = [`📋 Re-plan · ${config.providerMode} · ⏳ ${p.status} · ${toolCount} calls`];
              const toolLines = formatToolCallsForWidget(p.toolCalls, 7);
              if (toolLines.length > 0) {
                lines.push(...toolLines);
              }
              ctx.ui.setWidget("orchestrator", lines);
            },
          },
          config.stallTimeout,
        );

        if (revised.text?.trim()) {
          return approveOrRevise(fan, ctx, revised.text, task, onApprove);
        }
      }
      return false;
    }

    ctx.ui.notify("Plan discarded");
    return false;
  }

  fan.registerCommand("plan", {
    description: "Plan mode: explore codebase and create implementation plan",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /plan <task description>", "warning");
        return;
      }

      const task = args.trim();
      const startTime = Date.now();
      const scopedTask = `Working directory: ${ctx.cwd}\n\n${task}`;

      ctx.ui.setWidget("orchestrator", [
        "📋 ORCHESTRATOR — Plan Mode",
        "",
        `Task: ${task.length > 55 ? task.slice(0, 55) + "..." : task}`,
        `Mode: ${config.providerMode}`,
        "",
        `⏳ Spawning worker (${config.providerMode})...`,
      ]);
      ctx.ui.setStatus("2-orchestrator", "⏳ Planning...");

      const statusTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        ctx.ui.setStatus("2-orchestrator", `⏳ Planning... ${elapsed}s`);
      }, 5000);

      try {
        const result = await runWorkerWithFallback(
          "explore", PLANNING_PROMPT, ["read", "bash", "grep", "find", "ls"], scopedTask, config,
          {
            cwd: ctx.cwd,
            onProgress: (p) => {
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              const toolCount = p.toolCalls?.length ?? 0;
              const lines: string[] = [
                `📋 Plan · ${config.providerMode} · ⏳ ${p.status} · ${toolCount} calls (${elapsed}s)`,
              ];
              const toolLines = formatToolCallsForWidget(p.toolCalls, 7);
              if (toolLines.length > 0) {
                lines.push(...toolLines);
              }
              ctx.ui.setWidget("orchestrator", lines);
            },
          },
          config.stallTimeout,
        );

        if (!result.text?.trim()) {
          ctx.ui.notify("Worker returned empty result", "warning");
          return;
        }

        await approveOrRevise(fan, ctx, result.text, task, () => {
          if (!coordinatorActive) {
            coordinatorActive = true;
            ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
            ctx.ui.notify("Coordinator mode auto-enabled for implementation");
          }
        });
      } catch (err: any) {
        ctx.ui.notify(`Planning failed: ${err.message}`, "error");
        console.error("[orchestrator] Error:", err);
      } finally {
        clearInterval(statusTimer);
        ctx.ui.setWidget("orchestrator", undefined);
        ctx.ui.setStatus(
          "2-orchestrator",
          coordinatorActive
            ? "🎭 Coordinator ON"
            : `🎭 Orchestrator (${config.providerMode})`,
        );
      }
    },
  });

  // ── /orchestrator command ────────────────────────────────────────────────

  fan.registerCommand("orchestrator", {
    description: "Manage the orchestrator: on/off/status/stop/config/init/mode",
    handler: async (args, ctx) => {
      const sub = args?.trim().split(/\s+/)[0] ?? "";

      if (sub === "on") {
        coordinatorActive = true;
        ctx.ui.notify("Coordinator ON — Agent/SendMessage/StopAgent tools ready");
        ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
        return;
      }

      if (sub === "off") {
        coordinatorActive = false;
        ctx.ui.notify("Coordinator OFF");
        ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
        return;
      }

      if (sub === "status") {
        const workers = listWorkers();
        const active = activeWorkers();
        const statusLines: string[] = [
          `🎭 Orchestration: ${coordinatorActive ? "ON" : "OFF"}`,
          `📡 Provider: ${config.providerMode}`,
          `👷 Active: ${active.length} / ${config.parallelWorkers} | Queue: ${getQueueLength()}`,
          `📋 Total workers: ${workers.length}`,
        ];

        if (workers.length > 0) {
          statusLines.push("", "── Workers ──");
          for (const w of workers) {
            const elapsed = w.endTime
              ? Math.round((w.endTime - w.startTime) / 1000)
              : Math.round((Date.now() - w.startTime) / 1000);
            statusLines.push(
              `  ${statusIcon(w.status)} ${statusColor(w.status, w.id, ctx.ui.theme)}`,
              `     ${w.agentType} (${w.model}) — ${statusColor(w.status, w.status, ctx.ui.theme)} [${elapsed}s]`,
            );
          }
        }

        const tasks = listTasks();
        if (tasks.length > 0) {
          const completed = tasks.filter((t) => t.status === "completed").length;
          const failed = tasks.filter((t) => t.status === "failed").length;
          const summary = failed > 0
            ? ctx.ui.theme.fg("error", `${completed}/${tasks.length} done, ${failed} failed`)
            : ctx.ui.theme.fg("success", `${completed}/${tasks.length} done`);
          statusLines.push("", "── Tasks ──");
          statusLines.push(`  📊 ${summary}`);
          const activeTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "failed");
          for (const t of activeTasks.slice(-5)) {
            const icon = t.status === "in_progress" ? "🔄" : t.status === "blocked" ? "🚫" : "⏳";
            statusLines.push(`  ${icon} ${statusColor(t.status, `${t.id}: ${t.subject.slice(0, 50)}`, ctx.ui.theme)}`);
          }
          if (activeTasks.length > 5) statusLines.push(`  ... and ${activeTasks.length - 5} more`);
        }

        ctx.ui.setWidget("orchestrator", statusLines);
        setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 10_000);
        return;
      }

      if (sub === "stop") {
        const active = activeWorkers();
        for (const w of active) {
          updateWorker(w.id, { status: "aborted", endTime: Date.now() });
        }
        const count = active.length;
        ctx.ui.notify(`Stopped ${count} worker(s)`, count > 0 ? "warning" : "info");
        return;
      }

      if (sub === "config") {
        const cloudOverrides = Object.entries(config.cloud.models).map(([t, m]) => `${t}=${m}`).join(", ");
        const localOverrides = Object.entries(config.local.models).map(([t, m]) => `${t}=${m}`).join(", ");
        const healthIcon = getCloudHealthCached() === "available" ? "✅" : getCloudHealthCached() === "unavailable" ? "❌" : "❓";
        const lines = [
          `📊 ${config.providerMode.toUpperCase()} | Parallel: ${config.parallelWorkers} | Queue: ${config.maxWorkers} | Stall: ${Math.round(config.stallTimeout / 1000)}s | Retries: ${config.maxRetries}`,
          `☁️  ${config.cloud.defaultModel || "(not set)"} ${healthIcon}${cloudOverrides ? ` (${cloudOverrides})` : ""}`,
          `🏠 ${config.local.defaultModel || "(not set)"}${localOverrides ? ` (${localOverrides})` : ""}`,
          `🚫 Dangerous: ${config.dangerousCommands.length} patterns`,
        ];
        ctx.ui.setWidget("orchestrator", lines);
        setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 15_000);
        return;
      }

      if (sub === "mode") {
        const modeArg = args?.trim().split(/\s+/)[1];
        if (!modeArg || !["cloud", "local", "auto"].includes(modeArg)) {
          ctx.ui.notify("Usage: /orchestrator mode cloud|local|auto", "warning");
          return;
        }
        config.providerMode = modeArg as "cloud" | "local" | "auto";
        ctx.ui.notify(`Provider mode: ${modeArg}`);
        ctx.ui.setStatus("2-orchestrator", coordinatorActive ? "🎭 Coordinator ON" : `🎭 Orchestrator (${config.providerMode})`);
        return;
      }

      if (sub === "init") {
        const agentTypes = Object.entries(AGENT_DEFINITIONS).map(([type, def]) => ({
          type,
          icon: def.icon ?? "🤖",
        }));

        const cancelled = () => { ctx.ui.notify("Init cancelled"); ctx.ui.setWidget("orchestrator", undefined); };
        const input = (prompt: string, fallback: string) => ctx.ui.input(prompt, fallback);

        ctx.ui.setWidget("orchestrator", [
          "⚡ ORCHESTRATOR — Configuration Wizard",
          "",
          "Answer questions below to configure your orchestrator.",
          "Press Esc to cancel at any time.",
        ]);

        // 1. Provider mode
        const modeChoice = await ctx.ui.select("Provider mode?", [
          `cloud (current: ${config.providerMode})`,
          "local",
          "auto",
        ]);
        if (modeChoice === undefined) { cancelled(); return; }
        const providerMode = modeChoice.split(" ")[0] as "cloud" | "local" | "auto";

        // 2. General settings
        const parallelStr = await input(`Parallel workers (current: ${config.parallelWorkers}):`, String(config.parallelWorkers));
        if (parallelStr === undefined) { cancelled(); return; }
        const parallelWorkers = parseInt(parallelStr, 10) || 3;

        const stallTimeoutStr = await input(`Stall timeout ms (current: ${config.stallTimeout}):`, String(config.stallTimeout));
        if (stallTimeoutStr === undefined) { cancelled(); return; }
        const stallTimeout = parseInt(stallTimeoutStr, 10) || 300_000;

        // 3. Cloud model defaults
        const cloudDefault = await input(`Cloud default model:`, config.cloud.defaultModel || "");
        if (cloudDefault === undefined) { cancelled(); return; }

        const doCloudOverrides = await ctx.ui.select("Configure per-agent cloud models?", ["Yes", "No"]);
        if (doCloudOverrides === undefined) { cancelled(); return; }

        const cloudModels: Record<string, string> = {};
        if (doCloudOverrides === "Yes") {
          for (const { type, icon } of agentTypes) {
            const current = config.cloud.models[type] ?? cloudDefault;
            const val = await input(`${icon} ${type} cloud model:`, current);
            if (val === undefined) { cancelled(); return; }
            cloudModels[type] = val;
          }
        }

        // 4. Local model defaults
        const localDefault = await input(`Local default model:`, config.local.defaultModel || "");
        if (localDefault === undefined) { cancelled(); return; }

        const doLocalOverrides = await ctx.ui.select("Configure per-agent local models?", ["Yes", "No"]);
        if (doLocalOverrides === undefined) { cancelled(); return; }

        const localModels: Record<string, string> = {};
        if (doLocalOverrides === "Yes") {
          for (const { type, icon } of agentTypes) {
            const current = config.local.models[type] ?? localDefault;
            const val = await input(`${icon} ${type} local model:`, current);
            if (val === undefined) { cancelled(); return; }
            localModels[type] = val;
          }
        }

        // 5. Build config and save
        const newConfig = {
          ...config,
          providerMode,
          parallelWorkers,
          stallTimeout,
          cloud: {
            ...config.cloud,
            defaultModel: cloudDefault,
            models: cloudModels,
          },
          local: {
            ...config.local,
            defaultModel: localDefault,
            models: localModels,
          },
        };

        saveConfig(newConfig);
        config = loadConfig();
        ctx.ui.notify("Orchestrator configured! ✅");
        ctx.ui.setStatus("2-orchestrator", coordinatorActive ? "🎭 Coordinator ON" : `🎭 Orchestrator (${config.providerMode})`);
        ctx.ui.setWidget("orchestrator", undefined);
        return;
      }

      // No subcommand — show help
      ctx.ui.setWidget("orchestrator", [
        `/orchestrator init — configure agent settings`,
        `/orchestrator on/off — toggle coordinator`,
        `/orchestrator status — workers & tasks`,
        `/orchestrator stop — abort all`,
        `/orchestrator config — show current config`,
        `/orchestrator mode — cloud/local/auto`,
        `Alt+O — quick toggle`,
      ]);
      setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 10_000);
    },
  });

  // ── Task widget lifecycle ────────────────────────────────────────────────

  fan.on("turn_end", (_event, ctx) => {
    updateTaskWidget(ctx);
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────

  let lastCtx: ExtensionContext | null = null;

  fan.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    ctx.ui.setStatus("2-orchestrator", coordinatorActive ? "🎭 Coordinator ON" : `🎭 Orchestrator (${config.providerMode})`);
    updateTaskWidget(ctx);
    if (!configExists()) {
      ctx.ui.notify("💡 Orchestrator not configured. Run /orchestrator init to set up.");
    }
  });

  fan.on("session_shutdown", () => {
    for (const w of activeWorkers()) {
      updateWorker(w.id, { status: "aborted", endTime: Date.now() });
    }
    coordinatorActive = false;
    if (lastCtx) {
      try { lastCtx.ui.setStatus("2-orchestrator", undefined); } catch {}
      try { lastCtx.ui.setWidget("orchestrator", undefined); } catch {}
      try { lastCtx.ui.setWidget("orchestrator-tasks", undefined); } catch {}
    }
  });

  // ── Permission system ────────────────────────────────────────────────────

  fan.on("tool_call", async (event, ctx) => {
    if (event.toolName === "TaskCreate" || event.toolName === "TaskUpdate") {
      queueMicrotask(() => updateTaskWidget(ctx));
      return;
    }

    if (event.toolName !== "bash") return;
    const cmd = (event.input as { command?: string })?.command ?? "";
    const danger = isDangerousCommand(cmd);
    if (!danger) return;

    const choice = await ctx.ui.select(
      `Dangerous: ${danger} | ${cmd.slice(0, 100)}`,
      ["Block", "Allow"],
    );
    if (choice !== "Allow") {
      return { block: true, reason: `Blocked by user: ${danger}` };
    }
  });
}
