// F-34: MVP глубины 2 (L0 → 3–4×L1) — RED-фаза TDD.
//
// Модуль ../depth2-integration.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-34
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Сквозная интеграция модулей фаз A/B: reconcile (F-33) → цикл по children:
// canSpawn (F-25) → computeChildAllocation + allocate (F-31/F-30) →
// generateNodeToken (F-24) → spawnNode (DI, прод: process-manager F-23) →
// journal spawn (F-32) → createWorkPackage + sendPackage (F-27/F-29 DI) →
// NodeReport (F-28) → recordUsage + journal complete + onNodeComplete (F-30).
// Kill-switch: abort() останавливает всё дерево (killNode DI + journal abort).
//
// Контракт модуля:
//   interface Depth2RunOptions {
//     task: string;                  // эпик
//     children: number;              // 3-4
//     childTasks?: string[];         // дефолт: `${task} — часть N` (N с 1)
//     toolManifest?: string[];       // → buildToolArgs → --tools в argv spawn
//     deadline: string;              // ISO, общий для пакетов
//   }
//   interface Depth2Options {
//     missionDir: string;            // mission-budget.json + tree-journal.jsonl в нём
//     missionId: string;
//     budgetTotal: { tokens: number; usd: number };
//     perHopCeiling?: number;        // default 30000
//     guardOptions?: { maxDepth?: number; maxWidth?: number; workingWidth?: number };
//     spawnNode?: (opts: { id: string; port: number; token: string; nodeName: string;
//                          args: string[] }) => Promise<{ pid: number }>;
//     sendPackage?: (opts: { port: number; token: string;
//                            workPackage: WorkPackage }) => Promise<NodeReport>;
//     killNode?: (id: string) => Promise<void>;
//     portsFile?: string; pidDir?: string;   // для reconcile (F-33) и пула портов
//   }
//   interface Depth2Result {
//     reports: Array<{ nodeId: string; report: NodeReport }>;
//     budget: { allocated: BudgetAmount; consumed: BudgetAmount;
//               byBranch: Record<string, BudgetAmount> };
//     journalEntries: number;
//     durationMs: number;
//   }
//   interface Depth2Handle {
//     run(opts: Depth2RunOptions): Promise<Depth2Result>;
//     abort(): Promise<void>;        // идемпотентен; kill-switch всего дерева
//   }
//   createDepth2Integration(opts: Depth2Options): Depth2Handle
//
// Закрепляемые решения (judgment calls RED-фазы):
//   • Аллокация единообразная: computeChildAllocation от состояния на старт
//     run с plannedChildren = children — все дети получают одинаковую долю
//     (roadmap TC-F34-2: «3 узла с tokenBudget = 26666 каждый» при 100000/3).
//   • Бюджетная недостаточность (allocate → false) по ТОКЕНАМ недостижима
//     при формуле F-31 (резерв 20%: children × 0.8·remaining/children ≤
//     0.8·total < total), поэтому тест «бюджет не хватает» срабатывает по
//     USD-лимиту через округление round4 вверх: 0.8·0.00015/2 = 0.00006 →
//     0.0001; 2 × 0.0001 = 0.0002 > 0.00015 → allocate 2-го ребёнка false.
//   • Ошибка spawnNode: аллокация НЕ возвращается (потрачена на попытку),
//     run бросает, журнал содержит spawn успешных узлов без complete.
//   • Fan-out: узлы порождаются и пакеты отправляются без ожидания отчёта
//     предыдущего (TC-F34-3: 3 узла активны одновременно).
//
// Покрытие (TC-карточки roadmap):
//   TC-F34-1  run({task, children:3}) с mock spawn/sendPackage → 3 узла на
//             портах 7001–7003, args с --tools, workPackage (correlationId
//             mission/L1/node-N, depth 1, tokenBudget=allocated, deadline,
//             spawnBudget 0), 3 spawn-записи журнала, все отчёты collected
//   TC-F34-2  budget_total 100000/10USD, 3 узла по 26666 → Σconsumed ≤ total,
//             byBranch 3 записи, final allocated {0,0} (onNodeComplete),
//             инвариант Σallocated ≤ budget_total в финальном снимке и на диске
//   TC-F34-3  3 узла активны (sendPackage висит) → abort() → killNode ×3,
//             3 abort-записи журнала, порты освобождены, run settles < 10 сек
//   Доп.      guard: children=5 при workingWidth=4 → max_width_exceeded на 5-м
//             (первые 4 созданы); depth=1 разрешён при maxDepth=2 и отклонён
//             при maxDepth=1 (guard вызывается на depth=1);
//             бюджет не хватает → ошибка, 1 узел создан;
//             spawnNode ошибка → run бросает, spawn без complete, allocated
//             не возвращается; verdict FAIL → отчёт сохранён, usage учтён,
//             контур не падает; abort до run / после run — идемпотентен;
//             reconcile (F-33) чистит orphan-запись portsFile до spawn;
//             журнал ≥ 2×children записей (spawn+complete) в успешном сценарии;
//             дефолтные childTasks `${task} — часть N`; дефолтные
//             portsFile/pidDir (без DI) — run работает.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// F-31/F-32 уже реализованы (GREEN) — статические импорты для проверки
// артефактов на диске (как в budget-coordinator.test.mjs).
import { readMissionBudgetFile } from "../budget-coordinator.js";
import { createTreeJournal } from "../tree-journal.js";

