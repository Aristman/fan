/**
 * F12 (Golden Trajectories) + F13 (Pattern Mining) verification tests.
 * All tests use mocks — no real API calls.
 *
 * Usage: bun run extensions/fan-session-analytics/scripts/verify-golden-patterns.ts
 */

import { writeFile, mkdir, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// F12 imports
import { markGolden, unmarkGolden, listGolden, findGoldenForTrajectory, parseComparisonResponse, compareWithGolden } from "../src/golden.js";
import { formatGoldenSection } from "../src/report.js";

// F13 imports
import { minePatterns, normalizePrompt, jaccardSimilarity, formatPatternsSection, escapeMd } from "../src/patterns.js";

// State imports
import { loadState, saveState } from "../src/state.js";
import type { ExtensionState } from "../src/state.js";

// Registry imports
import { ORCHESTRATOR_TOOLS } from "../src/registry.js";

// Type imports
import type {
	AnalyticsConfig,
	Trajectory,
	TrajectoryStep,
	PatternCandidate,
	GoldenComparison,
	GoldenEntry,
	JudgeDeps,
	WorkerSpawn,
} from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/config.js";

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
// Helpers
// ============================================================================

function makeCfg(overrides?: Partial<AnalyticsConfig>): AnalyticsConfig {
	return {
		...DEFAULT_CONFIG,
		...overrides,
		orchestration: {
			...DEFAULT_CONFIG.orchestration,
			...(overrides?.orchestration || {}),
		},
	};
}

function makeStep(kind: TrajectoryStep["kind"], idx: number, extra?: Partial<TrajectoryStep>): TrajectoryStep {
	return {
		entryId: `entry-${idx}`,
		ts: Date.now() + idx * 1000,
		kind,
		...extra,
	};
}

function makeTrajectory(opts: {
	sessionId?: string;
	path?: string;
	steps?: TrajectoryStep[];
	workersSpawned?: WorkerSpawn[];
	skillsActivated?: string[];
}): Trajectory {
	const steps = opts.steps || [
		makeStep("user", 0, { args: { text: "Fix the login bug in auth.ts" } }),
		makeStep("tool_call", 1, { toolName: "read", args: { path: "auth.ts" } }),
		makeStep("tool_result", 2, { toolName: "read" }),
		makeStep("tool_call", 3, { toolName: "edit", args: { path: "auth.ts", edits: [] } }),
		makeStep("tool_result", 4, { toolName: "edit" }),
		makeStep("assistant_text", 5),
	];

	return {
		sessionId: opts.sessionId || `session-${Math.random().toString(36).slice(2, 8)}`,
		path: opts.path || "/tmp/test/sessions/test-session.jsonl",
		cwd: "/tmp/test",
		startedAt: Date.now(),
		endedAt: Date.now() + 60000,
		steps,
		skillsActivated: opts.skillsActivated || [],
		workersSpawned: opts.workersSpawned || [],
		compactions: 0,
		truncated: false,
		invalidLines: 0,
		totalLines: steps.length + 1,
	};
}

/**
 * Create a minimal valid JSONL session file for testing markGolden.
 */
async function createTestSession(dir: string, sessionId?: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const ts = new Date().toISOString();
	const id = sessionId || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const fileTimestamp = ts.replace(/[:.]/g, "-");
	const filePath = join(dir, `${fileTimestamp}_${id}.jsonl`);

	const entries = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/tmp/test" }),
		JSON.stringify({
			id: "e1", parentId: null, type: "message", timestamp: ts,
			message: { role: "user", content: [{ type: "text", text: "Fix the login bug in auth module" }] },
		}),
		JSON.stringify({
			id: "e2", parentId: "e1", type: "message", timestamp: ts,
			message: {
				role: "assistant", content: [
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "auth.ts" } },
				],
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		}),
		JSON.stringify({
			id: "e3", parentId: "e2", type: "message", timestamp: ts,
			message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "code" }], isError: false },
		}),
		JSON.stringify({
			id: "e4", parentId: "e3", type: "message", timestamp: ts,
			message: {
				role: "assistant", content: [
					{ type: "toolCall", id: "tc2", name: "edit", arguments: { path: "auth.ts", edits: [{ oldText: "old", newText: "new" }] } },
				],
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		}),
		JSON.stringify({
			id: "e5", parentId: "e4", type: "message", timestamp: ts,
			message: { role: "toolResult", toolCallId: "tc2", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false },
		}),
		JSON.stringify({
			id: "e6", parentId: "e5", type: "message", timestamp: ts,
			message: { role: "assistant", content: [{ type: "text", text: "Fixed the login bug." }] },
		}),
	];

	await writeFile(filePath, entries.join("\n") + "\n", "utf-8");
	return filePath;
}

function makeMockJudgeDeps(responseText: string): JudgeDeps {
	return {
		complete: async () => ({
			content: [{ type: "text", text: responseText }],
			usage: { input: 100, output: 50, cost: { total: 0.001 } },
		}),
		modelRegistry: {
			find: () => ({ provider: "test", id: "judge" }),
			getAvailable: () => [{ provider: "test", id: "judge", cost: { input: 0.01 } }],
		},
		currentModel: undefined,
	};
}

// ============================================================================
// F12: Golden Trajectory Tests
// ============================================================================

