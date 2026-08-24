/**
 * F-46 Iteration budget (per-iteration token/cost ceiling).
 *
 * Source of truth:
 *  - docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-46
 *
 * Spec summary:
 *   New config fields: iterationBudgetTokens (default 100000), iterationBudgetUsd (default 5.0).
 *   budgetTracker.checkIterationBudget(): { allowed: boolean, remaining: number }
 *   On exceed: I1 drain current iteration + record iteration_budget_exceeded + escalate I2 steer.
 *   Global and iteration budgets are independent limits; whichever fires first wins.
 *
 * Coverage (mapped to TC-F46-* in roadmap.md):
 *  - TC-F46-1: Exceed iteration budget → drain signal, remaining negative
 *  - TC-F46-2: Iteration budget configurable, progressive tracking
 *  - TC-F46-3: Global and iteration budgets are independent limits
 *
 * Additional edge cases:
 *  - iterationBudgetTokens = 0 or undefined → unlimited (no iteration cap)
 *  - Aggregation across multiple API calls within one iteration
 *  - Event/callback fired on iteration budget exceeded
 *  - resetIteration() resets per-iteration counter but not global
 *  - USD-based iteration limit (iterationBudgetUsd)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../budget.js";
import type { BudgetAlert } from "../types.js";

// ---------------------------------------------------------------------------
// Mock DB adapter (same pattern as budget.test.ts)
// ---------------------------------------------------------------------------

function createMockBudgetDb() {
	const budgets: any[] = [];
	let idCounter = 0;

	return {
		getAllBudgets: async () => [...budgets],
		getBudget: async (provider: string | null, period: string) =>
			budgets.find((b) => (b.provider ?? "all") === (provider ?? "all") && b.period === period),
		upsertBudgetConfig: async (data: any) => {
			const key = `${data.provider ?? "all"}/${data.period}`;
			let existing = budgets.find((b) => `${b.provider ?? "all"}/${b.period}` === key);
			if (existing) {
				Object.assign(existing, data);
			} else {
				existing = { id: `budget-${++idCounter}`, tokensUsed: 0, costUsed: 0, resetAt: new Date(), ...data };
				budgets.push(existing);
			}
			return existing;
		},
		updateBudgetUsage: async (id: string, tokens: number, cost: number) => {
			const budget = budgets.find((b) => b.id === id);
			if (budget) {
				budget.tokensUsed = (budget.tokensUsed ?? 0) + tokens;
				budget.costUsed = (budget.costUsed ?? 0) + cost;
			}
			return budget;
		},
		resetBudget: async (id: string) => {
			const budget = budgets.find((b) => b.id === id);
			if (budget) {
				budget.tokensUsed = 0;
				budget.costUsed = 0;
				budget.resetAt = new Date();
			}
		},
		_getBudgets: () => budgets,
	};
}

// ---------------------------------------------------------------------------
// IterationBudgetResult — the API surface we expect (RED: does not exist yet)
// ---------------------------------------------------------------------------

interface IterationBudgetResult {
	allowed: boolean;
	remaining: number;
}

interface IterationBudgetApi {
	/** Track usage for the current iteration (tokens + cost). */
	trackIterationUsage(tokens: number, cost?: number): void;
	/** Check whether the current iteration is within its budget ceiling. */
	checkIterationBudget(): IterationBudgetResult;
	/** Reset the per-iteration counter (called at iteration boundary). */
	resetIteration(): void;
}

