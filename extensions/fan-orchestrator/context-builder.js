/**
 * Context Builder — collects, merges, and formats worker context.
 *
 * The WorkerContext shape is a forward-compatible contract with
 * super-orchestrator v3 work_package.context (spec_super-orchestrator_v3_2026-08-10.md §3.3.2):
 * parentSummary / relevantFiles / constraints. FAN-specific extensions
 * (previousFindings, gitState, projectTree) are an optional superset.
 *
 * The formatted block is injected between the agent system prompt and the
 * "## Task" section of the worker prompt (see subagent-runner.js).
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Total context limit in characters (~5650 tokens). */
export const TOTAL_CONTEXT_LIMIT = 22500;

/** Per-section limits in characters. */
export const SECTION_LIMITS = {
    parentSummary: 2000,
    relevantFiles: 4000,
    previousFindings: 8000,
    constraints: 1500,
    gitState: 3000,
    projectTree: 4000,
};

/** Max length for auto-injected previous step output in chain mode. */
export const PREVIOUS_OUTPUT_LIMIT = 6000;

/** Directory names excluded from the project tree. */
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", ".fan"]);

/** Placeholder shown when the project tree cannot be collected. */
const TREE_UNAVAILABLE = "(project tree unavailable)";

/**
 * Truncate a string to maxLen characters. If truncated, appends a marker
 * `... (truncated, N chars omitted)` describing how much was cut.
 *
 * @param str - Input string (non-strings are treated as "")
 * @param maxLen - Maximum number of content characters to keep
 */
export function truncate(str, maxLen) {
    if (typeof str !== "string")
        return "";
    if (str.length <= maxLen)
        return str;
    const omitted = str.length - maxLen;
    return `${str.slice(0, maxLen)}\n... (truncated, ${omitted} chars omitted)`;
}

/** Format one relevantFiles entry: string | {path, lines?, purpose?}. */
function formatRelevantFile(entry) {
    if (typeof entry === "string")
        return `- \`${entry}\``;
    if (!entry || typeof entry !== "object" || !entry.path)
        return "";
    let line = `- \`${entry.path}\``;
    if (entry.lines)
        line += ` (lines ${entry.lines})`;
    if (entry.purpose)
        line += ` — ${entry.purpose}`;
    return line;
}

/**
 * Format a WorkerContext into a markdown block:
 *
 *   ## Project Context
 *   ### Summary / ### Relevant Files / ### Previous Findings /
 *   ### Constraints / ### Git State / ### Project Structure
 *
 * Only non-empty sections are included. Returns "" for an empty/undefined
 * context so callers can keep the legacy prompt format bit-for-bit.
 *
 * @param context - WorkerContext (all fields optional)
 */
export function formatContextBlock(context) {
    if (!context || typeof context !== "object")
        return "";
    const sections = [];
    if (context.parentSummary) {
        sections.push(`### Summary\n${truncate(context.parentSummary, SECTION_LIMITS.parentSummary)}`);
    }
    if (Array.isArray(context.relevantFiles) && context.relevantFiles.length > 0) {
        const lines = context.relevantFiles.map(formatRelevantFile).filter(Boolean);
        if (lines.length > 0) {
            sections.push(`### Relevant Files\n${truncate(lines.join("\n"), SECTION_LIMITS.relevantFiles)}`);
        }
    }
    if (context.previousFindings) {
        sections.push(`### Previous Findings\n${truncate(context.previousFindings, SECTION_LIMITS.previousFindings)}`);
    }
    if (Array.isArray(context.constraints) && context.constraints.length > 0) {
        const lines = context.constraints.filter((c) => typeof c === "string" && c.trim() !== "").map((c) => `- ${c}`);
        if (lines.length > 0) {
            sections.push(`### Constraints\n${truncate(lines.join("\n"), SECTION_LIMITS.constraints)}`);
        }
    }
    if (context.gitState) {
        sections.push(`### Git State\n${truncate(context.gitState, SECTION_LIMITS.gitState)}`);
    }
    if (context.projectTree) {
        sections.push(`### Project Structure\n${truncate(context.projectTree, SECTION_LIMITS.projectTree)}`);
    }
    if (sections.length === 0)
        return "";
    const block = `## Project Context\n\n${sections.join("\n\n")}`;
    return truncate(block, TOTAL_CONTEXT_LIMIT);
}