let createDepth2Integration;

beforeAll(async () => {
	const mod = await import("../depth2-integration.js");
	createDepth2Integration = mod.createDepth2Integration;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-d2-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

const DEADLINE = "2026-12-31T23:59:59.000Z";
const TOOL_MANIFEST = ["read", "write", "edit", "bash"];

/** Стенд миссии: missionDir + производные пути артефактов. */
function makeMission() {
	const missionDir = makeTmpDir();
	return {
		missionDir,
		missionId: "mission-f34",
		budgetTotal: { tokens: 100_000, usd: 10 },
		portsFile: join(missionDir, "child-ports.json"),
		pidDir: join(missionDir, "pids"),
		journalFile: join(missionDir, "tree-journal.jsonl"),
		budgetFile: join(missionDir, "mission-budget.json"),
	};
}

/** Handle интеграции с DI-моками поверх стенда. */
function makeHandle(mission, { spawnNode, sendPackage, killNode, ...extra } = {}) {
	return createDepth2Integration({
		missionDir: mission.missionDir,
		missionId: mission.missionId,
		budgetTotal: mission.budgetTotal,
		portsFile: mission.portsFile,
		pidDir: mission.pidDir,
		spawnNode: spawnNode ?? makeSpawnMock(),
		sendPackage: sendPackage ?? makeSendMock(),
		killNode: killNode ?? vi.fn(async () => {}),
		...extra,
	});
}

/** Мок spawnNode: «процесс» с pid, производным от порта. */
function makeSpawnMock() {
	return vi.fn(async ({ port }) => ({ pid: 10_000 + port }));
}

/** Мок sendPackage: мгновенный PASS-отчёт с usage 1500 tok / 0.1 USD. */
function makeSendMock(reportFor = defaultReportFor) {
	return vi.fn(async ({ port, workPackage }) => reportFor(port, workPackage));
}

/** NodeReport из workPackage: nodeId — хвост correlationId после missionId. */
function defaultReportFor(_port, workPackage) {
	const nodeId = workPackage.correlationId.split("/").slice(1).join("/");
	return makeReport(nodeId, workPackage.correlationId, {
		usage: { inputTokens: 1_000, outputTokens: 500, costUsd: 0.1 },
	});
}

/** Конструктор NodeReport (F-28-совместимый). */
function makeReport(nodeId, correlationId, { verdict = "PASS", status = "completed", usage = {} } = {}) {
	return {
		nodeId,
		correlationId,
		status,
		verdict,
		result: { text: `Готово.\nVERDICT: ${verdict ?? "PASS"}` },
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, ...usage },
	};
}

/** Управляемый промис (для зависающих sendPackage). */
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Записи tree-journal миссии (через F-32 readAll). */
function readJournal(mission) {
	return createTreeJournal(mission.journalFile).readAll();
}

/** Состояние бюджета миссии на диске (через F-31). */
function readBudgetState(mission) {
	return readMissionBudgetFile(mission.budgetFile)?.missions[mission.missionId];
}

/** Порты из portsFile ({} если файла нет). */
function readPorts(mission) {
	if (!existsSync(mission.portsFile)) {
		return {};
	}
	return JSON.parse(readFileSync(mission.portsFile, "utf8"));
}

// ─── TC-F34-1: run 3×L1 — spawn, пакеты, журнал, отчёты ────────────────────

describe("TC-F34-1: run({task, children: 3}) — 3 узла L1 с пакетами работ", () => {
	it("spawnNode вызван 3 раза: id L1/node-N, порты 7001–7003, args с --tools", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const handle = makeHandle(mission, { spawnNode });

		await handle.run({ task: "Рефакторинг auth", children: 3, toolManifest: TOOL_MANIFEST, deadline: DEADLINE });

		expect(spawnNode).toHaveBeenCalledTimes(3);
		for (let i = 0; i < 3; i++) {
			const opts = spawnNode.mock.calls[i][0];
			expect(opts.id).toBe(`L1/node-${i + 1}`);
			expect(opts.port).toBe(7001 + i);
			expect(typeof opts.nodeName).toBe("string");
			expect(opts.nodeName.length).toBeGreaterThan(0);
			expect(opts.args).toEqual(["--tools", "read,write,edit,bash"]);
		}
	});

	it("без toolManifest → args без --tools (пустой массив)", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const handle = makeHandle(mission, { spawnNode });

		await handle.run({ task: "Рефакторинг auth", children: 2, deadline: DEADLINE });

		expect(spawnNode).toHaveBeenCalledTimes(2);
		for (const [opts] of spawnNode.mock.calls) {
			expect(opts.args).toEqual([]);
		}
	});

	it("каждый узел получает уникальный токен (64 hex, F-24); sendPackage получает тот же токен", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const sendPackage = makeSendMock();
		const handle = makeHandle(mission, { spawnNode, sendPackage });

		await handle.run({ task: "Рефакторинг auth", children: 3, deadline: DEADLINE });

		const tokens = spawnNode.mock.calls.map(([opts]) => opts.token);
		for (const token of tokens) {
			expect(token).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(new Set(tokens).size).toBe(3);

		// sendPackage на порт узла — с токеном того же узла.
		const tokenByPort = new Map(spawnNode.mock.calls.map(([opts]) => [opts.port, opts.token]));
		for (const [opts] of sendPackage.mock.calls) {
			expect(opts.token).toBe(tokenByPort.get(opts.port));
		}
	});

	it("workPackage: correlationId mission/L1/node-N, depth 1, tokenBudget = allocated (26666), deadline, spawnBudget 0", async () => {
		const mission = makeMission();
		const sendPackage = makeSendMock();
		const handle = makeHandle(mission, { sendPackage });

		await handle.run({ task: "Рефакторинг auth", children: 3, toolManifest: TOOL_MANIFEST, deadline: DEADLINE });

		expect(sendPackage).toHaveBeenCalledTimes(3);
		for (let i = 0; i < 3; i++) {
			const wp = sendPackage.mock.calls[i][0].workPackage;
			expect(wp.task).toBe(`Рефакторинг auth — часть ${i + 1}`);
			expect(wp.correlationId).toBe(`mission-f34/L1/node-${i + 1}`);
			expect(wp.depth).toBe(1);
			// 0.8 × 100000 / 3 = 26666.67 → floor → 26666 (< ceiling 30000)
			expect(wp.tokenBudget).toBe(26_666);
			// 0.8 × 10 / 3 = 2.6666… → round4 → 2.6667 (ceiling к USD не применяется)
			expect(wp.costBudgetUsd).toBe(2.6667);
			expect(wp.toolManifest).toEqual(TOOL_MANIFEST);
			expect(wp.deadline).toBe(DEADLINE);
			expect(wp.spawnBudget).toBe(0);
		}
	});

	it("childTasks переопределяют дефолтные задачи", async () => {
		const mission = makeMission();
		const sendPackage = makeSendMock();
		const handle = makeHandle(mission, { sendPackage });

		await handle.run({
			task: "Рефакторинг auth",
			children: 2,
			childTasks: ["Выделить middleware", "Покрыть тестами"],
			deadline: DEADLINE,
		});

		expect(sendPackage.mock.calls[0][0].workPackage.task).toBe("Выделить middleware");
		expect(sendPackage.mock.calls[1][0].workPackage.task).toBe("Покрыть тестами");
	});

	it("журнал: 3 spawn (parentId L0, depth 1, port, task, correlationId) + 3 complete с usage", async () => {
		const mission = makeMission();
		const handle = makeHandle(mission);

		await handle.run({ task: "Рефакторинг auth", children: 3, deadline: DEADLINE });

		const entries = readJournal(mission);
		const spawns = entries.filter((e) => e.event === "spawn");
		const completes = entries.filter((e) => e.event === "complete");

		expect(spawns).toHaveLength(3);
		expect(completes).toHaveLength(3);
		// В успешном сценарии записей ≥ 2×children.
		expect(entries.length).toBeGreaterThanOrEqual(2 * 3);

		for (let i = 0; i < 3; i++) {
			const spawn = spawns[i];
			expect(spawn.nodeId).toBe(`L1/node-${i + 1}`);
			expect(spawn.parentId).toBe("L0");
			expect(spawn.correlationId).toBe(`mission-f34/L1/node-${i + 1}`);
			expect(spawn.task).toBe(`Рефакторинг auth — часть ${i + 1}`);
			expect(spawn.depth).toBe(1);
			expect(spawn.port).toBe(7001 + i);
		}

		// complete: usage = totalUsage(report) → tokens = input+output, usd = costUsd.
		for (const complete of completes) {
			expect(complete.usage).toEqual({ tokens: 1_500, usd: 0.1 });
		}
		// Для каждого узла spawn предшествует complete.
		for (const nodeId of ["L1/node-1", "L1/node-2", "L1/node-3"]) {
			const firstSpawn = entries.findIndex((e) => e.event === "spawn" && e.nodeId === nodeId);
			const firstComplete = entries.findIndex((e) => e.event === "complete" && e.nodeId === nodeId);
			expect(firstSpawn).toBeGreaterThanOrEqual(0);
			expect(firstComplete).toBeGreaterThan(firstSpawn);
		}
	});

	it("результат: reports 3 узлов, бюджетный снимок, journalEntries, durationMs", async () => {
		const mission = makeMission();
		const handle = makeHandle(mission);

		const result = await handle.run({ task: "Рефакторинг auth", children: 3, deadline: DEADLINE });

		expect(result.reports).toHaveLength(3);
		const byNode = new Map(result.reports.map((r) => [r.nodeId, r.report]));
		for (let i = 0; i < 3; i++) {
			const report = byNode.get(`L1/node-${i + 1}`);
			expect(report).toBeDefined();
			expect(report.status).toBe("completed");
			expect(report.verdict).toBe("PASS");
			expect(report.correlationId).toBe(`mission-f34/L1/node-${i + 1}`);
		}

		expect(result.budget.consumed.tokens).toBe(4_500); // 3 × 1500
		expect(result.budget.consumed.usd).toBeCloseTo(0.3, 10);
		expect(result.budget.allocated).toEqual({ tokens: 0, usd: 0 });
		expect(Object.keys(result.budget.byBranch)).toHaveLength(3);

		expect(result.journalEntries).toBe(readJournal(mission).length);
		expect(result.journalEntries).toBeGreaterThanOrEqual(6);
		expect(typeof result.durationMs).toBe("number");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});

// ─── TC-F34-2: бюджет не превышен, атрибуция по веткам ─────────────────────

describe("TC-F34-2: бюджет 100000/10 USD, 3 узла по 26666 — инварианты", () => {
	/** Разный расход узлов: 1500/3000/4500 tok, 0.1/0.2/0.3 USD. */
	function makeVaryingSendMock() {
		const usageByIndex = [
			{ inputTokens: 1_000, outputTokens: 500, costUsd: 0.1 },
			{ inputTokens: 2_000, outputTokens: 1_000, costUsd: 0.2 },
			{ inputTokens: 3_000, outputTokens: 1_500, costUsd: 0.3 },
		];
		let call = 0;
		return vi.fn(async ({ workPackage }) => {
			const nodeId = workPackage.correlationId.split("/").slice(1).join("/");
			return makeReport(nodeId, workPackage.correlationId, { usage: usageByIndex[call++ % 3] });
		});
	}

	it("каждый пакет получает tokenBudget 26666 (единая доля 0.8·total/children)", async () => {
		const mission = makeMission();
		const sendPackage = makeVaryingSendMock();
		const handle = makeHandle(mission, { sendPackage });

		await handle.run({ task: "Эпик", children: 3, deadline: DEADLINE });

		for (const [opts] of sendPackage.mock.calls) {
			expect(opts.workPackage.tokenBudget).toBe(26_666);
		}
	});

	it("Σconsumed ≤ budget_total; byBranch — 3 записи с расходом веток", async () => {
		const mission = makeMission();
		const handle = makeHandle(mission, { sendPackage: makeVaryingSendMock() });

		const result = await handle.run({ task: "Эпик", children: 3, deadline: DEADLINE });

		expect(result.budget.consumed.tokens).toBe(9_000);
		expect(result.budget.consumed.usd).toBeCloseTo(0.6, 10);
		expect(result.budget.consumed.tokens).toBeLessThanOrEqual(mission.budgetTotal.tokens);
		expect(result.budget.consumed.usd).toBeLessThanOrEqual(mission.budgetTotal.usd);

		expect(result.budget.byBranch["L1/node-1"]).toEqual({ tokens: 1_500, usd: 0.1 });
		expect(result.budget.byBranch["L1/node-2"]).toEqual({ tokens: 3_000, usd: 0.2 });
		expect(result.budget.byBranch["L1/node-3"]).toEqual({ tokens: 4_500, usd: 0.3 });
	});

	it("финальный снимок: allocated {0,0} после onNodeComplete (инвариант Σallocated ≤ total)", async () => {
		const mission = makeMission();
		const handle = makeHandle(mission, { sendPackage: makeVaryingSendMock() });

		const result = await handle.run({ task: "Эпик", children: 3, deadline: DEADLINE });

		expect(result.budget.allocated).toEqual({ tokens: 0, usd: 0 });
		expect(result.budget.allocated.tokens).toBeLessThanOrEqual(mission.budgetTotal.tokens);
		expect(result.budget.allocated.usd).toBeLessThanOrEqual(mission.budgetTotal.usd);
	});

	it("mission-budget.json на диске: byBranch 3 записи, allocated возвращён в пул", async () => {
		const mission = makeMission();
		const handle = makeHandle(mission, { sendPackage: makeVaryingSendMock() });

		await handle.run({ task: "Эпик", children: 3, deadline: DEADLINE });

		const state = readBudgetState(mission);
		expect(state).toBeDefined();
		expect(Object.keys(state.byBranch)).toHaveLength(3);
		expect(state.byBranch["L1/node-1"].tokens).toBe(1_500);
		expect(state.byBranch["L1/node-3"].tokens).toBe(4_500);
		expect(state.allocated).toEqual({ tokens: 0, usd: 0 });
		expect(state.allocated.tokens).toBeLessThanOrEqual(state.budgetTotal.tokens);
		expect(state.consumed.tokens).toBe(9_000);
	});
});

// ─── TC-F34-3: kill-switch — abort() останавливает всё дерево < 10 сек ─────

describe("TC-F34-3: abort() при 3 активных узлах", () => {
	it("killNode ×3, 3 abort-записи, порты освобождены, run settles < 10 сек", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const killNode = vi.fn(async () => {});
		// sendPackage висит на управляемых промисах — узлы «активны».
		const pending = [];
		const sendPackage = vi.fn(({ workPackage }) => {
			const d = deferred();
			pending.push({ ...d, workPackage });
			return d.promise;
		});
		const handle = makeHandle(mission, { spawnNode, sendPackage, killNode });

		const runPromise = handle.run({ task: "Эпик", children: 3, deadline: DEADLINE });
		const settled = runPromise.then(() => "resolved", () => "rejected");

		// Все 3 узла порождены и пакеты отправлены (fan-out без ожидания отчётов).
		await vi.waitFor(
			() => {
				expect(spawnNode).toHaveBeenCalledTimes(3);
				expect(sendPackage).toHaveBeenCalledTimes(3);
			},
			{ timeout: 5_000, interval: 10 },
		);

		const t0 = Date.now();
		await handle.abort();
		// Отпускаем зависшие пакеты — run() обязан завершиться (прерван).
		for (const p of pending) {
			const nodeId = p.workPackage.correlationId.split("/").slice(1).join("/");
			p.resolve(makeReport(nodeId, p.workPackage.correlationId));
		}
		const outcome = await Promise.race([settled, sleep(10_000).then(() => "timeout")]);
		const elapsedMs = Date.now() - t0;

		expect(outcome).not.toBe("timeout");
		expect(elapsedMs).toBeLessThan(10_000);

		// Все узлы остановлены kill-switch'ом.
		expect(killNode).toHaveBeenCalledTimes(3);
		expect(killNode.mock.calls.map(([id]) => id).sort()).toEqual(["L1/node-1", "L1/node-2", "L1/node-3"]);

		// Журнал: abort-запись для каждого узла; complete после abort не пишется
		// (флаг прерывания проверяется между шагами цикла).
		const entries = readJournal(mission);
		const aborts = entries.filter((e) => e.event === "abort");
		expect(aborts.map((e) => e.nodeId).sort()).toEqual(["L1/node-1", "L1/node-2", "L1/node-3"]);
		expect(entries.filter((e) => e.event === "complete")).toHaveLength(0);

		// Порты освобождены (roadmap TC-F34-3).
		const ports = readPorts(mission);
		expect(Object.keys(ports).filter((id) => id.startsWith("L1/"))).toEqual([]);
	}, 15_000);
});

