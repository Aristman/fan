/**
 * FAN Orchestrator — Coordinator Tools
 *
 * LLM-callable tools for task delegation, tracking, and classification.
 * Uses the subagent runner to spawn fna subprocesses.
 */

import * as os from "node:os";
import { StringEnum } from "@itone/fan-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@itone/fan-coding-agent";
import { Container, Markdown, Spacer, Text } from "@itone/fan-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agents.js";
import {
	formatTokens,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	mapWithConcurrencyLimit,
	runSingleAgent,
} from "./subagent-runner.js";
import type { TaskManager } from "./task-manager.js";
import type { ExecutionMode, OrchestratorConfig, SingleResult, SubagentDetails, WorkerType } from "./types.js";
import { acquireSlot, releaseSlot } from "./workers.js";

const COLLAPSED_ITEM_COUNT = 10;
const MAX_LIVE_TOOLS = 9;

const AGENT_ICONS: Record<string, string> = {
	explore: "🔍",
	plan: "📋",
	implement: "🔧",
	verify: "🛡️",
};

function getAgentIcon(agentName: string): string {
	return AGENT_ICONS[agentName] ?? "🤖";
}

function toWorkerType(agentName: string): WorkerType {
	if (agentName === "explore" || agentName === "plan" || agentName === "verify") return agentName as WorkerType;
	return "implement";
}

