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
