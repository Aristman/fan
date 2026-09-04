/**
 * FAN Orchestrator — Finding structure schema parser (F-9, code-review worker)
 *
 * Parses the per-finding line format produced by the code-review worker
 * (F-8 review workflow output):
 *
 *   - Severity: <S> | File:Line: <path>:<line> | Category: <c> | Problem: <p> | Suggestion: <s>
 *
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-9»; spec
 * docs/specs/spec_code-review-worker_2026-09-03.md. The schema is reused by
 * F-8 (parsing the report into Finding[]) and F-11 (security-handoff tagging);
 * severityToVerdict (F-10, agents.js) consumes findings with the same
 * `severity` field — keeping this parser the single source of Finding shape.
 *
 * Documented Green-phase choices (contract fixed by test/findings-schema.test.mjs):
 *   - Invalid severity (not one of the 4 enum values) → throw. The message
 *     contains "severity" and the list of allowed values (roadmap TC-F-9-2:
 *     «ошибка указывает на невалидный severity + список допустимых значений»).
 *   - Non-finding lines → parseFinding returns null (no exception) and
 *     parseFindings filters them out. Worker output is a markdown report that
 *     mixes finding lines with headers/prose; treating prose as a hard error
 *     would make parseFindings unusable on real reports, so skipping is the
 *     default. A finding-SHAPED line ("- Severity: …") is never skipped:
 *     bad severity → throw, broken body → throw (fail-fast on malformed data).
 *   - Empty lines are always filtered (roadmap acceptance criterion #3);
 *     output order of findings is preserved.
 *   - The `Category:` section is optional: a finding line without it is valid
 *     and yields category === undefined.
 *
 * Line is matched case-insensitively (severity "critical" → "CRITICAL", like
 * F-10 parseVerdict), with `\s*` tolerance around every `|` separator.
 */

/**
 * Severity enum — single source of truth. Exported for reuse by F-11/F-14
 * (security-handoff tagging, summary table grouping) and shared validation.
 */
export const SEVERITY_VALUES = Object.freeze(["CRITICAL", "MAJOR", "MINOR", "INFO"]);

/**
 * Strict finding-line regex (roadmap F-9 Refactor goal: single regex with
 * named groups). Category section is optional. The `i` flag makes severity
 * case-insensitive. The `file` group is a GREEDY `.+` anchored by
 * `:(?<line>\d+)` before the ` | ` separator: backtracking leaves the LAST
 * `:<digits>` of the path as `line`, so colons inside paths parse fine
 * (Windows `C:\path\file.ts:42`, Linux `src/foo:bar.ts:5`).
 */
const FINDING_LINE_RE =
    /^\s*-\s*Severity:\s*(?<severity>CRITICAL|MAJOR|MINOR|INFO)\s*\|\s*File:Line:\s*(?<file>.+):(?<line>\d+)\s*\|(?:\s*Category:\s*(?<category>[^|]+?)\s*\|)?\s*Problem:\s*(?<problem>[^|]+?)\s*\|\s*Suggestion:\s*(?<suggestion>.*?)\s*$/i;

/**
 * Loose "finding-shaped" prefix — any line starting a finding entry. Used to
 * distinguish «finding line with invalid severity» (throw, TC-F-9-2) from
 * «non-finding line» (null → filtered by parseFindings).
 */
const FINDING_SHAPE_RE = /^\s*-\s*Severity:\s*(?<value>[^\s|]*)/i;

/**
 * @typedef {object} Finding
 * @property {"CRITICAL"|"MAJOR"|"MINOR"|"INFO"} severity Severity enum value.
 * @property {string} file Path WITHOUT the line number ("src/auth.ts").
 * @property {number} line Line number as a number (not a string).
 * @property {string|undefined} category Optional category; undefined when the
 *   `Category:` section is absent from the line.
 * @property {string} problem Problem description.
 * @property {string} suggestion Suggested fix.
 */

/**
 * Parse a single finding line into a Finding object.
 *
 * @param {string} line One line of worker output.
 * @returns {Finding|null} Parsed finding, or null for a non-finding line
 *   (see module docstring for the documented skip-choice).
 * @throws {Error} If the line is finding-shaped but the severity is invalid
 *   (message contains "severity" + the allowed values, roadmap TC-F-9-2), or
 *   if the body after a valid severity does not match the line format.
 * @throws {TypeError} If `line` is not a string.
 */
export function parseFinding(line) {
    if (typeof line !== "string") {
        throw new TypeError(`parseFinding expects a string line, got ${typeof line}`);
    }

    const match = line.match(FINDING_LINE_RE);
    if (match) {
        return {
            severity: match.groups.severity.toUpperCase(),
            file: match.groups.file.trim(),
            line: Number.parseInt(match.groups.line, 10),
            category: match.groups.category === undefined ? undefined : match.groups.category.trim(),
            problem: match.groups.problem.trim(),
            suggestion: match.groups.suggestion.trim(),
        };
    }

    // Strict regex failed — is the line finding-shaped at all?
    const shape = line.match(FINDING_SHAPE_RE);
    if (shape) {
        const value = shape.groups.value.toUpperCase();
        if (SEVERITY_VALUES.includes(value)) {
            // Valid severity but malformed body — fail fast instead of
            // silently dropping a real (broken) finding.
            throw new Error(
                `Malformed finding line: severity "${value}" is valid but the body does not match ` +
                    `"Severity | File:Line | Category | Problem | Suggestion" — ${line.trim()}`,
            );
        }
        throw new Error(
            `Invalid severity "${shape.groups.value || "(missing)"}" in finding line ` +
                `(allowed values: ${SEVERITY_VALUES.join(", ")})`,
        );
    }

    // Non-finding line (header/prose/blank) — skipped by default.
    return null;
}

/**
 * Parse multi-line worker markdown output into an ordered Finding[].
 *
 * Empty lines are filtered (roadmap F-9 acceptance criterion #3) and
 * non-finding lines are skipped (parseFinding → null, documented choice);
 * the order of findings follows the order of lines in the output.
 *
 * @param {string} output Full multi-line markdown output of the worker.
 * @returns {Finding[]} Parsed findings in output order (empty array when the
 *   output contains no finding lines).
 */
export function parseFindings(output) {
    return output
        .split(/\r?\n/)
        .filter((raw) => raw.trim().length > 0)
        .map((raw) => parseFinding(raw))
        .filter((finding) => finding !== null);
}
