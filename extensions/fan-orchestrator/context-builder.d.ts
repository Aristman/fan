/**
 * Context Builder — collects, merges, and formats worker context.
 *
 * The WorkerContext shape is a forward-compatible contract with
 * super-orchestrator v3 work_package.context (spec_super-orchestrator_v3_2026-08-10.md §3.3.2):
 * parentSummary / relevantFiles / constraints. FAN-specific extensions
 * (previousFindings, gitState, projectTree) are an optional superset.
 */
import type { WorkerContext } from "./types.js";

/** Total context limit in characters (~5650 tokens). */
export declare const TOTAL_CONTEXT_LIMIT: number;

/** Per-section limits in characters. */
export declare const SECTION_LIMITS: {
  parentSummary: number;
  relevantFiles: number;
  previousFindings: number;
  constraints: number;
  gitState: number;
  projectTree: number;
};

/** Max length for auto-injected previous step output in chain mode. */
export declare const PREVIOUS_OUTPUT_LIMIT: number;

/**
 * Truncate a string to maxLen characters. If truncated, appends a marker
 * `... (truncated, N chars omitted)` describing how much was cut.
 */
export declare function truncate(str: string | undefined | null, maxLen: number): string;

/**
 * Format a WorkerContext into a `## Project Context` markdown block.
 * Only non-empty sections are included. Returns "" for an empty/undefined
 * context so callers can keep the legacy prompt format bit-for-bit.
 */
export declare function formatContextBlock(context: WorkerContext | undefined): string;

/**
 * Filter tree output lines, dropping any path that contains an excluded segment.
 */
export declare function filterTreeLines(raw: string): string;

/**
 * Auto-collect project context: git status + last 5 commits and a 2-level
 * directory tree (excluding node_modules, dist, .git, .fan).
 * Never throws — failures produce placeholder strings (5000ms command timeout).
 * Results are cached in-memory for 30 seconds (keyed by cwd + flags).
 */
export declare function collectProjectContext(
  cwd: string,
  options?: { includeGitState?: boolean; includeProjectTree?: boolean }
): WorkerContext;

/** Clear the collectProjectContext in-memory cache. */
export declare function clearContextCache(): void;

/**
 * Merge coordinator-provided (explicit) context with auto-collected context.
 * Explicit fields always win; auto-collected gitState/projectTree never
 * overwrite explicit values — they only fill gaps.
 */
export declare function mergeContext(
  explicit: WorkerContext | undefined,
  autoCollected: WorkerContext | undefined
): WorkerContext | undefined;
