export interface FanApiClientOptions {
	baseUrl?: string;
	token?: string;
}

/**
 * FAN API Gateway client skeleton (F-4.1).
 * Base URL comes from FAN_API_URL (default http://localhost:3456),
 * auth token from FAN_API_TOKEN. Methods land in F-4.2:
 * getSessionList, createSession, sendMessage, getBudgetUsage,
 * setProjectBudget, updateBudget.
 */
export class FanApiClient {
	readonly baseUrl: string;
	protected readonly token?: string;

	constructor(options: FanApiClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? process.env.FAN_API_URL ?? "http://localhost:3456";
		this.token = options.token ?? process.env.FAN_API_TOKEN;
	}

	protected get headers(): Record<string, string> {
		return this.token ? { Authorization: `Bearer ${this.token}` } : {};
	}
}
