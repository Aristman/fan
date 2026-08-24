import { BudgetTracker } from "./budget.js";
import * as db from "./db.js";
import { FallbackChain } from "./fallback.js";
import { ProviderRouter } from "./router.js";
import type {
	BudgetAlert,
	BudgetAlertHandler,
	BudgetConfig,
	BudgetStatus,
	BudgetTrackerOptions,
	FallbackChainOptions,
	FallbackResult,
	IterationBudgetCheckResult,
	ModelRoute,
	ModelSettingData,
	ProviderRouterOptions,
	RoutingRuleData,
	TaskType,
} from "./types.js";

/** Options for constructing ModelManager */
export interface ModelManagerOptions {
	/** Custom router options */
	router?: ProviderRouterOptions;
	/** Custom budget tracker options */
	budget?: BudgetTrackerOptions;
	/** Custom fallback chain options */
	fallback?: FallbackChainOptions;
	/** Initial budget alert handler */
	onAlert?: BudgetAlertHandler;
}

/** Resolved task route pair */
export interface ResolvedTaskRoute {
	primary: ModelRoute;
	fallback: ModelRoute | null;
	settings: Partial<ModelSettingData> | null;
}

export class ModelManager {
	private router: ProviderRouter;
	private fallback: FallbackChain;
	private budget: BudgetTracker;

	constructor(options: ModelManagerOptions = {}) {
		this.router = new ProviderRouter(options.router);
		this.fallback = new FallbackChain(options.fallback);
		this.budget = new BudgetTracker({
			...options.budget,
			onAlert: options.onAlert,
		});
	}

	// --- Task Resolution ---

	/**
	 * Resolve model route for a task type.
	 * Returns primary route, fallback route, and any per-model settings.
	 * Budget check: if exceeded for the primary provider, automatically uses fallback.
	 */
	async resolveForTask(taskType: TaskType | string): Promise<ResolvedTaskRoute> {
		const { route, settings } = await this.router.resolveWithSettings(taskType);
		const fallback = await this.router.getFallback(taskType);

		// Budget check: if exceeded, try to use fallback
		const budgetExceeded = await this.budget.isExceeded(route.provider, "daily");
		if (budgetExceeded && fallback) {
			return { primary: fallback, fallback: null, settings };
		}

		return { primary: route, fallback, settings };
	}

	/**
	 * Execute a streaming request with full fallback + budget tracking.
	 *
	 * Usage:
	 *   const result = await modelManager.executeWithFallback("coding", async (route) => {
	 *     return streamSimple({ ...options, model: route.model, provider: route.provider });
	 *   });
	 */
	async executeWithFallback<T>(
		taskType: TaskType | string,
		fn: (route: ModelRoute) => Promise<T>,
	): Promise<FallbackResult<T>> {
		const { primary, fallback } = await this.resolveForTask(taskType);
		const fallbackRoutes = fallback ? [fallback] : [];
		return this.fallback.execute(primary, fallbackRoutes, fn);
	}

	/**
	 * Execute with explicit routes (no router resolution).
	 * Useful when caller already knows the route but wants fallback + budget.
	 */
	async executeWithRoute<T>(
		primaryRoute: ModelRoute,
		fallbackRoutes: ModelRoute[],
		fn: (route: ModelRoute) => Promise<T>,
	): Promise<FallbackResult<T>> {
		return this.fallback.execute(primaryRoute, fallbackRoutes, fn);
	}

	// --- Budget-Aware Auto-Switch ---

	/**
	 * Check if budget is exceeded for a provider and suggest a cheaper alternative.
	 * Returns null if no switch needed, or a ModelRoute for the fallback.
	 */
	async shouldAutoSwitch(currentProvider: string): Promise<ModelRoute | null> {
		const exceeded = await this.budget.isExceeded(currentProvider, "daily");
		if (!exceeded) return null;

		// Return the fallback for "coding" task as a cheaper alternative
		// In a full implementation, this would use ModelRegistry to find the cheapest available model
		const fallback = await this.router.getFallback("coding");
		if (fallback && fallback.provider !== currentProvider) {
			return fallback;
		}

		return null;
	}

