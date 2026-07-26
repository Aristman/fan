import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import { ServiceRegistry, type ServiceRegistryOptions, type StatLikeFn } from "../src/workspace/service-registry.js";

function mockServices(cwd: string): AgentSessionServices {
	return { cwd } as unknown as AgentSessionServices;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll interval used in tests — short for fast, still deterministic polling. */
const POLL_MS = 25;

describe("ServiceRegistry config watch (F-2.11)", () => {
	let baseDir: string;
	let registries: ServiceRegistry[];

	function makeRegistry(opts: ServiceRegistryOptions = {}): ServiceRegistry {
		const registry = new ServiceRegistry({ watchPollIntervalMs: POLL_MS, ...opts });
		registries.push(registry);
		return registry;
	}

	function makeProject(name: string, withSettings = true): string {
		const cwd = mkdtempSync(join(baseDir, `${name}-`));
		if (withSettings) {
			mkdirSync(join(cwd, ".fan"), { recursive: true });
			writeFileSync(join(cwd, ".fan", "settings.json"), JSON.stringify({ model: "test-model" }));
		}
		return cwd;
	}

	function touchSettings(cwd: string): void {
		const path = join(cwd, ".fan", "settings.json");
		writeFileSync(path, JSON.stringify({ model: "updated-model" }));
		// Force a clearly different mtime (immune to coarse fs timestamp resolution).
		const future = new Date(Date.now() + 10_000);
		utimesSync(path, future, future);
	}

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "fan-svc-registry-watch-"));
		registries = [];
	});

	afterEach(() => {
		for (const registry of registries) {
			registry.clear();
		}
		rmSync(baseDir, { recursive: true, force: true });
	});

	describe("TC-F-2.11-1: cache invalidates when settings.json changes", () => {
		test("touch settings.json -> poll interval -> get returns null and cleanup runs", async () => {
			const cwd = makeProject("a");
			const cleanup = vi.fn();
			const registry = makeRegistry({ cleanup });
			const svc = mockServices(cwd);

			registry.set(cwd, svc);
			expect(registry.get(cwd)).toBe(svc);
			expect(registry.isWatching(cwd)).toBe(true);

			touchSettings(cwd);
			await sleep(POLL_MS * 4);

			expect(registry.get(cwd)).toBeNull();
			expect(registry.size).toBe(0);
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledWith(svc, cwd);
			// Watcher stopped after auto-invalidation (no leak).
			expect(registry.isWatching(cwd)).toBe(false);
			expect(registry.watcherCount).toBe(0);
		});

		test("entry survives polling while settings.json is unchanged", async () => {
			const cwd = makeProject("stable");
			const registry = makeRegistry();
			const svc = mockServices(cwd);

			registry.set(cwd, svc);
			await sleep(POLL_MS * 4);

			expect(registry.get(cwd)).toBe(svc);
			expect(registry.isWatching(cwd)).toBe(true);
		});

		test("re-set after auto-invalidation arms a fresh watcher (no stale baseline)", async () => {
			const cwd = makeProject("reset");
			const registry = makeRegistry();

			registry.set(cwd, mockServices(cwd));
			touchSettings(cwd);
			await sleep(POLL_MS * 4);
			expect(registry.get(cwd)).toBeNull();

			// Re-cache the same cwd; the new watcher baselines on the current mtime.
			const svc2 = mockServices(cwd);
			registry.set(cwd, svc2);
			await sleep(POLL_MS * 4);
			expect(registry.get(cwd)).toBe(svc2);
		});
	});

	describe("watcher lifecycle", () => {
		test("watcher starts on first access (set and get hit), not on get miss", () => {
			const cwd = makeProject("arm");
			const registry = makeRegistry();

			expect(registry.get(cwd)).toBeNull();
			expect(registry.isWatching(cwd)).toBe(false);

			registry.set(cwd, mockServices(cwd));
			expect(registry.isWatching(cwd)).toBe(true);
		});

		test("watcher stops after LRU eviction and never ticks again", async () => {
			let clock = 0;
			const cwdA = makeProject("evict-a");
			const cwdB = makeProject("evict-b");
			const cwdC = makeProject("evict-c");

			// Counting stat probe wraps the real fs to observe poll ticks per path.
			const statCalls = new Map<string, number>();
			const countingStatFn: StatLikeFn = (path) => {
				statCalls.set(path, (statCalls.get(path) ?? 0) + 1);
				try {
					return statSync(path);
				} catch {
					return null;
				}
			};

			const registry = makeRegistry({ maxItems: 2, now: () => clock, statFn: countingStatFn });

			clock = 100;
			registry.set(cwdA, mockServices(cwdA));
			clock = 200;
			registry.set(cwdB, mockServices(cwdB));
			clock = 300;
			registry.set(cwdC, mockServices(cwdC)); // evicts cwdA

			expect(registry.get(cwdA)).toBeNull();
			expect(registry.isWatching(cwdA)).toBe(false);
			expect(registry.isWatching(cwdB)).toBe(true);
			expect(registry.isWatching(cwdC)).toBe(true);
			expect(registry.watcherCount).toBe(2);

			// No more poll ticks for the evicted cwd (no timer leak).
			const settingsA = join(cwdA, ".fan", "settings.json");
			const callsAtEviction = statCalls.get(settingsA) ?? 0;
			await sleep(POLL_MS * 4);
			expect(statCalls.get(settingsA) ?? 0).toBe(callsAtEviction);
		});

		test("invalidate stops the watcher", async () => {
			const cwd = makeProject("inv");
			const registry = makeRegistry();

			registry.set(cwd, mockServices(cwd));
			expect(registry.isWatching(cwd)).toBe(true);

			registry.invalidate(cwd);
			expect(registry.isWatching(cwd)).toBe(false);

			// Changing settings after invalidate has no effect (nothing cached, nothing watching).
			touchSettings(cwd);
			await sleep(POLL_MS * 4);
			expect(registry.get(cwd)).toBeNull();
			expect(registry.watcherCount).toBe(0);
		});

		test("clear stops all watchers", () => {
			const cwdA = makeProject("clr-a");
			const cwdB = makeProject("clr-b");
			const registry = makeRegistry();

			registry.set(cwdA, mockServices(cwdA));
			registry.set(cwdB, mockServices(cwdB));
			expect(registry.watcherCount).toBe(2);

			registry.clear();
			expect(registry.watcherCount).toBe(0);
			expect(registry.isWatching(cwdA)).toBe(false);
			expect(registry.isWatching(cwdB)).toBe(false);
		});
	});

	describe("missing settings.json semantics", () => {
		test("a missing settings.json is still watched: file creation invalidates the entry", async () => {
			const cwd = makeProject("missing", false);
			const registry = makeRegistry();
			const svc = mockServices(cwd);

			registry.set(cwd, svc);
			await sleep(POLL_MS * 4);
			// No file yet — entry stays cached (absence is a stable state).
			expect(registry.get(cwd)).toBe(svc);

			// File appears => configuration changed => invalidation.
			mkdirSync(join(cwd, ".fan"), { recursive: true });
			writeFileSync(join(cwd, ".fan", "settings.json"), JSON.stringify({ model: "late-model" }));
			await sleep(POLL_MS * 4);

			expect(registry.get(cwd)).toBeNull();
			expect(registry.isWatching(cwd)).toBe(false);
		});

		test("deleting settings.json invalidates the entry", async () => {
			const cwd = makeProject("delete");
			const registry = makeRegistry();

			registry.set(cwd, mockServices(cwd));
			await sleep(POLL_MS * 3);
			expect(registry.get(cwd)).not.toBeNull();

			rmSync(join(cwd, ".fan", "settings.json"));
			await sleep(POLL_MS * 4);

			expect(registry.get(cwd)).toBeNull();
		});
	});

	describe("watch configuration", () => {
		test("watch: false disables config watching entirely", async () => {
			const cwd = makeProject("nowatch");
			const registry = makeRegistry({ watch: false });

			registry.set(cwd, mockServices(cwd));
			expect(registry.isWatching(cwd)).toBe(false);
			expect(registry.watchForConfigChanges(cwd)).toBe(false);

			touchSettings(cwd);
			await sleep(POLL_MS * 4);
			expect(registry.get(cwd)).not.toBeNull();
		});

		test("watchForConfigChanges is idempotent", () => {
			const cwd = makeProject("idem");
			const registry = makeRegistry();

			expect(registry.watchForConfigChanges(cwd)).toBe(true);
			expect(registry.watchForConfigChanges(cwd)).toBe(true);
			expect(registry.watcherCount).toBe(1);
		});
	});
});
