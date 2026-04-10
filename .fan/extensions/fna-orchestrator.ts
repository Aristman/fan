/**
 * FAN Orchestrator Extension — bridge file
 *
 * This file bridges the FAN orchestrator package into fan's extension system.
 * Fan's extension loader discovers this file from .fan/extensions/.
 *
 * NOTE: This file is local-only (.fan/ is gitignored).
 * In production, extension registration will be handled via config or built-in discovery.
 */
export { default } from "../../packages/orchestrator/src/orchestrator-extension.js";
