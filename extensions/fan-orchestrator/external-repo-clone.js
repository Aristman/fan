/**
 * FAN Orchestrator — External Repo Clone-Cache (F-7, code-review worker)
 *
 * Shallow clone-cache for reviewing EXTERNAL repositories by git URL (roadmap:
 * docs/features/code-review-worker/roadmap.md → «#### ☐ F-7»; card steps 1-5;
 * tests: test/external-repo-clone.test.mjs — TC-F-7-1, TC-F-7-2).
 *
 * Algorithm (card F-7):
 *   1) slug = owner-repo from the URL (repoSlug: https://github.com/owner/repo
 *      → "owner-repo"; edge cases handled — «.git» suffix stripped, git@ SSH
 *      format, self-hosted deep paths → last two segments);
 *   2) ensure the cache root `<projectDir>/.fan/git` (mkdir -p);
 *   3) cache miss → `git clone --depth 200 <url> .fan/git/<slug>` with
 *      cwd = projectDir (the target arg stays POSIX-relative so the git
 *      command is byte-identical to the card's: «clone --depth 200 <url>
 *      .fan/git/<slug>»);
 *   4) cache hit → `git fetch --prune` + `git checkout <base>` inside the
 *      cache dir (the card's «cd .fan/git/<slug>» = cwd argument of execGit);
 *   5) `base` is REQUIRED (commit/branch/tag) — missing base → throw with
 *      "base" in the message;
 *   6) every SUCCESSFUL clone/fetch also writes the cache-age stamp
 *      `<cacheDir>/.cloned-at` (ISO date, best-effort — Refactor goal).
 *
 * Steps 6-7 of the card (git diff + bad-revision shallow fallback) live in
 * review-runner.js: runReview is the scenario- (a) entry point — it delegates
 * cloning to cloneExternalRepo and runs `git diff <base>...HEAD` inside the
 * returned cache dir (F-7 Green wiring; «fatal: bad revision» → unshallow
 * instruction → graceful VERDICT: NEEDS_DISCUSSION). Card step 7 (external
 * conventions as a separate `conventions.<slug>.md`) is NOT wired yet —
 * TODO in cloneExternalRepo below (F-8/F-7 integration consumes cacheDir).
 *
 *
 * Dependency injection (pattern of review-runner.js / defaultExecGit): every
 * side-effectful dependency can be replaced for tests —
 *   - deps.execGit(args, cwd) → stdout string; non-zero exit → throw with
 *     git's stderr (default: execFileSync("git", …));
 *   - deps.existsSync(path) → boolean cache probe (default: node:fs);
 *   - deps.fs.mkdirSync(path, opts) → cache-root creation (default: node:fs).
 * Missing deps entries fall back to the real implementations (TC-F-7-3 passes
 * deps without fs).
 *
 * Return value: { slug, cacheDir } — cacheDir is consumed by runReview (diff
 * cwd); tests pin only the execGit commands and the existsSync probe path.
 *
 * Refactor goals (roadmap F-7 «Refactor-цели») — IMPLEMENTED:
 *   - repoSlug(url) edge cases: «.git» suffix stripped, git@ SSH format,
 *     self-hosted deep paths (pinned by the slug-matrix test);
 *   - cache-age stamp `<cacheDir>/.cloned-at` after every clone/fetch.
 */

import { execFileSync } from "node:child_process";
import {
    existsSync as defaultExistsSync,
    mkdirSync as defaultMkdirSync,
    writeFileSync as defaultWriteFileSync,
} from "node:fs";
import * as path from "node:path";

/** Cache root, relative to the project directory (POSIX separators — passed verbatim to git). */
const GIT_CACHE_REL = ".fan/git";