// ─── Доп: depth/width guard (F-25) перед spawn ─────────────────────────────

describe("guard: width/depth проверяются ДО allocate/spawn", () => {
	it("children=5 при workingWidth=4 → ошибка max_width_exceeded на 5-м (первые 4 созданы)", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		// Пакеты висят: нет complete → allocated не возвращается (наблюдаемо).
		const hanging = [];
		const sendPackage = vi.fn(() => {
			const d = deferred();
			hanging.push(d);
			return d.promise;
		});
		const handle = makeHandle(mission, {
			spawnNode,
			sendPackage,
			guardOptions: { workingWidth: 4, maxWidth: 12, maxDepth: 12 },
		});

		await expect(handle.run({ task: "Эпик", children: 5, deadline: DEADLINE })).rejects.toThrow(
			/max_width_exceeded/,
		);

		expect(spawnNode).toHaveBeenCalledTimes(4);
		expect(sendPackage).toHaveBeenCalledTimes(4);

		// 5-й узел: guard отказал ДО spawn → spawn-записей ровно 4.
		const spawns = readJournal(mission).filter((e) => e.event === "spawn");
		expect(spawns).toHaveLength(4);

		// Аллокации первых 4 удерживаются: 4 × floor(0.8·100000/5) = 4 × 16000.
		expect(readBudgetState(mission).allocated.tokens).toBe(64_000);

		for (const d of hanging) d.resolve(makeReport("x", "mission-f34/L1/node-1"));
	});

	it("depth=1 разрешён при maxDepth=2 (guard не срабатывает на глубине 1)", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const handle = makeHandle(mission, { spawnNode, guardOptions: { maxDepth: 2 } });

		const result = await handle.run({ task: "Эпик", children: 2, deadline: DEADLINE });

		expect(spawnNode).toHaveBeenCalledTimes(2);
		expect(result.reports).toHaveLength(2);
	});

	it("maxDepth=1 → отказ max_depth_exceeded на первом же узле (guard вызывается на depth=1)", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const sendPackage = makeSendMock();
		const handle = makeHandle(mission, { spawnNode, sendPackage, guardOptions: { maxDepth: 1 } });

		await expect(handle.run({ task: "Эпик", children: 2, deadline: DEADLINE })).rejects.toThrow(
			/max_depth_exceeded/,
		);

		expect(spawnNode).not.toHaveBeenCalled();
		expect(sendPackage).not.toHaveBeenCalled();
		expect(readJournal(mission).filter((e) => e.event === "spawn")).toHaveLength(0);
	});
});

