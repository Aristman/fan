/**
 * fan-lavish — CLI auto-detect and subprocess utilities for lavish-axi
 *
 * Provides:
 *   - detectCli(): auto-detects lavish-axi binary (PATH → global npm → npx fallback)
 *   - executeLavish(): spawn with AbortSignal + timeout
 *   - executeLavishPoll(): spawn without timeout, forwards heartbeat via stderr
 *   - loadConfig(): returns config with defaults
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CliInfo {
  bin: string;
  args: string[];
  source: "local" | "path" | "global" | "npx";
}

export interface LavishConfig {
  port: number;
  noOpen: boolean;
}

// ── Module State ─────────────────────────────────────────────────────────────

let cachedCli: CliInfo | undefined;

// ── CLI Detection ────────────────────────────────────────────────────────────

export function detectCli(): CliInfo {
  if (cachedCli) return cachedCli;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";
  const extDir = __dirname;

  // Helper: resolve a command via where/which, return full path or null
  const resolveCmd = (cmd: string): string | null => {
    try {
      const r = spawnSync(whichCmd, [cmd], {
        encoding: "utf-8",
        timeout: 3000,
        shell: isWin,
      });
      if (r.status === 0 && r.stdout.trim()) {
        return r.stdout.trim().split(/\r?\n/)[0].trim();
      }
    } catch { /* ignore */ }
    return null;
  };

  // ── Step 0: Local node_modules (installed by FAN Store bun install) ──

  // 0a: Check .bin/ entries
  const binDir = join(extDir, "node_modules", ".bin");
  const binCandidates = isWin
    ? ["lavish-axi.cmd", "lavish-axi.exe", "lavish-axi.ps1", "lavish-axi"]
    : ["lavish-axi"];

  for (const name of binCandidates) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      cachedCli = { bin: candidate, args: [], source: "local" };
      return cachedCli;
    }
  }

  // 0b: Direct entry — node_modules/lavish-axi/dist/cli.mjs
  //     Try process.execPath first (works when FAN runs as bun binary),
  //     then where node, where bun
  const directEntry = join(extDir, "node_modules", "lavish-axi", "dist", "cli.mjs");
  if (existsSync(directEntry)) {
    // Try process.execPath (the runtime that loaded this extension)
    const execPath = process.execPath;
    if (execPath && existsSync(execPath)) {
      cachedCli = { bin: execPath, args: [directEntry], source: "local" };
      return cachedCli;
    }
    // Fallback: find node or bun in PATH
    for (const runtime of ["node", "bun"]) {
      const resolved = resolveCmd(runtime);
      if (resolved) {
        cachedCli = { bin: resolved, args: [directEntry], source: "local" };
        return cachedCli;
      }
    }
  }

  // ── Step 1: PATH ──
  const pathResolved = resolveCmd("lavish-axi");
  if (pathResolved) {
    cachedCli = { bin: pathResolved, args: [], source: "path" };
    return cachedCli;
  }

  // ── Step 2: Global npm ──
  try {
    const npmRootResult = spawnSync("npm", ["root", "-g"], {
      encoding: "utf-8",
      timeout: 3000,
      shell: isWin,
    });
    if (npmRootResult.status === 0 && npmRootResult.stdout.trim()) {
      const globalDir = npmRootResult.stdout.trim();
      if (existsSync(join(globalDir, "lavish-axi"))) {
        const resolved = resolveCmd("lavish-axi");
        if (resolved) {
          cachedCli = { bin: resolved, args: [], source: "global" };
          return cachedCli;
        }
      }
    }
  } catch { /* ignore */ }

  // ── Step 3: npx fallback ──
  const npxResolved = resolveCmd("npx");
  if (npxResolved) {
    cachedCli = { bin: npxResolved, args: ["-y", "lavish-axi"], source: "npx" };
    return cachedCli;
  }

  // ── Nothing found — diagnostic error ──
  const diag: string[] = [];
  diag.push(`extDir: ${extDir}`);
  diag.push(`binDir exists: ${existsSync(binDir)}`);
  if (existsSync(binDir)) {
    try {
      const files = require("fs").readdirSync(binDir);
      diag.push(`binDir contents: ${files.join(", ")}`);
    } catch { /* ignore */ }
  }
  diag.push(`directEntry exists: ${existsSync(directEntry)}`);
  diag.push(`process.execPath: ${process.execPath}`);
  diag.push(`PATH: ${(process.env.PATH || "").split(isWin ? ";" : ":").slice(0, 5).join(isWin ? ";" : ":")}...`);

  throw new Error(
    `lavish-axi not found. Install it with: npm install -g lavish-axi\n\n` +
    `Diagnostic:\n${diag.map(d => `  ${d}`).join("\n")}`,
  );
}

