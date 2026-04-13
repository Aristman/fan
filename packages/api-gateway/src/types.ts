export type { BudgetStatus, BudgetConfig, ModelSettingData, BudgetAlert, BudgetAlertHandler } from "@fan/model-manager";
import type { BudgetStatus, BudgetConfig, ModelSettingData } from "@fan/model-manager";

// ============================================================================
// HTTP REST Request/Response Types
// ============================================================================

/** Standard error response */
export interface ApiError {
  error: string;
  code: string;
}

/** Health check response */
export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
}

// --- Sessions ---

export interface CreateSessionRequest {
  title?: string;
  parentSessionId?: string;
}

export interface CreateSessionResponse {
  id: string;
  title: string;
  model?: string;
  provider?: string;
  createdAt: string;
  updatedAt: string;
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
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
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

export type WsOutgoingMessage = WsAgentEvent | WsBudgetAlert | WsModelSwitch | WsError;

/** Incoming WebSocket messages from client */
export type WsIncomingMessage =
  | { type: "ping" }
  | { type: "subscribe"; sessionId: string };