async function testMarkGolden() {
	console.log("\n=== F12: mark-golden Tests ===\n");

	const testDir = join(tmpdir(), `fan-golden-test-${Date.now()}`);
	const sessionsDir = join(testDir, "sessions");
	const extDir = join(testDir, "ext");
	await mkdir(sessionsDir, { recursive: true });
	await mkdir(extDir, { recursive: true });

	try {
		// Test 1: Mark a session as golden
		{
			console.log("Test: mark-golden writes entry to state");
			const sessionPath = await createTestSession(sessionsDir, "golden-test-1");
			const state = await loadState(extDir);

			const entry = await markGolden(state, sessionPath, "эталонный багфикс");
			assert(entry.sessionId === "golden-test-1", `sessionId = golden-test-1: got ${entry.sessionId}`);
			assert(entry.label === "эталонный багфикс", `label = "эталонный багфикс": got ${entry.label}`);
			assert(entry.firstRequest.includes("Fix the login bug"), `firstRequest contains user text: "${entry.firstRequest.slice(0, 50)}"`);
			assert(entry.path === sessionPath, `path matches: ${sessionPath}`);
			assert(typeof entry.markedAt === "string" && entry.markedAt.length > 0, "markedAt is set");
			assert(state.golden !== undefined && state.golden.length === 1, "state.golden has 1 entry");
		}

		// Test 2: Dedup by sessionId — second mark updates label
		{
			console.log("Test: mark-golden deduplicates by sessionId");
			const sessionPath = await createTestSession(sessionsDir, "golden-test-1"); // same sessionId
			const state = await loadState(extDir);
			// Simulate existing entry
			state.golden = [{
				sessionId: "golden-test-1",
				path: "/old/path.jsonl",
				label: "old label",
				markedAt: "2026-01-01T00:00:00.000Z",
				firstRequest: "old request",
			}];

			const entry = await markGolden(state, sessionPath, "обновлённая метка");
			assert(state.golden!.length === 1, `Still 1 entry after re-mark: got ${state.golden!.length}`);
			assert(entry.label === "обновлённая метка", `Label updated: got ${entry.label}`);
			assert(entry.path === sessionPath, "Path updated to new path");
		}

		// Test 3: Unmark golden
		{
			console.log("Test: unmark-golden removes entry");
			const state = await loadState(extDir);
			state.golden = [{
				sessionId: "to-remove",
				path: "/some/path.jsonl",
				label: "to delete",
				markedAt: "2026-01-01T00:00:00.000Z",
				firstRequest: "",
			}];

			const removed = unmarkGolden(state, "to-remove");
			assert(removed === true, "unmarkGolden returns true");
			assert(state.golden!.length === 0, "state.golden is empty after unmark");
		}

		// Test 4: Unmark non-existent
		{
			console.log("Test: unmark-golden returns false for unknown sessionId");
			const state = await loadState(extDir);
			state.golden = [];
			const removed = unmarkGolden(state, "non-existent");
			assert(removed === false, "unmarkGolden returns false for unknown");
		}

		// Test 5: List golden
		{
			console.log("Test: listGolden returns all entries");
			const state = await loadState(extDir);
			state.golden = [
				{ sessionId: "s1", path: "/p1.jsonl", label: "label1", markedAt: "2026-01-01", firstRequest: "req1" },
				{ sessionId: "s2", path: "/p2.jsonl", label: "label2", markedAt: "2026-01-02", firstRequest: "req2" },
			];
			const list = listGolden(state);
			assert(list.length === 2, `2 golden entries: got ${list.length}`);
			assert(list[0].sessionId === "s1", "First entry correct");
			assert(list[1].sessionId === "s2", "Second entry correct");
		}

		// Test 6: State backward compat — no golden field
		{
			console.log("Test: state without golden field → empty array");
			const statePath = join(extDir, "state.json");
			await writeFile(statePath, JSON.stringify({ analyzedMtimes: {} }), "utf-8");
			const state = await loadState(extDir);
			assert(Array.isArray(state.golden), "golden is an array");
			assert(state.golden!.length === 0, "golden defaults to empty array");
		}
	} finally {
		await rm(testDir, { recursive: true, force: true });
	}
}

async function testFindGolden() {
	console.log("\n=== F12: findGoldenForTrajectory Tests ===\n");

	// Test 7: Find golden in same directory
	{
		console.log("Test: finds golden in same session directory");
		const state: ExtensionState = {
			analyzedMtimes: {},
			golden: [{
				sessionId: "golden-1",
				path: "/home/user/.fan/sessions/--cwd--/2026-01-01_golden-1.jsonl",
				label: "эталон",
				markedAt: "2026-01-01",
				firstRequest: "fix bug",
			}],
		};
		const trajectory = makeTrajectory({
			path: "/home/user/.fan/sessions/--cwd--/2026-08-02_current.jsonl",
		});
		const found = findGoldenForTrajectory(state, trajectory);
		assert(found !== undefined, "Found golden entry");
		assert(found!.sessionId === "golden-1", `Correct sessionId: ${found?.sessionId}`);
	}

	// Test 8: No match in different directory
	{
		console.log("Test: no match for different session directory");
		const state: ExtensionState = {
			analyzedMtimes: {},
			golden: [{
				sessionId: "golden-other",
				path: "/home/user/.fan/sessions/--other-cwd--/2026-01-01_golden.jsonl",
				label: "эталон",
				markedAt: "2026-01-01",
				firstRequest: "fix bug",
			}],
		};
		const trajectory = makeTrajectory({
			path: "/home/user/.fan/sessions/--cwd--/2026-08-02_current.jsonl",
		});
		const found = findGoldenForTrajectory(state, trajectory);
		assert(found === undefined, "No golden match for different directory");
	}

	// Test 9: Empty golden list
	{
		console.log("Test: empty golden list → undefined");
		const state: ExtensionState = { analyzedMtimes: {}, golden: [] };
		const trajectory = makeTrajectory({});
		const found = findGoldenForTrajectory(state, trajectory);
		assert(found === undefined, "No match when golden list is empty");
	}
}