/** Run a command synchronously with a hard timeout. Throws on failure. */
function execQuiet(command, cwd) {
    return execSync(command, {
        cwd,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
    })
        .toString()
        .trim();
}

/** Filter tree output lines, dropping any path that contains an excluded segment. */
export function filterTreeLines(raw) {
    return raw
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => {
            const trimmed = l.trim();
            return trimmed !== "" && trimmed !== ".";
        })
        .filter((line) => {
            const segments = line.replace(/\\/g, "/").split("/").filter(Boolean);
            return !segments.some((seg) => EXCLUDED_DIRS.has(seg));
        })
        .join("\n");
}

/** In-memory cache for collectProjectContext: key → { time, value }. */
const _contextCache = new Map();
const CONTEXT_CACHE_TTL = 30_000; // 30 seconds

/** Clear the collectProjectContext cache (exported for testing). */
export function clearContextCache() {
    _contextCache.clear();
}

/**
 * Auto-collect project context: git status + last 5 commits and a 2-level
 * directory tree (excluding node_modules, dist, .git, .fan).
 *
 * Never throws — failures produce placeholder strings. Commands have a
 * 5000ms timeout and use platform-specific variants (win32/posix).
 * Results are cached in-memory for 30 seconds (keyed by cwd + flags).
 *
 * @param cwd - Working directory to inspect
 * @param options - Flags: includeGitState, includeProjectTree (both default true)
 */
export function collectProjectContext(cwd, options) {
    const includeGitState = options?.includeGitState !== false;
    const includeProjectTree = options?.includeProjectTree !== false;
    const cacheKey = `${cwd}|${includeGitState}|${includeProjectTree}`;
    const cached = _contextCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CONTEXT_CACHE_TTL) {
        return cached.value;
    }
    const context = {};
    if (includeGitState) {
        let statusText = "(git status unavailable)";
        let logText = "(git log unavailable)";
        try {
            statusText = execQuiet("git status -s", cwd) || "(clean)";
        }
        catch {
            /* keep placeholder */
        }
        try {
            logText = execQuiet("git log --oneline -5", cwd);
        }
        catch {
            /* keep placeholder */
        }
        context.gitState = `git status:\n${statusText}\n\nrecent commits:\n${logText}`;
    }
    if (includeProjectTree) {
        try {
            const treeCommand = process.platform === "win32"
                ? "powershell -NoProfile -Command \"Get-ChildItem -Directory | ForEach-Object { $r = './' + $_.Name; $r; Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object { $r + '/' + $_.Name } }\""
                : "find . -maxdepth 2 \\( -name node_modules -o -name dist -o -name .git -o -name .fan \\) -prune -o -type d -print";
            context.projectTree = filterTreeLines(execQuiet(treeCommand, cwd)) || "(empty project)";
        }
        catch {
            context.projectTree = TREE_UNAVAILABLE;
        }
    }
    _contextCache.set(cacheKey, { time: Date.now(), value: context });
    return context;
}

/**
 * Merge coordinator-provided (explicit) context with auto-collected context.
 * Explicit fields always win; auto-collected gitState/projectTree never
 * overwrite explicit values — they only fill gaps.
 *
 * @param explicit - Context passed via delegate_task (may be undefined)
 * @param autoCollected - Context from collectProjectContext (may be undefined)
 */
export function mergeContext(explicit, autoCollected) {
    if (!explicit && !autoCollected)
        return undefined;
    if (!explicit)
        return autoCollected;
    if (!autoCollected)
        return explicit;
    const merged = { ...explicit };
    if (merged.gitState === undefined && autoCollected.gitState !== undefined)
        merged.gitState = autoCollected.gitState;
    if (merged.projectTree === undefined && autoCollected.projectTree !== undefined)
        merged.projectTree = autoCollected.projectTree;
    return merged;
}
