import * as db from "./db.js";
import type {
	BudgetAlert,
	BudgetAlertHandler,
	BudgetConfig,
	BudgetStatus,
	BudgetTrackerOptions,
	IterationBudgetCheckResult,
} from "./types.js";

const DEFAULT_THRESHOLDS = {
	warning: 0.8,
	critical: 0.95,
	exceeded: 1.0,
};

/**
 * F-46 roadmap defaults for the per-iteration budget.
 *
 * BudgetTracker itself treats `0`/`undefined` as unlimited (see red-test
 * contract in __tests__/budget-iteration.test.ts); integration layers
 * (coding-agent SDK) apply these defaults when constructing the tracker.
 */
export const DEFAULT_ITERATION_BUDGET_TOKENS = 100_000;
export const DEFAULT_ITERATION_BUDGET_USD = 5.0;

export class BudgetTracker {
	private dbAdapter: BudgetTrackerOptions["db"];
	private alertHandler?: BudgetAlertHandler;
	private thresholds: { warning: number; critical: number; exceeded: number };
	private loaded = false;
	private budgetCache: Map<string, any> = new Map();

	// F-46: per-iteration budget state (in-memory only, independent from the
	// DB-backed global budgets). `0` = unlimited.
	private iterationTokenLimit: number;
	private iterationUsdLimit: number;
	private iterationTokensUsed = 0;
	private iterationCostUsed = 0;
	/** Dedupe: the "exceeded" alert fires once per exceeded episode (until resetIteration). */
	private iterationExceededAlerted = false;

	constructor(options?: BudgetTrackerOptions) {
		this.dbAdapter = options?.db;
		this.alertHandler = options?.onAlert;
		this.thresholds = {
			warning: options?.thresholds?.warning ?? DEFAULT_THRESHOLDS.warning,
			critical: options?.thresholds?.critical ?? DEFAULT_THRESHOLDS.critical,
			exceeded: options?.thresholds?.exceeded ?? DEFAULT_THRESHOLDS.exceeded,
		};
		this.iterationTokenLimit = options?.iterationBudgetTokens ?? 0;
		this.iterationUsdLimit = options?.iterationBudgetUsd ?? 0;
	}

	/** Load budget data from DB */
	private async load(): Promise<void> {
		try {
			let budgets: any[];
			if (this.dbAdapter) {
				budgets = await this.dbAdapter.getAllBudgets();
			} else {
				budgets = await db.getAllBudgets();
			}
			this.budgetCache.clear();
			for (const b of budgets) {
				this.budgetCache.set(`${b.provider ?? "all"}/${b.period}`, b);
			}
			this.loaded = true;
		} catch {
			this.budgetCache.clear();
			this.loaded = true;
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) await this.load();
	}

	private cacheKey(provider: string, period: string): string {
		return `${provider}/${period}`;
	}

	/** Track token usage and cost for a provider. Returns budget status + optional alert. */
	async track(
		provider: string,
		tokens: number,
		cost: number,
		period: string = "daily",
	): Promise<{ status: BudgetStatus; alert?: BudgetAlert }> {
		await this.ensureLoaded();
		await this.autoResetCheck(provider, period);

		const key = this.cacheKey(provider, period);
		let budget = this.budgetCache.get(key);

		// Create budget entry if it doesn't exist
		if (!budget) {
			const data = { provider, period };
			if (this.dbAdapter) {
				budget = await this.dbAdapter.upsertBudgetConfig(data);
			} else {
				budget = await db.upsertBudgetConfig(data);
			}
			this.budgetCache.set(key, budget);
		}

		// Update usage in DB
		if (budget.id) {
			try {
				if (this.dbAdapter) {
					budget = await this.dbAdapter.updateBudgetUsage(budget.id, tokens, cost);
				} else {
					budget = await db.updateBudgetUsage(budget.id, tokens, cost);
				}
				this.budgetCache.set(key, budget);
			} catch {
				// Update locally if DB fails
				budget = {
					...budget,
					tokensUsed: (budget.tokensUsed ?? 0) + tokens,
					costUsed: (budget.costUsed ?? 0) + cost,
				};
				this.budgetCache.set(key, budget);
			}
		}

		const status = this.toStatus(budget, provider, period);
		const alert = this.checkThresholds(budget, provider, period);
		return { status, alert: alert ?? undefined };
	}

	/** Check budget status for a specific provider and period (sync, from cache only) */
	getCachedStatus(provider: string, period: string = "daily"): BudgetStatus | undefined {
		const key = this.cacheKey(provider, period);
		const budget = this.budgetCache.get(key);
		if (!budget) return undefined;
		return this.toStatus(budget, provider, period);
	}

	/** Check budget status for a specific provider and period */
	async check(provider: string, period: string = "daily"): Promise<BudgetStatus> {
		await this.ensureLoaded();
		await this.autoResetCheck(provider, period);

		const key = this.cacheKey(provider, period);
		const budget = this.budgetCache.get(key);
		if (!budget) {
			return {
				provider,
				period,
				tokensUsed: 0,
				costUsed: 0,
				exceeded: false,
			};
		}
		return this.toStatus(budget, provider, period);
	}

