// @fan/api-gateway — Client API Gateway for FAN

export type { ClientTokenData } from "./auth.js";
export {
	generateToken,
	isAuthDisabled,
	listTokens,
	revokeToken,
	seedNodeToken,
	tokenAuth,
	validateToken,
} from "./auth.js";
export type { MissionDelegateAuthResult } from "./auth-mission-delegate.js";
export { verifyNodeToken } from "./auth-mission-delegate.js";
export type { ServerOptions, SessionAdapter } from "./http-server.js";
export { apiEvents, createApp, startServer } from "./http-server.js";
export type { MissionTree, MissionTreeNode } from "./mission-api.js";
export { getMissionBudget, getMissionStatus, getMissionTree, isValidMissionSlug } from "./mission-api.js";
export type { MissionDelegatePayload, MissionDelegateValidationResult } from "./mission-delegate-schema.js";
export { validateMissionDelegatePayload } from "./mission-delegate-schema.js";
export * from "./types.js";
export type { MissionJournalLike, WsHandlerOptions } from "./ws-handler.js";
export { attachWebSocketHandler } from "./ws-handler.js";
