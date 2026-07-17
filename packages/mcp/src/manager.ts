/**
 * MCP client manager (F-1.4, F-1.5, F-1.6, F-1.7, F-1.14, F-1.15, F-1.16, F-1.17).
 * Owns MCP Client instances per server, handles transport lifecycle, and
 * forwards tool calls to the FAN agent loop via the ExtensionAPI.
 *
 * F-1.14: Graceful shutdown — closes all clients and transports within 5s.
 * F-1.15: list_changed — subscribes to notifications/tools/list_changed with
 *         500ms debounce and atomic diff-based refresh.
 * F-1.16: Unavailable server handling — spawn fail / connect timeout marks
 *         a server as "unavailable" while other servers proceed.
 * F-1.17: Crash handling — transport.onclose unregisters all tools for that
 *         server and aborts pending calls.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { type AdapterClient, mcpToolToDefinition } from "./adapter.js";
import type { McpConfig, McpServerConfig } from "./config.js";
import { filterToolsByConfig, type PermissionGate } from "./permissions.js";
import { createHttpTransport, createStdioTransport } from "./transport.js";

/** Connect timeout per server (initialize phase). */
const CONNECT_TIMEOUT_MS = 5_000;

/** Total budget for dispose() cleanup across all servers. */
const DISPOSE_TIMEOUT_MS = 5_000;

/** Default debounce for list_changed notifications. */
const LIST_CHANGED_DEBOUNCE_MS = 500;

/**
 * Maximum auto-restart backoff attempts (F-3.4).
 */
export const MAX_RESTART_ATTEMPTS = 5;

/**
 * Auto-restart backoff window in milliseconds (F-3.4).
 * After this much time since the first crash, the attempt counter resets.
 */
export const RESTART_WINDOW_MS = 60_000;

/**
 * Calculate exponential backoff delay for auto-restart (F-3.4).
 *
 * Returns: 1s, 2s, 4s, 8s, 16s (capped at 16_000 ms).
 */
export function backoffDelay(attempt: number): number {
	return Math.min(1000 * 2 ** (attempt - 1), 16_000);
}

/**
 * Internal state for a single MCP server connection.
 */
interface ServerEntry {
	index: number;
	config: McpServerConfig;
	client: Client | null;
	transport: Transport | null;
	status: "connecting" | "connected" | "unavailable" | "disabled";
	toolNames: string[];
	connectError?: string;
	/** AdapterClient used to call tools on this server. */
	adapterClient?: AdapterClient;
	/** Number of restart attempts since last crash (resets after success or 60s window). */
	restartAttempts?: number;
	/** Timestamp of the first crash in the current backoff window. */
	firstCrashAt?: number;
}

/**
 * Public, read-only view of a server entry for the widget.
 */
export interface ServerInfo {
	index: number;
	name: string;
	transport: "stdio" | "streamable-http";
	status: "connecting" | "connected" | "unavailable" | "disabled";
	toolNames: string[];
	connectError?: string;
	enabled: boolean;
	/** List of tool names that are denied/disabled for this server. */
	deniedTools: string[];
}

export interface McpClientManager {
	connectAll(config: McpConfig): Promise<void>;
	dispose(): Promise<void>;
	/** Exposed for tests only — returns current internal state. */
	_entries(): ServerEntry[];

	// New public API for TUI widget
	getServers(): ServerInfo[];
	connectOne(index: number): Promise<void>;
	disconnectOne(index: number): Promise<void>;
	setToolEnabled(serverIdx: number, toolName: string, enabled: boolean): Promise<void>;
	reloadConfig(configLoader: import("./config.js").ConfigLoader): Promise<string>;
}

/**
 * Create an McpClientManager that owns per-server MCP Client instances.
 *
 * @param fan - Extension API for tool registration/unregistration
 * @param permissions - Permission gate for tool call filtering
 */