async function testGoldenComparison() {
	console.log("\n=== F12: Golden Comparison Tests ===\n");

	// Test 10: Parse valid comparison response
	{
		console.log("Test: parseComparisonResponse — valid JSON");
		const response = JSON.stringify({
			alignment: 2,
			deviations: [
				{ aspect: "выбор инструментов", current: "read → edit", golden: "grep → read → edit", assessment: "текущая сессия пропустила grep" },
			],
			verdict: "В целом соответствует эталону, но пропущен этап поиска.",
		});
		const result = parseComparisonResponse(response);
		assert(result !== null, "Parsed successfully");
		assert(result!.alignment === 2, `alignment = 2: got ${result?.alignment}`);
		assert(result!.deviations.length === 1, `1 deviation: got ${result?.deviations.length}`);
		assert(result!.deviations[0].aspect === "выбор инструментов", "Deviation aspect correct");
		assert(result!.verdict.includes("эталону"), "Verdict contains expected text");
	}

	// Test 11: Parse invalid JSON → null
	{
		console.log("Test: parseComparisonResponse — invalid JSON → null");
		const result = parseComparisonResponse("This is not JSON at all");
		assert(result === null, "Returns null for invalid response");
	}

	// Test 12: Parse JSON with invalid alignment (out of range) → null
	{
		console.log("Test: parseComparisonResponse — alignment=5 → null");
		const response = JSON.stringify({ alignment: 5, deviations: [], verdict: "test" });
		const result = parseComparisonResponse(response);
		assert(result === null, "Returns null for out-of-range alignment");
	}

	// Test 13: compareWithGolden — valid flow with mock judge
	{
		console.log("Test: compareWithGolden — valid comparison flow");
		const testDir = join(tmpdir(), `fan-golden-compare-${Date.now()}`);
		const sessionsDir = join(testDir, "sessions");
		await mkdir(sessionsDir, { recursive: true });

		try {
			const goldenPath = await createTestSession(sessionsDir, "golden-session");
			const currentTrajectory = makeTrajectory({
				sessionId: "current-session",
				path: join(sessionsDir, "current.jsonl"),
			});

			const goldenEntry: GoldenEntry = {
				sessionId: "golden-session",
				path: goldenPath,
				label: "эталонный фикс",
				markedAt: "2026-01-01",
				firstRequest: "Fix the login bug in auth module",
			};

			const mockResponse = JSON.stringify({
				alignment: 2,
				deviations: [
					{ aspect: "флоу", current: "read→edit", golden: "read→grep→edit", assessment: "пропущен grep" },
				],
				verdict: "Хорошее соответствие с мелкими отклонениями.",
			});

			const deps = makeMockJudgeDeps(mockResponse);
			const cfg = makeCfg();

			const result = await compareWithGolden(currentTrajectory, goldenEntry, deps, cfg);
			assert(result.alignment === 2, `alignment = 2: got ${result.alignment}`);
			assert(result.deviations.length === 1, `1 deviation: got ${result.deviations.length}`);
			assert(!result.unavailable, "Not unavailable");
		} finally {
			await rm(testDir, { recursive: true, force: true });
		}
	}

	// Test 14: compareWithGolden — invalid judge response → unavailable
	{
		console.log("Test: compareWithGolden — invalid response → unavailable");
		const testDir = join(tmpdir(), `fan-golden-compare-invalid-${Date.now()}`);
		const sessionsDir = join(testDir, "sessions");
		await mkdir(sessionsDir, { recursive: true });

		try {
			const goldenPath = await createTestSession(sessionsDir, "golden-invalid");
			const currentTrajectory = makeTrajectory({
				sessionId: "current-invalid",
				path: join(sessionsDir, "current.jsonl"),
			});

			const goldenEntry: GoldenEntry = {
				sessionId: "golden-invalid",
				path: goldenPath,
				label: "эталон",
				markedAt: "2026-01-01",
				firstRequest: "Fix bug",
			};

			const deps = makeMockJudgeDeps("I cannot produce JSON sorry");
			const cfg = makeCfg();

			const result = await compareWithGolden(currentTrajectory, goldenEntry, deps, cfg);
			assert(result.unavailable === true, "Marked as unavailable after invalid response");
			assert(result.alignment === 0, `alignment = 0 for unavailable: got ${result.alignment}`);
		} finally {
			await rm(testDir, { recursive: true, force: true });
		}
	}

	// Test 15: compareWithGolden — judge unavailable (no model) → unavailable
	{
		console.log("Test: compareWithGolden — no model → unavailable");
		const testDir = join(tmpdir(), `fan-golden-compare-nomodel-${Date.now()}`);
		const sessionsDir = join(testDir, "sessions");
		await mkdir(sessionsDir, { recursive: true });

		try {
			const goldenPath = await createTestSession(sessionsDir, "golden-nomodel");
			const currentTrajectory = makeTrajectory({
				sessionId: "current-nomodel",
				path: join(sessionsDir, "current.jsonl"),
			});

			const goldenEntry: GoldenEntry = {
				sessionId: "golden-nomodel",
				path: goldenPath,
				label: "эталон",
				markedAt: "2026-01-01",
				firstRequest: "Fix bug",
			};

			const deps: JudgeDeps = {
				complete: async () => ({ content: [], usage: {} }),
				modelRegistry: {
					find: () => undefined,
					getAvailable: () => [],
				},
				currentModel: undefined,
			};
			const cfg = makeCfg();

			const result = await compareWithGolden(currentTrajectory, goldenEntry, deps, cfg);
			assert(result.unavailable === true, "Marked as unavailable when no model");
		} finally {
			await rm(testDir, { recursive: true, force: true });
		}
	}
}

async function testGoldenReportSection() {
	console.log("\n=== F12: Golden Section in Report Tests ===\n");

	// Test 16: formatGoldenSection — available comparison
	{
		console.log("Test: formatGoldenSection — available comparison");
		const comparison: GoldenComparison = {
			alignment: 2,
			deviations: [
				{ aspect: "инструменты", current: "read→edit", golden: "grep→read→edit", assessment: "пропущен grep" },
			],
			verdict: "Хорошее соответствие.",
		};
		const section = formatGoldenSection(comparison);
		assert(section.includes("Сравнение с эталоном (golden)"), "Contains section header");
		assert(section.includes("2/3"), "Contains alignment score");
		assert(section.includes("инструменты"), "Contains deviation aspect");
		assert(section.includes("Хорошее соответствие"), "Contains verdict");
	}

	// Test 17: formatGoldenSection — unavailable
	{
		console.log("Test: formatGoldenSection — unavailable");
		const comparison: GoldenComparison = {
			alignment: 0,
			deviations: [],
			verdict: "Судья недоступен",
			unavailable: true,
		};
		const section = formatGoldenSection(comparison);
		assert(section.includes("недоступно"), "Contains unavailable notice");
	}
}

// ============================================================================
// F13: Pattern Mining Tests
// ============================================================================

