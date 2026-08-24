// F-31: Global Budget Coordinator — RED-фаза TDD.
//
// Модуль ../budget-coordinator.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-31
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.4
//
// Контракт модуля:
//   interface MissionBudgetFile { missions: Record<string, BudgetState>; }
//
//   createMissionBudgetStore(filePath: string, missionId: string, defaults?: BudgetState): BudgetStore
//     // Реализует BudgetStore из F-30 (budget-aggregator.js): { load, save }.
//     // load(): файл отсутствует/повреждён → defaults (НЕ бросает);
//     //       миссии нет в файле → defaults; иначе — её состояние.
//     //       defaults undefined → пустое состояние emptyBudgetState(0, 0).
//     // save(state): файл = { missions: { ...существующие, [missionId]: state } };
//     //       атомарно: запись <filePath>.tmp → rename; .tmp не остаётся;
//     //       родительский каталог создаётся, если отсутствует;
//     //       другие миссии в файле НЕ теряются.
//
//   computeChildAllocation(state: BudgetState, plannedChildren: number, perHopCeilingTokens?: number): BudgetAmount
//     // remaining.tokens = max(0, budgetTotal.tokens - consumed.tokens - allocated.tokens)
//     // tokens = floor(min(0.8 * remaining.tokens / plannedChildren, perHopCeilingTokens ?? 30000))
//     // usd = 0.8 * remaining.usd / plannedChildren (округление до 4 знаков; ceiling НЕ применяется)
//     // plannedChildren <= 0 → { tokens: 0, usd: 0 }
//     // budgetTotal.tokens <= 0 (unlimited) → tokens = perHopCeilingTokens (дефолт 30000) на ребёнка
//
//   readMissionBudgetFile(filePath: string): MissionBudgetFile | null
//     // null — файл отсутствует или повреждён (не бросает)
//
// Продакшн-путь файла: ~/.fan/agent/mission-budget.json (инжектится параметром).
//
// Покрытие (TC-карточки roadmap):
//   TC-F31-1  формула выделения min(0.8 × remaining / children, ceiling): 26666 при 100000/3
//   TC-F31-2  атомарная запись mission-budget.json: данные на диске, .tmp не остаётся,
//             corrupt JSON → load → defaults (не бросает)
//   TC-F31-3  byBranch обеих веток в файле; две миссии в одном файле независимы
//   Доп.      load без файла → defaults; defaults undefined → emptyBudgetState(0,0);
//             plannedChildren=0 → нули; consumed/allocated вычитаются из remaining;
//             ceiling срабатывает; ceiling НЕ применяется к usd; unlimited токены → ceiling;
//             родительский каталог создаётся; интеграция с createBudgetAggregator (F-30)

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// F-30 уже реализован (GREEN) — статический импорт для интеграционных тестов.
import { createBudgetAggregator, emptyBudgetState } from "../budget-aggregator.js";

let createMissionBudgetStore;
let computeChildAllocation;
let readMissionBudgetFile;

