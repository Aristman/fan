/**
 * FAN Orchestrator — Conventions.md schema parser (F-5, code-review worker)
 *
 * Parses `.fan/code-review/conventions.md` (project-local) and
 * `.fan/code-review/conventions.<name>.md` (external repos, same schema):
 * roadmap docs/features/code-review-worker/roadmap.md → F-5; spec
 * docs/specs/spec_code-review-worker_2026-09-03.md.
 *
 * File format:
 *   - YAML frontmatter between `---` markers at the very start of the file:
 *       stack: typescript                    (required, string)
 *       last_analyzed: 2026-09-03T12:00:00Z  (required, ISO 8601 → Date)
 *       analyzed_files:                      (required, non-empty list of strings;
 *         - src/index.ts                      YAML block list or inline [a, b])
 *   - Body: standard sections `## Style`, `## Architecture`, `## Patterns`
 *     plus ANY other `## …` sections the user added by hand.
 *
 * Hand-edited sections are a data contract: parseConventions never drops them —
 * every non-standard `## …` section lands in customSections[name] so F-6
 * (regeneration lifecycle) can merge them back into the new file.
 *
 * gray-matter is NOT in orchestrator dependencies (roadmap Refactor goal is a
 * skip), so frontmatter is parsed by hand: a regex on the `---` block plus
 * simple `key: value` / `- item` lines. parseConventions throws with the
 * MISSING FIELD NAME in the message (tests match /analyzed_files/) whenever a
 * required frontmatter field is absent or invalid — the worker then knows the
 * file must be regenerated from scratch (roadmap: "frontmatter полный → OK").
 */

import { readFileSync } from "node:fs";
import { STACK_DETECTION_ORDER } from "./stack-detection.js";

/** Frontmatter keys that are mandatory (validated on every parse). */
const REQUIRED_FIELDS = ["stack", "last_analyzed", "analyzed_files"];

/** Body sections with a fixed slot in result.sections (matched case-insensitively). */
const STANDARD_SECTION_KEYS = new Set(["style", "architecture", "patterns"]);

/** Known stacks — single source of truth reused from F-3 stack detection. */
const KNOWN_STACKS = STACK_DETECTION_ORDER;

/**
 * Split raw file content into frontmatter scalar block and body.
 * Frontmatter must start at byte 0; returns null frontmatter when absent.
 *
 * @param {string} raw - Full file content.
 * @returns {{frontmatter: string|null, body: string}}
 */
function splitFrontmatter(raw) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) {
        return { frontmatter: null, body: raw };
    }
    return { frontmatter: match[1], body: raw.slice(match[0].length) };
}

/** Strip surrounding whitespace and one level of YAML quotes from a scalar. */
function cleanScalar(value) {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

/**
 * Hand-rolled YAML subset parser: `key: value` scalars, `key:` followed by
 * `  - item` block lists, and inline `key: [a, b]` lists. Comments and blank
 * lines are skipped. Anything fancier is out of scope (conventions.md is
 * machine-generated; users only append `## …` sections, never edit YAML).
 *
 * @param {string} raw - Frontmatter content between the `---` markers.
 * @returns {Map<string, {scalar?: string, list?: string[]}>}
 */
function parseFrontmatterYaml(raw) {
    const fields = new Map();
    let currentKey = null;
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;

        // Block list item: "  - src/index.ts" (belongs to the previous `key:`)
        const listItem = line.match(/^\s+-\s+(.+)$/);
        if (listItem && currentKey) {
            const entry = fields.get(currentKey);
            if (!entry.list) entry.list = [];
            entry.list.push(cleanScalar(listItem[1]));
            continue;
        }

        const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!kv) continue;
        currentKey = kv[1];
        const value = kv[2].trim();
        const inlineList = value.match(/^\[(.*)\]$/s);
        if (inlineList) {
            // Inline YAML list: analyzed_files: [src/a.ts, src/b.ts]
            const items = inlineList[1]
                .split(",")
                .map((item) => cleanScalar(item))
                .filter((item) => item !== "");
            fields.set(currentKey, { list: items });
        } else if (value === "") {
            // Block list header — items may follow as `  - …` lines
            fields.set(currentKey, { list: [] });
        } else {
            fields.set(currentKey, { scalar: cleanScalar(value) });
        }
    }
    return fields;
}

/**
 * Split the markdown body into `## …` sections.
 * Standard sections (Style/Architecture/Patterns, case-insensitive) map to
 * sections.style/.architecture/.patterns; every other section is preserved
 * verbatim in customSections under its exact heading text (manual edits
 * must survive parsing — F-6 merge contract).
 *
 * @param {string} body - Markdown body after the frontmatter block.
 * @returns {{sections: {style?: string, architecture?: string, patterns?: string}, customSections: Record<string, string>}}
 */
