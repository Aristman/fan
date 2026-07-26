import { createMcpConfigLoader, type McpConfig } from "@fan/mcp";

/**
 * Minimal contract for an MCP connection manager owned by the switcher.
 *
 * Structurally compatible with `McpClientManager` from `@fan/mcp`
 * (connectAll → connect, dispose → dispose are adapted by the caller's
 * `createManager` factory).
 */
export interface McpConnectionManager {
	/** Establish all server connections described by the config. */
	connect(config: McpConfig): Promise<void>;
	/** Tear down all server connections. */
	dispose(): Promise<void>;
}

/**
 * Cache of live MCP connections keyed by project cwd.
 *
 * Mirrors the get/set semantics of `ServiceRegistry` (F-2.1). Kept as a
 * separate interface because the real ServiceRegistry caches
 * `AgentSessionServices`, which today do not carry MCP connections (MCP is
 * per-session, see the module docstring of this file). Once MCP connections
 * become part of the cached services, an adapter over ServiceRegistry can
 * implement this interface.
 */
export interface McpConnectionCache {
	get(cwd: string): McpConnectionManager | null;
	set(cwd: string, manager: McpConnectionManager): void;
}

/**
 * Default in-memory {@link McpConnectionCache} (plain Map).
 *
 * Eviction policy is intentionally out of scope here: entries stay alive
 * until `delete()`/`disposeAll()` is called, matching the F-2.10 requirement
 * that old connections are not torn down on switch.
 */
export class InMemoryMcpConnectionCache implements McpConnectionCache {
	private readonly connections = new Map<string, McpConnectionManager>();

	get(cwd: string): McpConnectionManager | null {
		return this.connections.get(cwd) ?? null;
	}

	set(cwd: string, manager: McpConnectionManager): void {
		this.connections.set(cwd, manager);
	}

	delete(cwd: string): boolean {
		return this.connections.delete(cwd);
	}

	get size(): number {
		return this.connections.size;
	}

	keys(): string[] {
		return [...this.connections.keys()];
	}

	/** Dispose every cached connection (best-effort) and clear the cache. */
	async disposeAll(): Promise<void> {
		const managers = [...this.connections.values()];
		this.connections.clear();
		for (const manager of managers) {
			try {
				await manager.dispose();
			} catch {
				// Disposal must never break cache consistency.
			}
		}
	}
}

/** Outcome of a {@link McpSwitcher.switchMcpServers} call. */
export type McpSwitchAction =
	/** fromCwd === toCwd: immediate no-op, nothing touched. */
	| "noop"
	/** toCwd already has live connections in the cache: reused as-is. */
	| "reused"
	/** toCwd was not cached: config loaded, connections established and cached. */
	| "initialized"
	/** toCwd was not cached but its config declares no servers: nothing to do. */
	| "no-servers";

export interface McpSwitchResult {
	action: McpSwitchAction;
	fromCwd: string;
	toCwd: string;
	/** Live connection manager for toCwd, or null for noop/no-servers. */
	manager: McpConnectionManager | null;
}

export interface McpSwitcherOptions {
	/**
	 * Connection cache. Default: {@link InMemoryMcpConnectionCache}.
	 * Pass an adapter over ServiceRegistry when MCP connections are attached
	 * to cached AgentSessionServices.
	 */
	cache?: McpConnectionCache;
	/**
	 * Factory for a connection manager bound to the session's extension
	 * context. Required because real MCP managers need the ExtensionAPI,
	 * which only the session/extension layer can provide.
	 */
	createManager: (cwd: string, config: McpConfig) => McpConnectionManager | Promise<McpConnectionManager>;
	/**
	 * Config loader for a project cwd. Default: reads and merges
	 * `~/.fan/agent/mcp.json` with `<cwd>/.fan/mcp.json` via the real
	 * `createMcpConfigLoader` from `@fan/mcp`.
	 */
	loadConfig?: (cwd: string) => Promise<McpConfig>;
}