beforeAll(async () => {
	const mod = await import("../budget-coordinator.js");
	createMissionBudgetStore = mod.createMissionBudgetStore;
	computeChildAllocation = mod.computeChildAllocation;
	readMissionBudgetFile = mod.readMissionBudgetFile;
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
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-bc-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Путь к mission-budget.json в свежем tempdir. */
function makeBudgetPath(fileName = "mission-budget.json") {
	return join(makeTmpDir(), fileName);
}

/** Состояние бюджета: total 100000 токенов / 10 usd, остальное по нулям. */
function makeState(overrides = {}) {
	const state = emptyBudgetState(100_000, 10);
	return { ...state, ...overrides };
}

// ─── TC-F31-1: формула выделения min(0.8 × remaining / children, ceiling) ───

describe("TC-F31-1: budget_total 100000, consumed 0, allocated 0, children 3, ceiling 30000", () => {
	it("tokens = min(0.8 × 100000/3, 30000) = 26666 (floor)", () => {
		const alloc = computeChildAllocation(makeState(), 3, 30_000);
		expect(alloc.tokens).toBe(26_666);
	});

	it("usd = 0.8 × 10/3 = 2.6667 (округление до 4 знаков)", () => {
		const alloc = computeChildAllocation(makeState(), 3, 30_000);
		expect(alloc.usd).toBe(2.6667);
	});

	it("ceiling по умолчанию 30000 (аргумент не передан)", () => {
		const alloc = computeChildAllocation(makeState(), 3);
		expect(alloc.tokens).toBe(26_666);
	});
});

describe("TC-F31-1 (доп): вариации формулы выделения", () => {
	it("частично потреблённый бюджет: consumed 40000 → remaining 60000 → 0.8×60000/3 = 16000", () => {
		const state = makeState({ consumed: { tokens: 40_000, usd: 4 } });
		const alloc = computeChildAllocation(state, 3, 30_000);
		expect(alloc.tokens).toBe(16_000);
		expect(alloc.usd).toBe(1.6); // 0.8 × (10-4)/3 = 1.6
	});

	it("allocated вычитается из remaining: allocated 20000 → remaining 80000 → 0.8×80000/4 = 16000", () => {
		const state = makeState({ allocated: { tokens: 20_000, usd: 2 } });
		const alloc = computeChildAllocation(state, 4, 30_000);
		expect(alloc.tokens).toBe(16_000);
		expect(alloc.usd).toBe(1.6); // 0.8 × (10-2)/4 = 1.6
	});

	it("consumed + allocated вместе уменьшают remaining", () => {
		const state = makeState({
			consumed: { tokens: 30_000, usd: 3 },
			allocated: { tokens: 20_000, usd: 2 },
		});
		// remaining.tokens = 50000 → 0.8 × 50000/2 = 20000
		// remaining.usd = 5 → 0.8 × 5/2 = 2
		const alloc = computeChildAllocation(state, 2, 30_000);
		expect(alloc.tokens).toBe(20_000);
		expect(alloc.usd).toBe(2);
	});

	it("remaining огромный → срабатывает ceiling 30000", () => {
		const state = emptyBudgetState(10_000_000, 1_000);
		const alloc = computeChildAllocation(state, 2, 30_000);
		expect(alloc.tokens).toBe(30_000);
	});

	it("кастомный ceiling: 0.8×100000/1 = 80000 → min(80000, 50000) = 50000", () => {
		const alloc = computeChildAllocation(makeState(), 1, 50_000);
		expect(alloc.tokens).toBe(50_000);
	});

	it("ceiling НЕ применяется к usd: огромный usd пропорционально делится", () => {
		const state = emptyBudgetState(10_000_000, 1_000_000);
		const alloc = computeChildAllocation(state, 2, 30_000);
		expect(alloc.tokens).toBe(30_000); // потолок сработал
		expect(alloc.usd).toBe(400_000); // 0.8 × 1000000/2 — без потолка
	});

	it("plannedChildren = 0 → { tokens: 0, usd: 0 }", () => {
		expect(computeChildAllocation(makeState(), 0, 30_000)).toEqual({ tokens: 0, usd: 0 });
	});

	it("plannedChildren < 0 → { tokens: 0, usd: 0 }", () => {
		expect(computeChildAllocation(makeState(), -2, 30_000)).toEqual({ tokens: 0, usd: 0 });
	});

	it("consumed + allocated > budgetTotal → remaining зажат в 0 → нули", () => {
		const state = makeState({
			consumed: { tokens: 90_000, usd: 9 },
			allocated: { tokens: 20_000, usd: 2 },
		});
		const alloc = computeChildAllocation(state, 3, 30_000);
		expect(alloc.tokens).toBe(0);
		expect(alloc.usd).toBe(0);
	});

	it("unlimited токены (budgetTotal.tokens = 0) → ребёнку perHopCeilingTokens", () => {
		const state = emptyBudgetState(0, 5);
		const alloc = computeChildAllocation(state, 3, 30_000);
		expect(alloc.tokens).toBe(30_000);
	});

	it("unlimited токены с дефолтным ceiling → 30000", () => {
		const state = emptyBudgetState(0, 5);
		const alloc = computeChildAllocation(state, 3);
		expect(alloc.tokens).toBe(30_000);
	});

	it("unlimited токены: кастомный ceiling применяется как есть", () => {
		const state = emptyBudgetState(0, 5);
		const alloc = computeChildAllocation(state, 3, 12_345);
		expect(alloc.tokens).toBe(12_345);
	});

	it("unlimited токены: usd по-прежнему делится пропорционально", () => {
		const state = emptyBudgetState(0, 5);
		const alloc = computeChildAllocation(state, 3, 30_000);
		expect(alloc.usd).toBe(1.3333); // 0.8 × 5/3 = 1.3333… → округление до 4 знаков
	});

	it("округление tokens вниз (floor), не до ближайшего", () => {
		// 0.8 × 100000/3 = 26666.666… → 26666, а не 26667
		const alloc = computeChildAllocation(makeState(), 3, 30_000);
		expect(alloc.tokens).toBe(26_666);
		expect(Number.isInteger(alloc.tokens)).toBe(true);
	});
});

// ─── TC-F31-2: атомарная запись mission-budget.json ─────────────────────────

describe("TC-F31-2: store.save → файл на диске содержит актуальные данные", () => {
	it("save → JSON в файле: missions[missionId] = сохранённое состояние", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));

		const state = makeState({
			consumed: { tokens: 5_000, usd: 0.5 },
			byBranch: { "L1/node-1": { tokens: 5_000, usd: 0.5 } },
		});
		store.save(state);

		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.missions["mission-1"]).toEqual(state);
	});

	it("атомарность: после save НЕ остаётся .tmp файла", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));
		store.save(makeState());

		expect(existsSync(`${filePath}.tmp`)).toBe(false);
		const dirFiles = readdirSync(join(filePath, ".."));
		expect(dirFiles.filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("файл читабелен как валидный JSON после нескольких save", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));

		store.save(makeState({ consumed: { tokens: 1_000, usd: 0.1 } }));
		store.save(makeState({ consumed: { tokens: 2_000, usd: 0.2 } }));

		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.missions["mission-1"].consumed).toEqual({ tokens: 2_000, usd: 0.2 });
	});

	it("load → то же состояние, что было передано в save (roundtrip)", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));

		const state = makeState({
			allocated: { tokens: 26_666, usd: 2.6667 },
			consumed: { tokens: 12_000, usd: 1.2 },
			peak: { tokens: 12_000, usd: 1.2 },
			byBranch: { "L1/node-1": { tokens: 12_000, usd: 1.2 } },
		});
		store.save(state);

		// Новый store над тем же файлом — читает с диска.
		const store2 = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(0, 0));
		expect(store2.load()).toEqual(state);
	});

	it("corrupt JSON в файле → load возвращает defaults (НЕ бросает)", () => {
		const filePath = makeBudgetPath();
		writeFileSync(filePath, "{ not valid json !!!", "utf8");

		const defaults = emptyBudgetState(100_000, 10);
		const store = createMissionBudgetStore(filePath, "mission-1", defaults);

		expect(() => store.load()).not.toThrow();
		expect(store.load()).toEqual(defaults);
	});

	it("corrupt JSON: последующий save восстанавливает файл валидным JSON", () => {
		const filePath = makeBudgetPath();
		writeFileSync(filePath, "garbage", "utf8");

		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));
		store.save(makeState({ consumed: { tokens: 7_000, usd: 0.7 } }));

		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.missions["mission-1"].consumed).toEqual({ tokens: 7_000, usd: 0.7 });
	});
});

