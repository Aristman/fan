/**
 * FAN Orchestrator v2 — RPC Worker Spawning
 *
 * Spawns fan child processes in RPC mode (--mode rpc) via JSONL protocol.
 * Provides runWorker (single), runWorkerWithRetry (retry logic),
 * and runWorkerWithFallback (cloud→local fallback).
 */

import { spawn } from "node:child_process";
import type { AgentType, OrchestratorConfig, WorkerResult, WorkerProgress, ToolCallInfo } from "./types.js";
import { resolveModel, getCloudStatus } from "./config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get the correct fan binary name for the current platform */
function getFanCommand(): string {
  return process.platform === "win32" ? "fan.cmd" : "fan";
}

/** Shorten home dir to ~ */
function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Truncate string to maxLen with ellipsis */
function trunc(s: string, maxLen: number = 120): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

/** Get first non-empty line of a string */
function firstLine(s: string | undefined): string {
  return (s || "").split("\n").map(l => l.trim()).filter(Boolean)[0] || "";
}

/** Normalize args — handle both object and JSON string */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

/** Extract a descriptive preview from tool call arguments */
function formatToolPreview(toolName: string, rawArgs: unknown): string {
  const args = normalizeArgs(rawArgs);
  switch (toolName) {
    case "bash": {
      const cmd = (args.command as string) || "...";
      return trunc(cmd);
    }
    case "read": {
      const p = shortenPath((args.file_path || args.path || "...") as string);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let s = `read ${p}`;
      if (offset !== undefined || limit !== undefined) {
        const from = offset ?? 1;
        const to = limit ? from + limit - 1 : "";
        s += ` :${from}-${to}`;
      }
      return trunc(s);
    }
    case "write": {
      const p = shortenPath((args.file_path || args.path || "...") as string);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      const bytes = new TextEncoder().encode(content).length;
      const sizeStr = bytes > 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
      return trunc(`write ${p} (${lines} lines, ${sizeStr})`);
    }
    case "edit": {
      const p = shortenPath((args.file_path || args.path || "...") as string);
      const oldText = firstLine(args.oldText as string | undefined);
      const newText = firstLine(args.newText as string | undefined);
      let s = `edit ${p}`;
      if (oldText) s += `  <- "${oldText.slice(0, 40)}"`;
      if (newText) s += `  -> "${newText.slice(0, 40)}"`;
      return trunc(s);
    }
    case "bash_command": {
      // FAN uses bash_command as tool name
      const cmd = (args.command as string) || "...";
      return trunc(cmd);
    }
    case "grep": {
      const pat = (args.pattern || "") as string;
      const p = shortenPath((args.path || ".") as string);
      const include = (args.include || "") as string;
      let s = `grep /${pat}/ in ${p}`;
      if (include) s += ` include:${include}`;
      return trunc(s);
    }
    case "find": {
      const pat = (args.pattern || "*") as string;
      const p = shortenPath((args.path || ".") as string);
      return trunc(`find ${pat} in ${p}`);
    }
    default: {
      const s = JSON.stringify(args);
      return trunc(s);
    }
  }
}

export type ProgressCallback = (progress: WorkerProgress) => void;

// ── Core worker spawn ──────────────────────────────────────────────────────

/**
 * Spawn a fan worker in RPC mode. Returns a promise that resolves when done.
 */
