/**
 * Subprocess Runner — Spawns fan subprocesses for subagent execution
 *
 * Ported from packages/coding-agent/examples/extensions/subagent/index.ts
 * with FAN-specific enhancements (ModelManager integration, budget awareness).
 */
import type { Message } from "@seaagents/fan-ai";
import type { AgentConfig, SingleResult, WorkerContext } from "./types.js";
export declare const MAX_PARALLEL_TASKS = 8;
export declare const MAX_CONCURRENCY = 4;
export declare function getFinalOutput(messages: Message[]): string;
export type DisplayItem = {
    type: "text";
    text: string;
} | {
    type: "toolCall";
    name: string;
    args: Record<string, any>;
};
export declare function getDisplayItems(messages: Message[]): DisplayItem[];
export declare function formatTokens(count: number): string;
export declare function formatUsageStats(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
}, model?: string): string;
export declare function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]>;
export declare function getFnaInvocation(args: string[]): {
    command: string;
    args: string[];
};
type OnUpdateCallback = (partial: {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: any;
}) => void;
/**
 * Run a single agent as a subprocess.
 *
 * @param defaultCwd - Default working directory
 * @param agents - Available agent configurations
 * @param agentName - Name of the agent to run
 * @param task - Task description to send
 * @param temperature - Optional temperature override for the worker
 * @param cwd - Optional override working directory
 * @param step - Chain step number (if applicable)
 * @param signal - AbortSignal for cancellation
 * @param onUpdate - Callback for streaming updates
 * @param stallTimeout - Kill worker after this much inactivity (ms)
 * @param context - Optional worker context (forward-compatible contract with
 *                  super-orchestrator v3 work_package.context). Injected between
 *                  the agent system prompt and the "## Task" section. When omitted,
 *                  the worker prompt is bit-for-bit identical to the legacy format.
 * @returns SingleResult with messages, usage, and exit code
 */
export declare function runSingleAgent(defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, temperature: number | null, cwd: string | undefined, step: number | undefined, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined, stallTimeout?: number, context?: WorkerContext): Promise<SingleResult>;
export {};
//# sourceMappingURL=subagent-runner.d.ts.map