describe("TC-F31-2 (доп): readMissionBudgetFile", () => {
	it("файл отсутствует → null (не бросает)", () => {
		const filePath = makeBudgetPath();
		expect(() => readMissionBudgetFile(filePath)).not.toThrow();
		expect(readMissionBudgetFile(filePath)).toBeNull();
	});

	it("corrupt JSON → null (не бросает)", () => {
		const filePath = makeBudgetPath();
		writeFileSync(filePath, "[[[ broken", "utf8");
		expect(readMissionBudgetFile(filePath)).toBeNull();
	});

	it("валидный файл → { missions: {...} }", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));
		store.save(makeState());

		const file = readMissionBudgetFile(filePath);
		expect(file).not.toBeNull();
		expect(file.missions["mission-1"].budgetTotal).toEqual({ tokens: 100_000, usd: 10 });
	});
});

// ─── TC-F31-3: by_branch атрибуция + мультимиссионность ─────────────────────

describe("TC-F31-3: byBranch — обе ветки сохраняются в файле", () => {
	it("save со state.byBranch {node-1, node-2} → в файле обе ветки", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));

		const state = makeState({
			consumed: { tokens: 22_000, usd: 0.75 },
			byBranch: {
				"L1/node-1": { tokens: 12_000, usd: 0.45 },
				"L1/node-2": { tokens: 10_000, usd: 0.3 },
			},
		});
		store.save(state);

		const file = readMissionBudgetFile(filePath);
		const byBranch = file.missions["mission-1"].byBranch;
		expect(byBranch["L1/node-1"]).toEqual({ tokens: 12_000, usd: 0.45 });
		expect(byBranch["L1/node-2"]).toEqual({ tokens: 10_000, usd: 0.3 });
	});
});