export function createMcpClientManager(fan: ExtensionAPI, permissions: PermissionGate): McpClientManager {
	const entries: ServerEntry[] = [];

	// ── Transport factory ──────────────────────────────────────────

	/**
	 * Build a Transport from a server config.
	 */
	async function buildTransport(cfg: McpServerConfig): Promise<Transport> {
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
	 * that were registered for this server via fan.unregisterTool().
	 *
	 * F-3.4: If config.autoRestart is true, attempts to reconnect
	 * the server with exponential backoff (1s, 2s, 4s, 8s, 16s)
	 * up to 5 attempts within a 60-second window. After 5 failures
	 * autoRestart is disabled permanently.
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
				fan.unregisterTool(toolName);
			} catch {
				// Ignore per-tool errors; keep going
			}
		}
		entry.toolNames = [];

		// ── Auto-restart (F-3.4) ────────────────────────────────

		if (!entry.config.autoRestart) return;

		// Initialize counters on first crash
		if (entry.restartAttempts === undefined) entry.restartAttempts = 0;
		if (entry.firstCrashAt === undefined) entry.firstCrashAt = Date.now();

		entry.restartAttempts++;

		// Check if 60s window has passed since first crash — reset counters
		if (Date.now() - entry.firstCrashAt > RESTART_WINDOW_MS) {
			entry.restartAttempts = 1;
			entry.firstCrashAt = Date.now();
		}

		if (entry.restartAttempts > MAX_RESTART_ATTEMPTS) {
			console.warn(
				`mcp: server ${entry.index} auto-restart exhausted after ${entry.restartAttempts} attempts, disabling`,
			);
			entry.config = { ...entry.config, autoRestart: false };
			return;
		}

		const delayMs = backoffDelay(entry.restartAttempts);
		console.info(
			`mcp: server ${entry.index} auto-restart attempt ${entry.restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delayMs}ms`,
		);

		setTimeout(() => {
			connectOne(entry.index, entry.config)
				.then((newEntry) => {
					// Merge fields from the new connection back into the existing entry.
					// The new entry already has tools registered via connectOne.
					Object.assign(entry, {
						client: newEntry.client,
						transport: newEntry.transport,
						status: newEntry.status,
						toolNames: newEntry.toolNames,
						connectError: newEntry.connectError,
						adapterClient: newEntry.adapterClient,
					});

					if (newEntry.status === "connected") {
						// Success — tools already re-registered by connectOne.
						// Reset backoff counters.
						entry.restartAttempts = 0;
						entry.firstCrashAt = undefined;
						console.info(`mcp: server ${entry.index} auto-restart successful`);
					} else {
						console.warn(
							`mcp: server ${entry.index} auto-restart attempt ${entry.restartAttempts} failed: ${newEntry.connectError ?? "unknown"}`,
						);
					}
				})
				.catch((e) => {
					console.warn(
						`mcp: server ${entry.index} auto-restart attempt ${entry.restartAttempts} threw: ${e instanceof Error ? e.message : String(e)}`,
					);
				});
		}, delayMs);
	}

	// ── list_changed atomic refresh (F-1.15) ───────────────────────

	/**
	 * Atomically refresh the tool registry for a server after a list_changed
	 * notification.
	 *
	 * 1. Re-fetches tools from the MCP server via listTools().
	 * 2. Filters through permission gate config.
	 * 3. Computes diff (add/remove/update) against current toolNames.
	 * 4. Applies changes atomically: unregister old → register/update new.
	 */
	async function refreshServerTools(entry: ServerEntry): Promise<void> {
		if (!entry.client || entry.status !== "connected") {
			return;
		}

		const client = entry.client;
		const adapterClient = entry.adapterClient;
		if (!adapterClient) {
			return;
		}

		try {
			const toolsResult = await client.listTools();
			const filtered = filterToolsByConfig(toolsResult.tools as any, entry.config);

			const newToolNames = new Set<string>();
			const newDefs: Array<{ name: string; def: any }> = [];
			const serverId = String(entry.index);

			for (const mcpTool of filtered) {
				const name = mcpToolToDefinition(serverId, mcpTool as any, adapterClient);
				newToolNames.add(name.name);
				newDefs.push({ name: name.name, def: name });
			}

			// Build old set for O(1) lookup
			const oldToolSet = new Set(entry.toolNames);

			// Remove tools that no longer exist
			for (const oldName of entry.toolNames) {
				if (!newToolNames.has(oldName)) {
					fan.unregisterTool(oldName);
				}
			}

			// Add new tools / update changed tools
			for (const { name, def } of newDefs) {
				if (oldToolSet.has(name)) {
					fan.updateTool(name, def);
				} else {
					fan.registerTool(def);
				}
			}

			entry.toolNames = [...newToolNames];

			console.info(`mcp: server ${serverId} tools refreshed (${newToolNames.size} tools)`);
		} catch (e: any) {
			console.warn(`mcp: server ${entry.index} list_changed refresh failed: ${e?.message ?? String(e)}`);
		}
	}

	// ── Connect one server ────────────────────────────────────────

	/**
	 * Connect to a single MCP server, register its tools, and return
	 * the ServerEntry. If connect fails (spawn error, timeout, etc.)
	 * the entry is marked "unavailable" with connectError set.
	 */
	async function connectOne(index: number, cfg: McpServerConfig): Promise<ServerEntry> {
		const entry: ServerEntry = {
			index,
			config: cfg,
			client: null,
			transport: null,
			status: "connecting",
			toolNames: [],
			adapterClient: undefined,
		};

		let transport: Transport;
		try {
			transport = await buildTransport(cfg);
		} catch (e: any) {
			entry.status = "unavailable";
			entry.connectError = e?.message ?? String(e);
			console.warn(`mcp: server ${index} config error: ${entry.connectError}`);
			return entry;
		}
		entry.transport = transport;

		// Install crash/error callbacks before starting the client
		transport.onclose = () => {
			handleCrash(entry);
		};
		transport.onerror = (error: Error) => {
			console.warn(`mcp: server ${index} transport error: ${error.message}`);
		};

		// F-1.15: Set up list_changed subscription with 500ms debounce.
		// autoRefresh is disabled — we handle the diff/register cycle ourselves
		// via refreshServerTools which calls listTools() with permission filtering.
		// Enabling autoRefresh would cause a double-fetch (SDK + ours).
		const client = new Client(
			{ name: "fan-mcp", version: "0.1.0" },
			{
				capabilities: {},
				listChanged: {
					tools: {
						autoRefresh: false,
						debounceMs: LIST_CHANGED_DEBOUNCE_MS,
						onChanged: (_error: Error | null, _tools: any[] | null) => {
							// We ignore the SDK-provided tools and do our own
							// filtered refresh via refreshServerTools.
							if (entry.status === "connected") {
								refreshServerTools(entry).catch((e) =>
									console.warn(
										`mcp: refreshServerTools failed for server ${index}: ${e?.message ?? String(e)}`,
									),
								);
							}
						},
					},
				},
			},
		);
		entry.client = client;

		try {
			// client.connect() calls transport.start() internally
			const connectPromise = client.connect(transport);
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`connect timeout ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
			);
			await Promise.race([connectPromise, timeout]);

			// List available tools
			const toolsResult = await client.listTools();

			// Filter tools via permission gate config
			const filtered = filterToolsByConfig(toolsResult.tools as any, cfg);

			// Create adapter client and store on entry so refreshServerTools
			// can use it for diff-based registry updates (F-1.15).
			const adapterClient: AdapterClient = {
				callTool: (args, options) =>
					client.callTool(
						args as any,
						undefined, // resultSchema — use default
						options as any, // RequestOptions with signal
					) as any,
			};
			entry.adapterClient = adapterClient;

			for (const mcpTool of filtered) {
				const serverId = String(index);
				const def = mcpToolToDefinition(serverId, mcpTool as any, adapterClient);
				fan.registerTool(def as any);
				entry.toolNames.push(def.name);
			}

			entry.status = "connected";
		} catch (e: any) {
			entry.status = "unavailable";
			entry.connectError = e?.message ?? String(e);
			console.warn(`mcp: server ${index} unavailable: ${entry.connectError}`);

			// Ensure transport is closed on failure
			try {
				await transport.close();
			} catch {
				// Best-effort cleanup
			}
		}

		return entry;
	}

	// ── emit catalog helper ───────────────────────────────────────

	function emitCatalog(): void {
		fan.events.emit("mcp:catalog", { servers: entries });
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

			// Emit catalog event
			fan.events.emit("mcp:catalog", { servers: entries });
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

			const timeoutPromise = new Promise<void>((resolve) => setTimeout(() => resolve(), DISPOSE_TIMEOUT_MS));

			await Promise.race([Promise.allSettled(closePromises), timeoutPromise]);

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

		getServers(): ServerInfo[] {
			return entries.map(e => ({
				index: e.index,
				name: e.config.command || e.config.url || `Server #${e.index}`,
				transport: e.config.transport,
				status: e.status,
				toolNames: [...e.toolNames],
				connectError: e.connectError,
				enabled: e.status === "connected" || e.status === "connecting",
				deniedTools: [...(e.config.deniedTools ?? [])],
			}));
		},

		async connectOne(index: number): Promise<void> {
			if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
				throw new RangeError(`Server index ${index} out of range (0..${entries.length - 1})`);
			}

			// If already connected/connecting — disconnect first to avoid leaking transport/client
			const existing = entries[index];
			if (existing.status === "connected" || existing.status === "connecting") {
				await this.disconnectOne(index);
			}

			const cfg = existing.config;
			const newEntry = await connectOne(index, cfg);
			entries[index] = newEntry;

			emitCatalog();
		},

		async disconnectOne(index: number): Promise<void> {
			if (index < 0 || index >= entries.length) {
				throw new RangeError(`Server index ${index} out of range (0..${entries.length - 1})`);
			}

			const entry = entries[index];
			if (entry.status === "unavailable" || entry.status === "disabled") return;

			// Mark as disabled
			entry.status = "disabled";

			// Unregister all tools
			for (const name of entry.toolNames) {
				try {
					fan.unregisterTool(name);
				} catch {
					// Best-effort cleanup
				}
			}
			entry.toolNames = [];

			// Close client + transport
			if (entry.client) {
				try {
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
			entry.client = null;
			entry.transport = null;

			emitCatalog();
		},

		async setToolEnabled(serverIdx: number, toolName: string, enabled: boolean): Promise<void> {
			if (serverIdx < 0 || serverIdx >= entries.length) {
				throw new RangeError(`Server index ${serverIdx} out of range (0..${entries.length - 1})`);
			}

			const entry = entries[serverIdx];
			const denied = new Set(entry.config.deniedTools ?? []);

			if (enabled) {
				denied.delete(toolName);
			} else {
				denied.add(toolName);
			}

			// Mutate config
			entry.config = { ...entry.config, deniedTools: [...denied] };
			permissions.updateConfig(entries.map(e => e.config));

			// Re-register tools via diff-based refresh
			if (entry.client && entry.status === "connected") {
				await refreshServerTools(entry);
			}

			emitCatalog();
		},

		async reloadConfig(configLoader: import("./config.js").ConfigLoader): Promise<string> {
			// dispose all current connections
			const closePromises = entries.map(async (entry) => {
				if (entry.client) {
					try { await entry.client.close(); } catch {}
				}
				if (entry.transport) {
					try { await entry.transport.close(); } catch {}
				}
			});
			await Promise.allSettled(closePromises);

			entries.length = 0;
			const config = await configLoader.load();
			permissions.updateConfig(config.servers);
			await this.connectAll(config);
			return `Reloaded: ${entries.length} servers`;
		},
	};
}
