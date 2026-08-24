// F-35 / TC-F35-1: бюджетный инвариант на реальных mock-узлах (HTTP + WS).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-35
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.4
//
// Интеграционный слой: НЕ мокаем fetch/ws — child-node-client (F-29) ходит
// по настоящему HTTP/WS против 3 mock-узлов (helpers/mock-node-server.mjs).
//
// Полный цикл на каждый узел: computeChildAllocation (26666 при 100000/3) →
// allocate → journal spawn → createWorkPackage → sendWorkPackage (реальный
// fetch + ws) → NodeReport → recordUsage → journal complete → onNodeComplete.
//
// Проверки:
//   • после КАЖДОГО отчёта Σallocated ≤ 100000 в mission-budget.json НА ДИСКЕ;
//   • финал: Σconsumed = 75000 токенов (30000+25000+20000) / 7.5 USD;
//   • by_branch — 3 записи с атрибуцией по узлам;
//   • каждый mock-узел реально получил work_package своего correlationId.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBudgetAggregator, emptyBudgetState } from "../budget-aggregator.js";
import {
	computeChildAllocation,
	createMissionBudgetStore,
	readMissionBudgetFile,
} from "../budget-coordinator.js";
import { createChildNodeClient } from "../child-node-client.js";
import { totalUsage } from "../node-report.js";
import { createTreeJournal } from "../tree-journal.js";
import { createWorkPackage, makeCorrelationId } from "../work-package.js";
import { portRange, startMockOnFreePort, wsFactory } from "./helpers/hierarchy-helpers.mjs";

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-f35-budget-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Mock-узел + регистрация stop() в cleanup. */
async function trackMock(opts, candidates) {
	const mock = await startMockOnFreePort(opts, candidates);
	cleanups.push(() => mock.stop());
	return mock;
}

const TOKEN = "f35-budget-token";
const MISSION = "mission-f35-budget";
const BUDGET_TOKENS = 100_000;
const BUDGET_USD = 10;

// ─── TC-F35-1 ───────────────────────────────────────────────────────────────

