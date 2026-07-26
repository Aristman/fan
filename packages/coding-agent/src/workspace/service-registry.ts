import type { AgentSessionServices } from "../core/agent-session-services.js";

/**
 * Cleanup callback invoked when an entry leaves the cache
 * (via invalidate() or clear()).
 *
 * AgentSessionServices has no built-in dispose/teardown method, so resource
 * release (MCP connection close, watcher stop, etc.) is delegated to the
 * caller through this hook.
 */
export type ServiceCleanupFn = (services: AgentSessionServices, cwd: string) => void;

export interface ServiceRegistryOptions {
	/** Maximum number of cached entries. Default: 5. When full, the least recently used entry is evicted. */
	maxItems?: number;
	/** Optional cleanup hook called before an entry is removed from the cache. */
	cleanup?: ServiceCleanupFn;
	/** Clock source, injectable for deterministic tests. Default: Date.now. */
	now?: () => number;
}

interface CacheEntry {
	services: AgentSessionServices;
	lastAccess: number;
}

export const DEFAULT_MAX_ITEMS = 5;

/**
 * Cache of cwd-bound AgentSessionServices keyed by working directory.
 *
 * Standalone infrastructure module (F-2.1). Avoids full teardown/recreate of
 * services on every project switch. When the cache reaches maxItems, set()
 * evicts the entry with the oldest lastAccess (LRU, F-2.2).
 */
export class ServiceRegistry {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly maxItemsValue: number;
	private readonly cleanupFn?: ServiceCleanupFn;
	private readonly now: () => number;

	constructor(options: ServiceRegistryOptions | number = {}) {
		const opts: ServiceRegistryOptions = typeof options === "number" ? { maxItems: options } : options;
		this.maxItemsValue = opts.maxItems ?? DEFAULT_MAX_ITEMS;
		this.cleanupFn = opts.cleanup;
		this.now = opts.now ?? Date.now;
	}

	/** Configured cache capacity. The cache never exceeds this size (LRU eviction). */
	get maxItems(): number {
		return this.maxItemsValue;
	}

	/** Number of cached entries. */
	get size(): number {
		return this.cache.size;
	}

	/** Cached cwd keys (insertion order). Exposed for tests and diagnostics. */
	keys(): string[] {
		return [...this.cache.keys()];
	}

	/**
	 * Look up services for a cwd. Updates lastAccess on hit (LRU accounting).
	 * Returns null on miss.
	 */
	get(cwd: string): AgentSessionServices | null {
		const entry = this.cache.get(cwd);
		if (!entry) {
			return null;
		}
		entry.lastAccess = this.now();
		return entry.services;
	}

	/**
	 * Store services for a cwd. Overwrites an existing entry (running cleanup
	 * for the replaced services). If the cache is full and the key is new,
	 * the least recently used entry (smallest lastAccess) is evicted first
	 * (delete + cleanup), so the cache never exceeds maxItems.
	 */
	set(cwd: string, services: AgentSessionServices): void {
		const existing = this.cache.get(cwd);
		if (existing) {
			// Overwrite: no eviction, just replace the services.
			if (existing.services !== services) {
				this.runCleanup(existing.services, cwd);
			}
			this.cache.set(cwd, { services, lastAccess: this.now() });
			return;
		}
		if (this.cache.size >= this.maxItemsValue) {
			this.evictLeastRecentlyUsed();
		}
		this.cache.set(cwd, { services, lastAccess: this.now() });
	}

	/**
	 * Remove the entry for a cwd, running cleanup for its services.
	 * Returns true if an entry existed.
	 */
	invalidate(cwd: string): boolean {
		const entry = this.cache.get(cwd);
		if (!entry) {
			return false;
		}
		this.cache.delete(cwd);
		this.runCleanup(entry.services, cwd);
		return true;
	}

	/** Remove all entries, running cleanup for each. */
	clear(): void {
		const entries = [...this.cache.entries()];
		this.cache.clear();
		for (const [cwd, entry] of entries) {
			this.runCleanup(entry.services, cwd);
		}
	}

	/**
	 * Last access timestamp for a cwd (null on miss). Does not touch the entry.
	 * Exposed for tests and diagnostics.
	 */
	getLastAccess(cwd: string): number | null {
		return this.cache.get(cwd)?.lastAccess ?? null;
	}

	/** Find the entry with the smallest lastAccess, delete it, and run cleanup. */
	private evictLeastRecentlyUsed(): void {
		let oldestKey: string | undefined;
		let oldestAccess = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.cache) {
			if (entry.lastAccess < oldestAccess) {
				oldestAccess = entry.lastAccess;
				oldestKey = key;
			}
		}
		if (oldestKey === undefined) {
			return;
		}
		const entry = this.cache.get(oldestKey);
		this.cache.delete(oldestKey);
		if (entry) {
			this.runCleanup(entry.services, oldestKey);
		}
	}

	private runCleanup(services: AgentSessionServices, cwd: string): void {
		if (!this.cleanupFn) {
			return;
		}
		try {
			this.cleanupFn(services, cwd);
		} catch {
			// Cleanup must never break cache consistency.
		}
	}
}
