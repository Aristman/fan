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
 * F-2.4 FIX: External callback for actual MCP tool invocation.
 * Set by orchestrator-extension at init. Routes to fan-mcp client.
 * @type {((serverId: string, toolName: string, args: object) => Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>) | null}
 */
let toolCallHandler = null;

/**
 * F-2.7: Agent name → permission level mapping.
 * Key: agent name, Value: "all" | "read-only" | "none"
 */
const PROFILES_BY_AGENT = {
	explore: "read-only",
	plan: "read-only",
	verify: "read-only",
	"code-research": "read-only",
	implement: "all",
	"bug-fix": "all",
	"tests-impl": "all",
};

const DEFAULT_LEVEL = "all";

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
	 * F-2.7: Resolve permission level for a given agent name.
	 * @param {string} [agentName] - Agent identifier (e.g. "explore", "implement")
	 * @returns {"all" | "read-only" | "none"}
	 */
	getPermissionLevel(agentName) {
		return PROFILES_BY_AGENT[agentName] ?? DEFAULT_LEVEL;
	},

	/**
	 * F-2.7: Filter MCP tool catalog by agent permission level.
	 *
	 * - "all": no filter, returns all tools
	 * - "none": returns empty array
	 * - "read-only": returns only tools with annotations.readOnly === true
	 *
	 * @param {import("./types.js").MCPToolDescriptor[]} tools - Full catalog array
	 * @param {"all" | "read-only" | "none"} level - Permission level from getPermissionLevel()
	 * @returns {import("./types.js").MCPToolDescriptor[]}
	 */
	filterToolsByProfile(tools, level) {
		if (!Array.isArray(tools)) return [];
		if (level === "none") return [];
		if (level === "all") return tools;
		// read-only: only tools with readOnly annotation
		return tools.filter((t) => t.annotations?.readOnly === true);
	},

	/**
	 * Set the callback for actual MCP tool invocations.
	 * Called once during orchestrator extension init.
	 * @param {(serverId: string, toolName: string, args: object) => Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>} handler
	 */
	setToolCallHandler(handler) {
		toolCallHandler = handler;
	},

	/**
	 * Get the current tool call handler (for testing/debugging).
	 * @returns {typeof toolCallHandler}
	 */
	getToolCallHandler() {
		return toolCallHandler;
	},

	/**
	 * F-2.4 FIX: Look up tool in catalog, route to MCP client via registered handler.
	 * @param {string} toolId - Fully qualified tool ID (e.g. "mcp__filesystem__read_file")
	 * @param {object} args - Tool arguments
	 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
	 */
	async invokeTool(toolId, args) {
		if (!toolCallHandler) {
			throw new Error(`No MCP tool handler registered (broker not initialized)`);
		}
		const descriptor = brokerCatalog.get(toolId);
		if (!descriptor) {
			throw new Error(`Tool "${toolId}" not found in MCP catalog`);
		}
		// descriptor.id = "mcp__<serverId>__<toolName>"
		// Extract serverId and toolName from the fully-qualified ID
		const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolId);
		if (!match) throw new Error(`Invalid tool ID format: ${toolId}`);
		const [, serverId, toolName] = match;
		return toolCallHandler(serverId, toolName, args);
	},

	/**
	 * F-2.4 FIX: Safe wrapper for subagent-runner to call directly.
	 * Returns a properly shaped remote_tool_response payload.
	 * @param {string} toolId
	 * @param {object} args
	 * @returns {Promise<{content: Array<{type: string, text: string}>, isError: boolean}>}
	 */
	async handleRemoteToolInvocation(toolId, args) {
		try {
			const result = await this.invokeTool(toolId, args);
			return {
				content: result.content ?? [{ type: "text", text: "" }],
				isError: false,
			};
		} catch (e) {
			return {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				isError: true,
			};
		}
	},

	/**
	 * Reset internal state (for testing).
	 */
	_reset() {
		brokerCatalog = new Map();
		brokerInitialized = false;
		toolCallHandler = null;
	},
};

/**
 * F-2.7: Standalone wrapper for test imports (delegates to brokerHandler singleton).
 */
export function getPermissionLevel(agentName) {
	return brokerHandler.getPermissionLevel(agentName);
}

export function filterToolsByProfile(tools, level) {
	return brokerHandler.filterToolsByProfile(tools, level);
}