	// --- Usage Tracking ---

	/**
	 * Track usage from an LLM response message.
	 * Extracts tokens and cost, updates budget.
	 */
	async trackUsage(
		provider: string,
		tokens: number,
		cost: number,
		period: string = "daily",
	): Promise<{ status: BudgetStatus; alert?: BudgetAlert }> {
		return this.budget.track(provider, tokens, cost, period);
	}

	// --- Budget Management ---

	/** Get cached budget status synchronously (from cache only, no DB round-trip). */
	getCachedBudgetStatus(provider: string, period: string = "daily"): BudgetStatus | undefined {
		return this.budget.getCachedStatus(provider, period);
	}

	async getBudgetStatus(provider?: string, period: string = "daily"): Promise<BudgetStatus | BudgetStatus[]> {
		if (provider) {
			return this.budget.check(provider, period);
		}
		return this.budget.checkAll();
	}

	async configureBudget(config: BudgetConfig): Promise<void> {
		return this.budget.configure(config);
	}

	async resetBudget(provider: string, period: string = "daily"): Promise<void> {
		return this.budget.reset(provider, period);
	}

	async isBudgetExceeded(provider: string, period: string = "daily"): Promise<boolean> {
		return this.budget.isExceeded(provider, period);
	}

	// --- F-46: Per-Iteration Budget ---

	/**
	 * F-46: Track usage for the current iteration (synchronous, in-memory).
	 * Independent from the global DB-backed budgets.
	 */
	trackIterationUsage(tokens: number, cost = 0): void {
		this.budget.trackIterationUsage(tokens, cost);
	}

	/** F-46: Check the per-iteration ceiling. `{ allowed, remaining }`. */
	checkIterationBudget(): IterationBudgetCheckResult {
		return this.budget.checkIterationBudget();
	}

	/** F-46: Reset per-iteration counters (iteration boundary). Global usage untouched. */
	resetIteration(): void {
		this.budget.resetIteration();
	}

	/** F-46: Snapshot of current per-iteration usage and limits (0 = unlimited). */
	getIterationUsage(): { tokensUsed: number; costUsed: number; tokenLimit: number; usdLimit: number } {
		return this.budget.getIterationUsage();
	}

	// --- Routing Management ---

	async getRoutingRules(): Promise<RoutingRuleData[]> {
		// Force load if not loaded yet — use bracket to access private member
		try {
			// biome-ignore lint/complexity/useLiteralKeys: accessing private member
			await this.router["ensureLoaded"]();
		} catch {
			/* ignore */
		}
		return this.router.getRules();
	}

	async addRoutingRule(rule: Omit<RoutingRuleData, "id">): Promise<void> {
		return this.router.addRule(rule);
	}

	async removeRoutingRule(name: string): Promise<void> {
		return this.router.removeRule(name);
	}

	async enableRoutingRule(name: string): Promise<void> {
		return this.router.enableRule(name);
	}

	async disableRoutingRule(name: string): Promise<void> {
		return this.router.disableRule(name);
	}

	// --- Model Settings Management ---

	getModelSetting(provider: string, model: string): ModelSettingData | null {
		return this.router.getSetting(provider, model);
	}

	async getAllModelSettings(): Promise<ModelSettingData[]> {
		try {
			// biome-ignore lint/complexity/useLiteralKeys: accessing private member
			await this.router["ensureLoaded"]();
		} catch {
			/* ignore */
		}
		return this.router.getAllSettings();
	}

	async setModelSetting(data: {
		provider: string;
		model: string;
		temperature?: number | null;
		maxTokens?: number | null;
		thinking?: string | null;
		isDefault?: boolean;
		priority?: number;
	}): Promise<void> {
		await db.upsertModelSetting(data);
		await this.router.rebuild();
	}

