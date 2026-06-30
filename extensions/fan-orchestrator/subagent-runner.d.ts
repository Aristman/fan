/**
 * Subprocess Runner — Spawns fan subprocesses for subagent execution
 *
 * Ported from packages/coding-agent/examples/extensions/subagent/index.ts
 * with FAN-specific enhancements (ModelManager integration, budget awareness).
 */
import type { Message } from "@seaagents/fan-ai";
import type { AgentConfig, OrchestratorConfig, SingleResult } from "./types.js";
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
 * @param cwd - Optional override working directory
 * @param step - Chain step number (if applicable)
 * @param signal - AbortSignal for cancellation
 * @param onUpdate - Callback for streaming updates
 * @returns SingleResult with messages, usage, and exit code
 */
export declare function runSingleAgent(defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, cwd: string | undefined, step: number | undefined, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined): Promise<SingleResult>;
/**
 * Run a single agent with retry logic.
 * Retries up to config.maxRetries times.
 * Does NOT retry on abort signals.
 */
export declare function runSingleAgentWithRetry(defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, config: OrchestratorConfig, cwd: string | undefined, step: number | undefined, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined): Promise<SingleResult>;
/**
 * Run a single agent with cloud/local fallback.
 * - "cloud": try cloud, retry cloud
 * - "local": try local, retry local
 * - "auto": try cloud first, fallback to local on failure
 */
export declare function runSingleAgentWithFallback(defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, config: OrchestratorConfig, cwd: string | undefined, step: number | undefined, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined): Promise<SingleResult>;
export {};
//# sourceMappingURL=subagent-runner.d.ts.map