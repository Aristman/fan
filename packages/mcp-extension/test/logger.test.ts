/**
 * Tests for F-3.7: Logging/metrics for MCP tool calls.
 *
 * Covers:
 * - formatLogEntry: whitelist-only serialization (no args/content)
 * - writeLog: directory creation, append semantics, graceful failure
 * - withLogging: success logging, error logging with rethrow
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatLogEntry, writeLog, withLogging } from "../src/logger.js";

// ──────────────────────────────────────────────────
// TC-F3.7-1: formatLogEntry — whitelist serialization
// ──────────────────────────────────────────────────

describe("F-3.7: formatLogEntry", () => {
	it("includes timestamp and event", () => {
		const line = formatLogEntry({
			timestamp: "2026-07-16T12:00:00.000Z",
			event: "tool_call_start",
		});
		const parsed = JSON.parse(line);
		expect(parsed.timestamp).toBe("2026-07-16T12:00:00.000Z");
		expect(parsed.event).toBe("tool_call_start");
	});

	it("includes optional fields when present", () => {
		const line = formatLogEntry({
			timestamp: "2026-07-16T12:00:00.000Z",
			event: "tool_call_end",
			serverId: "fs",
			toolName: "read_file",
			durationMs: 123,
			status: "success",
		});
		const parsed = JSON.parse(line);
		expect(parsed.serverId).toBe("fs");
		expect(parsed.toolName).toBe("read_file");
		expect(parsed.durationMs).toBe(123);
		expect(parsed.status).toBe("success");
	});

	it("omits undefined fields", () => {
		const line = formatLogEntry({
			timestamp: "2026-07-16T12:00:00.000Z",
			event: "tool_call_start",
		});
		const parsed = JSON.parse(line);
		expect("serverId" in parsed).toBe(false);
		expect("toolName" in parsed).toBe(false);
	});

	it("does NOT include arbitrary props (whitelist only)", () => {
		const entry: any = {
			timestamp: "2026-07-16T12:00:00.000Z",
			event: "tool_call_end",
			args: { path: "/tmp/x" },
			content: "secret data",
			serverId: "fs",
		};
		const line = formatLogEntry(entry);
		const parsed = JSON.parse(line);
		expect("args" in parsed).toBe(false);
		expect("content" in parsed).toBe(false);
		expect(parsed.serverId).toBe("fs");
	});

	it("includes errorMessage when present", () => {
		const line = formatLogEntry({
			timestamp: "2026-07-16T12:00:00.000Z",
			event: "tool_call_error",
			serverId: "fs",
			toolName: "read_file",
			durationMs: 42,
			status: "error",
			errorMessage: "file not found",
		});
		const parsed = JSON.parse(line);
		expect(parsed.errorMessage).toBe("file not found");
		expect(parsed.status).toBe("error");
	});
});

// ──────────────────────────────────────────────────
// TC-F3.7-2: writeLog — directory + file I/O
// ──────────────────────────────────────────────────

describe("F-3.7: writeLog", () => {
	let tempDir: string;

	// Helper: fresh temp dir per test
	async function freshDir(): Promise<string> {
		return await fs.mkdtemp(path.join(os.tmpdir(), "mcp-log-test-"));
	}

	it("creates log directory and writes entry", async () => {
		tempDir = await freshDir();
		const entry = {
			timestamp: new Date().toISOString(),
			event: "tool_call_start" as const,
			serverId: "fs",
			toolName: "read_file",
		};
		await writeLog(entry, tempDir);
		const today = entry.timestamp.slice(0, 10);
		const expected = path.join(tempDir, `mcp-${today}.log`);
		const content = await fs.readFile(expected, "utf8");
		expect(content).toContain("tool_call_start");
		expect(content).toContain("fs");
	});

	it("appends multiple entries to the same daily file", async () => {
		tempDir = await freshDir();
		for (let i = 0; i < 3; i++) {
			await writeLog(
				{
					timestamp: new Date().toISOString(),
					event: "tool_call_start",
				},
				tempDir,
			);
		}
		const today = new Date().toISOString().slice(0, 10);
		const content = await fs.readFile(
			path.join(tempDir, `mcp-${today}.log`),
			"utf8",
		);
		expect(content.split("\n").filter(Boolean)).toHaveLength(3);
	});

	it("handles write failure gracefully (no throw)", async () => {
		tempDir = await freshDir();
		const invalidDir = path.join(
			tempDir,
			"nonexistent",
			"deeply",
			"nested",
		);
		const entry = {
			timestamp: new Date().toISOString(),
			event: "tool_call_start" as const,
		};
		// Should not throw despite invalid path (mkdir will handle it)
		await expect(writeLog(entry, invalidDir)).resolves.not.toThrow();
	});
});

// ──────────────────────────────────────────────────
// TC-F3.7-3: withLogging — wrapper semantics
// ──────────────────────────────────────────────────

describe("F-3.7: withLogging", () => {
	async function readDailyLog(
		dir: string,
		date?: string,
	): Promise<string> {
		const today = date ?? new Date().toISOString().slice(0, 10);
		return fs.readFile(path.join(dir, `mcp-${today}.log`), "utf8");
	}

	it("logs success event with duration", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "mcp-log-test-"),
		);
		await withLogging(
			"fs",
			"read_file",
			async () => {
				await new Promise((r) => setTimeout(r, 10));
				return "ok";
			},
			tempDir,
		).then(() => {});

		const content = await readDailyLog(tempDir);
		expect(content).toContain("tool_call_start");
		expect(content).toContain("tool_call_end");
		expect(content).toContain("status");
		expect(content).toContain("durationMs");
		expect(content).toContain("success");
	});

	it("logs error event and rethrows", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "mcp-log-test-"),
		);
		await expect(
			withLogging(
				"fs",
				"read_file",
				async () => {
					throw new Error("boom");
				},
				tempDir,
			),
		).rejects.toThrow(/boom/);

		const content = await readDailyLog(tempDir);
		expect(content).toContain("tool_call_start");
		expect(content).toContain("tool_call_error");
		expect(content).toContain("boom");
		expect(content).toContain("durationMs");
	});

	it("logs start event before execution", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "mcp-log-test-"),
		);
		let started = false;
		await withLogging(
			"db",
			"query",
			async () => {
				// Read the log mid-execution — should already have the start event
				const content = await readDailyLog(tempDir);
				expect(content).toContain("tool_call_start");
				started = true;
				return "result";
			},
			tempDir,
		);

		expect(started).toBe(true);
		const content = await readDailyLog(tempDir);
		expect(content).toContain("tool_call_end");
	});
});
