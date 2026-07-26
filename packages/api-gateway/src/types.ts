export type { BudgetAlert, BudgetAlertHandler, BudgetConfig, BudgetStatus, ModelSettingData } from "@fan/model-manager";

import type { BudgetConfig, BudgetStatus, ModelSettingData } from "@fan/model-manager";

// ============================================================================
// HTTP REST Request/Response Types
// ============================================================================

/** Standard error response */
export interface ApiError {
	error: string;
	code: string;
}

/** Health check response (F-0.9: readiness fields) */
export interface HealthResponse {
	/** "ok" when all readiness checks pass, "degraded" when any check fails */
	status: "ok" | "degraded";
	version: string;
	uptime: number;
	/** Database (Prisma/SQLite) reachability */
	db: "up" | "down";
	/** Active session info from the SessionAdapter */
	session: {
		active: boolean;
		id: string | null;
	};
}

// --- Sessions ---

export interface CreateSessionRequest {
	title?: string;
	parentSessionId?: string;
	/** F-1.3: optional working directory for the new session. Normalized by the server. */
	cwd?: string;
}

export interface CreateSessionResponse {
	id: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
	/** Working directory of the new session (from JSONL session header) */
	cwd?: string;
}

export interface SessionSummary {
	id: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** Path to JSONL file on disk (for disk-based sessions) */
	sessionFile?: string;
	/**
	 * Working directory of the project the session belongs to (from JSONL session header).
	 * Omitted for legacy sessions whose header has no cwd — never an empty string or null
	 * (F-1.12). Cwd-less sessions never match the ?project= filter.
	 */
	cwd?: string;
}

export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

// --- Projects (F-1.5) ---

/** Registry project entry as provided by the SessionAdapter (source: project-registry in coding-agent) */
export interface ProjectInfo {
	/** Absolute path to the project workspace */
	path: string;
	/** Display name (basename of the path by default) */
	name: string;
	/** Project classification */
	type: string;
}

/** Project entry in the API response, enriched with session count */
export interface ProjectSummary extends ProjectInfo {
	/** Number of sessions whose cwd matches the project path (normalized comparison) */
	sessionCount: number;
	/**
	 * F-2.13: false when the project directory no longer exists on disk.
	 * Unavailable projects are NOT excluded from the list — the user must be
	 * able to see them and remove them from the registry (DELETE /api/projects).
	 */
	available: boolean;
	/** F-2.13: machine-readable error marker, present only when available === false. */
	error?: "PROJECT_NOT_FOUND";
}

export interface ListProjectsResponse {
	projects: ProjectSummary[];
}

// --- Project creation (F-3.5) ---

/** POST /api/projects request body. */
export interface CreateProjectRequest {
	/** Project name — used as the directory name under rootPath. Required. */
	name: string;
	/** Optional workspace template ('code' | 'research' | 'automation'). */
	template?: string;
	/** Optional parent directory. Default: workspace root (FAN_WORKSPACE_ROOT → ~/projects). */
	rootPath?: string;
}

/** POST /api/projects response body — metadata of the created/existing project. */
export interface CreateProjectResponse {
	/** Absolute path of the project workspace. */
	path: string;
	/** Project name (directory basename). */
	name: string;
	/** Workspace type (auto-detected after template application). */
	type: string;
	/** Template that was applied (omitted for template-less creation). */
	template?: string;
}

/** Adapter-level result of project creation (F-3.5): response metadata plus
 *  a flag telling whether a new registry entry was created. The HTTP layer
 *  maps created=true → 201, created=false (duplicate path, idempotent) → 200. */
export interface CreateProjectResult extends CreateProjectResponse {
	/** False when the resolved path was already registered (no re-registration). */
	created: boolean;
}

export interface SessionMessage {
	id: string;
	role: "user" | "assistant" | "tool";
	content: string;
	model?: string;
	tokens?: number;
	cost?: number;
	createdAt: string;
}

export interface GetSessionResponse {
	id: string;
	title: string;
	model?: string;
	provider?: string;
	createdAt: string;
	updatedAt: string;
	messages: SessionMessage[];
	/** Path to JSONL file on disk (for disk-based sessions) */
	sessionFile?: string;
	/**
	 * Working directory of the project the session belongs to (from JSONL session header).
	 * Omitted for legacy sessions whose header has no cwd — never an empty string or null (F-1.12).
	 */
	cwd?: string;
}