export function runWorker(
  model: string,
  agentPrompt: string,
  tools: string[],
  task: string,
  stallTimeout: number,
  options?: { onProgress?: ProgressCallback; signal?: AbortSignal; cwd?: string },
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      getFanCommand(),
      [
        "--mode", "rpc",
        "--model", model,
        "--system-prompt",
        "You are a helpful coding assistant that follows instructions precisely.",
        "--tools", tools.join(","),
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: process.env,
        cwd: options?.cwd ?? process.cwd(),
      },
    );

    let stderrBuf = "";
    let stdoutBuf = "";
    let resolved = false;
    let wasStreaming = false;
    let messageCount = 0;
    let lastText = "";

    const toolCalls: ToolCallInfo[] = [];
    const seenToolCallIds = new Set<string>();

    const cleanup = () => {
      if (stallTimer) clearTimeout(stallTimer);
      try { child.stdin?.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
    };

    const finish = (result: WorkerResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };

    // Stall-based timeout
    let stallTimer: ReturnType<typeof setTimeout> | null = null;

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
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    // Stdout — LF-only JSONL
    child.stdout?.on("data", (chunk: Buffer) => {
      resetStallTimer();
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleMessage(JSON.parse(line)); } catch {}
      }
    });

    const PROMPT_ID = "orch-prompt";
    const STATE_ID = "orch-state";
    const TEXT_ID = "orch-text";

    function send(data: Record<string, unknown>) {
      if (!resolved) {
        try { child.stdin?.write(JSON.stringify(data) + "\n"); } catch {}
      }
    }

    function schedulePoll() {
      if (resolved) return;
      setTimeout(() => {
        if (!resolved) send({ type: "get_state", id: STATE_ID });
      }, 2000);
    }

    function handleMessage(data: any) {
      if (data.type === "response" && data.id === PROMPT_ID) {
        if (!data.success) { fail(new Error(`Worker prompt failed: ${data.error}`)); return; }
        options?.onProgress?.({ status: "Processing", messageCount, toolCalls, model });
        setTimeout(() => schedulePoll(), 1000);
        return;
      }

      if (data.type === "response" && data.id === STATE_ID && data.success && data.data) {
        messageCount = data.data.messageCount ?? 0;
        if (data.data.isStreaming) {
          wasStreaming = true;
          options?.onProgress?.({ status: "Thinking", messageCount, toolCalls, model });
          schedulePoll();
        } else if (wasStreaming) {
          options?.onProgress?.({ status: "Done", messageCount, toolCalls, model });
          send({ type: "get_last_assistant_text", id: TEXT_ID });
          setTimeout(() => { if (!resolved) finish({ text: lastText, messageCount }); }, 15_000);
        } else {
          schedulePoll();
        }
        return;
      }

      if (data.type === "response" && data.id === TEXT_ID && data.success) {
        lastText = data.data?.text ?? "";
        options?.onProgress?.({ status: "Done", messageCount, toolCalls, model });
        finish({ text: lastText, messageCount });
        return;
      }

      // Early detection of tool calls from streamed messages
      if (data.type === "message_update" && data.message?.content) {
        for (const part of data.message.content) {
          if (part.type === "toolCall" && !seenToolCallIds.has(part.id)) {
            seenToolCallIds.add(part.id);
            toolCalls.push({ name: part.name, preview: "" });
          }
        }
      }

      // Fill in preview when tool actually starts executing
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

    setTimeout(() => {
      send({ type: "prompt", message: `${agentPrompt}\n\n## Task\n${task}`, id: PROMPT_ID });
    }, 500);
  });
}

// ── Retry logic ────────────────────────────────────────────────────────────

/**
 * Run a worker with retry logic. Retries up to `config.maxRetries` times.
 * User-initiated aborts (via AbortSignal) are NOT retried.
 */
export async function runWorkerWithRetry(
  model: string,
  agentType: AgentType,
  agentPrompt: string,
  tools: string[],
  task: string,
  config: OrchestratorConfig,
  options?: { onProgress?: ProgressCallback; signal?: AbortSignal; cwd?: string },
  stallTimeout?: number,
): Promise<WorkerResult> {
  const maxRetries = config.maxRetries;
  const effectiveTimeout = stallTimeout ?? config.stallTimeout;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      options?.onProgress?.({ status: `Retry ${attempt}/${maxRetries}`, messageCount: 0, toolCalls: [] });
    }
    try {
      return await runWorker(model, agentPrompt, tools, task, effectiveTimeout, options);
    } catch (err: any) {
      lastError = err;
      if (options?.signal?.aborted) throw err;
    }
  }
  throw lastError ?? new Error(`Worker failed after ${maxRetries + 1} attempts`);
}

// ── Provider fallback ──────────────────────────────────────────────────────

/**
 * Run worker with cloud → local fallback when providerMode is "auto".
 */
export async function runWorkerWithFallback(
  agentType: AgentType,
  agentPrompt: string,
  tools: string[],
  task: string,
  config: OrchestratorConfig,
  options?: { onProgress?: ProgressCallback; signal?: AbortSignal; cwd?: string },
  stallTimeout?: number,
): Promise<WorkerResult> {
  const cloudModel = resolveModel(agentType, config, "cloud");
  const localModel = resolveModel(agentType, config, "local");

  if (config.providerMode === "cloud") {
    return runWorkerWithRetry(cloudModel, agentType, agentPrompt, tools, task, config, options, stallTimeout);
  }

  if (config.providerMode === "local") {
    return runWorkerWithRetry(localModel, agentType, agentPrompt, tools, task, config, options, stallTimeout);
  }

  // auto — check cloud health, try cloud, fallback to local
  const cloudStatus = await getCloudStatus();
  if (cloudStatus === "available") {
    try {
      return await runWorkerWithRetry(cloudModel, agentType, agentPrompt, tools, task, config, options, stallTimeout);
    } catch {
      // Fall through to local
    }
  }

  return runWorkerWithRetry(localModel, agentType, agentPrompt, tools, task, config, options, stallTimeout);
}
