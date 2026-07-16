/**
 * MCP client manager (F-1.4, F-1.5, F-1.6, F-1.7, F-1.14, F-1.15, F-1.16, F-1.17).
 * Owns MCP Client instances per server, handles transport lifecycle, and
 * forwards tool calls to the FAN agent loop via the ExtensionAPI.
 *
 * F-1.14: Graceful shutdown — closes all clients and transports within 5s.
 * F-1.16: Unavailable server handling — spawn fail / connect timeout marks
 *         a server as "unavailable" while other servers proceed.
 * F-1.17: Crash handling — transport.onclose unregisters all tools for that
 *         server and aborts pending calls.
 */

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig, McpServerConfig } from "./config.js";
import { createStdioTransport } from "./transport.js";
import { createHttpTransport } from "./transport.js";
import { mcpToolToDefinition, type AdapterClient } from "./adapter.js";
import { filterToolsByConfig, type PermissionGate } from "./permissions.js";

/** Connect timeout per server (initialize phase). */
const CONNECT_TIMEOUT_MS = 5_000;

/** Total budget for dispose() cleanup across all servers. */
const DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Internal state for a single MCP server connection.
 */
interface ServerEntry {
	index: number;
	config: McpServerConfig;
	client: Client | null;
	transport: Transport | null;
	status: "connecting" | "connected" | "unavailable";
	toolNames: string[];
	connectError?: string;
}

export interface McpClientManager {
	connectAll(config: McpConfig): Promise<void>;
	dispose(): Promise<void>;
	/** Exposed for tests only — returns current internal state. */
	_entries(): ServerEntry[];
}

/**
 * Create an McpClientManager that owns per-server MCP Client instances.
 *
 * @param pi - Extension API for tool registration/unregistration
 * @param permissions - Permission gate for tool call filtering
 */
