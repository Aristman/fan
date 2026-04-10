import type { BudgetStatus } from "./types.js";

/**
 * BudgetTracker — tracks token usage and cost per provider.
 *
 * Skeleton implementation: no-op tracking.
 * Phase 2 will persist to DB, enforce limits, and auto-reset periods.
 */
export class BudgetTracker {
	track(_provider: string, _tokens: number, _cost: number): void {
		// TODO Phase 2: Persist usage to DB
	}

	check(_provider: string): BudgetStatus {
		// TODO Phase 2: Query actual usage from DB
		return {
			provider: _provider,
			period: "daily",
			tokensUsed: 0,
			costUsed: 0,
			exceeded: false,
		};
	}

	reset(_provider: string): void {
		// TODO Phase 2: Reset usage counters for the current period
	}
}