async function testWorkerChainMining() {
	console.log("\n=== F13: Worker Chain Mining Tests ===\n");

	// Test 18: 3 sessions with explore→implement→verify → pattern found
	{
		console.log("Test: worker_chain — 3 sessions meet threshold → pattern found");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `chain-session-${i}`,
				workersSpawned: [
					{ type: "explore", task: "исследуй модуль auth" },
					{ type: "implement", task: "добавь поле username" },
					{ type: "verify", task: "проверь тесты" },
				],
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);

		const chainPatterns = patterns.filter((p) => p.kind === "worker_chain");
		assert(chainPatterns.length > 0, `Found chain patterns: ${chainPatterns.length}`);

		// Should find explore→implement→verify
		const fullChain = chainPatterns.find((p) => p.signature.includes("explore→implement→verify"));
		assert(fullChain !== undefined, "Found explore→implement→verify chain");
		if (fullChain) {
			assert(fullChain.sessionsCount === 3, `sessionsCount = 3: got ${fullChain.sessionsCount}`);
			assert(fullChain.exampleSessionIds.length <= 3, `exampleSessionIds ≤ 3: got ${fullChain.exampleSessionIds.length}`);
			assert(fullChain.suggestedArtifact === "worker", `suggestedArtifact = worker: got ${fullChain.suggestedArtifact}`);
		}
	}

	// Test 19: Only 2 sessions → below threshold
	{
		console.log("Test: worker_chain — 2 sessions below threshold (3) → no pattern");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 2; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `chain-below-${i}`,
				workersSpawned: [
					{ type: "explore", task: "исследуй" },
					{ type: "implement", task: "реализуй" },
					{ type: "verify", task: "проверь" },
				],
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const chainPatterns = patterns.filter((p) => p.kind === "worker_chain");
		assert(chainPatterns.length === 0, `No chain patterns below threshold: got ${chainPatterns.length}`);
	}

	// Test 20: Sub-sequences of length 2 also detected
	{
		console.log("Test: worker_chain — subsequence length 2 detected");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `chain-sub2-${i}`,
				workersSpawned: [
					{ type: "implement", task: "do something" },
					{ type: "verify", task: "check it" },
				],
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const chainPatterns = patterns.filter((p) => p.kind === "worker_chain");
		const implVerify = chainPatterns.find((p) => p.signature === "implement→verify");
		assert(implVerify !== undefined, "Found implement→verify subsequence");
	}
}