// ─── Доп: бюджет не хватает → allocate false → ошибка ──────────────────────

describe("budget: allocate false (USD-лимит) → run бросает, созданный узел сохранён", () => {
	it("budgetTotal.usd=0.00015, children=2 → 2×0.0001 > 0.00015 → ошибка бюджета, 1 узел создан", async () => {
		const mission = makeMission();
		mission.budgetTotal = { tokens: 100_000, usd: 0.00015 };
		const spawnNode = makeSpawnMock();
		// Пакет 1-го узла висит: complete нет, его аллокация удерживается.
		const hanging = [];
		const sendPackage = vi.fn(() => {
			const d = deferred();
			hanging.push(d);
			return d.promise;
		});
		const handle = makeHandle(mission, { spawnNode, sendPackage });

		await expect(handle.run({ task: "Эпик", children: 2, deadline: DEADLINE })).rejects.toThrow(
			/бюджет|budget/i,
		);

		// Доля ребёнка: tokens min(0.8·100000/2, 30000)=30000,
		// usd round4(0.8·0.00015/2)=round4(0.00006)=0.0001; 2-я аллокация
		// 0.0001+0.0001=0.0002 > 0.00015 → allocate false → ошибка.
		expect(spawnNode).toHaveBeenCalledTimes(1);
		expect(sendPackage).toHaveBeenCalledTimes(1);

		const entries = readJournal(mission);
		expect(entries.filter((e) => e.event === "spawn")).toHaveLength(1);
		expect(entries.filter((e) => e.event === "complete")).toHaveLength(0);

		// Аллокация созданного узла удерживается (он ещё активен).
		expect(readBudgetState(mission).allocated.tokens).toBe(30_000);

		for (const d of hanging) d.resolve(makeReport("L1/node-1", "mission-f34/L1/node-1"));
	});
});

