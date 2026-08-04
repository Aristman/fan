/**
 * Auto-analysis (Stage C, part 1: F9 + F10) verification tests.
 *
 * Usage: bun run extensions/fan-session-analytics/scripts/verify-auto.ts
 *
 * Tests state management, weekly due logic, trend comparison,
 * F9 auto-analyze on shutdown, and F10 weekly batch.
 */

import { writeFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadState, saveState } from "../src/state.js";
import type { ExtensionState, BatchStats, AutoSummary } from "../src/state.js";
import { isWeeklyDue, compareTrends, formatTrendBlock } from "../src/weekly.js";
import type { TrendDelta } from "../src/weekly.js";
import { formatAutoSummaryLine } from "../src/auto.js";
import { handleSessionShutdown } from "../src/auto.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { AnalyticsConfig } from "../src/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  ✅ ${message}`);
		passed++;
	} else {
		console.log(`  ❌ ${message}`);
		failed++;
	}
}

// ============================================================================
// Mock helpers
// ============================================================================

function makeMockCtx(opts?: {
	sessionFile?: string;
	cwd?: string;
	hasUI?: boolean;
	confirmResult?: boolean;
	notifyMessages?: string[];
}) {
	const notifications: Array<{ message: string; type: string }> = [];
	return {
		sessionManager: {
			getSessionFile: () => opts?.sessionFile,
			getSessionDir: () => join(opts?.cwd || "/tmp/test", ".fan/sessions"),
			getSessionId: () => "mock-session-id",
			getCwd: () => opts?.cwd || "/tmp/test",
			getEntries: () => [],
			getBranch: () => [],
			getHeader: () => null,
			getLabel: () => "mock",
			getLeafId: () => "leaf-1",
			getLeafEntry: () => null,
			getEntry: () => null,
			getTree: () => ({ nodes: [], leafIds: [] }),
			getSessionName: () => "mock-session",
		},
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type: type || "info" });
			},
			confirm: async () => opts?.confirmResult ?? true,
			select: async () => undefined,
			input: async () => undefined,
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
		},
		hasUI: opts?.hasUI ?? true,
		cwd: opts?.cwd || "/tmp/test",
		modelRegistry: { find: () => undefined, getAvailable: () => [], refresh: () => {} },
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		notifications,
	};
}

function makeCfg(overrides?: Partial<AnalyticsConfig>): AnalyticsConfig {
	return {
		...DEFAULT_CONFIG,
		...overrides,
		autoAnalyze: {
			enabled: true,
			mode: "metrics" as const,
			...(overrides?.autoAnalyze || {}),
		},
		weeklyBatch: {
			enabled: true,
			silent: false,
			...(overrides?.weeklyBatch || {}),
		},
		// Always override reports.dir in tests to avoid writing to the real global dir
		reports: overrides?.reports ?? { dir: "test-reports" },
	};
}

/**
 * Create a minimal valid JSONL session file.
 */
async function createTestSession(dir: string, opts?: {
	selfReference?: boolean;
	minimal?: boolean;
}): Promise<string> {
	await mkdir(dir, { recursive: true });
	const ts = new Date().toISOString();
	const sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const fileTimestamp = ts.replace(/[:.]/g, "-");
	const filePath = join(dir, `${fileTimestamp}_${sessionId}.jsonl`);

	const entries: string[] = [];

	// Session header
	entries.push(JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: ts,
		cwd: "/tmp/test",
	}));

	if (opts?.minimal) {
		// Only 2 entries — below minEntries threshold
		entries.push(JSON.stringify({
			id: "e1",
			parentId: null,
			type: "message",
			timestamp: ts,
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		}));
	} else {
		// Normal session with 6+ entries
		entries.push(JSON.stringify({
			id: "e1",
			parentId: null,
			type: "message",
			timestamp: ts,
			message: { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
		}));
		entries.push(JSON.stringify({
			id: "e2",
			parentId: "e1",
			type: "message",
			timestamp: ts,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "auth.ts" } }],
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		}));
		entries.push(JSON.stringify({
			id: "e3",
			parentId: "e2",
			type: "message",
			timestamp: ts,
			message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "auth code here" }], isError: false },
		}));
		entries.push(JSON.stringify({
			id: "e4",
			parentId: "e3",
			type: "message",
			timestamp: ts,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "edit", arguments: { path: "auth.ts", edits: [{ oldText: "old", newText: "new" }] } }],
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		}));
		entries.push(JSON.stringify({
			id: "e5",
			parentId: "e4",
			type: "message",
			timestamp: ts,
			message: { role: "toolResult", toolCallId: "tc2", toolName: "edit", content: [{ type: "text", text: "edited" }], isError: false },
		}));

		if (opts?.selfReference) {
			// Add a session_analyze call (self-reference)
			entries.push(JSON.stringify({
				id: "e6",
				parentId: "e5",
				type: "message",
				timestamp: ts,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc3", name: "session_analyze", arguments: { target: "last" } }],
					usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
			}));
		}

		entries.push(JSON.stringify({
			id: opts?.selfReference ? "e7" : "e6",
			parentId: opts?.selfReference ? "e6" : "e5",
			type: "message",
			timestamp: ts,
			message: { role: "assistant", content: [{ type: "text", text: "Fixed the login bug." }] },
		}));
	}

	await writeFile(filePath, entries.join("\n") + "\n", "utf-8");
	return filePath;
}

// ============================================================================
// STATE TESTS
// ============================================================================

async function testState() {
	console.log("\n=== State Tests ===\n");

	const testDir = join(tmpdir(), `fan-state-test-${Date.now()}`);
	await mkdir(testDir, { recursive: true });

	try {
		// Test 1: Save and load round-trip (with new `analyzed` field)
		{
			console.log("Test: state save/load round-trip");
			const state: ExtensionState = {
				lastBatchRun: "2026-08-01T10:00:00.000Z",
				lastAutoSummary: {
					sessionId: "test-123",
					score: 85,
					findingsHigh: 1,
					findingsMedium: 2,
					findingsLow: 3,
					reportPath: "/tmp/report.md",
					analyzedAt: "2026-08-01T10:00:00.000Z",
					loopCount: 0,
					errorCount: 2,
					overheadPercent: 30,
				},
				analyzedMtimes: {},
				analyzed: {
					"/path/to/session.jsonl": { mtime: 1234567890, analyzedAt: "2026-08-01T10:00:00.000Z", reportPath: "/tmp/report.md" },
				},
			};

			const saved = await saveState(testDir, state);
			assert(saved === true, "saveState returns true");

			const loaded = await loadState(testDir);
			assert(loaded.lastBatchRun === "2026-08-01T10:00:00.000Z", "lastBatchRun preserved");
			assert(loaded.lastAutoSummary?.score === 85, "lastAutoSummary.score preserved");
			assert(loaded.lastAutoSummary?.loopCount === 0, "loopCount preserved");
			assert(loaded.lastAutoSummary?.errorCount === 2, "errorCount preserved");
			assert(loaded.analyzed?.["/path/to/session.jsonl"]?.mtime === 1234567890, "analyzed entry preserved");
			assert(loaded.analyzed?.["/path/to/session.jsonl"]?.analyzedAt === "2026-08-01T10:00:00.000Z", "analyzedAt preserved");
		}

		// Test 1b: Migration — old analyzedMtimes → new analyzed
		{
			console.log("Test: analyzedMtimes migration");
			await writeFile(join(testDir, "state.json"), JSON.stringify({
				analyzedMtimes: { "/old/path.jsonl": 9999999 },
			}, null, 2), "utf-8");

			const loaded = await loadState(testDir);
			assert(loaded.analyzed !== undefined, "analyzed field created");
			assert(loaded.analyzed?.["/old/path.jsonl"]?.mtime === 9999999, "mtime migrated from analyzedMtimes");
			assert(loaded.analyzed?.["/old/path.jsonl"]?.analyzedAt === "", "analyzedAt is empty for migrated entries");
		}

		// Test 2: Broken JSON → empty state
		{
			console.log("Test: broken JSON → empty state");
			await writeFile(join(testDir, "state.json"), "{broken json!!", "utf-8");
			const loaded = await loadState(testDir);
			assert(loaded.analyzed !== undefined, "analyzed exists on empty state");
			assert(Object.keys(loaded.analyzed!).length === 0, "analyzed is empty");
			assert(loaded.lastBatchRun === undefined, "lastBatchRun is undefined");
		}

		// Test 3: Missing file → empty state
		{
			console.log("Test: missing file → empty state");
			const missingDir = join(tmpdir(), `fan-state-missing-${Date.now()}`);
			const loaded = await loadState(missingDir);
			assert(loaded.analyzed !== undefined, "analyzed exists");
			assert(loaded.lastAutoSummary === undefined, "lastAutoSummary is undefined");
		}
	} finally {
		await rm(testDir, { recursive: true, force: true });
	}
}

// ============================================================================
// WEEKLY DUE LOGIC TESTS
// ============================================================================

async function testWeeklyDue() {
	console.log("\n=== Weekly Due Logic Tests ===\n");

	// Test 4: No lastBatchRun → due
	{
		console.log("Test: no lastBatchRun → due");
		const state: ExtensionState = { analyzedMtimes: {} };
		assert(isWeeklyDue(state) === true, "Weekly is due when no lastBatchRun");
	}

	// Test 5: 3 days ago → not due
	{
		console.log("Test: 3 days ago → not due");
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		const state: ExtensionState = { analyzedMtimes: {}, lastBatchRun: threeDaysAgo };
		assert(isWeeklyDue(state) === false, "Weekly is NOT due at 3 days");
	}

	// Test 6: 8 days ago → due
	{
		console.log("Test: 8 days ago → due");
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const state: ExtensionState = { analyzedMtimes: {}, lastBatchRun: eightDaysAgo };
		assert(isWeeklyDue(state) === true, "Weekly IS due at 8 days");
	}

	// Test 7: User declined → deferred for 1 day
	{
		console.log("Test: deferred after decline → not due within 1 day");
		const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const state: ExtensionState = {
			analyzedMtimes: {},
			weeklyDeferredUntil: tomorrow,
		};
		assert(isWeeklyDue(state) === false, "Not due when deferred to tomorrow");
	}

	// Test 8: Deferred but deferral expired → due
	{
		console.log("Test: deferral expired → due");
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const state: ExtensionState = {
			analyzedMtimes: {},
			weeklyDeferredUntil: yesterday,
		};
		assert(isWeeklyDue(state) === true, "Due when deferral expired");
	}
}

// ============================================================================
// TREND TESTS
// ============================================================================

async function testTrend() {
	console.log("\n=== Trend Comparison Tests ===\n");

	// Test 9: Basic trend delta
	{
		console.log("Test: trend delta calculation");
		const prev: BatchStats = {
			avgScore: 75,
			sessionCount: 10,
			findingsBySeverity: { high: 5, medium: 10, low: 20 },
			topDetectors: [{ detectorId: "D1", count: 8 }],
			periodStart: "2026-07-01T00:00:00.000Z",
			periodEnd: "2026-07-08T00:00:00.000Z",
		};
		const curr: BatchStats = {
			avgScore: 82,
			sessionCount: 12,
			findingsBySeverity: { high: 3, medium: 8, low: 25 },
			topDetectors: [
				{ detectorId: "D2", count: 10 },
				{ detectorId: "D1", count: 7 },
				{ detectorId: "D11", count: 5 },
			],
			periodStart: "2026-07-08T00:00:00.000Z",
			periodEnd: "2026-07-15T00:00:00.000Z",
		};

		const delta = compareTrends(prev, curr);
		assert(delta.avgScoreDelta === 7, `avgScoreDelta = +7: got ${delta.avgScoreDelta}`);
		assert(delta.findingsHighDelta === -2, `findingsHighDelta = -2: got ${delta.findingsHighDelta}`);
		assert(delta.findingsMediumDelta === -2, `findingsMediumDelta = -2: got ${delta.findingsMediumDelta}`);
		assert(delta.findingsLowDelta === 5, `findingsLowDelta = +5: got ${delta.findingsLowDelta}`);
		assert(delta.topDetectors.length === 3, `3 top detectors: got ${delta.topDetectors.length}`);
		assert(delta.topDetectors[0].detectorId === "D2", `Top detector is D2: got ${delta.topDetectors[0].detectorId}`);
	}

	// Test 10: Trend format
	{
		console.log("Test: trend block format");
		const delta: TrendDelta = {
			avgScoreDelta: 7,
			findingsHighDelta: -2,
			findingsMediumDelta: 0,
			findingsLowDelta: 5,
			topDetectors: [{ detectorId: "D1", count: 10 }],
		};
		const block = formatTrendBlock(delta);
		assert(block.includes("↑"), "Contains up arrow for positive score");
		assert(block.includes("↓"), "Contains down arrow for negative findings (improvement)");
		assert(block.includes("→"), "Contains right arrow for zero delta");
		assert(block.includes("+7"), "Contains +7 for score delta");
		assert(block.includes("-2"), "Contains -2 for high findings delta");
		assert(block.includes("D1 (10)"), "Contains top detector");
	}
}

// ============================================================================
// F9 AUTO-ANALYZE TESTS
// ============================================================================

async function testAutoAnalyze() {
	console.log("\n=== F9 Auto-Analyze Tests ===\n");

	const testBase = join(tmpdir(), `fan-auto-test-${Date.now()}`);
	const sessionsDir = join(testBase, "sessions");
	const extDir = join(testBase, "ext");
	await mkdir(sessionsDir, { recursive: true });
	await mkdir(extDir, { recursive: true });

	// reports.dir is relative to cwd (testBase), so use just a folder name
	const reportsRelDir = "reports";

	try {
		// Test 11: F9 shutdown → analysis runs, lastAutoSummary written
		{
			console.log("Test: shutdown → auto-analyze runs");
			const sessionPath = await createTestSession(sessionsDir);

			const cfg = makeCfg({
				reports: { dir: reportsRelDir },
			});

			const ctx = makeMockCtx({
				sessionFile: sessionPath,
				cwd: testBase,
			});

			await handleSessionShutdown(
				{ type: "session_shutdown" },
				ctx as any,
				extDir,
				cfg,
			);

			// Check state was written
			const state = await loadState(extDir);
			assert(state.lastAutoSummary !== undefined, "lastAutoSummary exists after shutdown");
			assert(state.lastAutoSummary!.score >= 0, `Score >= 0: ${state.lastAutoSummary!.score}`);
			assert(state.lastAutoSummary!.reportPath !== "", "Report path is set");

			// Verify report file exists
			try {
				const reportStat = await stat(state.lastAutoSummary!.reportPath);
				assert(reportStat.size > 0, "Report file exists and non-empty");
			} catch {
				assert(false, "Report file should exist");
			}
		}

		// Test 12: Garbage session (minimal, < minEntries) → skip
		{
			console.log("Test: garbage session → skip");
			const sessionPath = await createTestSession(sessionsDir, { minimal: true });

			// Clear state first
			await saveState(extDir, { analyzedMtimes: {} });

			const cfg = makeCfg();
			const ctx = makeMockCtx({ sessionFile: sessionPath, cwd: testBase });

			await handleSessionShutdown(
				{ type: "session_shutdown" },
				ctx as any,
				extDir,
				cfg,
			);

			const state = await loadState(extDir);
			assert(state.lastAutoSummary === undefined, "lastAutoSummary NOT set for garbage session");
		}

		// Test 13: Self-reference session → skip
		{
			console.log("Test: self-reference session → skip");
			const sessionPath = await createTestSession(sessionsDir, { selfReference: true });

			// Clear state
			await saveState(extDir, { analyzedMtimes: {} });

			const cfg = makeCfg();
			const ctx = makeMockCtx({ sessionFile: sessionPath, cwd: testBase });

			await handleSessionShutdown(
				{ type: "session_shutdown" },
				ctx as any,
				extDir,
				cfg,
			);

			const state = await loadState(extDir);
			assert(state.lastAutoSummary === undefined, "lastAutoSummary NOT set for self-referencing session");
		}

		// Test 14: autoAnalyze.enabled: false → skip
		{
			console.log("Test: autoAnalyze disabled → skip");
			const sessionPath = await createTestSession(sessionsDir);

			// Clear state
			await saveState(extDir, { analyzedMtimes: {} });

			const cfg = makeCfg({
				autoAnalyze: { enabled: false, mode: "metrics" },
			});
			const ctx = makeMockCtx({ sessionFile: sessionPath, cwd: testBase });

			await handleSessionShutdown(
				{ type: "session_shutdown" },
				ctx as any,
				extDir,
				cfg,
			);

			const state = await loadState(extDir);
			assert(state.lastAutoSummary === undefined, "lastAutoSummary NOT set when disabled");
		}

		// Test 15: No session file → skip
		{
			console.log("Test: no session file → skip (no crash)");
			await saveState(extDir, { analyzedMtimes: {} });

			const cfg = makeCfg();
			const ctx = makeMockCtx({ sessionFile: undefined, cwd: testBase });

			// Should not throw
			await handleSessionShutdown(
				{ type: "session_shutdown" },
				ctx as any,
				extDir,
				cfg,
			);

			const state = await loadState(extDir);
			assert(state.lastAutoSummary === undefined, "No crash when sessionFile undefined");
		}
	} finally {
		await rm(testBase, { recursive: true, force: true });
	}
}

// ============================================================================
// ONE-LINER FORMAT TEST
// ============================================================================

async function testOneLinerFormat() {
	console.log("\n=== One-Liner Format Tests ===\n");

	// Test 16: Format with all fields
	{
		console.log("Test: format with all metrics");
		const summary: AutoSummary = {
			sessionId: "test-session",
			score: 87,
			findingsHigh: 1,
			findingsMedium: 2,
			findingsLow: 3,
			reportPath: ".fan/reports/session-analytics/test.md",
			analyzedAt: "2026-08-01T10:00:00.000Z",
			loopCount: 0,
			errorCount: 2,
			overheadPercent: 45,
		};
		const line = formatAutoSummaryLine(summary);
		assert(line.includes("87/100"), "Contains score");
		assert(line.includes("петель: 0"), "Contains loop count");
		assert(line.includes("ошибок: 2"), "Contains error count");
		assert(line.includes("overhead: 45%"), "Contains overhead");
		assert(line.includes("отчёт:"), "Contains report path label");
		console.log(`\n  📝 Example: ${line}\n`);
	}

	// Test 17: Format without optional metrics
	{
		console.log("Test: format without optional metrics");
		const summary: AutoSummary = {
			sessionId: "test-session",
			score: 92,
			findingsHigh: 0,
			findingsMedium: 0,
			findingsLow: 1,
			reportPath: "/tmp/report.md",
			analyzedAt: "2026-08-01T10:00:00.000Z",
		};
		const line = formatAutoSummaryLine(summary);
		assert(line.includes("92/100"), "Contains score");
		assert(line.includes("петель: 0"), "Contains loop count (default 0)");
		assert(line.includes("ошибок: 0"), "Contains error count (default 0)");
		assert(!line.includes("overhead"), "No overhead when undefined");
	}
}

// ============================================================================
// PATHS / resolveReportsDir TESTS
// ============================================================================

import { resolveReportsDir, getReportsRoot, _resetCache } from "../src/paths.js";
import { runPipeline } from "../src/pipeline.js";
import { getSessionsDir } from "../src/parser.js";

async function testResolveReportsDir() {
	console.log("\n=== resolveReportsDir Tests ===\n");

	// Test: "global" → ~/.fan/reports/session-analytics
	{
		console.log("Test: 'global' → global reports root");
		_resetCache();
		const cfg = { ...DEFAULT_CONFIG, reports: { dir: "global" } };
		const result = resolveReportsDir(cfg, "/some/cwd");
		const expected = getReportsRoot();
		assert(result === expected, `resolveReportsDir('global') = ${result}, expected ${expected}`);
		assert(result.includes("reports") && result.includes("session-analytics"), `Path contains reports/session-analytics: ${result}`);
	}

	// Test: relative path → cwd-based
	{
		console.log("Test: relative path → cwd-based");
		const cfg = { ...DEFAULT_CONFIG, reports: { dir: ".fan/reports/session-analytics" } };
		const result = resolveReportsDir(cfg, "/home/user/project");
		const normalized = result.replace(/\\/g, "/");
		assert(normalized.includes("/home/user/project"), `Relative path resolved relative to cwd: ${result}`);
		assert(result.endsWith("session-analytics"), `Ends with session-analytics: ${result}`);
	}

	// Test: absolute path → used as-is
	{
		console.log("Test: absolute path → as-is");
		const absPath = "/tmp/custom/reports";
		const cfg = { ...DEFAULT_CONFIG, reports: { dir: absPath } };
		const result = resolveReportsDir(cfg, "/some/cwd");
		assert(result === absPath, `Absolute path preserved: ${result}`);
	}
}

// ============================================================================
// INCREMENTAL ANALYSIS TESTS
// ============================================================================

async function testIncrementalAnalysis() {
	console.log("\n=== Incremental Analysis Tests ===\n");

	const testBase = join(tmpdir(), `fan-incremental-${Date.now()}`);
	const sessionsDir = join(testBase, "sessions");
	const extDir = join(testBase, "ext");
	const reportsDir = join(testBase, "reports");
	await mkdir(sessionsDir, { recursive: true });
	await mkdir(extDir, { recursive: true });

	const cfg = makeCfg({ reports: { dir: reportsDir } });

	// Create a session and track its path
	const sessionPath = await createTestSession(sessionsDir);

	try {
		// Test: mark after analysis (explicit path target)
		{
			console.log("Test: mark after analysis → explicit path gets mark");

			// First run — analyze via explicit path
			const result1 = await runPipeline({
				target: sessionPath,
				mode: "metrics",
				cwd: testBase,
				cfg,
				extensionDir: extDir,
			});
			assert(result1.results.length === 1, `First run: 1 result, got ${result1.results.length}`);

			// Verify state has the analyzed entry
			const state = await loadState(extDir);
			assert(state.analyzed?.[sessionPath] !== undefined, "Session marked in state after analysis");
			assert(state.analyzed?.[sessionPath]?.mtime !== undefined, "mtime is set");
			assert(state.analyzed?.[sessionPath]?.analyzedAt !== undefined, "analyzedAt is set");
		}

		// Test: explicit target with existing mark → info note
		{
			console.log("Test: explicit target → info note for already analyzed");
			const result = await runPipeline({
				target: sessionPath,
				mode: "metrics",
				cwd: testBase,
				cfg,
				extensionDir: extDir,
			});
			assert(result.results.length === 1, `Explicit target: 1 result, got ${result.results.length}`);
			const skipped = result.results[0].skipped || "";
			assert(skipped.includes("уже анализировалась"), `Explicit target: info note present: "${skipped}"`);
		}

		// Test: changed mtime → re-analyze (with new mark)
		{
			console.log("Test: changed mtime → re-analyze with updated mark");
			// Modify the session file to change its mtime
			await (await import("node:fs/promises")).appendFile(sessionPath, "\n", "utf-8");
			// Small delay to ensure mtime differs
			await new Promise((r) => setTimeout(r, 50));

			const result = await runPipeline({
				target: sessionPath,
				mode: "metrics",
				cwd: testBase,
				cfg,
				extensionDir: extDir,
			});
			assert(result.results.length === 1, `After mtime change: 1 result, got ${result.results.length}`);

			// Verify the mark was updated
			const state = await loadState(extDir);
			assert(state.analyzed?.[sessionPath] !== undefined, "Session re-marked after mtime change");
		}

		// Test: dir mode with force: true analyzes despite marks
		// (We can't test dir scanning with tmpdir, but we can test force flag propagation)
		{
			console.log("Test: force: true flag propagates correctly");
			// This tests that force flag is accepted and doesn't crash
			const result = await runPipeline({
				target: sessionPath,
				mode: "metrics",
				cwd: testBase,
				cfg,
				extensionDir: extDir,
				force: true,
			});
			assert(result.results.length === 1, `Force: 1 result, got ${result.results.length}`);
		}
	} finally {
		await rm(testBase, { recursive: true, force: true });
	}
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log("=== FAN Session Analytics — Auto (F9 + F10) Verification ===");
	console.log(`Date: ${new Date().toISOString()}`);

	await testState();
	await testWeeklyDue();
	await testTrend();
	await testAutoAnalyze();
	await testOneLinerFormat();
	await testResolveReportsDir();
	await testIncrementalAnalysis();

	console.log("\n=== Summary ===");
	console.log(`Passed: ${passed}`);
	console.log(`Failed: ${failed}`);
	console.log(`Total: ${passed + failed}`);

	if (failed > 0) {
		console.log("\n❌ SOME TESTS FAILED");
		process.exit(1);
	} else {
		console.log("\n✅ ALL TESTS PASSED");
	}
}

main().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