describe("TC-F31-3: две миссии в одном файле — независимы", () => {
	it("save миссии A не трёт миссию B", () => {
		const filePath = makeBudgetPath();
		const storeA = createMissionBudgetStore(filePath, "mission-A", emptyBudgetState(100_000, 10));
		const storeB = createMissionBudgetStore(filePath, "mission-B", emptyBudgetState(50_000, 5));

		const stateA = makeState({ consumed: { tokens: 1_000, usd: 0.1 } });
		const stateB = makeState({
			budgetTotal: { tokens: 50_000, usd: 5 },
			consumed: { tokens: 2_000, usd: 0.2 },
		});

		storeA.save(stateA);
		storeB.save(stateB);

		const file = readMissionBudgetFile(filePath);
		expect(file.missions["mission-A"]).toEqual(stateA);
		expect(file.missions["mission-B"]).toEqual(stateB);
	});

	it("повторный save миссии A после save B → B неизменна, A обновлена", () => {
		const filePath = makeBudgetPath();
		const storeA = createMissionBudgetStore(filePath, "mission-A", emptyBudgetState(100_000, 10));
		const storeB = createMissionBudgetStore(filePath, "mission-B", emptyBudgetState(50_000, 5));

		const stateB = makeState({
			budgetTotal: { tokens: 50_000, usd: 5 },
			consumed: { tokens: 2_000, usd: 0.2 },
		});
		storeB.save(stateB);
		storeA.save(makeState({ consumed: { tokens: 1_000, usd: 0.1 } }));
		storeA.save(makeState({ consumed: { tokens: 9_999, usd: 0.9 } }));

		const file = readMissionBudgetFile(filePath);
		expect(file.missions["mission-B"]).toEqual(stateB);
		expect(file.missions["mission-A"].consumed).toEqual({ tokens: 9_999, usd: 0.9 });
	});

	it("load миссии A не видит состояние миссии B", () => {
		const filePath = makeBudgetPath();
		const storeB = createMissionBudgetStore(filePath, "mission-B", emptyBudgetState(50_000, 5));
		storeB.save(makeState({ consumed: { tokens: 2_000, usd: 0.2 } }));

		const defaults = emptyBudgetState(100_000, 10);
		const storeA = createMissionBudgetStore(filePath, "mission-A", defaults);
		expect(storeA.load()).toEqual(defaults);
	});
});

// ─── Доп: load при отсутствии файла / без defaults ──────────────────────────

describe("load: отсутствующий файл и defaults", () => {
	it("файл отсутствует → load возвращает defaults (не бросает)", () => {
		const filePath = makeBudgetPath();
		const defaults = emptyBudgetState(100_000, 10);
		const store = createMissionBudgetStore(filePath, "mission-1", defaults);

		expect(() => store.load()).not.toThrow();
		expect(store.load()).toEqual(defaults);
	});

	it("defaults undefined → пустое состояние с нулями (emptyBudgetState(0, 0))", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1");

		expect(store.load()).toEqual({
			budgetTotal: { tokens: 0, usd: 0 },
			allocated: { tokens: 0, usd: 0 },
			consumed: { tokens: 0, usd: 0 },
			peak: { tokens: 0, usd: 0 },
			byBranch: {},
		});
	});

	it("миссии нет в существующем файле → defaults", () => {
		const filePath = makeBudgetPath();
		writeFileSync(filePath, JSON.stringify({ missions: { "mission-other": makeState() } }), "utf8");

		const defaults = emptyBudgetState(77_000, 7.7);
		const store = createMissionBudgetStore(filePath, "mission-1", defaults);
		expect(store.load()).toEqual(defaults);
	});
});

// ─── Доп: родительский каталог создаётся ────────────────────────────────────

describe("save: родительский каталог создаётся, если отсутствует", () => {
	it("вложенный путь tmp/nested/deep/mission-budget.json → файл записан", () => {
		const filePath = join(makeTmpDir(), "nested", "deep", "mission-budget.json");
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));

		expect(() => store.save(makeState())).not.toThrow();
		expect(existsSync(filePath)).toBe(true);

		const file = readMissionBudgetFile(filePath);
		expect(file.missions["mission-1"].budgetTotal).toEqual({ tokens: 100_000, usd: 10 });
	});
});

// ─── Schema-corrupt entry: валидация записей миссий ────────────────────────