// ─── Доп: ошибка spawnNode ──────────────────────────────────────────────────

describe("spawnNode: ошибка spawn → run бросает, allocated не возвращается", () => {
	it("2-й spawn падает → журнал: spawn 1-го без complete; обе аллокации потрачены на попытку", async () => {
		const mission = makeMission();
		let call = 0;
		const spawnNode = vi.fn(async ({ port }) => {
			call++;
			if (call === 2) {
				throw new Error("spawn boom");
			}
			return { pid: 10_000 + port };
		});
		// Пакет 1-го узла висит → complete не пишется (детерминированно).
		const hanging = [];
		const sendPackage = vi.fn(() => {
			const d = deferred();
			hanging.push(d);
			return d.promise;
		});
		const handle = makeHandle(mission, { spawnNode, sendPackage });

		await expect(handle.run({ task: "Эпик", children: 2, deadline: DEADLINE })).rejects.toThrow(/spawn boom/);

		expect(spawnNode).toHaveBeenCalledTimes(2);
		expect(sendPackage).toHaveBeenCalledTimes(1);

		const entries = readJournal(mission);
		const spawns = entries.filter((e) => e.event === "spawn");
		expect(spawns).toHaveLength(1);
		expect(spawns[0].nodeId).toBe("L1/node-1");
		expect(entries.filter((e) => e.event === "complete")).toHaveLength(0);

		// Обе аллокации (2 × 30000) НЕ возвращены — потрачены на попытку.
		expect(readBudgetState(mission).allocated.tokens).toBe(60_000);

		for (const d of hanging) d.resolve(makeReport("L1/node-1", "mission-f34/L1/node-1"));
	});
});

