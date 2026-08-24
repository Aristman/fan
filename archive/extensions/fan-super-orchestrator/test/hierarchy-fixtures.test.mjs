// F-35 (fixtures): валидатор фикстур test/fixtures/http-hierarchy/.
//
// Фикстуры — образцы артефактов протокола HTTP-иерархии. Этот файл
// гарантирует, что они парсятся СООТВЕТСТВУЮЩИМИ модулями (не моками):
//   work-package.json    → parseWorkPackage / createWorkPackage (F-27)
//   node-report.json     → parseNodeReport над text + totalUsage (F-28)
//   mission-budget.json  → readMissionBudgetFile / createMissionBudgetStore (F-31)
//   tree-journal.jsonl   → createTreeJournal.readAll + reconstructTree (F-32)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMissionBudgetStore, readMissionBudgetFile } from "../budget-coordinator.js";
import { parseNodeReport, totalUsage } from "../node-report.js";
import { createTreeJournal, reconstructTree } from "../tree-journal.js";
import { createWorkPackage, parseWorkPackage, serializeWorkPackage } from "../work-package.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "http-hierarchy");

/** Прочитать JSON-фикстуру. */
function readJsonFixture(name) {
	return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

// ─── work-package.json ──────────────────────────────────────────────────────

describe("fixture work-package.json: валидный пакет по спеке §3.3.2", () => {
	it("parseWorkPackage(JSON.stringify({work_package: fixture})) → пакет с полями фикстуры", () => {
		const raw = readJsonFixture("work-package.json");
		const wp = parseWorkPackage(JSON.stringify({ work_package: raw }));

		expect(wp).not.toBeNull();
		expect(wp.task).toBe(raw.task);
		expect(wp.correlationId).toBe("mission-fixture/L1/node-1");
		expect(wp.depth).toBe(1);
		expect(wp.tokenBudget).toBe(26_666);
		expect(wp.costBudgetUsd).toBe(2.6667);
		expect(wp.maxRetries).toBe(2);
		expect(wp.spawnBudget).toBe(0);
		expect(wp.toolManifest).toEqual(["read", "write", "bash"]);
		expect(wp.deadline).toBe("2026-12-31T23:59:59.000Z");
		expect(wp.verificationCommand).toBe("npm test");
		expect(wp.context?.relevantFiles).toEqual(["src/auth/middleware.ts", "src/auth/session.ts"]);
	});

	it("createWorkPackage(fixture) не бросает и сохраняет поля", () => {
		const raw = readJsonFixture("work-package.json");
		const wp = createWorkPackage(raw);
		expect(wp.correlationId).toBe(raw.correlationId);
		expect(wp.tokenBudget).toBe(raw.tokenBudget);
	});

	it("serialize → parse roundtrip: пакет выживает SendMessageRequest-форму", () => {
		const raw = readJsonFixture("work-package.json");
		const wp = createWorkPackage(raw);
		const serialized = serializeWorkPackage(wp);

		expect(serialized.streamingBehavior).toBe("followUp");
		expect(parseWorkPackage(serialized.message)).toEqual(wp);
	});
});

// ─── node-report.json ───────────────────────────────────────────────────────

describe("fixture node-report.json: отчёт с VERDICT PASS + usage + children", () => {
	it("parseNodeReport(text, meta+usage) → completed/PASS, usage из фикстуры", () => {
		const fixture = readJsonFixture("node-report.json");
		const report = parseNodeReport(fixture.text, { ...fixture.meta, usage: fixture.usage });

		expect(report.status).toBe("completed");
		expect(report.verdict).toBe("PASS");
		expect(report.nodeId).toBe("L1/node-1");
		expect(report.correlationId).toBe("mission-fixture/L1/node-1");
		expect(report.usage).toEqual({ inputTokens: 20_000, outputTokens: 10_000, costUsd: 3 });
		expect(report.result.text).toContain("VERDICT: PASS");
	});

	it("children парсятся тем же parseNodeReport; totalUsage агрегирует рекурсивно", () => {
		const fixture = readJsonFixture("node-report.json");
		const report = parseNodeReport(fixture.text, { ...fixture.meta, usage: fixture.usage });
		report.children = fixture.children.map((child) =>
			parseNodeReport(child.text, { ...child.meta, usage: child.usage }),
		);

		expect(report.children).toHaveLength(1);
		expect(report.children[0].verdict).toBe("PASS");
		expect(report.children[0].nodeId).toBe("L2/node-1");

		const total = totalUsage(report);
		expect(total.inputTokens).toBe(20_100);
		expect(total.outputTokens).toBe(10_050);
		expect(total.costUsd).toBeCloseTo(3.01, 10);
	});
});

// ─── mission-budget.json ────────────────────────────────────────────────────

describe("fixture mission-budget.json: состояние бюджета читается координатором", () => {
	it("readMissionBudgetFile → missions['mission-fixture'] на месте", () => {
		const file = readMissionBudgetFile(join(FIXTURES_DIR, "mission-budget.json"));

		expect(file).not.toBeNull();
		const mission = file.missions["mission-fixture"];
		expect(mission.budgetTotal).toEqual({ tokens: 100_000, usd: 10 });
		expect(mission.consumed).toEqual({ tokens: 30_000, usd: 3 });
		expect(Object.keys(mission.byBranch)).toHaveLength(3);
	});

	it("createMissionBudgetStore.load() → запись валидна по схеме BudgetState (не defaults)", () => {
		// load() не мутирует файл: читаем прямо из фикстуры через store с
		// ЗАВЕДОМО другими defaults — если запись валидна, defaults не вернутся.
		const store = createMissionBudgetStore(join(FIXTURES_DIR, "mission-budget.json"), "mission-fixture", {
			budgetTotal: { tokens: -1, usd: -1 },
			allocated: { tokens: -1, usd: -1 },
			consumed: { tokens: -1, usd: -1 },
			peak: { tokens: -1, usd: -1 },
			byBranch: { sentinel: { tokens: -1, usd: -1 } },
		});
		const state = store.load();

		expect(state.budgetTotal).toEqual({ tokens: 100_000, usd: 10 });
		expect(state.byBranch["L1/node-1"]).toEqual({ tokens: 30_000, usd: 3 });
		expect(state.byBranch.sentinel).toBeUndefined();
	});
});

// ─── tree-journal.jsonl ─────────────────────────────────────────────────────

describe("fixture tree-journal.jsonl: 5 записей, reconstructTree восстанавливает топологию", () => {
	it("readAll → 5 валидных записей, correlationId сквозной (mission-fixture)", () => {
		const journal = createTreeJournal(join(FIXTURES_DIR, "tree-journal.jsonl"));
		const entries = journal.readAll();

		expect(entries).toHaveLength(5);
		expect(entries.filter((e) => e.event === "spawn")).toHaveLength(4);
		expect(entries.filter((e) => e.event === "complete")).toHaveLength(1);
		for (const entry of entries) {
			expect(entry.correlationId).toMatch(/^mission-fixture\//);
		}
	});

	it("reconstructTree: L0 — корень с 3 детьми; node-1 complete с usage, node-2/3 в spawn", () => {
		const journal = createTreeJournal(join(FIXTURES_DIR, "tree-journal.jsonl"));
		const tree = reconstructTree(journal.readAll());

		expect(tree.roots).toEqual(["L0"]);
		expect(tree.nodes.L0.children).toEqual(["L1/node-1", "L1/node-2", "L1/node-3"]);
		expect(tree.nodes["L1/node-1"].status).toBe("complete");
		expect(tree.nodes["L1/node-1"].usage).toEqual({ tokens: 30_000, usd: 3 });
		expect(tree.nodes["L1/node-2"].status).toBe("spawn");
		expect(tree.nodes["L1/node-3"].status).toBe("spawn");
		expect(tree.nodes["L1/node-2"].parentId).toBe("L0");
	});
});