describe("Schema-corrupt entry: load валидирует запись и возвращает defaults при невалидной", () => {
	it("запись миссии = {} → load возвращает defaults", () => {
		const filePath = makeBudgetPath();
		writeFileSync(filePath, JSON.stringify({ missions: { "mission-1": {} } }), "utf8");

		const defaults = emptyBudgetState(100_000, 10);
		const store = createMissionBudgetStore(filePath, "mission-1", defaults);
		expect(store.load()).toEqual(defaults);
	});

	it("запись без byBranch → load возвращает defaults", () => {
		const filePath = makeBudgetPath();
		const entry = {
			budgetTotal: { tokens: 100_000, usd: 10 },
			allocated: { tokens: 0, usd: 0 },
			consumed: { tokens: 0, usd: 0 },
			peak: { tokens: 0, usd: 0 },
			// byBranch отсутствует
		};
		writeFileSync(filePath, JSON.stringify({ missions: { "mission-1": entry } }), "utf8");

		const defaults = emptyBudgetState(50_000, 5);
		const store = createMissionBudgetStore(filePath, "mission-1", defaults);
		expect(store.load()).toEqual(defaults);
	});

	it("запись с нечисловыми полями → load возвращает defaults", () => {
		const filePath = makeBudgetPath();
		const entry = {
			budgetTotal: { tokens: "not-a-number", usd: 10 },
			allocated: { tokens: 0, usd: 0 },
			consumed: { tokens: 0, usd: 0 },
			peak: { tokens: 0, usd: 0 },
			byBranch: {},
		};
		writeFileSync(filePath, JSON.stringify({ missions: { "mission-1": entry } }), "utf8");

		const defaults = emptyBudgetState(50_000, 5);
		const store = createMissionBudgetStore(filePath, "mission-1", defaults);
		expect(store.load()).toEqual(defaults);
	});

	it("валидная запись → load возвращает состояние (регресс)", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(100_000, 10));
		const state = makeState({ consumed: { tokens: 5_000, usd: 0.5 } });
		store.save(state);

		const store2 = createMissionBudgetStore(filePath, "mission-1", emptyBudgetState(0, 0));
		expect(store2.load()).toEqual(state);
	});
});

// ─── Интеграция с агрегатором F-30 ──────────────────────────────────────────

describe("Интеграция: createBudgetAggregator(createMissionBudgetStore(...))", () => {
	it("allocate/recordUsage агрегатора → данные persist-ятся в файл", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-int", emptyBudgetState(100_000, 10));
		const agg = createBudgetAggregator(store);

		expect(agg.allocate("L1/node-1", { tokens: 26_666, usd: 2 })).toBe(true);
		agg.recordUsage("L1/node-1", { inputTokens: 15_000, costUsd: 0.45 });

		const file = readMissionBudgetFile(filePath);
		const persisted = file.missions["mission-int"];
		expect(persisted.allocated).toEqual({ tokens: 26_666, usd: 2 });
		expect(persisted.consumed.tokens).toBe(15_000);
		expect(persisted.consumed.usd).toBeCloseTo(0.45, 10);
		expect(persisted.byBranch["L1/node-1"].tokens).toBe(15_000);
		expect(persisted.byBranch["L1/node-1"].usd).toBeCloseTo(0.45, 10);
	});

	it("состояние переживает пересоздание агрегатора (load с диска)", () => {
		const filePath = makeBudgetPath();
		const store1 = createMissionBudgetStore(filePath, "mission-int", emptyBudgetState(100_000, 10));
		createBudgetAggregator(store1).recordUsage("L1/node-1", { inputTokens: 7_000, costUsd: 0.2 });

		const store2 = createMissionBudgetStore(filePath, "mission-int", emptyBudgetState(0, 0));
		const agg2 = createBudgetAggregator(store2);
		expect(agg2.state().consumed.tokens).toBe(7_000);
		expect(agg2.state().consumed.usd).toBeCloseTo(0.2, 10);
	});

	it("сценарий фазы B: 3 ребёнка по computeChildAllocation → Σallocated ≤ budgetTotal", () => {
		const filePath = makeBudgetPath();
		const store = createMissionBudgetStore(filePath, "mission-int", emptyBudgetState(100_000, 10));
		const agg = createBudgetAggregator(store);

		const alloc = computeChildAllocation(agg.state(), 3, 30_000);
		expect(alloc.tokens).toBe(26_666);

		for (const nodeId of ["L1/node-1", "L1/node-2", "L1/node-3"]) {
			expect(agg.allocate(nodeId, alloc)).toBe(true);
		}

		const persisted = readMissionBudgetFile(filePath).missions["mission-int"];
		expect(persisted.allocated.tokens).toBe(79_998); // 3 × 26666
		expect(persisted.allocated.tokens).toBeLessThanOrEqual(persisted.budgetTotal.tokens);
	});
});
