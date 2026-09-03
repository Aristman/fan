/**
 * FAN Orchestrator — Conventions auto-profile lifecycle (F-6, code-review worker)
 *
 * Regeneration lifecycle for `.fan/code-review/conventions.md` (STEP 3 of the
 * code-review worker prompt). Roadmap: docs/features/code-review-worker/roadmap.md
 * → «#### ☐ F-6»; spec: docs/specs/spec_code-review-worker_2026-09-03.md.
 *
 * Three regeneration triggers (first fired wins), extracted into the pure exported
 * function shouldRegenerate(parsed | null, currentFiles, now) → {regen, reason}
 * (roadmap refactor goal: unit-testable without fs):
 *   1. file missing or unparsable (parseConventions (F-5) throws, including the
 *      missing-file case) → regenerate from scratch (no customSections to keep);
 *   2. frontmatter last_analyzed older than 30 days → regenerate;
 *   3. frontmatter analyzed_files differs from the actual list → regenerate.
 * None fired → cache-hit: {regenerated: false, reason: "no triggers fired"},
 * the file stays byte-for-byte identical and executeBash is never called.
 *
 * On regeneration the hand-written `## …` sections (parseConventions.customSections,
 * the F-5 data contract) are merged back into the new body; the standard
 * Style/Architecture/Patterns sections are re-emitted as minimal placeholders
 * with a TODO note — filling them with real conventions is the LLM worker's
 * runtime job (this function is the executable skeleton: triggers + merge + write).
 *
 * Write path (roadmap TC-F-6-2: single heredoc command, path narrowed):
 *   - options.executeBash provided → the file is written by EXACTLY ONE bash
 *     command, relative to projectDir (no absolute paths, no ".."):
 *         cat > .fan/code-review/conventions.md << 'EOF'
 *         <new content>
 *         EOF
 *     The delimiter is quoted ('EOF'), so `$`/backticks in section bodies are
 *     never expanded by bash.
 *   - options.executeBash absent → direct fs write to
 *     <projectDir>/.fan/code-review/conventions.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseConventions } from "./conventions.js";

/** Profile lifetime (roadmap F-6, trigger 2): last_analyzed older than this → regenerate. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Project-relative path of the conventions profile (worker reads/writes this exact path). */
const CONVENTIONS_REL_PATH = ".fan/code-review/conventions.md";

/** Quoted heredoc delimiter (TC-F-6-2 command shape: cat > <path> << 'EOF' … EOF). */
const HEREDOC_DELIMITER = "EOF";

/** Standard body sections regenerated from scratch on every write (F-5 schema slots). */
const STANDARD_SECTION_TITLES = ["Style", "Architecture", "Patterns"];

/**
 * @typedef {object} RegenerateOptions
 * @property {string} stack Stack id for the frontmatter (one of STACK_DETECTION_ORDER).
 * @property {string[]} analyzedFiles Actual reviewed-file list (review scope / disk).
 * @property {(command: string) => void | Promise<void>} [executeBash] Bash executor;
 *   when provided the file is written via a single heredoc command, otherwise via fs.
 */

/**
 * @typedef {object} RegenerateResult
 * @property {boolean} regenerated Whether the profile was (re)written.
 * @property {string} reason Fired trigger, or "no triggers fired" on cache-hit.
 */

/**
 * Validate required options (fail-fast, same style as findings.js/validateConventions).
 *
 * @param {RegenerateOptions} options
 */
function assertOptions(options) {
    if (typeof options?.stack !== "string" || options.stack.trim() === "") {
        throw new Error(`regenerateConventions: options.stack must be a non-empty string`);
    }
    if (
        !Array.isArray(options.analyzedFiles) ||
        options.analyzedFiles.length === 0 ||
        !options.analyzedFiles.every((file) => typeof file === "string" && file.trim() !== "")
    ) {
        throw new Error(`regenerateConventions: options.analyzedFiles must be a non-empty array of strings`);
    }
}

/**
 * Order-insensitive comparison of two file lists (trigger 3: "list changed").
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function sameFileList(a, b) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((file, index) => file === sortedB[index]);
}

/**
 * Build the full new conventions.md content: frontmatter (stack / last_analyzed /
 * analyzed_files) + placeholder Style/Architecture/Patterns + preserved customSections.
 *
 * @param {object} args
 * @param {string} args.stack
 * @param {string[]} args.analyzedFiles
 * @param {Date} args.now
 * @param {Record<string, string>} args.customSections
 * @returns {string} File content with a trailing newline.
 */
