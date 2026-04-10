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