// ─── Доп: verdict FAIL не роняет контур ─────────────────────────────────────

describe("отчёт с verdict FAIL: отчёт сохранён, usage учтён, run завершается", () => {
	it("run резолвится; report.verdict FAIL; consumed включает usage; complete в журнале", async () => {
		const mission = makeMission();
		const sendPackage = makeSendMock((_port, workPackage) => {
			const nodeId = workPackage.correlationId.split("/").slice(1).join("/");
			return makeReport(nodeId, workPackage.correlationId, {
				verdict: "FAIL",
				usage: { inputTokens: 800, outputTokens: 200, costUsd: 0.05 },
			});
		});
		const handle = makeHandle(mission, { sendPackage });

		const result = await handle.run({ task: "Эпик", children: 1, deadline: DEADLINE });

		expect(result.reports).toHaveLength(1);
		expect(result.reports[0].nodeId).toBe("L1/node-1");
		expect(result.reports[0].report.verdict).toBe("FAIL");

		expect(result.budget.consumed.tokens).toBe(1_000);
		expect(result.budget.consumed.usd).toBeCloseTo(0.05, 10);
		expect(result.budget.byBranch["L1/node-1"]).toEqual({ tokens: 1_000, usd: 0.05 });

		const completes = readJournal(mission).filter((e) => e.event === "complete");
		expect(completes).toHaveLength(1);
		expect(completes[0].usage).toEqual({ tokens: 1_000, usd: 0.05 });
	});
});

