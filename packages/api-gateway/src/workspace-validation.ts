// ============================================================================
// Workspace Whitelist Validation (F-1.13)
// ============================================================================
//
// Security-critical module: validates a requested session cwd against a
// whitelist of allowed workspace roots before the runtime touches the
// filesystem (ResourceLoader, tool path resolution, etc. — the runtime no
// longer calls process.chdir since F-5.4).
//
// Decisions (documented per spec):
//
// - Empty whitelist → BYPASS (local mode). When no allowed roots are
//   configured every path is accepted. This keeps TUI / local single-user
//   setups and the current e2e-local compose stack (no whitelist) working.
//
// - Canonicalization: `path.resolve` (absolute, `.`/`..` collapsed) plus
//   `fs.realpathSync` on the longest existing prefix. Non-existent trailing
//   segments are kept as-is, but any symlink in an intermediate component
//   is followed. This closes the partial-symlink bypass where a path whose
//   leaf does not exist was previously judged only by its lexical form.
//     · canonical path INSIDE the whitelist → valid (future projects,
//       repos not cloned yet — the directory will be created under an
//       allowed root later);
//     · canonical path OUTSIDE the whitelist → invalid.
//
// - Boundary safety: comparison is segment-based — a candidate must equal
//   the root or start with `root + path.sep`. Plain `startsWith` would
//   wrongly accept `/data/repos2` for root `/data/repos`.
//
// - Case sensitivity follows the platform: Windows (win32) compares
//   case-folded (case-insensitive filesystem), POSIX compares as-is.
//
// - Allowed roots are canonicalized the same way (realpath when they
//   exist) so a root that lives under a symlink (e.g. macOS /var →
//   /private/var) still matches realpath-resolved candidates.
//
// - Rejections are written to the audit log via `console.warn` with a
//   structured JSON field — this flows into the F-0.10 file logger
//   (/data/logs/app.log in container deployments). No separate audit file.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export interface CwdValidationResult {
	valid: boolean;
	/** Machine-readable rejection reason (only present when valid === false). */
	reason?: string;
}

/** Windows filesystems are case-insensitive — compare case-folded there. */
const CASE_INSENSITIVE = process.platform === "win32";

/** Max characters of a rejected cwd written to the audit log (F-1.13 hardening). */
const MAX_AUDIT_CWD_LENGTH = 500;

/**
 * Characters that are never valid in a filesystem path passed through the API.
 * Null bytes and C0 control characters cannot be used in paths on any platform.
 */
const INVALID_PATH_CHARS = /[\x00-\x1f]/;

function containsInvalidPathChars(p: string): boolean {
	return INVALID_PATH_CHARS.test(p);
}

function truncateForAudit(p: string): string {
	if (p.length <= MAX_AUDIT_CWD_LENGTH) return p;
	return `${p.slice(0, MAX_AUDIT_CWD_LENGTH)}...[truncated]`;
}

/**
 * Resolve the workspace whitelist from the environment (F-1.11 source).
 *
 * Follows the phase-0 config pattern (ALLOWED_ORIGINS / FAN_PUBLIC): the
 * gateway reads `FAN_WORKSPACE_ROOT` directly, with the raw env value
 * injectable for tests. An unset, empty, or whitespace-only value yields an
 * EMPTY whitelist → bypass (local mode). Callers that want the full server
 * fallback chain (`FAN_WORKSPACE_ROOT` → `~/projects`) pass the roots
 * explicitly via `ServerOptions.allowedRoots`.
 */
export function resolveAllowedRoots(envValue: string | undefined = process.env.FAN_WORKSPACE_ROOT): string[] {
	const trimmed = envValue?.trim();
	return trimmed ? [trimmed] : [];
}