export interface DeleteSessionResponse {
	success: boolean;
}

// --- Messages ---

export interface SendMessageRequest {
	message: string;
	streamingBehavior?: "steer" | "followUp";
}

export interface SendMessageResponse {
	success: true;
}

// --- Models ---

export interface ModelInfo {
	provider: string;
	model: string;
	displayName?: string;
}

export interface RoutingRuleInfo {
	id: string;
	name: string;
	provider: string;
	model: string;
	fallback?: string;
	enabled: boolean;
}

export interface GetModelsResponse {
	models: ModelInfo[];
	routingRules: RoutingRuleInfo[];
}

export interface GetModelSettingsResponse {
	settings: ModelSettingData[];
}

export interface UpdateModelSettingsRequest {
	provider: string;
	model: string;
	temperature?: number;
	maxTokens?: number;
	thinking?: string;
}

export interface UpdateModelSettingsResponse {
	setting: ModelSettingData;
}

// --- Budget ---

export interface GetBudgetResponse {
	budgets: BudgetStatus[];
}

export interface UpdateBudgetRequest {
	provider?: string;
	period: "daily" | "monthly";
	tokenLimit?: number;
	costLimit?: number;
}

export interface UpdateBudgetResponse {
	config: BudgetConfig;
}

// --- Client Tokens ---

export interface TokenInfo {
	id: string;
	name: string;
	token: string;
	createdAt: string;
	lastUsed?: string;
}

export interface GenerateTokenResponse {
	token: TokenInfo;
}

export interface ListTokensResponse {
	tokens: Omit<TokenInfo, "token">[];
}

export interface RevokeTokenResponse {
	success: boolean;
}

// ============================================================================
// MCP (Model Context Protocol) Types
// ============================================================================

/** Status of a single MCP server for dashboard display */
export interface McpServerStatus {
	index: number;
	name: string; // serverId из mcp.json или индекс
	status: "connecting" | "connected" | "unavailable";
	transport: "stdio" | "streamable-http";
	toolCount: number;
	toolNames: string[];
	serverInfo?: { name: string; version: string };
	connectError?: string;
	lastUpdated: string; // ISO 8601
}

/** Response shape for GET /api/mcp/servers */
export interface ApiMcpStatusResponse {
	servers: McpServerStatus[];
	totalConnected: number;
	totalUnavailable: number;
	lastUpdate: string;
}

// ============================================================================
// WebSocket Event Types
// ============================================================================

/** Base WebSocket message envelope */
export interface WsMessage {
	type: string;
	sessionId: string;
	timestamp: string;
}

/** Agent event forwarded to WebSocket client */
export interface WsAgentEvent extends WsMessage {
	type: "agent_event";
	event: Record<string, unknown>; // AgentSessionEvent serialized
}

/** Budget alert forwarded to WebSocket client */
export interface WsBudgetAlert extends WsMessage {
	type: "budget_alert";
	alert: {
		provider: string;
		period: string;
		alertType: "warning" | "critical" | "exceeded";
		message: string;
	};
}

/** Model switch event forwarded to WebSocket client */
export interface WsModelSwitch extends WsMessage {
	type: "model_switch";
	from: { provider: string; model: string };
	to: { provider: string; model: string };
	reason: string;
}

/** WebSocket error message */
export interface WsError extends WsMessage {
	type: "error";
	code: string;
	message: string;
}

/** Server notification: the message was queued because the engine is busy (F-2.5) */
export interface WsQueued extends WsMessage {
	type: "queued";
	/** 1-based position of the message in the session's queue */
	position: number;
}

/** Server notification: the message was REJECTED because the session's queue
 *  is full (F-2.15). Sent instead of `queued` when enqueue hits the limit. */
export interface WsQueueFull extends WsMessage {
	type: "queue_full";
	/** Stable machine-readable error code */
	error: "QUEUE_OVERFLOW";
	/** Per-session queue capacity that was reached */
	limit: number;
}

export type WsOutgoingMessage = WsAgentEvent | WsBudgetAlert | WsModelSwitch | WsError | WsQueued | WsQueueFull;

/** Incoming WebSocket messages from client */
export type WsIncomingMessage =
	| { type: "ping" }
	| { type: "subscribe"; sessionId: string }
	| { type: "sendMessage"; content: string; streamingBehavior?: "steer" | "followUp" };
