/**
 * Subprocess Runner — Spawns fan subprocesses for subagent execution
 *
 * Ported from packages/coding-agent/examples/extensions/subagent/index.ts
 * with FAN-specific enhancements (ModelManager integration, budget awareness).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@itone/fan-ai";
import type { AgentConfig, OrchestratorConfig, SingleResult, UsageStats } from "./types.js";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fna-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * Resolve the fan binary invocation.
 * Tries current script path first, then falls back to "fan" command.
 */
let _cachedInvocation: { command: string; baseArgs: string[] } | null = null;

export function getFnaInvocation(args: string[]): { command: string; args: string[] } {
	if (!_cachedInvocation) {
		const currentScript = process.argv[1];
		if (currentScript && fs.existsSync(currentScript)) {
			_cachedInvocation = { command: process.execPath, baseArgs: [currentScript] };
		} else {
			const execName = path.basename(process.execPath).toLowerCase();
			const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
			if (!isGenericRuntime) {
				_cachedInvocation = { command: process.execPath, baseArgs: [] };
			} else {
				_cachedInvocation = { command: "fan", baseArgs: [] };
			}
		}
	}
	return { command: _cachedInvocation.command, args: [..._cachedInvocation.baseArgs, ...args] };
}

type OnUpdateCallback = (partial: { content: Array<{ type: "text"; text: string }>; details: any }) => void;

/**
 * Run a single agent as a subprocess.
 *
 * @param defaultCwd - Default working directory
 * @param agents - Available agent configurations
 * @param agentName - Name of the agent to run
 * @param task - Task description to send
 * @param cwd - Optional override working directory
 * @param step - Chain step number (if applicable)
 * @param signal - AbortSignal for cancellation
 * @param onUpdate - Callback for streaming updates
 * @returns SingleResult with messages, usage, and exit code
 */
export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
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

	const args: string[] = [
		"--mode", "json", "-p", "--no-session",
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
	];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		startTime: Date.now(),
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: [currentResult],
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getFnaInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}

				// Also capture tool results via message_end (toolResult role)
				if (event.type === "message_end" && event.message && event.message.role === "toolResult") {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.endTime = Date.now();
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/**
 * Run a single agent with retry logic.
 * Retries up to config.maxRetries times.
 * Does NOT retry on abort signals.
 */
export async function runSingleAgentWithRetry(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	config: OrchestratorConfig,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
	let lastError: SingleResult | undefined;
	const maxAttempts = 1 + (config.maxRetries ?? 0);

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = await runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate);

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
		} catch (e: any) {
			// Don't retry on abort
			if (signal?.aborted) {
				throw e;
			}

			if (attempt < maxAttempts) {
				lastError = undefined; // Will retry
				task += `\n\n[Retry ${attempt}/${config.maxRetries} — previous attempt threw: ${e.message}]`;
			} else {
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

	return (
		lastError ?? {
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
		}
	);
}

/**
 * Run a single agent with cloud/local fallback.
 * - "cloud": try cloud, retry cloud
 * - "local": try local, retry local
 * - "auto": try cloud first, fallback to local on failure
 */
export async function runSingleAgentWithFallback(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	config: OrchestratorConfig,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
	const mode = config.providerMode;
	const timeout =
		(config.agentTimeouts && config.agentTimeouts[agentName as keyof typeof config.agentTimeouts])
		?? config.workerTimeout
		?? 300_000;

	// Set up abort timeout
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const abortController = new AbortController();

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			abortController.abort();
			reject(new Error(`Worker timed out after ${timeout}ms`));
		}, timeout);
	});

	const cleanup = () => {
		if (timeoutId) clearTimeout(timeoutId);
		// If external signal aborts, clear our timeout
	};

	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				abortController.abort();
				cleanup();
			},
			{ once: true },
		);
	}

	try {
		const result = await Promise.race([
			runSingleAgentWithRetry(
				defaultCwd,
				agents,
				agentName,
				task,
				config,
				cwd,
				step,
				abortController.signal,
				onUpdate,
			),
			timeoutPromise,
		]);
		cleanup();
		return result;
	} catch (e: any) {
		cleanup();

		// In auto mode, try fallback
		if (mode === "auto") {
			const fallbackConfig = { ...config, providerMode: "local" as const };
			return runSingleAgentWithRetry(
				defaultCwd,
				agents,
				agentName,
				task,
				fallbackConfig,
				cwd,
				step,
				signal,
				onUpdate,
			);
		}

		// Re-throw for cloud/local mode
		throw e;
	}
}
