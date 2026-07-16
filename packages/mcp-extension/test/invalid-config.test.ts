/**
 * F-1.18: Invalid mcp.json graceful handling at the extension/loader level.
 *
 * Tests that loadMcpConfig (via createMcpConfigLoader) gracefully handles:
 * - Invalid JSON syntax → console.warn + empty config (no crash)
 * - Invalid schema (e.g. bad transport) → server skipped, other file loaded
 * - Both files invalid → empty config without throwing
 *
 * Uses real files in temporary directories for isolation.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig } from "../src/config.js";

describe("F-1.18: invalid mcp.json handling", () => {
	let globalRoot: string;
	let cwd: string;

	beforeEach(async () => {
		globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fan-mcp-test-"));
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fan-mcp-cwd-"));
		process.env.HOME = globalRoot;
		process.env.USERPROFILE = globalRoot;
	});

	afterEach(async () => {
		await fs.rm(globalRoot, { recursive: true, force: true });
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("invalid JSON in global → warn + empty config", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await fs.mkdir(path.join(globalRoot, ".fan/agent"), { recursive: true });
		await fs.writeFile(path.join(globalRoot, ".fan/agent/mcp.json"), "{ broken");

		const config = await loadMcpConfig(cwd);
		expect(config.servers).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("invalid schema in project → server skipped, global still loaded", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Global OK
		await fs.mkdir(path.join(globalRoot, ".fan/agent"), { recursive: true });
		await fs.writeFile(
			path.join(globalRoot, ".fan/agent/mcp.json"),
			JSON.stringify({ servers: [{ transport: "stdio", command: "x" }] }),
		);

		// Project invalid — unknown transport
		await fs.mkdir(path.join(cwd, ".fan"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".fan/mcp.json"),
			JSON.stringify({ servers: [{ transport: "unknown" }] }),
		);

		const config = await loadMcpConfig(cwd);
		expect(config.servers.length).toBeGreaterThanOrEqual(1);
		expect(config.servers[0].transport).toBe("stdio");
		expect(config.servers[0].command).toBe("x");
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("both invalid → empty config without throwing", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Global: broken JSON
		await fs.mkdir(path.join(globalRoot, ".fan/agent"), { recursive: true });
		await fs.writeFile(path.join(globalRoot, ".fan/agent/mcp.json"), "{ broken");

		// Project: valid JSON but invalid schema (array instead of object)
		await fs.mkdir(path.join(cwd, ".fan"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".fan/mcp.json"), "[]");

		const config = await loadMcpConfig(cwd);
		expect(config.servers).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});
});