	/** Check all budget statuses */
	async checkAll(): Promise<BudgetStatus[]> {
		await this.ensureLoaded();
		const statuses: BudgetStatus[] = [];
		for (const [key, budget] of this.budgetCache) {
			const [provider, period] = key.split("/");
			statuses.push(this.toStatus(budget, provider, period));
		}
		return statuses;
	}

	/** Reset budget counters for a provider/period */
	async reset(provider: string, period: string = "daily"): Promise<void> {
		await this.ensureLoaded();
		const key = this.cacheKey(provider, period);
		const budget = this.budgetCache.get(key);
		if (budget?.id) {
			try {
				if (this.dbAdapter) {
					await this.dbAdapter.resetBudget(budget.id);
				} else {
					await db.resetBudget(budget.id);
				}
			} catch {
				/* ignore */
			}
		}
		await this.load(); // refresh cache
	}

	/** Configure budget limits */
	async configure(config: BudgetConfig): Promise<void> {
		await this.ensureLoaded();
		const provider = config.provider ?? "all";
		try {
			if (this.dbAdapter) {
				await this.dbAdapter.upsertBudgetConfig({
					provider: provider === "all" ? undefined : provider,
					period: config.period,
					tokenLimit: config.tokenLimit,
					costLimit: config.costLimit,
				});
			} else {
				await db.upsertBudgetConfig({
					provider: provider === "all" ? undefined : provider,
					period: config.period,
					tokenLimit: config.tokenLimit,
					costLimit: config.costLimit,
				});
			}
		} catch {
			/* ignore */
		}
		await this.load();
	}

	/** Check if budget is exceeded for a provider */
	async isExceeded(provider: string, period: string = "daily"): Promise<boolean> {
		const status = await this.check(provider, period);
		return status.exceeded;
	}

	/** Auto-reset check: if resetAt has passed for the period, reset counters */
	private async autoResetCheck(provider: string, period: string): Promise<void> {
		const key = this.cacheKey(provider, period);
		const budget = this.budgetCache.get(key);
		if (!budget?.resetAt) return;

		const now = new Date();
		const resetAt = new Date(budget.resetAt);

		let shouldReset = false;
		if (period === "daily") {
			// Reset if we've passed midnight of the resetAt date
			const nextReset = new Date(resetAt);
			nextReset.setDate(nextReset.getDate() + 1);
			nextReset.setHours(0, 0, 0, 0);
			shouldReset = now >= nextReset;
		} else if (period === "monthly") {
			// Reset if we've passed the 1st of next month
			const nextReset = new Date(resetAt.getFullYear(), resetAt.getMonth() + 1, 1);
			shouldReset = now >= nextReset;
		}

		if (shouldReset) {
			await this.reset(provider, period);
		}
	}

	/** Convert DB budget record to BudgetStatus */
	private toStatus(budget: any, provider: string, period: string): BudgetStatus {
		const tokensLimit = budget.tokenLimit ?? undefined;
		const costLimit = budget.costLimit ?? undefined;
		const tokensUsed = budget.tokensUsed ?? 0;
		const costUsed = budget.costUsed ?? 0;

		const exceeded =
			(tokensLimit !== undefined && tokensLimit > 0 && tokensUsed >= tokensLimit) ||
			(costLimit !== undefined && costLimit > 0 && costUsed >= costLimit);

		return {
			provider,
			period,
			tokensUsed,
			costUsed,
			tokenLimit: tokensLimit,
			costLimit,
			exceeded,
		};
	}

	/** Check if thresholds are crossed, fire alert if handler is set */
	private checkThresholds(budget: any, provider: string, period: string): BudgetAlert | null {
		const tokensUsed = budget.tokensUsed ?? 0;
		const costUsed = budget.costUsed ?? 0;
		const tokensLimit = budget.tokenLimit;
		const costLimit = budget.costLimit;

		if (!tokensLimit && !costLimit) return null;
		if (!this.alertHandler) return null;

		// Calculate usage ratios
		const tokenRatio = tokensLimit && tokensLimit > 0 ? tokensUsed / tokensLimit : 0;
		const costRatio = costLimit && costLimit > 0 ? costUsed / costLimit : 0;
		const maxRatio = Math.max(tokenRatio, costRatio);

		if (maxRatio >= this.thresholds.exceeded) {
			const alert: BudgetAlert = {
				provider,
				period,
				type: "exceeded",
				message: `Budget exceeded for ${provider} (${period}): $${costUsed.toFixed(2)} / $${(costLimit ?? 0).toFixed(2)}, ${tokensUsed} tokens`,
				tokensUsed,
				tokensLimit,
				costUsed,
				costLimit,
			};
			this.alertHandler(alert);
			return alert;
		}

		if (maxRatio >= this.thresholds.critical) {
			const alert: BudgetAlert = {
				provider,
				period,
				type: "critical",
				message: `Budget critical for ${provider} (${period}): $${costUsed.toFixed(2)} / $${(costLimit ?? 0).toFixed(2)} (${(maxRatio * 100).toFixed(0)}%)`,
				tokensUsed,
				tokensLimit,
				costUsed,
				costLimit,
			};
			this.alertHandler(alert);
			return alert;
		}

		if (maxRatio >= this.thresholds.warning) {
			const alert: BudgetAlert = {
				provider,
				period,
				type: "warning",
				message: `Budget warning for ${provider} (${period}): $${costUsed.toFixed(2)} / $${(costLimit ?? 0).toFixed(2)} (${(maxRatio * 100).toFixed(0)}%)`,
				tokensUsed,
				tokensLimit,
				costUsed,
				costLimit,
			};
			this.alertHandler(alert);
			return alert;
		}

		return null;
	}