	async removeModelSetting(provider: string, model: string): Promise<void> {
		await db.deleteModelSetting(provider, model);
		await this.router.rebuild();
	}

	// --- Per-Model Settings Application ---

	/**
	 * Apply per-model settings to request options.
	 * Merges temperature, maxTokens, thinking from DB settings.
	 * Returns the merged options (original options take precedence for explicitly set values).
	 */
	applySettingsToOptions<T extends Record<string, any>>(modelRoute: ModelRoute, options: T): T {
		const setting = this.router.getSetting(modelRoute.provider, modelRoute.model);
		if (!setting) return options;

		const merged = { ...options };

		// Only apply DB settings if the caller didn't explicitly set them
		if (setting.temperature != null && merged.temperature === undefined) {
			(merged as any).temperature = setting.temperature;
		}
		if (setting.maxTokens != null && merged.maxTokens === undefined) {
			(merged as any).maxTokens = setting.maxTokens;
		}
		if (setting.thinking != null && merged.thinking === undefined) {
			(merged as any).thinking = setting.thinking;
		}

		return merged;
	}

	// --- Event Hooks ---

	/** Subscribe to budget alerts. Returns unsubscribe function. */
	onBudgetAlert(handler: BudgetAlertHandler): () => void {
		return this.budget.onAlert(handler);
	}

	// --- Lifecycle ---

	/** Reload all data from DB */
	async reload(): Promise<void> {
		await Promise.all([this.router.rebuild(), this.budget.reload()]);
	}

	/**
	 * Sync settings from file-based SettingsManager to DB.
	 * Call this on session start to ensure DB is in sync with settings.json.
	 */
	async syncFromSettings(settings: {
		modelSettings?: Record<string, { temperature?: number; maxTokens?: number; thinking?: string }>;
		routingRules?: Array<{ name: string; provider: string; model: string; fallback?: string; enabled?: boolean }>;
		budget?: {
			dailyTokenLimit?: number;
			dailyCostLimit?: number;
			monthlyTokenLimit?: number;
			monthlyCostLimit?: number;
		};
	}): Promise<void> {
		const ops: Promise<void>[] = [];

		// Sync model settings
		if (settings.modelSettings) {
			for (const [key, value] of Object.entries(settings.modelSettings)) {
				const [provider, ...modelParts] = key.split("/");
				const model = modelParts.join("/");
				if (provider && model) {
					ops.push(
						db
							.upsertModelSetting({
								provider,
								model,
								temperature: value.temperature,
								maxTokens: value.maxTokens,
								thinking: value.thinking,
							})
							.then(() => {}),
					);
				}
			}
		}

		// Sync routing rules
		if (settings.routingRules) {
			for (const rule of settings.routingRules) {
				ops.push(db.upsertRoutingRule(rule).then(() => {}));
			}
		}

		// Sync budget
		if (settings.budget) {
			if (settings.budget.dailyTokenLimit !== undefined || settings.budget.dailyCostLimit !== undefined) {
				ops.push(
					db
						.upsertBudgetConfig({
							period: "daily",
							tokenLimit: settings.budget.dailyTokenLimit,
							costLimit: settings.budget.dailyCostLimit,
						})
						.then(() => {}),
				);
			}
			if (settings.budget.monthlyTokenLimit !== undefined || settings.budget.monthlyCostLimit !== undefined) {
				ops.push(
					db
						.upsertBudgetConfig({
							period: "monthly",
							tokenLimit: settings.budget.monthlyTokenLimit,
							costLimit: settings.budget.monthlyCostLimit,
						})
						.then(() => {}),
				);
			}
		}

		await Promise.allSettled(ops);
		await this.reload();
	}

	// --- Direct access to subsystems (for advanced use) ---

	getRouter(): ProviderRouter {
		return this.router;
	}

	getFallbackChain(): FallbackChain {
		return this.fallback;
	}

	getBudgetTracker(): BudgetTracker {
		return this.budget;
	}
}