/**
 * MCP switch coordinator (F-2.10): reconnect MCP servers on project switch.
 *
 * Semantics (roadmap F-2.10 / spec §2.5):
 * 1. Same cwd → no-op. Nothing is closed, loaded, or connected.
 * 2. New cwd already cached → reuse the cached connections.
 * 3. New cwd not cached → lazy init from `<toCwd>/.fan/mcp.json`.
 *
 * Old connections (fromCwd) are never closed by the switch — they stay alive
 * in the cache until the cache owner evicts/disposes them.
 *
 * Deviations from the spec (documented, driven by the real architecture):
 * - The spec assumed `packages/coding-agent/src/mcp/mcp-connection-manager.ts`.
 *   In reality MCP lives in the `@fan/mcp` package with a per-session
 *   lifecycle (`session_start` → connectAll, `session_shutdown` → dispose);
 *   no persistent cwd-keyed connection manager exists. This module is the
 *   coordinator that adds the cwd-keyed semantics on top.
 * - `ServiceRegistry` (F-2.1) caches `AgentSessionServices`, which do not
 *   include MCP connections, so the switcher works against the small
 *   {@link McpConnectionCache} interface (default in-memory impl) that
 *   mirrors ServiceRegistry's get/set semantics.
 * - A project config with zero servers yields action "no-servers" (mirrors
 *   the mcp extension's silent no-op on empty config) and is not cached.
 */
type InitResult = { action: "initialized"; manager: McpConnectionManager } | { action: "no-servers"; manager: null };

export class McpSwitcher {
	private readonly cache: McpConnectionCache;
	private readonly createManager: McpSwitcherOptions["createManager"];
	private readonly loadConfig: (cwd: string) => Promise<McpConfig>;
	/** In-flight initializations keyed by cwd. Concurrent switches to the same
	 *  uncached cwd await the first attempt and reuse its result. */
	private readonly inFlight = new Map<string, Promise<InitResult>>();

	constructor(options: McpSwitcherOptions) {
		this.cache = options.cache ?? new InMemoryMcpConnectionCache();
		this.createManager = options.createManager;
		this.loadConfig = options.loadConfig ?? ((cwd: string) => createMcpConfigLoader(cwd).load());
	}

	/** The connection cache used by this switcher. */
	get connectionCache(): McpConnectionCache {
		return this.cache;
	}

	/**
	 * Switch MCP connections from one project cwd to another.
	 *
	 * Never closes the connections of fromCwd: they remain cached and alive.
	 */
	async switchMcpServers(fromCwd: string, toCwd: string): Promise<McpSwitchResult> {
		// 1. Same cwd → immediate no-op.
		if (fromCwd === toCwd) {
			return { action: "noop", fromCwd, toCwd, manager: null };
		}

		// 2. New cwd cached → reuse live connections.
		const cached = this.cache.get(toCwd);
		if (cached) {
			return { action: "reused", fromCwd, toCwd, manager: cached };
		}

		// 3. New cwd not cached → lazy init from <toCwd>/.fan/mcp.json.
		//    Guard concurrent switches to the same cwd so only one connect
		//    runs and every waiter receives the same manager.
		const existing = this.inFlight.get(toCwd);
		if (existing) {
			const result = await existing;
			return { action: result.action, fromCwd, toCwd, manager: result.manager };
		}

		const promise = this.initialize(toCwd);
		this.inFlight.set(toCwd, promise);
		try {
			const result = await promise;
			return { action: result.action, fromCwd, toCwd, manager: result.manager };
		} finally {
			this.inFlight.delete(toCwd);
		}
	}

	private async initialize(toCwd: string): Promise<InitResult> {
		const config = await this.loadConfig(toCwd);
		if (config.servers.length === 0) {
			return { action: "no-servers", manager: null };
		}

		const manager = await this.createManager(toCwd, config);
		await manager.connect(config);
		this.cache.set(toCwd, manager);
		return { action: "initialized", manager };
	}
}
