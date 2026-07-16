/**
 * F-2.5: Broker handler — maintains MCP tool catalog for routing worker→parent tool calls.
 *
 * Subscribes to the EventBus channel "mcp:catalog" (emitted by fan-mcp extension).
 * Uses FAN's `fan.events` to receive the catalog (F-2.3 replay-on-subscribe ensures
 * late subscribers still get the latest catalog).
 *
 * @module broker-handler
 */

/** @type {Map<string, import("./types.js").MCPToolDescriptor>} */
let brokerCatalog = new Map();
let brokerInitialized = false;

/**
 * @typedef {Object} MCPToolDescriptor
 * @property {string} id - Fully qualified tool ID (e.g. "mcp__filesystem__read_file")
 * @property {string} name - Short tool name
 * @property {string} description - Tool description
 * @property {Object} [inputSchema] - JSON Schema for tool parameters
 * @property {string} [serverName] - MCP server name
 */

/**
 * Broker handler singleton.
 * @namespace brokerHandler
 */
export const brokerHandler = {
	/**
	 * Subscribe to catalog updates. Idempotent.
	 * @param {import("./types.js").FANExtensionAPI} fan - ExtensionAPI from orchestrator-extension
	 */
	initialize(fan) {
		if (brokerInitialized) return;
		brokerInitialized = true;

		if (fan && fan.events && typeof fan.events.on === "function") {
			fan.events.on("mcp:catalog", (payload) => {
				if (!payload || !Array.isArray(payload.tools)) return;
				const newMap = new Map();
				for (const tool of payload.tools) {
					newMap.set(tool.id, tool);
				}
				brokerCatalog = newMap;
			});
		}
	},

	/**
	 * Get a tool descriptor by ID (e.g. "mcp__filesystem__read_file").
	 * Returns null if not found.
	 * @param {string} toolId
	 * @returns {MCPToolDescriptor | null}
	 */
	getTool(toolId) {
		return brokerCatalog.get(toolId) ?? null;
	},

	/**
	 * List all proxied tools.
	 * @returns {MCPToolDescriptor[]}
	 */
	listTools() {
		return Array.from(brokerCatalog.values());
	},

	/**
	 * Reset internal state (for testing).
	 */
	_reset() {
		brokerCatalog = new Map();
		brokerInitialized = false;
	},
};
