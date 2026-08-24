// git-adapter — production shell-wrapper over child_process.exec implementing
// the MissionGit interface (see mission-loop.ts). Default exec is injectable
// via opts.exec for testability (see test/git-adapter.test.mjs).

import { exec as execShell } from "node:child_process";
import type { MissionGit } from "./mission-loop.js";

export type GitExec = (
	command: string,
	options: { cwd: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// Default exec: promise-wrapper over node:child_process.exec with shell: true
// (Windows-compatible). Never throws on non-zero exit — returns exitCode.
const defaultExec: GitExec = (command, options) =>
	new Promise((resolve) => {
		execShell(command, { cwd: options.cwd, shell: true }, (error, stdout, stderr) => {
			const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ stdout, stderr, exitCode });
		});
	});

/** Escape backslashes/double-quotes/shell metacharacters so message survives
 *  a \"-quoted argument even when exec runs with `shell: true`.
 *
 *  Escaped chars: `\`, `"`, `$`, `` ` ``.
 *  These are exactly the chars with special meaning inside POSIX double quotes
 *  (POSIX §2.2.3: backslash only special before $, `, ", \, newline).
 *
 *  `!` is NOT escaped: it is not POSIX-special in DQ, and `\!` would insert
 *  a literal backslash into the message (bash history expansion is off in
 *  non-interactive shells spawned by child_process.exec). */
function quoteMessage(message: string): string {
	return message.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

/** Extract short-hash from `git commit` stdout.
 *  Handles both `[<branch> <hash>]` and `[<branch> (root-commit) <hash>]`. */
function parseCommitHash(stdout: string): string {
	return /\[.*\b([0-9a-f]{7,})\]/.exec(stdout)?.[1] ?? "";
}

export function createGitAdapter(opts?: { exec?: GitExec }): MissionGit {
	const exec = opts?.exec ?? defaultExec;

	return {
		async commit({ cwd, message, files }) {
			const add = await exec(`git add ${files.join(" ")}`, { cwd });
			if (add.exitCode !== 0) {
				throw new Error(`git add failed: ${add.stderr}`);
			}
			const commit = await exec(`git commit -m "${quoteMessage(message)}"`, { cwd });
			if (commit.exitCode !== 0) {
				throw new Error(`git commit failed: ${commit.stderr}`);
			}
			return { hash: parseCommitHash(commit.stdout) };
		},

		async log({ cwd, maxCount }) {
			const limit = maxCount !== undefined ? ` -n ${maxCount}` : "";
			const result = await exec(`git log --pretty=format:"%h|%s|%ci"${limit}`, { cwd });
			if (result.exitCode !== 0) {
				return [];
			}
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => {
					const first = line.indexOf("|");
					const last = line.lastIndexOf("|");
					return {
						hash: line.slice(0, first),
						subject: line.slice(first + 1, last),
						date: line.slice(last + 1),
					};
				});
		},

		async status({ cwd }) {
			const result = await exec("git status --porcelain", { cwd });
			return { clean: result.exitCode === 0 && result.stdout.trim() === "" };
		},
	};
}
