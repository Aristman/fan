/**
 * FAN Orchestrator — Coordinator Tools
 *
 * LLM-callable tools for task delegation, tracking, and classification.
 * Uses the subagent runner to spawn fna subprocesses.
 */
import * as os from "node:os";
import { StringEnum } from "@seaagents/fan-ai";
import { getMarkdownTheme } from "@seaagents/fan-coding-agent";
import { Container, Markdown, Spacer, Text } from "@seaagents/fan-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agents.js";
import { classifyComplexity, formatComplexityResult, DIRECT_TASK_RULES, DELEGATE_TASK_RULES } from "./task-complexity.js";
import { resolveWorkerModel, resolveWorkerTemperature } from "./config.js";
import { formatUsageStats, formatToolPreview, getDisplayItems, getFinalOutput, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, mapWithConcurrencyLimit, runSingleAgent, } from "./subagent-runner.js";
import { acquireSlot, getWorker, releaseSlot, updateWorker } from "./workers.js";
import { collectProjectContext, mergeContext, truncate, PREVIOUS_OUTPUT_LIMIT } from "./context-builder.js";
const COLLAPSED_ITEM_COUNT = 10;
const MAX_LIVE_TOOLS = 9;
const AGENT_ICONS = {
    explore: "🔍",
    plan: "📋",
    implement: "🔧",
    verify: "🛡️",
};
const WRITE_WORKER_TYPES = new Set(["implement", "bug-fix", "tests-impl", "docs-impl"]);
function getAgentIcon(agentName) {
    return AGENT_ICONS[agentName] ?? "🤖";
}
/** Build the 📋 ctx indicator for renderCall (only for fields the coordinator passed). */
function formatContextIndicator(context) {
    if (!context || typeof context !== "object")
        return "";
    const parts = [];
    if (context.parentSummary)
        parts.push("summary");
    const fileCount = Array.isArray(context.relevantFiles) ? context.relevantFiles.length : 0;
    if (fileCount > 0)
        parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}`);
    if (context.previousFindings)
        parts.push("findings");
    const constraintCount = Array.isArray(context.constraints) ? context.constraints.length : 0;
    if (constraintCount > 0)
        parts.push(`${constraintCount} constraint${constraintCount !== 1 ? "s" : ""}`);
    if (parts.length === 0)
        return "";
    return `📋 ctx: ${parts.join(", ")}`;
}
function toWorkerType(agent) {
    // readOnly агенты получают свой слот (параллельные)
    if (agent?.readOnly) return agent.name;
    // write-агенты (implement, bug-fix, tests-impl, docs-impl) — общий эксклюзивный слот
    return "implement";
}
function formatElapsedTime(startTime, endTime) {
    const ms = (endTime ?? Date.now()) - startTime;
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60)
        return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
function countToolCalls(messages) {
    return getDisplayItems(messages).filter((item) => item.type === "toolCall").length;
}
function getLastToolCalls(messages, limit) {
    return getDisplayItems(messages).filter((item) => item.type === "toolCall").slice(-limit);
}
/** Get tool calls from progress (preferred) or messages (fallback) */
function getResultToolCalls(result) {
    if (result.progress?.toolCalls?.length > 0) {
        return result.progress.toolCalls;
    }
    return getDisplayItems(result.messages || []).filter((item) => item.type === "toolCall");
}
function formatToolCall(toolName, args, themeFg) {
    const shortenPath = (p) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };
    switch (toolName) {
        case "bash": {
            const command = args.command || "...";
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...");
            const filePath = shortenPath(rawPath);
            const offset = args.offset;
            const limit = args.limit;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...");
            const filePath = shortenPath(rawPath);
            const content = (args.content || "");
            const lines = content.split("\n").length;
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1)
                text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...");
            return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
        }
        case "ls": {
            const rawPath = (args.path || ".");
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*");
            const rawPath = (args.path || ".");
            return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
        }
        case "grep": {
            const pattern = (args.pattern || "");
            const rawPath = (args.path || ".");
            return (themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`));
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}
function classifyTaskByDescription(description) {
    const lower = description.toLowerCase();
    // Explore patterns
    if (/\b(explore|find|locate|search|grep|look for|what files|list|structure|where|which file)\b/i.test(lower)) {
        return {
            workerType: "explore",
            confidence: 0.8,
            reasoning: "Task description suggests codebase exploration or file lookup",
        };
    }
    // Plan patterns
    if (/\b(plan|design|architect|spec|how should|what approach|strategy|outline|propose)\b/i.test(lower)) {
        return { workerType: "plan", confidence: 0.8, reasoning: "Task description suggests planning or design work" };
    }
    // Verify patterns
    if (/\b(review|verify|check|test|audit|inspect|validate|security|quality)\b/i.test(lower)) {
        return { workerType: "verify", confidence: 0.8, reasoning: "Task description suggests verification or review" };
    }
    // Default: implement
    return {
        workerType: "implement",
        confidence: 0.5,
        reasoning: "No specific pattern matched, defaulting to implement",
    };
}
/**
 * Register all orchestrator tools with the extension API.
 */
