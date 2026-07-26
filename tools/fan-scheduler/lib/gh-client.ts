import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isGitEnabled } from "./github-identity.js";
import { createLogger } from "./logger.js";

const log = createLogger("gh");

/**
 * PR creation via the GitHub CLI (F-4.8).
 *
 * After an autonomous task finishes its work on a feature branch
 * (see branch-policy.ts, F-4.7), the scheduler opens a pull request:
 *
 *   1. `git push -u origin <branch>`   — ALWAYS before PR creation (order enforced)
 *   2. `gh pr create --base <base> --head <branch> --title "auto: <taskName>" --body "..."`
 *
 * Guarantees:
 * - Base branch is DETECTED from the remote, not hardcoded: the module runs
 *   `git symbolic-ref --short refs/remotes/origin/HEAD` in the repo (this is
 *   what the remote's default branch points at, e.g. "origin/main" or
 *   "origin/master"). When detection fails (no remote HEAD configured,
 *   bare/unusual remote setup), it falls back to "main".
 * - The git/PR policy gate is honored: when `isGitEnabled()` is false
 *   (missing/invalid GITHUB_TOKEN, F-4.6) the function performs NO external
 *   calls and returns status "partial" with a warning — the task itself is
 *   not failed.
 * - When the `gh` binary is unavailable the result is status "partial" with a
 *   descriptive reason ('gh CLI not found — ensure GitHub CLI installed and
 *   authenticated') instead of a crash; availability is probed up-front via
 *   `gh --version` so nothing is pushed when the CLI is missing.
 * - A failed `git push` is a hard error (thrown): `gh pr create` is never
 *   executed for an unpushed branch.
 * - All process execution goes through an injectable `ExecFn` — tests mock it
 *   and assert exact commands, arguments, cwd and call order without spawning
 *   real processes.
 */

/** Outcome of a single executed command. */
export interface ExecResult {
	stdout: string;
	stderr: string;
}

/**
 * Injectable process runner. Implementations execute `command` with `args`
 * in the given working directory and resolve with captured output; they
 * reject on non-zero exit codes or spawn failures (ENOENT etc.).
 */
