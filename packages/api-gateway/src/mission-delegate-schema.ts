// @fan/api-gateway — Mission Delegate payload schema (F-3 extract)
//
// Extracted from http-server.ts (Phase 2 — F-3 refactor) to make payload
// validation independently testable and reusable from spawners (F-4) that
// need to validate the same shape before issuing an HTTP delegation.
//
// Shape mirrors the SPEC §F-3 payload: `parentReportId` and `packages` are
// required; everything else is optional metadata propagated to the spawned
// super-orchestrator (F-5). The validator only enforces the *required* fields
// — it does not deep-validate `packages[]` entries (that's the spawned SO's
// job in circuit initialization, see F-5).

/**
 * Shape of a valid /api/mission-delegate payload (post-validation).
 * `parentReportId` ties the delegation to the parent's upstream report;
 * `packages` carries the work units the spawned SO will dispatch.
 */
export interface MissionDelegatePayload {
	/** Required: parent's upstream report id this delegation belongs to. */
	parentReportId: string;
	/** Optional: parent correlation id for cross-process tracing. */
	parentCorrelationId?: string;
	/** Optional: explicit role label (e.g. "super-orchestrator", "worker"). */
	role?: string;
	/** Optional: named role profile to load (default_extensions + exclusions). */
	role_profile?: string;
	/** Optional: depth in the recursive spawn chain (root = 1). */
	depth?: number;
	/** Required: work packages to dispatch to the spawned SO. */
	packages: unknown[];
	/** Optional: lineage trail of parent node ids (for tree-journal). */
	lineage?: unknown[];
}

/** Discriminated union returned by the validator.
 *  - `ok: true`  → validated payload, ready to emit / persist.
 *  - `ok: false` → first failing required field name (e.g. "parentReportId"). */
export type MissionDelegateValidationResult =
	| { ok: true; payload: MissionDelegatePayload }
	| { ok: false; field: string };

/**
 * Validate mission-delegate payload. Returns the typed payload on success,
 * or `{ ok: false, field }` identifying the first invalid required field.
 *
 * Semantics preserved from the pre-extract inline implementation:
 *   - rejects non-object bodies (including arrays) with `field: "body"`
 *   - rejects missing/empty `parentReportId` with `field: "parentReportId"`
 *   - rejects non-array `packages` with `field: "packages"`
 *   - does NOT deep-validate `packages[]` entries (intentional)
 *   - does NOT reject unknown extra fields (forward-compat with F-4 metadata)
 */
export function validateMissionDelegatePayload(body: unknown): MissionDelegateValidationResult {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, field: "body" };
	}
	const obj = body as Record<string, unknown>;
	if (typeof obj.parentReportId !== "string" || obj.parentReportId.length === 0) {
		return { ok: false, field: "parentReportId" };
	}
	if (!Array.isArray(obj.packages)) {
		return { ok: false, field: "packages" };
	}
	return { ok: true, payload: obj as unknown as MissionDelegatePayload };
}