// ─── Доп: abort идемпотентен ────────────────────────────────────────────────

describe("abort: идемпотентность", () => {
	it("abort до run — не бросает, killNode не вызывается", async () => {
		const mission = makeMission();
		const killNode = vi.fn(async () => {});
		const handle = makeHandle(mission, { killNode });

		await expect(handle.abort()).resolves.toBeUndefined();
		await expect(handle.abort()).resolves.toBeUndefined();
		expect(killNode).not.toHaveBeenCalled();
	});

	it("abort после успешного run — не бросает, killNode не вызывается (нет активных узлов)", async () => {
		const mission = makeMission();
		const killNode = vi.fn(async () => {});
		const handle = makeHandle(mission, { killNode });

		await handle.run({ task: "Эпик", children: 1, deadline: DEADLINE });

		await expect(handle.abort()).resolves.toBeUndefined();
		expect(killNode).not.toHaveBeenCalled();
	});
});

// ─── Доп: startup-reconciliation (F-33) при старте run ─────────────────────

describe("reconcile: orphan-записи portsFile чистятся до spawn", () => {
	it("мертвая запись (без PID-файла) удаляется из portsFile, run идёт на порту 7001", async () => {
		const mission = makeMission();
		// Orphan прошлой сессии: запись в portsFile, PID-файла нет → cleaned_dead
		// (probe процесса не требуется — кроссплатформенно).
		writeFileSync(mission.portsFile, JSON.stringify({ "L1/node-old": 7099 }, null, 2), "utf8");

		const spawnNode = makeSpawnMock();
		const handle = makeHandle(mission, { spawnNode });

		const result = await handle.run({ task: "Эпик", children: 1, deadline: DEADLINE });

		expect(result.reports).toHaveLength(1);
		// Orphan-запись зачищена; пул стартовал с 7001.
		expect(readPorts(mission)["L1/node-old"]).toBeUndefined();
		expect(spawnNode).toHaveBeenCalledTimes(1);
		expect(spawnNode.mock.calls[0][0].port).toBe(7001);
	});
});

// ─── Доп: дефолтные portsFile/pidDir (без DI) ──────────────────────────────