/** Cache-age stamp file name inside <cacheDir> (F-7 Refactor goal: track clone freshness). */
const CLONED_AT_FILE = ".cloned-at";

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
 * Derive the cache slug from a repo URL: «owner-repo» from the last two
 * path segments (basic https case, pinned by TC-F-7-1). Edge cases (F-7
 * Refactor goals, pinned by the slug-matrix test):
 *   - trailing «.git» suffix is stripped (case-insensitive, after trailing
 *     slashes) before slicing: https://github.com/owner/repo.git → «owner-repo»;
 *   - git@ SSH format: the host is separated by «:», so the same
 *     last-two-segments rule applies: git@github.com:owner/repo.git → «owner-repo»;
 *   - self-hosted deep paths keep the last two segments (previous behavior):
 *     https://git.corp.example/team/proj/repo → «proj-repo»;
 *   - empty/malformed input returns the input as-is — validation lives in
 *     cloneExternalRepo (throw on missing url), matching the prior contract.
 *
 * @param {string} url - External repo URL (https://… or git@…).
 * @returns {string} Slug «owner-repo».
 */
export function repoSlug(url) {
    // Normalize: drop trailing slashes, then the «.git» suffix (https + SSH forms).
    const normalized = url.replace(/\/+$/, "").replace(/\.git$/i, "");
    // Last two segments; separators: «/» (https path) or «:» (git@ SSH host part).
    const match = normalized.match(/([^/:]+)[/:]([^/:]+)\/?$/);
    return match === null ? url : `${match[1]}-${match[2]}`;
}

/**
 * Write the cache-age stamp `<cacheDir>/.cloned-at` (F-7 Refactor goal): ISO
 * timestamp of the last successful clone/fetch. Best-effort — a stamp write
 * failure NEVER fails the clone/fetch flow (auxiliary telemetry only; also
 * keeps partial fs spies in tests — `{ mkdirSync }` without writeFileSync —
 * working when the real-fs fallback hits a missing cache dir).
 *
 * @param {(p: string, data: string, encoding?: string) => void} writeFileSync - fs writer (deps.fs.writeFileSync or node:fs fallback).
 * @param {string} cacheDir - Absolute cache dir `<projectDir>/.fan/git/<slug>`.
 * @returns {void}
 */
function stampClonedAt(writeFileSync, cacheDir) {
    try {
        writeFileSync(path.join(cacheDir, CLONED_AT_FILE), new Date().toISOString(), "utf-8");
    } catch {
        // Best-effort: the stamp is telemetry, not a hard requirement.
    }
}

/**
 * Clone an external repo into the project's shallow clone-cache, or refresh
 * the existing cache entry (F-7, card steps 1-5).
 *
 * @param {object} options
 * @param {string} options.url - External repo URL (https://… or git@…); required.
 * @param {string} options.base - REQUIRED ref (commit/branch/tag) the cache is
 *   refreshed to on a cache hit (`git checkout <base>`); missing → throw with
 *   "base" in the message.
 * @param {string} [options.projectDir] - Project root holding `.fan/git`;
 *   defaults to process.cwd().
 * @param {{execGit?: (args: string[], cwd: string) => string, existsSync?: (p: string) => boolean, fs?: {mkdirSync: (p: string, opts?: object) => unknown, writeFileSync?: (p: string, data: string, encoding?: string) => void}}} [deps]
 *   Injectable dependencies (test spies); each entry falls back to its real
 *   implementation when omitted. fs.writeFileSync (optional) receives the
 *   cache-age stamp `.cloned-at` after every successful clone/fetch.
 * @returns {{slug: string, cacheDir: string}} Cache slug and ABSOLUTE cache dir
 *   `<projectDir>/.fan/git/<slug>` (consumed by runReview as the diff cwd).
 *   Side effect: `<cacheDir>/.cloned-at` = ISO date of the clone/fetch
 *   (best-effort stamp, F-7 Refactor goal).
 * @throws {Error} When url or base is missing, or when a git command fails
 *   (defaultExecGit carries git's stderr).
 */
export function cloneExternalRepo(options, deps) {
    const opts = options ?? {};
    const execGit = deps?.execGit ?? defaultExecGit;
    const existsSync = deps?.existsSync ?? defaultExistsSync;
    const mkdirSync = deps?.fs?.mkdirSync ?? defaultMkdirSync;
    const writeFileSync = deps?.fs?.writeFileSync ?? defaultWriteFileSync;

    if (typeof opts.url !== "string" || opts.url.trim().length === 0) {
        throw new Error('cloneExternalRepo requires a "url" (external repo: https://… or git@…)');
    }
    if (typeof opts.base !== "string" || opts.base.trim().length === 0) {
        throw new Error('cloneExternalRepo requires a "base" ref (commit/branch/tag) — the shallow clone has no ref to refresh to');
    }

    const projectDir = opts.projectDir ?? process.cwd();
    const slug = repoSlug(opts.url);
    const cacheRoot = path.join(projectDir, GIT_CACHE_REL); // mkdir -p .fan/git (step 2)
    const cacheDir = path.join(cacheRoot, slug); // absolute probe path for deps.existsSync

    mkdirSync(cacheRoot, { recursive: true });

    if (!existsSync(cacheDir)) {
        // Cache miss (step 3): shallow clone --depth 200, cwd = projectDir.
        // The target stays POSIX-relative so the git command matches the card verbatim.
        execGit(["clone", "--depth", "200", opts.url, `${GIT_CACHE_REL}/${slug}`], projectDir);
        stampClonedAt(writeFileSync, cacheDir); // cache-age stamp (Refactor goal)
        return { slug, cacheDir };
        // TODO(F-7 card step 7 — out of scope of this REFACTOR phase): external-repo
        // conventions live as a SEPARATE file `.fan/code-review/conventions.<slug>.md`
        // (F-5 schema), distinct from the project-local conventions.md. F-8/F-7
        // integration in review-runner.js already consumes cacheDir — wire the
        // slug-scoped conventions loading there (currently only the common file is read).
    }

    // Cache hit (step 4): «cd .fan/git/<slug>» = cwd argument of execGit —
    // refresh remote refs, then check out the requested base. No clone.
    execGit(["fetch", "--prune"], cacheDir);
    execGit(["checkout", opts.base], cacheDir);
    stampClonedAt(writeFileSync, cacheDir); // stamp refreshed on every successful fetch
    return { slug, cacheDir };
}
