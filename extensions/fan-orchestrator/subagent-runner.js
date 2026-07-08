/**
 * Subprocess Runner — Spawns fan subprocesses for subagent execution
 *
 * Architecture (pi-style, ported from pi-orchestrator/rpc.ts):
 * - ONE timer: stallTimer — resets on ANY stdout data from the subprocess
 * - NO progressTimer — actively streaming LLM emits stdout continuously
 *   so stallTimer never fires during generation
 * - NO hard execution limit — recursive setTimeout poll runs until completion
 * - NO maxPollIterations — worker can run as long as it's producing data
 *
 * Protocol: stdin/stdout JSONL. Commands: prompt, get_state, get_last_assistant_text.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export function getFinalOutput(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === "text")
                    return part.text;
            }
        }
    }
    return "";
}
export function getDisplayItems(messages) {
    const items = [];
    for (const msg of messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === "text")
                    items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall")
                    items.push({ type: "toolCall", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}
export function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
}
export function formatUsageStats(usage, model) {
    const parts = [];
    if (usage.turns)
        parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input)
        parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output)
        parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead)
        parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite)
        parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.cost)
        parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
    }
    if (model)
        parts.push(model);
    return parts.join(" ");
}
export async function mapWithConcurrencyLimit(items, concurrency, fn) {
    if (items.length === 0)
        return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length)
                return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}
/** Shorten home dir to ~ */
function shortenPath(p) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Truncate string to maxLen with ellipsis */
function trunc(s, maxLen = 120) {
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

/** Get first non-empty line of a string */
function firstLine(s) {
    return (s || "").split("\n").map(l => l.trim()).filter(Boolean)[0] || "";
}

/** Normalize args — handle both object and JSON string */
function normalizeArgs(raw) {
    if (!raw) return {};
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    if (typeof raw === "object") return raw;
    return {};
}

/** Extract a descriptive preview from tool call arguments */
export function formatToolPreview(toolName, rawArgs) {
    const args = normalizeArgs(rawArgs);
    switch (toolName) {
        case "bash": {
            const cmd = (args.command) || "...";
            return trunc(cmd);
        }
        case "read": {
            const p = shortenPath((args.file_path || args.path || "..."));
            const offset = args.offset;
            const limit = args.limit;
            let s = `read ${p}`;
            if (offset !== undefined || limit !== undefined) {
                const from = offset ?? 1;
                const to = limit ? from + limit - 1 : "";
                s += ` :${from}-${to}`;
            }
            return trunc(s);
        }
        case "write": {
            const p = shortenPath((args.file_path || args.path || "..."));
            const content = (args.content || "");
            const lines = content.split("\n").length;
            const bytes = new TextEncoder().encode(content).length;
            const sizeStr = bytes > 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
            return trunc(`write ${p} (${lines} lines, ${sizeStr})`);
        }
        case "edit": {
            const p = shortenPath((args.file_path || args.path || "..."));
            const oldText = firstLine(args.oldText);
            const newText = firstLine(args.newText);
            let s = `edit ${p}`;
            if (oldText) s += `  <- "${oldText.slice(0, 40)}"`;
            if (newText) s += `  -> "${newText.slice(0, 40)}"`;
            return trunc(s);
        }
        case "grep": {
            const pat = (args.pattern || "");
            const p = shortenPath((args.path || "."));
            const include = (args.include || "");
            let s = `grep /${pat}/ in ${p}`;
            if (include) s += ` include:${include}`;
            return trunc(s);
        }
        case "find": {
            const pat = (args.pattern || "*");
            const p = shortenPath((args.path || "."));
            return trunc(`find ${pat} in ${p}`);
        }
        case "ls": {
            const p = shortenPath((args.path || "."));
            return `ls ${p}`;
        }
        default: {
            const s = JSON.stringify(args);
            return trunc(s);
        }
    }
}
/**
 * Resolve the fan binary invocation.
 * Tries current script path first, then falls back to "fan" command.
 */
let _cachedInvocation = null;
export function getFnaInvocation(args) {
    if (!_cachedInvocation) {
        const currentScript = process.argv[1];
        if (currentScript && fs.existsSync(currentScript)) {
            _cachedInvocation = { command: process.execPath, baseArgs: [currentScript] };
        }
        else {
            const execName = path.basename(process.execPath).toLowerCase();
            const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
            if (!isGenericRuntime) {
                _cachedInvocation = { command: process.execPath, baseArgs: [] };
            }
            else {
                _cachedInvocation = { command: "fan", baseArgs: [] };
            }
        }
    }
    return { command: _cachedInvocation.command, args: [..._cachedInvocation.baseArgs, ...args] };
}

/**
 * Format a millisecond duration as MM:SS or H:MM:SS
 */
function formatDuration(ms) {
    const totalSecs = Math.round(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    if (mins >= 60) {
        return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// ── Core worker spawn (pi-style) ──────────────────────────────────────────

/**
 * Spawn a fan worker in RPC mode. Returns a promise that resolves when done.
 *
 * Protocol flow (mirrors pi-orchestrator):
 * 1. Send `prompt` with agent instructions + task (after 500ms delay)
 * 2. Poll `get_state` every 2s until `isStreaming` becomes false (after 1s delay post-prompt-ack)
 * 3. Send `get_last_assistant_text` to get the result
 * 4. Resolve with WorkerResult
 *
 * Single stallTimer — reset on ANY stdout data. Worker can run indefinitely
 * as long as it's producing output. If no output for stallTimeout ms → kill.
 */
export function runWorker(model, temperature, agentPrompt, tools, task, stallTimeout, options) {
    const PROMPT_ID = "orch-prompt";
    const STATE_ID = "orch-state";
    const TEXT_ID = "orch-text";

    return new Promise((resolve, reject) => {
        const rpcArgs = ["--mode", "rpc"];
        if (model) rpcArgs.push("--model", model);
        if (temperature != null) rpcArgs.push("--temperature", String(temperature));
        if (tools && tools.length > 0) rpcArgs.push("--tools", tools.join(","));
        rpcArgs.push("--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes");
        const invocation = getFnaInvocation(rpcArgs);
        const child = spawn(invocation.command, invocation.args, {
            cwd: options?.cwd ?? process.cwd(),
            shell: process.platform === "win32",
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stderrBuf = "";
        let stdoutBuf = "";
        let resolved = false;
        let wasStreaming = false;
        let messageCount = 0;
        let lastText = "";
        let detectedModel = model || "";
        let idlePolls = 0;
        let lastSeenMessageCount = 0;
        const MAX_IDLE_POLLS = 3;

        // Track tool calls extracted from worker events
        const toolCalls = [];
        const seenToolCallIds = new Set();

        const cleanup = () => {
            if (stallTimer) clearTimeout(stallTimer);
            try { child.stdin?.end(); } catch { /* ignore */ }
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
        };

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve(result);
        };

        const fail = (err) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            reject(err);
        };

        // Stall-based timeout: kill worker if no data received for N ms
        let stallTimer = null;

        const resetStallTimer = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                const totalSecs = Math.round(stallTimeout / 1000);
                const mins = Math.floor(totalSecs / 60);
                const secs = totalSecs % 60;
                const elapsedStr = mins >= 60
                    ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
                    : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
                fail(new Error(`Worker stalled: no activity for ${elapsedStr}`));
            }, stallTimeout);
        };

        resetStallTimer();

        // Abort signal (Esc key)
        const onAbort = () => fail(new Error("Aborted by user"));
        options?.signal?.addEventListener("abort", onAbort, { once: true });

        // Stderr
        child.stderr?.on("data", (chunk) => {
            stderrBuf += chunk.toString();
        });

        // Stdout — LF-only JSONL
        child.stdout?.on("data", (chunk) => {
            resetStallTimer();
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split("\n");
            stdoutBuf = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;
                try { handleMessage(JSON.parse(line)); } catch { /* ignore */ }
            }
        });

        function send(data) {
            if (!resolved) {
                try { child.stdin?.write(JSON.stringify(data) + "\n"); } catch { /* ignore */ }
            }
        }

        function schedulePoll() {
            if (resolved) return;
            setTimeout(() => {
                if (!resolved) send({ type: "get_state", id: STATE_ID });
            }, 2000);
        }

        function emitProgress(status) {
            if (options?.onProgress) {
                options.onProgress({
                    status,
                    messageCount,
                    toolCalls: [...toolCalls],
                    model: detectedModel,
                });
            }
        }

        function handleMessage(data) {
            if (data.type === "response" && data.id === PROMPT_ID) {
                if (!data.success) {
                    fail(new Error(`Worker prompt failed: ${data.error || data.message}`));
                    return;
                }
                emitProgress("Processing");
                setTimeout(() => schedulePoll(), 1000);
                return;
            }

            if (data.type === "response" && data.id === STATE_ID && data.success && data.data) {
                messageCount = data.data.messageCount ?? 0;
                if (data.data.model) detectedModel = data.data.model;
                if (data.data.isStreaming) {
                    wasStreaming = true;
                    idlePolls = 0;
                    lastSeenMessageCount = messageCount;
                    emitProgress("Thinking");
                    schedulePoll();
                } else if (wasStreaming) {
                    idlePolls = 0;
                    lastSeenMessageCount = messageCount;
                    emitProgress("Done");
                    send({ type: "get_last_assistant_text", id: TEXT_ID });
                    setTimeout(() => { if (!resolved) finish({ text: lastText, messageCount }); }, 15_000);
                } else {
                    // No streaming detected — use messageCount growth as activity signal
                    if (data.data.messageCount > lastSeenMessageCount) {
                        lastSeenMessageCount = data.data.messageCount;
                        idlePolls = 0;
                        schedulePoll();
                    } else {
                        idlePolls++;
                        if (idlePolls >= MAX_IDLE_POLLS) {
                            // No progress for MAX_IDLE_POLLS rounds — force finish
                            emitProgress("Done");
                            send({ type: "get_last_assistant_text", id: TEXT_ID });
                            setTimeout(() => { if (!resolved) finish({ text: lastText, messageCount }); }, 15_000);
                        } else {
                            schedulePoll();
                        }
                    }
                }
                return;
            }

            if (data.type === "response" && data.id === TEXT_ID && data.success) {
                lastText = data.data?.text ?? "";
                
                // If no text but tool calls were made (e.g. plan agent did research) —
                // give the model a moment to generate a final answer after tool execution.
                if (!lastText && toolCalls.length > 0 && !resolved) {
                    // Schedule one more poll cycle to catch the final response
                    setTimeout(() => {
                        if (resolved) return;
                        send({ type: "get_state", id: STATE_ID });
                        // After 8s, force finish with whatever we have
                        setTimeout(() => {
                            if (resolved) return;
                            if (lastText) {
                                finish({ text: lastText, messageCount });
                            } else if (toolCalls.length > 0) {
                                // Build summary from tool calls
                                const summary = toolCalls
                                    .filter(tc => tc.preview)
                                    .map(tc => `→ ${tc.preview}`)
                                    .join('\n');
                                const fallback = summary
                                    ? `Plan agent completed research but did not generate a summary. Tool calls:\n${summary}`
                                    : "(no output — tool calls were made but no summary generated)";
                                finish({ text: fallback, messageCount });
                            } else {
                                finish({ text: lastText, messageCount });
                            }
                        }, 8000);
                    }, 2000);
                    return;
                }
                
                emitProgress("Done");
                finish({ text: lastText, messageCount });
                return;
            }

            // Early detection of tool calls from streamed messages (args may be incomplete)
            if (data.type === "message_update" && data.message?.content) {
                for (const part of data.message.content) {
                    if (part.type === "toolCall" && !seenToolCallIds.has(part.id)) {
                        seenToolCallIds.add(part.id);
                        toolCalls.push({ name: part.name, preview: "" });
                    }
                }
            }

            // Fill in preview when tool actually starts executing (args are complete)
            if (data.type === "tool_execution_start") {
                const existing = toolCalls.find(tc => tc.name === data.toolName && tc.preview === "");
                if (existing) {
                    existing.preview = formatToolPreview(data.toolName, data.args);
                } else if (!seenToolCallIds.has(data.toolCallId)) {
                    seenToolCallIds.add(data.toolCallId);
                    toolCalls.push({
                        name: data.toolName,
                        preview: formatToolPreview(data.toolName, data.args),
                    });
                }
            }
        }

        child.on("error", (err) => fail(new Error(`Worker spawn error: ${err.message}`)));

        child.on("exit", (code) => {
            if (stallTimer) clearTimeout(stallTimer);
            options?.signal?.removeEventListener("abort", onAbort);
            if (resolved) return;
            if (code !== 0 && code !== null) {
                fail(new Error(`Worker exited with code ${code}\n${stderrBuf.slice(-500)}`));
            }
            setTimeout(() => { if (!resolved) finish({ text: lastText, messageCount }); }, 2000);
        });

        // Initial 500ms delay before sending prompt
        setTimeout(() => {
            send({
                type: "prompt",
                message: `${agentPrompt}\n\n## Task\n${task}`,
                id: PROMPT_ID,
            });
        }, 500);
    });
}

