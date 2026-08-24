// F-F: Quality checks — pluggable registry.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-F
// Спека:    docs/features/super-orchestrator-v2/architecture.md §7.2 verification_approach
//
// Контракт:
//   registerQualityCheck(approach, check) → void   // регистрирует check для подхода
//   runQualityCheck(report, profile) → Issue|null  // запускает check по profile.verification_approach
//
// Подходы (verification_approach):
//   strict    → проверяем quality_score vs threshold (default 0.5)
//   standard  → no-op (baseline, качество не валидируется)
//   lenient   → no-op (минимальные гарантии)
//
// Quality checks выполняются ТОЛЬКО при наличии roleProfile
// (для случаев без roleProfile — quality_score игнорируется полностью).

import type { Issue, NodeReport, RoleProfileForVerify } from "./verify-subtree.js";

export type VerificationApproach = "lenient" | "standard" | "strict";

export type QualityCheckFn = (report: NodeReport, profile: RoleProfileForVerify) => Issue | null;

/**
 * Registry of quality checks keyed by `verification_approach`.
 * Module-private — external code must go through `registerQualityCheck` /
 * `runQualityCheck` so we keep insertion order and ability to inspect at runtime.
 */
const QUALITY_CHECKS: Record<string, QualityCheckFn> = {};

/** Register (or override) a quality check for a given verification approach. */
export function registerQualityCheck(approach: VerificationApproach, check: QualityCheckFn): void {
	QUALITY_CHECKS[approach] = check;
}

/** Default `strict` check: warn when quality_score < verification_threshold. */
registerQualityCheck("strict", (report, profile) => {
	const score = report.payload?.quality_score;
	const threshold = profile.verification_threshold ?? 0.5;
	if (typeof score === "number" && score < threshold) {
		return {
			severity: "warning",
			kind: "quality_below_threshold",
			score,
			threshold,
			reportId: report.correlationId,
		};
	}
	return null;
});

/** Default `standard` check: no-op (quality not validated). */
registerQualityCheck("standard", () => null);

/** Default `lenient` check: no-op (minimal guarantees). */
registerQualityCheck("lenient", () => null);

/**
 * Run the quality check registered for `profile.verification_approach`.
 * Returns `null` if no check is registered for the approach
 * (e.g. unknown approach or default empty entry).
 */
export function runQualityCheck(report: NodeReport, profile: RoleProfileForVerify): Issue | null {
	const approach: string = profile.verification_approach ?? "standard";
	const check = QUALITY_CHECKS[approach];
	if (!check) return null;
	return check(report, profile);
}

/**
 * Test-only helper: list registered approaches.
 * Used by unit tests to assert that defaults are present.
 * Not part of the public API — do not rely on it from production code.
 */
export function _listRegisteredApproaches(): string[] {
	return Object.keys(QUALITY_CHECKS);
}