export type ExecFn = (command: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;

/** Input for createPullRequest(). */
export interface CreatePullRequestParams {
	/** Filesystem path of the local repository clone (used as cwd for all commands). */
	repo: string;
	/** Feature branch to push and use as the PR head (fan-auto/<id>-<timestamp>). */
	branch: string;
	/** Task name — becomes the PR title "auto: <taskName>". */
	taskName: string;
	/** Optional issue number closed by the PR — appended as "Closes #N" to the body. */
	issueNumber?: number;
}

/**
 * Result of createPullRequest().
 * - "created": PR was opened, `prUrl` is set.
 * - "partial": task work succeeded but no PR was created (git disabled or gh
 *   CLI unavailable); `reason` explains why. NOT a task failure.
 */
export interface PullRequestResult {
	prUrl?: string;
	status: "created" | "partial";
	reason?: string;
}

/** Dependency injection point (tests pass a mock exec / git-enabled gate). */
export interface GhClientDeps {
	exec?: ExecFn;
	/** Override the git-enabled gate (default: isGitEnabled() from F-4.6). */
	gitEnabled?: boolean;
}

/** Base branch used when remote HEAD detection fails. */
export const DEFAULT_BASE_BRANCH = "main";

/** Reason reported when the gh binary is not available. */
export const GH_CLI_NOT_FOUND_REASON = "gh CLI not found — ensure GitHub CLI installed and authenticated";

const execFileAsync = promisify(execFile);

/** Default ExecFn backed by child_process.execFile (compatible with Node and Bun). */
const defaultExec: ExecFn = async (command, args, options) => {
	const { stdout, stderr } = await execFileAsync(command, args, { cwd: options.cwd });
	return { stdout: String(stdout), stderr: String(stderr) };
};

/** true when the error means "binary not found" (spawn ENOENT). */
function isNotFoundError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Detects the remote's default branch via
 * `git symbolic-ref --short refs/remotes/origin/HEAD` (prints e.g.
 * "origin/main"; the "origin/" prefix is stripped). Falls back to
 * DEFAULT_BASE_BRANCH when detection fails or yields nothing.
 */
export async function detectBaseBranch(repo: string, exec: ExecFn): Promise<string> {
	try {
		const { stdout } = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
		const ref = stdout.trim();
		const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
		return branch.length > 0 ? branch : DEFAULT_BASE_BRANCH;
	} catch {
		return DEFAULT_BASE_BRANCH;
	}
}

/**
 * Pushes the feature branch and opens a pull request via the gh CLI.
 *
 * @returns PullRequestResult — never resolves to a "failed" state; soft
 *          degradation is reported as status "partial".
 * @throws  Error when `git push` fails or `gh pr create` fails for a reason
 *          other than a missing gh binary.
 */
export async function createPullRequest(
	params: CreatePullRequestParams,
	deps: GhClientDeps = {},
): Promise<PullRequestResult> {
	const exec = deps.exec ?? defaultExec;
	const gitEnabled = deps.gitEnabled ?? isGitEnabled();

	if (!gitEnabled) {
		const reason = "git/PR actions disabled (gitEnabled=false) — skipping pull request creation";
		log.warn("pr_skipped", `[gh-client] ${reason} (repo=${params.repo}, branch=${params.branch})`, {
			repo: params.repo,
			branch: params.branch,
			reason,
		});
		return { status: "partial", reason };
	}

	// Probe gh availability up-front so nothing is pushed when the CLI is missing.
	try {
		await exec("gh", ["--version"], { cwd: params.repo });
	} catch (error) {
		const reason = isNotFoundError(error)
			? GH_CLI_NOT_FOUND_REASON
			: `gh CLI probe failed: ${error instanceof Error ? error.message : String(error)}`;
		log.warn("pr_skipped", `[gh-client] ${reason} — pull request not created (branch=${params.branch})`, {
			branch: params.branch,
			reason,
		});
		return { status: "partial", reason };
	}

	const base = await detectBaseBranch(params.repo, exec);

	// Order enforced: push ALWAYS happens before gh pr create.
	try {
		await exec("git", ["push", "-u", "origin", params.branch], { cwd: params.repo });
	} catch (error) {
		throw new Error(
			`git push failed for branch "${params.branch}" in ${params.repo}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	const body =
		"Automated fix generated by FAN agent." +
		(params.issueNumber !== undefined ? `\n\nCloses #${params.issueNumber}` : "");

	let stdout: string;
	try {
		({ stdout } = await exec(
			"gh",
			[
				"pr",
				"create",
				"--base",
				base,
				"--head",
				params.branch,
				"--title",
				`auto: ${params.taskName}`,
				"--body",
				body,
			],
			{ cwd: params.repo },
		));
	} catch (error) {
		if (isNotFoundError(error)) {
			log.warn(
				"pr_skipped",
				`[gh-client] ${GH_CLI_NOT_FOUND_REASON} — pull request not created (branch=${params.branch})`,
				{
					branch: params.branch,
					reason: GH_CLI_NOT_FOUND_REASON,
				},
			);
			return { status: "partial", reason: GH_CLI_NOT_FOUND_REASON };
		}
		throw new Error(
			`gh pr create failed for branch "${params.branch}" in ${params.repo}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	// gh prints the PR URL to stdout; extract it defensively.
	const match = stdout.match(/https:\/\/\S+\/pull\/\d+/);
	const prUrl = match ? match[0] : stdout.trim();
	log.info("pr_created", `[gh-client] pull request created: ${prUrl} (base=${base}, head=${params.branch})`, {
		prUrl,
		base,
		branch: params.branch,
	});
	return { prUrl, status: "created" };
}
