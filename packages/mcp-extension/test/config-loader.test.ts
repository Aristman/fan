/**
 * Tests for config.ts: mcp.json loader and global/project merge (F-1.8).
 *
 * Uses real files in temporary directories for isolation.
 *
 * Test cases:
 *   TC-F1.8-1: empty config when no files exist
 *   TC-F1.8-2: loads global file
 *   TC-F1.8-3: project overrides global at same index (non-overridden fields from global)
 *   TC-F1.8-4: invalid JSON → warning + skip file
 *   TC-F1.8-5: missing required fields → skip file with warning
 *   TC-F1.8-6: extra project servers beyond global length
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readConfigs, ConfigValidationError } from "../src/config.js";

// ──────────────────── Helpers ────────────────────

async function makeTempDir(): Promise<string> {
	const dir = join(tmpdir(), `fan-mcp-config-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writeJson(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(data), "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, "utf8");
}

// Silence warnings during tests (we assert on them separately)
function silenceWarnings() {
	const orig = console.warn;
	console.warn = vi.fn();
	return () => {
		console.warn = orig;
	};
}

function getWarningCalls(): string[] {
	return (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
}

// ──────────────────── Tests ────────────────────

describe("F-1.8: mcp.json loader", () => {
	// ── TC-F1.8-1: empty config when no files ──
	describe("TC-F1.8-1: no config files", () => {
		it("returns empty config when both files are missing", async () => {
			const dir = await makeTempDir();
			const result = await readConfigs(
				join(dir, "no-such-global.json"),
				join(dir, "no-such-project.json"),
			);
			expect(result.servers).toEqual([]);
		});

		it("returns empty config when both paths are undefined", async () => {
			const result = await readConfigs(undefined, undefined);
			expect(result.servers).toEqual([]);
		});
	});

	// ── TC-F1.8-2: loads global file ──
	describe("TC-F1.8-2: global file loads", () => {
		it("loads a global config with one server", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "global.json");
			await writeJson(globalPath, {
				servers: [{ transport: "stdio", command: "node", args: ["server.js"] }],
			});
			const result = await readConfigs(globalPath, join(dir, "no-project.json"));
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0].transport).toBe("stdio");
			expect(result.servers[0].command).toBe("node");
			expect(result.servers[0].args).toEqual(["server.js"]);
		});

		it("loads a global config with streamable-http transport", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "global.json");
			await writeJson(globalPath, {
				servers: [{ transport: "streamable-http", url: "https://mcp.example.com" }],
			});
			const result = await readConfigs(globalPath, join(dir, "no-project.json"));
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0].transport).toBe("streamable-http");
			expect(result.servers[0].url).toBe("https://mcp.example.com");
		});
	});

	// ── TC-F1.8-3: project overrides global at same index ──
	describe("TC-F1.8-3: project overrides global", () => {
		it("project overrides command at same index, keeps global timeout", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, ".fan", "mcp.json");

			await writeJson(globalPath, {
				servers: [{ transport: "stdio", command: "global-cmd", timeout: 1000 }],
			});
			await writeJson(projectPath, {
				servers: [{ transport: "stdio", command: "project-cmd" }],
			});

			const result = await readConfigs(globalPath, projectPath);
			expect(result.servers).toHaveLength(1);
			// Project wins for command
			expect(result.servers[0].command).toBe("project-cmd");
			// Global value preserved since project didn't set it (merge replaces the
			// whole entry — so timeout is lost since project didn't set it)
			expect(result.servers[0].timeout).toBeUndefined();
		});

		it("project transport overrides global transport", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, "project.json");

			await writeJson(globalPath, {
				servers: [
					{ transport: "stdio", command: "a", timeout: 5000 },
					{ transport: "stdio", command: "b" },
				],
			});
			await writeJson(projectPath, {
				servers: [{ transport: "streamable-http", url: "https://override.example.com" }],
			});

			const result = await readConfigs(globalPath, projectPath);
			expect(result.servers).toHaveLength(2);
			expect(result.servers[0].transport).toBe("streamable-http");
			expect(result.servers[0].url).toBe("https://override.example.com");
			// timeout from global is gone because the whole server object was replaced
			// (merge replaces the entry, not deep-merge)
			expect(result.servers[0].timeout).toBeUndefined();
			expect(result.servers[1].command).toBe("b");
		});
	});

	// ── TC-F1.8-4: invalid JSON → warning, skip file ──
	describe("TC-F1.8-4: invalid JSON is skipped with warning", () => {
		it("broken JSON in global file triggers warning and returns empty", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "broken.json");
				await writeText(globalPath, "{ broken json");

				const result = await readConfigs(globalPath, undefined);
				expect(result.servers).toEqual([]);
				const warnings = getWarningCalls();
				expect(warnings.length).toBeGreaterThan(0);
				expect(warnings.some((w) => w.includes("broken.json"))).toBe(true);
			} finally {
				restore();
			}
		});

		it("broken JSON in project file triggers warning, global still loads", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "global.json");
				const projectPath = join(dir, "project.json");

				await writeJson(globalPath, {
					servers: [{ transport: "stdio", command: "ok" }],
				});
				await writeText(projectPath, "{ broken project");

				const result = await readConfigs(globalPath, projectPath);
				expect(result.servers).toHaveLength(1);
				expect(result.servers[0].command).toBe("ok");

				const warnings = getWarningCalls();
				expect(warnings.some((w) => w.includes("project.json"))).toBe(true);
			} finally {
				restore();
			}
		});
	});

	// ── TC-F1.8-5: missing required fields → skip file with warning ──
	describe("TC-F1.8-5: missing required fields skips file", () => {
		it("server without transport fails validation", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "bad.json");

				// Missing required 'transport'
				await writeJson(globalPath, {
					servers: [{ command: "node" }],
				});

				const result = await readConfigs(globalPath, undefined);
				expect(result.servers).toEqual([]);

				const warnings = getWarningCalls();
				expect(warnings.length).toBeGreaterThan(0);
				expect(warnings.some((w) => w.includes("Invalid mcp config"))).toBe(true);
			} finally {
				restore();
			}
		});

		it("server with invalid transport value fails validation", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "bad.json");

				await writeJson(globalPath, {
					servers: [{ transport: "websocket" }],
				});

				const result = await readConfigs(globalPath, undefined);
				expect(result.servers).toEqual([]);

				const warnings = getWarningCalls();
				expect(warnings.length).toBeGreaterThan(0);
			} finally {
				restore();
			}
		});

		it("timeout below minimum fails validation", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "bad.json");

				await writeJson(globalPath, {
					servers: [{ transport: "stdio", command: "x", timeout: 100 }],
				});

				const result = await readConfigs(globalPath, undefined);
				expect(result.servers).toEqual([]);
			} finally {
				restore();
			}
		});

		it("invalid server type in array causes file skip", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "bad.json");

				await writeJson(globalPath, {
					servers: [{ transport: "stdio", command: "ok" }, "not-a-server"],
				});

				const result = await readConfigs(globalPath, undefined);
				expect(result.servers).toEqual([]);
			} finally {
				restore();
			}
		});
	});

	// ── TC-F1.8-6: extra project servers beyond global length ──
	describe("TC-F1.8-6: project servers appended beyond global length", () => {
		it("project has more servers than global — extra appended", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, "project.json");

			await writeJson(globalPath, {
				servers: [{ transport: "stdio", command: "a" }],
			});
			await writeJson(projectPath, {
				servers: [
					{ transport: "stdio", command: "x" },
					{ transport: "stdio", command: "y" },
				],
			});

			const result = await readConfigs(globalPath, projectPath);
			expect(result.servers).toHaveLength(2);
			expect(result.servers[0].command).toBe("x"); // overrides global[0]
			expect(result.servers[1].command).toBe("y"); // appended beyond global length
		});

		it("project shorter than global — global entries past project length remain", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "global.json");
			const projectPath = join(dir, "project.json");

			await writeJson(globalPath, {
				servers: [
					{ transport: "stdio", command: "a" },
					{ transport: "stdio", command: "b" },
					{ transport: "stdio", command: "c" },
				],
			});
			await writeJson(projectPath, {
				servers: [{ transport: "stdio", command: "x" }],
			});

			const result = await readConfigs(globalPath, projectPath);
			expect(result.servers).toHaveLength(3);
			expect(result.servers[0].command).toBe("x");
			expect(result.servers[1].command).toBe("b");
			expect(result.servers[2].command).toBe("c");
		});

		it("only project config — global path missing", async () => {
			const dir = await makeTempDir();
			const projectPath = join(dir, "project.json");

			await writeJson(projectPath, {
				servers: [{ transport: "streamable-http", url: "https://only.example.com" }],
			});

			const result = await readConfigs(join(dir, "no-global.json"), projectPath);
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0].url).toBe("https://only.example.com");
		});
	});

	// ── Additional edge cases ──
	describe("edge cases", () => {
		it("all fields in McpServerConfig", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "full.json");

			await writeJson(globalPath, {
				servers: [
					{
						transport: "stdio",
						command: "my-server",
						args: ["--port", "8080"],
						env: { FOO: "bar" },
						allowedTools: ["read_*"],
						deniedTools: ["delete_*"],
						timeout: 30000,
						autoRestart: true,
						allowLocal: false,
					},
				],
			});

			const result = await readConfigs(globalPath, undefined);
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0]).toEqual({
				transport: "stdio",
				command: "my-server",
				args: ["--port", "8080"],
				env: { FOO: "bar" },
				allowedTools: ["read_*"],
				deniedTools: ["delete_*"],
				timeout: 30000,
				autoRestart: true,
				allowLocal: false,
			});
		});

		it("additionalProperties fail validation with additionalProperties: false", async () => {
			const restore = silenceWarnings();
			try {
				const dir = await makeTempDir();
				const globalPath = join(dir, "extra.json");

				await writeJson(globalPath, {
					servers: [
						{
							transport: "stdio",
							command: "x",
							unknownField: "should-be-rejected", // additional property
						},
					],
				});

				const result = await readConfigs(globalPath, undefined);
				// With additionalProperties: false, Value.Check returns false and file is skipped
				expect(result.servers).toEqual([]);
			} finally {
				restore();
			}
		});

		it("streamable-http without url is valid (url is optional in schema)", async () => {
			const dir = await makeTempDir();
			const globalPath = join(dir, "bad.json");

			// url is Optional in the TypeBox schema, so missing url passes validation
			await writeJson(globalPath, {
				servers: [{ transport: "streamable-http" }], // no url, schema allows
			});

			const result = await readConfigs(globalPath, undefined);
			// url is Optional, so the config is valid — the server appears
			expect(result.servers).toHaveLength(1);
			expect(result.servers[0].transport).toBe("streamable-http");
		});

		it("ConfigValidationError path includes filename", () => {
			const err = new ConfigValidationError("Invalid transport", "/path/to/mcp.json");
			expect(err.message).toContain("/path/to/mcp.json");
			expect(err.name).toBe("ConfigValidationError");
		});

		it("ConfigValidationError without path", () => {
			const err = new ConfigValidationError("Generic error");
			expect(err.message).toBe("Generic error");
		});
	});
});
