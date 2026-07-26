import { describe, expect, test, vi } from "vitest";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import { ServiceRegistry } from "../src/workspace/service-registry.js";

function mockServices(cwd: string): AgentSessionServices {
	return { cwd } as unknown as AgentSessionServices;
}

describe("ServiceRegistry (F-2.1)", () => {
	describe("TC-F-2.1-1: get/set/invalidate work correctly", () => {
		test("set then get returns the stored services", () => {
			const registry = new ServiceRegistry(3);
			const svcA = mockServices("/a");
			const svcB = mockServices("/b");

			registry.set("/a", svcA);
			registry.set("/b", svcB);

			expect(registry.get("/a")).toBe(svcA);
			expect(registry.get("/b")).toBe(svcB);
			expect(registry.size).toBe(2);
		});

		test("invalidate removes the entry, get returns null, cleanup is called", () => {
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 3, cleanup });
			const svcA = mockServices("/a");

			registry.set("/a", svcA);
			expect(registry.get("/a")).toBe(svcA);

			expect(registry.invalidate("/a")).toBe(true);
			expect(registry.get("/a")).toBeNull();
			expect(registry.size).toBe(0);
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledWith(svcA, "/a");
		});

		test("invalidate on missing key is a no-op and returns false", () => {
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 3, cleanup });

			expect(registry.invalidate("/missing")).toBe(false);
			expect(cleanup).not.toHaveBeenCalled();
		});
	});

	describe("TC-F-2.1-2: clear() releases all services", () => {
		test("clear empties the cache and runs cleanup for every entry", () => {
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 3, cleanup });
			const svcA = mockServices("/a");
			const svcB = mockServices("/b");
			const svcC = mockServices("/c");

			registry.set("/a", svcA);
			registry.set("/b", svcB);
			registry.set("/c", svcC);
			expect(registry.size).toBe(3);

			registry.clear();

			expect(registry.size).toBe(0);
			expect(registry.get("/a")).toBeNull();
			expect(registry.get("/b")).toBeNull();
			expect(registry.get("/c")).toBeNull();
			expect(cleanup).toHaveBeenCalledTimes(3);
			expect(cleanup).toHaveBeenCalledWith(svcA, "/a");
			expect(cleanup).toHaveBeenCalledWith(svcB, "/b");
			expect(cleanup).toHaveBeenCalledWith(svcC, "/c");
		});
	});

	describe("constructor options", () => {
		test("default maxItems is 5", () => {
			expect(new ServiceRegistry().maxItems).toBe(5);
			expect(new ServiceRegistry({}).maxItems).toBe(5);
		});

		test("numeric constructor argument sets maxItems", () => {
			expect(new ServiceRegistry(3).maxItems).toBe(3);
		});

		test("options object sets maxItems", () => {
			expect(new ServiceRegistry({ maxItems: 7 }).maxItems).toBe(7);
		});

		test("maxItems = 0 throws", () => {
			expect(() => new ServiceRegistry(0)).toThrow("maxItems must be a positive integer");
			expect(() => new ServiceRegistry({ maxItems: 0 })).toThrow("maxItems must be a positive integer");
		});

		test("negative maxItems throws", () => {
			expect(() => new ServiceRegistry(-1)).toThrow("maxItems must be a positive integer");
			expect(() => new ServiceRegistry({ maxItems: -5 })).toThrow("maxItems must be a positive integer");
		});

		test("non-integer maxItems throws", () => {
			expect(() => new ServiceRegistry(1.5)).toThrow("maxItems must be a positive integer");
			expect(() => new ServiceRegistry({ maxItems: 3.14 })).toThrow("maxItems must be a positive integer");
		});
	});

	describe("lastAccess tracking", () => {
		test("set records the current timestamp and get() updates it", () => {
			let clock = 1000;
			const registry = new ServiceRegistry({ now: () => clock });

			registry.set("/a", mockServices("/a"));
			expect(registry.getLastAccess("/a")).toBe(1000);

			clock = 2000;
			registry.get("/a");
			expect(registry.getLastAccess("/a")).toBe(2000);
		});

		test("get() on a missing key does not create an entry", () => {
			const registry = new ServiceRegistry();

			expect(registry.get("/missing")).toBeNull();
			expect(registry.size).toBe(0);
			expect(registry.getLastAccess("/missing")).toBeNull();
		});

		test("keys() exposes cached cwds", () => {
			const registry = new ServiceRegistry(3);

			registry.set("/a", mockServices("/a"));
			registry.set("/b", mockServices("/b"));

			expect(registry.keys()).toEqual(["/a", "/b"]);
		});
	});

	describe("overwrite semantics", () => {
		test("set on an existing key replaces services and cleans up the old ones", () => {
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 3, cleanup });
			const oldSvc = mockServices("/a");
			const newSvc = mockServices("/a");

			registry.set("/a", oldSvc);
			registry.set("/a", newSvc);

			expect(registry.size).toBe(1);
			expect(registry.get("/a")).toBe(newSvc);
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledWith(oldSvc, "/a");
		});

		test("set with the same services object does not run cleanup", () => {
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 3, cleanup });
			const svc = mockServices("/a");

			registry.set("/a", svc);
			registry.set("/a", svc);

			expect(cleanup).not.toHaveBeenCalled();
			expect(registry.get("/a")).toBe(svc);
		});
	});

	describe("cleanup robustness", () => {
		test("throwing cleanup does not break invalidate", () => {
			const registry = new ServiceRegistry({
				cleanup: () => {
					throw new Error("boom");
				},
			});

			registry.set("/a", mockServices("/a"));
			expect(() => registry.invalidate("/a")).not.toThrow();
			expect(registry.size).toBe(0);
		});

		test("throwing cleanup does not break clear", () => {
			const registry = new ServiceRegistry({
				cleanup: () => {
					throw new Error("boom");
				},
			});

			registry.set("/a", mockServices("/a"));
			registry.set("/b", mockServices("/b"));
			expect(() => registry.clear()).not.toThrow();
			expect(registry.size).toBe(0);
		});

		test("registry works without a cleanup callback", () => {
			const registry = new ServiceRegistry(3);

			registry.set("/a", mockServices("/a"));
			expect(() => registry.invalidate("/a")).not.toThrow();
			expect(() => registry.clear()).not.toThrow();
		});
	});
});