describe("TC-F35-1: инвариант Σallocated ≤ budget_total после каждого отчёта", () => {
	it(
		"3 mock-узла (30000/25000/20000 токенов): полный цикл, финал Σconsumed = 75000, by_branch 3 записи",
		async () => {
			const tmp = makeTmpDir();
			const budgetFile = join(tmp, "mission-budget.json");
			const journalFile = join(tmp, "tree-journal.jsonl");

			const store = createMissionBudgetStore(budgetFile, MISSION, emptyBudgetState(BUDGET_TOKENS, BUDGET_USD));
			const aggregator = createBudgetAggregator(store);
			const journal = createTreeJournal(journalFile);

			// 3 mock-узла с разным расходом (Σ = 75000 токенов / 7.5 USD).
			const specs = [
				{ nodeId: "L1/node-1", usage: { inputTokens: 20_000, outputTokens: 10_000, costUsd: 3 } },
				{ nodeId: "L1/node-2", usage: { inputTokens: 15_000, outputTokens: 10_000, costUsd: 2.5 } },
				{ nodeId: "L1/node-3", usage: { inputTokens: 15_000, outputTokens: 5_000, costUsd: 2 } },
			];
			const candidates = portRange(7021, 7030);
			const mocks = [];
			for (const spec of specs) {
				mocks.push(await trackMock({ token: TOKEN, usage: spec.usage, delayMs: 80 }, candidates));
			}

			// Аллокация единообразная: 0.8 × 100000 / 3 = 26666 (floor).
			const allocation = computeChildAllocation(aggregator.state(), 3);
			expect(allocation.tokens).toBe(26_666);
			expect(allocation.usd).toBe(2.6667);

			const client = createChildNodeClient({ wsFactory });
			cleanups.push(() => client.close());
			const deadline = new Date(Date.now() + 30_000).toISOString();

			// Fan-out: allocate + spawn-запись + пакет + sendWorkPackage на узел.
			const results = await Promise.all(
				specs.map(async (spec, index) => {
					const correlationId = makeCorrelationId(MISSION, 1, index + 1);
					expect(aggregator.allocate(spec.nodeId, allocation)).toBe(true);
					journal.write({
						event: "spawn",
						nodeId: spec.nodeId,
						parentId: "L0",
						correlationId,
						depth: 1,
						port: mocks[index].port,
					});
					const workPackage = createWorkPackage({
						task: `TC-F35-1: часть ${index + 1}`,
						correlationId,
						depth: 1,
						tokenBudget: allocation.tokens,
						costBudgetUsd: allocation.usd,
						deadline,
					});
					const report = await client.sendWorkPackage({
						port: mocks[index].port,
						token: TOKEN,
						workPackage,
					});
					return { spec, correlationId, report };
				}),
			);

			// Отчёты: completed/PASS, usage — из mock-узлов.
			for (const { spec, correlationId, report } of results) {
				expect(report.status).toBe("completed");
				expect(report.verdict).toBe("PASS");
				expect(report.nodeId).toBe(spec.nodeId);
				expect(report.correlationId).toBe(correlationId);
				expect(report.usage.inputTokens).toBe(spec.usage.inputTokens);
				expect(report.usage.outputTokens).toBe(spec.usage.outputTokens);
				expect(report.usage.costUsd).toBe(spec.usage.costUsd);
			}

			// Mock-узлы реально получили пакеты (SendMessageRequest-форма).
			for (const [index, mock] of mocks.entries()) {
				const received = mock.receivedWorkPackage();
				expect(received).not.toBeNull();
				expect(received.streamingBehavior).toBe("followUp");
				const receivedWp = JSON.parse(received.message).work_package;
				expect(receivedWp.correlationId).toBe(makeCorrelationId(MISSION, 1, index + 1));
				expect(receivedWp.tokenBudget).toBe(26_666);
			}

			// После fan-out Σallocated = 3 × 26666 = 79998 ≤ 100000 — на диске.
			const afterAlloc = readMissionBudgetFile(budgetFile).missions[MISSION];
			expect(afterAlloc.allocated.tokens).toBe(79_998);
			expect(afterAlloc.allocated.tokens).toBeLessThanOrEqual(BUDGET_TOKENS);

			// Учёт отчётов: после КАЖДОГО — инвариант Σallocated ≤ budget_total
			// проверяется в mission-budget.json НА ДИСКЕ (оба измерения).
			const expectedAllocatedTokens = [53_332, 26_666, 0];
			for (const [index, { spec, correlationId, report }] of results.entries()) {
				const usage = totalUsage(report);
				aggregator.recordUsage(spec.nodeId, usage);
				aggregator.onNodeComplete(spec.nodeId, allocation);
				journal.write({
					event: "complete",
					nodeId: spec.nodeId,
					parentId: "L0",
					correlationId,
					depth: 1,
					usage: { tokens: usage.inputTokens + usage.outputTokens, usd: usage.costUsd },
				});

				const onDisk = readMissionBudgetFile(budgetFile).missions[MISSION];
				expect(onDisk.allocated.tokens).toBe(expectedAllocatedTokens[index]);
				expect(onDisk.allocated.tokens).toBeLessThanOrEqual(BUDGET_TOKENS);
				expect(onDisk.allocated.usd).toBeLessThanOrEqual(BUDGET_USD + 1e-9);
			}

			// Финал: Σconsumed = 75000 токенов / 7.5 USD; allocated возвращён в пул.
			const finalState = aggregator.state();
			expect(finalState.consumed.tokens).toBe(75_000);
			expect(finalState.consumed.usd).toBeCloseTo(7.5, 10);
			expect(finalState.allocated.tokens).toBe(0);
			expect(finalState.allocated.usd).toBeCloseTo(0, 10);

			// by_branch: 3 записи с атрибуцией расхода по узлам.
			expect(Object.keys(finalState.byBranch).sort()).toEqual(["L1/node-1", "L1/node-2", "L1/node-3"]);
			expect(finalState.byBranch["L1/node-1"]).toEqual({ tokens: 30_000, usd: 3 });
			expect(finalState.byBranch["L1/node-2"]).toEqual({ tokens: 25_000, usd: 2.5 });
			expect(finalState.byBranch["L1/node-3"]).toEqual({ tokens: 20_000, usd: 2 });

			// Финальное состояние персистировано на диск.
			const diskFinal = readMissionBudgetFile(budgetFile).missions[MISSION];
			expect(diskFinal.consumed.tokens).toBe(75_000);
			expect(Object.keys(diskFinal.byBranch)).toHaveLength(3);
		},
		30_000,
	);
});
