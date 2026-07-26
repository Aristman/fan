import { statSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Stat-like probe used by the config watcher. Returns an object with
 * `mtimeMs`, or null when the file is missing/unreadable.
 * Injectable for deterministic tests (mirrors the `now()` injection pattern).
 */
export type StatLikeFn = (path: string) => { mtimeMs: number } | null;

const defaultStatFn: StatLikeFn = (path) => {
	try {
		return statSync(path);
	} catch {
		return null;
	}
};

export interface ServiceRegistryOptions {
	/** Maximum number of cached entries. Default: 5. When full, the least recently used entry is evicted. */
	maxItems?: number;
	/** Optional cleanup hook called before an entry is removed from the cache. */
	cleanup?: ServiceCleanupFn;
	/** Clock source, injectable for deterministic tests. Default: Date.now. */
	now?: () => number;
	/**
	 * Enable config watching (F-2.11). Default: true.
	 * A watcher starts on first access (set/get hit) to a cwd and polls
	 * `<cwd>/.fan/settings.json` for mtime changes.
	 */
	watch?: boolean;
	/** Poll interval for the config watcher in ms. Default: 5000. Injectable for fast tests. */
	watchPollIntervalMs?: number;
	/** Stat probe for the config watcher. Default: fs.statSync based. Injectable for tests. */
	statFn?: StatLikeFn;
}

interface CacheEntry {
	services: AgentSessionServices;
	lastAccess: number;
}

interface WatcherEntry {
	timer: ReturnType<typeof setInterval>;
	/** Last observed mtimeMs of <cwd>/.fan/settings.json (null = file missing). */
	lastMtimeMs: number | null;
}

export const DEFAULT_MAX_ITEMS = 5;
export const DEFAULT_WATCH_POLL_INTERVAL_MS = 5000;

/**
 * Cache of cwd-bound AgentSessionServices keyed by working directory.
 *
 * Standalone infrastructure module (F-2.1). Avoids full teardown/recreate of
 * services on every project switch. When the cache reaches maxItems, set()
 * evicts the entry with the oldest lastAccess (LRU, F-2.2).
 *
 * Config auto-invalidation (F-2.11): on first access to a cwd a polling
 * watcher starts for `<cwd>/.fan/settings.json`; when its mtime changes
 * (including file creation or deletion) the entry is invalidated. Watchers
 * stop when entries leave the cache (invalidate/clear/eviction).
 */
export class ServiceRegistry {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly maxItemsValue: number;
	private readonly cleanupFn?: ServiceCleanupFn;
	private readonly now: () => number;
	private readonly watchers = new Map<string, WatcherEntry>();
	private readonly watchEnabled: boolean;
	private readonly watchPollIntervalMs: number;
	private readonly statFn: StatLikeFn;

	constructor(options: ServiceRegistryOptions | number = {}) {
		const opts: ServiceRegistryOptions = typeof options === "number" ? { maxItems: options } : options;
		const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
		if (!Number.isInteger(maxItems) || maxItems < 1) {
			throw new Error(`ServiceRegistry: maxItems must be a positive integer, got ${maxItems}`);
		}
		this.maxItemsValue = maxItems;
		this.cleanupFn = opts.cleanup;
		this.now = opts.now ?? Date.now;
		this.watchEnabled = opts.watch ?? true;
		this.watchPollIntervalMs = opts.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS;
		this.statFn = opts.statFn ?? defaultStatFn;
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
		// First access to this cwd arms the config watcher (F-2.11).
		this.watchForConfigChanges(cwd);
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
		// First access to this cwd arms the config watcher (F-2.11).
		this.watchForConfigChanges(cwd);
	}

	/**
	 * Remove the entry for a cwd, running cleanup for its services and
	 * stopping its config watcher. Returns true if an entry existed.
	 */
	invalidate(cwd: string): boolean {
		this.stopWatching(cwd);
		const entry = this.cache.get(cwd);
		if (!entry) {
			return false;
		}
		this.cache.delete(cwd);
		this.runCleanup(entry.services, cwd);
		return true;
	}

	/** Remove all entries, running cleanup for each and stopping all watchers. */
	clear(): void {
		const entries = [...this.cache.entries()];
		this.cache.clear();
		for (const cwd of [...this.watchers.keys()]) {
			this.stopWatching(cwd);
		}
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
		this.stopWatching(oldestKey);
		if (entry) {
			this.runCleanup(entry.services, oldestKey);
		}
	}

	/**
	 * Start watching `<cwd>/.fan/settings.json` for mtime changes (F-2.11).
	 *
	 * Implementation note: polling is used instead of fs.watch because it is
	 * deterministic in tests, cross-platform (fs.watch is unreliable on
	 * Windows/network drives), and — crucially — can watch a file that does
	 * not exist yet (fs.watch throws on missing paths). A missing
	 * settings.json is therefore watched as well: file creation counts as a
	 * configuration change, and so does deletion.
	 *
	 * Idempotent: calling for an already watched cwd is a no-op. The watcher
	 * stops automatically when the entry leaves the cache (invalidate/clear/
	 * LRU eviction). The poll timer is unref'd so it never keeps the process
	 * alive. Returns true if a watcher is active for the cwd after the call.
	 */
	watchForConfigChanges(cwd: string): boolean {
		if (!this.watchEnabled) {
			return false;
		}
		if (this.watchers.has(cwd)) {
			return true;
		}
		const record: WatcherEntry = {
			lastMtimeMs: this.statFn(this.settingsPath(cwd))?.mtimeMs ?? null,
			timer: setInterval(() => this.pollWatcher(cwd), this.watchPollIntervalMs),
		};
		record.timer.unref?.();
		this.watchers.set(cwd, record);
		return true;
	}

	/** Whether a config watcher is currently active for a cwd. */
	isWatching(cwd: string): boolean {
		return this.watchers.has(cwd);
	}

	/** Number of active config watchers. Exposed for tests and diagnostics. */
	get watcherCount(): number {
		return this.watchers.size;
	}

	private settingsPath(cwd: string): string {
		return join(cwd, ".fan", "settings.json");
	}

	private pollWatcher(cwd: string): void {
		const record = this.watchers.get(cwd);
		if (!record) {
			return;
		}
		const mtimeMs = this.statFn(this.settingsPath(cwd))?.mtimeMs ?? null;
		if (mtimeMs !== record.lastMtimeMs) {
			// settings.json modified / created / deleted => configuration changed.
			// invalidate() also stops this watcher.
			this.invalidate(cwd);
		}
	}

	private stopWatching(cwd: string): void {
		const record = this.watchers.get(cwd);
		if (!record) {
			return;
		}
		clearInterval(record.timer);
		this.watchers.delete(cwd);
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
