/**
 * Smoke test for fan-session-analytics extension.
 * Imports and tests REAL functions from src/ — no inlined logic.
 *
 * Usage: bun run extensions/fan-session-analytics/scripts/smoke.ts
 *
 * Module resolution: bun resolves @seaagents/fan-coding-agent from root node_modules
 * (workspace symlinks). The smoke test imports from ../src/ which transitively
 * pulls in the workspace packages.
 */

import { stat, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// Import REAL functions from src/
import { parseSessionFile, getSessionsDir, isGarbagePath, isGarbageSession } from "../src/parser.js";
import { buildTrajectory } from "../src/normalizer.js";
import { ALL_DETECTORS } from "../src/detectors/index.js";
import { calculateScore } from "../src/score.js";
import { loadConfig } from "../src/config.js";
import { trySqliteTokens } from "../src/detectors/d9-tokens-cost.js";
import type { Trajectory, Finding, SessionScore, AnalyticsConfig } from "../src/types.js";

const SESSIONS_DIR = join(homedir(), ".fan", "agent", "sessions", "--C--Users-User--");
const CWD = "C:\\Users\\User";

// Test sessions: small, medium, large
const TEST_FILES = [
	"2026-06-27T09-22-14-191Z_393a7679-abbc-44e9-8291-6ab186e3a3e0.jsonl",
	"2026-06-03T18-10-30-734Z_56a211a3-af15-4499-838a-6c3ca238e7de.jsonl",
	"2026-05-25T20-14-02-656Z_d4c01817-1d4d-48e9-ad71-c2e5f9ea752d.jsonl",
];

const LARGE_SESSION_FILE = TEST_FILES[2]; // d4c01817 — should have 78 toolCalls
const EXPECTED_LARGE_TOOL_CALLS = 78;

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

async function testGetSessionsDir(): Promise<void> {
	console.log("\n=== Test: getSessionsDir ===");

	const result = getSessionsDir(CWD);
	const expected = join(homedir(), ".fan", "agent", "sessions", "--C--Users-User--");
	assert(result === expected, `getSessionsDir("${CWD}") = "${result}" (expected "${expected}")`);

	// Additional test cases
	const linuxDir = getSessionsDir("/home/user/project");
	assert(
		linuxDir.includes("--home-user-project--"),
		`getSessionsDir("/home/user/project") contains "--home-user-project--": got "${linuxDir}"`
	);

	const trailingSlash = getSessionsDir("C:\\Users\\User\\");
	assert(
		trailingSlash.includes("--C--Users-User---") || trailingSlash.includes("--C--Users-User--"),
		`getSessionsDir("C:\\\\Users\\\\User\\\\") = "${trailingSlash}"`
	);
}

async function testToolCallCount(cfg: AnalyticsConfig): Promise<void> {
	console.log("\n=== Test: toolCall count on large session ===");

	const filePath = join(SESSIONS_DIR, LARGE_SESSION_FILE);
	const parsed = await parseSessionFile(filePath);
	const trajectory = buildTrajectory(parsed);

	const toolCallCount = trajectory.steps.filter((s) => s.kind === "tool_call").length;
	console.log(`  Large session (${LARGE_SESSION_FILE}):`);
	console.log(`    Steps: ${trajectory.steps.length}`);
	console.log(`    Tool calls: ${toolCallCount}`);
	console.log(`    Expected: ${EXPECTED_LARGE_TOOL_CALLS}`);

	assert(
		toolCallCount === EXPECTED_LARGE_TOOL_CALLS,
		`toolCall count = ${toolCallCount} (expected ${EXPECTED_LARGE_TOOL_CALLS})`
	);
}

async function testFileIntegrity(): Promise<void> {
	console.log("\n=== Test: File integrity ===");

	// Record mtimes before
	const mtimesBefore = new Map<string, { mtime: number; size: number }>();
	for (const f of TEST_FILES) {
		const s = await stat(join(SESSIONS_DIR, f));
		mtimesBefore.set(f, { mtime: s.mtimeMs, size: s.size });
	}

	// Parse all sessions (read-only operations)
	for (const f of TEST_FILES) {
		const filePath = join(SESSIONS_DIR, f);
		const parsed = await parseSessionFile(filePath);
		buildTrajectory(parsed);
	}

	// Verify files unchanged
	for (const f of TEST_FILES) {
		const s = await stat(join(SESSIONS_DIR, f));
		const before = mtimesBefore.get(f)!;
		assert(s.mtimeMs === before.mtime, `${f}: mtime unchanged`);
		assert(s.size === before.size, `${f}: size unchanged`);
	}
}

async function testPipeline(cfg: AnalyticsConfig): Promise<void> {
	console.log("\n=== Test: Full pipeline on 3 sessions ===");

	const reportDir = join(CWD, ".fan", "reports", "session-analytics");
	await mkdir(reportDir, { recursive: true });

	for (const file of TEST_FILES) {
		const filePath = join(SESSIONS_DIR, file);
		console.log(`\n  --- ${file} ---`);

		try {
			const fileStat = await stat(filePath);
			console.log(`  Size: ${(fileStat.size / 1024).toFixed(1)} KB`);

			// Parse
			const parsed = await parseSessionFile(filePath);
			console.log(`  Lines: ${parsed.totalLines} total, ${parsed.validLines} valid, ${parsed.invalidLines} invalid`);

			// Build trajectory (uses REAL buildTrajectory with all toolCalls)
			const trajectory = buildTrajectory(parsed);
			console.log(`  Session ID: ${trajectory.sessionId}`);
			console.log(`  Steps: ${trajectory.steps.length}`);
			console.log(`  Tool calls: ${trajectory.steps.filter(s => s.kind === "tool_call").length}`);
			console.log(`  Skills: ${trajectory.skillsActivated.join(", ") || "none"}`);
			console.log(`  Workers: ${trajectory.workersSpawned.map(w => `${w.type}(${w.verdict || "?"})`).join(", ") || "none"}`);
			console.log(`  Compactions: ${trajectory.compactions}`);

			// Pre-fetch SQLite tokens (best-effort)
			trajectory.dbTokensInfo = await trySqliteTokens(trajectory.sessionId);
			console.log(`  DB tokens: ${trajectory.dbTokensInfo ? `yes (${trajectory.dbTokensInfo.source})` : "no (fallback to JSONL)"}`);

			// Run detectors (async)
			const allFindings: Finding[] = [];
			for (const detector of ALL_DETECTORS) {
				try {
					const findings = await detector.fn(trajectory, cfg);
					allFindings.push(...findings);
				} catch (err) {
					allFindings.push({
						detectorId: detector.id,
						severity: "low",
						title: `Detector ${detector.id} failed: ${err instanceof Error ? err.message : String(err)}`,
						evidence: { entryIds: [], excerpt: "" },
					});
				}
			}

			// Calculate score
			const score = calculateScore(allFindings, trajectory.truncated);
			console.log(`\n  Score: ${score.total}/100`);
			console.log(`  Findings: ${score.metrics["findingsHigh"]}H / ${score.metrics["findingsMedium"]}M / ${score.metrics["findingsLow"]}L`);

			// Print top findings
			const topFindings = allFindings
				.filter(f => f.severity === "high" || f.severity === "medium")
				.slice(0, 5);
			if (topFindings.length > 0) {
				console.log(`  Top findings:`);
				for (const f of topFindings) {
					const icon = f.severity === "high" ? "🔴" : "🟡";
					console.log(`    ${icon} [${f.detectorId}] ${f.title}`);
				}
			}

			// Tool call summary
			const toolCounts = new Map<string, number>();
			for (const step of trajectory.steps) {
				if (step.kind === "tool_call" && step.toolName) {
					toolCounts.set(step.toolName, (toolCounts.get(step.toolName) || 0) + 1);
				}
			}
			if (toolCounts.size > 0) {
				console.log(`  Tool summary:`);
				const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
				for (const [name, count] of sorted.slice(0, 10)) {
					console.log(`    ${name}: ${count}`);
				}
			}

		} catch (err) {
			console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
			failed++;
		}
	}
}

async function main() {
	console.log("=== FAN Session Analytics — Smoke Test ===");
	console.log(`Date: ${new Date().toISOString()}`);
	console.log(`Sessions dir: ${SESSIONS_DIR}`);
	console.log("");

	// Load config
	const cfg = await loadConfig(join(homedir(), "projects", "agents", "fan", "extensions", "fan-session-analytics"), CWD);

	// Run tests
	await testGetSessionsDir();
	await testToolCallCount(cfg);
	await testFileIntegrity();
	await testPipeline(cfg);

	// Summary
	console.log("\n=== Summary ===");
	console.log(`Passed: ${passed}`);
	console.log(`Failed: ${failed}`);
	console.log(`Total: ${passed + failed}`);

	if (failed > 0) {
		console.log("\n❌ SMOKE TEST FAILED");
		process.exit(1);
	} else {
		console.log("\n✅ ALL TESTS PASSED");
	}
}

main().catch((err) => {
	console.error("Smoke test error:", err);
	process.exit(1);
});
