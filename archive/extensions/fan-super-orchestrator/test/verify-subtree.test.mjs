// F-F: Verify-subtree — RED-фаза TDD.
//
// Модуль ../verify-subtree.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND). После реализации (GREEN)
// тесты должны пройти БЕЗ изменений.
//
// Spec: docs/features/super-orchestrator-v2/architecture.md §7 verification
// Roadmap: docs/features/super-orchestrator-v2/roadmap.md §F-F
//
// Coverage (TC-cards):
//   TC-FF-1  Completeness + budget checks + quality
//     1a  2 valid reports → no issues, verified:true
//     1b  empty reports → no_reports issue
//     1c  total cost > budget → budget_exceeded
//     1d  quality below threshold (strict role)
//   TC-FF-2  Interface consistency check
//     2a  consistent interfaces → no issues
//     2b  report references undefined endpoint → broken_interface_ref
//     2c  orphan-reports detection in batch
//   TC-FF-3  Mandatory invocation pattern
//     3a  verifySubtree returns issues for incomplete subtree
//     3b  verifySubtree is synchronous (mandatory before report)
//
// Expected: all 9 tests FAIL (module not yet implemented).

import { describe, it, expect } from "vitest";

// ─── TC-FF-1: Completeness + budget checks + quality ─────────────────────────

describe("TC-FF-1: Completeness + budget checks + quality", () => {
	it("TC-FF-1a: 2 valid reports → no issues, verified:true", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [
				{ correlationId: "r1", costUsd: 1.5, payload: { interfaces: { "/api/a": {} } } },
				{ correlationId: "r2", costUsd: 2.0, payload: { interfaces: { "/api/b": {} } } },
			],
			expected: 2,
			costBudget: 10.0,
		});
		expect(result.issues).toEqual([]);
		expect(result.summary.verified).toBe(true);
		expect(result.summary.total).toBe(2);
		expect(result.summary.totalCost).toBeCloseTo(3.5);
	});

	it("TC-FF-1b: empty reports → no_reports issue", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [],
			expected: 2,
			costBudget: 10.0,
		});
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "error",
				kind: "no_reports",
			}),
		);
		expect(result.summary.verified).toBe(false);
	});

	it("TC-FF-1c: total cost > budget → budget_exceeded", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [
				{ correlationId: "r1", costUsd: 8.0, payload: {} },
				{ correlationId: "r2", costUsd: 7.0, payload: {} },
			],
			expected: 2,
			costBudget: 10.0,
		});
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "error",
				kind: "budget_exceeded",
				actual: 15.0,
				budget: 10.0,
			}),
		);
	});

	it("TC-FF-1d: quality below threshold (strict role)", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [
				{ correlationId: "r1", costUsd: 1.0, payload: { quality_score: 0.3 } },
			],
			expected: 1,
			costBudget: 10.0,
			roleProfile: {
				id: "qa",
				verification_approach: "strict",
				verification_threshold: 0.5,
			},
		});
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				kind: "quality_below_threshold",
				score: 0.3,
				threshold: 0.5,
			}),
		);
	});
});

// ─── TC-FF-2: Interface consistency check ─────────────────────────────────────

describe("TC-FF-2: Interface consistency check", () => {
	it("TC-FF-2a: consistent interfaces → no issues", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [
				{
					correlationId: "r1",
					costUsd: 1.0,
					payload: {
						interfaces: { "/api/a": {} },
						input: { depends_on: ["/api/a"] },
					},
				},
				{
					correlationId: "r2",
					costUsd: 1.0,
					payload: { input: { depends_on: ["/api/a"] } },
				},
			],
			expected: 2,
			costBudget: 10.0,
		});
		expect(result.issues.filter((i) => i.kind === "broken_interface_ref")).toHaveLength(0);
	});

	it("TC-FF-2b: report references undefined endpoint → broken_interface_ref", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [
				{
					correlationId: "r1",
					costUsd: 1.0,
					payload: { input: { depends_on: ["/api/unknown"] } },
				},
			],
			expected: 1,
			costBudget: 10.0,
		});
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				kind: "broken_interface_ref",
				endpoint: "/api/unknown",
				referenced_by: "r1",
			}),
		);
	});

	it("TC-FF-2c: orphan-reports detection in batch", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		const result = verifySubtree({
			reports: [
				{ correlationId: "r1", costUsd: 1.0, payload: { orphanReportId: "orphan-123" } },
			],
			expected: 1,
			costBudget: 10.0,
		});
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				kind: "orphan_report_in_batch",
			}),
		);
	});
});

// ─── TC-FF-3: Mandatory invocation pattern ───────────────────────────────────

describe("TC-FF-3: Mandatory invocation pattern", () => {
	it("TC-FF-3a: verifySubtree returns issues for incomplete subtree", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		// Super-Orch агрегирует 2 reports, но expected=3 — 1 отсутствует
		const result = verifySubtree({
			reports: [
				{ correlationId: "r1", costUsd: 1.0, payload: {} },
				{ correlationId: "r2", costUsd: 1.0, payload: {} },
			],
			expected: 3,
			costBudget: 10.0,
		});
		expect(result.summary.total).toBe(2);
		expect(result.summary.expected).toBe(3);
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "error",
				kind: "incomplete",
				missing: 1,
			}),
		);
	});

	it("TC-FF-3b: verifySubtree is synchronous (mandatory before report)", async () => {
		const { verifySubtree } = await import("../verify-subtree.js");
		// Не async — возвращает результат сразу
		const result = verifySubtree({
			reports: [{ correlationId: "r1", costUsd: 1.0, payload: {} }],
			expected: 1,
			costBudget: 10.0,
		});
		// Не Promise!
		expect(result).not.toBeInstanceOf(Promise);
		expect(result.issues).toBeDefined();
		expect(result.summary).toBeDefined();
	});
});
