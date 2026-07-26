// @fan/dashboard/api — FAN REST API client
import type {
	ApiError,
	CreateProjectRequest,
	CreateProjectResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	DeleteSessionResponse,
	GenerateTokenResponse,
	GetBudgetResponse,
	GetModelSettingsResponse,
	GetModelsResponse,
	GetSessionResponse,
	HealthResponse,
	ListProjectsResponse,
	ListSessionsResponse,
	ListTokensResponse,
	RevokeTokenResponse,
	SendMessageResponse,
	UpdateBudgetRequest,
	UpdateBudgetResponse,
	UpdateModelSettingsRequest,
	UpdateModelSettingsResponse,
} from "@fan/api-gateway/types";

// ---------------------------------------------------------------------------
// FanApiError — thrown on non-2xx responses
// ---------------------------------------------------------------------------

/**
 * Options for session endpoints that accept an optional project filter (F-2.8).
 * `project` is the absolute workspace path; it is sent as `?project=<encoded>`.
 */
export interface ProjectOptions {
	/** Absolute project/workspace path to scope the request to (sent as ?project=). */
	project?: string;
}

/** Alias kept for roadmap naming (F-2.8). */
export type ListSessionsOptions = ProjectOptions;

/**
 * Pure URL builder: appends `?project=<encoded>` via URLSearchParams when set.
 * Without a project the path is returned unchanged (backward compatible).
 */
export function buildSessionUrl(path: string, project?: string): string {
	if (project === undefined) return path;
	const params = new URLSearchParams();
	params.set("project", project);
	return `${path}?${params.toString()}`;
}

export class FanApiError extends Error {
	/** HTTP status code */
	readonly status: number;
	/** Machine-readable error code from the server (e.g. "UNAUTHORIZED") */
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "FanApiError";
		this.status = status;
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// FanApiClient — wraps every REST endpoint
// ---------------------------------------------------------------------------

export class FanApiClient {
	private readonly baseUrl: string;
	private token?: string;

	constructor(opts: { baseUrl: string; token?: string }) {
		// Ensure trailing slash is removed so path joining is clean
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		// Strip any non-ASCII characters that may have been pasted from terminals
		this.token = opts.token?.replace(/[^\x20-\x7E]/g, "") ?? "";
	}

	/** Update the bearer token (e.g. after generating a new one). */
	setToken(token: string | undefined): void {
		this.token = token?.replace(/[^\x20-\x7E]/g, "") ?? "";
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private headers(authenticated: boolean): HeadersInit {
		const h: HeadersInit = { Accept: "application/json" };
		if (authenticated && this.token) {
			h.Authorization = `Bearer ${this.token}`;
		}
		return h;
	}

	private async _request<T>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const isWrite = method === "POST" || method === "PUT" || method === "PATCH";
		const jsonBody = body !== undefined ? body : isWrite ? {} : undefined;

		const h: Record<string, string> = {
			...this.headers(authenticated),
		} as Record<string, string>;

		if (isWrite) {
			h["Content-Type"] = "application/json";
		}

		const init: RequestInit = {
			method,
			headers: h,
			body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
		};

		const res = await fetch(url, init);

		if (!res.ok) {
			let code = "UNKNOWN";
			let message = res.statusText;

			try {
				const errBody = (await res.json()) as ApiError;
				code = errBody.code ?? code;
				message = errBody.error ?? message;
			} catch {
				// response body wasn't valid JSON — use defaults
			}

			if (res.status === 401) {
				window.dispatchEvent(new CustomEvent("fan:auth-error"));
			}

			throw new FanApiError(res.status, code, message);
		}

		// 204 No Content — nothing to parse
		if (res.status === 204) {
			return undefined as T;
		}

		return res.json() as Promise<T>;
	}

	// -----------------------------------------------------------------------
	// Health
	// -----------------------------------------------------------------------

	health(): Promise<HealthResponse> {
		return this._request<HealthResponse>("GET", "/api/health", undefined, false);
	}

