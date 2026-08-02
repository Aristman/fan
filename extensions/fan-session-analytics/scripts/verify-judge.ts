/**
 * Judge (Stage B) verification tests.
 * All tests use mocked LLM (no real API calls).
 *
 * Usage: bun run extensions/fan-session-analytics/scripts/verify-judge.ts
 */

import { compressTrajectory } from "../src/judge/batcher.js";
import { buildJudgePrompt, getActiveRubricKeys, RUBRICS, ALL_RUBRIC_KEYS } from "../src/judge/rubrics.js";
import { parseJudgeResponse } from "../src/judge/validate.js";
import { runJudge } from "../src/judge/client.js";
import { calculateScore } from "../src/score.js";
import { runPipeline } from "../src/pipeline.js";
import { detectWorkerRouting } from "../src/detectors/d12-worker-routing.js";
import { buildTrajectory } from "../src/normalizer.js";
import type {
	AnalyticsConfig,
	Trajectory,
	TrajectoryStep,
	JudgeDeps,
	JudgeBatch,
	Finding,
	SessionScore,
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

function makeCfg(overrides?: Partial<AnalyticsConfig["judge"]>): AnalyticsConfig {
	return {
		...DEFAULT_CONFIG,
		judge: { ...DEFAULT_CONFIG.judge, ...overrides },
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

function makeTrajectory(steps: TrajectoryStep[], hasDelegateTask = false): Trajectory {
	const allSteps = hasDelegateTask
		? [
				...steps,
				makeStep("tool_call", steps.length, { toolName: "delegate_task", args: { agent: "implement", task: "fix bug" } }),
			]
		: steps;

	return {
		sessionId: "test-session",
		path: "/test/path.jsonl",
		cwd: "/test",
		startedAt: Date.now(),
		endedAt: Date.now() + 60000,
		steps: allSteps,
		skillsActivated: [],
		workersSpawned: [],
		compactions: 0,
		truncated: false,
		invalidLines: 0,
		totalLines: allSteps.length + 1,
	};
}

function makeMockComplete(responseText: string, usage?: any): any {
	return async (_model: any, _context: any) => ({
		content: [{ type: "text", text: responseText }],
		usage: usage || { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
	});
}

function makeMockDeps(opts?: {
	complete?: any;
	models?: any[];
	currentModel?: any;
	findResult?: any;
}): JudgeDeps {
	return {
		complete: opts?.complete || makeMockComplete('{"rubrics":{"skillAppropriateness":{"score":2,"justification":"ok","stepRefs":[1]}},"recommendations":[]}'),
		modelRegistry: {
			find: (_p: string, _m: string) => opts?.findResult,
			getAvailable: () => opts?.models || [],
		},
		currentModel: opts?.currentModel,
	};
}

// ============================================================================
// BATCHER TESTS
// ============================================================================

async function testBatcher() {
	console.log("\n=== Batcher Tests ===\n");

	// Test 1: Basic batching with step limits
	{
		console.log("Test: basic batching respects maxSteps");
		const steps: TrajectoryStep[] = [];
		for (let i = 0; i < 10; i++) {
			steps.push(makeStep("user", i, { args: { text: `message ${i}` } }));
		}
		const trajectory = makeTrajectory(steps);
		const cfg = makeCfg({ batchMaxSteps: 4, batchMaxChars: 100000 });
		const batches = compressTrajectory(trajectory, cfg);

		assert(batches.length >= 2, `Expected >= 2 batches, got ${batches.length}`);
		assert(batches[0].steps.length <= 4, `First batch has <= 4 steps: ${batches[0].steps.length}`);
	}

	// Test 2: Char limits
	{
		console.log("Test: batching respects maxChars");
		const steps: TrajectoryStep[] = [];
		for (let i = 0; i < 5; i++) {
			steps.push(makeStep("user", i, { args: { text: "x".repeat(5000) } }));
		}
		const trajectory = makeTrajectory(steps);
		// excerptLimit=500 → text truncated to 1000 chars per step, so use very low batchMaxChars
		const cfg = makeCfg({ batchMaxChars: 2500, batchMaxSteps: 100, excerptLimit: 500 });
		const batches = compressTrajectory(trajectory, cfg);

		assert(batches.length >= 2, `Expected >= 2 batches for char limit, got ${batches.length}`);
	}

	// Test 3: Tool call/result pair not split
	{
		console.log("Test: tool_call/tool_result pair not split across batches");
		const steps: TrajectoryStep[] = [];
		for (let i = 0; i < 4; i++) {
			steps.push(makeStep("tool_call", i * 2, { toolName: "edit", args: { file: `file${i}.ts` } }));
			steps.push(makeStep("tool_result", i * 2 + 1, { toolName: "edit", isError: false }));
		}
		const trajectory = makeTrajectory(steps);
		const cfg = makeCfg({ batchMaxSteps: 3, batchMaxChars: 100000 });
		const batches = compressTrajectory(trajectory, cfg);

		// Verify: no batch should end with a tool_call while the next batch starts with its tool_result
		let pairSplit = false;
		for (let b = 0; b < batches.length - 1; b++) {
			const lastStep = batches[b].steps[batches[b].steps.length - 1];
			if (lastStep.includes("tool→") && batches[b + 1].steps[0]?.includes("result")) {
				pairSplit = true;
			}
		}
		assert(!pairSplit, "tool_call/tool_result pair was not split across batches");
	}

	// Test 4: Header contains first user request
	{
		console.log("Test: header contains first user request");
		const steps: TrajectoryStep[] = [
			makeStep("user", 0, { args: { text: "Fix the login bug" } }),
			makeStep("tool_call", 1, { toolName: "read", args: { path: "auth.ts" } }),
		];
		const trajectory = makeTrajectory(steps);
		const cfg = makeCfg();
		const batches = compressTrajectory(trajectory, cfg);

		assert(batches.length > 0, "At least one batch");
		assert(batches[0].header.includes("Fix the login bug"), `Header contains user request: "${batches[0].header}"`);
	}

	// Test 5: isLast flag
	{
		console.log("Test: isLast flag on last batch");
		const steps: TrajectoryStep[] = [];
		for (let i = 0; i < 20; i++) {
			steps.push(makeStep("user", i, { args: { text: `msg ${i}` } }));
		}
		const trajectory = makeTrajectory(steps);
		const cfg = makeCfg({ batchMaxSteps: 5 });
		const batches = compressTrajectory(trajectory, cfg);

		const lastBatch = batches[batches.length - 1];
		assert(lastBatch.isLast === true, "Last batch has isLast=true");
		if (batches.length > 1) {
			assert(batches[0].isLast === false, "First batch has isLast=false");
		}
	}
}

// ============================================================================
// VALIDATE TESTS
// ============================================================================

async function testValidate() {
	console.log("\n=== Validate Tests ===\n");

	// Test 6: Clean JSON
	{
		console.log("Test: parse clean JSON response");
		const text = JSON.stringify({
			rubrics: {
				skillAppropriateness: { score: 2, justification: "Хороший выбор", stepRefs: [1, 3] },
				completeness: { score: 3, justification: "Полностью", stepRefs: [5] },
			},
			recommendations: [],
		});
		const result = parseJudgeResponse(text, ["skillAppropriateness", "completeness"]);
		assert(result.ok === true, "Parsed clean JSON successfully");
		assert(result.rubrics?.skillAppropriateness !== "n/a", "skillAppropriateness is evaluated");
		assert((result.rubrics?.skillAppropriateness as any)?.score === 2, "Score is 2");
	}

	// Test 7: JSON in ```json fence
	{
		console.log("Test: parse JSON from ```json fence");
		const text = 'Here is my evaluation:\n```json\n{"rubrics":{"completeness":{"score":1,"justification":"Не полностью","stepRefs":[]}},"recommendations":[]}\n```';
		const result = parseJudgeResponse(text, ["completeness"]);
		assert(result.ok === true, "Parsed fenced JSON");
		assert(result.rubrics?.completeness !== "n/a", "completeness evaluated");
	}

	// Test 8: Score out of range → invalid
	{
		console.log("Test: score=5 → invalid (n/a)");
		const text = JSON.stringify({
			rubrics: {
				skillAppropriateness: { score: 5, justification: "too high", stepRefs: [] },
			},
		});
		const result = parseJudgeResponse(text, ["skillAppropriateness"]);
		assert(result.ok === true, "Parsed but score is n/a");
		assert(result.rubrics?.skillAppropriateness === "n/a", "Invalid score → n/a");
	}

	// Test 9: Text before/after JSON
	{
		console.log("Test: text before and after JSON");
		const text = 'My analysis follows.\n{"rubrics":{"economy":{"score":2,"justification":"ok","stepRefs":[1]}},"recommendations":[]}\nDone.';
		const result = parseJudgeResponse(text, ["economy"]);
		assert(result.ok === true, "Parsed JSON with surrounding text");
		assert(result.rubrics?.economy !== "n/a", "Economy evaluated from embedded JSON");
	}

	// Test 10: Missing rubric → n/a
	{
		console.log("Test: missing rubric → n/a");
		const text = JSON.stringify({
			rubrics: {
				skillAppropriateness: { score: 2, justification: "ok", stepRefs: [] },
			},
		});
		const result = parseJudgeResponse(text, ["skillAppropriateness", "completeness"]);
		assert(result.ok === true, "Parsed successfully");
		assert(result.rubrics?.completeness === "n/a", "Missing rubric → n/a");
	}

	// Test 11: No JSON at all → error
	{
		console.log("Test: no JSON → error");
		const result = parseJudgeResponse("I cannot evaluate this session.", ["skillAppropriateness"]);
		assert(result.ok === false, "No JSON → error");
	}
}

// ============================================================================
// CLIENT TESTS
// ============================================================================

async function testClient() {
	console.log("\n=== Client Tests ===\n");

	const sampleTrajectory = makeTrajectory([
		makeStep("user", 0, { args: { text: "Fix bug" } }),
		makeStep("tool_call", 1, { toolName: "read", args: { path: "bug.ts" } }),
		makeStep("tool_result", 2, { toolName: "read" }),
		makeStep("assistant_text", 3, { args: { text: "Fixed" } }),
	]);

	const goodResponse = JSON.stringify({
		rubrics: {
			skillAppropriateness: { score: 2, justification: "Нормально", stepRefs: [1] },
			completeness: { score: 3, justification: "Всё сделано", stepRefs: [3] },
			economy: { score: 2, justification: "Эффективно", stepRefs: [1, 2] },
			compliance: { score: 2, justification: "Соответствует", stepRefs: [] },
		},
		recommendations: [{ target: "prompt", suggestion: "Улучшить промпт", reason: "Так будет лучше" }],
	});

	// Test 12: Model selection — configured found
	{
		console.log("Test: model selection — configured model found");
		const mockModel = { provider: "zai", id: "glm-4.5-air", api: "openai-completions" };
		const deps = makeMockDeps({
			complete: makeMockComplete(goodResponse),
			findResult: mockModel,
			models: [{ provider: "openai", id: "gpt-4", cost: { input: 30 } }],
		});
		const cfg = makeCfg({ provider: "zai", model: "glm-4.5-air" });
		const batches = compressTrajectory(sampleTrajectory, cfg);
		const result = await runJudge(batches, deps, cfg, sampleTrajectory);

		assert(result.unavailable !== true, "Judge is available");
		assert(result.model === "zai/glm-4.5-air", `Model is zai/glm-4.5-air: got ${result.model}`);
	}

	// Test 13: Model selection — configured not found → cheapest
	{
		console.log("Test: model selection — configured not found → cheapest");
		const cheapModel = { provider: "cheap", id: "tiny", api: "openai-completions", cost: { input: 0.1 } };
		const expensiveModel = { provider: "exp", id: "big", api: "openai-completions", cost: { input: 50 } };
		const deps = makeMockDeps({
			complete: makeMockComplete(goodResponse),
			findResult: undefined, // configured not found
			models: [expensiveModel, cheapModel],
		});
		const cfg = makeCfg({ provider: "zai", model: "missing" });
		const batches = compressTrajectory(sampleTrajectory, cfg);
		const result = await runJudge(batches, deps, cfg, sampleTrajectory);

		assert(result.model === "cheap/tiny", `Cheapest model selected: got ${result.model}`);
	}

	// Test 14: Model selection — empty registry → currentModel
	{
		console.log("Test: model selection — empty registry → currentModel");
		const current = { provider: "current", id: "model-x", api: "openai-completions" };
		const deps = makeMockDeps({
			complete: makeMockComplete(goodResponse),
			findResult: undefined,
			models: [],
			currentModel: current,
		});
		const cfg = makeCfg({ provider: "zai", model: "missing" });
		const batches = compressTrajectory(sampleTrajectory, cfg);
		const result = await runJudge(batches, deps, cfg, sampleTrajectory);

		assert(result.model === "current/model-x", `Current model fallback: got ${result.model}`);
	}

	// Test 15: Model selection — nothing available → unavailable
	{
		console.log("Test: model selection — nothing → unavailable");
		const deps = makeMockDeps({
			complete: makeMockComplete(goodResponse),
			findResult: undefined,
			models: [],
			currentModel: undefined,
		});
		const cfg = makeCfg({ provider: "zai", model: "missing" });
		const batches = compressTrajectory(sampleTrajectory, cfg);
		const result = await runJudge(batches, deps, cfg, sampleTrajectory);

		assert(result.unavailable === true, "Judge is unavailable");
		assert(result.judgeScore === 0, "Score is 0 when unavailable");
	}

	// Test 16: Retry on invalid response
	{
		console.log("Test: retry on invalid response");
		let callCount = 0;
		const mockComplete = async () => {
			callCount++;
			if (callCount === 1) {
				return { content: [{ type: "text", text: "not json" }], usage: { input: 10, output: 5, cost: { total: 0 } } };
			}
			return {
				content: [{ type: "text", text: goodResponse }],
				usage: { input: 10, output: 5, cost: { total: 0 } },
			};
		};
		const deps = makeMockDeps({
			complete: mockComplete,
			models: [{ provider: "test", id: "m1", api: "openai-completions", cost: { input: 1 } }],
		});
		const cfg = makeCfg();
		const batches = compressTrajectory(sampleTrajectory, cfg);
		const result = await runJudge(batches, deps, cfg, sampleTrajectory);

		assert(callCount === 2, `Called twice (retry happened): ${callCount}`);
		assert(result.judgeScore > 0, "Got valid score after retry");
	}

	// Test 17: Exception in batch → n/a, others continue
	{
		console.log("Test: exception in one batch → n/a, others ok");
		let callIdx = 0;
		const mockComplete = async () => {
			callIdx++;
			if (callIdx === 1) throw new Error("API error");
			return {
				content: [{ type: "text", text: goodResponse }],
				usage: { input: 10, output: 5, cost: { total: 0 } },
			};
		};
		const deps = makeMockDeps({
			complete: mockComplete,
			models: [{ provider: "test", id: "m1", api: "openai-completions", cost: { input: 1 } }],
		});
		const cfg = makeCfg({ batchMaxSteps: 2 }); // Force 2+ batches
		const batches = compressTrajectory(sampleTrajectory, cfg);
		assert(batches.length >= 2, `Have 2+ batches: ${batches.length}`);

		const result = await runJudge(batches, deps, cfg, sampleTrajectory);
		// Should not crash; should have some scores from batch 2
		assert(result.usage.calls >= 2, `Usage calls >= 2: ${result.usage.calls}`);
	}

	// Test 18: Aggregation — average and rounding to 0.5
	{
		console.log("Test: aggregation average and rounding to 0.5");
		// Two batches with different scores for same rubric
		const responses = [
			JSON.stringify({ rubrics: { skillAppropriateness: { score: 1, justification: "a", stepRefs: [] }, completeness: { score: 2, justification: "b", stepRefs: [] }, economy: { score: 1, justification: "c", stepRefs: [] }, compliance: { score: 2, justification: "d", stepRefs: [] } }, recommendations: [] }),
			JSON.stringify({ rubrics: { skillAppropriateness: { score: 3, justification: "e", stepRefs: [] }, completeness: { score: 2, justification: "f", stepRefs: [] }, economy: { score: 3, justification: "g", stepRefs: [] }, compliance: { score: 2, justification: "h", stepRefs: [] } }, recommendations: [] }),
		];
		let batchIdx = 0;
		const mockComplete = async () => {
			const resp = responses[Math.min(batchIdx, responses.length - 1)];
			batchIdx++;
			return { content: [{ type: "text", text: resp }], usage: { input: 10, output: 5, cost: { total: 0 } } };
		};

		const steps: TrajectoryStep[] = [];
		for (let i = 0; i < 10; i++) steps.push(makeStep("user", i, { args: { text: `msg${i}` } }));
		const traj = makeTrajectory(steps);
		const deps = makeMockDeps({
			complete: mockComplete,
			models: [{ provider: "test", id: "m1", api: "openai-completions", cost: { input: 1 } }],
		});
		const cfg = makeCfg({ batchMaxSteps: 5 }); // 2 batches
		const batches = compressTrajectory(traj, cfg);
		const result = await runJudge(batches, deps, cfg, traj);

		// skillAppropriateness: avg(1,3) = 2.0
		const saScore = result.rubrics.skillAppropriateness;
		assert(saScore !== "n/a" && (saScore as any).score === 2, `skillAppropriateness avg = 2: got ${saScore !== "n/a" ? (saScore as any).score : "n/a"}`);

		// economy: avg(1,3) = 2.0
		const ecScore = result.rubrics.economy;
		assert(ecScore !== "n/a" && (ecScore as any).score === 2, `economy avg = 2: got ${ecScore !== "n/a" ? (ecScore as any).score : "n/a"}`);
	}

	// Test 19: Usage accumulation
	{
		console.log("Test: usage accumulation across batches");
		const mockComplete = async () => ({
			content: [{ type: "text", text: goodResponse }],
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
		});
		const steps: TrajectoryStep[] = [];
		for (let i = 0; i < 10; i++) steps.push(makeStep("user", i, { args: { text: `m${i}` } }));
		const traj = makeTrajectory(steps);
		const deps = makeMockDeps({
			complete: mockComplete,
			models: [{ provider: "test", id: "m1", api: "openai-completions", cost: { input: 1 } }],
		});
		const cfg = makeCfg({ batchMaxSteps: 5 });
		const batches = compressTrajectory(traj, cfg);
		const result = await runJudge(batches, deps, cfg, traj);

		assert(result.usage.calls >= 2, `Usage calls >= 2: ${result.usage.calls}`);
		assert(result.usage.inputTokens >= 200, `Input tokens >= 200: ${result.usage.inputTokens}`);
		assert(result.usage.cost >= 0.01, `Cost >= 0.01: ${result.usage.cost}`);
	}
}

// ============================================================================
// RUBRICS TESTS
// ============================================================================

async function testRubrics() {
	console.log("\n=== Rubrics Tests ===\n");

	// Test 20: getActiveRubricKeys — no delegate_task
	{
		console.log("Test: no delegate_task → decomposition/orchestrationQuality excluded");
		const trajectory = makeTrajectory([
			makeStep("user", 0, { args: { text: "fix" } }),
			makeStep("tool_call", 1, { toolName: "edit" }),
		], false);
		const keys = getActiveRubricKeys(trajectory);
		assert(!keys.includes("decomposition"), "decomposition excluded");
		assert(!keys.includes("orchestrationQuality"), "orchestrationQuality excluded");
		assert(keys.includes("skillAppropriateness"), "skillAppropriateness included");
		assert(keys.includes("completeness"), "completeness included");
	}

	// Test 21: getActiveRubricKeys — with delegate_task
	{
		console.log("Test: with delegate_task → all keys included");
		const trajectory = makeTrajectory([
			makeStep("user", 0, { args: { text: "fix" } }),
		], true);
		const keys = getActiveRubricKeys(trajectory);
		assert(keys.includes("decomposition"), "decomposition included");
		assert(keys.includes("orchestrationQuality"), "orchestrationQuality included");
		assert(keys.length === 6, `All 6 keys: ${keys.length}`);
	}

	// Test 22: buildJudgePrompt — last batch gets recommendations instruction
	{
		console.log("Test: last batch prompt includes recommendations instruction");
		const batch: JudgeBatch = {
			index: 0,
			totalBatches: 1,
			header: "Batch 1 of 1",
			steps: ["[#1 user] hello"],
			isLast: true,
		};
		const { systemPrompt, userText } = buildJudgePrompt(batch, ["skillAppropriateness", "completeness"]);
		assert(userText.includes("LAST batch"), "User text mentions LAST batch");
		assert(userText.includes("recommendations"), "User text mentions recommendations");
		assert(systemPrompt.includes("skillAppropriateness"), "System prompt includes rubric key");
	}
}

// ============================================================================
// FULL PIPELINE TEST
// ============================================================================

async function testFullPipeline() {
	console.log("\n=== Full Pipeline Test ===\n");

	// Test 23: Full pipeline with mock judge
	{
		console.log("Test: full pipeline with mock produces judge section in report");
		const goodResponse = JSON.stringify({
			rubrics: {
				skillAppropriateness: { score: 2, justification: "Хороший выбор скилла", stepRefs: [1] },
				completeness: { score: 3, justification: "Запрос выполнен полностью", stepRefs: [2] },
				economy: { score: 2, justification: "Эффективный флоу", stepRefs: [1, 2] },
				compliance: { score: 3, justification: "Все правила соблюдены", stepRefs: [] },
			},
			recommendations: [
				{ target: "prompt", suggestion: "Добавить проверки edge cases", reason: "Улучшит надёжность" },
			],
		});

		const mockComplete = makeMockComplete(goodResponse);
		const mockModel = { provider: "test", id: "judge-model", api: "openai-completions" };

		const judgeDeps: JudgeDeps = {
			complete: mockComplete,
			modelRegistry: {
				find: () => mockModel,
				getAvailable: () => [mockModel],
			},
			currentModel: mockModel,
		};

		// We need a real session file. Use a minimal JSONL in a temp dir.
		const { writeFile, mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const testDir = join(tmpdir(), `fan-test-judge-${Date.now()}`);
		const sessionsDir = join(testDir, ".fan", "agent", "sessions", "--test--");
		await mkdir(sessionsDir, { recursive: true });

		const ts = new Date().toISOString();
		const s1 = JSON.stringify({ type: "session", id: "judge-test-session", timestamp: ts, cwd: "/test" });
		const s2 = JSON.stringify({ id: "e1", parentId: null, type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text: "Fix the auth bug" }] } });
		const s3 = JSON.stringify({
			id: "e2",
			parentId: "e1",
			type: "message",
			timestamp: ts,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "auth.ts" } }],
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		});
		const s4 = JSON.stringify({ id: "e3", parentId: "e2", type: "message", timestamp: ts, message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "auth code" }], isError: false } });
		const s5 = JSON.stringify({ id: "e4", parentId: "e3", type: "message", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "Fixed the auth bug." }] } });
		const sessionContent = [s1, s2, s3, s4, s5].join("\n");

		const sessionPath = join(sessionsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_test.jsonl`);
		await writeFile(sessionPath, sessionContent, "utf-8");

		const cfg = makeCfg({ provider: "test", model: "judge-model" });

		try {
			const { results } = await runPipeline({
				target: sessionPath,
				mode: "full",
				cwd: testDir,
				cfg,
				judgeDeps,
			});

			assert(results.length === 1, `Got 1 result: ${results.length}`);

			const result = results[0];
			assert(result.score.judge !== undefined, "Judge result present");
			assert(result.score.judge?.judgeScore !== undefined, "Judge score present");
			assert(result.score.judge?.judgeScore !== undefined && result.score.judge.judgeScore > 0, `Judge score > 0: ${result.score.judge?.judgeScore}`);
			assert(result.score.combinedScore !== undefined, "Combined score present");

			// Read report and check judge section
			const { readFile } = await import("node:fs/promises");
			const reportContent = await readFile(result.reportPath, "utf-8");
			assert(reportContent.includes("Оценки судьи"), "Report contains 'Оценки судьи'");
			assert(reportContent.includes("Рекомендации судьи"), "Report contains 'Рекомендации судьи'");
			assert(reportContent.includes("judge-model"), "Report mentions model name");

			console.log("\n  📄 Report fragment (judge section):");
			const judgeStart = reportContent.indexOf("## Оценки судьи");
			const judgeEnd = reportContent.indexOf("## Сводка вызовов") || reportContent.length;
			if (judgeStart !== -1) {
				const fragment = reportContent.slice(judgeStart, judgeEnd).split("\n").slice(0, 15).join("\n  ");
				console.log(`  ${fragment}`);
			}
		} finally {
			// Cleanup
			try {
				const { rm } = await import("node:fs/promises");
				await rm(testDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

// ============================================================================
// MAIN
// ============================================================================

// ============================================================================
// D12 WORKER ROUTING TESTS
// ============================================================================

async function testD12() {
	console.log("\n=== D12 Worker Routing Tests ===\n");

	const baseCfg: AnalyticsConfig = {
		...DEFAULT_CONFIG,
		detectors: { ...DEFAULT_CONFIG.detectors, d12Enabled: true },
	};

	function makeTrajectoryWithDelegate(agent: string, task: string): Trajectory {
		return {
			sessionId: "d12-test",
			path: "/test/d12.jsonl",
			cwd: "/test",
			startedAt: Date.now(),
			endedAt: Date.now() + 60000,
			steps: [
				{
					entryId: "d12-e1",
					ts: Date.now(),
					kind: "tool_call",
					toolName: "delegate_task",
					args: { agent, task },
				},
			],
			skillsActivated: [],
			workersSpawned: [],
			compactions: 0,
			truncated: false,
			invalidLines: 0,
			totalLines: 2,
		};
	}

	// Test 24: Mismatch — bug-fix task with implement agent → finding
	{
		console.log("Test: task 'исправь падающий тест' + agent 'implement' → finding");
		const t = makeTrajectoryWithDelegate("implement", "исправь падающий тест в auth модуле");
		const findings = await detectWorkerRouting(t, baseCfg);
		assert(findings.length === 1, `Expected 1 finding, got ${findings.length}`);
		assert(findings[0].detectorId === "D12", "detectorId is D12");
		assert(findings[0].severity === "low", `Single mismatch → low severity: got ${findings[0].severity}`);
		assert(findings[0].title.includes("bug-fix"), `Title mentions bug-fix: ${findings[0].title}`);
	}

	// Test 25: Correct routing — bug-fix task with bug-fix agent → no finding
	{
		console.log("Test: task 'исправь падающий тест' + agent 'bug-fix' → clean");
		const t = makeTrajectoryWithDelegate("bug-fix", "исправь падающий тест в auth модуле");
		const findings = await detectWorkerRouting(t, baseCfg);
		assert(findings.length === 0, `Expected 0 findings, got ${findings.length}`);
	}

	// Test 26: No markers → skip (no finding)
	{
		console.log("Test: task without markers → clean");
		const t = makeTrajectoryWithDelegate("implement", "выполни задачу по проекту");
		const findings = await detectWorkerRouting(t, baseCfg);
		assert(findings.length === 0, `Expected 0 findings, got ${findings.length}`);
	}

	// Test 27: 2+ mismatches → medium severity
	{
		console.log("Test: 2 mismatches → medium severity");
		const t: Trajectory = {
			sessionId: "d12-test-multi",
			path: "/test/d12-multi.jsonl",
			cwd: "/test",
			startedAt: Date.now(),
			endedAt: Date.now() + 60000,
			steps: [
				{
					entryId: "d12-m1",
					ts: Date.now(),
					kind: "tool_call",
					toolName: "delegate_task",
					args: { agent: "implement", task: "исследуй архитектуру проекта" },
				},
				{
					entryId: "d12-m2",
					ts: Date.now() + 1000,
					kind: "tool_call",
					toolName: "delegate_task",
					args: { agent: "implement", task: "проанализируй зависимости модулей" },
				},
			],
			skillsActivated: [],
			workersSpawned: [],
			compactions: 0,
			truncated: false,
			invalidLines: 0,
			totalLines: 3,
		};
		const findings = await detectWorkerRouting(t, baseCfg);
		assert(findings.length === 2, `Expected 2 findings, got ${findings.length}`);
		assert(
			findings.every((f) => f.severity === "medium"),
			`All findings are medium severity: ${findings.map((f) => f.severity).join(", ")}`,
		);
	}

	// Test 28: explore/code-research aliases are interchangeable
	{
		console.log("Test: explore task with code-research agent → clean (aliases)");
		const t = makeTrajectoryWithDelegate("code-research", "исследуй архитектуру проекта");
		const findings = await detectWorkerRouting(t, baseCfg);
		assert(findings.length === 0, `Expected 0 findings (alias), got ${findings.length}`);
	}

	// Test 29: d12Enabled=false → no findings
	{
		console.log("Test: d12Enabled=false → detector skipped");
		const disabledCfg: AnalyticsConfig = {
			...baseCfg,
			detectors: { ...baseCfg.detectors, d12Enabled: false },
		};
		const t = makeTrajectoryWithDelegate("implement", "исправь падающий тест");
		const findings = await detectWorkerRouting(t, disabledCfg);
		assert(findings.length === 0, `Expected 0 findings when disabled, got ${findings.length}`);
	}

	// Test 30: English markers work
	{
		console.log("Test: English markers — 'fix the regression' + agent 'explore' → finding");
		const t = makeTrajectoryWithDelegate("explore", "fix the regression in auth module");
		const findings = await detectWorkerRouting(t, baseCfg);
		assert(findings.length === 1, `Expected 1 finding, got ${findings.length}`);
		assert(findings[0].title.includes("bug-fix"), `Title mentions bug-fix: ${findings[0].title}`);
	}
}

async function testAssistantTextExtraction() {
	console.log("\n=== Assistant Text Extraction (regression: thinking+text blocks) ===\n");

	// Регрессия: assistant message с content [thinking, text] — текст должен попадать в батч судьи
	{
		console.log("Test: assistant text visible in judge batch despite thinking block");
		const entries = [
			{ type: "session", version: 3, id: "s1", timestamp: "2026-08-02T00:00:00Z", cwd: "/tmp" },
			{
				type: "message", id: "e1", parentId: null, timestamp: "2026-08-02T00:00:01Z",
				message: { role: "user", content: [{ type: "text", text: "Привет" }], timestamp: 1 },
			},
			{
				type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-02T00:00:02Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "должен ответить" },
						{ type: "text", text: "Здравствуй, мясной мешок!" },
					],
					api: "openai-completions", provider: "test", model: "t1", timestamp: 2,
				},
			},
		];
		const trajectory = buildTrajectory({ entries } as any);
		const batches = compressTrajectory(trajectory, DEFAULT_CONFIG);
		const allText = batches.flatMap((b) => b.steps).join("\n");
		assert(
			allText.includes("Здравствуй, мясной мешок!"),
			"assistant text должен быть виден в батче судьи (ранее терялся из-за thinking-блока)",
		);
	}
}

async function main() {
	console.log("=== FAN Session Analytics — Judge (Stage B) Verification ===");
	console.log(`Date: ${new Date().toISOString()}`);

	await testBatcher();
	await testValidate();
	await testClient();
	await testRubrics();
	await testFullPipeline();
	await testD12();
	await testAssistantTextExtraction();

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
