/**
 * FAN Orchestrator — PlatformReviewAdapter contract (F-15, code-review worker).
 *
 * Pure TypeScript declarations: 0 runtime, 0 imports. Consumers import types
 * only (`import type { … } from "./review-adapters.js"`). Concrete platform
 * implementations (GitHub, Bitbucket) are separate extensions of later phases
 * — the orchestrator itself stays platform-agnostic (see review-adapters.md →
 * «Extension model»).
 *
 * Roadmap: docs/features/code-review-worker/roadmap.md → «#### ☐ F-15».
 * Documentation: extensions/fan-orchestrator/review-adapters.md
 * (Semantics of errors · Extension model · Precedent).
 */

/**
 * Severity of a single review finding, mirrored 1:1 from the F-9 Finding
 * schema (`findings.js` → SEVERITY_VALUES) so that adapters can post worker
 * findings to the platform without re-mapping.
 *
 * @example
 * const severity: ReviewSeverity = "CRITICAL";
 */
export type ReviewSeverity = "CRITICAL" | "MAJOR" | "MINOR" | "INFO";

/**
 * Final verdict of a code review — the code-review subset of the orchestrator
 * verdict space (agents.d.ts → Verdict): APPROVED | CHANGES_REQUESTED |
 * NEEDS_DISCUSSION.
 *
 * @example
 * const verdict: ReviewVerdict = "CHANGES_REQUESTED";
 */
export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_DISCUSSION";

/**
 * Identifies the platform and repository a review operates on.
 *
 * `id` uses the `string & {}` pattern: the known ids ("github", "bitbucket")
 * get autocomplete in editors, while any other string stays assignable — the
 * TYPE is permissive for extensibility; the IMPLEMENTATION must not guess.
 * An unknown platform id must be explicitly handled by the implementation
 * (logged + gracefully rejected or forwarded) — see review-adapters.md →
 * «Extension model».
 *
 * @example
 * const github: PlatformRef = { id: "github", repo: "owner/repo" };
 * const selfHosted: PlatformRef = {
 *   id: "github-enterprise-self-hosted",
 *   repo: "owner/repo",
 *   baseUrl: "https://ghe.example.com/api/v3",
 * };
 */
export type PlatformRef = {
    /** Known ids autocomplete; unknown ids remain valid (permissive type). */
    id: "github" | "bitbucket" | (string & {});
    /** Repository slug in "owner/repo" form. */
    repo: string;
    /** API base URL for self-hosted instances; omit for the public cloud. */
    baseUrl?: string;
    /** Reference to a stored credential (env name / token id) — never a raw secret. */
    credentialsRef?: string;
};

/**
 * Request for the unified diff a review covers (diff retrieval side of the
 * contract).
 *
 * @example
 * const request: DiffRequest = { base: "main", head: "feature/auth" };
 * const byPr: DiffRequest = { base: "main", pr: 128, maxPatchLines: 4000 };
 */
export type DiffRequest = {
    /** "Old" side of the diff: commit SHA, branch or tag. */
    base: string;
    /** "New" side of the diff; defaults to the PR head when omitted. */
    head?: string;
    /** Pull-request number; when set, the diff is scoped to that PR. */
    pr?: number;
    /** Cap on per-file patch size (lines) to avoid platform truncation. */
    maxPatchLines?: number;
};

/**
 * Unified diff returned by the platform (diff retrieval side of the contract).
 *
 * @example
 * const diff: DiffResult = {
 *   patch: "diff --git a/src/auth.ts b/src/auth.ts\n…",
 *   changedFiles: 3,
 *   additions: 41,
 *   deletions: 7,
 *   baseSha: "0f3e1a2",
 *   headSha: "9b8c7d6",
 * };
 */
