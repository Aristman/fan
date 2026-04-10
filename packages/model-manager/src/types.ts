/** Task type for routing decisions — re-exported from orchestrator types */
export type TaskType = "coding" | "quick" | "analysis" | "chat";

/** A resolved model route */
export interface ModelRoute {
	provider: string;
	model: string;
	temperature?: number;
	maxTokens?: number;
	thinking?: string;
}

/** Named routing preset */
export interface RoutingPreset {
	name: TaskType;
	route: ModelRoute;
	fallback?: ModelRoute;
}

/** Budget status for a provider */
export interface BudgetStatus {
	provider: string;
	period: string;
	tokensUsed: number;
	costUsed: number;
	tokenLimit?: number;
	costLimit?: number;
	exceeded: boolean;
}

/** Budget configuration */
export interface BudgetConfig {
	provider?: string;
	period: "daily" | "monthly";
	tokenLimit?: number;
	costLimit?: number;
}

/** DB-backed routing rule data */
export interface RoutingRuleData {
	id: string;
	name: string;
	provider: string;
	model: string;
	fallback?: string;
	enabled: boolean;
}

/** DB-backed model setting data */
export interface ModelSettingData {
	id: string;
	provider: string;
	model: string;
	temperature?: number | null;
	maxTokens?: number | null;
	thinking?: string | null;
	isDefault: boolean;
	priority: number;
}

/** Budget alert fired when thresholds are crossed */
export interface BudgetAlert {
	provider: string;
	period: string;
	type: "warning" | "critical" | "exceeded";
	message: string;
	tokensUsed: number;
	tokensLimit?: number;
	costUsed: number;
	costLimit?: number;
}

/** Handler for budget alerts */
export type BudgetAlertHandler = (alert: BudgetAlert) => void;

/** Configuration for fallback retry behavior */
export interface FallbackConfig {
	/** Maximum number of fallback attempts (default: 1 = try primary + 1 fallback) */
	maxRetries: number;
	/** Error patterns that trigger fallback (string matching in error messages) */
	retryableErrors: string[];
	/** Base delay in ms before first retry (default: 1000) */
	baseDelayMs: number;
	/** Maximum delay in ms (default: 30000) */
	maxDelayMs: number;
	/** Exponential backoff multiplier (default: 2) */
	backoffFactor: number;
}

/** Result of a fallback execution */
export interface FallbackResult<T = unknown> {
	/** Which route ultimately succeeded */
	route: ModelRoute;
	/** How many routes were tried */
	attempts: number;
	/** The result from the successful execution */
	result: T;
}

/** Error thrown when all fallback routes are exhausted */
export class FallbackError extends Error {
	public readonly attemptedRoutes: ModelRoute[];
	public readonly errors: Array<{ route: ModelRoute; error: unknown }>;

	constructor(attemptedRoutes: ModelRoute[], errors: Array<{ route: ModelRoute; error: unknown }>) {
		const messages = errors.map((e, i) => `  [${i}] ${e.route.provider}/${e.route.model}: ${e.error instanceof Error ? e.error.message : String(e.error)}`);
		super(`All fallback routes exhausted:\n${messages.join("\n")}`);
		this.name = "FallbackError";
		this.attemptedRoutes = attemptedRoutes;
		this.errors = errors;
	}
}

/** Options for FallbackChain */
export interface FallbackChainOptions {
	config?: Partial<FallbackConfig>;
}

/** Options for BudgetTracker */
export interface BudgetTrackerOptions {
	/** Custom DB adapter functions */
	db?: {
		getBudget: (provider: string | null, period: string) => Promise<any>;
		getAllBudgets: () => Promise<any[]>;
		updateBudgetUsage: (id: string, tokens: number, cost: number) => Promise<any>;
		upsertBudgetConfig: (data: { provider?: string; period: string; tokenLimit?: number | null; costLimit?: number | null }) => Promise<any>;
		resetBudget: (id: string) => Promise<any>;
	};
	/** Alert handler called when thresholds are crossed */
	onAlert?: BudgetAlertHandler;
	/** Thresholds for alerts (as fractions of limit) */
	thresholds?: {
		warning: number;   // default: 0.8
		critical: number;  // default: 0.95
		exceeded: number;  // default: 1.0
	};
}

/** Options for ProviderRouter */
export interface ProviderRouterOptions {
	/** Custom DB adapter functions (for testing or custom backends) */
	db?: {
		getRoutingRules: () => Promise<RoutingRuleData[]>;
		upsertRoutingRule: (data: Omit<RoutingRuleData, "id">) => Promise<RoutingRuleData>;
		deleteRoutingRule: (name: string) => Promise<void>;
		toggleRoutingRule: (name: string, enabled: boolean) => Promise<void>;
		getModelSetting: (provider: string, model: string) => Promise<ModelSettingData | null>;
		getAllModelSettings: () => Promise<ModelSettingData[]>;
	};
	/** Initial custom presets (merged on top of DEFAULT_PRESETS) */
	presets?: RoutingPreset[];
}