// ── Config ───────────────────────────────────────────────────────────────────

export function loadConfig(): LavishConfig {
  const defaults: LavishConfig = { port: 4387, noOpen: false };
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = join(__dirname, "config.json");
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      port: typeof parsed.port === "number" ? parsed.port : defaults.port,
      noOpen: typeof parsed.noOpen === "boolean" ? parsed.noOpen : defaults.noOpen,
    };
  } catch {
    return defaults;
  }
}

// ── Process Tree Kill Helper ─────────────────────────────────────────────────

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5000,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Process may have already exited
  }
}

// ── Subprocess Execution ─────────────────────────────────────────────────────

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function executeLavish(
  subArgs: string[],
  signal?: AbortSignal,
  timeoutMs: number = 30_000,
): Promise<ExecuteResult> {
  const cli = detectCli();
  const config = loadConfig();
  const fullArgs = [...cli.args, ...subArgs];

  return new Promise<ExecuteResult>((resolve, reject) => {
    const child = spawn(cli.bin, fullArgs, {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        LAVISH_AXI_PORT: String(config.port),
        ...(config.noOpen ? { LAVISH_AXI_NO_OPEN: "1" } : {}),
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Kill helper: SIGTERM → 5s grace → SIGKILL/taskkill
    const killProc = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          killProcessTree(child.pid);
        }
      }, 5000);
    };

    // AbortSignal handling
    if (signal) {
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }

    // Timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killProc();
        reject(new Error(`lavish-axi timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Polling Execution (no timeout, heartbeat forwarding) ─────────────────────

export function executeLavishPoll(
  subArgs: string[],
  signal?: AbortSignal,
  onUpdate?: (update: string) => void,
): Promise<ExecuteResult> {
  const cli = detectCli();
  const config = loadConfig();
  const fullArgs = [...cli.args, ...subArgs];

  return new Promise<ExecuteResult>((resolve, reject) => {
    const child = spawn(cli.bin, fullArgs, {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        LAVISH_AXI_PORT: String(config.port),
        ...(config.noOpen ? { LAVISH_AXI_NO_OPEN: "1" } : {}),
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const trimmed = text.trim();
      if (trimmed) {
        onUpdate?.("[heartbeat] " + trimmed);
      }
    });

    // Kill helper: SIGTERM → 5s grace → SIGKILL/taskkill
    const killProc = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          killProcessTree(child.pid);
        }
      }, 5000);
    };

    // AbortSignal handling
    if (signal) {
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// ── Extension Entry Point ────────────────────────────────────────────────────

export default function fanLavish(fan: ExtensionAPI) {
  // --- Lifecycle: Session Start (ambient context) ---
  fan.on("session_start", async (_event, ctx) => {
    try {
      const result = await executeLavish([], ctx.signal, 5_000);
      if (result.code === 0 && result.stdout.trim()) {
        const output = result.stdout.trim();
        // Inject ambient context only if there are open sessions
        if (output.includes("sessions[") && !output.includes("sessions[0]")) {
          ctx.ui.notify(
            `Lavish Editor — Ambient Context\n\n${output}`,
            "info",
          );
        }
      }
    } catch {
      // CLI not found or timeout — silent, skill will handle guidance
    }
  });

  fan.registerTool({
    name: "lavish",
    label: "Lavish Editor",
    description:
      "Open HTML artifacts in Lavish Editor for visual review with human feedback loop",
    promptSnippet:
      "lavish: Open HTML artifacts in Lavish Editor for visual review with human feedback loop. Commands: open, poll, end, playbook, design, export, info. Use playbook before writing HTML. Always poll after open.",
    promptGuidelines: [
      "MUST run lavish({ command: 'playbook', playbook_id: '<id>' }) for each matching playbook BEFORE writing HTML",
      "MUST call lavish({ command: 'poll', file: '<path>' }) after every open to receive user feedback",
      "Fix layout_warnings (proven severe failures) before asking user to review",
      "On poll status 'ended' → stop polling, deliver final updates in chat",
      "HTML artifacts must use relative paths for local assets",
      "Mermaid diagrams in .mermaid containers become editable Excalidraw whiteboards",
    ],
    parameters: Type.Object({
      command: Type.Union(
        [
          Type.Literal("open"),
          Type.Literal("poll"),
          Type.Literal("end"),
          Type.Literal("playbook"),
          Type.Literal("design"),
          Type.Literal("export"),
          Type.Literal("info"),
        ],
        { description: "Subcommand to execute" },
      ),
      file: Type.Optional(
        Type.String({
          description:
            "Path to HTML artifact file (required for open, poll, end, export)",
        }),
      ),
      playbook_id: Type.Optional(
        Type.String({
          description:
            "Playbook ID: diagram, plan, comparison, table, code, input, slides (for playbook command)",
        }),
      ),
      agent_reply: Type.Optional(
        Type.String({
          description:
            "Agent's reply to show in browser chat (poll only)",
        }),
      ),
      reopen: Type.Optional(
        Type.Boolean({
          description: "Reopen a user-ended session (open only)",
          default: false,
        }),
      ),
      no_gate: Type.Optional(
        Type.Boolean({
          description: "Skip open-time layout curtain (open only)",
          default: false,
        }),
      ),
      out: Type.Optional(
        Type.String({ description: "Output path for export" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      // Pre-flight: ensure CLI is available
      try {
        detectCli();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Lavish unavailable: ${(err as Error).message}` }],
          details: undefined,
        };
      }

      const args: string[] = [];

      switch (params.command) {
        case "open": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'open' command" }], details: undefined };
          }
          args.push(params.file);
          if (params.reopen) args.push("--reopen");
          if (params.no_gate) args.push("--no-gate");
          break;
        }

        case "poll": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'poll' command" }], details: undefined };
          }
          args.push("poll", params.file);
          if (params.agent_reply) args.push("--agent-reply", params.agent_reply);
          // Long-poll: no timeout, blocking
          const pollResult = await executeLavishPoll(args, signal, (heartbeat) => {
            onUpdate?.({ content: [{ type: "text", text: heartbeat }], details: undefined });
          });
          if (pollResult.code !== 0) {
            return { content: [{ type: "text", text: `lavish-axi poll error (exit ${pollResult.code}): ${pollResult.stderr || pollResult.stdout}` }], details: undefined };
          }
          return { content: [{ type: "text", text: pollResult.stdout }], details: undefined };
        }

        case "end": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'end' command" }], details: undefined };
          }
          args.push("end", params.file);
          break;
        }

        case "playbook": {
          args.push("playbook");
          if (params.playbook_id) args.push(params.playbook_id);
          break;
        }

        case "design": {
          args.push("design");
          break;
        }

        case "export": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'export' command" }], details: undefined };
          }
          args.push("export", params.file);
          if (params.out) args.push("--out", params.out);
          break;
        }

        case "info": {
          break;
        }

        default: {
          return { content: [{ type: "text", text: `Unknown command: ${params.command}. Available: open, poll, end, playbook, design, export, info` }], details: undefined };
        }
      }

      const result = await executeLavish(args, signal, 15_000);
      if (result.code !== 0) {
        return { content: [{ type: "text", text: `lavish-axi error (exit ${result.code}): ${result.stderr || result.stdout}` }], details: undefined };
      }
      return { content: [{ type: "text", text: result.stdout }], details: undefined };
    },
  });

  // Session shutdown — graceful stop of lavish-axi background server
  fan.on("session_shutdown", async () => {
    try {
      await executeLavish(["stop"], undefined, 5_000);
    } catch {
      // Silent — best-effort cleanup, server may not be running
    }
  });
}