/**
 * Format tool calls list for display in worker body.
 */
function formatToolCallsBody(toolCalls, maxItems = 12) {
    if (!toolCalls || toolCalls.length === 0) return [];
    const withPreview = toolCalls.filter(tc => tc.preview);
    const toShow = withPreview.slice(-maxItems);
    const skipped = withPreview.length - toShow.length;
    const lines = [];
    if (skipped > 0) lines.push(`  ... ${skipped} earlier`);
    for (const tc of toShow) {
        lines.push(`  → ${tc.preview}`);
    }
    return lines;
}

/**
 * Build the status text shown as the worker content (header + body).
 * Mirrors pi-orchestrator's buildWorkerStatusText.
 */
/**
 * Build worker body content (status line + tool calls list).
 * Framework renders the header (agent name, task) separately.
 */
function buildWorkerContent(agentName, task, model, progress, startTime) {
    const statusText = progress?.status ?? "Spawning";
    const toolCallCount = progress?.toolCalls?.length ?? 0;
    const msgCount = progress?.messageCount ?? 0;
    const elapsed = Math.max(0, startTime ? Math.floor((Date.now() - startTime) / 1000) : 0);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const elapsedStr = mins >= 60
        ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
        : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const lines = [
        `${statusText} · ${toolCallCount} tools · ${msgCount} msgs · ${elapsedStr}`,
    ];
    const toolLines = formatToolCallsBody(progress?.toolCalls);
    if (toolLines.length > 0) {
        lines.push("", "Tools:");
        lines.push(...toolLines);
    }
    return lines.join("\n");
}
export async function runSingleAgent(defaultCwd, agents, agentName, task, temperature, cwd, step, signal, onUpdate, stallTimeout = 300_000) {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            step,
            startTime: Date.now(),
            endTime: Date.now(),
        };
    }

    const model = agent.model || "";
    const agentPrompt = agent.systemPrompt || "You are a helpful assistant.";
    const tools = agent.tools && agent.tools.length > 0 ? agent.tools : [];

    const startTime = Date.now();
    let lastText = "";
    let messageCount = 0;
    let detectedModel = model;
    const allToolCalls = [];
    let wasAborted = false;

    const progressOptions = {
        onProgress: (p) => {
            if (p.toolCalls) {
                allToolCalls.length = 0;
                allToolCalls.push(...p.toolCalls);
            }
            if (p.messageCount !== undefined) messageCount = p.messageCount;
            if (onUpdate) {
                const body = buildWorkerContent(agentName, task, detectedModel, p, startTime);
                onUpdate({
                    content: [{ type: "text", text: body }],
                    details: [{
                        agent: agentName,
                        agentSource: agent.source,
                        task,
                        step,
                        startTime,
                        progress: p,
                    }],
                });
            }
        },
        signal,
        cwd: cwd || defaultCwd,
    };

    // Hook signal to track wasAborted for the outer caller
    if (signal) {
        signal.addEventListener("abort", () => { wasAborted = true; }, { once: true });
    }

    try {
        const result = await runWorker(model, temperature, agentPrompt, tools, task, stallTimeout, progressOptions);
        lastText = result.text;
        messageCount = result.messageCount;
        const endTime = Date.now();
        // Send final update with the full result text (markdown)
        if (onUpdate) {
            const finalProgress = { status: "Done", messageCount, toolCalls: [...allToolCalls], model: detectedModel };
            onUpdate({
                content: [{ type: "text", text: lastText || "(no output)" }],
                details: [{
                    agent: agentName,
                    agentSource: agent.source,
                    task,
                    step,
                    startTime,
                    endTime,
                    progress: finalProgress,
                }],
            });
        }
        return {
            agent: agentName,
            agentSource: agent.source,
            task,
            exitCode: 0,
            messages: lastText
                ? [{ role: "assistant", content: [{ type: "text", text: lastText }] }]
                : [],
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: messageCount > 0 ? messageCount : 1 },
            model: detectedModel,
            text: lastText,
            step,
            startTime,
            endTime,
            progress: {
                status: "Done",
                messageCount,
                toolCalls: [...allToolCalls],
                model: detectedModel,
            },
        };
    } catch (err) {
        if (wasAborted) {
            throw new Error("Subagent was aborted");
        }
        const endTime = Date.now();
        return {
            agent: agentName,
            agentSource: agent.source,
            task,
            exitCode: 1,
            messages: lastText
                ? [{ role: "assistant", content: [{ type: "text", text: lastText }] }]
                : [],
            stderr: err.message,
            errorMessage: err.message,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            model: detectedModel,
            text: lastText,
            step,
            startTime,
            endTime,
            progress: {
                status: "Failed",
                messageCount,
                toolCalls: [...allToolCalls],
                model: detectedModel,
            },
        };
    }
}

