/**
 * FAN Orchestrator — Review Runner (F-8, code-review worker)
 *
 * Diff-only review workflow: `git diff <base>...HEAD` → per-file unified-diff
 * parsing → findings (F-9 format) → verdict (F-10 mapping) → markdown report
 * with the STRICT 5-section order (roadmap: docs/features/code-review-worker/
 * roadmap.md → «#### ☐ F-8»; spec: docs/specs/spec_code-review-worker_2026-09-03.md,
 * «F-4. Diff-only ревью» + MANDATORY OUTPUT FORMAT):
 *
 *   ## Review Scope → ## Findings → ## Summary Table → [## Security Handoffs] → VERDICT
 *
 * Input scenarios (STEP 0 of the worker prompt):
 *   (a) gitUrl  — external repo (F-7): cloneExternalRepo({url, base, projectDir}, deps)
 *                 (external-repo-clone.js) maintains the shallow clone-cache
 *                 `.fan/git/<slug>` (--depth 200; cache hit → fetch --prune + checkout
 *                 <base>); stack, rules and the diff then run INSIDE the cache dir.
 *                 Shallow limitation — git fails with "fatal: bad revision" because
 *                 base is older than the cloned depth — is handled gracefully:
 *                 a `git fetch --unshallow` retry is attempted and, when it fails
 *                 too (e.g. no network), the result is a report carrying the
 *                 "git fetch --unshallow" instruction and VERDICT: NEEDS_DISCUSSION
 *                 (card F-7, step 6 — graceful fallback, never a throw).
 *   (b) base + projectDir — `git diff <base>...HEAD` in the given directory.
 *   (c) path    — local path to ANOTHER project: works in the target directory
 *                 (path wins over projectDir), NO cloning, conventions are read
 *                 from the target project's common `.fan/code-review/conventions.md`
 *                 (slug conventions `conventions.<name>.md` stay reserved for F-7).
 *
 * Pipeline (SKELETON — real git over real repos, NO LLM code analysis):
 *   1. Validate: targetDir = path ?? projectDir (exactly one required); base required.
 *   2. STEP 0, scenario (a): gitUrl → cloneExternalRepo (F-7, external-repo-clone.js)
 *      → reviewDir = cache dir `.fan/git/<slug>`; for (b)/(c) reviewDir = targetDir.
 *   3. STEP 1 — stack: detectStack(reviewDir) (F-3, stack-detection.js).
 *   4. STEP 2 — rules: loadRules(reviewDir, stack, rulesDir) (F-4, rules-loader.js)
 *      → { files, warning? }; rulesDir = options.rulesDir ?? env CODE_REVIEW_RULES_DIR
 *      (F-13) ?? <extension root>/review-rules (fileURLToPath pattern, F-13 parity).
 *   5. git diff: execGit(["diff", `${base}...HEAD`], reviewDir) — scenario (a) diffs
 *      inside the clone-cache; "fatal: bad revision" → unshallow retry → graceful
 *      NEEDS_DISCUSSION (see scenario (a) above). (b)/(c): no clone, no network.
 *   6. Empty stdout → EARLY RETURN with verdict "APPROVED" and scope marked
 *      "no changes detected". This is a SPECIAL CASE ON TOP OF severityToVerdict:
 *      the F-10 mapper returns NEEDS_DISCUSSION for [] ("ambiguity"), but an empty
 *      DIFF means "nothing to review" = APPROVED (roadmap TC-F-8-2).
 *   7. Per-file unified-diff parsing: file boundaries on «diff --git a/<p> b/<p>»
 *      (path from the b/ side, relative, POSIX separators, refined by «+++ b/<p>»);
 *      new-file line numbers from hunk headers «@@ -a,b +c,d @@» (1-based); added
 *      lines are «+»-prefixed (the «+++» file header is never counted); deleted
 *      lines do not advance the new-file counter; renames/binary files are kept
 *      in scope with a note but skipped from analysis.
 *   8. Analysis — PLACEHOLDER HEURISTIC (documented stub for the LLM step; the real
 *      rule-based analysis is performed by the LLM code-review worker at runtime and
 *      is intentionally not reproducible in unit tests — here only the SKELETON is
 *      tested: diff retrieval, parsing, stub-rule application, output structure):
 *        added line matches /user\.id\b/ AND has no null-safety on the same line
 *        (none of «user?.», «== null», «!= null», «typeof user») → finding
 *        MAJOR (category "correctness") with concrete problem/suggestion text;
 *        added line matches one of SECURITY_PATTERNS (F-11) → ADDITIONAL finding
 *        CRITICAL (category "security", securityNote: true) naming the marker.
 *   9. VERDICT: severityToVerdict(findings) (F-10, agents.js); empty diff — step 6.
 *   10. Report: all sections in the order above; finding lines are emitted in the
 *      exact F-9 line format so parseFindings(report) round-trips losslessly.
 *
 * Metrics (REFACTOR F-8, additive): runReview returns `metrics =
 * {durationMs, filesInDiff, rulesLoaded}` alongside the pre-existing fields —
 * wall time of the whole call, number of files parsed from the diff (0 for an
 * empty diff), and the count of loaded rule files. Report behavior and all
 * pre-existing result fields are unchanged.
 *
 * Security Handoffs (F-11): added lines matching SECURITY_PATTERNS produce
 * CRITICAL security findings (securityNote: true). When at least one exists,
 * a «## Security Handoffs» section — entries `- file:line — problem` plus the
 * explicit «Recommend delegating to security worker» RECOMMENDATION (never a
 * delegate_task tool call) — is inserted between «## Summary Table» and
 * «VERDICT:», and `handoffs` carries its full text. Without security findings
 * the section is omitted and `handoffs` stays undefined (TC-F-8-1 pin).
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectStack } from "./stack-detection.js";
import { loadRules } from "./rules-loader.js";
import { cloneExternalRepo } from "./external-repo-clone.js";
import { SEVERITY_VALUES } from "./findings.js";
import { severityToVerdict } from "./agents.js";

/** Extension root — fallback review-rules location (same pattern as F-13 injection). */
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_DIR = path.join(EXTENSION_DIR, "review-rules");