function buildConventionsMarkdown({ stack, analyzedFiles, now, customSections }) {
    const lines = [
        "---",
        `stack: ${stack}`,
        `last_analyzed: ${now.toISOString()}`,
        "analyzed_files:",
        ...analyzedFiles.map((file) => `  - ${file}`),
        "---",
        "",
    ];
    for (const title of STANDARD_SECTION_TITLES) {
        lines.push(`## ${title}`, "");
        lines.push(
            `- TODO(code-review): fill during the next review run — ${title.toLowerCase()} ` +
                `conventions for the "${stack}" stack.`,
        );
        lines.push("");
    }
    for (const [name, body] of Object.entries(customSections ?? {})) {
        lines.push(`## ${name}`, "");
        const trimmed = String(body ?? "").trim();
        if (trimmed !== "") lines.push(trimmed);
        lines.push("");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
}

/**
 * Write the regenerated content: single heredoc command via executeBash, or direct fs.
 *
 * @param {string} projectDir
 * @param {RegenerateOptions} options
 * @param {string} content
 */
async function writeConventions(projectDir, options, content) {
    if (typeof options.executeBash === "function") {
        const command = [
            `cat > ${CONVENTIONS_REL_PATH} << '${HEREDOC_DELIMITER}'`,
            content,
            HEREDOC_DELIMITER,
        ].join("\n");
        await options.executeBash(command);
        return;
    }
    const absPath = path.join(projectDir, CONVENTIONS_REL_PATH);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
}

/**
 * Pure regeneration-trigger check (roadmap F-6 refactor goal): no fs/io, all three
 * triggers inside, first fired wins. Exported for unit tests — triggers are
 * decidable from (parsed, currentFiles, now) alone.
 *
 * @param {ReturnType<typeof parseConventions> | null} parsed Parsed conventions
 *   profile (F-5) or null when the file is missing/unparsable.
 * @param {string[]} currentFiles Actual reviewed-file list (review scope / disk).
 * @param {Date} now Current moment (trigger 2 compares last_analyzed against this).
 * @returns {{regen: boolean, reason: string}} regen=true with the fired trigger as
 *   reason, or regen=false with "no triggers fired" on cache-hit.
 */
export function shouldRegenerate(parsed, currentFiles, now) {
    // Trigger 1: file missing or unparsable (parseConventions throws on both).
    if (parsed === null) {
        return { regen: true, reason: "conventions.md missing or unparsable" };
    }
    // Trigger 2: last_analyzed older than 30 days.
    if (now.getTime() - parsed.lastAnalyzed.getTime() > THIRTY_DAYS_MS) {
        return { regen: true, reason: "last_analyzed is older than 30 days" };
    }
    // Trigger 3: analyzed_files differ from the actual list.
    if (!sameFileList(parsed.analyzedFiles, currentFiles)) {
        return { regen: true, reason: "analyzed_files changed" };
    }
    // Cache-hit: no trigger fired.
    return { regen: false, reason: "no triggers fired" };
}

/**
 * Check the regeneration triggers (shouldRegenerate) and (re)generate
 * `.fan/code-review/conventions.md` when one fires. Cache-hit leaves the file
 * byte-for-byte untouched.
 *
 * @param {string} projectDir Project root containing `.fan/code-review/conventions.md`.
 * @param {RegenerateOptions} options
 * @returns {Promise<RegenerateResult>}
 * @throws {Error} When options.stack / options.analyzedFiles are missing or invalid.
 */
export async function regenerateConventions(projectDir, options) {
    assertOptions(options);
    const absPath = path.join(projectDir, CONVENTIONS_REL_PATH);
    const now = new Date();

    let parsed = null;
    try {
        parsed = parseConventions(absPath);
    } catch {
        parsed = null;
    }

    const { regen, reason } = shouldRegenerate(parsed, options.analyzedFiles, now);
    if (!regen) {
        // Cache-hit: file untouched, executeBash never called.
        return { regenerated: false, reason };
    }

    await writeConventions(projectDir, options, buildConventionsMarkdown({
        stack: options.stack,
        analyzedFiles: options.analyzedFiles,
        now,
        customSections: parsed?.customSections ?? {},
    }));
    return { regenerated: true, reason };
}