	// -----------------------------------------------------------------------
	// Sessions
	// -----------------------------------------------------------------------

	listSessions(options?: ListSessionsOptions): Promise<ListSessionsResponse> {
		return this._request<ListSessionsResponse>("GET", buildSessionUrl("/api/sessions", options?.project));
	}

	getSession(id: string, options?: ProjectOptions): Promise<GetSessionResponse> {
		return this._request<GetSessionResponse>("GET", buildSessionUrl(`/api/sessions/${id}`, options?.project));
	}

	createSession(opts?: CreateSessionRequest): Promise<CreateSessionResponse> {
		return this._request<CreateSessionResponse>("POST", "/api/sessions", opts);
	}

	deleteSession(id: string, options?: ProjectOptions): Promise<DeleteSessionResponse> {
		return this._request<DeleteSessionResponse>("DELETE", buildSessionUrl(`/api/sessions/${id}`, options?.project));
	}

	// -----------------------------------------------------------------------
	// Projects (F-1.5)
	// -----------------------------------------------------------------------

	listProjects(): Promise<ListProjectsResponse> {
		return this._request<ListProjectsResponse>("GET", "/api/projects");
	}

	/**
	 * Create a project workspace, optionally from a template (F-3.5).
	 * Server contract: POST /api/projects { name, template?, rootPath? } →
	 * 201 (created) / 200 (already registered, idempotent) with the project
	 * metadata; 400 (bad name / unknown template), 403 (path outside the
	 * allowed-roots whitelist).
	 */
	createProject(data: CreateProjectRequest): Promise<CreateProjectResponse> {
		return this._request<CreateProjectResponse>("POST", "/api/projects", data);
	}

	/**
	 * Remove a project from the registry (F-2.13).
	 * Server contract: DELETE /api/projects?path=<encoded> → 204 (no body).
	 * Registry-only: sessions and files on disk are not touched.
	 */
	removeProject(path: string): Promise<void> {
		const params = new URLSearchParams();
		params.set("path", path);
		return this._request<void>("DELETE", `/api/projects?${params.toString()}`);
	}

	// -----------------------------------------------------------------------
	// Messages
	// -----------------------------------------------------------------------

	sendMessage(
		sessionId: string,
		message: string,
		streamingBehavior?: "steer" | "followUp",
	): Promise<SendMessageResponse> {
		return this._request<SendMessageResponse>("POST", `/api/sessions/${sessionId}/messages`, {
			message,
			streamingBehavior,
		});
	}

	// -----------------------------------------------------------------------
	// Models
	// -----------------------------------------------------------------------

	getModels(): Promise<GetModelsResponse> {
		return this._request<GetModelsResponse>("GET", "/api/models");
	}

	getModelSettings(): Promise<GetModelSettingsResponse> {
		return this._request<GetModelSettingsResponse>("GET", "/api/models/settings");
	}

	updateModelSetting(data: UpdateModelSettingsRequest): Promise<UpdateModelSettingsResponse> {
		return this._request<UpdateModelSettingsResponse>("PUT", "/api/models/settings", data);
	}

	// -----------------------------------------------------------------------
	// Budget
	// -----------------------------------------------------------------------

	getBudget(): Promise<GetBudgetResponse> {
		return this._request<GetBudgetResponse>("GET", "/api/budget");
	}

	updateBudget(data: UpdateBudgetRequest): Promise<UpdateBudgetResponse> {
		return this._request<UpdateBudgetResponse>("PUT", "/api/budget", data);
	}

	// -----------------------------------------------------------------------
	// Client Tokens
	// -----------------------------------------------------------------------

	generateToken(name: string): Promise<GenerateTokenResponse> {
		return this._request<GenerateTokenResponse>("POST", "/api/tokens", { name });
	}

	listTokens(): Promise<ListTokensResponse> {
		return this._request<ListTokensResponse>("GET", "/api/tokens");
	}

	revokeToken(id: string): Promise<RevokeTokenResponse> {
		return this._request<RevokeTokenResponse>("DELETE", `/api/tokens/${id}`);
	}
}