export type DiffResult = {
    /** Unified diff text ("diff --git …"), one section per changed file. */
    patch: string;
    /** Number of changed files in the diff. */
    changedFiles: number;
    /** Added lines across all files. */
    additions: number;
    /** Deleted lines across all files. */
    deletions: number;
    /** Resolved SHAs actually diffed — the anchor for comment positions. */
    baseSha: string;
    /** Resolved head SHA (see {@link DiffResult.baseSha}). */
    headSha: string;
    /** true → the platform truncated the diff; fetch narrower per-file diffs. */
    truncated?: boolean;
};

/**
 * A single review comment anchored to a diff position, posted via
 * `postComments` in page-safe batches: every comment targets exactly one
 * file/side/line, so paginated platforms can place it without cross-page
 * lookups. `externalId` makes re-runs idempotent (no duplicate comments).
 *
 * @example
 * const comment: ReviewComment = {
 *   file: "src/auth.ts",
 *   line: 42,
 *   side: "RIGHT",
 *   severity: "MAJOR",
 *   body: "Token hardcoded in source.",
 *   suggestion: "Read it from process.env.AUTH_TOKEN instead.",
 * };
 */
export type ReviewComment = {
    /** File path exactly as it appears in the diff (no ":line" suffix). */
    file: string;
    /** 1-based line in the referenced revision; omit for file-level comments. */
    line?: number;
    /** Diff side the line belongs to; default "RIGHT" (new revision). */
    side?: "LEFT" | "RIGHT";
    /** Finding severity (F-9 Finding schema). */
    severity: ReviewSeverity;
    /** Comment body (markdown). */
    body: string;
    /** Optional suggested fix; rendered as a suggestion block where supported. */
    suggestion?: string;
    /** Stable dedup key: posting the same key twice must not duplicate a comment. */
    externalId?: string;
};

/**
 * Final resolution applied to a pull request by `resolvePr`.
 *
 * @example
 * const resolution: ReviewResolution = {
 *   verdict: "CHANGES_REQUESTED",
 *   summary: "1 CRITICAL / 1 MAJOR finding — see inline comments.",
 * };
 */
export type ReviewResolution = {
    /** Review verdict (code-review subset, see {@link ReviewVerdict}). */
    verdict: ReviewVerdict;
    /** Summary posted together with the resolution (markdown). */
    summary: string;
    /** Display name of the reviewing bot, e.g. "fan-code-review". */
    reviewer?: string;
};

/**
 * Contract every platform implementation satisfies. The orchestrator depends
 * only on this interface — GitHub/Bitbucket/… adapters register as separate
 * extensions (review-adapters.md → «Extension model»).
 *
 * Error semantics (binding, see review-adapters.md → «Semantics of errors»):
 *   - network/transient failures → retry with exponential backoff inside the
 *     adapter; surface an error only after the attempts are exhausted;
 *   - auth failures → throw an explicit auth error immediately (never retry);
 *   - missing repo/PR → throw an explicit not-found (404) error.
 * An unknown `ref.id` must be explicitly handled by the implementation — it
 * must never be silently treated as a known platform.
 */
export interface PlatformReviewAdapter {
    /** Same id space as {@link PlatformRef.id}; e.g. "github". */
    readonly id: PlatformRef["id"];

    /**
     * Fetch the unified diff the review covers (diff retrieval).
     * See review-adapters.md → «Semantics of errors» for retry/auth/404.
     */
    getDiff(ref: PlatformRef, request: DiffRequest): Promise<DiffResult>;

    /**
     * Post review comments to a PR (page-safe anchors: file/side/line).
     * Returns how many comments the platform accepted and the rejected ones.
     */
    postComments(
        ref: PlatformRef,
        pr: number,
        comments: readonly ReviewComment[],
    ): Promise<{ posted: number; failed: readonly ReviewComment[] }>;

    /**
     * Resolve the review on a PR with the final verdict.
     * NEEDS_DISCUSSION must not auto-approve: the implementation rejects or
     * holds such resolutions explicitly instead of resolving as approved.
     */
    resolvePr(ref: PlatformRef, pr: number, resolution: ReviewResolution): Promise<void>;
}
