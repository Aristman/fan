import { createLogger } from "./logger.js";

const log = createLogger("gh");

/**
 * Bot Identity — GitHub PAT configuration (F-4.6).
 *
 * The scheduler acts on GitHub under a dedicated bot account. The PAT is
 * provided via the GITHUB_TOKEN environment variable (minimum scope: `repo`).
 *
 * Guarantees:
 * - The token is validated exactly once per token value (result is cached);
 *   validation is a single GET https://api.github.com/user request.
 * - The raw token is NEVER logged — only the masked form (first 4 chars + "***").
 * - A missing/invalid token does NOT crash the scheduler: git/PR-dependent
 *   actions are flagged unavailable (gitEnabled=false) and a warning is logged.
 */

export interface GitHubIdentity {
	/** true when a valid PAT is configured — git/PR-dependent actions are available. */
	gitEnabled: boolean;
	/** GitHub login of the bot account (e.g. "fan-bot"), present when gitEnabled. */
	login?: string;
	/** OAuth scopes reported by the x-oauth-scopes response header (classic PATs only). */
	scopes?: string[];
	/** Human-readable reason when gitEnabled=false, or a non-fatal warning otherwise. */
	reason?: string;
}

const GITHUB_USER_URL = "https://api.github.com/user";

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

let cache: { token: string; identity: GitHubIdentity } | null = null;

/**
 * Masks a token for log output: first 4 characters + "***".
 * The full token must never appear in logs.
 */
export function maskedToken(token: string): string {
	if (token.length <= 4) return "***";
	return `${token.slice(0, 4)}***`;
}

/** Clears the cached validation result (used by tests and for re-validation). */
export function resetGitHubIdentityCache(): void {
	cache = null;
}

/**
 * Validates a GitHub PAT via GET https://api.github.com/user.
 * Falls back to the GITHUB_TOKEN env var when `token` is omitted.
 * The result is cached per token value — repeat calls with the same token
 * do not issue another network request.
 */
export async function validateToken(token?: string, fetchFn?: FetchLike): Promise<GitHubIdentity> {
	const resolved = token ?? process.env.GITHUB_TOKEN;
	if (!resolved || resolved.trim().length === 0) {
		return { gitEnabled: false, reason: "GITHUB_TOKEN not configured" };
	}
	if (cache && cache.token === resolved) {
		return cache.identity;
	}

	const doFetch = fetchFn ?? fetch;
	let identity: GitHubIdentity;
	try {
		const response = await doFetch(GITHUB_USER_URL, {
			headers: {
				Authorization: `Bearer ${resolved}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (response.status === 401 || response.status === 403) {
			identity = {
				gitEnabled: false,
				reason: `GITHUB_TOKEN rejected by GitHub API (HTTP ${response.status}) — check that the PAT is valid, not expired, and has the 'repo' scope`,
			};
		} else if (!response.ok) {
			identity = {
				gitEnabled: false,
				reason: `GitHub API returned HTTP ${response.status} during token validation`,
			};
		} else {
			const body = (await response.json()) as { login?: string };
			const scopesHeader = response.headers.get("x-oauth-scopes");
			const scopes = scopesHeader
				? scopesHeader
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				: undefined;
			identity = { gitEnabled: true, login: body.login, scopes };
			if (scopes && !scopes.includes("repo")) {
				identity.reason = "token is missing the minimum 'repo' scope — git push/PR actions may fail";
			}
		}
	} catch (error) {
		identity = {
			gitEnabled: false,
			reason: `GitHub token validation request failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	cache = { token: resolved, identity };
	return identity;
}

/**
 * true when a valid GitHub identity has been validated (gitEnabled).
 * Returns false before validation runs or when the token is missing/invalid.
 */
export function isGitEnabled(): boolean {
	return cache?.identity.gitEnabled ?? false;
}

/**
 * Startup helper: validates GITHUB_TOKEN from the environment, logs the
 * result (masked token only) and returns the identity. Never throws.
 */
export async function validateGitHubIdentity(fetchFn?: FetchLike): Promise<GitHubIdentity> {
	const token = process.env.GITHUB_TOKEN;
	const identity = await validateToken(token, fetchFn);
	if (identity.gitEnabled) {
		log.info(
			"identity_validated",
			`[github] identity validated: login=${identity.login ?? "unknown"} (token ${maskedToken(token ?? "")})`,
			{ login: identity.login ?? "unknown", token: maskedToken(token ?? "") },
		);
		if (identity.reason) {
			log.warn("identity_scope_warning", `[github] ${identity.reason}`);
		}
	} else {
		log.warn(
			"identity_unavailable",
			`[github] git/PR-dependent actions unavailable (gitEnabled=false): ${identity.reason}`,
		);
	}
	return identity;
}