describe("Depth2Options: portsFile/pidDir опциональны", () => {
	it("run работает без явных portsFile/pidDir (дефолты в missionDir)", async () => {
		const mission = makeMission();
		const spawnNode = makeSpawnMock();
		const sendPackage = makeSendMock();
		const handle = createDepth2Integration({
			missionDir: mission.missionDir,
			missionId: mission.missionId,
			budgetTotal: mission.budgetTotal,
			spawnNode,
			sendPackage,
		});

		const result = await handle.run({ task: "Эпик", children: 1, deadline: DEADLINE });

		expect(result.reports).toHaveLength(1);
		expect(spawnNode).toHaveBeenCalledTimes(1);
		expect(sendPackage).toHaveBeenCalledTimes(1);
	});
});

// ─── F1: deferred spawnNode + abort — узел убит после разрешения spawn ─────

describe("F1: abort() во время pending spawnNode — узел убит после разрешения spawn", () => {
	it("spawnNode deferred, abort ДО разрешения spawn → killNode вызван, abort-запись в журнале, порт освобождён", async () => {
		const mission = makeMission();
		const spawnDeferred = deferred();
		const killNode = vi.fn(async () => {});
		const spawnNode = vi.fn(() => spawnDeferred.promise);
		const sendPackage = vi.fn(async () => makeReport("L1/node-1", "mission-f34/L1/node-1"));

		const handle = makeHandle(mission, { spawnNode, sendPackage, killNode });

		// run стартует, но spawnNode висит (deferred).
		const runPromise = handle.run({ task: "Эпик", children: 1, deadline: DEADLINE });

		// Даём launchChild дойти до await spawnNode.
		await sleep(50);
		expect(spawnNode).toHaveBeenCalledTimes(1);

		// abort() вызывается ДО разрешения spawn.
		const abortPromise = handle.abort();

		// Разрешаем spawnNode ПОСЛЕ вызова abort().
		spawnDeferred.resolve({ pid: 99999 });

		await abortPromise;
		await runPromise;

		// killNode вызван для отложенного узла.
		expect(killNode).toHaveBeenCalledTimes(1);
		expect(killNode).toHaveBeenCalledWith("L1/node-1");

		// Журнал содержит abort-запись (не spawn, т.к. узел убит до регистрации).
		const entries = readJournal(mission);
		const aborts = entries.filter((e) => e.event === "abort");
		expect(aborts).toHaveLength(1);
		expect(aborts[0].nodeId).toBe("L1/node-1");

		// spawn-записи нет (узел убит до journal.write spawn).
		expect(entries.filter((e) => e.event === "spawn")).toHaveLength(0);
		// complete-записи нет.
		expect(entries.filter((e) => e.event === "complete")).toHaveLength(0);

		// Порт освобождён.
		const ports = readPorts(mission);
		expect(Object.keys(ports).filter((id) => id.startsWith("L1/"))).toEqual([]);
	}, 10_000);
});

// ─── F2: sendPackage reject — fail-запись, очистка, возврат аллокации ──────

describe("F2: sendPackage reject — журнал fail, порт освобождён, аллокация возвращена", () => {
	it("sendPackage rejects → run бросает, fail-запись, порт освобождён, killNode вызван, allocated возвращён", async () => {
		const mission = makeMission();
		mission.budgetTotal = { tokens: 100_000, usd: 10 };
		const killNode = vi.fn(async () => {});
		const sendPackage = vi.fn(async () => {
			throw new Error("network timeout");
		});
		const handle = makeHandle(mission, { sendPackage, killNode });

		await expect(
			handle.run({ task: "Эпик", children: 1, deadline: DEADLINE }),
		).rejects.toThrow(/network timeout/);

		// spawnNode и sendPackage вызваны ровно 1 раз.
		expect(sendPackage).toHaveBeenCalledTimes(1);

		// Журнал: spawn + fail, без complete.
		const entries = readJournal(mission);
		expect(entries.filter((e) => e.event === "spawn")).toHaveLength(1);
		expect(entries.filter((e) => e.event === "fail")).toHaveLength(1);
		expect(entries.filter((e) => e.event === "fail")[0].nodeId).toBe("L1/node-1");
		expect(entries.filter((e) => e.event === "complete")).toHaveLength(0);

		// Порт освобождён.
		const ports = readPorts(mission);
		expect(Object.keys(ports).filter((id) => id.startsWith("L1/"))).toEqual([]);

		// killNode вызван для узла.
		expect(killNode).toHaveBeenCalledWith("L1/node-1");

		// Аллокация возвращена (узел ничего не потребил).
		const budgetState = readBudgetState(mission);
		expect(budgetState.allocated.tokens).toBe(0);
		expect(budgetState.allocated.usd).toBe(0);
	});
});