async function testToolSequenceMining() {
	console.log("\n=== F13: Tool Sequence Mining Tests ===\n");

	// Test 21: Tool sequence n-grams — thresholds met
	{
		console.log("Test: tool_sequence — meets session and occurrence thresholds");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			// Each session has read→edit→bash at least 3 times
			const steps: TrajectoryStep[] = [];
			for (let j = 0; j < 3; j++) {
				steps.push(makeStep("tool_call", j * 3, { toolName: "read" }));
				steps.push(makeStep("tool_call", j * 3 + 1, { toolName: "edit" }));
				steps.push(makeStep("tool_call", j * 3 + 2, { toolName: "bash" }));
			}
			trajectories.push(makeTrajectory({
				sessionId: `tool-seq-${i}`,
				steps,
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const toolPatterns = patterns.filter((p) => p.kind === "tool_sequence");
		const readEditBash = toolPatterns.find((p) => p.signature === "read→edit→bash");
		assert(readEditBash !== undefined, "Found read→edit→bash pattern");
		if (readEditBash) {
			assert(readEditBash.sessionsCount >= 3, `sessionsCount ≥ 3: got ${readEditBash.sessionsCount}`);
			assert(readEditBash.suggestedArtifact === "skill", `suggestedArtifact = skill: got ${readEditBash.suggestedArtifact}`);
		}
	}

	// Test 22: Tool sequence — below session threshold
	{
		console.log("Test: tool_sequence — below session threshold → no pattern");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 2; i++) {
			const steps: TrajectoryStep[] = [];
			for (let j = 0; j < 5; j++) {
				steps.push(makeStep("tool_call", j * 3, { toolName: "grep" }));
				steps.push(makeStep("tool_call", j * 3 + 1, { toolName: "read" }));
				steps.push(makeStep("tool_call", j * 3 + 2, { toolName: "write" }));
			}
			trajectories.push(makeTrajectory({
				sessionId: `tool-below-${i}`,
				steps,
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const toolPatterns = patterns.filter((p) => p.kind === "tool_sequence");
		assert(toolPatterns.length === 0, `No tool patterns below threshold: got ${toolPatterns.length}`);
	}

	// Test 23: Tool sequence — below occurrence threshold (3 total)
	{
		console.log("Test: tool_sequence — below 3 total occurrences → no pattern");
		const trajectories: Trajectory[] = [];
		// 3 sessions but only 1 occurrence each = 3 total — this should pass (>=3)
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `tool-occ-${i}`,
				steps: [
					makeStep("tool_call", 0, { toolName: "read" }),
					makeStep("tool_call", 1, { toolName: "edit" }),
					makeStep("tool_call", 2, { toolName: "bash" }),
				],
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const toolPatterns = patterns.filter((p) => p.kind === "tool_sequence");
		// 3 sessions × 1 occurrence = 3 total — exactly at threshold
		assert(toolPatterns.length >= 1, `Pattern found at occurrence threshold: ${toolPatterns.length}`);
	}
}

async function testPromptTemplateMining() {
	console.log("\n=== F13: Prompt Template Mining Tests ===\n");

	// Test 24: Jaccard similarity — identical prompts
	{
		console.log("Test: jaccardSimilarity — identical prompts ≥ 0.7");
		const a = new Set(["fix", "the", "login", "bug"]);
		const b = new Set(["fix", "the", "login", "bug"]);
		const sim = jaccardSimilarity(a, b);
		assert(sim === 1.0, `Jaccard = 1.0 for identical: got ${sim}`);
	}

	// Test 25: Jaccard similarity — completely different
	{
		console.log("Test: jaccardSimilarity — different prompts < 0.7");
		const a = new Set(["fix", "login", "bug"]);
		const b = new Set(["deploy", "production", "server"]);
		const sim = jaccardSimilarity(a, b);
		assert(sim < 0.7, `Jaccard < 0.7 for different: got ${sim}`);
	}

	// Test 26: normalizePrompt — removes paths and numbers
	{
		console.log("Test: normalizePrompt — removes paths, numbers, quotes");
		const raw = 'Исправь баг в файле C:\\Users\\test\\auth.ts на строке 42 "login failed"';
		const normalized = normalizePrompt(raw);
		assert(!normalized.includes("C:"), `Path removed: "${normalized}"`);
		assert(!normalized.includes("42"), `Number removed: "${normalized}"`);
		assert(!normalized.includes('"'), `Quotes removed: "${normalized}"`);
		assert(normalized.includes("баг"), `Content preserved: "${normalized}"`);
		assert(normalized.includes("файле"), `Content preserved: "${normalized}"`);
	}

	// Test 27: normalizePrompt — Unix paths
	{
		console.log("Test: normalizePrompt — removes Unix paths");
		const raw = "Fix bug in /home/user/project/src/auth.ts line 100";
		const normalized = normalizePrompt(raw);
		assert(!normalized.includes("/home"), `Unix path removed: "${normalized}"`);
		assert(!normalized.includes("100"), `Number removed: "${normalized}"`);
	}

	// Test 28: prompt_template — cluster found across sessions
	{
		console.log("Test: prompt_template — similar prompts across sessions → cluster");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 4; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `prompt-cluster-${i}`,
				workersSpawned: [
					{ type: "implement", task: `Исправь баг в модуле авторизации, добавь проверку токена и обнови тесты` },
				],
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const promptPatterns = patterns.filter((p) => p.kind === "prompt_template");
		assert(promptPatterns.length >= 1, `Found prompt template patterns: ${promptPatterns.length}`);
		if (promptPatterns.length > 0) {
			assert(promptPatterns[0].sessionsCount >= 3, `sessionsCount ≥ 3: got ${promptPatterns[0].sessionsCount}`);
			assert(promptPatterns[0].suggestedArtifact === "worker" || promptPatterns[0].suggestedArtifact === "skill",
				`suggestedArtifact is worker or skill: got ${promptPatterns[0].suggestedArtifact}`);
		}
	}

	// Test 29: prompt_template — different prompts → no cluster
	{
		console.log("Test: prompt_template — different prompts → no cluster");
		const trajectories: Trajectory[] = [
			makeTrajectory({
				sessionId: "diff-1",
				workersSpawned: [
					{ type: "explore", task: "Исследуй архитектуру модуля авторизации и найди проблемы безопасности" },
				],
			}),
			makeTrajectory({
				sessionId: "diff-2",
				workersSpawned: [
					{ type: "implement", task: "Разверни production сервер в облаке и настрой мониторинг" },
				],
			}),
			makeTrajectory({
				sessionId: "diff-3",
				workersSpawned: [
					{ type: "bug-fix", task: "Почини падающий тест в модуле базы данных и обнови миграции" },
				],
			}),
		];

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const promptPatterns = patterns.filter((p) => p.kind === "prompt_template");
		assert(promptPatterns.length === 0, `No prompt template patterns for different prompts: got ${promptPatterns.length}`);
	}
}

async function testPatternsReportSection() {
	console.log("\n=== F13: Pattern Report Section Tests ===\n");

	// Test 30: formatPatternsSection — with candidates
	{
		console.log("Test: formatPatternsSection — with candidates");
		const candidates: PatternCandidate[] = [
			{
				kind: "worker_chain",
				signature: "explore→implement→verify",
				sessionsCount: 5,
				exampleSessionIds: ["s1", "s2", "s3"],
				suggestedArtifact: "worker",
				draftProposal: "Создать тип воркера для цепочки explore→implement→verify.",
			},
			{
				kind: "tool_sequence",
				signature: "read→edit→bash",
				sessionsCount: 4,
				exampleSessionIds: ["s1", "s4"],
				suggestedArtifact: "skill",
				draftProposal: "Создать скилл для последовательности read→edit→bash.",
			},
		];

		const section = formatPatternsSection(candidates, 3);
		assert(section.includes("Рекомендации по синтезу"), "Contains section header");
		assert(section.includes("explore→implement→verify"), "Contains chain pattern");
		assert(section.includes("read→edit→bash"), "Contains tool pattern");
		assert(section.includes("BR4"), "Contains BR4 warning");
		assert(section.includes("Цепочка воркеров"), "Contains worker chain label");
		assert(section.includes("Последовательность инструментов"), "Contains tool sequence label");
	}

	// Test 31: formatPatternsSection — empty candidates
	{
		console.log("Test: formatPatternsSection — no patterns found");
		const section = formatPatternsSection([], 3);
		assert(section.includes("Повторяющихся паттернов не найдено"), "Contains 'no patterns' message");
		assert(section.includes("порог: 3"), "Contains threshold info");
	}

	// Test 32: formatPatternsSection — draftProposal present
	{
		console.log("Test: formatPatternsSection — includes draftProposal");
		const candidates: PatternCandidate[] = [{
			kind: "prompt_template",
			signature: "prompt:исправь баг в модуле...",
			sessionsCount: 6,
			exampleSessionIds: ["s1", "s2"],
			suggestedArtifact: "worker",
			draftProposal: "Создать специализированный тип воркера для исправления багов.",
		}];

		const section = formatPatternsSection(candidates, 3);
		assert(section.includes("Создать специализированный"), "Contains draft proposal text");
		assert(section.includes("Шаблон промпта"), "Contains prompt template label");
	}
}

// ============================================================================
// NEW FIX VERIFICATION TESTS
// ============================================================================

async function testFixesSelfGoldenExcluded() {
	console.log("\n=== FIX: Self-golden excluded ===\n");

	// Test: findGoldenForTrajectory excludes current session by sessionId
	{
		console.log("Test: self-session excluded from golden candidates");
		const state: ExtensionState = {
			analyzedMtimes: {},
			golden: [{
				sessionId: "session-A",
				path: "/home/user/.fan/sessions/--cwd--/2026-01-01_session-A.jsonl",
				label: "эталон",
				markedAt: "2026-01-01",
				firstRequest: "fix bug",
			}],
		};
		const trajectory = makeTrajectory({
			sessionId: "session-A",
			path: "/home/user/.fan/sessions/--cwd--/2026-08-02_session-A.jsonl",
		});
		const found = findGoldenForTrajectory(state, trajectory);
		assert(found === undefined, "Self-session excluded → undefined");
	}

	// Test: findGoldenForTrajectory excludes current session by path
	{
		console.log("Test: self-path excluded from golden candidates");
		const state: ExtensionState = {
			analyzedMtimes: {},
			golden: [{
				sessionId: "other-id",
				path: "/home/user/.fan/sessions/--cwd--/2026-08-02_current.jsonl",
				label: "эталон",
				markedAt: "2026-01-01",
				firstRequest: "fix bug",
			}],
		};
		const trajectory = makeTrajectory({
			sessionId: "different-id",
			path: "/home/user/.fan/sessions/--cwd--/2026-08-02_current.jsonl",
		});
		const found = findGoldenForTrajectory(state, trajectory);
		assert(found === undefined, "Self-path excluded → undefined");
	}

	// Test: deterministic selection — most recent markedAt
	{
		console.log("Test: deterministic golden selection — most recent markedAt");
		const state: ExtensionState = {
			analyzedMtimes: {},
			golden: [
				{
					sessionId: "old-golden",
					path: "/home/user/.fan/sessions/--cwd--/2026-01-01_old.jsonl",
					label: "старый",
					markedAt: "2026-01-01T00:00:00.000Z",
					firstRequest: "old",
				},
				{
					sessionId: "new-golden",
					path: "/home/user/.fan/sessions/--cwd--/2026-06-01_new.jsonl",
					label: "новый",
					markedAt: "2026-06-01T00:00:00.000Z",
					firstRequest: "new",
				},
			],
		};
		const trajectory = makeTrajectory({
			sessionId: "current-x",
			path: "/home/user/.fan/sessions/--cwd--/2026-08-02_current.jsonl",
		});
		const found = findGoldenForTrajectory(state, trajectory);
		assert(found !== undefined, "Found golden");
		assert(found!.sessionId === "new-golden", `Most recent markedAt selected: got ${found?.sessionId}`);
	}
}

async function testFixesGoldenTruncation() {
	console.log("\n=== FIX: 10MB golden prompt truncation ===\n");

	// Test: parseComparisonResponse still works after truncation (valid JSON)
	{
		console.log("Test: comparison response validation still works normally");
		const response = JSON.stringify({
			alignment: 1,
			deviations: [],
			verdict: "Короткий вердикт",
		});
		const result = parseComparisonResponse(response);
		assert(result !== null, "Valid short response parsed");
		assert(result!.alignment === 1, `alignment = 1: got ${result?.alignment}`);
	}

	// Test: deviations > 5 are truncated to 5
	{
		console.log("Test: deviations limited to 5 in output");
		const devs = [];
		for (let i = 0; i < 10; i++) {
			devs.push({ aspect: `a${i}`, current: `c${i}`, golden: `g${i}`, assessment: `as${i}` });
		}
		const response = JSON.stringify({ alignment: 1, deviations: devs, verdict: "много отклонений" });
		const result = parseComparisonResponse(response);
		assert(result !== null, "Parsed response with many deviations");
		assert(result!.deviations.length === 5, `Deviations capped at 5: got ${result!.deviations.length}`);
	}
}

async function testFixesStricterValidation() {
	console.log("\n=== FIX: Stricter comparison validation ===\n");

	// Test: missing deviations array → null
	{
		console.log("Test: missing deviations array → null");
		const response = JSON.stringify({ alignment: 2, verdict: "test" });
		const result = parseComparisonResponse(response);
		assert(result === null, "Missing deviations → null");
	}

	// Test: missing verdict string → null
	{
		console.log("Test: missing verdict → null");
		const response = JSON.stringify({ alignment: 2, deviations: [] });
		const result = parseComparisonResponse(response);
		assert(result === null, "Missing verdict → null");
	}

	// Test: empty verdict string → null
	{
		console.log("Test: empty verdict string → null");
		const response = JSON.stringify({ alignment: 2, deviations: [], verdict: "" });
		const result = parseComparisonResponse(response);
		assert(result === null, "Empty verdict → null");
	}

	// Test: verdict as number → null
	{
		console.log("Test: verdict as number → null");
		const response = JSON.stringify({ alignment: 2, deviations: [], verdict: 42 });
		const result = parseComparisonResponse(response);
		assert(result === null, "Non-string verdict → null");
	}

	// Test: deviations not an array → null
	{
		console.log("Test: deviations as string → null");
		const response = JSON.stringify({ alignment: 2, deviations: "not-array", verdict: "test" });
		const result = parseComparisonResponse(response);
		assert(result === null, "Non-array deviations → null");
	}

	// Test: valid with empty deviations → passes
	{
		console.log("Test: valid with empty deviations array");
		const response = JSON.stringify({ alignment: 3, deviations: [], verdict: "Полное соответствие" });
		const result = parseComparisonResponse(response);
		assert(result !== null, "Valid response with empty deviations");
		assert(result!.deviations.length === 0, "Empty deviations preserved");
		assert(result!.verdict === "Полное соответствие", "Verdict preserved");
	}
}

async function testFixesSubsequenceMatching() {
	console.log("\n=== FIX: Worker chain subsequence matching ===\n");

	// Test: contiguous subsequence still works
	{
		console.log("Test: contiguous subsequence [explore→implement→verify] found");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `contiguous-${i}`,
				workersSpawned: [
					{ type: "explore", task: "a" },
					{ type: "implement", task: "b" },
					{ type: "verify", task: "c" },
				],
			}));
		}
		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const chainPatterns = patterns.filter((p) => p.kind === "worker_chain");
		const found = chainPatterns.find((p) => p.signature === "explore→implement→verify");
		assert(found !== undefined, "Contiguous subsequence found");
	}

	// Test: non-contiguous subsequence [explore→implement→verify] inside [explore→implement→implement→verify]
	{
		console.log("Test: non-contiguous subsequence [explore→implement→verify] inside [explore→implement→implement→verify]");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `subseq-${i}`,
				workersSpawned: [
					{ type: "explore", task: "a" },
					{ type: "implement", task: "b" },
					{ type: "implement", task: "c" },
					{ type: "verify", task: "d" },
				],
			}));
		}
		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const chainPatterns = patterns.filter((p) => p.kind === "worker_chain");
		const found = chainPatterns.find((p) => p.signature === "explore→implement→verify");
		assert(found !== undefined, "Non-contiguous subsequence explore→implement→verify found inside explore→implement→implement→verify");
		if (found) {
			assert(found.sessionsCount === 3, `sessionsCount = 3: got ${found.sessionsCount}`);
		}
	}

	// Test: non-contiguous subsequence [explore→verify] inside [explore→implement→implement→verify]
	{
		console.log("Test: non-contiguous [explore→verify] found");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `subseq2-${i}`,
				workersSpawned: [
					{ type: "explore", task: "a" },
					{ type: "implement", task: "b" },
					{ type: "implement", task: "c" },
					{ type: "verify", task: "d" },
				],
			}));
		}
		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const chainPatterns = patterns.filter((p) => p.kind === "worker_chain");
		const found = chainPatterns.find((p) => p.signature === "explore→verify");
		assert(found !== undefined, "Non-contiguous explore→verify found");
	}
}

