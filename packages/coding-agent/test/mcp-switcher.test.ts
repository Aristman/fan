import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfig } from "@fan/mcp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InMemoryMcpConnectionCache, type McpConnectionManager, McpSwitcher } from "../src/workspace/mcp-switcher.js";

// Redirect homedir() into a sandbox so the default config loader never reads
// the real ~/.fan/agent/mcp.json during tests.
const { homeState } = vi.hoisted(() => ({ homeState: { home: "" } }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => homeState.home };
});

function mockManager(): McpConnectionManager & {
	connect: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
} {
	return {
		connect: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
}

function configWithServers(count: number): McpConfig {
	return {
		servers: Array.from({ length: count }, (_, i) => ({
			transport: "stdio" as const,
			name: `server-${i}`,
			command: "true",
		})),
	};
}

describe("McpSwitcher (F-2.10)", () => {
	describe("TC-F-2.10-1: same cwd → no-op, no connection closed", () => {
		test("returns immediately without touching cache, config, or connections", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerA = mockManager();
			cache.set("/a", managerA);

			const loadConfig = vi.fn(async () => configWithServers(1));
			const createManager = vi.fn(() => mockManager());
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			const result = await switcher.switchMcpServers("/a", "/a");

			expect(result.action).toBe("noop");
			expect(result.fromCwd).toBe("/a");
			expect(result.toCwd).toBe("/a");
			// No connection closed, none created, no config read.
			expect(managerA.dispose).not.toHaveBeenCalled();
			expect(loadConfig).not.toHaveBeenCalled();
			expect(createManager).not.toHaveBeenCalled();
			// Cache untouched: /a still cached, nothing added.
			expect(cache.size).toBe(1);
			expect(cache.get("/a")).toBe(managerA);
		});
	});

	describe("TC-F-2.10-1b: concurrent switches to uncached cwd serialize on one connect", () => {
		test("two parallel switches → one connect, both receive the same manager", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerB = mockManager();
			const createManager = vi.fn(() => managerB);
			const loadConfig = vi.fn(async () => configWithServers(1));
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			let releaseConnect: () => void;
			const connectGate = new Promise<void>((resolve) => {
				releaseConnect = resolve;
			});
			managerB.connect.mockImplementation(async () => {
				await connectGate;
			});

			const both = Promise.all([switcher.switchMcpServers("/a", "/b"), switcher.switchMcpServers("/a", "/b")]);

			// Wait until the first (and only) connect call is in flight.
			await vi.waitFor(() => expect(managerB.connect).toHaveBeenCalledTimes(1));
			expect(createManager).toHaveBeenCalledTimes(1);
			releaseConnect!();

			const [result1, result2] = await both;

			expect(result1.action).toBe("initialized");
			expect(result2.action).toBe("initialized");
			expect(result1.manager).toBe(managerB);
			expect(result2.manager).toBe(managerB);
			expect(cache.get("/b")).toBe(managerB);
		});

		test("concurrent switch waits for failure and propagates the error", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const failingManager = mockManager();
			failingManager.connect.mockRejectedValue(new Error("connect failed"));
			const createManager = vi.fn(() => failingManager);
			const loadConfig = vi.fn(async () => configWithServers(1));
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			const [result1, result2] = await Promise.allSettled([
				switcher.switchMcpServers("/a", "/b"),
				switcher.switchMcpServers("/a", "/b"),
			]);

			expect(result1.status).toBe("rejected");
			expect(result2.status).toBe("rejected");
			expect(createManager).toHaveBeenCalledTimes(1);
			expect(cache.get("/b")).toBeNull();
		});
	});

	describe("TC-F-2.10-2: uncached cwd → lazy init, old connections preserved", () => {
		test("initializes from <toCwd> config and keeps fromCwd connections alive", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerA = mockManager();
			cache.set("/a", managerA);

			const configB = configWithServers(2);
			const loadConfig = vi.fn(async (cwd: string) => {
				expect(cwd).toBe("/b");
				return configB;
			});
			const managerB = mockManager();
			const createManager = vi.fn(() => managerB);
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			const result = await switcher.switchMcpServers("/a", "/b");

			expect(result.action).toBe("initialized");
			expect(result.manager).toBe(managerB);
			// Lazy init: config loaded for /b, manager created and connected.
			expect(loadConfig).toHaveBeenCalledTimes(1);
			expect(loadConfig).toHaveBeenCalledWith("/b");
			expect(createManager).toHaveBeenCalledTimes(1);
			expect(createManager).toHaveBeenCalledWith("/b", configB);
			expect(managerB.connect).toHaveBeenCalledTimes(1);
			expect(managerB.connect).toHaveBeenCalledWith(configB);
			// New connections cached under /b.
			expect(cache.get("/b")).toBe(managerB);
			// Old connections preserved: /a still cached, never disposed.
			expect(cache.get("/a")).toBe(managerA);
			expect(managerA.dispose).not.toHaveBeenCalled();
			expect(managerB.dispose).not.toHaveBeenCalled();
		});
	});

	describe("cached cwd → reuse", () => {
		test("returns cached manager without loading config or connecting", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerA = mockManager();
			const managerB = mockManager();
			cache.set("/a", managerA);
			cache.set("/b", managerB);

			const loadConfig = vi.fn(async () => configWithServers(1));
			const createManager = vi.fn(() => mockManager());
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			const result = await switcher.switchMcpServers("/a", "/b");

			expect(result.action).toBe("reused");
			expect(result.manager).toBe(managerB);
			expect(loadConfig).not.toHaveBeenCalled();
			expect(createManager).not.toHaveBeenCalled();
			expect(managerB.connect).not.toHaveBeenCalled();
			expect(managerA.dispose).not.toHaveBeenCalled();
			expect(managerB.dispose).not.toHaveBeenCalled();
		});

		test("switching back to a previously initialized cwd reuses it (round-trip)", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerA = mockManager();
			cache.set("/a", managerA);

			const loadConfig = vi.fn(async () => configWithServers(1));
			const managerB = mockManager();
			const createManager = vi.fn(() => managerB);
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			await switcher.switchMcpServers("/a", "/b");
			const back = await switcher.switchMcpServers("/b", "/a");

			expect(back.action).toBe("reused");
			expect(back.manager).toBe(managerA);
			// Config was loaded exactly once (first init of /b).
			expect(loadConfig).toHaveBeenCalledTimes(1);
			expect(managerA.dispose).not.toHaveBeenCalled();
			expect(managerB.dispose).not.toHaveBeenCalled();
		});
	});

	describe("empty project config", () => {
		test("no servers configured → no-servers action, nothing created or cached", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerA = mockManager();
			cache.set("/a", managerA);

			const loadConfig = vi.fn(async () => ({ servers: [] }) as McpConfig);
			const createManager = vi.fn(() => mockManager());
			const switcher = new McpSwitcher({ cache, createManager, loadConfig });

			const result = await switcher.switchMcpServers("/a", "/b");

			expect(result.action).toBe("no-servers");
			expect(result.manager).toBeNull();
			expect(createManager).not.toHaveBeenCalled();
			expect(cache.get("/b")).toBeNull();
			expect(managerA.dispose).not.toHaveBeenCalled();
		});
	});

	describe("default loadConfig (real @fan/mcp loader)", () => {
		const testDir = join(process.cwd(), "test-mcp-switcher-tmp");
		const fakeHome = join(testDir, "home");
		const projectB = join(testDir, "project-b");

		beforeEach(() => {
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true });
			}
			mkdirSync(fakeHome, { recursive: true });
			mkdirSync(join(projectB, ".fan"), { recursive: true });
			homeState.home = fakeHome;
		});

		afterEach(() => {
			homeState.home = "";
			if (existsSync(testDir)) {
				rmSync(testDir, { recursive: true });
			}
		});

		test("lazy init reads <toCwd>/.fan/mcp.json from disk", async () => {
			writeFileSync(
				join(projectB, ".fan", "mcp.json"),
				JSON.stringify({
					servers: [{ transport: "stdio", name: "proj-b-server", command: "true" }],
				}),
			);

			const managerB = mockManager();
			const createManager = vi.fn(() => managerB);
			// No loadConfig override → default createMcpConfigLoader(cwd).
			const switcher = new McpSwitcher({ createManager });

			const result = await switcher.switchMcpServers("/a", projectB);

			expect(result.action).toBe("initialized");
			expect(result.manager).toBe(managerB);
			expect(createManager).toHaveBeenCalledTimes(1);
			const [cwdArg, configArg] = createManager.mock.calls[0] as unknown as [string, McpConfig];
			expect(cwdArg).toBe(projectB);
			expect(configArg.servers).toHaveLength(1);
			expect(configArg.servers[0].name).toBe("proj-b-server");
			expect(managerB.connect).toHaveBeenCalledWith(configArg);
			// Cached for reuse.
			expect(switcher.connectionCache.get(projectB)).toBe(managerB);
		});

		test("missing .fan/mcp.json → no-servers, no manager created", async () => {
			const createManager = vi.fn(() => mockManager());
			const switcher = new McpSwitcher({ createManager });

			const result = await switcher.switchMcpServers("/a", projectB);

			expect(result.action).toBe("no-servers");
			expect(createManager).not.toHaveBeenCalled();
		});
	});

	describe("InMemoryMcpConnectionCache", () => {
		test("disposeAll disposes every connection and clears the cache", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const managerA = mockManager();
			const managerB = mockManager();
			cache.set("/a", managerA);
			cache.set("/b", managerB);

			await cache.disposeAll();

			expect(managerA.dispose).toHaveBeenCalledTimes(1);
			expect(managerB.dispose).toHaveBeenCalledTimes(1);
			expect(cache.size).toBe(0);
		});

		test("disposeAll tolerates a failing dispose", async () => {
			const cache = new InMemoryMcpConnectionCache();
			const failing = mockManager();
			failing.dispose.mockRejectedValue(new Error("boom"));
			cache.set("/a", failing);

			await expect(cache.disposeAll()).resolves.toBeUndefined();
			expect(cache.size).toBe(0);
		});
	});
});
