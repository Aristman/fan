/**
 * Agent discovery and configuration for FAN orchestrator
 *
 * Discovers agent definitions from:
 *   1. Built-in agents (packages/orchestrator/src/agents/*.md)
 *   2. User agents (~/.fan/agent/agents/*.md)
 *   3. Project agents (.fan/agents/*.md, walked up to git root)
 *
 * Priority (highest wins): project > user > builtin
 */
export type AgentScope = "user" | "project" | "both";
export type { AgentConfig, AgentDiscoveryResult } from "./types.js";
/**
 * Discover agents from all sources.
 *
 * @param cwd - Current working directory (for project agent lookup)
 * @param scope - Which directories to search
 * @returns Discovered agents and project agents directory path
 */
export declare function discoverAgents(cwd: string, scope: AgentScope): import("./types.js").AgentDiscoveryResult;
/**
 * Format agent list for display.
 */
export declare function formatAgentList(agents: import("./types.js").AgentConfig[], maxItems: number): {
    text: string;
    remaining: number;
};
export declare const COORDINATOR_PROMPT: string;
export declare const PLANNING_PROMPT: string;
export declare function formatTaskNotification(workerId: string, agentType: string, model: string | undefined, status: string, result: string | undefined, startTime: number): string;
export declare function parseVerdict(text: string): "PASS" | "FAIL" | "PARTIAL" | null;
//# sourceMappingURL=agents.d.ts.map