export function createMcpClientManager(
	pi: ExtensionAPI,
	permissions: PermissionGate,
): McpClientManager {
	const entries: ServerEntry[] = [];

	// ── Transport factory ──────────────────────────────────────────

	/**
	 * Build a Transport from a server config.
	 */
	function buildTransport(cfg: McpServerConfig): Transport {
		if (cfg.transport === "stdio") {
			return createStdioTransport(cfg);
		}
		return createHttpTransport(cfg);
	}

	// ── Crash handler ─────────────────────────────────────────────

	/**
	 * Handle a server crash (transport closed unexpectedly).
	 *
	 * F-1.17: Sets status to "unavailable" and unregisters all tools
	 * that were registered for this server via pi.unregisterTool().
	 */
	function handleCrash(entry: ServerEntry): void {
		if (entry.status !== "connected") {
			return; // Already unavailable or not yet fully connected
		}
		entry.status = "unavailable";
		console.warn(
			`mcp: server ${entry.index} (${entry.config.command ?? entry.config.url ?? "?"}) crashed, unregistering ${entry.toolNames.length} tools`,
		);
		for (const toolName of entry.toolNames) {
			try {
				pi.unregisterTool(toolName);
			} catch {
				// Ignore per-tool errors; keep going
			}
		}
		entry.toolNames = [];
	}

	// ── Connect one server ────────────────────────────────────────

	/**
	 * Connect to a single MCP server, register its tools, and return
	 * the ServerEntry. If connect fails (spawn error, timeout, etc.)
	 * the entry is marked "unavailable" with connectError set.
	 */
	async function connectOne(
		index: number,
		cfg: McpServerConfig,
	): Promise<ServerEntry> {
		const entry: ServerEntry = {
			index,
			config: cfg,
			client: null,
			transport: null,
			status: "connecting",
			toolNames: [],
		};

		let transport: Transport;
		try {
			transport = buildTransport(cfg);
		} catch (e: any) {
			entry.status = "unavailable";
			entry.connectError = e?.message ?? String(e);
			console.warn(
				`mcp: server ${index} config error: ${entry.connectError}`,
			);
			return entry;
		}
		entry.transport = transport;

		// Install crash/error callbacks before starting the client
		transport.onclose = () => {
			handleCrash(entry);
		};
		transport.onerror = (error: Error) => {
			console.warn(
				`mcp: server ${index} transport error: ${error.message}`,
			);
		};

		const client = new Client(
			{ name: "fan-mcp", version: "0.1.0" },
			{ capabilities: {} },
		);
		entry.client = client;

		try {
			// client.connect() calls transport.start() internally
			const connectPromise = client.connect(transport);
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`connect timeout ${CONNECT_TIMEOUT_MS}ms`)),
					CONNECT_TIMEOUT_MS,
				),
			);
			await Promise.race([connectPromise, timeout]);

			// List available tools
			const toolsResult = await client.listTools();

			// Filter tools via permission gate config
			const filtered = filterToolsByConfig(
				toolsResult.tools as any,
				cfg,
			);

			// Register each tool with the FAN extension API
			const adapterClient: AdapterClient = {
				callTool: (args, options) =>
					client.callTool(
						args as any,
						undefined, // resultSchema — use default
						options as any, // RequestOptions with signal
					) as any,
			};

			for (const mcpTool of filtered) {
				const serverId = String(index);
				const def = mcpToolToDefinition(
					serverId,
					mcpTool as any,
					adapterClient,
				);
				pi.registerTool(def as any);
				entry.toolNames.push(def.name);
			}

			entry.status = "connected";
		} catch (e: any) {
			entry.status = "unavailable";
			entry.connectError = e?.message ?? String(e);
			console.warn(
				`mcp: server ${index} unavailable: ${entry.connectError}`,
			);

			// Ensure transport is closed on failure
			try {
				await transport.close();
			} catch {
				// Best-effort cleanup
			}
		}

		return entry;
	}

	// ── Public API ─────────────────────────────────────────────────

	return {
		/**
		 * Connect to all configured MCP servers.
		 *
		 * Each server connects independently. Failures are isolated —
		 * a single unavailable server does not prevent others from
		 * connecting (F-1.16).
		 */
		async connectAll(config: McpConfig): Promise<void> {
			const promises = config.servers.map((cfg, i) => connectOne(i, cfg));
			const results = await Promise.allSettled(promises);

			// Collect all entries
			for (const result of results) {
				if (result.status === "fulfilled") {
					entries.push(result.value);
				}
			}

			// Emit catalog event if at least one server connected
			const connected = entries.filter(
				(e) => e.status === "connected",
			).length;
			if (connected > 0) {
				pi.events.emit("mcp:catalog", { servers: entries });
			}
		},

		/**
		 * Gracefully shut down all MCP connections.
		 *
		 * F-1.14: Closes all clients and transports within DISPOSE_TIMEOUT_MS.
		 * If cleanup takes longer, a warning is emitted but the function
		 * still resolves.
		 */
		async dispose(): Promise<void> {
			const startTime = Date.now();

			const closePromises = entries.map(async (entry) => {
				if (entry.client) {
					try {
						// Calling close() on the MCP Client will internally
						// close the transport as well, but we also call
						// transport.close() explicitly for safety.
						await entry.client.close();
					} catch {
						// Best-effort
					}
				}
				if (entry.transport) {
					try {
						await entry.transport.close();
					} catch {
						// Best-effort
					}
				}
			});

			const timeoutPromise = new Promise<void>((resolve) =>
				setTimeout(() => resolve(), DISPOSE_TIMEOUT_MS),
			);

			await Promise.race([
				Promise.allSettled(closePromises),
				timeoutPromise,
			]);

			const elapsed = Date.now() - startTime;
			if (elapsed >= DISPOSE_TIMEOUT_MS) {
				console.warn(
					`mcp: shutdown took ${elapsed}ms (>= ${DISPOSE_TIMEOUT_MS}ms threshold), some servers may not have closed gracefully`,
				);
			}
		},

		_entries(): ServerEntry[] {
			return entries;
		},
	};
}
