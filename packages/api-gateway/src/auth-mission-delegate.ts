// @fan/api-gateway — Mission Delegate token verification (F-3 extract)
//
// Extracted from http-server.ts (Phase 2 — F-3 refactor) so that:
//   - token semantics are unit-testable without spinning up the Hono app
//   - other potential call sites (e.g. F-5 spawned SO startup probe) can reuse
//     the same constant-time comparison instead of re-implementing it.
//
// Auth model: the /api/mission-delegate endpoint is a *node-level* API — it
// is NOT protected by the DB-backed `tokenAuth` middleware used by /api/*
// dashboards. Instead, each FAN process shares an env var FAN_NODE_TOKEN
// (see `seedNodeToken` in ./auth.ts); a parent SO authenticates by sending
// `Authorization: Bearer <token>`. This avoids requiring the parent to hold a
// ClientToken row in the local DB just to delegate work to a child node.

import { timingSafeEqual } from "node:crypto";

/** Discriminated union returned by the verifier.
 *  - `ok: true`                              → token matches.
 *  - `ok: false, error: "missing_token"`     → no/wrong-format Authorization header.
 *  - `ok: false, error: "invalid_token"`     → header present but token doesn't match
 *                                              (or server-side env not configured). */
export type MissionDelegateAuthResult = { ok: true } | { ok: false; error: "missing_token" | "invalid_token" };

/**
 * Constant-time verification of FAN_NODE_TOKEN.
 *
 * @param authHeader    Raw `Authorization` header value (e.g. "Bearer xxx") or undefined.
 * @param expectedToken Expected FAN_NODE_TOKEN (typically `process.env.FAN_NODE_TOKEN`).
 *
 * Semantics preserved from the pre-extract inline `verifyNodeToken`:
 *   - Missing/non-string `authHeader` OR no `Bearer ` prefix → `missing_token`
 *   - Missing/empty `expectedToken`                         → `invalid_token`
 *   - Provided token empty after the "Bearer " slice         → `invalid_token`
 *   - Buffer length mismatch                                → `invalid_token`
 *     (never invokes `timingSafeEqual` on different-length buffers — that
 *     function throws RangeError, and even if it didn't, comparing length
 *     would leak the expected length via timing)
 *   - Equal-length buffers + `timingSafeEqual` match         → `ok`
 *   - Otherwise                                              → `invalid_token`
 *
 * Never throws; safe to call directly from request handlers.
 */
export function verifyNodeToken(
	authHeader: string | undefined,
	expectedToken: string | undefined,
): MissionDelegateAuthResult {
	// Missing or malformed Authorization header → client did not provide a token.
	if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
		return { ok: false, error: "missing_token" };
	}
	const provided = authHeader.slice("Bearer ".length);

	// Server-side env not configured OR provided token is empty after slice.
	// Both collapse to `invalid_token` in the original implementation.
	if (!expectedToken || typeof expectedToken !== "string" || expectedToken.length === 0 || provided.length === 0) {
		return { ok: false, error: "invalid_token" };
	}

	const providedBuf = Buffer.from(provided, "utf8");
	const expectedBuf = Buffer.from(expectedToken, "utf8");
	// Length differs → reject without invoking timingSafeEqual (which would throw).
	if (providedBuf.length !== expectedBuf.length) {
		return { ok: false, error: "invalid_token" };
	}
	return timingSafeEqual(providedBuf, expectedBuf) ? { ok: true } : { ok: false, error: "invalid_token" };
}