/**
 * Run a single agent with retry logic.
 * Retries up to config.maxRetries times.
 * Does NOT retry on abort signals.
 */
export async function runSingleAgentWithRetry(defaultCwd, agents, agentName, task, config, cwd, step, signal, onUpdate, stallTimeout = 300_000) {
    let lastError;
    const maxAttempts = 1 + (config.maxRetries ?? 0);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await runSingleAgent(defaultCwd, agents, agentName, task, temperature, cwd, step, signal, onUpdate, stallTimeout);
            if (result.exitCode === 0) {
                return result;
            }
            // Check if it was aborted — don't retry
            if (signal?.aborted) {
                return result;
            }
            lastError = result;
            if (attempt < maxAttempts) {
                // Add retry info to the task for the next attempt
                task += `\n\n[Retry ${attempt}/${config.maxRetries} — previous attempt failed: ${result.errorMessage || result.stderr || "exit code " + result.exitCode}]`;
            }
        }
        catch (e) {
            // Don't retry on abort
            if (signal?.aborted) {
                throw e;
            }
            if (attempt < maxAttempts) {
                lastError = undefined; // Will retry
                task += `\n\n[Retry ${attempt}/${config.maxRetries} — previous attempt threw: ${e.message}]`;
            }
            else {
                // Final attempt failed
                return {
                    agent: agentName,
                    agentSource: "unknown",
                    task,
                    exitCode: 1,
                    messages: [],
                    stderr: e.message,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                    errorMessage: e.message,
                    step,
                    endTime: Date.now(),
                };
            }
        }
    }
    return (lastError ?? {
        agent: agentName,
        agentSource: "unknown",
        task,
        exitCode: 1,
        messages: [],
        stderr: "All retry attempts exhausted",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        errorMessage: "All retry attempts exhausted",
        step,
        endTime: Date.now(),
    });
}

/**
 * Run a single agent with cloud/local fallback.
 * - "cloud": try cloud, retry cloud
 * - "local": try local, retry local
 * - "auto": try cloud first, fallback to local on failure
 *
 * NO hard execution limit — only stallTimer protects against frozen workers.
 */
export async function runSingleAgentWithFallback(defaultCwd, agents, agentName, task, config, cwd, step, signal, onUpdate) {
    const mode = config.providerMode;
    const stallTimeout = (config.stallTimeout ?? 300) * 1000;

    try {
        return await runSingleAgentWithRetry(defaultCwd, agents, agentName, task, config, cwd, step, signal, onUpdate, stallTimeout);
    }
    catch (e) {
        // In auto mode, try fallback
        if (mode === "auto") {
            const fallbackConfig = { ...config, providerMode: "local" };
            const fallbackStallTimeout = (fallbackConfig.stallTimeout ?? 300) * 1000;
            return runSingleAgentWithRetry(defaultCwd, agents, agentName, task, fallbackConfig, cwd, step, signal, onUpdate, fallbackStallTimeout);
        }
        // Re-throw for cloud/local mode
        throw e;
    }
}