function parseSections(body) {
    const sections = {};
    const customSections = {};
    let current = null; // { name, key|null, lines[] }
    const flush = () => {
        if (!current) return;
        const text = current.lines.join("\n").trim();
        if (current.key) sections[current.key] = text;
        else customSections[current.name] = text;
        current = null;
    };
    for (const line of body.split(/\r?\n/)) {
        // `## Heading` opens a section; `### …` stays inside the current one.
        const headingMatch = line.match(/^##\s+(.+?)\s*$/);
        if (headingMatch) {
            flush();
            const name = headingMatch[1].trim();
            const key = name.toLowerCase();
            current = { name, key: STANDARD_SECTION_KEYS.has(key) ? key : null, lines: [] };
        } else if (current) {
            current.lines.push(line);
        }
    }
    flush();
    return { sections, customSections };
}

/**
 * Parse a conventions.md file into its structured form.
 *
 * @param {string} filePath - Absolute or relative path to conventions.md.
 * @returns {{
 *   stack: string,
 *   lastAnalyzed: Date,
 *   analyzedFiles: string[],
 *   sections: {style?: string, architecture?: string, patterns?: string},
 *   customSections: Record<string, string>,
 * }} Parsed conventions; customSections keeps hand-written `## …` sections.
 * @throws {Error} When a required frontmatter field is missing/invalid — the
 *   message always names the offending field ("stack", "last_analyzed",
 *   "analyzed_files") so callers can regenerate the file.
 */
export function parseConventions(filePath) {
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(raw);
    if (frontmatter === null) {
        throw new Error(
            `conventions.md: no YAML frontmatter block found at file start; ` +
                `missing required frontmatter field(s): ${REQUIRED_FIELDS.join(", ")}`,
        );
    }
    const fields = parseFrontmatterYaml(frontmatter);

    // stack: required non-empty string
    const stack = fields.get("stack")?.scalar ?? "";
    if (stack === "") {
        throw new Error(`conventions.md: missing required frontmatter field "stack" (string)`);
    }

    // last_analyzed: required ISO 8601 date, parsed into Date
    const lastAnalyzedRaw = fields.get("last_analyzed")?.scalar ?? "";
    if (lastAnalyzedRaw === "") {
        throw new Error(`conventions.md: missing required frontmatter field "last_analyzed" (ISO 8601 date)`);
    }
    const lastAnalyzed = new Date(lastAnalyzedRaw);
    if (Number.isNaN(lastAnalyzed.getTime())) {
        throw new Error(
            `conventions.md: frontmatter field "last_analyzed" is not a valid ISO 8601 date: "${lastAnalyzedRaw}"`,
        );
    }

    // analyzed_files: required non-empty list of strings (block list or inline [a, b])
    const analyzedFiles = fields.get("analyzed_files")?.list ?? null;
    if (!analyzedFiles || analyzedFiles.length === 0) {
        throw new Error(
            `conventions.md: missing required frontmatter field "analyzed_files" (non-empty list of strings)`,
        );
    }

    const { sections, customSections } = parseSections(body);
    return { stack, lastAnalyzed, analyzedFiles, sections, customSections };
}

/**
 * Validate a parseConventions result against the frontmatter contract.
 * Validity = frontmatter completeness (roadmap: "frontmatter полный → OK");
 * the worker regenerates the file whenever valid === false.
 *
 * @param {ReturnType<typeof parseConventions>} parsed - Parsed conventions object.
 * @returns {{valid: boolean, errors: string[]}} errors — human-readable, one per violation.
 */
export function validateConventions(parsed) {
    const errors = [];

    if (typeof parsed?.stack !== "string" || parsed.stack.trim() === "") {
        errors.push(`field "stack" must be a non-empty string`);
    } else if (!KNOWN_STACKS.includes(parsed.stack)) {
        errors.push(`field "stack" must be one of: ${KNOWN_STACKS.join(", ")}; got "${parsed.stack}"`);
    }

    if (!(parsed?.lastAnalyzed instanceof Date) || Number.isNaN(parsed.lastAnalyzed.getTime())) {
        errors.push(`field "lastAnalyzed" (frontmatter last_analyzed) must be a valid Date (ISO 8601)`);
    }

    if (
        !Array.isArray(parsed?.analyzedFiles) ||
        parsed.analyzedFiles.length === 0 ||
        !parsed.analyzedFiles.every((file) => typeof file === "string" && file.trim() !== "")
    ) {
        errors.push(`field "analyzedFiles" (frontmatter analyzed_files) must be a non-empty array of strings`);
    }

    return { valid: errors.length === 0, errors };
}