describe("ServiceRegistry LRU eviction (F-2.2)", () => {
	describe("TC-F-2.2-1: oldest entry is evicted automatically", () => {
		test("set on a full cache evicts the entry with the smallest lastAccess", () => {
			let clock = 0;
			const registry = new ServiceRegistry({ maxItems: 2, now: () => clock });
			const svcA = mockServices("/a");
			const svcB = mockServices("/b");
			const svcC = mockServices("/c");

			clock = 100;
			registry.set("/a", svcA);
			clock = 200;
			registry.set("/b", svcB);

			clock = 300;
			registry.set("/c", svcC);

			expect(registry.get("/a")).toBeNull();
			expect(registry.get("/c")).toBe(svcC);
			expect(registry.get("/b")).toBe(svcB);
			expect(registry.size).toBe(2);
		});
	});

	describe("TC-F-2.2-2: eviction is by last access, not insertion order", () => {
		test("a recently accessed entry survives; the stale one is evicted", () => {
			let clock = 0;
			const registry = new ServiceRegistry({ maxItems: 2, now: () => clock });
			const svcA = mockServices("/a");
			const svcB = mockServices("/b");
			const svcC = mockServices("/c");

			clock = 100;
			registry.set("/a", svcA);
			clock = 200;
			registry.get("/a");
			clock = 300;
			registry.set("/b", svcB);
			clock = 400;
			registry.get("/a");

			clock = 500;
			registry.set("/c", svcC);

			expect(registry.get("/b")).toBeNull();
			expect(registry.get("/a")).toBe(svcA);
			expect(registry.get("/c")).toBe(svcC);
			expect(registry.size).toBe(2);
		});
	});

	describe("eviction semantics", () => {
		test("overwrite of an existing key on a full cache does not trigger eviction", () => {
			let clock = 0;
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 2, cleanup, now: () => clock });
			const svcA = mockServices("/a");
			const svcB = mockServices("/b");
			const svcA2 = mockServices("/a");

			clock = 100;
			registry.set("/a", svcA);
			clock = 200;
			registry.set("/b", svcB);

			clock = 300;
			registry.set("/a", svcA2);

			expect(registry.size).toBe(2);
			expect(registry.get("/b")).toBe(svcB);
			expect(registry.get("/a")).toBe(svcA2);
			// Cleanup ran only for the overwritten services, nothing evicted.
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledWith(svcA, "/a");
		});

		test("cleanup is called for the evicted entry", () => {
			let clock = 0;
			const cleanup = vi.fn();
			const registry = new ServiceRegistry({ maxItems: 2, cleanup, now: () => clock });
			const svcA = mockServices("/a");

			clock = 100;
			registry.set("/a", svcA);
			clock = 200;
			registry.set("/b", mockServices("/b"));
			clock = 300;
			registry.set("/c", mockServices("/c"));

			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledWith(svcA, "/a");
		});

		test("cache never exceeds maxItems across many inserts", () => {
			let clock = 0;
			const registry = new ServiceRegistry({ maxItems: 3, now: () => clock });

			for (let i = 0; i < 20; i++) {
				clock = i;
				registry.set(`/p${i}`, mockServices(`/p${i}`));
				expect(registry.size).toBeLessThanOrEqual(3);
			}
			expect(registry.size).toBe(3);
			expect(registry.keys()).toEqual(["/p17", "/p18", "/p19"]);
		});

		test("throwing cleanup does not break eviction", () => {
			let clock = 0;
			const registry = new ServiceRegistry({
				maxItems: 1,
				now: () => clock,
				cleanup: () => {
					throw new Error("boom");
				},
			});

			clock = 100;
			registry.set("/a", mockServices("/a"));
			clock = 200;
			expect(() => registry.set("/b", mockServices("/b"))).not.toThrow();
			expect(registry.size).toBe(1);
			expect(registry.get("/a")).toBeNull();
			expect(registry.get("/b")).not.toBeNull();
		});
	});
});