function formatElapsedTime(startTime: number, endTime?: number): string {
	const ms = (endTime ?? Date.now()) - startTime;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function countToolCalls(messages: any[]): number {
	return getDisplayItems(messages).filter((item: any) => item.type === "toolCall").length;
}

function getLastToolCalls(messages: any[], limit: number): any[] {
	return getDisplayItems(messages).filter((item: any) => item.type === "toolCall").slice(-limit);
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function classifyTaskByDescription(description: string): {
	workerType: WorkerType;
	confidence: number;
	reasoning: string;
} {
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

type OnUpdateCallback = (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;

/**
 * Register all orchestrator tools with the extension API.
 */
export function registerOrchestratorTools(pi: ExtensionAPI, taskManager: TaskManager, config: OrchestratorConfig): void {
	// ---- delegate_task ----

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	});

	const ChainItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	});

	type AgentScope = "user" | "project" | "both";

	const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
		description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
		default: "user",
	});

	const DelegateParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Built-in agents: explore (fast recon), plan (implementation plans), implement (general-purpose), verify (code review).",
			'Default agent scope is "user". Set agentScope: "both" to include project-local agents from .fan/agents/.',
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
7. Keep task descriptions self-contained and specific`,
		parameters: DelegateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: ExecutionMode) =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
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
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is import("./types.js").AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// === Chain Mode ===
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = Array.isArray(partial.details)
									? partial.details[0]
									: partial.details?.results?.[0];
								if (currentResult) {
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")([...results, currentResult]),
									});
								}
							}
						: undefined;

					const workerType = toWorkerType(step.agent);
					await acquireSlot(workerType, config.parallelWorkers);
					let result: SingleResult;
					try {
						result = await runSingleAgent(ctx.cwd, agents, step.agent, taskWithContext, step.cwd, i + 1, signal, chainUpdate);
					} finally {
						releaseSlot(workerType, config.parallelWorkers);
					}
					results.push(result);

					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
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

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const workerType = toWorkerType(t.agent);
					await acquireSlot(workerType, config.parallelWorkers);
					let result: SingleResult;
					try {
						result = await runSingleAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, undefined, signal, (partial) => {
							const _cr = Array.isArray(partial.details) ? partial.details[0] : partial.details?.results?.[0];
							if (_cr) { allResults[index] = _cr; emitParallelUpdate(); }
						});
					} finally {
						releaseSlot(workerType, config.parallelWorkers);
					}

					allResults[index] = result;
					emitParallelUpdate();

					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// === Single Mode ===
			if (params.agent && params.task) {
				const singleUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
							const currentResult = Array.isArray(partial.details)
								? partial.details[0]
								: partial.details?.results?.[0];
							if (currentResult) {
								onUpdate({
									content: partial.content,
									details: makeDetails("single")([currentResult]),
								});
							}
					  }
					: undefined;

				const workerType = toWorkerType(params.agent);
				await acquireSlot(workerType, config.parallelWorkers);
				let result: SingleResult;
				try {
					result = await runSingleAgent(ctx.cwd, agents, params.agent, params.task, params.cwd, undefined, signal, singleUpdate);
				} finally {
					releaseSlot(workerType, config.parallelWorkers);
				}

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${getAgentIcon(step.agent)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 5) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 5} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("⚡ PARALLEL worker")) + theme.fg("muted", ` (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 5)) {
					const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}...` : t.task;
					text += `\n  ${getAgentIcon(t.agent)} ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 5) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 5} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentIcon = getAgentIcon(args.agent || "unknown");
			const agentLabel = (args.agent || "unknown").toUpperCase();
			let text = theme.fg("toolTitle", theme.bold(`${agentIcon} ${agentLabel} worker`));
			if (args.task) {
				const preview = args.task.length > 80 ? `${args.task.slice(0, 80)}...` : args.task;
				text += `\n  ${theme.fg("dim", `Task: ${preview}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const fmtTool = (name: string, args: Record<string, unknown>) =>
				formatToolCall(name, args, theme.fg.bind(theme));

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			const formatFooter = (r: SingleResult) => {
				const parts: string[] = [];
				const tc = countToolCalls(r.messages);
				parts.push(`${tc} tool${tc !== 1 ? "s" : ""}`);
				const msgCount = r.messages.filter((m: any) => m.role === "assistant" || m.role === "user").length;
				parts.push(`${msgCount} msg${msgCount !== 1 ? "s" : ""}`);
				if (r.startTime) parts.push(formatElapsedTime(r.startTime, r.endTime));
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) parts.push(usageStr);
				return parts.join(" · ");
			};

			const formatAggregateFooter = (results: SingleResult[]) => {
				const parts: string[] = [];
				const totalTools = results.reduce((s, r) => s + countToolCalls(r.messages), 0);
				parts.push(`${totalTools} tool${totalTools !== 1 ? "s" : ""}`);
				const starts = results.map((r) => r.startTime ?? Infinity);
				const ends = results.map((r) => r.endTime ?? 0);
				const firstStart = Math.min(...starts);
				const lastEnd = Math.max(...ends);
				if (firstStart < Infinity && lastEnd > 0) parts.push(formatElapsedTime(firstStart, lastEnd));
				const usageStr = formatUsageStats(aggregateUsage(results));
				if (usageStr) parts.push(usageStr);
				return parts.join(" · ");
			};

			// ─── SINGLE MODE ───────────────────────────────────────
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isRunning = !r.endTime;
				const isError = !isRunning && r.exitCode !== 0;
				const toolCount = countToolCalls(r.messages);
				const modelLabel = r.model || "initializing...";
				const headerLabel = `${getAgentIcon(r.agent)} ${r.agent.toUpperCase()} worker`;

				// ── Running (collapsed) ──
				if (isRunning) {
					const icon = theme.fg("warning", "⏳");
					const toolCount = countToolCalls(r.messages);
					const msgCount = r.messages.filter((m: any) => m.role === "assistant" || m.role === "user").length;
					const statusLine = `Processing · ${toolCount} tool${toolCount !== 1 ? "s" : ""} · ${msgCount} message${msgCount !== 1 ? "s" : ""}`;
					let text = `${icon} ${theme.fg("toolTitle", theme.bold(headerLabel))} ${theme.fg("muted", `(${modelLabel})`)}`;
					text += `\n${theme.fg("dim", statusLine)}`;
					const lastTools = getLastToolCalls(r.messages, MAX_LIVE_TOOLS);
					if (lastTools.length > 0) {
						for (const tc of lastTools) text += `\n${theme.fg("muted", "→ ")}${fmtTool(tc.name, tc.args)}`;
					} else {
						text += `\n${theme.fg("muted", "(thinking...)")}`;
					}
					return new Text(text, 0, 0);
				}

				// ── Completed ──
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const finalOutput = getFinalOutput(r.messages);
				const displayItems = getDisplayItems(r.messages);
				const allToolCalls = displayItems.filter((item: any) => item.type === "toolCall") as any[];

				if (expanded) {
					const container = new Container();
					let headerLine = `${icon} ${theme.fg("toolTitle", theme.bold(headerLabel))} ${theme.fg("muted", `(${modelLabel})`)}`;
					if (isError && r.stopReason) headerLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(headerLine, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					if (isError && r.stderr && !r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Stderr: ${r.stderr.slice(0, 500)}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", `─── Tools (${allToolCalls.length}) ───`), 0, 0));
					if (allToolCalls.length === 0) {
						container.addChild(new Text(theme.fg("muted", "(no tools)"), 0, 0));
					} else {
						for (const item of allToolCalls)
							container.addChild(new Text(theme.fg("muted", "→ ") + fmtTool(item.name, item.args), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (finalOutput) {
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", formatFooter(r)), 0, 0));
					return container;
				}

				// Collapsed completed
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(headerLabel))} ${theme.fg("muted", `(${modelLabel})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) {
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				} else if (isError && r.stderr) {
					text += `\n${theme.fg("error", `Stderr: ${r.stderr.slice(0, 500)}`)}`;
				} else if (finalOutput) {
					const lines = finalOutput.trim().split("\n");
					const preview = lines.slice(0, 10).join("\n");
					text += `\n${theme.fg("toolOutput", preview)}`;
					if (lines.length > 10)
						text += `\n${theme.fg("muted", `... ${lines.length - 10} more lines (Ctrl+O to expand)`)}`;
				} else {
					text += `\n${theme.fg("muted", "(no output)")}`;
				}
				text += `\n${theme.fg("dim", formatFooter(r))}`;
				return new Text(text, 0, 0);
			}

			// ─── CHAIN MODE ────────────────────────────────────────
			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const allDone = details.results.every((r) => !!r.endTime);
				const completedSteps = details.results.filter((r) => !!r.endTime).length;
				const icon = allDone
					? successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗")
					: theme.fg("warning", "⏳");
				const headerStatus = allDone
					? `${successCount}/${details.results.length} steps`
					: `${completedSteps}/${details.results.length} steps`;

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("CHAIN worker"))} ${theme.fg("accent", `(${headerStatus})`)}`,
							0,
							0,
						),
					);
					for (const r of details.results) {
						const rRunning = !r.endTime;
						const rIcon = rRunning
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
						const rDisplayItems = getDisplayItems(r.messages);
						const rOutput = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}:`)} ${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const item of rDisplayItems) {
							if (item.type === "toolCall")
								container.addChild(new Text(theme.fg("muted", "→ ") + fmtTool(item.name, item.args), 0, 0));
						}
						if (rOutput && !rRunning) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(rOutput.trim(), 0, 0, mdTheme));
						}
						if (!rRunning) {
							container.addChild(new Text(theme.fg("dim", formatFooter(r)), 0, 0));
						}
					}
					if (allDone) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", formatAggregateFooter(details.results)), 0, 0));
					}
					return container;
				}

				// Collapsed chain
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("CHAIN worker"))} ${theme.fg("accent", `(${headerStatus})`)}`;
				for (const r of details.results) {
					const rRunning = !r.endTime;
					const rIcon = rRunning
						? theme.fg("warning", "⏳")
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const rOutput = getFinalOutput(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}:`)} ${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)} ${rIcon}`;
					if (rRunning) {
						const lastTools = getLastToolCalls(r.messages, 5);
						if (lastTools.length > 0) {
							for (const tc of lastTools) text += `\n${theme.fg("muted", "→ ")}${fmtTool(tc.name, tc.args)}`;
						} else {
							text += `\n${theme.fg("muted", "(running...)")}`;
						}
					} else if (rOutput) {
						const lines = rOutput.trim().split("\n");
						const preview = lines.slice(0, 3).join("\n");
						text += `\n${theme.fg("toolOutput", preview)}`;
						if (lines.length > 3) text += `\n${theme.fg("muted", `... ${lines.length - 3} more lines`)}`;
					} else {
						text += `\n${theme.fg("muted", "(no output)")}`;
					}
					if (!rRunning) text += `\n${theme.fg("dim", formatFooter(r))}`;
				}
				if (allDone) text += `\n\n${theme.fg("dim", formatAggregateFooter(details.results))}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// ─── PARALLEL MODE ─────────────────────────────────────
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => !r.endTime).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
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
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("PARALLEL worker"))} ${theme.fg("accent", `(${status})`)}`,
							0,
							0,
						),
					);
					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const rDisplayItems = getDisplayItems(r.messages);
						const rOutput = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ")}${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const item of rDisplayItems) {
							if (item.type === "toolCall")
								container.addChild(new Text(theme.fg("muted", "→ ") + fmtTool(item.name, item.args), 0, 0));
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
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const rOutput = getFinalOutput(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${getAgentIcon(r.agent)} ${theme.fg("accent", r.agent)} ${rIcon}`;
					if (rRunning) {
						const lastTools = getLastToolCalls(r.messages, 5);
						if (lastTools.length > 0) {
							for (const tc of lastTools) text += `\n${theme.fg("muted", "→ ")}${fmtTool(tc.name, tc.args)}`;
						} else {
							text += `\n${theme.fg("muted", "(running...)")}`;
						}
					} else if (rOutput) {
						const lines = rOutput.trim().split("\n");
						const preview = lines.slice(0, 3).join("\n");
						text += `\n${theme.fg("toolOutput", preview)}`;
						if (lines.length > 3) text += `\n${theme.fg("muted", `... ${lines.length - 3} more lines`)}`;
					} else {
						text += `\n${theme.fg("muted", "(no output)")}`;
					}
					if (!rRunning) text += `\n${theme.fg("dim", formatFooter(r))}`;
				}
				if (!isRunning) text += `\n\n${theme.fg("dim", formatAggregateFooter(details.results))}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Fallback
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ---- list_tasks ----

	pi.registerTool({
		name: "list_tasks",
		label: "List Tasks",
		description: "List orchestrator tasks. Optionally filter by status.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.String({ description: "Filter by status: pending, in_progress, completed, failed, blocked" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const filter: any = {};
			if (params.status) filter.status = params.status;
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
				return `[${t.status}] ${t.id.slice(0, 8)} ${t.agentType}: ${t.description}${error}${result}`;
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

	pi.registerTool({
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
					content: [{ type: "text", text: `Task ${task.id.slice(0, 8)} cancelled.` }],
					details: undefined,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Failed to cancel task: ${e.message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ---- classify_task ----

	pi.registerTool({
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

	// ---- TaskCreate ----

	pi.registerTool({
		name: "TaskCreate",
		label: "Create Task",
		description: "Create a tracked task for decomposition. Tasks can block each other via blocks[].",
		parameters: Type.Object({
			subject: Type.String({ description: "Short description of the task" }),
			description: Type.Optional(Type.String({ description: "Detailed description of the task" })),
			owner: Type.Optional(Type.String({ description: "Worker ID that owns this task" })),
			blocks: Type.Optional(
				Type.Array(Type.String(), { description: "Task IDs this task blocks (creates dependency)" }),
			),
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
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Failed to create task: ${e.message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ---- TaskUpdate ----

	pi.registerTool({
		name: "TaskUpdate",
		label: "Update Task",
		description:
			"Update a task's status, subject, description, or blocks. Completing a task auto-unblocks dependents.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The ID of the task to update" }),
			status: Type.Optional(
				Type.String({ description: "New status: pending, in_progress, completed, blocked, failed" }),
			),
			subject: Type.Optional(Type.String({ description: "New subject/description" })),
			description: Type.Optional(Type.String({ description: "New detailed description" })),
			blocks: Type.Optional(Type.Array(Type.String(), { description: "New blocks array (replaces existing)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const updates: any = {};
				if (params.status) updates.status = params.status;
				if (params.subject) updates.subject = params.subject;
				if (params.description) updates.description = params.description;
				if (params.blocks !== undefined) updates.blocks = params.blocks;

				const task = taskManager.updateTask(params.taskId, updates);

				// Check if any dependents were unblocked
				const unblockedCount =
					task.status === "completed"
						? taskManager.getTasks().filter((t) => t.blockedBy?.includes(task.id) && t.status !== "blocked")
								.length
						: 0;

				return {
					content: [
						{
							type: "text",
							text: `Task updated: ${task.id.slice(0, 8)}\nStatus: ${task.status}${params.subject ? `\nSubject: ${params.subject}` : ""}${unblockedCount > 0 ? `\nDependents unblocked: ${unblockedCount}` : ""}`,
						},
					],
					details: undefined,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Failed to update task: ${e.message}` }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ---- TaskClear ----

	pi.registerTool({
		name: "TaskClear",
		label: "Clear Completed Tasks",
		description:
			"Remove all completed and failed tasks from the task list. Call this after your final report when all work is done.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const counts = taskManager.getStatusCounts();
			const removed = taskManager.clearCompleted();
			return {
				content: [
					{
						type: "text",
						text:
							removed > 0
								? `Cleared ${removed} task(s) from task list. Remaining: ${taskManager.size} tasks.`
								: "No completed or failed tasks to clear.",
					},
				],
				details: undefined,
			};
		},
	});

	// ---- stop_worker ----

	pi.registerTool({
		name: "stop_worker",
		label: "Stop Worker",
		description: "Stop a running or spawning worker by its ID.",
		parameters: Type.Object({
			workerId: Type.String({ description: "The worker ID to stop" }),
			reason: Type.Optional(Type.String({ description: "Reason for stopping" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { getWorker, updateWorker } = await import("./workers.js");
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
					content: [{ type: "text", text: `Worker ${worker.id.slice(0, 8)} is already ${worker.status}.` }],
				details: undefined,
				};
			}
			updateWorker(worker.id, { status: "aborted", endTime: Date.now(), error: params.reason ?? "Stopped by coordinator" });
			return {
				content: [{ type: "text", text: `Worker ${worker.id.slice(0, 8)} (${worker.agentType}) stopped.${params.reason ? ` Reason: ${params.reason}` : ""}` }],
				details: undefined,
			};
		},
	});
}
