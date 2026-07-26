// ============================================================================
// Workspace Whitelist Validation (F-1.13)
// ============================================================================
//
// Security-critical module: validates a requested session cwd against a
// whitelist of allowed workspace roots before the runtime touches the
// filesystem (process.chdir, ResourceLoader, etc.).
//
// Decisions (documented per spec):
//
// - Empty whitelist → BYPASS (local mode). When no allowed roots are
//   configured every path is accepted. This keeps TUI / local single-user
//   setups and the current e2e-local compose stack (no whitelist) working.
//
// - Normalization: `path.resolve` (absolute, `.`/`..` collapsed) plus
//   `fs.realpathSync` for symlink resolution — but ONLY when the path
//   exists. A non-existent path cannot traverse a symlink itself, so it is
//   judged by its lexical resolved path:
//     · non-existent path INSIDE the whitelist → valid
//       (future projects, repos not cloned yet — the directory will be
//       created under an allowed root later);
//     · non-existent path OUTSIDE the whitelist → invalid.
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
 * Validate a requested cwd against the allowed workspace roots.
 *
 * Returns `{ valid: true }` when the whitelist is empty (bypass, local
 * mode) or the canonical path lies within one of the allowed roots.
 * Otherwise `{ valid: false, reason }` where reason is one of:
 *   - "empty path"
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

	const resolved = path.resolve(cwd);

	// Symlink resolution: realpath only when the path exists. A non-existent
	// path is judged lexically — inside the whitelist it stays valid (future
	// projects / not-yet-cloned repos), outside it is rejected.
	let canonical = resolved;
	let usedRealpath = false;
	try {
		if (existsSync(resolved)) {
			canonical = realpathSync(resolved);
			usedRealpath = true;
		}
	} catch {
		// realpath failure (permissions, race with unlink) — lexical fallback
	}

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
	if (usedRealpath && lexicallyInside && normalizeForCompare(canonical) !== normalizeForCompare(resolved)) {
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
			cwd: details.cwd,
			reason: details.reason,
			allowedRoots: details.allowedRoots,
			timestamp: new Date().toISOString(),
		})}`,
	);
}