// ─── PLACEHOLDER heuristic (step 7) — real analysis is the LLM worker's job ───

/** Added line touches `user.id` (word-bounded — `user.idle` does not match). */
const USER_ID_RE = /user\.id\b/;
/** Null-safety markers that silence the heuristic ON THE SAME LINE ONLY. */
const NULL_SAFETY_RE = /user\?\.|==\s*null|!=\s*null|typeof\s+user/;

/**
 * SECURITY_PATTERNS (F-11): skeleton security markers scanned over added diff
 * lines. A matched line yields an ADDITIONAL finding — CRITICAL, category
 * "security", securityNote: true — whose problem text names the marker. This
 * is TAGGING for a security-worker handoff (roadmap F-11), not an audit: the
 * worker never delegates on its own (TC-F-11-2). Order matters: the FIRST
 * matching marker names the finding. Patterns are line-scoped (no `g` flag —
 * `test()` must stay stateless).
 */
export const SECURITY_PATTERNS = Object.freeze([
    {
        // String-concatenated SQL: db.query("…" + input) / exec('…' + input),
        // or template interpolation: query(`…${input}`)
        name: "SQL injection",
        pattern: /\b(?:query|execute|exec)\s*\(\s*(?:"[^"]*"\s*\+|'[^']*'\s*\+|`[^`]*\$\{)/i,
    },
    {
        // Raw HTML sinks: el.innerHTML = …, document.write(…)
        name: "XSS",
        pattern: /\b(?:innerHTML|outerHTML)\s*=|\bdocument\.write(?:ln)?\s*\(/i,
    },
    {
        // Credential literals: const API_KEY = "sk-live-…", password = "hunter2"
        name: "hardcoded secret",
        pattern: /\b(?:password|passwd|secret|api_?key|access_?token|auth_?token|private_?key)\b\s*[:=]\s*["'][^"']{4,}["']/i,
    },
    {
        // Broken primitives: createHash("md5"/"sha1"), createCipher("des"/"rc4")
        name: "weak crypto",
        pattern: /\b(?:createHash|createCipher(?:iv)?)\s*\(\s*["'](md5|sha1|des|rc4)["']/i,
    },
    {
        // «..» path segments, or FS reads fed straight from request input
        name: "path traversal",
        pattern: /\.\.[\\/]|(?:readFileSync?|createReadStream)\s*\([^)]*\breq(?:uest)?\.(?:query|params|body)\b/i,
    },
    {
        // Interpreting data as code: eval(…), new Function(…), unserialize(…)
        name: "insecure deserialization",
        pattern: /\b(?:eval\s*\(|new\s+Function\s*\(|unserialize\s*\(|pickle\.loads\s*\()/i,
    },
    {
        // Route registered WITHOUT an auth/middleware/guard/session/token marker
        // on the same line (skeleton heuristic — single line only)
        name: "missing auth",
        pattern: /^(?=.*\b(?:app|router|server)\.(?:get|post|put|patch|delete|all)\s*\()(?!.*(?:auth|middleware|guard|session|token|permission|jwt|verify)).*$/i,
    },
    {
        // Object lookup keyed by unvalidated request data: findById(req.params.id)
        name: "IDOR",
        pattern: /\b(?:find(?:One|Many)?|findById(?:AndUpdate|AndDelete)?|deleteOne|updateOne)\s*\([^)]*\breq\.(?:params|query|body)\b/i,
    },
]);

/**
 * Default git executor: contract-compatible with deps.execGit. Returns stdout;
 * on non-zero exit throws an Error carrying git's stderr.
 *
 * @param {string[]} args - Git arguments (without the "git" binary itself).
 * @param {string} cwd - Working directory for the command.
 * @returns {string} Command stdout (utf-8).
 */
function defaultExecGit(args, cwd) {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf-8" });
    } catch (err) {
        const stderr = typeof err.stderr === "string" ? err.stderr : err.message;
        throw new Error(`git ${args.join(" ")} failed (cwd: ${cwd}): ${stderr.trim()}`);
    }
}

/**
 * Extract the b/-side path from a «diff --git a/<p> b/<p>» header line.
 * Heuristic (paths with spaces are disambiguated by the «+++ b/<p>» line).
 *
 * @param {string} line - Full «diff --git …» line.
 * @returns {string} Relative POSIX path from the b/ side.
 */
function pathFromDiffHeader(line) {
    const rest = line.slice("diff --git ".length);
    const idx = rest.indexOf(" b/");
    return idx >= 0 ? rest.slice(idx + 3) : rest;
}

/**
 * Extract a path from a «--- »/«+++ » line: strip the trailing tab marker
 * (git appends "\t" for paths with spaces) and the a//b/ prefix.
 *
 * @param {string} rest - Line content after the «--- »/«+++ » marker.
 * @returns {string} Relative POSIX path (or "/dev/null").
 */
function pathFromMarkerLine(rest) {
    const raw = rest.split("\t")[0].trim();
    return raw.replace(/^[ab]\//, "");
}

/**
 * Parse a unified diff into per-file records of added lines with new-file
 * line numbers (1-based, from «@@ -a,b +c,d @@» hunk headers).
 *
 * Parsing rules (contract step 6):
 *   - «diff --git …» starts a new file record (path from the b/ side);
 *   - «+++ b/<p>» refines the path; «+++ /dev/null» marks a deleted file;
 *   - «@@ -a,b +c,d @@» sets the new-file line counter to c;
 *   - «+» lines (never «+++») are added content: recorded, counter advances;
 *   - «-» lines do NOT advance the counter (deleted content is not in the new file);
 *   - context lines (and blank lines inside hunks) advance the counter;
 *   - binary («Binary files …», «GIT binary patch») and renamed files are
 *     flagged and skipped from analysis, but stay listed in the scope.
 *
 * @param {string} diffText - Raw `git diff <base>...HEAD` stdout.
 * @returns {{path: string, added: {line: number, content: string}[], binary: boolean, renamed: boolean, deleted: boolean}[]} Per-file parse records.
 */
export function parseUnifiedDiff(diffText) {
    const files = [];
    let current = null;

    for (const rawLine of diffText.split(/\r?\n/)) {
        if (rawLine.startsWith("diff --git ")) {
            current = { path: pathFromDiffHeader(rawLine), added: [], binary: false, renamed: false, deleted: false };
            files.push(current);
            continue;
        }
        if (current === null) {
            continue;
        }
        // File markers MUST be checked before the +/- content prefixes.
        if (rawLine.startsWith("+++ ")) {
            const p = pathFromMarkerLine(rawLine.slice(4));
            if (p === "/dev/null") {
                current.deleted = true;
            } else {
                current.path = p;
            }
            continue;
        }
        if (rawLine.startsWith("--- ")) {
            continue; // old-file path — not needed for new-file line numbering
        }
        if (rawLine.startsWith("@@ ")) {
            const match = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match) {
                current.inHunk = true;
                current.newLine = Number.parseInt(match[1], 10);
            }
            continue;
        }
        if (rawLine.startsWith("+")) {
            current.added.push({ line: current.newLine, content: rawLine.slice(1) });
            current.newLine += 1;
            continue;
        }
        if (rawLine.startsWith("-")) {
            continue; // deleted line — new-file counter unchanged
        }
        if (rawLine.startsWith("\\")) {
            continue; // «\ No newline at end of file»
        }
        if (rawLine.startsWith("Binary files ") || rawLine === "GIT binary patch") {
            current.binary = true;
            continue;
        }
        if (rawLine.startsWith("rename ")) {
            current.renamed = true;
            continue;
        }
        if (current.inHunk) {
            // Context line (leading space) or blank context line (git strips
            // the trailing space on empty lines) — present in the new file.
            current.newLine += 1;
        }
    }
    return files;
}

/**
 * PLACEHOLDER analysis (contract step 7 — see module docstring): apply the
 * documented stub heuristic to every added line of an analyzable file.
 *
 * @param {{path: string, added: {line: number, content: string}[], binary: boolean, renamed: boolean, deleted: boolean}[]} files - Parsed diff records.
 * @returns {{severity: "CRITICAL"|"MAJOR", file: string, line: number, category: "correctness"|"security", problem: string, suggestion: string, securityNote?: boolean}[]} Findings in F-9 format, diff order; security findings additionally carry securityNote: true (F-11).
 */
function analyzeAddedLines(files) {
    const findings = [];
    for (const file of files) {
        if (file.binary || file.renamed || file.deleted) {
            continue;
        }
        for (const { line, content } of file.added) {
            if (USER_ID_RE.test(content) && !NULL_SAFETY_RE.test(content)) {
                findings.push({
                    severity: "MAJOR",
                    file: file.path,
                    line,
                    category: "correctness",
                    problem: "Possible access to user.id without a null-check",
                    suggestion: "Add a null/undefined check for user before accessing user.id",
                });
            }
            // F-11: skeleton security markers — an added line matching any
            // SECURITY_PATTERNS entry yields an ADDITIONAL finding (a TAG for
            // the security-worker handoff; the first matched marker names it).
            for (const { name, pattern } of SECURITY_PATTERNS) {
                if (pattern.test(content)) {
                    findings.push({
                        severity: "CRITICAL",
                        file: file.path,
                        line,
                        category: "security",
                        problem: `${name}: pattern matched in added line — needs a dedicated security audit`,
                        suggestion: `Run a full security audit for ${file.path}:${line} (${name}) and fix the risk before merge`,
                        securityNote: true,
                    });
                    break; // one security finding per added line
                }
            }
        }
    }
    return findings;
}

/**
 * Build the «## Review Scope» section (verbatim part of the final report):
 * loaded rules (absolute paths from loadRules) + diff file list, or the
 * «no changes detected» mark for an empty diff.
 */
function formatScopeSection({ base, rules, diffFiles, isEmpty }) {
    const lines = ["## Review Scope", "", `- Diff: git diff ${base}...HEAD`, "- Rules loaded:"];
    for (const ruleFile of rules.files) {
        lines.push(`  - ${ruleFile}`);
    }
    if (rules.warning) {
        lines.push(`- Warning: ${rules.warning}`);
    }
    if (isEmpty) {
        lines.push(`- no changes detected — git diff ${base}...HEAD produced no output`);
    } else {
        lines.push(`- Files in diff (${diffFiles.length}):`);
        for (const file of diffFiles) {
            let entry = `  - ${file.path}`;
            if (file.binary) {
                entry += " (binary — skipped from analysis)";
            } else if (file.renamed) {
                entry += " (renamed — skipped from analysis)";
            } else if (file.deleted) {
                entry += " (deleted — nothing to analyze in the new file)";
            }
            lines.push(entry);
        }
    }
    return lines.join("\n");
}

/**
 * Build the «## Findings» section. Finding lines use the exact F-9 line format
 * so parseFindings(report) reproduces the findings array losslessly.
 */
function formatFindingsSection(findings) {
    const lines = ["## Findings", ""];
    if (findings.length === 0) {
        lines.push("_No findings._");
        return lines.join("\n");
    }
    for (const f of findings) {
        const category = f.category === undefined ? "" : `Category: ${f.category} | `;
        lines.push(
            `- Severity: ${f.severity} | File:Line: ${f.file}:${f.line} | ${category}` +
                `Problem: ${f.problem} | Suggestion: ${f.suggestion}`,
        );
    }
    return lines.join("\n");
}

/**
 * Build the «## Summary Table» section (REFACTOR F-8: exported for reuse and
 * customization). Default rendering — markdown table with the findings
 * distribution across the full severity enum (zero rows included, so the
 * table is present even for an empty diff); report behavior is unchanged.
 *
 * @param {object[]} findings - Findings in F-9 format.
 * @param {{formatTable?: (rows: {severity: string, count: number}[]) => string}} [options]
 *   Custom output hook: formatTable receives the computed rows (one per
 *   SEVERITY_VALUES entry, in enum order, zero rows included) and returns the
 *   FULL section string, replacing the default markdown renderer.
 * @returns {string} Section text («## Summary Table» markdown by default).
 */
export function formatSummaryTable(findings, options) {
    const counts = new Map(SEVERITY_VALUES.map((severity) => [severity, 0]));
    for (const f of findings) {
        counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    }
    const rows = SEVERITY_VALUES.map((severity) => ({ severity, count: counts.get(severity) }));
    if (typeof options?.formatTable === "function") {
        return options.formatTable(rows);
    }
    const lines = ["## Summary Table", "", "| Severity | Count |", "| --- | --- |"];
    for (const { severity, count } of rows) {
        lines.push(`| ${severity} | ${count} |`);
    }
    return lines.join("\n");
}

/**
 * Build the «## Security Handoffs» section (F-11): one `- <file>:<line> —
 * <problem>` entry per security finding (securityNote: true) followed by the
 * explicit delegation RECOMMENDATION («Recommend delegating to security
 * worker») — a text hint for the coordinator, never a tool call (TC-F-11-2).
 *
 * @param {object[]} findings - Findings in F-9 format (securityNote allowed).
 * @returns {string|undefined} Full section text (header included), or undefined
 *   when there are no security findings (section omitted — TC-F-8-1 pin).
 */
function formatSecurityHandoffs(findings) {
    const security = findings.filter((f) => f.securityNote === true);
    if (security.length === 0) {
        return undefined;
    }
    const lines = ["## Security Handoffs", ""];
    for (const f of security) {
        lines.push(`- ${f.file}:${f.line} — ${f.problem}`);
    }
    lines.push("");
    lines.push("Recommend delegating to security worker");
    return lines.join("\n");
}

/**
 * «fatal: bad revision» from `git diff <base>...HEAD` against a shallow clone-cache
 * (scenario (a)): base is older than the cloned depth (F-7, card step 6).
 */
const BAD_REVISION_RE = /fatal:\s*bad revision/i;

/**
 * Build the «## Review Scope» section for the graceful shallow-limit fallback
 * (F-7, card step 6): the diff could not run because base is outside the
 * shallow history and the unshallow retry failed — the report carries the
 * «git fetch --unshallow» resolution instruction and ends with
 * VERDICT: NEEDS_DISCUSSION (assembled in runReview).
 */
function formatShallowLimitSection({ gitUrl, base, cacheDir, rules, diffError, unshallowError }) {
    const lines = [
        "## Review Scope",
        "",
        `- Diff: git diff ${base}...HEAD — failed: the clone-cache is a shallow clone (--depth 200)`,
        "- Rules loaded:",
    ];
    for (const ruleFile of rules.files) {
        lines.push(`  - ${ruleFile}`);
    }
    if (rules.warning) {
        lines.push(`- Warning: ${rules.warning}`);
    }
    if (gitUrl !== undefined) {
        lines.push(`- External repo: ${gitUrl} (clone-cache: ${cacheDir})`);
    }
    lines.push(`- Shallow clone limitation: base "${base}" is not present in the cached history — ${String(diffError?.message ?? diffError).trim()}`);
    lines.push(`- Resolution: run \`git fetch --unshallow\` in ${cacheDir}, then re-run the review`);
    lines.push(`- Unshallow attempt failed: ${String(unshallowError?.message ?? unshallowError).trim()}`);
    return lines.join("\n");
}

/**
 * Run the diff-only code-review workflow (F-8 skeleton; F-7 scenario (a) wiring).
 *
 * @param {object} options
 * @param {string} [options.projectDir] - Project directory (scenario (b)); target is `path ?? projectDir`;
 *   scenario (a): root of the `.fan/git` clone-cache.
 * @param {string} [options.path] - Local path to ANOTHER project (scenario (c)); wins over projectDir; no cloning.
 * @param {string} options.base - REQUIRED ref (commit/branch/tag); diff = `git diff <base>...HEAD`.
 * @param {string} [options.gitUrl] - External repo URL (scenario (a), F-7): delegated to
 *   cloneExternalRepo({url, base, projectDir}, deps) → shallow clone-cache `.fan/git/<slug>`;
 *   stack/rules/diff then run inside the cache dir; shallow-limit diff failure degrades
 *   gracefully to VERDICT: NEEDS_DISCUSSION with a `git fetch --unshallow` instruction.
 * @param {string} [options.rulesDir] - Review-rules corpus root; defaults to env
 *   CODE_REVIEW_RULES_DIR (F-13), then `<extension root>/review-rules`.
 * @param {{execGit?: (args: string[], cwd: string) => string, existsSync?: (p: string) => boolean, fs?: {mkdirSync: (p: string, opts?: object) => unknown}}} [deps]
 *   Injectable dependencies (test spies) — passed through to cloneExternalRepo in
 *   scenario (a); execGit defaults to synchronous execFileSync("git", …).
 * @returns {Promise<{scope: string, findings: object[], summaryTable: string, handoffs: string|undefined, report: string, verdict: "APPROVED"|"CHANGES_REQUESTED"|"NEEDS_DISCUSSION", rulesLoaded: string[], metrics: {durationMs: number, filesInDiff: number, rulesLoaded: number}}>}
 *   metrics (REFACTOR F-8, additive): durationMs — wall time of the whole call;
 *   filesInDiff — number of files parsed from the diff (0 for an empty diff);
 *   rulesLoaded — count of loaded rule files (rules.files.length).
 * @throws {Error} On missing base, missing projectDir/path, git/rules failures
 *   (stderr / common.md missing — F-4 contract); scenario (a) shallow-limit diff
 *   failures do NOT throw (graceful NEEDS_DISCUSSION, F-7 step 6).
 */
export async function runReview(options, deps) {
    const startedAt = Date.now(); // metrics.durationMs (REFACTOR F-8)
    const opts = options ?? {};

    // ── Step 1: validation (base → target dir) ──
    if (typeof opts.base !== "string" || opts.base.trim().length === 0) {
        throw new Error('runReview requires a "base" ref (commit/branch/tag) to diff against HEAD');
    }
    const targetDir = opts.path ?? opts.projectDir;
    if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
        throw new Error('runReview requires exactly one target directory: "projectDir" (current project) or "path" (local path to another project)');
    }

    const execGit = deps?.execGit ?? defaultExecGit;
    const rulesDir = opts.rulesDir ?? process.env.CODE_REVIEW_RULES_DIR ?? DEFAULT_RULES_DIR;

    // ── STEP 0, scenario (a): gitUrl → shallow clone-cache (F-7, external-repo-clone.js) ──
    // reviewDir = cache dir `.fan/git/<slug>`; scenarios (b)/(c): reviewDir = targetDir.
    let reviewDir = targetDir;
    let externalCache = null;
    if (opts.gitUrl !== undefined) {
        externalCache = cloneExternalRepo({ url: opts.gitUrl, base: opts.base, projectDir: opts.projectDir }, deps);
        reviewDir = externalCache.cacheDir;
    }

    // ── STEP 1: stack (F-3) ──
    const stack = detectStack(reviewDir);

    // ── STEP 2: rules (F-4) — throws when common.md is missing ──
    const rules = loadRules(reviewDir, stack, rulesDir);

    // ── git diff (scenario (a): inside the clone-cache; shallow-limit fallback below) ──
    let diffText;
    try {
        diffText = execGit(["diff", `${opts.base}...HEAD`], reviewDir);
    } catch (err) {
        // F-7 step 6 (scenario (a) only): base older than the shallow depth →
        // try `git fetch --unshallow`, on failure degrade gracefully.
        if (externalCache === null || !BAD_REVISION_RE.test(String(err?.message ?? err))) {
            throw err;
        }
        try {
            execGit(["fetch", "--unshallow"], reviewDir);
            diffText = execGit(["diff", `${opts.base}...HEAD`], reviewDir);
        } catch (unshallowErr) {
            // Graceful fallback (card F-7): report carries the unshallow instruction;
            // verdict NEEDS_DISCUSSION — deliberate, NOT the F-10 empty-findings mapping
            // and NOT the empty-diff APPROVED special case.
            const scope = formatShallowLimitSection({
                gitUrl: opts.gitUrl,
                base: opts.base,
                cacheDir: reviewDir,
                rules,
                diffError: err,
                unshallowError: unshallowErr,
            });
            const summaryTable = formatSummaryTable([]);
            const report = [scope, formatFindingsSection([]), summaryTable, "VERDICT: NEEDS_DISCUSSION"].join("\n\n") + "\n";
            const metrics = { durationMs: Date.now() - startedAt, filesInDiff: 0, rulesLoaded: rules.files.length };
            return { scope, findings: [], summaryTable, handoffs: undefined, report, verdict: "NEEDS_DISCUSSION", rulesLoaded: rules.files, metrics };
        }
    }

    // ── Empty diff → EARLY RETURN: APPROVED (special case on top of F-10) ──
    if (diffText.trim().length === 0) {
        const scope = formatScopeSection({ base: opts.base, rules, diffFiles: [], isEmpty: true });
        const summaryTable = formatSummaryTable([]);
        const report = [scope, formatFindingsSection([]), summaryTable, "VERDICT: APPROVED"].join("\n\n") + "\n";
        const metrics = { durationMs: Date.now() - startedAt, filesInDiff: 0, rulesLoaded: rules.files.length };
        return { scope, findings: [], summaryTable, handoffs: undefined, report, verdict: "APPROVED", rulesLoaded: rules.files, metrics };
    }

    // ── Per-file unified-diff parsing (contract step 6) ──
    const diffFiles = parseUnifiedDiff(diffText);

    // ── PLACEHOLDER analysis (contract step 7 — LLM worker replaces this at runtime) ──
    const findings = analyzeAddedLines(diffFiles);

    // ── VERDICT via F-10 mapping (empty diff handled above) ──
    const verdict = severityToVerdict(findings);

    // ── Report: Review Scope → Findings → Summary Table → [Security Handoffs] → VERDICT ──
    const scope = formatScopeSection({ base: opts.base, rules, diffFiles, isEmpty: false });
    const summaryTable = formatSummaryTable(findings);
    // F-11: security findings (securityNote: true) → «## Security Handoffs»
    // between Summary Table and VERDICT; no security findings → omitted, undefined.
    const handoffs = formatSecurityHandoffs(findings);
    const reportParts = [scope, formatFindingsSection(findings), summaryTable];
    if (handoffs !== undefined) {
        reportParts.push(handoffs);
    }
    reportParts.push(`VERDICT: ${verdict}`);
    const report = reportParts.join("\n\n") + "\n";

    const metrics = { durationMs: Date.now() - startedAt, filesInDiff: diffFiles.length, rulesLoaded: rules.files.length };
    return { scope, findings, summaryTable, handoffs, report, verdict, rulesLoaded: rules.files, metrics };
}
