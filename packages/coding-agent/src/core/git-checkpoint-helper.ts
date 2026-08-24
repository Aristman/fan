/**
 * Git helpers for the Checkpoint API (F-45, docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-45).
 *
 * Thin wrappers over the git CLI, reused by AgentSession:
 *  - checkpoint:  `git add -A` + `git commit --allow-empty -m "checkpoint:<label>"`
 *  - restore:     `git checkout <commit>` (plain checkout per roadmap — never a forced
 *                 reset; if the work tree has conflicting local changes, git refuses and
 *                 the error is surfaced to the caller)
 *
 * FAN-internal state (checkpoint files under `.fan/`, session JSONL files) is excluded
 * from git tracking via `.git/info/exclude` (repo-local, never committed), so internal
 * bookkeeping never conflicts with checkpoint commits or checkouts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execCommand } from "./exec.js";

/** Check whether cwd is inside a git work tree. Returns false when git is missing. */
export async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
	const result = await execCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	return result.code === 0 && result.stdout.trim() === "true";
}

/** Resolve the .git directory for cwd, or undefined when unavailable. */
async function getGitDir(cwd: string): Promise<string | undefined> {
	const result = await execCommand("git", ["rev-parse", "--git-dir"], cwd);
	if (result.code !== 0) return undefined;
	const gitDir = result.stdout.trim();
	if (!gitDir) return undefined;
	return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
}

/**
 * Ensure gitignore-style patterns are present in `.git/info/exclude`.
 * Keeps FAN state (checkpoint files, session files) out of checkpoint commits so
 * `git checkout <commit>` never conflicts with internal bookkeeping.
 */
export async function ensureGitExcludes(cwd: string, patterns: string[]): Promise<void> {
	if (patterns.length === 0) return;
	const gitDir = await getGitDir(cwd);
	if (!gitDir) return;

	const excludeFile = join(gitDir, "info", "exclude");
	let existing = "";
	if (existsSync(excludeFile)) {
		existing = readFileSync(excludeFile, "utf-8");
	}

	const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
	const missing = patterns.filter((pattern) => pattern.length > 0 && !existingLines.has(pattern));
	if (missing.length === 0) return;

	mkdirSync(dirname(excludeFile), { recursive: true });
	const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	writeFileSync(excludeFile, `${existing}${separator}${missing.map((pattern) => `${pattern}\n`).join("")}`, "utf-8");
}

/**
 * Stage all changes and create a commit (even when nothing changed).
 * @returns the commit hash
 * @throws when the commit cannot be created
 */
export async function gitCommitAll(cwd: string, message: string): Promise<string> {
	const add = await execCommand("git", ["add", "-A"], cwd);
	if (add.code !== 0) {
		throw new Error(`git add failed: ${add.stderr.trim()}`);
	}
	const commit = await execCommand("git", ["commit", "--allow-empty", "-m", message], cwd);
	if (commit.code !== 0) {
		throw new Error(`git commit failed: ${commit.stderr.trim()}`);
	}
	const rev = await execCommand("git", ["rev-parse", "HEAD"], cwd);
	if (rev.code !== 0) {
		throw new Error(`git rev-parse HEAD failed: ${rev.stderr.trim()}`);
	}
	return rev.stdout.trim();
}

/**
 * Check out the given commit (detached HEAD).
 * Never forces: with conflicting local changes git refuses and the error is surfaced.
 * @throws when the checkout fails
 */
export async function gitCheckoutCommit(cwd: string, commit: string): Promise<void> {
	const result = await execCommand("git", ["checkout", commit], cwd);
	if (result.code !== 0) {
		throw new Error(`git checkout ${commit} failed: ${result.stderr.trim()}`);
	}
}
