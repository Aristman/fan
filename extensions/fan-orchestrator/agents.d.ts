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
/**
 * Verdict parsed from worker output: 3 verify verdicts + 3 code-review verdicts.
 */
export type Verdict = "PASS" | "FAIL" | "PARTIAL" | "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_DISCUSSION";
/**
 * All 6 valid verdict values in canonical order (verify group first, then
 * code-review group) — single source of truth mirrored from agents.js: builds
 * the parseVerdict regex and drives isCodeReviewVerdict().
 */
export declare const VERDICT_VALUES: readonly Verdict[];
/**
 * Parse a «VERDICT: <value>» line from worker output (case-insensitive).
 * Accepts null/undefined/empty — returns null instead of throwing.
 */
export declare function parseVerdict(text: string | null | undefined): Verdict | null;
/**
 * Whether a verdict belongs to the code-review set (APPROVED |
 * CHANGES_REQUESTED | NEEDS_DISCUSSION) as opposed to the verify set
 * (PASS | FAIL | PARTIAL).
 */
export declare function isCodeReviewVerdict(verdict: string | null | undefined): boolean;
/**
 * Map code-review findings (F-9 format, severity ∈ CRITICAL|MAJOR|MINOR|INFO)
 * to a review verdict: CRITICAL/MAJOR → CHANGES_REQUESTED, only MINOR/INFO →
 * APPROVED, «unclear» marker or empty/ambiguous input → NEEDS_DISCUSSION.
 */
export declare function severityToVerdict(findings: readonly { severity: "CRITICAL" | "MAJOR" | "MINOR" | "INFO"; metadata?: { unclear?: boolean } }[]): Verdict;
//# sourceMappingURL=agents.d.ts.map
