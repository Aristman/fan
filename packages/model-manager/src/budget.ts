import * as db from "./db.js";
import type { BudgetAlert, BudgetAlertHandler, BudgetConfig, BudgetStatus, BudgetTrackerOptions } from "./types.js";

const DEFAULT_THRESHOLDS = {
	warning: 0.8,
	critical: 0.95,
	exceeded: 1.0,
};

export class BudgetTracker {
	private dbAdapter: BudgetTrackerOptions["db"];
	private alertHandler?: BudgetAlertHandler;
	private thresholds: { warning: number; critical: number; exceeded: number };
	private loaded = false;
	private budgetCache: Map<string, any> = new Map();

	constructor(options?: BudgetTrackerOptions) {
		this.dbAdapter = options?.db;
		this.alertHandler = options?.onAlert;
		this.thresholds = {
			warning: options?.thresholds?.warning ?? DEFAULT_THRESHOLDS.warning,
			critical: options?.thresholds?.critical ?? DEFAULT_THRESHOLDS.critical,
			exceeded: options?.thresholds?.exceeded ?? DEFAULT_THRESHOLDS.exceeded,
		};
	}

	/** Load budget data from DB */
	private async load(): Promise<void> {
		try {
			let budgets;
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

	/** Set alert handler */
	onAlert(handler: BudgetAlertHandler): () => void {
		this.alertHandler = handler;
		return () => {
			if (this.alertHandler === handler) this.alertHandler = undefined;
		};
	}
}
