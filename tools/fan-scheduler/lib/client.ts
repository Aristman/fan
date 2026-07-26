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

/** Single message in a session (mirrors gateway SessionMessage). */
export interface FanSessionMessage {
	id: string;
	role: "user" | "assistant" | "tool";
	content: string;
	model?: string;
	tokens?: number;
	cost?: number;
	createdAt: string;
}

/** Response of GET /api/sessions/:id (mirrors gateway GetSessionResponse). */
export interface FanSessionDetail {
	id: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
	messages: FanSessionMessage[];
	sessionFile?: string;
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
 * and the budget monitor (F-4.9). Mirrors the gateway's project-scoped
 * GET /api/budget?project=<path> response (F-4.9 part A).
 */
export interface BudgetUsage {
	project: string;
	/** Sum of assistant-message tokens across all sessions of the project. */
	used: number;
	/** Stored per-project token cap; null when no limit is configured. */
	limit: number | null;
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
 * - GET  /api/budget?project=<path>         — REAL (F-4.9 part A): project-scoped
 *   branch returns `{ project, used, limit }` where used = sum of assistant-message
 *   tokens across the project's sessions and limit = stored per-project cap.
 * - GET  /api/budget (no project)             — PROVIDER-scoped (unchanged).
 * - PUT  /api/budget { project, tokenLimit }  — REAL (F-4.9 part A): stores the
 *   per-project cap (project-budgets.json in the agent dir).
 * - PUT  /api/budget (no project)             — PROVIDER-scoped: body is
 *   `{ provider?, period: "daily"|"monthly", tokenLimit?, costLimit? }`.
 *
 * Enforcement note (F-4.9): the gateway only stores/serves per-project budgets;
 * it does not block sendMessage on cap exhaustion. The scheduler enforces caps
 * itself via getBudgetUsage polling in the executor (see executor.ts).
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
	 * GET /api/sessions/:id — full session detail including the message list.
	 * Used by the execution pipeline (F-4.4) as the completion-signal source:
	 * the gateway exposes no per-session streaming flag over HTTP (isExecuting()
	 * is WS-internal, /api/health only reports the globally active session), so
	 * the executor polls this endpoint — see executor.ts for the heuristic.
	 */
	async getSession(sessionId: string): Promise<FanSessionDetail> {
		return this.request<FanSessionDetail>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
	}

	/**
	 * GET /api/budget?project=<path> — aggregated token usage for a project.
	 * The gateway (F-4.9 part A) answers `{ project, used, limit }` directly:
	 * `used` = sum of assistant-message tokens across the project's sessions,
	 * `limit` = stored per-project cap (null when unset).
	 */
	async getBudgetUsage(project: string): Promise<BudgetUsage> {
		const resp = await this.request<{ project: string; used: number; limit: number | null }>("GET", "/api/budget", {
			query: { project },
		});
		return { project: resp.project ?? project, used: resp.used ?? 0, limit: resp.limit ?? null };
	}

	/**
	 * PUT /api/budget?project=<path>&limit=<tokens> — set the token cap for a project.
	 * The gateway's project-scoped branch (F-4.9 part A) persists the cap in
	 * project-budgets.json; query params are kept for spec compatibility, the
	 * body is authoritative.
	 */
	async setProjectBudget(project: string, limit: number): Promise<void> {
		await this.request("PUT", "/api/budget", {
			query: { project, limit: String(limit) },
			body: { project, tokenLimit: limit },
		});
	}

	/**
	 * PUT /api/budget?project=<path> — partial budget update for a project.
	 * When the body carries `project`, the gateway routes to the project-scoped
	 * branch (F-4.9 part A); `period` is only meaningful for provider budgets.
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
