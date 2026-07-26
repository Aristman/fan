export interface FanApiClientOptions {
	baseUrl?: string;
	token?: string;
}

/** Session summary as returned by GET /api/sessions (mirrors gateway SessionSummary). */
export interface FanSessionSummary {
	id: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	sessionFile?: string;
	cwd?: string;
}

/** Response of POST /api/sessions (mirrors gateway CreateSessionResponse). */
export interface CreateSessionResult {
	id: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
	cwd?: string;
}

/** Single provider budget entry as returned by GET /api/budget (mirrors model-manager BudgetStatus). */
export interface FanBudgetStatus {
	provider: string;
	period: string;
	tokensUsed: number;
	costUsed: number;
	tokenLimit?: number;
	costLimit?: number;
	exceeded: boolean;
}

/**
 * Aggregated budget usage for a project, consumed by the execution pipeline (F-4.4)
 * and the budget monitor (F-4.9) as `{ used, limit }`.
 */
export interface BudgetUsage {
	project: string;
	/** Sum of tokensUsed across all provider budgets. */
	used: number;
	/** Sum of defined tokenLimits across providers; null when no limit is configured. */
	limit: number | null;
	/** Raw per-provider budget entries returned by the gateway. */
	budgets: FanBudgetStatus[];
}

/** Partial budget update accepted by updateBudget(). */
export interface BudgetUpdate {
	period?: "daily" | "monthly";
	tokenLimit?: number;
	costLimit?: number;
}

/** Error thrown for non-2xx responses from the FAN API Gateway. */
export class FanApiError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = "FanApiError";
		this.status = status;
		this.code = code;
	}
}

/**
 * FAN API Gateway HTTP client (F-4.2).
 *
 * Base URL comes from FAN_API_URL (default http://localhost:3456),
 * auth token from FAN_API_TOKEN (sent as `Authorization: Bearer <token>`).
 *
 * Endpoint reality check (packages/api-gateway/src/http-server.ts, docs/guides/api-reference.md):
 * - POST /api/sessions { cwd }                — REAL, matches spec.
 * - GET  /api/sessions?project=<path>         — REAL, matches spec.
 * - POST /api/sessions/:id/messages { message } — REAL (REST bypass, never queued);
 *   note the body field is `message`, not `content`.
 * - GET  /api/budget                          — REAL but PROVIDER-scoped: the gateway
 *   accepts NO `project` query param and returns per-provider budgets only.
 * - PUT  /api/budget                          — REAL but PROVIDER-scoped: body is
 *   `{ provider?, period: "daily"|"monthly", tokenLimit?, costLimit? }`; there is
 *   no `project` field and `period` is REQUIRED by the real endpoint.
 *
 * TODO(F-4.9 blocker): per-project budget endpoints do not exist in the gateway.
 * getBudgetUsage/setProjectBudget/updateBudget send `project` (and `limit`) as query
 * params per the roadmap spec, but the current gateway ignores them. The gateway must
 * be extended (e.g. project-scoped budget registry) before F-4.9 can enforce
 * per-project caps against a live server.
 */
export class FanApiClient {
	readonly baseUrl: string;
	protected readonly token?: string;

	constructor(options: FanApiClientOptions = {}) {
		const envUrl = process.env.FAN_API_URL;
		const baseUrl = options.baseUrl ?? (envUrl && envUrl.trim().length > 0 ? envUrl : "http://localhost:3456");
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = options.token ?? process.env.FAN_API_TOKEN;
	}

	/** GET /api/sessions — optionally filtered by project path. */
	async getSessionList(project?: string): Promise<FanSessionSummary[]> {
		const query = project ? { project } : undefined;
		const resp = await this.request<{ sessions: FanSessionSummary[] }>("GET", "/api/sessions", { query });
		return resp.sessions;
	}

	/** POST /api/sessions { cwd } — returns the created session object. */
	async createSession(cwd: string): Promise<CreateSessionResult> {
		return this.request<CreateSessionResult>("POST", "/api/sessions", { body: { cwd } });
	}

	/** POST /api/sessions/:id/messages { message } — dispatches a message to the session. */
	async sendMessage(sessionId: string, content: string): Promise<void> {
		await this.request<{ success: true }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
			body: { message: content },
		});
	}

	/**
	 * GET /api/budget?project=<path> — aggregated token usage for a project.
	 * TODO: the real gateway has no per-project scoping; it returns provider-wide
	 * budgets and ignores the `project` param. Aggregation is done client-side.
	 */
	async getBudgetUsage(project: string): Promise<BudgetUsage> {
		const resp = await this.request<{ budgets: FanBudgetStatus[] }>("GET", "/api/budget", {
			query: { project },
		});
		const budgets = resp.budgets ?? [];
		const used = budgets.reduce((sum, b) => sum + b.tokensUsed, 0);
		const limits = budgets.map((b) => b.tokenLimit).filter((l): l is number => typeof l === "number");
		const limit = limits.length > 0 ? limits.reduce((sum, l) => sum + l, 0) : null;
		return { project, used, limit, budgets };
	}

	/**
	 * PUT /api/budget?project=<path>&limit=<tokens> — set the token cap for a project.
	 * TODO: the real gateway is provider-scoped, ignores `project`/`limit` query params
	 * and requires `period` in the body. See class-level note (F-4.9 blocker).
	 */
	async setProjectBudget(project: string, limit: number): Promise<void> {
		await this.request("PUT", "/api/budget", {
			query: { project, limit: String(limit) },
			body: { project, tokenLimit: limit, period: "daily" },
		});
	}

	/**
	 * PUT /api/budget?project=<path> — partial budget update for a project.
	 * TODO: same per-project scoping caveat as setProjectBudget.
	 */
	async updateBudget(project: string, data: BudgetUpdate): Promise<void> {
		await this.request("PUT", "/api/budget", {
			query: { project },
			body: { project, ...data },
		});
	}

	protected get headers(): Record<string, string> {
		return this.token ? { Authorization: `Bearer ${this.token}` } : {};
	}

	private async request<T>(
		method: string,
		path: string,
		options: { query?: Record<string, string>; body?: unknown } = {},
	): Promise<T> {
		if (!this.token || this.token.trim().length === 0) {
			throw new Error(
				"FAN API token is not configured: set the FAN_API_TOKEN environment variable " +
					"or pass `token` to FanApiClientOptions",
			);
		}

		const url = new URL(`${this.baseUrl}${path}`);
		if (options.query) {
			for (const [key, value] of Object.entries(options.query)) {
				url.searchParams.set(key, value);
			}
		}

		const headers: Record<string, string> = { ...this.headers };
		const init: RequestInit = { method, headers };
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(options.body);
		}

		const response = await fetch(url, init);
		if (!response.ok) {
			throw await this.toApiError(response, method, url);
		}
		return (await response.json()) as T;
	}

	private async toApiError(response: Response, method: string, url: URL): Promise<FanApiError> {
		let detail = response.statusText;
		let code: string | undefined;
		try {
			const body = (await response.json()) as { error?: string; code?: string };
			if (body.error) detail = body.error;
			if (body.code) code = body.code;
		} catch {
			// non-JSON error body — keep statusText
		}
		return new FanApiError(
			response.status,
			`FAN API ${method} ${url.pathname} failed with HTTP ${response.status}: ${detail}`,
			code,
		);
	}
}
