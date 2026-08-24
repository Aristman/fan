// F-F: Verify-subtree — агрегационная верификация поддерева.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-F
// Спека:    docs/features/super-orchestrator-v2/architecture.md §7 verification
//
// Контракт:
//   verifySubtree({ reports, expected, costBudget, roleProfile? }) → VerificationResult
//     — синхронная функция (НЕ Promise — обязательно перед report);
//     — 4 проверки: completeness, budget, quality (только strict), interface consistency;
//     — дополнительно: orphan-reports detection в батче;
//     — issues[] содержит структурированные объекты { severity, kind, ...details };
//     — summary.verified = true ⇔ нет issues с severity === "error".
//
// Quality check включается ТОЛЬКО при roleProfile.verification_approach === "strict"
// (для lenient/standard — quality_score игнорируется, см. §7.2 спеки).
// Interface check: declaredEndpoints собираются из ВСЕХ reports.payload.interfaces,
// затем для каждого report проверяются его input.depends_on[] на наличие в наборе.
//
// Quality check делегирован pluggable registry в ./quality-checks.ts
// (см. §F-F roadmap: extraction в pluggable модуль per verification_approach).

import { runQualityCheck } from "./quality-checks.js";

export type IssueSeverity = "error" | "warning";
export type IssueKind =
	| "no_reports"
	| "budget_exceeded"
	| "quality_below_threshold"
	| "broken_interface_ref"
	| "orphan_report_in_batch"
	| "incomplete";

export interface Issue {
	severity: IssueSeverity;
	kind: IssueKind;
	[key: string]: unknown;
}

export interface NodeReport {
	correlationId: string;
	costUsd: number;
	payload: {
		interfaces?: Record<string, unknown>;
		input?: { depends_on?: string[] };
		quality_score?: number;
		orphanReportId?: string;
		[key: string]: unknown;
	};
}

export interface RoleProfileForVerify {
	id: string;
	verification_approach?: "lenient" | "standard" | "strict";
	verification_threshold?: number;
}

export interface VerifySubtreeOpts {
	reports: NodeReport[];
	expected: number;
	costBudget: number;
	roleProfile?: RoleProfileForVerify;
}

export interface VerificationResult {
	issues: Issue[];
	summary: {
		verified: boolean;
		total: number;
		expected: number;
		totalCost: number;
	};
}

/** Главная функция верификации поддерева. Синхронная — обязательный контракт. */
export function verifySubtree(opts: VerifySubtreeOpts): VerificationResult {
	const issues: Issue[] = [];
	const reports = opts.reports ?? [];
	const totalCost = reports.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

	// 1. Completeness check
	if (reports.length === 0) {
		issues.push({ severity: "error", kind: "no_reports" });
	} else if (reports.length < opts.expected) {
		issues.push({
			severity: "error",
			kind: "incomplete",
			missing: opts.expected - reports.length,
			expected: opts.expected,
			total: reports.length,
		});
	}

	// 2. Budget check
	if (totalCost > opts.costBudget) {
		issues.push({
			severity: "error",
			kind: "budget_exceeded",
			actual: totalCost,
			budget: opts.costBudget,
		});
	}

	// 3. Quality check (delegated to pluggable registry, см. quality-checks.ts)
	if (opts.roleProfile) {
		for (const report of reports) {
			const issue = runQualityCheck(report, opts.roleProfile);
			if (issue) issues.push(issue);
		}
	}

	// 4. Interface consistency check
	const declaredEndpoints = new Set<string>();
	for (const report of reports) {
		const interfaces = report.payload?.interfaces ?? {};
		for (const endpoint of Object.keys(interfaces)) {
			declaredEndpoints.add(endpoint);
		}
	}

	for (const report of reports) {
		const depends = report.payload?.input?.depends_on ?? [];
		for (const endpoint of depends) {
			if (!declaredEndpoints.has(endpoint)) {
				issues.push({
					severity: "warning",
					kind: "broken_interface_ref",
					endpoint,
					referenced_by: report.correlationId,
				});
			}
		}
	}

	// 5. Orphan-reports detection in batch
	for (const report of reports) {
		if (report.payload?.orphanReportId) {
			issues.push({
				severity: "warning",
				kind: "orphan_report_in_batch",
				reportId: report.correlationId,
				orphanReportId: report.payload.orphanReportId,
			});
		}
	}

	// Summary
	const hasErrors = issues.some((i) => i.severity === "error");
	const verified = !hasErrors;

	return {
		issues,
		summary: {
			verified,
			total: reports.length,
			expected: opts.expected,
			totalCost,
		},
	};
}