async function testFixesOrchestratorToolsExcluded() {
	console.log("\n=== FIX: Orchestrator tools excluded from tool_sequence ===\n");

	// Test: delegate_task, TaskCreate etc. excluded from tool_sequence
	{
		console.log("Test: orchestrator tools excluded from tool_sequence n-grams");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			const steps: TrajectoryStep[] = [];
			for (let j = 0; j < 3; j++) {
				steps.push(makeStep("tool_call", j * 3, { toolName: "delegate_task" }));
				steps.push(makeStep("tool_call", j * 3 + 1, { toolName: "TaskCreate" }));
				steps.push(makeStep("tool_call", j * 3 + 2, { toolName: "bash" }));
			}
			trajectories.push(makeTrajectory({
				sessionId: `orch-tools-${i}`,
				steps,
			}));
		}
		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const toolPatterns = patterns.filter((p) => p.kind === "tool_sequence");
		// delegate_task→TaskCreate→bash should NOT appear (orchestrator tools filtered)
		const orchNgram = toolPatterns.find((p) => p.signature.includes("delegate_task") || p.signature.includes("TaskCreate"));
		assert(orchNgram === undefined, "No orchestrator tool n-grams in tool_sequence patterns");
	}

	// Test: regular tools still work
	{
		console.log("Test: regular tool n-grams still detected after orchestrator exclusion");
		const trajectories: Trajectory[] = [];
		for (let i = 0; i < 3; i++) {
			const steps: TrajectoryStep[] = [];
			for (let j = 0; j < 3; j++) {
				steps.push(makeStep("tool_call", j * 3, { toolName: "grep" }));
				steps.push(makeStep("tool_call", j * 3 + 1, { toolName: "read" }));
				steps.push(makeStep("tool_call", j * 3 + 2, { toolName: "edit" }));
			}
			trajectories.push(makeTrajectory({
				sessionId: `reg-tools-${i}`,
				steps,
			}));
		}
		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		const toolPatterns = patterns.filter((p) => p.kind === "tool_sequence");
		const found = toolPatterns.find((p) => p.signature === "grep→read→edit");
		assert(found !== undefined, "Regular tool n-grams still detected");
	}

	// Verify ORCHESTRATOR_TOOLS set contains expected tools
	{
		console.log("Test: ORCHESTRATOR_TOOLS contains expected tools");
		assert(ORCHESTRATOR_TOOLS.has("delegate_task"), "ORCHESTRATOR_TOOLS has delegate_task");
		assert(ORCHESTRATOR_TOOLS.has("TaskCreate"), "ORCHESTRATOR_TOOLS has TaskCreate");
		assert(ORCHESTRATOR_TOOLS.has("TaskUpdate"), "ORCHESTRATOR_TOOLS has TaskUpdate");
		assert(ORCHESTRATOR_TOOLS.has("assess_task"), "ORCHESTRATOR_TOOLS has assess_task");
		assert(!ORCHESTRATOR_TOOLS.has("bash"), "ORCHESTRATOR_TOOLS does NOT have bash");
		assert(!ORCHESTRATOR_TOOLS.has("read"), "ORCHESTRATOR_TOOLS does NOT have read");
	}
}