	/** Reload budget data from DB */
	async reload(): Promise<void> {
		this.loaded = false;
		await this.load();
	}

	// --- F-46: per-iteration budget -----------------------------------------

	/**
	 * F-46: Track usage for the current iteration (synchronous, in-memory only).
	 *
	 * Aggregates every API call that belongs to the current iteration until
	 * {@link resetIteration} is called at the iteration boundary. Does NOT
	 * touch the DB-backed global budgets — global and iteration budgets are
	 * independent limits; whichever fires first wins.
	 */
	trackIterationUsage(tokens: number, cost = 0): void {
		// Sanitize: non-finite or negative values are clamped to 0 so a bad
		// caller cannot poison the counters with NaN (which would silently
		// disable the limit: NaN >= limit is always false).
		const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
		const safeCost = Number.isFinite(cost) && cost > 0 ? cost : 0;
		this.iterationTokensUsed += safeTokens;
		this.iterationCostUsed += safeCost;
	}

	/**
	 * F-46: Check whether the current iteration is within its budget ceiling.
	 *
	 * Both ceilings are checked; the first exceeded one wins (`allowed=false`).
	 * `remaining` reports the tightest enabled limit (Infinity when unlimited).
	 * On the first check that observes an exceedance, fires an `exceeded`
	 * BudgetAlert (deduped until {@link resetIteration}).
	 */
	checkIterationBudget(): IterationBudgetCheckResult {
		const tokenLimit = this.iterationTokenLimit;
		const usdLimit = this.iterationUsdLimit;

		const tokenRemaining = tokenLimit > 0 ? tokenLimit - this.iterationTokensUsed : Number.POSITIVE_INFINITY;
		const usdRemaining = usdLimit > 0 ? usdLimit - this.iterationCostUsed : Number.POSITIVE_INFINITY;
		const remaining = Math.min(tokenRemaining, usdRemaining);

		const tokensExceeded = tokenLimit > 0 && this.iterationTokensUsed >= tokenLimit;
		const usdExceeded = usdLimit > 0 && this.iterationCostUsed >= usdLimit;
		const allowed = !tokensExceeded && !usdExceeded;

		if (!allowed && !this.iterationExceededAlerted && this.alertHandler) {
			this.iterationExceededAlerted = true;
			const alert: BudgetAlert = {
				provider: "iteration",
				period: "iteration",
				type: "exceeded",
				message: `Iteration budget exceeded: ${this.iterationTokensUsed} / ${tokenLimit || "∞"} tokens, $${this.iterationCostUsed.toFixed(2)} / $${usdLimit ? usdLimit.toFixed(2) : "∞"}`,
				tokensUsed: this.iterationTokensUsed,
				tokensLimit: tokenLimit > 0 ? tokenLimit : undefined,
				costUsed: this.iterationCostUsed,
				costLimit: usdLimit > 0 ? usdLimit : undefined,
			};
			this.alertHandler(alert);
		}

		return { allowed, remaining };
	}

	/**
	 * F-46: Reset the per-iteration counters (called at the iteration boundary).
	 * Does NOT reset global (DB-backed) budget usage.
	 */
	resetIteration(): void {
		this.iterationTokensUsed = 0;
		this.iterationCostUsed = 0;
		this.iterationExceededAlerted = false;
	}

	/** F-46: Snapshot of the current per-iteration usage and configured limits (0 = unlimited). */
	getIterationUsage(): { tokensUsed: number; costUsed: number; tokenLimit: number; usdLimit: number } {
		return {
			tokensUsed: this.iterationTokensUsed,
			costUsed: this.iterationCostUsed,
			tokenLimit: this.iterationTokenLimit,
			usdLimit: this.iterationUsdLimit,
		};
	}

	/** Set alert handler */
	onAlert(handler: BudgetAlertHandler): () => void {
		this.alertHandler = handler;
		return () => {
			if (this.alertHandler === handler) this.alertHandler = undefined;
		};
	}
}
