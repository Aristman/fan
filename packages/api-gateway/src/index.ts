// @fan/api-gateway — Client API Gateway for FAN

export type { ClientTokenData } from "./auth.js";
export {
	generateToken,
	isAuthDisabled,
	isPublicMode,
	listTokens,
	revokeToken,
	tokenAuth,
	validateToken,
} from "./auth.js";
export { DEFAULT_ALLOWED_ORIGINS, resolveAllowedOrigins, resolveCorsOrigin } from "./cors-config.js";
export type { ServerOptions, SessionAdapter } from "./http-server.js";
export { createApp, startServer } from "./http-server.js";
export * from "./types.js";
export type { CwdValidationResult } from "./workspace-validation.js";
export { isWithinRoot, logCwdRejection, resolveAllowedRoots, validateCwd } from "./workspace-validation.js";
export type { WsHandlerOptions } from "./ws-handler.js";
export { attachWebSocketHandler, createBunWebSocketBridge } from "./ws-handler.js";
