/**
 * Bundled module imports for compiled Bun binary.
 *
 * These static imports exist solely so `bun build --compile` includes them
 * in the single-binary output. They are re-exported to extensions via
 * jiti's virtualModules option.
 *
 * This file is dynamically imported by loader.ts ONLY when isBunBinary === true.
 * In Node.js / development mode these modules are never loaded — extensions
 * resolve them through jiti aliases pointing to node_modules instead.
 *
 * Do NOT import this file statically from loader.ts or any module in the
 * main.ts import graph — doing so would negate lazy-import optimisations.
 */

import * as _bundledMcp from "@fan/mcp";
import * as _bundledStore from "@fan/store";
import * as _bundledPiAgentCore from "@seaagents/fan-agent-core";
import * as _bundledPiAi from "@seaagents/fan-ai";
import * as _bundledPiAiOauth from "@seaagents/fan-ai/oauth";
import * as _bundledPiTui from "@seaagents/fan-tui";
import * as _bundledTypebox from "@sinclair/typebox";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @seaagents/fan-coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	"@sinclair/typebox": _bundledTypebox,
	"@seaagents/fan-agent-core": _bundledPiAgentCore,
	"@seaagents/fan-tui": _bundledPiTui,
	"@seaagents/fan-ai": _bundledPiAi,
	"@seaagents/fan-ai/oauth": _bundledPiAiOauth,
	"@seaagents/fan-coding-agent": _bundledPiCodingAgent,
	"@fan/store": _bundledStore,
	"@fan/mcp": _bundledMcp,
};