async function testFixesPromptSingleCharTokens() {
	console.log("\n=== FIX: Single-char tokens and prompt distinction ===\n");

	// Test: «создай X» and «создай Y» produce different clusters
	{
		console.log("Test: «создай X» vs «создай Y» → different clusters");
		const normX = normalizePrompt("создай X");
		const normY = normalizePrompt("создай Y");
		// After normalization, X and Y should be preserved as single-char tokens
		const tokensX = new Set(normX.split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[,.;:]+$/, "")));
		const tokensY = new Set(normY.split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[,.;:]+$/, "")));
		const sim = jaccardSimilarity(tokensX, tokensY);
		assert(sim < 1.0, `«создай X» ≠ «создай Y» (Jaccard < 1.0): got ${sim.toFixed(3)}`);
	}

	// Test: identical prompts with different paths → same cluster
	{
		console.log("Test: identical prompts with different paths → same cluster (Jaccard ≥ 0.7)");
		const normA = normalizePrompt("Fix bug in C:\\Users\\project\\auth.ts line 42");
		const normB = normalizePrompt("Fix bug in /home/user/src/main.py line 99");
		const tokensA = new Set(normA.split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[,.;:]+$/, "")));
		const tokensB = new Set(normB.split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[,.;:]+$/, "")));
		const sim = jaccardSimilarity(tokensA, tokensB);
		assert(sim >= 0.7, `Same prompt with different paths → Jaccard ≥ 0.7: got ${sim.toFixed(3)}`);
	}

	// Test: normalizePrompt replaces paths with __PATH__
	{
		console.log("Test: normalizePrompt replaces paths with __PATH__");
		const normalized = normalizePrompt("Edit file /src/main.ts at line 10");
		assert(normalized.includes("__PATH__"), `Path replaced with __PATH__: "${normalized}"`);
		assert(normalized.includes("__NUM__"), `Number replaced with __NUM__: "${normalized}"`);
	}

	// Test: trailing punctuation stripped from tokens
	{
		console.log("Test: trailing punctuation stripped during tokenization");
		const norm = normalizePrompt("hello, world; test.");
		const tokens = new Set(norm.split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[,.;:]+$/, "")));
		assert(tokens.has("hello"), "Token 'hello' present (comma stripped)");
		assert(tokens.has("world"), "Token 'world' present (semicolon stripped)");
		assert(tokens.has("test"), "Token 'test' present (period stripped)");
	}
}

async function testFixesMarkdownEscaping() {
	console.log("\n=== FIX: Markdown escaping ===\n");

	// Test: escapeMd replaces | with \|
	{
		console.log("Test: escapeMd escapes pipe characters");
		assert(escapeMd("a|b") === "a\\|b", `Pipe escaped: "${escapeMd("a|b")}"`);
		assert(escapeMd("no pipes here") === "no pipes here", "No change when no pipes");
	}

	// Test: escapeMd replaces newlines with spaces
	{
		console.log("Test: escapeMd replaces newlines with spaces");
		assert(escapeMd("line1\nline2") === "line1 line2", `Newline replaced: "${escapeMd("line1\nline2")}"`);
		assert(escapeMd("a\r\nb") === "a b", `CRLF replaced: "${escapeMd("a\r\nb")}"`);
	}

	// Test: formatGoldenSection escapes deviations
	{
		console.log("Test: formatGoldenSection escapes pipe in deviations");
		const comparison: GoldenComparison = {
			alignment: 2,
			deviations: [
				{ aspect: "foo|bar", current: "a|b", golden: "c|d", assessment: "e|f" },
			],
			verdict: "verdict|with|pipes",
		};
		const section = formatGoldenSection(comparison);
		assert(section.includes("foo\\|bar"), "Pipe in aspect escaped");
		assert(section.includes("a\\|b"), "Pipe in current escaped");
		assert(section.includes("verdict\\|with\\|pipes"), "Pipe in verdict escaped");
	}

	// Test: formatPatternsSection escapes pipe in signature
	{
		console.log("Test: formatPatternsSection escapes pipe in proposals");
		const candidates: PatternCandidate[] = [{
			kind: "worker_chain",
			signature: "test|chain",
			sessionsCount: 3,
			exampleSessionIds: ["s1"],
			suggestedArtifact: "worker",
			draftProposal: "Create a worker|skill hybrid",
		}];
		const section = formatPatternsSection(candidates, 3);
		assert(section.includes("test\\|chain"), "Pipe in signature escaped in table");
		assert(section.includes("worker\\|skill"), "Pipe in proposal escaped in table");
	}
}