export function registerOrchestratorTools(fan, taskManager, config, workerLifecycle) {
    // ---- delegate_task ----
    /**
     * Relevant file entry: plain path string or {path, lines?, purpose?}.
     * Forward-compatible contract with super-orchestrator v3 work_package.context
     * (spec_super-orchestrator_v3_2026-08-10.md §3.3.2).
     */
    const RelevantFileSchema = Type.Union([
        Type.String({ description: "File path" }),
        Type.Object({
            path: Type.String({ description: "File path" }),
            lines: Type.Optional(Type.String({ description: "Line range, e.g. \"10-42\"" })),
            purpose: Type.Optional(Type.String({ description: "Why this file matters for the task" })),
        }),
    ]);
    /**
     * WorkerContextSchema — context injected into the worker prompt.
     * parentSummary / relevantFiles / constraints form the forward-compatible contract
     * with super-orchestrator v3 work_package.context (spec_super-orchestrator_v3_2026-08-10.md §3.3.2).
     * previousFindings / gitState / projectTree are an optional FAN-specific superset.
     */
    const WorkerContextSchema = Type.Object({
        parentSummary: Type.Optional(Type.String({ description: "Forward-compatible contract with super-orchestrator v3 work_package.context. Condensed summary of everything the worker needs to know (goal, decisions, background)." })),
        relevantFiles: Type.Optional(Type.Array(RelevantFileSchema, { description: "Forward-compatible contract with super-orchestrator v3 work_package.context. Files the worker should know about (path or {path, lines, purpose})." })),
        previousFindings: Type.Optional(Type.String({ description: "Optional superset. Condensed findings from previous workers (explore/plan reports). Summarize, do not paste raw reports." })),
        constraints: Type.Optional(Type.Array(Type.String(), { description: "Forward-compatible contract with super-orchestrator v3 work_package.context. Rules the worker must follow (conventions, forbidden changes, compatibility requirements)." })),
        gitState: Type.Optional(Type.String({ description: "Optional superset. Current git state. Auto-collected when omitted." })),
        projectTree: Type.Optional(Type.String({ description: "Optional superset. Project directory tree. Auto-collected when omitted." })),
    }, { description: "Optional context injected into the worker prompt (between the agent prompt and the task). Forward-compatible contract with super-orchestrator v3 work_package.context." });
    const TaskItem = Type.Object({
        agent: Type.String({ description: "Name of the agent to invoke" }),
        task: Type.String({ description: "Task to delegate to the agent" }),
        cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
        context: Type.Optional(WorkerContextSchema),
    });
    const ChainItem = Type.Object({
        agent: Type.String({ description: "Name of the agent to invoke" }),
        task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
        cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
        context: Type.Optional(WorkerContextSchema),
    });
    const AgentScopeSchema = StringEnum(["user", "project", "both"], {
        description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
        default: "user",
    });
    const DelegateParams = Type.Object({
        agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
        task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
        tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
        chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
        agentScope: Type.Optional(AgentScopeSchema),
        confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
        cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
        context: Type.Optional(WorkerContextSchema),
    });
    fan.registerTool({
        name: "delegate_task",
        label: "Delegate Task",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
            "Built-in agents: explore (fast recon), plan (implementation plans), implement (general-purpose), verify (code review).",
            'Default agent scope is "user". Set agentScope: "both" to include project-local agents from .fan/agents/.',
            "Each task may carry an optional 'context' object (parentSummary, relevantFiles, previousFindings, constraints) injected into the worker prompt —",
            "pass condensed knowledge there instead of pasting large texts into the task; it saves tokens.",
        ].join(" "),
        promptSnippet: `## Orchestrator Mode
You have access to the \`delegate_task\` tool for spawning specialized subagents.
Each subagent runs in an isolated context window — it cannot see the main conversation.

### When to Delegate
- **explore**: Fast codebase recon, file search, structure analysis
- **plan**: Create implementation plans from gathered context
- **implement**: Make code changes with full tool capabilities
- **verify**: Code review, quality checks, security audit

### Guidelines
1. Decompose large tasks into sub-tasks
2. Use chain mode for multi-step workflows (explore → plan → implement)
3. Use parallel mode for independent tasks
4. Always explore before implementing
5. Verify after implementation
6. Workers cannot see each other — pass context via {previous} in chains
7. Keep task descriptions self-contained and specific
8. Use the optional \`context\` parameter (parentSummary, relevantFiles, previousFindings, constraints) to inject condensed knowledge into workers — it saves tokens instead of pasting large texts into the task`,
        parameters: DelegateParams,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agentScope = params.agentScope ?? "user";
            const discovery = discoverAgents(ctx.cwd, agentScope);
            const agents = discovery.agents;
            // Enrich agent models from config
            for (const a of agents) {
                const resolved = resolveWorkerModel(a.name, config, config.providerMode);
                if (resolved) a.model = resolved;
            }
            // Auto-collect project context (git state + tree) once per delegate_task call.
            // Respects contextEnrichment.enabled (default true). collectProjectContext never throws.
            let autoContext = undefined;
            if (config.contextEnrichment?.enabled !== false) {
                try {
                    autoContext = collectProjectContext(ctx.cwd, {
                        includeGitState: config.contextEnrichment?.includeGitState !== false,
                        includeProjectTree: config.contextEnrichment?.includeProjectTree !== false,
                    });
                }
                catch {
                    autoContext = undefined;
                }
            }
            const confirmProjectAgents = params.confirmProjectAgents ?? true;
            const hasChain = (params.chain?.length ?? 0) > 0;
            const hasTasks = (params.tasks?.length ?? 0) > 0;
            const hasSingle = Boolean(params.agent && params.task);
            const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
            const makeDetails = (mode) => (results, extra = {}) => ({
                mode,
                agentScope,
                projectAgentsDir: discovery.projectAgentsDir,
                results,
                ...extra,
            });
            if (modeCount !== 1) {
                const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid parameters. Provide exactly one mode (agent+task, tasks array, or chain).\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails("single")([]),
                };
            }
            // Project agent confirmation
            if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
                const requestedAgentNames = new Set();
                if (params.chain)
                    for (const step of params.chain)
                        requestedAgentNames.add(step.agent);
                if (params.tasks)
                    for (const t of params.tasks)
                        requestedAgentNames.add(t.agent);
                if (params.agent)
                    requestedAgentNames.add(params.agent);
                const projectAgentsRequested = Array.from(requestedAgentNames)
                    .map((name) => agents.find((a) => a.name === name))
                    .filter((a) => a?.source === "project");
                if (projectAgentsRequested.length > 0) {
                    const names = projectAgentsRequested.map((a) => a.name).join(", ");
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm("Run project-local agents?", `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`);
                    if (!ok)
                        return {
                            content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                            details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                        };
                }
            }
            // === Chain Mode ===
            if (params.chain && params.chain.length > 0) {
                const totalSteps = params.chain.length;
                const plan = params.chain.map(s => ({ agent: s.agent, task: s.task }));
                const chainExtra = { totalSteps, plan };
                const results = [];
                let previousOutput = "";
                for (let i = 0; i < params.chain.length; i++) {
                    const step = params.chain[i];
                    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
                    // Build per-step context: explicit step context wins, auto fills gitState/projectTree.
                    // Chain no-duplication rule: do NOT inject previousOutput into previousFindings when the
                    // task uses the {previous} placeholder (the output is already inlined in the task text).
                    const usesPreviousPlaceholder = step.task.includes("{previous}");
                    let stepContext = mergeContext(step.context, autoContext);
                    if (previousOutput && !usesPreviousPlaceholder && i > 0) {
                        stepContext = {
                            ...(stepContext ?? {}),
                            previousFindings: stepContext?.previousFindings ?? truncate(previousOutput, PREVIOUS_OUTPUT_LIMIT),
                        };
                    }
                    const chainUpdate = onUpdate
                        ? (partial) => {
                            const currentResult = Array.isArray(partial.details)
                                ? partial.details[0]
                                : partial.details?.results?.[0];
                            if (currentResult) {
                                currentResult.model = currentResult.model || chainWorkerModel;
                                onUpdate({
                                    content: partial.content,
                                    details: makeDetails("chain")([...results, currentResult], chainExtra),
                                });
                            }
                        }
                        : undefined;
                    const workerAgent = agents.find(a => a.name === step.agent);
                    const workerType = toWorkerType(workerAgent);
                    await acquireSlot(workerType, config.parallelWorkers);
                    const chainWorkerId = workerLifecycle?.genWorkerId?.() ?? `w-${Date.now()}`;
                    const chainWorkerModel = workerAgent?.model || "";
                    const chainWorkerTemperature = resolveWorkerTemperature(step.agent, config);
                    const chainAbort = new AbortController();
                    // Forward external signal to per-worker abort
                    if (signal) {
                        if (signal.aborted) chainAbort.abort();
                        else signal.addEventListener("abort", () => chainAbort.abort(), { once: true });
                    }
                    workerLifecycle?.onWorkerStart?.(chainWorkerId, step.agent, chainWorkerModel);
                    updateWorker(chainWorkerId, { abortController: chainAbort });
                    let result;
                    try {
                        result = await runSingleAgent(ctx.cwd, agents, step.agent, taskWithContext, chainWorkerTemperature, step.cwd, i + 1, chainAbort.signal, chainUpdate, undefined, stepContext);
                    } catch (workerErr) {
                        const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                        const now = Date.now();
                        result = {
                            agent: step.agent,
                            agentSource: "unknown",
                            task: taskWithContext,
                            exitCode: 1,
                            stopReason: "error",
                            messages: [],
                            stderr: msg,
                            errorMessage: msg,
                            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                            model: chainWorkerModel,
                            text: "",
                            step: i + 1,
                            startTime: now,
                            endTime: now,
                            progress: { status: "Failed", messageCount: 0, toolCalls: [], model: chainWorkerModel },
                        };
                    }
                    finally {
                        workerLifecycle?.onWorkerStop?.(chainWorkerId, result?.exitCode === 0, result);
                        releaseSlot(workerType, config.parallelWorkers);
                    }
                    results.push(result);
                    const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || (result.exitCode === 0 && !((result.text ?? "").trim()));
                    if (isError) {
                        const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || (!result.text?.trim() ? "Worker completed with empty output" : "(no output)");
                        return {
                            content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                            details: makeDetails("chain")(results, chainExtra),
                            isError: true,
                        };
                    }
                    previousOutput = getFinalOutput(result.messages);
                }
                return {
                    content: [{ type: "text", text: (getFinalOutput(results[results.length - 1].messages) || "(no output)") }],
                    details: makeDetails("chain")(results, chainExtra),
                };
            }
            // === Parallel Mode ===
            if (params.tasks && params.tasks.length > 0) {
                if (params.tasks.length > MAX_PARALLEL_TASKS) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                            },
                        ],
                        details: makeDetails("parallel")([]),
                    };
                }
                // Block write workers from parallel mode
                const writeWorkersInParallel = params.tasks.filter(t => {
                    const agent = agents.find(a => a.name === t.agent);
                    return agent ? !agent.readOnly : WRITE_WORKER_TYPES.has(t.agent);
                });
                if (writeWorkersInParallel.length > 0) {
                    const names = [...new Set(writeWorkersInParallel.map(t => t.agent))].join(", ");
                    return {
                        content: [{
                            type: "text",
                            text: `Write workers (${names}) cannot run in parallel mode. Use single or chain mode instead.`,
                        }],
                        details: makeDetails("parallel")([]),
                        isError: true,
                    };
                }
                const allResults = new Array(params.tasks.length);
                for (let i = 0; i < params.tasks.length; i++) {
                    const initAgent = agents.find(a => a.name === params.tasks[i].agent);
                    allResults[i] = {
                        agent: params.tasks[i].agent,
                        agentSource: "unknown",
                        task: params.tasks[i].task,
                        exitCode: -1,
                        messages: [],
                        stderr: "",
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                        model: initAgent?.model || "",
                    };
                }
                const emitParallelUpdate = () => {
                    if (onUpdate) {
                        const running = allResults.filter((r) => r.exitCode === -1).length;
                        const done = allResults.filter((r) => r.exitCode !== -1).length;
                        // Build per-worker live status lines
                        const lines = [`⏳ PARALLEL: ${done}/${allResults.length} done, ${running} running`];
                        for (const r of allResults) {
                            const icon = AGENT_ICONS[r.agent] || "🤖";
                            if (r.exitCode === -1) {
                                // Running — show live progress
                                const p = r.progress;
                                const status = p?.status || "running";
                                const toolCount = p?.toolCalls?.length ?? 0;
                                const msgCount = p?.messageCount ?? 0;
                                const elapsed = r.startTime ? Math.round((Date.now() - r.startTime) / 1000) : 0;
                                const modelLabel = r.model || "";
                                lines.push(`  ${icon} ${r.agent}${modelLabel ? ` 🤖 ${modelLabel}` : ""} — ${status} · ${toolCount} tools · ${msgCount} msgs · ${elapsed}s`);
                                // Show last few tool calls
                                const tools = (p?.toolCalls || []).filter(tc => tc.preview).slice(-3);
                                for (const tc of tools) {
                                    lines.push(`    → ${tc.preview}`);
                                }
                            } else {
                                // Done
                                const statusIcon = r.exitCode === 0 ? "✓" : "✗";
                                lines.push(`  ${icon} ${r.agent} ${statusIcon}`);
                            }
                        }
                        onUpdate({
                            content: [
                                { type: "text", text: lines.join("\n") },
                            ],
                            details: makeDetails("parallel")([...allResults]),
                        });
                    }
                };
                const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
                    const parWorkerAgent = agents.find(a => a.name === t.agent);
                    const workerType = toWorkerType(parWorkerAgent);
                    await acquireSlot(workerType, config.parallelWorkers);
                    const parWorkerId = workerLifecycle?.genWorkerId?.() ?? `w-${Date.now()}-${index}`;
                    const parWorkerModel = parWorkerAgent?.model || "";
                    const parWorkerTemperature = resolveWorkerTemperature(t.agent, config);
                    const parAbort = new AbortController();
                    // Forward external signal to per-worker abort
                    if (signal) {
                        if (signal.aborted) parAbort.abort();
                        else signal.addEventListener("abort", () => parAbort.abort(), { once: true });
                    }
                    workerLifecycle?.onWorkerStart?.(parWorkerId, t.agent, parWorkerModel);
                    updateWorker(parWorkerId, { abortController: parAbort });
                    let result;
                    try {
                        result = await runSingleAgent(ctx.cwd, agents, t.agent, t.task, parWorkerTemperature, t.cwd, undefined, parAbort.signal, (partial) => {
                            const _cr = Array.isArray(partial.details) ? partial.details[0] : partial.details?.results?.[0];
                            if (_cr) {
                                // MERGE: keep exitCode=-1 (running), add progress data
                                allResults[index] = { ...allResults[index], ..._cr, exitCode: -1 };
                                emitParallelUpdate();
                            }
                        }, undefined, mergeContext(t.context, autoContext));
                    } catch (workerErr) {
                        const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                        const now = Date.now();
                        result = {
                            ...allResults[index],
                            exitCode: 1,
                            stopReason: "error",
                            messages: [],
                            stderr: msg,
                            errorMessage: msg,
                            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                            text: "",
                            endTime: now,
                            progress: { status: "Failed", messageCount: 0, toolCalls: [], model: allResults[index].model },
                        };
                        allResults[index] = result;
                        emitParallelUpdate();
                    }
                    finally {
                        workerLifecycle?.onWorkerStop?.(parWorkerId, result?.exitCode === 0, result);
                        releaseSlot(workerType, config.parallelWorkers);
                    }
                    allResults[index] = result;
                    emitParallelUpdate();
                    return result;
                });
                const anyFailed = results.some(r => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
                const successCount = results.filter((r) => r.exitCode === 0).length;
                const summaries = results.map((r) => {
                    const output = getFinalOutput(r.messages || []);
                    const preview = output || "(no output)";
                    return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}:\n${preview}`;
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n---\n")}`,
                        },
                    ],
                    details: makeDetails("parallel")(results),
                    ...(anyFailed ? { isError: true } : {}),
                };
            }
            // === Single Mode ===
            if (params.agent && params.task) {
                const singleUpdate = onUpdate
                    ? (partial) => {
                        const currentResult = Array.isArray(partial.details)
                            ? partial.details[0]
                            : partial.details?.results?.[0];
                        if (currentResult) {
                            currentResult.model = currentResult.model || workerModel;
                            onUpdate({
                                content: partial.content,
                                details: makeDetails("single")([currentResult]),
                            });
                        }
                    }
                    : undefined;
                const workerAgent = agents.find(a => a.name === params.agent);
                const workerType = toWorkerType(workerAgent);
                await acquireSlot(workerType, config.parallelWorkers);
                // Register worker for live widget display
                const workerId = workerLifecycle?.genWorkerId?.() ?? `w-${Date.now()}`;
                const workerModel = workerAgent?.model || "";
                const workerTemperature = resolveWorkerTemperature(params.agent, config);
                const singleAbort = new AbortController();
                // Forward external signal to per-worker abort
                if (signal) {
                    if (signal.aborted) singleAbort.abort();
                    else signal.addEventListener("abort", () => singleAbort.abort(), { once: true });
                }
                workerLifecycle?.onWorkerStart?.(workerId, params.agent, workerModel);
                updateWorker(workerId, { abortController: singleAbort });
                let result;
                try {
                    result = await runSingleAgent(ctx.cwd, agents, params.agent, params.task, workerTemperature, params.cwd, undefined, singleAbort.signal, singleUpdate, undefined, mergeContext(params.context, autoContext));
                } catch (workerErr) {
                    const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
                    const now = Date.now();
                    result = {
                        agent: params.agent,
                        agentSource: "unknown",
                        task: params.task,
                        exitCode: 1,
                        stopReason: "error",
                        messages: [],
                        stderr: msg,
                        errorMessage: msg,
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                        model: workerModel,
                        text: "",
                        step: undefined,
                        startTime: now,
                        endTime: now,
                        progress: { status: "Failed", messageCount: 0, toolCalls: [], model: workerModel },
                    };
                }
                finally {
                    workerLifecycle?.onWorkerStop?.(workerId, result?.exitCode === 0, result);
                    releaseSlot(workerType, config.parallelWorkers);
                }
                const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || (result.exitCode === 0 && !((result.text ?? "").trim()));
                if (isError) {
                    const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || (!result.text?.trim() ? "Worker completed with empty output" : "(no output)");
                    return {
                        content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                        details: makeDetails("single")([result]),
                        isError: true,
                    };
                }
                return {
                    content: [{ type: "text", text: (getFinalOutput(result.messages) || "(no output)") }],
                    details: makeDetails("single")([result]),
                };
            }
            const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
            return {
                content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
                details: makeDetails("single")([]),
            };
        },
        renderCall(args, theme) {
            if (args.chain && args.chain.length > 0) {
                let text = theme.fg("toolTitle", theme.bold("🔗 CHAIN worker")) + theme.fg("muted", ` (${args.chain.length} steps)`);
                for (let i = 0; i < Math.min(args.chain.length, 5); i++) {
                    const step = args.chain[i];
                    const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
                    const preview = cleanTask.length > 50 ? `${cleanTask.slice(0, 50)}...` : cleanTask;
                    text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("muted", "☐")} ${getAgentIcon(step.agent)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
                    const ctxIndicator = formatContextIndicator(step.context);
                    if (ctxIndicator)
                        text += `\n     ${theme.fg("muted", ctxIndicator)}`;
                }
                if (args.chain.length > 5)
                    text += `\n  ${theme.fg("muted", `... +${args.chain.length - 5} more`)}`;
                return new Text(text, 0, 0);
            }
            if (args.tasks && args.tasks.length > 0) {
                let text = theme.fg("toolTitle", theme.bold("⚡ PARALLEL worker")) + theme.fg("muted", ` (${args.tasks.length} tasks)`);
                for (const t of args.tasks.slice(0, 5)) {
                    const preview = (t.task || "").length > 50 ? `${(t.task || "").slice(0, 50)}...` : (t.task || "(no description)");
                    text += `\n  ${getAgentIcon(t.agent)} ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
                    const ctxIndicator = formatContextIndicator(t.context);
                    if (ctxIndicator)
                        text += `\n     ${theme.fg("muted", ctxIndicator)}`;
                }
                if (args.tasks.length > 5)
                    text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 5} more`)}`;
                return new Text(text, 0, 0);
            }
            const agentIcon = getAgentIcon(args.agent || "unknown");
            const agentLabel = (args.agent || "unknown").toUpperCase();
            let text = theme.fg("toolTitle", theme.bold(`${agentIcon} ${agentLabel} worker`));
            if (args.task) {
                const preview = (args.task || "").length > 80 ? `${(args.task || "").slice(0, 80)}...` : (args.task || "");
                text += `\n  ${theme.fg("dim", `ЗАДАЧА: ${preview}`)}`;
            }
            const ctxIndicator = formatContextIndicator(args.context);
            if (ctxIndicator)
                text += `\n  ${theme.fg("muted", ctxIndicator)}`;
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const details = result.details;
            if (!details || details.results.length === 0) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
            }
            const mdTheme = getMarkdownTheme();
            const fmtTool = (name, args) => formatToolCall(name, args, theme.fg.bind(theme));
            const aggregateUsage = (results) => {
                const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
                for (const r of results) {
                    const u = r.usage || {};
                    total.input += u.input || 0;
                    total.output += u.output || 0;
                    total.cacheRead += u.cacheRead || 0;
                    total.cacheWrite += u.cacheWrite || 0;
                    total.cost += u.cost || 0;
                    total.turns += u.turns || 0;
                }
                return total;
            };
            const formatFooter = (r) => {
                const parts = [];
                const tc = getResultToolCalls(r).length;
                parts.push(`${tc} tool${tc !== 1 ? "s" : ""}`);
                const msgCount = r.progress?.messageCount ?? (r.messages || []).filter((m) => m.role === "assistant" || m.role === "user").length;
                parts.push(`${msgCount} msg${msgCount !== 1 ? "s" : ""}`);
                if (r.startTime)
                    parts.push(formatElapsedTime(r.startTime, r.endTime));
                const usageStr = r.usage ? formatUsageStats(r.usage, r.model) : "";
                if (usageStr)
                    parts.push(usageStr);
                return parts.join(" · ");
            };
            const formatAggregateFooter = (results) => {
                const parts = [];
                const totalTools = results.reduce((s, r) => s + getResultToolCalls(r).length, 0);
                parts.push(`${totalTools} tool${totalTools !== 1 ? "s" : ""}`);
                const starts = results.map((r) => r.startTime ?? Infinity);
                const ends = results.map((r) => r.endTime ?? 0);
                const firstStart = Math.min(...starts);
                const lastEnd = Math.max(...ends);
                if (firstStart < Infinity && lastEnd > 0)
                    parts.push(formatElapsedTime(firstStart, lastEnd));
                const usageStr = formatUsageStats(aggregateUsage(results));
                if (usageStr)
                    parts.push(usageStr);
                return parts.join(" · ");
            };
            // ─── SINGLE MODE ───────────────────────────────────────
            if (details.mode === "single" && details.results.length === 1) {
                const r = details.results[0];
                const isRunning = !r.endTime;
                const isError = !isRunning && (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
                const toolCount = countToolCalls(r.messages || []);
                const modelLabel = r.model || "initializing...";
                // ── Running (collapsed) ──
                if (isRunning) {
                    const icon = theme.fg("warning", "⏳");
                    const progress = r.progress || {};
                    const statusLabel = progress.status || "Processing";
                    const msgCount = progress.messageCount ?? 0;
                    const progressTools = progress.toolCalls || [];
                    const toolCount = progressTools.length;
                    const elapsed = r.startTime ? formatElapsedTime(r.startTime) : "";
                    const statusParts = [];
                    statusParts.push(`🤖 ${modelLabel}`);
                    if (elapsed) statusParts.push(`⏱ ${elapsed}`);
                    statusParts.push(`💬 ${msgCount} message${msgCount !== 1 ? "s" : ""}`);
                    statusParts.push(`🔧 ${toolCount} tool${toolCount !== 1 ? "s" : ""}`);
                    let text = `${icon} ${theme.fg("muted", statusParts.join(" | "))}`;
                    const lastTools = progressTools.slice(-MAX_LIVE_TOOLS);
                    if (lastTools.length > 0) {
                        for (const tc of lastTools) {
                            const previewStr = tc.preview || formatToolPreview(tc.name, tc.args);
                            text += `\n  ${theme.fg("muted", "→ ")}${theme.fg("toolOutput", previewStr)}`;
                        }
                    }
                    else {
                        text += `\n  ${theme.fg("muted", `(${statusLabel === "Thinking" ? "thinking" : "initializing"}...)`)}`;
                    }
                    return new Text(text, 0, 0);
                }
                // ── Completed ──
                const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                const finalOutput = getFinalOutput(r.messages || []);
                const allToolCalls = getResultToolCalls(r);
                if (expanded) {
                    const container = new Container();
                    if (isError && r.errorMessage)
                        container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
                    if (isError && r.stderr && !r.errorMessage)
                        container.addChild(new Text(theme.fg("error", `Stderr: ${r.stderr.slice(0, 500)}`), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", "─── ЗАДАЧА ───"), 0, 0));
                    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", `─── Tools (${allToolCalls.length}) ───`), 0, 0));
                    if (allToolCalls.length === 0) {
                        container.addChild(new Text(theme.fg("muted", "(no tools)"), 0, 0));
                    }
                    else {
                        for (const item of allToolCalls) {
                            if (item.preview) {
                                container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", item.preview), 0, 0));
                            } else {
                                container.addChild(new Text(theme.fg("muted", "→ ") + fmtTool(item.name, item.args), 0, 0));
                            }
                        }
                    }
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
                    if (finalOutput) {
                        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                    }
                    else {
                        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
                    }
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("dim", formatFooter(r)), 0, 0));
                    return container;
                }
                // Collapsed completed
                let text = `${icon} ${theme.fg("muted", `(${modelLabel})`)}`;
                if (isError && r.stopReason)
                    text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                if (isError && r.errorMessage) {
                    text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
                }
                else if (isError && r.stderr) {
                    text += `\n${theme.fg("error", `Stderr: ${r.stderr.slice(0, 500)}`)}`;
                }
                // Show partial tool calls for aborted/failed workers (even without final output)
                if (isError && allToolCalls.length > 0 && !finalOutput) {
                    const partialTools = allToolCalls.slice(-5);
                    text += `\n${theme.fg("muted", `─── Partial work (${allToolCalls.length} tools) ───`)}`;
                    for (const tc of partialTools) {
                        if (tc.preview) {
                            text += `\n${theme.fg("muted", "→ ")}${theme.fg("toolOutput", tc.preview)}`;
                        } else {
                            text += `\n${theme.fg("muted", "→ ")}${theme.fg("toolOutput", tc.name)}`;
                        }
                    }
                    if (allToolCalls.length > 5) {
                        text += `\n${theme.fg("muted", `... ${allToolCalls.length - 5} more tools`)}`;
                    }
                }
                if (finalOutput) {
                    const lines = finalOutput.trim().split("\n");
                    const MAX_COLLAPSED_LINES = 50;
                    if (lines.length > MAX_COLLAPSED_LINES) {
                        const preview = lines.slice(0, MAX_COLLAPSED_LINES).join("\n");
                        text += `\n${theme.fg("toolOutput", preview)}`;
                        text += `\n${theme.fg("muted", `... ${lines.length - MAX_COLLAPSED_LINES} more lines (Ctrl+O to expand)`)}`;
                    } else {
                        text += `\n${theme.fg("toolOutput", finalOutput.trim())}`;
                    }
                }
                else if (!isError) {
                    text += `\n${theme.fg("muted", "(no output)")}`;
                }
                text += `\n${theme.fg("dim", formatFooter(r))}`;
                return new Text(text, 0, 0);
            }
            // ─── CHAIN MODE ────────────────────────────────────────
            if (details.mode === "chain") {
                const hasPlan = Array.isArray(details.plan) && details.plan.length > 0;
                const totalSteps = details.totalSteps || (hasPlan ? details.plan.length : details.results.length);
                const completedSteps = details.results.filter((r) => !!r.endTime).length;
                const failedCount = details.results.filter((r) => !!r.endTime && (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted")).length;
                const allDone = completedSteps === totalSteps;
                const terminated = result.isError || allDone;
                const icon = !terminated
                    ? theme.fg("warning", "⏳")
                    : (failedCount > 0)
                        ? theme.fg("error", "✗")
                        : theme.fg("success", "✓");
                const headerStatus = `${completedSteps}/${totalSteps} steps` + (failedCount > 0 ? ` · ${failedCount} failed` : "");
                // Helper: determine step status for index i (0-based)
                const stepStatus = (i) => {
                    const r = details.results.find(x => x.step === i + 1);
                    if (!r) return "pending";
                    if (!r.endTime) return "running";
                    if (r.exitCode === 0 && !r.stopReason) return "completed";
                    return "failed";
                };
                const stepIcon = (status) => {
                    switch (status) {
                        case "completed": return theme.fg("muted", "☑");
                        case "failed": return theme.fg("error", "✗");
                        case "running": return theme.fg("warning", "◐");
                        default: return theme.fg("muted", "☐");
                    }
                };
                // Find the running step index (0-based) for collapsed view
                const runningStepIdx = hasPlan ? details.plan.findIndex((_, i) => stepStatus(i) === "running") : -1;
                const runningStepPlan = runningStepIdx >= 0 ? details.plan[runningStepIdx] : null;
                if (expanded) {
                    const container = new Container();
                    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("CHAIN worker"))} ${theme.fg("accent", `(${headerStatus})`)}`, 0, 0));
                    const stepCount = hasPlan ? details.plan.length : details.results.length;
                    for (let i = 0; i < stepCount; i++) {
                        const status = stepStatus(i);
                        const sIcon = stepIcon(status);
                        container.addChild(new Spacer(1));
                        if (status === "pending") {
                            const p = details.plan[i];
                            const cleanTask = (p.task || "").replace(/\{previous\}/g, "").trim();
                            const preview = cleanTask.length > 80 ? `${cleanTask.slice(0, 80)}...` : cleanTask;
                            container.addChild(new Text(`${theme.fg("muted", `─── Step ${i + 1}:`)} ${sIcon} ${getAgentIcon(p.agent)} ${theme.fg("muted", p.agent)} ${theme.fg("muted", preview)}`, 0, 0));
                        } else {
                            const r = details.results.find(x => x.step === i + 1);
                            const chainStepModel = r.model ? theme.fg("muted", ` 🤖 ${r.model}`) : "";
                            const isRunning = status === "running";
                            const stepTaskText = isRunning
                                ? theme.fg("muted", "Task: ") + theme.fg("warning", theme.bold(r.task))
                                : theme.fg("muted", "Task: ") + (status === "completed"
                                    ? theme.fg("muted", theme.strikethrough(r.task))
                                    : theme.fg("dim", r.task));
                            container.addChild(new Text(`${theme.fg("muted", `─── Step ${r.step}:`)} ${sIcon} ${getAgentIcon(r.agent)} ${theme.fg(isRunning ? "warning" : "accent", r.agent)}${chainStepModel}`, 0, 0));
                            container.addChild(new Text(stepTaskText, 0, 0));
                            const rToolCalls = getResultToolCalls(r);
                            for (const item of rToolCalls) {
                                if (item.preview) {
                                    container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", item.preview), 0, 0));
                                } else {
                                    container.addChild(new Text(theme.fg("muted", "→ ") + fmtTool(item.name, item.args), 0, 0));
                                }
                            }
                            if (isRunning) {
                                const progressTools = r.progress?.toolCalls || [];
                                const lastTools = progressTools.slice(-5);
                                for (const tc of lastTools) {
                                    const previewStr = tc.preview || formatToolPreview(tc.name, tc.args);
                                    container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", previewStr), 0, 0));
                                }
                                if (lastTools.length === 0) {
                                    container.addChild(new Text(theme.fg("muted", "(running...)"), 0, 0));
                                }
                            } else {
                                const rOutput = getFinalOutput(r.messages || []);
                                if (rOutput) {
                                    container.addChild(new Spacer(1));
                                    container.addChild(new Markdown(rOutput.trim(), 0, 0, mdTheme));
                                }
                                container.addChild(new Text(theme.fg("dim", formatFooter(r)), 0, 0));
                            }
                        }
                    }
                    if (terminated) {
                        container.addChild(new Spacer(1));
                        container.addChild(new Text(theme.fg("dim", formatAggregateFooter(details.results)), 0, 0));
                    }
                    return container;
                }
                // Collapsed chain
                let text = `${icon} ${theme.fg("toolTitle", theme.bold("CHAIN worker"))} ${theme.fg("accent", `(${headerStatus})`)}`;
                if (runningStepPlan) {
                    text += ` ${theme.fg("warning", `· ◐ step ${runningStepIdx + 1}: ${getAgentIcon(runningStepPlan.agent)} ${runningStepPlan.agent}`)}`;
                }
                // Show pending count only when chain is still running
                if (hasPlan && !terminated) {
                    const pendingCount = details.plan.filter((_, i) => stepStatus(i) === "pending").length;
                    if (pendingCount > 0) {
                        text += ` ${theme.fg("dim", `(${pendingCount} pending)`)}`;
                    }
                }
                for (const r of details.results) {
                    const rRunning = !r.endTime;
                    const rIcon = rRunning
                        ? theme.fg("warning", "◐")
                        : (r.exitCode === 0 && !r.stopReason)
                            ? theme.fg("muted", "☑")
                            : theme.fg("error", "✗");
                    const rOutput = getFinalOutput(r.messages || []);
                    const chainCollapsedModel = r.model ? theme.fg("muted", ` 🤖 ${r.model}`) : "";
                    text += `\n\n${theme.fg("muted", `─── Step ${r.step}:`)} ${rIcon} ${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)}${chainCollapsedModel}`;
                    if (rRunning) {
                        const progressTools = r.progress?.toolCalls || [];
                        const lastTools = progressTools.slice(-5);
                        if (lastTools.length > 0) {
                            for (const tc of lastTools) {
                                const previewStr = tc.preview || formatToolPreview(tc.name, tc.args);
                                text += `\n${theme.fg("muted", "→ ")}${theme.fg("toolOutput", previewStr)}`;
                            }
                        }
                        else {
                            text += `\n${theme.fg("muted", "(running...)")}`;
                        }
                    }
                    else if (rOutput) {
                        const lines = rOutput.trim().split("\n");
                        const preview = lines.slice(0, 15).join("\n");
                        text += `\n${theme.fg("toolOutput", preview)}`;
                        if (lines.length > 15)
                            text += `\n${theme.fg("muted", `... ${lines.length - 15} more lines`)}`;
                    }
                    else {
                        text += `\n${theme.fg("muted", "(no output)")}`;
                    }
                    if (!rRunning)
                        text += `\n${theme.fg("dim", formatFooter(r))}`;
                }
                if (terminated)
                    text += `\n\n${theme.fg("dim", formatAggregateFooter(details.results))}`;
                text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                return new Text(text, 0, 0);
            }
            // ─── PARALLEL MODE ─────────────────────────────────────
            if (details.mode === "parallel") {
                const running = details.results.filter((r) => !r.endTime).length;
                const successCount = details.results.filter((r) => r.exitCode === 0).length;
                const failCount = details.results.filter((r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted").length;
                const doneCount = successCount + failCount;
                const isRunning = running > 0;
                const icon = isRunning
                    ? theme.fg("warning", "⏳")
                    : failCount > 0
                        ? theme.fg("warning", "◐")
                        : theme.fg("success", "✓");
                const status = isRunning
                    ? `${doneCount}/${details.results.length} done, ${running} running`
                    : `${successCount}/${details.results.length} tasks`;
                if (expanded && !isRunning) {
                    const container = new Container();
                    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("PARALLEL worker"))} ${theme.fg("accent", `(${status})`)}`, 0, 0));
                    for (const r of details.results) {
                        const rFailed = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
                        const rIcon = !rFailed ? theme.fg("success", "✓") : theme.fg("error", "✗");
                        const rOutput = getFinalOutput(r.messages || []);
                        container.addChild(new Spacer(1));
                        const parExpModel = r.model ? theme.fg("muted", ` 🤖 ${r.model}`) : "";
                        container.addChild(new Text(`${theme.fg("muted", "─── ")}${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)}${parExpModel} ${rIcon}`, 0, 0));
                        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
                        const rToolCalls = getResultToolCalls(r);
                        for (const item of rToolCalls) {
                            if (item.preview) {
                                container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", item.preview), 0, 0));
                            } else {
                                container.addChild(new Text(theme.fg("muted", "→ ") + fmtTool(item.name, item.args), 0, 0));
                            }
                        }
                        if (rOutput) {
                            container.addChild(new Spacer(1));
                            container.addChild(new Markdown(rOutput.trim(), 0, 0, mdTheme));
                        }
                        container.addChild(new Text(theme.fg("dim", formatFooter(r)), 0, 0));
                    }
                    container.addChild(new Spacer(1));
                    container.addChild(new Text(theme.fg("dim", formatAggregateFooter(details.results)), 0, 0));
                    return container;
                }
                // Collapsed parallel (includes running state)
                let text = `${icon} ${theme.fg("toolTitle", theme.bold("PARALLEL worker"))} ${theme.fg("accent", `(${status})`)}`;
                for (const r of details.results) {
                    const rRunning = !r.endTime;
                    const rIcon = rRunning
                        ? theme.fg("warning", "⏳")
                        : (r.exitCode === 0 && !r.stopReason)
                            ? theme.fg("success", "✓")
                            : theme.fg("error", "✗");
                    const rOutput = getFinalOutput(r.messages || []);
                    const parCollapsedModel = r.model ? theme.fg("muted", ` 🤖 ${r.model}`) : "";
                    text += `\n\n${theme.fg("muted", "─── ")}${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)}${parCollapsedModel} ${rIcon}`;
                    if (rRunning) {
                        const progressTools = r.progress?.toolCalls || [];
                        const lastTools = progressTools.slice(-5);
                        if (lastTools.length > 0) {
                            for (const tc of lastTools) {
                                const previewStr = tc.preview || formatToolPreview(tc.name, tc.args);
                                text += `\n${theme.fg("muted", "→ ")}${theme.fg("toolOutput", previewStr)}`;
                            }
                        }
                        else {
                            text += `\n${theme.fg("muted", "(running...)")}`;
                        }
                    }
                    else if (rOutput) {
                        const lines = rOutput.trim().split("\n");
                        const preview = lines.slice(0, 15).join("\n");
                        text += `\n${theme.fg("toolOutput", preview)}`;
                        if (lines.length > 15)
                            text += `\n${theme.fg("muted", `... ${lines.length - 15} more lines`)}`;
                    }
                    else {
                        text += `\n${theme.fg("muted", "(no output)")}`;
                    }
                    if (!rRunning)
                        text += `\n${theme.fg("dim", formatFooter(r))}`;
                }
                if (!isRunning)
                    text += `\n\n${theme.fg("dim", formatAggregateFooter(details.results))}`;
                text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                return new Text(text, 0, 0);
            }
            // Fallback
            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        },
        resultReplacesCall: true,
    });
    // ---- list_tasks ----
    fan.registerTool({
        name: "list_tasks",
        label: "List Tasks",
        description: "List orchestrator tasks. Optionally filter by status.",
        parameters: Type.Object({
            status: Type.Optional(Type.String({ description: "Filter by status: pending, in_progress, completed, failed, blocked" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const filter = {};
            if (params.status)
                filter.status = params.status;
            const tasks = taskManager.getTasks(filter);
            const counts = taskManager.getStatusCounts();
            if (tasks.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No tasks found. Status counts: ${JSON.stringify(counts)}`,
                        },
                    ],
                    details: undefined,
                };
            }
            const lines = tasks.map((t) => {
                const result = t.result ? ` → ${t.result.slice(0, 80)}` : "";
                const error = t.error ? ` [${t.error}]` : "";
                return `[${t.status}] ${t.id} ${t.agentType}: ${t.description}${error}${result}`;
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Tasks (${tasks.length}):\n${lines.join("\n")}\n\nStatus counts: ${JSON.stringify(counts)}`,
                    },
                ],
                details: undefined,
            };
        },
    });
    // ---- cancel_task ----
    fan.registerTool({
        name: "cancel_task",
        label: "Cancel Task",
        description: "Cancel a running or pending orchestrator task.",
        parameters: Type.Object({
            taskId: Type.String({ description: "The ID of the task to cancel" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            try {
                const task = taskManager.cancelTask(params.taskId);
                return {
                    content: [{ type: "text", text: `Task ${task.id} cancelled.` }],
                    details: undefined,
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: `Failed to cancel task: ${e.message}` }],
                    isError: true,
                    details: undefined,
                };
            }
        },
    });
    // ---- classify_task ----
    fan.registerTool({
        name: "classify_task",
        label: "Classify Task",
        description: "Classify a task description to determine the best worker type (explore, plan, implement, verify).",
        parameters: Type.Object({
            description: Type.String({ description: "Task description to classify" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const classification = classifyTaskByDescription(params.description);
            return {
                content: [
                    {
                        type: "text",
                        text: `Classification:
  Worker type: ${classification.workerType}
  Confidence: ${classification.confidence}
  Reasoning: ${classification.reasoning}`,
                    },
                ],
                details: undefined,
            };
        },
    });
    // ---- assess_task ----
    fan.registerTool({
        name: "assess_task",
        label: "Assess Task Complexity",
        description: [
            "Multi-level task complexity assessment for the coordinator.",
            "Returns verdict: direct (coordinator handles it), delegate (spawn worker), or uncertain.",
            "Level 1: keyword heuristic — fast deterministic check.",
            "Level 2: rule-based scoring — syntactic analysis with weighted rules.",
            "Level 3: LLM assessment — semantic analysis using a quick model call (optional).",
            "",
            "DIRECT criteria (coordinator does it):",
            ...DIRECT_TASK_RULES.map(r => `  - ${r}`),
            "",
            "DELEGATE criteria (needs worker):",
            ...DELEGATE_TASK_RULES.map(r => `  - ${r}`),
        ].join("\n"),
        parameters: Type.Object({
            description: Type.String({ description: "Task description to assess" }),
            levels: Type.Optional(Type.Integer({ description: "Assessment depth (1-3). 1=keywords only, 2=+rules, 3=+LLM. Default: 2", default: 2, minimum: 1, maximum: 3 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            try {
                const levels = params.levels ?? 2;
                const result = await classifyComplexity(params.description, {
                    levels,
                    taskContext: {},
                    signal: _signal,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: formatComplexityResult(result),
                        },
                    ],
                    details: undefined,
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: `Assessment failed: ${e.message}` }],
                    isError: true,
                    details: undefined,
                };
            }
        },
        renderCall(args, theme) {
            const levels = args.levels ?? 2;
            let text = theme.fg("toolTitle", theme.bold("📊 ASSESS task"));
            text += `\n  ${theme.fg("dim", `Levels: L1-L${levels}`)}`;
            const preview = (args.description || "").length > 60
                ? `${(args.description || "").slice(0, 60)}...`
                : (args.description || "");
            text += `\n  ${theme.fg("toolOutput", preview)}`;
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded }, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "(no output)";
            if (expanded) {
                return new Text(content, 0, 0);
            }
            // Extract first line as summary
            const firstLine = content.split("\n")[0];
            return new Text(`${firstLine}`, 0, 0);
        },
    });
    // ---- TaskCreate ----
    fan.registerTool({
        name: "TaskCreate",
        label: "Create Task",
        description: "Create a tracked task for decomposition. Tasks can block each other via blocks[].",
        parameters: Type.Object({
            subject: Type.String({ description: "Short description of the task" }),
            description: Type.Optional(Type.String({ description: "Detailed description of the task" })),
            owner: Type.Optional(Type.String({ description: "Worker ID that owns this task" })),
            blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks (creates dependency)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            try {
                const task = taskManager.createTask({
                    description: params.subject,
                    agentType: "implement",
                    blocks: params.blocks,
                    owner: params.owner,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Task created: ${task.id}\nSubject: ${params.subject}${task.status === "blocked" ? "\nStatus: blocked (waiting for dependencies)" : "\nStatus: pending"}${params.description ? `\nDescription: ${params.description}` : ""}${params.blocks?.length ? `\nBlocks: ${params.blocks.join(", ")}` : ""}`,
                        },
                    ],
                    details: undefined,
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: `Failed to create task: ${e.message}` }],
                    isError: true,
                    details: undefined,
                };
            }
        },
    });
    fan.registerTool({
        name: "TaskUpdate",
        label: "Update Task",
        description: "Update a task's status. REQUIRED parameter: status. Optional: subject, description, blocks. Completing a task auto-unblocks dependents. Do NOT call this repeatedly with the same status — if the task is already in the target status, move on to the next step.",
        parameters: Type.Object({
            taskId: Type.String({ description: "The ID of the task to update" }),
            status: Type.String({ description: "New status: pending, in_progress, completed, blocked, failed" }),
            subject: Type.Optional(Type.String({ description: "New subject/description" })),
            description: Type.Optional(Type.String({ description: "New detailed description" })),
            blocks: Type.Optional(Type.Array(Type.String(), { description: "New blocks array (replaces existing)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            try {
                // === REQUIRED FIELDS GUARD ===
                if (!params.status || typeof params.status !== "string" || params.status.trim() === "") {
                    return {
                        content: [{ type: "text", text: "ERROR: TaskUpdate requires a non-empty 'status' parameter. Valid statuses: pending, in_progress, completed, blocked, failed." }],
                        isError: true,
                        details: undefined,
                    };
                }
                const existingTask = taskManager.getTask(params.taskId);
                // === NO-OP DETECTION ===
                if (existingTask && params.status && existingTask.status === params.status && !params.subject && !params.description && params.blocks === undefined) {
                    return {
                        content: [{ type: "text", text: `STOP. Task ${params.taskId} status is ALREADY "${params.status}". This call had ZERO effect. DO NOT retry — move to the NEXT step immediately.` }],
                        isError: true,
                        details: undefined,
                    };
                }
                const updates = {};
                if (params.status)
                    updates.status = params.status;
                if (params.subject)
                    updates.subject = params.subject;
                if (params.description)
                    updates.description = params.description;
                if (params.blocks !== undefined)
                    updates.blocks = params.blocks;
                let task;
                try {
                    task = taskManager.updateTask(params.taskId, updates);
                } catch (e) {
                    // If update fails, try to mark task as failed
                    try { taskManager.updateTask(params.taskId, { status: "failed" }); } catch {}
                    return {
                        content: [{ type: "text", text: `Failed to update task: ${e.message}. Task marked as failed.` }],
                        isError: true,
                    };
                }
                // Check if any dependents were unblocked
                const unblockedCount = task.status === "completed"
                    ? taskManager.getTasks().filter((t) => t.blockedBy?.includes(task.id) && t.status !== "blocked")
                        .length
                    : 0;
                return {
                    content: [
                        {
                            type: "text",
                            text: "Task updated: " + task.id + "\nStatus: " + task.status + (params.subject ? "\nSubject: " + params.subject : "") + (unblockedCount > 0 ? "\nDependents unblocked: " + unblockedCount : ""),
                        },
                    ],
                    details: undefined,
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: `Failed to update task: ${e.message}` }],
                    isError: true,
                    details: undefined,
                };
            }
        },
    });
    // ---- TaskClear ----
    fan.registerTool({
        name: "TaskClear",
        label: "Clear Completed Tasks",
        description: "Remove all completed and failed tasks from the task list. Call this after your final report when all work is done.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
            const counts = taskManager.getStatusCounts();
            const removed = taskManager.clearCompleted();
            return {
                content: [
                    {
                        type: "text",
                        text: removed > 0
                            ? `Cleared ${removed} task(s) from task list. Remaining: ${taskManager.size} tasks.`
                            : "No completed or failed tasks to clear.",
                    },
                ],
                details: undefined,
            };
        },
    });
    // ---- stop_worker ----
    fan.registerTool({
        name: "stop_worker",
        label: "Stop Worker",
        description: "Stop a running or spawning worker by its ID.",
        parameters: Type.Object({
            workerId: Type.String({ description: "The worker ID to stop" }),
            reason: Type.Optional(Type.String({ description: "Reason for stopping" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            const worker = getWorker(params.workerId);
            if (!worker) {
                return {
                    content: [{ type: "text", text: `Worker not found: ${params.workerId}` }],
                    isError: true,
                    details: undefined,
                };
            }
            if (worker.status === "completed" || worker.status === "failed" || worker.status === "aborted") {
                return {
                    content: [{ type: "text", text: `Worker ${worker.id} is already ${worker.status}.` }],
                    details: undefined,
                };
            }
            // Signal the subprocess to abort via AbortController
            try { worker.abortController?.abort(); } catch {}
            updateWorker(worker.id, { status: "aborted", endTime: Date.now(), error: params.reason ?? "Stopped by coordinator" });
            return {
                content: [{ type: "text", text: `Worker ${worker.id} (${worker.agentType}) stopped.${params.reason ? ` Reason: ${params.reason}` : ""}` }],
                details: undefined,
            };
        },
    });
}
//# sourceMappingURL=orchestrator-tools.js.map