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
 *   /orchestrator [on|off|stop|config|init|mode|status] — Orchestrator control
 *   /tasks [status]       — List tracked tasks
 *   /agents [scope]       — List available agents
 *   /plan [task]          — Generate implementation plan
 *   /delegate <agent> <task> — Quick delegate
 */
import { COORDINATOR_PROMPT, buildCoordinatorPrompt, discoverAgents } from "./agents.js";
import { DEFAULTS, configExists, loadConfig, resolveWorkerModel, resolveWorkerTemperature, saveConfig } from "./config.js";
import { registerOrchestratorTools } from "./orchestrator-tools.js";
import { isDangerousCommand } from "./permissions.js";
import { getFinalOutput, runSingleAgent } from "./subagent-runner.js";
import { TaskManager } from "./task-manager.js";
import { _resetRegistry, activeWorkers, genWorkerId, registerWorker, updateWorker } from "./workers.js";
export const orchestratorExtension = (fan) => {
    // ---- Infrastructure setup ----
    const hasConfig = configExists();
    const config = hasConfig ? loadConfig() : { ...DEFAULTS };
    const taskManager = new TaskManager();
    // Register tools (delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate)
    registerOrchestratorTools(fan, taskManager, config, {
        genWorkerId: () => genWorkerId(),
        onWorkerStart: (id, agentType, model) => {
            registerWorker({ id, agentType, model, status: "spawning", startTime: Date.now() });
            updateWorker(id, { status: "running" });
            startWidgetTimer(lastCtx);
        },
        onWorkerStop: (id, success = true) => {
            updateWorker(id, { status: success ? "completed" : "failed", endTime: Date.now() });
        },
    });
    // ---- State ----
    let coordinatorActive = config.coordinatorDefault ?? true;
    let configInitialized = hasConfig;
    let taskWidgetCollapsed = false;
    let lastCtx;
    // Cached dynamic coordinator prompt (rebuilt on session start)
    let cachedCoordinatorPrompt = COORDINATOR_PROMPT;
    // ---- Live widget timer ----
    // Refreshes the task widget every 1 second while workers are active.
    // This ensures the elapsed timer in worker content counts up continuously.
    let _widgetTimer = null;
    function startWidgetTimer(ctx) {
        if (_widgetTimer) return; // already running
        _widgetTimer = setInterval(() => {
            const active = activeWorkers();
            if (active.length === 0) {
                stopWidgetTimer();
                updateTaskWidget(ctx || lastCtx);
                return;
            }
            updateTaskWidget(ctx || lastCtx);
        }, 1000);
    }
    function stopWidgetTimer() {
        if (_widgetTimer) {
            clearInterval(_widgetTimer);
            _widgetTimer = null;
        }
    }
    // ---- Helper: updateTaskWidget ----
    function updateTaskWidget(ctx) {
        if (!ctx?.ui?.setWidget)
            return;
        const tasks = taskManager.getTasks();
        // Auto-hide + auto-clear: if no active/pending tasks, hide widget and clean up
        const activeOrPending = tasks.filter((t) => t.status !== "completed" && t.status !== "failed");
        if (tasks.length === 0 || activeOrPending.length === 0) {
            if (tasks.length > 0)
                taskManager.clearCompleted();
            ctx.ui.setWidget("orchestrator-tasks", undefined);
            return;
        }
        const theme = ctx.ui.theme;
        const fg = (color, text) => theme?.fg?.(color, text) ?? text;
        const bold = (text) => theme?.bold?.(text) ?? text;
        const strikethrough = (text) => theme?.strikethrough?.(text) ?? text;
        const sorted = [...tasks].sort((a, b) => {
            const order = { in_progress: 0, pending: 1, blocked: 2, completed: 3, failed: 4 };
            return (order[a.status] ?? 5) - (order[b.status] ?? 5);
        });
        const doneCount = tasks.filter((t) => t.status === "completed" || t.status === "failed").length;
        const totalCount = activeOrPending.length + doneCount;
        // Collapsed: compact format
        if (taskWidgetCollapsed) {
            const lines = [`📋 ${doneCount}/${totalCount} tasks  [Alt+T to expand]`];
            ctx.ui.setWidget("orchestrator-tasks", lines);
            return;
        }
        // Expanded: themed task list
        const lines = [
            `📋 ${doneCount}/${totalCount} tasks:`,
            ...sorted
                .filter((t) => t.status !== "completed" && t.status !== "failed")
                .map((t) => {
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
        const doneTasks = sorted.filter((t) => t.status === "completed" || t.status === "failed");
        if (doneTasks.length > 0 && doneTasks.length <= 3) {
            lines.push("", fg("dim", "── done ──"));
            for (const t of doneTasks) {
                const desc = t.description.length > 50 ? t.description.slice(0, 50) + "..." : t.description;
                const icon = t.status === "completed" ? "☑" : "✗";
                lines.push(`  ${fg("muted", strikethrough(`${icon} ${desc}`))}`);
            }
        }
        else if (doneTasks.length > 3) {
            lines.push("", fg("muted", `  ── ${doneTasks.length} completed/failed ──`));
        }
        ctx.ui.setWidget("orchestrator-tasks", lines);
    }
    // ---- Helper: setCoordinatorStatus ----
    function setCoordinatorStatus(ctx, active) {
        coordinatorActive = active;
        if (!ctx?.ui?.setStatus)
            return;
        if (active) {
            ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
        }
        else {
            ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
        }
    }
    // ---- Shortcuts ----
    fan.registerShortcut("alt+o", {
        description: "Toggle coordinator mode",
        handler: async (ctx) => {
            setCoordinatorStatus(ctx, !coordinatorActive);
            ctx.ui.notify(coordinatorActive
                ? "Coordinator mode ENABLED — delegate via delegate_task, track via TaskCreate/TaskUpdate"
                : "Coordinator mode DISABLED");
        },
    });
    fan.registerShortcut("alt+t", {
        description: "Toggle task list collapse",
        handler: async (ctx) => {
            taskWidgetCollapsed = !taskWidgetCollapsed;
            updateTaskWidget(ctx);
        },
    });
    // ---- Coordinator mode: inject prompt ----
    fan.on("before_agent_start", (event, ctx) => {
        lastCtx = ctx;
        if (coordinatorActive) {
            return {
                systemPrompt: event.systemPrompt + "\n\n" + cachedCoordinatorPrompt,
            };
        }
        return {};
    });
    // ---- Events ----
    fan.on("turn_end", (_event, ctx) => {
        updateTaskWidget(ctx);
    });
    fan.on("session_start", (_event, ctx) => {
        lastCtx = ctx;
        // Warn if no config
        if (!configInitialized && ctx.ui.notify) {
            ctx.ui.notify("⚠️ Orchestrator config not found. Run /orchestrator init to configure.", "warn");
        }
        // Build dynamic coordinator prompt from discovered agents
        try {
            const discovery = discoverAgents(ctx.cwd, "both");
            if (discovery.agents.length > 0) {
                // Enrich agent models from config (per-agent override → default → session)
                for (const a of discovery.agents) {
                    const resolved = resolveWorkerModel(a.name, config, config.providerMode);
                    if (resolved) a.model = resolved;
                }
                cachedCoordinatorPrompt = buildCoordinatorPrompt(discovery.agents);
                console.log(`[FAN Orchestrator] Dynamic coordinator prompt built from ${discovery.agents.length} agents`);
            } else {
                cachedCoordinatorPrompt = COORDINATOR_PROMPT;
                console.log("[FAN Orchestrator] No agents discovered, using static coordinator prompt");
            }
        } catch (err) {
            cachedCoordinatorPrompt = COORDINATOR_PROMPT;
            console.error("[FAN Orchestrator] Failed to build dynamic prompt, using fallback:", err);
        }
        // Restore status bar and widget
        if (coordinatorActive) {
            ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
        }
        else {
            ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
        }
        updateTaskWidget(ctx);
        console.log("[FAN Orchestrator] Session started");
        console.log("[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate, TaskClear");
        if (coordinatorActive) {
            console.log("[FAN Orchestrator] Coordinator mode: ACTIVE");
        }
    });
    fan.on("session_shutdown", (_event, ctx) => {
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
    fan.on("tool_call", async (event, ctx) => {
        // Interactive permission check for dangerous bash commands
        if (event.toolName === "bash") {
            const cmd = event.args?.command;
            if (cmd) {
                const reason = isDangerousCommand(cmd, config.dangerousCommands);
                if (reason) {
                    // Interactive mode — ask user to allow or block
                    if (ctx.hasUI && typeof ctx.ui.select === 'function') {
                        const choice = await ctx.ui.select(
                            `⚠️ Dangerous command detected: ${reason}\n\nCommand: ${cmd.trim().slice(0, 120)}${cmd.trim().length > 120 ? "..." : ""}`,
                            ['Allow', 'Block']
                        );
                        if (choice === 'Block' || choice === undefined) {
                            return { block: true, reason: `⚠️ Blocked by user: ${reason}` };
                        }
                        // choice === 'Allow' — pass through, return empty to allow
                        return {};
                    } else {
                        // Headless mode — default to blocking
                        return { block: true, reason: `⚠️ Blocked (headless): ${reason}` };
                    }
                }
            }
        }
        return {};
    });
    // Update widget AFTER tool execution (tool_result), when state has actually changed
    fan.on("tool_result", (event, ctx) => {
        if (event.toolName === "TaskCreate" ||
            event.toolName === "TaskUpdate" ||
            event.toolName === "TaskClear" ||
            event.toolName === "cancel_task") {
            queueMicrotask(() => {
                updateTaskWidget(ctx);
            });
        }
    });
    // ---- Slash Command: /orchestrator (enhanced) ----
    fan.registerCommand("orchestrator", {
        description: "Orchestrator control: on, off, stop, config, init, mode, status",
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
                    const cloudOverrides = Object.entries(config.cloud.models || {}).map(([t, m]) => `  ☁️  ${t}: ${m}`);
                    const localOverrides = Object.entries(config.local.models || {}).map(([t, m]) => `  🏠 ${t}: ${m}`);
                    const tempOverrides = Object.entries(config.agentTemperature || {}).map(([t, tmp]) => `  ${t}: ${tmp}`);
                    const configLines = [
                        `📊 ${config.providerMode.toUpperCase()} | Parallel: ${config.parallelWorkers} | Worker: ${config.workerTimeout}s | Stall: ${config.stallTimeout}s | Retries: ${config.maxRetries}`,
                        `☁️  ${config.cloud.model || "(session)"} (cloud default)`,
                        ...cloudOverrides,
                        `🏠 ${config.local.model || "(session)"} (local default)`,
                        ...localOverrides,
                        `🌡️  Default temperature: ${config.temperature ?? 0.1}`,
                        "Per-agent temperatures:",
                        ...tempOverrides,
                        "Agent timeouts:",
                        ...Object.entries(config.agentTimeouts).map(([k, v]) => `  ${k}: ${typeof v === "number" ? v + "s" : "default"}`),
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
                    const failed = taskManager.getTasks().filter((t) => t.status === "failed");
                    if (failed.length === 0) {
                        ctx.ui.notify("No failed tasks to retry.");
                        return;
                    }
                    const last = failed[failed.length - 1];
                    if (last.description) {
                        ctx.ui.notify(`Retrying failed task: ${last.description.slice(0, 80)}`);
                        taskManager.updateTask(last.id, { status: "pending" });
                    }
                    else {
                        ctx.ui.notify("No retryable task found.");
                    }
                    return;
                }
                case "status": {
                    const counts = taskManager.getStatusCounts();
                    const workers = activeWorkers();
                    const discovery = discoverAgents(ctx.cwd, "both");
                    const statusLines = [
                        `🎭 Orchestration: ${coordinatorActive ? "ON" : "OFF"}`,
                        `📡 Provider: ${config.providerMode}`,
                        `👷 Active: ${counts.in_progress} / ${config.parallelWorkers} | Queue: ${workers.length}`,
                    ];
                    if (workers.length > 0) {
                        statusLines.push("", "── Workers ──");
                        for (const w of workers) {
                            const elapsed = w.startTime ? Math.round((Date.now() - w.startTime) / 1000) : 0;
                            statusLines.push(`  🔄 ${w.id} ${w.agentType} (${w.model ?? "?"}) — ${w.status} [${elapsed}s]`);
                        }
                    }
                    if (taskManager.size > 0) {
                        const done = counts.completed + counts.failed;
                        statusLines.push("", "── Tasks ──");
                        statusLines.push(`  📊 ${done}/${taskManager.size} done`);
                        const pending = taskManager.getTasks().filter((t) => t.status === "pending" || t.status === "in_progress");
                        for (const t of pending.slice(0, 5)) {
                            statusLines.push(`  ${t.status === "in_progress" ? "🔄" : "⏳"} ${t.id}: ${t.description.slice(0, 50)}`);
                        }
                        if (pending.length > 5)
                            statusLines.push(`  ... +${pending.length - 5} more`);
                    }
                    statusLines.push("", `── Agents ──`);
                    statusLines.push(`  Available: ${discovery.agents.length}`);
                    for (const a of discovery.agents.slice(0, 4)) {
                        statusLines.push(`  • ${a.name} (${a.source})`);
                    }
                    if (discovery.agents.length > 4)
                        statusLines.push(`  ... +${discovery.agents.length - 4} more`);
                    ctx.ui.setWidget("orchestrator", statusLines);
                    setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 10_000);
                    return;
                }
                case "init": {
                    if (!ctx.hasUI) {
                        ctx.ui.notify("UI not available. Edit config.json manually.");
                        return;
                    }
                    const cancelled = () => {
                        ctx.ui.notify("Init cancelled.");
                        ctx.ui.setWidget("orchestrator", undefined);
                    };
                    const agentTypes = ["explore", "plan", "implement", "verify", "bug-fix", "code-research", "tests-impl", "docs-impl"];
                    const agentIcons = { explore: "🔍", plan: "📋", implement: "🔧", verify: "✅", "bug-fix": "🐛", "code-research": "🔬", "tests-impl": "🧪", "docs-impl": "📝" };

                    ctx.ui.setWidget("orchestrator", [
                        "⚡ ORCHESTRATOR — Configuration Wizard",
                        "",
                        "Answer the questions below to configure the orchestrator.",
                        "Press Esc to cancel at any time.",
                    ]);

                    // 1. Provider mode
                    const modeChoice = await ctx.ui.select("Provider mode", [
                        `auto (recommended — cloud first, fallback to local)`,
                        "cloud — use cloud provider only",
                        "local — use local provider only",
                    ]);
                    if (modeChoice === undefined) { cancelled(); return; }
                    const providerMode = modeChoice.startsWith("auto") ? "auto" : modeChoice.startsWith("cloud") ? "cloud" : "local";

                    // 2. General settings
                    const parallelStr = await ctx.ui.input(`Parallel workers (current: ${config.parallelWorkers})`, String(config.parallelWorkers));
                    if (parallelStr === undefined) { cancelled(); return; }
                    const parallelWorkers = parseInt(parallelStr, 10) || 3;

                    const maxRetriesStr = await ctx.ui.input(`Max retries per task (current: ${config.maxRetries})`, String(config.maxRetries));
                    if (maxRetriesStr === undefined) { cancelled(); return; }
                    const maxRetries = parseInt(maxRetriesStr, 10) || 2;

                    // 3. Cloud model (default)
                    const cloudModel = await ctx.ui.input("Cloud default model (empty = session model)", config.cloud.model || "");
                    if (cloudModel === undefined) { cancelled(); return; }

                    // 4. Cloud per-agent models
                    const doCloudOverrides = await ctx.ui.select("Configure per-agent cloud models?", [
                        "No — use the same cloud model for all agents",
                        "Yes — set custom model for each agent",
                    ]);
                    if (doCloudOverrides === undefined) { cancelled(); return; }
                    const cloudModels = Object.fromEntries(agentTypes.map(t => [t, ""]));
                    if (doCloudOverrides.startsWith("Yes")) {
                        ctx.ui.setWidget("orchestrator", [
                            `⚡ Cloud per-agent models (default: ${cloudModel})`,
                            "Leave empty to use the default model for that agent.",
                        ]);
                        for (const type of agentTypes) {
                            const current = config.cloud.models?.[type] || "";
                            const val = await ctx.ui.input(`${agentIcons[type]} ${type} cloud model`, current);
                            if (val === undefined) { cancelled(); return; }
                            if (val.trim()) cloudModels[type] = val.trim();
                        }
                    }

                    // 5. Local model (default)
                    const localModel = await ctx.ui.input("Local default model (empty = session model)", config.local.model || "");
                    if (localModel === undefined) { cancelled(); return; }

                    // 6. Local per-agent models
                    const doLocalOverrides = await ctx.ui.select("Configure per-agent local models?", [
                        "No — use the same local model for all agents",
                        "Yes — set custom model for each agent",
                    ]);
                    if (doLocalOverrides === undefined) { cancelled(); return; }
                    const localModels = Object.fromEntries(agentTypes.map(t => [t, ""]));
                    if (doLocalOverrides.startsWith("Yes")) {
                        ctx.ui.setWidget("orchestrator", [
                            `⚡ Local per-agent models (default: ${localModel})`,
                            "Leave empty to use the default model for that agent.",
                        ]);
                        for (const type of agentTypes) {
                            const current = config.local.models?.[type] || "";
                            const val = await ctx.ui.input(`${agentIcons[type]} ${type} local model`, current);
                            if (val === undefined) { cancelled(); return; }
                            if (val.trim()) localModels[type] = val.trim();
                        }
                    }

                    // 7. Default temperature
                    const defaultTempStr = await ctx.ui.input(`Default worker temperature (0.0-1.0, current: ${config.temperature ?? 0.1})`, String(config.temperature ?? 0.1));
                    if (defaultTempStr === undefined) { cancelled(); return; }
                    let temperature = parseFloat(defaultTempStr);
                    if (Number.isNaN(temperature)) temperature = 0.1;
                    temperature = Math.max(0.0, Math.min(1.0, temperature));

                    // 8. Per-agent temperatures
                    const doTempOverrides = await ctx.ui.select("Configure per-agent temperatures?", [
                        "No — use default per-agent temperatures",
                        "Yes — set custom temperature for each agent",
                    ]);
                    if (doTempOverrides === undefined) { cancelled(); return; }
                    let agentTemperature;
                    if (doTempOverrides.startsWith("Yes")) {
                        agentTemperature = Object.fromEntries(agentTypes.map(t => [t, temperature]));
                        ctx.ui.setWidget("orchestrator", [
                            `⚡ Per-agent temperatures (default: ${temperature})`,
                            "Enter a value between 0.0 and 1.0. Leave empty to use the default.",
                        ]);
                        for (const type of agentTypes) {
                            const current = config.agentTemperature?.[type] ?? temperature;
                            const val = await ctx.ui.input(`${agentIcons[type]} ${type} temperature`, String(current));
                            if (val === undefined) { cancelled(); return; }
                            if (val.trim()) {
                                const parsed = parseFloat(val.trim());
                                if (!Number.isNaN(parsed)) {
                                    agentTemperature[type] = Math.max(0.0, Math.min(1.0, parsed));
                                }
                            }
                        }
                    } else {
                        agentTemperature = { ...DEFAULTS.agentTemperature };
                    }

                    // 9. Coordinator default
                    const coordDefault = await ctx.ui.select("Enable coordinator mode by default?", [
                        `Yes (current: ${config.coordinatorDefault ? "on" : "off"})`,
                        "No",
                    ]);
                    if (coordDefault === undefined) { cancelled(); return; }
                    const coordinatorDefault = coordDefault.startsWith("Yes");

                    // 10. Build and save config
                    const newConfig = {
                        cloud: { model: cloudModel || config.cloud.model, models: cloudModels },
                        local: { model: localModel || config.local.model, models: localModels },
                        providerMode,
                        coordinatorDefault,
                        parallelWorkers,
                        workerTimeout: config.workerTimeout,
                        stallTimeout: config.stallTimeout,
                        planTimeout: config.planTimeout,
                        maxRetries,
                        agentTimeouts: { ...config.agentTimeouts },
                        temperature,
                        agentTemperature,
                        dangerousCommands: [...config.dangerousCommands],
                    };

                    const saved = saveConfig(newConfig);
                    if (saved) {
                        // Reload config in-memory
                        const fresh = loadConfig();
                        Object.assign(config, fresh);
                        configInitialized = true;
                        ctx.ui.notify("Orchestrator configured! ✅");
                        ctx.ui.setWidget("orchestrator", undefined);
                        setCoordinatorStatus(ctx, coordinatorDefault);
                    } else {
                        ctx.ui.notify("Failed to save config.json. Check console.", "error");
                        ctx.ui.setWidget("orchestrator", undefined);
                    }
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
                        "  init     — Interactive configuration wizard",
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
    fan.registerCommand("plan", {
        description: "Generate an implementation plan using a planning worker",
        handler: async (args, ctx) => {
            const taskDescription = (args.trim() || "Analyze this codebase and create an implementation plan for the current task.") + 
                "\n\nЯзык документации: русский. Весь план, все описания шагов, риски и критерии успеха должны быть написаны на русском языке. Названия файлов и технические термины оставляй на английском.";
            const discovery = discoverAgents(ctx.cwd, "both");
            const planAgent = discovery.agents.find((a) => a.name === "plan");
            if (!planAgent) {
                ctx.ui.notify('No "plan" agent found. Make sure agent definitions are available.', "error");
                return;
            }
            // Enrich plan agent model and temperature from config
            const planModel = resolveWorkerModel("plan", config, config.providerMode);
            if (planModel) planAgent.model = planModel;
            const planTemperature = resolveWorkerTemperature("plan", config);

            /** Run plan worker with live progress widget */
            async function runPlanWorker(agentCfg, task, signal, headerPrefix) {
                const planStartTime = Date.now();
                const PLAN_TIMEOUT_MS = (config.planTimeout ?? 300) * 1000;
                let timedOut = false;
                
                const statusTimer = setInterval(() => {
                    const elapsed = Math.round((Date.now() - planStartTime) / 1000);
                    ctx.ui.setStatus("2-orchestrator", `⏳ ${headerPrefix}... ${elapsed}s`);
                }, 3000);
                
                // Combined abort signal (ESC + timeout)
                const abortController = new AbortController();
                const timeoutId = setTimeout(() => {
                    timedOut = true;
                    abortController.abort();
                }, PLAN_TIMEOUT_MS);
                
                // Forward external signal (ESC) to our combined signal
                if (signal) {
                    if (signal.aborted) {
                        clearTimeout(timeoutId);
                        abortController.abort();
                    } else {
                        signal.addEventListener("abort", () => {
                            clearTimeout(timeoutId);
                            abortController.abort();
                        }, { once: true });
                    }
                }
                
                try {
                    const result = await runSingleAgent(ctx.cwd, [agentCfg], agentCfg.name, task, planTemperature, undefined, undefined, abortController.signal,
                        (partial) => {
                            const details = Array.isArray(partial.details)
                                ? partial.details[0]
                                : partial.details?.results?.[0];
                            // Use progress.toolCalls (live) instead of messages (empty during run)
                            const liveTools = details?.progress?.toolCalls ?? [];
                            const elapsed = Math.round((Date.now() - planStartTime) / 1000);
                            const status = liveTools.length > 0
                                ? `Working · ${liveTools.length} tools`
                                : "Thinking";
                            const widgetLines = [
                                `📋 ${headerPrefix} · ⏳ ${status} · ${elapsed}s`,
                            ];
                            // Show tool calls with previews (like regular workers)
                            if (liveTools.length > 0) {
                                const MAX_LIVE = 7;
                                const show = liveTools.slice(-MAX_LIVE);
                                for (const tc of show) {
                                    const preview = tc.preview || `→ ${tc.name} ${JSON.stringify(tc.args || {}).slice(0, 40)}`;
                                    widgetLines.push(`  ${preview.slice(0, 90)}`);
                                }
                                if (liveTools.length > MAX_LIVE) {
                                    widgetLines.push(`  ... +${liveTools.length - MAX_LIVE} more`);
                                }
                            }
                            ctx.ui.setWidget("orchestrator-plan", widgetLines);
                        }
                    );
                    const output = result.text || getFinalOutput(result.messages);
                    if (timedOut) {
                        return { output: "", exitCode: 1, stderr: "Plan generation timed out after 5 minutes" };
                    }
                    return { output, exitCode: result.exitCode, stderr: result.stderr };
                } catch (err) {
                    if (timedOut) {
                        return { output: "", exitCode: 1, stderr: "Plan generation timed out after 5 minutes" };
                    }
                    return { output: "", exitCode: 1, stderr: err.message || "Plan generation failed" };
                } finally {
                    clearTimeout(timeoutId);
                    clearInterval(statusTimer);
                }
            }
            async function approveOrRevise(planText, signal) {
                // Show plan in UI + conversation context WITHOUT triggering an LLM turn
                fan.sendMessage({ customType: "orchestrator-plan-draft", content: planText, display: true }, { triggerTurn: false });
                const choice = await ctx.ui.select("Plan Review", ["✅ Approve", "✏️ Revise", "❌ Reject"]);
                if (choice === "✅ Approve") {
                    return true;
                }
                if (choice === "✏️ Revise") {
                    const feedback = await ctx.ui.input("Revision Feedback", "What should be changed in the plan?");
                    if (feedback) {
                        const revised = await runPlanWorker(planAgent, `${taskDescription}\n\n--- Revision Feedback ---\n${feedback}\n\n--- Original Plan ---\n${planText}`, signal, "Re-plan");
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
            if (!approved)
                return;
            // Enable coordinator, then trigger a new turn with coordinator prompt active
            setCoordinatorStatus(ctx, true);
            fan.sendUserMessage("The plan has been approved. Review the plan above and start implementing it step by step. Use delegate_task to spawn workers for each task. Decompose the plan into tasks using TaskCreate, then implement each one.", { deliverAs: "followUp" });
        },
    });
    // ---- Slash Command: /tasks ----
    fan.registerCommand("tasks", {
        description: "List orchestrator tasks (optional: filter by status)",
        handler: async (args, ctx) => {
            const statusFilter = args.trim() || undefined;
            const tasks = taskManager.getTasks(statusFilter ? { status: statusFilter } : undefined);
            const counts = taskManager.getStatusCounts();
            if (tasks.length === 0) {
                ctx.ui.notify(`No tasks found. Counts: pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}`);
                return;
            }
            const lines = tasks.map((t) => {
                const result = t.result ? ` → ${t.result.slice(0, 60)}` : "";
                const error = t.error ? ` [${t.error}]` : "";
                return `[${t.status}] ${t.id} ${t.agentType}: ${t.description.slice(0, 80)}${error}${result}`;
            });
            ctx.ui.notify([`Tasks (${tasks.length}):`, ...lines, "", `Counts: ${JSON.stringify(counts)}`].join("\n"));
        },
    });
    // ---- Slash Command: /agents ----
    fan.registerCommand("agents", {
        description: "List available agents (built-in, user, project)",
        handler: async (args, ctx) => {
            const scope = (args.trim() === "project" ? "project" : args.trim() === "user" ? "user" : "both");
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
    fan.registerCommand("delegate", {
        description: "Quick delegate a task to an agent: /delegate <agent> <task>",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/);
            if (parts.length < 2) {
                ctx.ui.notify("Usage: /delegate <agent> <task description...>\n\nAgents: explore, plan, implement, verify\nExample: /delegate explore Find all API endpoints in the project");
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
            ctx.ui.notify(`Task queued for delegation:\n  Agent: ${agentName}\n  Task: ${task}\n\nThe delegate_task tool will be used on the next turn.`);
        },
    });
};
export default orchestratorExtension;
//# sourceMappingURL=orchestrator-extension.js.map