/** Absolute, normalized, platform-case-folded form for comparison. */
function normalizeForCompare(p: string): string {
	const resolved = path.resolve(p);
	return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/**
 * Segment-boundary containment check: `candidate === root` or
 * `candidate` starts with `root + path.sep`. Protects against the
 * `/data/repos2` vs `/data/repos` prefix collision. Handles filesystem
 * roots that already end with a separator (`/`, `C:\`).
 */
export function isWithinRoot(candidate: string, root: string): boolean {
	const c = normalizeForCompare(candidate);
	const r = normalizeForCompare(root);
	if (c === r) return true;
	const prefix = r.endsWith(path.sep) ? r : r + path.sep;
	return c.startsWith(prefix);
}

/** Canonical form of an allowed root: realpath when it exists, else lexical. */
function canonicalizeRoot(root: string): string {
	const resolved = path.resolve(root);
	try {
		if (existsSync(resolved)) {
			return realpathSync(resolved);
		}
	} catch {
		// realpath failure (permissions, race) — fall back to the lexical path
	}
	return resolved;
}

/**
 * Canonicalize a path by resolving symlinks on the longest existing prefix.
 *
 * Non-existent trailing segments are kept as-is, but any symlink in an
 * intermediate component is followed. This closes the partial-symlink bypass
 * where `/data/repos/link-out/foo` was accepted because `foo` does not exist
 * and only the lexical path was checked.
 */
function canonicalizePath(p: string): string {
	const resolved = path.resolve(p);
	let prefix = resolved;
	const suffixSegments: string[] = [];

	// Walk upward to the longest existing prefix.
	while (!existsSync(prefix)) {
		const parent = path.dirname(prefix);
		if (parent === prefix) break; // filesystem root not existing — defensive break
		suffixSegments.unshift(path.basename(prefix));
		prefix = parent;
	}

	try {
		prefix = realpathSync(prefix);
	} catch {
		// realpath failure (permissions, race with unlink) — keep lexical prefix
	}

	return suffixSegments.length > 0 ? path.join(prefix, ...suffixSegments) : prefix;
}

/**
 * Validate a requested cwd against the allowed workspace roots.
 *
 * Returns `{ valid: true }` when the whitelist is empty (bypass, local
 * mode) or the canonical path lies within one of the allowed roots.
 * Otherwise `{ valid: false, reason }` where reason is one of:
 *   - "empty path"
 *   - "invalid characters in path"
 *   - "path outside allowed roots"
 *   - "symlink traversal detected" (lexical path inside, realpath outside)
 */
export function validateCwd(cwd: string, allowedRoots: string[]): CwdValidationResult {
	// Empty whitelist → bypass (local mode: TUI, dev, unconfigured compose).
	if (allowedRoots.length === 0) {
		return { valid: true };
	}
	if (cwd.trim().length === 0) {
		return { valid: false, reason: "empty path" };
	}
	if (containsInvalidPathChars(cwd)) {
		return { valid: false, reason: "invalid characters in path" };
	}

	const resolved = path.resolve(cwd);
	const canonical = canonicalizePath(cwd);

	// Roots are canonicalized (realpath) as well, so roots living under a
	// symlink (macOS /var → /private/var, symlinked mounts) still match
	// realpath-resolved candidates.
	const canonicalRoots = allowedRoots.map(canonicalizeRoot);
	if (canonicalRoots.some((root) => isWithinRoot(canonical, root))) {
		return { valid: true };
	}

	// Distinguish a symlink escape from a plain out-of-whitelist path:
	// the lexical path is inside but the real target is outside.
	const lexicallyInside = allowedRoots.some((root) => isWithinRoot(resolved, root));
	if (lexicallyInside) {
		return { valid: false, reason: "symlink traversal detected" };
	}
	return { valid: false, reason: "path outside allowed roots" };
}

/**
 * Audit-log a rejected cwd. Structured JSON on a single line so it can be
 * grepped/parsed in the F-0.10 file log (/data/logs/app.log) and docker logs.
 */
export function logCwdRejection(details: { cwd: string; reason: string; allowedRoots: string[] }): void {
	console.warn(
		`[api-gateway][audit] cwd rejected by workspace whitelist: ${JSON.stringify({
			event: "cwd_rejected",
			cwd: truncateForAudit(details.cwd),
			reason: details.reason,
			allowedRoots: details.allowedRoots,
			timestamp: new Date().toISOString(),
		})}`,
	);
}