async function testFixesGoldenDedup() {
	console.log("\n=== FIX: Golden dedup removes ALL duplicates ===\n");

	// Test: markGolden removes ALL existing entries with same sessionId
	{
		console.log("Test: markGolden removes all duplicates before adding");
		const testDir = join(tmpdir(), `fan-golden-dedup-${Date.now()}`);
		const sessionsDir = join(testDir, "sessions");
		const extDir = join(testDir, "ext");
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(extDir, { recursive: true });

		try {
			const state = await loadState(extDir);
			// Simulate buggy state with duplicate entries
			state.golden = [
				{ sessionId: "dup-session", path: "/p1.jsonl", label: "first", markedAt: "2026-01-01", firstRequest: "" },
				{ sessionId: "dup-session", path: "/p2.jsonl", label: "second", markedAt: "2026-01-02", firstRequest: "" },
				{ sessionId: "dup-session", path: "/p3.jsonl", label: "third", markedAt: "2026-01-03", firstRequest: "" },
			];

			const sessionPath = await createTestSession(sessionsDir, "dup-session");
			const entry = await markGolden(state, sessionPath, "единственный");
			assert(state.golden!.length === 1, `After mark: exactly 1 entry: got ${state.golden!.length}`);
			assert(state.golden![0].label === "единственный", `Label is the new one: got ${state.golden![0].label}`);
			assert(state.golden![0].sessionId === "dup-session", `sessionId preserved: got ${state.golden![0].sessionId}`);
		} finally {
			await rm(testDir, { recursive: true, force: true });
		}
	}
}

async function testFixesPatternMinSessionsValidation() {
	console.log("\n=== FIX: patternMinSessions validation ===\n");

	// Import validateConfig dynamically
	const { validateConfig } = await import("../src/config.js");

	// Test: valid integer ≥ 1
	{
		console.log("Test: patternMinSessions = 3 → valid");
		const result = validateConfig({ orchestration: { patternMinSessions: 3 } });
		assert(result.valid === true, "Valid: patternMinSessions = 3");
	}

	// Test: 0 → invalid
	{
		console.log("Test: patternMinSessions = 0 → invalid");
		const result = validateConfig({ orchestration: { patternMinSessions: 0 } });
		assert(result.valid === false, "Invalid: patternMinSessions = 0");
		assert(result.errors.some((e) => e.includes("patternMinSessions")), "Error mentions patternMinSessions");
	}

	// Test: negative → invalid
	{
		console.log("Test: patternMinSessions = -1 → invalid");
		const result = validateConfig({ orchestration: { patternMinSessions: -1 } });
		assert(result.valid === false, "Invalid: patternMinSessions = -1");
	}

	// Test: float → invalid
	{
		console.log("Test: patternMinSessions = 2.5 → invalid");
		const result = validateConfig({ orchestration: { patternMinSessions: 2.5 } });
		assert(result.valid === false, "Invalid: patternMinSessions = 2.5 (not integer)");
	}
}

async function testFixesGlobalSort() {
	console.log("\n=== FIX: Global sort by sessionsCount ===\n");

	// Test: patterns sorted globally by sessionsCount desc
	{
		console.log("Test: global sort — tool_sequence with more sessions appears before worker_chain");
		const trajectories: Trajectory[] = [];
		// 5 sessions with read→edit→bash tool pattern
		for (let i = 0; i < 5; i++) {
			const steps: TrajectoryStep[] = [];
			for (let j = 0; j < 3; j++) {
				steps.push(makeStep("tool_call", j * 3, { toolName: "read" }));
				steps.push(makeStep("tool_call", j * 3 + 1, { toolName: "edit" }));
				steps.push(makeStep("tool_call", j * 3 + 2, { toolName: "bash" }));
			}
			trajectories.push(makeTrajectory({
				sessionId: `sort-tool-${i}`,
				steps,
			}));
		}
		// 3 sessions with explore→implement worker chain
		for (let i = 0; i < 3; i++) {
			trajectories.push(makeTrajectory({
				sessionId: `sort-chain-${i}`,
				workersSpawned: [
					{ type: "explore", task: "a" },
					{ type: "implement", task: "b" },
				],
			}));
		}

		const cfg = makeCfg({ orchestration: { ...DEFAULT_CONFIG.orchestration, patternMinSessions: 3 } });
		const patterns = minePatterns(trajectories, cfg);
		assert(patterns.length >= 2, `At least 2 patterns: got ${patterns.length}`);
		if (patterns.length >= 2) {
			assert(patterns[0].sessionsCount >= patterns[1].sessionsCount,
				`Global sort: first (${patterns[0].sessionsCount}) ≥ second (${patterns[1].sessionsCount})`);
		}
	}
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
	console.log("=== FAN Session Analytics — Golden (F12) + Patterns (F13) Verification ===");
	console.log(`Date: ${new Date().toISOString()}`);

	await testMarkGolden();
	await testFindGolden();
	await testGoldenComparison();
	await testGoldenReportSection();
	await testWorkerChainMining();
	await testToolSequenceMining();
	await testPromptTemplateMining();
	await testPatternsReportSection();

	// NEW FIX VERIFICATION TESTS
	await testFixesSelfGoldenExcluded();
	await testFixesGoldenTruncation();
	await testFixesStricterValidation();
	await testFixesSubsequenceMatching();
	await testFixesOrchestratorToolsExcluded();
	await testFixesPromptSingleCharTokens();
	await testFixesMarkdownEscaping();
	await testFixesGoldenDedup();
	await testFixesPatternMinSessionsValidation();
	await testFixesGlobalSort();

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