function asIterationApi(tracker: BudgetTracker): IterationBudgetApi {
	return tracker as unknown as IterationBudgetApi;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F-46: Iteration budget (budget.ts)", () => {
	let mockDb: ReturnType<typeof createMockBudgetDb>;
	let alertHandler: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockDb = createMockBudgetDb();
		alertHandler = vi.fn();
	});

	// ---- TC-F46-1 ----
	it("TC-F46-1: exceeding iteration budget → allowed=false, remaining negative, drain signal", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			onAlert: alertHandler,
			iterationBudgetTokens: 50_000,
		});
		const api = asIterationApi(tracker);

		// Simulate an iteration that consumed 51000 tokens
		api.trackIterationUsage(51_000);

		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(false);
		expect(result.remaining).toBe(-1000);
	});

	// ---- TC-F46-2 ----
	it("TC-F46-2: iteration budget is configurable; progressive tracking", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetTokens: 10_000,
		});
		const api = asIterationApi(tracker);

		api.trackIterationUsage(9_000);
		const first = api.checkIterationBudget();
		expect(first.allowed).toBe(true);
		expect(first.remaining).toBe(1_000);

		api.trackIterationUsage(2_000);
		const second = api.checkIterationBudget();
		expect(second.allowed).toBe(false);
		expect(second.remaining).toBe(-1_000);
	});

	// ---- TC-F46-3 ----
	it("TC-F46-3: global and iteration budgets are independent; iteration fires first", async () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			onAlert: alertHandler,
			iterationBudgetTokens: 50_000,
		});
		const api = asIterationApi(tracker);

		// Global budget: 100000 tokens, currently used 40000 — not exceeded
		await tracker.configure({ provider: "all", period: "daily", tokenLimit: 100_000 });
		await tracker.track("all", 40_000, 0);

		// Iteration: 51000 tokens — exceeds iteration limit of 50000
		api.trackIterationUsage(51_000);

		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(false);
		// Even though global budget has 60000 remaining, iteration is over
	});

	// ---- Edge: 0 or undefined iterationBudgetTokens → unlimited ----
	it("iterationBudgetTokens = 0 means unlimited (no iteration cap)", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetTokens: 0,
		});
		const api = asIterationApi(tracker);

		api.trackIterationUsage(1_000_000);
		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(Infinity);
	});

	it("iterationBudgetTokens undefined means unlimited", () => {
		// No iterationBudgetTokens option passed → default unlimited
		const tracker = new BudgetTracker({ db: mockDb });
		const api = asIterationApi(tracker);

		api.trackIterationUsage(500_000);
		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(Infinity);
	});

	// ---- Edge: aggregation of multiple API calls in one iteration ----
	it("aggregates usage across multiple API calls within one iteration", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetTokens: 50_000,
		});
		const api = asIterationApi(tracker);

		// Three API calls in one iteration: 20k + 20k + 15k = 55k → exceeded
		api.trackIterationUsage(20_000);
		expect(api.checkIterationBudget().allowed).toBe(true); // 30k remaining

		api.trackIterationUsage(20_000);
		expect(api.checkIterationBudget().allowed).toBe(true); // 10k remaining

		api.trackIterationUsage(15_000);
		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(false); // -5k
		expect(result.remaining).toBe(-5_000);
	});

	// ---- Edge: event/callback on iteration budget exceeded ----
	it("fires alert callback when iteration budget is exceeded", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			onAlert: alertHandler,
			iterationBudgetTokens: 50_000,
		});
		const api = asIterationApi(tracker);

		api.trackIterationUsage(51_000);
		api.checkIterationBudget();

		// Expect at least one alert with type indicating iteration budget exceeded
		expect(alertHandler).toHaveBeenCalled();
		const alert = alertHandler.mock.calls[0][0] as BudgetAlert;
		expect(alert.type).toBe("exceeded");
	});

	// ---- Edge: resetIteration clears per-iteration counter only ----
	it("resetIteration clears per-iteration counter but not global usage", async () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetTokens: 50_000,
		});
		const api = asIterationApi(tracker);

		// Use 40k globally and 45k in current iteration
		await tracker.configure({ provider: "all", period: "daily", tokenLimit: 100_000 });
		await tracker.track("all", 40_000, 0);
		api.trackIterationUsage(45_000);

		expect(api.checkIterationBudget().allowed).toBe(true); // 5k remaining

		// New iteration starts
		api.resetIteration();

		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(50_000); // full iteration budget available

		// Global usage is still 40k (not reset)
		const globalStatus = await tracker.check("all", "daily");
		expect(globalStatus.tokensUsed).toBe(40_000);
	});

	// ---- Edge: USD-based iteration limit ----
	it("iterationBudgetUsd limits cost per iteration", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetUsd: 5.0,
		});
		const api = asIterationApi(tracker);

		api.trackIterationUsage(10_000, 3.0);
		expect(api.checkIterationBudget().allowed).toBe(true);

		api.trackIterationUsage(10_000, 2.5);
		// Total cost = 5.5 > 5.0 → exceeded
		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(false);
	});

	// ---- Edge: both token and USD limits — whichever fires first ----
	it("both iterationBudgetTokens and iterationBudgetUsd: first exceeded wins", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetTokens: 50_000,
			iterationBudgetUsd: 5.0,
		});
		const api = asIterationApi(tracker);

		// Tokens under limit, cost over limit
		api.trackIterationUsage(10_000, 6.0);
		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(false);
	});

	// ---- Edge: NaN / negative / non-finite sanitization ----
	it("non-finite and negative tokens/cost are clamped to 0 (limit stays enforced)", () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			iterationBudgetTokens: 1_000,
		});
		const api = asIterationApi(tracker);

		// NaN would poison the counter: NaN >= limit is always false → the
		// limit would be silently disabled. Negative values would "refund" the
		// budget. Both must clamp to 0.
		api.trackIterationUsage(Number.NaN, Number.NaN);
		api.trackIterationUsage(-50, -0.5);
		api.trackIterationUsage(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);

		const usage = tracker.getIterationUsage();
		expect(usage.tokensUsed).toBe(0);
		expect(usage.costUsed).toBe(0);

		const result = api.checkIterationBudget();
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(1_000); // full limit, not NaN/Infinity

		// The limit is still enforced after the sanitized calls.
		api.trackIterationUsage(1_500);
		expect(api.checkIterationBudget().allowed).toBe(false);
	});
});
