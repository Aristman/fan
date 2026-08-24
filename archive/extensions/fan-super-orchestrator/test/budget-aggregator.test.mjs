// F-30: Агрегатор бюджета — RED-фаза TDD.
//
// Модуль ../budget-aggregator.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Контракт модуля:
//   interface BudgetAmount { tokens: number; usd: number; }
//   interface BudgetState {
//       budgetTotal: BudgetAmount;             // потолок миссии
//       allocated: BudgetAmount;               // Σ активных аллокаций
//       consumed: BudgetAmount;                // Σ фактического расхода
//       peak: BudgetAmount;                    // максимум consumed
//       byBranch: Record<string, BudgetAmount>;// атрибуция по веткам
//   }
//   interface BudgetStore { load(): BudgetState; save(state: BudgetState): void; }
//   interface BudgetAlertHandlers {
//       onWarn?: (pct: number, consumed: BudgetAmount) => void;   // 80% (I2 steer)
//       onExhausted?: (consumed: BudgetAmount) => void;           // 100% (I1 drain)
//   }
//   interface BudgetAggregator {
//       canAllocate(amount: BudgetAmount): boolean;
//         // allocated + amount ≤ budgetTotal (ОБА лимита, срабатывает первый)
//       allocate(nodeId: string, amount: BudgetAmount): boolean;
//         // false если canAllocate false; иначе allocated += amount
//       recordUsage(nodeId: string, usage: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void;
//         // consumed += (inputTokens+outputTokens, costUsd); byBranch[nodeId] += ;
//         // peak = max(peak, consumed)
//         // алерты: переход через 80% → onWarn (один раз на порог),
//         //         переход через 100% → onExhausted (один раз)
//       onNodeComplete(nodeId: string, allocatedAmount: BudgetAmount): void;
//         // allocated -= allocatedAmount (не ниже 0)
//       state(): BudgetState;                  // снимок (копия)
//   }
//   createBudgetAggregator(store: BudgetStore, alerts?: BudgetAlertHandlers): BudgetAggregator
//   makeInMemoryStore(initial: BudgetState): BudgetStore   // хелпер для тестов
//   emptyBudgetState(totalTokens: number, totalUsd: number): BudgetState
//
// Порог алертов = МАКСИМУМ из двух долей consumed/budgetTotal (tokens, usd) —
// срабатывает первый достигнутый лимит. Алерты однократные на порог.
//
// Покрытие (TC-карточки roadmap):
//   TC-F30-1  recordUsage по отчёту L1 → consumed + byBranch; второй узел — независимая ветка
//   TC-F30-2  3×26666=79998 → canAllocate(26666) false, canAllocate(20000) true
//   TC-F30-3  onNodeComplete возвращает аллокацию в доступный пул
//   Доп.      двойной бюджет (USD-лимит первым), allocate при нехватке не меняет state,
//             алерты 80%/100% однократные, recordUsage из totalUsage(NodeReport),
//             onNodeComplete больше allocated → 0, state() — копия, peak не уменьшается

import { beforeAll, describe, expect, it } from "vitest";

let createBudgetAggregator;
let makeInMemoryStore;
let emptyBudgetState;

beforeAll(async () => {
	const mod = await import("../budget-aggregator.js");
	createBudgetAggregator = mod.createBudgetAggregator;
	makeInMemoryStore = mod.makeInMemoryStore;
	emptyBudgetState = mod.emptyBudgetState;
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

// Фабрика агрегатора с in-memory store и сборщиком алертов.
function makeAggregator(totalTokens, totalUsd) {
	const alerts = { warnCalls: [], exhaustedCalls: [] };
	const store = makeInMemoryStore(emptyBudgetState(totalTokens, totalUsd));
	const agg = createBudgetAggregator(store, {
		onWarn: (pct, consumed) => alerts.warnCalls.push({ pct, consumed }),
		onExhausted: (consumed) => alerts.exhaustedCalls.push(consumed),
	});
	return { agg, store, alerts };
}

// ─── Хелперы модуля: emptyBudgetState / makeInMemoryStore ───────────────────

describe("helpers: emptyBudgetState / makeInMemoryStore", () => {
	it("emptyBudgetState: budgetTotal задан, остальное по нулям", () => {
		const s = emptyBudgetState(100_000, 10);
		expect(s.budgetTotal).toEqual({ tokens: 100_000, usd: 10 });
		expect(s.allocated).toEqual({ tokens: 0, usd: 0 });
		expect(s.consumed).toEqual({ tokens: 0, usd: 0 });
		expect(s.peak).toEqual({ tokens: 0, usd: 0 });
		expect(s.byBranch).toEqual({});
	});

	it("makeInMemoryStore: load() возвращает initial", () => {
		const initial = emptyBudgetState(50_000, 5);
		const store = makeInMemoryStore(initial);
		expect(store.load()).toEqual(initial);
	});

	it("makeInMemoryStore: save() затем load() → сохранённое состояние", () => {
		const store = makeInMemoryStore(emptyBudgetState(50_000, 5));
		const next = emptyBudgetState(50_000, 5);
		next.consumed = { tokens: 1_000, usd: 0.1 };
		store.save(next);
		expect(store.load().consumed).toEqual({ tokens: 1_000, usd: 0.1 });
	});
});

// ─── TC-F30-1: recordUsage по отчёту L1 → consumed + byBranch ───────────────

describe("TC-F30-1: L1 отчитался {inputTokens:15000, costUsd:0.45} → recordUsage", () => {
	it("consumed = {tokens:15000, usd:0.45}", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-3", { inputTokens: 15_000, costUsd: 0.45 });
		expect(agg.state().consumed.tokens).toBe(15_000);
		expect(agg.state().consumed.usd).toBeCloseTo(0.45, 10);
	});

	it("byBranch['L1/node-3'] = {tokens:15000, usd:0.45}", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-3", { inputTokens: 15_000, costUsd: 0.45 });
		expect(agg.state().byBranch["L1/node-3"].tokens).toBe(15_000);
		expect(agg.state().byBranch["L1/node-3"].usd).toBeCloseTo(0.45, 10);
	});

	it("второй узел → независимая ветка, consumed суммируется", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-3", { inputTokens: 15_000, costUsd: 0.45 });
		agg.recordUsage("L1/node-4", { inputTokens: 8_000, outputTokens: 2_000, costUsd: 0.3 });

		const s = agg.state();
		expect(s.byBranch["L1/node-3"].tokens).toBe(15_000);
		expect(s.byBranch["L1/node-3"].usd).toBeCloseTo(0.45, 10);
		expect(s.byBranch["L1/node-4"].tokens).toBe(10_000);
		expect(s.byBranch["L1/node-4"].usd).toBeCloseTo(0.3, 10);
		expect(s.consumed.tokens).toBe(25_000);
		expect(s.consumed.usd).toBeCloseTo(0.75, 10);
	});

	it("inputTokens + outputTokens складываются в tokens", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-3", { inputTokens: 10_000, outputTokens: 5_000, costUsd: 0.2 });
		expect(agg.state().consumed.tokens).toBe(15_000);
	});

	it("повторный recordUsage той же ветки — накапливается", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-3", { inputTokens: 5_000, costUsd: 0.1 });
		agg.recordUsage("L1/node-3", { inputTokens: 3_000, costUsd: 0.1 });
		expect(agg.state().byBranch["L1/node-3"].tokens).toBe(8_000);
		expect(agg.state().byBranch["L1/node-3"].usd).toBeCloseTo(0.2, 10);
	});

	it("поля usage по умолчанию 0 (пустой объект usage)", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		expect(() => agg.recordUsage("L1/node-3", {})).not.toThrow();
		expect(agg.state().consumed).toEqual({ tokens: 0, usd: 0 });
	});
});

// ─── TC-F30-1 (доп): recordUsage из totalUsage рекурсивного NodeReport ──────

describe("TC-F30-1 (доп): usage агрегируется из totalUsage(NodeReport) с детьми", () => {
	it("вход = Σ usage узла и его детей (2 уровня вложенности)", () => {
		// Имитация результата totalUsage(report) из F-28:
		// node {input: 5000, output: 1000, usd: 0.20}
		//  └ child {input: 3000, output: 500, usd: 0.10}
		//     └ grandchild {input: 2000, output: 500, usd: 0.05}
		// totalUsage → {inputTokens: 10000, outputTokens: 2000, costUsd: 0.35}
		const totalUsageResult = { inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.35 };

		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-3", totalUsageResult);

		const s = agg.state();
		expect(s.consumed.tokens).toBe(12_000);
		expect(s.consumed.usd).toBeCloseTo(0.35, 10);
		expect(s.byBranch["L1/node-3"].tokens).toBe(12_000);
		expect(s.byBranch["L1/node-3"].usd).toBeCloseTo(0.35, 10);
	});
});

// ─── TC-F30-2: инвариант Σallocated ≤ budgetTotal ───────────────────────────

describe("TC-F30-2: 3×26666=79998 → canAllocate(26666) false, canAllocate(20000) true", () => {
	const TOTAL_TOKENS = 100_000;
	const TOTAL_USD = 100; // USD-лимит заведомо не срабатывает

	function allocatedAggregator() {
		const { agg, alerts } = makeAggregator(TOTAL_TOKENS, TOTAL_USD);
		agg.allocate("L1/node-1", { tokens: 26_666, usd: 0 });
		agg.allocate("L1/node-2", { tokens: 26_666, usd: 0 });
		agg.allocate("L1/node-3", { tokens: 26_666, usd: 0 });
		return { agg, alerts };
	}

	it("после 3 аллокаций allocated = 79998", () => {
		const { agg } = allocatedAggregator();
		expect(agg.state().allocated.tokens).toBe(79_998);
	});

	it("canAllocate(26666) → false (79998 + 26666 > 100000)", () => {
		const { agg } = allocatedAggregator();
		expect(agg.canAllocate({ tokens: 26_666, usd: 0 })).toBe(false);
	});

	it("canAllocate(20000) → true (79998 + 20000 ≤ 100000)", () => {
		const { agg } = allocatedAggregator();
		expect(agg.canAllocate({ tokens: 20_000, usd: 0 })).toBe(true);
	});

	it("canAllocate ровно до потолка (20002) → true", () => {
		const { agg } = allocatedAggregator();
		expect(agg.canAllocate({ tokens: 20_002, usd: 0 })).toBe(true);
	});

	it("allocate при нехватке → false и state НЕ меняется", () => {
		const { agg } = allocatedAggregator();
		const before = agg.state();
		const ok = agg.allocate("L1/node-4", { tokens: 26_666, usd: 0 });
		expect(ok).toBe(false);
		expect(agg.state().allocated.tokens).toBe(before.allocated.tokens);
		expect(agg.state().allocated.usd).toBe(before.allocated.usd);
	});

	it("allocate при достатке → true, allocated += amount", () => {
		const { agg } = allocatedAggregator();
		const ok = agg.allocate("L1/node-4", { tokens: 20_000, usd: 0 });
		expect(ok).toBe(true);
		expect(agg.state().allocated.tokens).toBe(99_998);
	});
});

// ─── Двойной бюджет: USD-лимит срабатывает первым ───────────────────────────

describe("Двойной бюджет: токены в норме, USD превышен → canAllocate false", () => {
	it("USD-лимит блокирует аллокацию при свободных токенах", () => {
		const { agg } = makeAggregator(1_000_000, 1.0);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 0.9 });

		// По токенам свободно (990000), но 0.9 + 0.2 > 1.0 → false
		expect(agg.canAllocate({ tokens: 5_000, usd: 0.2 })).toBe(false);
	});

	it("аллокация, вписывающаяся в ОБА лимита → true", () => {
		const { agg } = makeAggregator(1_000_000, 1.0);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 0.9 });
		expect(agg.canAllocate({ tokens: 5_000, usd: 0.1 })).toBe(true);
	});

	it("токен-лимит блокирует при свободном USD", () => {
		const { agg } = makeAggregator(50_000, 1_000);
		agg.allocate("L1/node-1", { tokens: 40_000, usd: 0.1 });
		expect(agg.canAllocate({ tokens: 20_000, usd: 0.1 })).toBe(false);
	});
});

// ─── TC-F30-3: onNodeComplete возвращает аллокацию в пул ────────────────────

describe("TC-F30-3: узел завершился → allocated -= 26666, пул растёт", () => {
	function makeFullAggregator() {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.allocate("L1/node-1", { tokens: 26_666, usd: 0 });
		agg.allocate("L1/node-2", { tokens: 26_666, usd: 0 });
		agg.allocate("L1/node-3", { tokens: 26_666, usd: 0 });
		return { agg, alerts };
	}

	it("onNodeComplete(node-1, 26666) → allocated 53332", () => {
		const { agg } = makeFullAggregator();
		agg.onNodeComplete("L1/node-1", { tokens: 26_666, usd: 0 });
		expect(agg.state().allocated.tokens).toBe(53_332);
	});

	it("незанятый остаток возвращается: canAllocate(26666) теперь true", () => {
		const { agg } = makeFullAggregator();
		expect(agg.canAllocate({ tokens: 26_666, usd: 0 })).toBe(false);
		agg.onNodeComplete("L1/node-1", { tokens: 26_666, usd: 0 });
		expect(agg.canAllocate({ tokens: 26_666, usd: 0 })).toBe(true);
	});

	it("onNodeComplete больше allocated → allocated = 0 (не отрицательный)", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 0.5 });
		agg.onNodeComplete("L1/node-1", { tokens: 50_000, usd: 5 });
		expect(agg.state().allocated.tokens).toBe(0);
		expect(agg.state().allocated.usd).toBe(0);
	});
});

// ─── Алерты: 80% → onWarn, 100% → onExhausted (однократные) ─────────────────

describe("Алерты: порог 80% (onWarn) и 100% (onExhausted), однократные", () => {
	it("переход через 80% по токенам → onWarn вызван 1 раз, pct ≥ 80", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 50_000 });
		expect(alerts.warnCalls).toHaveLength(0);

		agg.recordUsage("L1/node-1", { inputTokens: 30_000 }); // consumed = 80000 = 80%
		expect(alerts.warnCalls).toHaveLength(1);
		expect(alerts.warnCalls[0].pct).toBeGreaterThanOrEqual(80);
		expect(alerts.warnCalls[0].consumed.tokens).toBe(80_000);
	});

	it("повторные recordUsage выше 80% НЕ дублируют onWarn", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 85_000 });
		agg.recordUsage("L1/node-1", { inputTokens: 5_000 });
		agg.recordUsage("L1/node-2", { inputTokens: 5_000 });
		expect(alerts.warnCalls).toHaveLength(1);
	});

	it("переход через 100% → onExhausted вызван 1 раз", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 60_000 });
		expect(alerts.exhaustedCalls).toHaveLength(0);

		agg.recordUsage("L1/node-1", { inputTokens: 45_000 }); // consumed = 105000 ≥ 100%
		expect(alerts.exhaustedCalls).toHaveLength(1);
		expect(alerts.exhaustedCalls[0].tokens).toBe(105_000);
	});

	it("повторные recordUsage выше 100% НЕ дублируют onExhausted", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 110_000 });
		agg.recordUsage("L1/node-1", { inputTokens: 10_000 });
		expect(alerts.exhaustedCalls).toHaveLength(1);
	});

	it("за один recordUsage через оба порога → onWarn и onExhausted по 1 разу", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 120_000 });
		expect(alerts.warnCalls).toHaveLength(1);
		expect(alerts.exhaustedCalls).toHaveLength(1);
	});

	it("USD-доля достигает 80% первой → onWarn (максимум из двух долей)", () => {
		const { agg, alerts } = makeAggregator(1_000_000, 1.0);
		// токены: 1000/1000000 = 0.1%, usd: 0.8/1.0 = 80% → срабатывает USD-лимит
		agg.recordUsage("L1/node-1", { inputTokens: 1_000, costUsd: 0.8 });
		expect(alerts.warnCalls).toHaveLength(1);
		expect(alerts.warnCalls[0].pct).toBeGreaterThanOrEqual(80);
	});

	it("USD-доля достигает 100% → onExhausted при низкой токенной доле", () => {
		const { agg, alerts } = makeAggregator(1_000_000, 1.0);
		agg.recordUsage("L1/node-1", { inputTokens: 1_000, costUsd: 1.05 });
		expect(alerts.exhaustedCalls).toHaveLength(1);
	});

	it("расход ниже 80% → алерты не вызываются", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 79_999, costUsd: 1 });
		expect(alerts.warnCalls).toHaveLength(0);
		expect(alerts.exhaustedCalls).toHaveLength(0);
	});

	it("без handlers — recordUsage не бросает", () => {
		const store = makeInMemoryStore(emptyBudgetState(100_000, 100));
		const agg = createBudgetAggregator(store);
		expect(() => agg.recordUsage("L1/node-1", { inputTokens: 120_000 })).not.toThrow();
	});
});

// ─── state(): снимок-копия ──────────────────────────────────────────────────

describe("state(): возвращает копию (мутация снимка не влияет на store)", () => {
	it("мутация полей снимка не меняет внутреннее состояние", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 10_000, costUsd: 0.5 });

		const snap = agg.state();
		snap.consumed.tokens = 999_999;
		snap.byBranch["L1/node-1"].tokens = 999_999;

		expect(agg.state().consumed.tokens).toBe(10_000);
		expect(agg.state().byBranch["L1/node-1"].tokens).toBe(10_000);
	});

	it("последовательные state() → разные объекты", () => {
		const { agg } = makeAggregator(100_000, 100);
		expect(agg.state()).not.toBe(agg.state());
	});
});

// ─── peak: максимум consumed, не уменьшается ────────────────────────────────

describe("peak: растёт с consumed, НЕ уменьшается после onNodeComplete", () => {
	it("consumed растёт → peak растёт", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 10_000, costUsd: 0.3 });
		expect(agg.state().peak.tokens).toBe(10_000);

		agg.recordUsage("L1/node-1", { inputTokens: 5_000, costUsd: 0.2 });
		expect(agg.state().peak.tokens).toBe(15_000);
		expect(agg.state().peak.usd).toBeCloseTo(0.5, 10);
	});

	it("после onNodeComplete peak НЕ уменьшается", () => {
		const { agg } = makeAggregator(1_000_000, 100);
		agg.allocate("L1/node-1", { tokens: 20_000, usd: 1 });
		agg.recordUsage("L1/node-1", { inputTokens: 15_000, costUsd: 0.7 });
		agg.onNodeComplete("L1/node-1", { tokens: 20_000, usd: 1 });

		const s = agg.state();
		expect(s.allocated).toEqual({ tokens: 0, usd: 0 });
		expect(s.peak.tokens).toBe(15_000);
		expect(s.peak.usd).toBeCloseTo(0.7, 10);
	});
});

// ─── Персистентность: изменения сохраняются в инжектированный store ─────────

describe("Персистентность: store.save вызывается при изменениях состояния", () => {
	it("recordUsage сохраняет состояние в store (F-31: budget-coordinator)", () => {
		const store = makeInMemoryStore(emptyBudgetState(1_000_000, 100));
		const agg = createBudgetAggregator(store);
		agg.recordUsage("L1/node-1", { inputTokens: 7_000, costUsd: 0.2 });

		expect(store.load().consumed.tokens).toBe(7_000);
		expect(store.load().consumed.usd).toBeCloseTo(0.2, 10);
	});

	it("allocate / onNodeComplete сохраняют состояние в store", () => {
		const store = makeInMemoryStore(emptyBudgetState(1_000_000, 100));
		const agg = createBudgetAggregator(store);
		agg.allocate("L1/node-1", { tokens: 5_000, usd: 0.1 });
		expect(store.load().allocated.tokens).toBe(5_000);

		agg.onNodeComplete("L1/node-1", { tokens: 5_000, usd: 0.1 });
		expect(store.load().allocated.tokens).toBe(0);
	});
});

// ─── Robustness: санитайзер отрицательных/NaN/Infinity значений ─────────────

describe("Robustness: allocate с невалидными значениями → false без мутаций", () => {
	it("allocate с отрицательным tokens → false, allocated не меняется", () => {
		const { agg } = makeAggregator(100_000, 100);
		const before = agg.state();
		const ok = agg.allocate("L1/bad", { tokens: -5_000, usd: 0 });
		expect(ok).toBe(false);
		expect(agg.state().allocated).toEqual(before.allocated);
	});

	it("allocate с отрицательным usd → false, allocated не меняется", () => {
		const { agg } = makeAggregator(100_000, 100);
		const before = agg.state();
		const ok = agg.allocate("L1/bad", { tokens: 1_000, usd: -1 });
		expect(ok).toBe(false);
		expect(agg.state().allocated).toEqual(before.allocated);
	});

	it("allocate с NaN tokens → false", () => {
		const { agg } = makeAggregator(100_000, 100);
		const before = agg.state();
		const ok = agg.allocate("L1/bad", { tokens: NaN, usd: 0 });
		expect(ok).toBe(false);
		expect(agg.state().allocated).toEqual(before.allocated);
	});

	it("allocate с Infinity usd → false", () => {
		const { agg } = makeAggregator(100_000, 100);
		const before = agg.state();
		const ok = agg.allocate("L1/bad", { tokens: 0, usd: Infinity });
		expect(ok).toBe(false);
		expect(agg.state().allocated).toEqual(before.allocated);
	});

	it("allocate с обоими отрицательными → false, state не меняется", () => {
		const { agg } = makeAggregator(100_000, 100);
		const before = agg.state();
		const ok = agg.allocate("L1/bad", { tokens: -5_000, usd: -1 });
		expect(ok).toBe(false);
		expect(agg.state()).toEqual(before);
	});

	it("canAllocate тоже не пропускает отрицательные значения", () => {
		const { agg } = makeAggregator(100_000, 100);
		expect(agg.canAllocate({ tokens: -100, usd: 0 })).toBe(false);
		expect(agg.canAllocate({ tokens: 0, usd: -0.01 })).toBe(false);
		expect(agg.canAllocate({ tokens: NaN, usd: 0 })).toBe(false);
	});
});

describe("Robustness: recordUsage с NaN/отрицательными → consumed не отравлен", () => {
	it("NaN inputTokens → вклад 0, consumed остаётся {0,0}", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: NaN, costUsd: 0 });
		expect(agg.state().consumed.tokens).toBe(0);
		expect(agg.state().consumed.usd).toBe(0);
	});

	it("отрицательный inputTokens → вклад 0", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: -5_000, costUsd: 0 });
		expect(agg.state().consumed.tokens).toBe(0);
	});

	it("NaN costUsd → вклад 0 по usd", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 1_000, costUsd: NaN });
		expect(agg.state().consumed.tokens).toBe(1_000);
		expect(agg.state().consumed.usd).toBe(0);
	});

	it("отрицательный costUsd → вклад 0 по usd", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 1_000, costUsd: -0.5 });
		expect(agg.state().consumed.usd).toBe(0);
	});

	it("Infinity outputTokens → вклад 0 по tokens", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { outputTokens: Infinity, costUsd: 0 });
		expect(agg.state().consumed.tokens).toBe(0);
	});

	it("смешанный: валидный inputTokens + NaN outputTokens → только input учтён", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: 5_000, outputTokens: NaN, costUsd: 0.1 });
		expect(agg.state().consumed.tokens).toBe(5_000);
		expect(agg.state().consumed.usd).toBeCloseTo(0.1, 10);
	});

	it("NaN не отравляет peak — peak остаётся числом", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: NaN, costUsd: NaN });
		const s = agg.state();
		expect(Number.isFinite(s.peak.tokens)).toBe(true);
		expect(Number.isFinite(s.peak.usd)).toBe(true);
	});

	it("алерты живы после NaN recordUsage — последующий валидный расход триггерит onWarn", () => {
		const { agg, alerts } = makeAggregator(100_000, 100);
		// NaN record — не должен сломать алерты
		agg.recordUsage("L1/node-1", { inputTokens: NaN, costUsd: NaN });
		expect(alerts.warnCalls).toHaveLength(0);
		// Валидный расход доводит до 80%
		agg.recordUsage("L1/node-2", { inputTokens: 85_000, costUsd: 0 });
		expect(alerts.warnCalls).toHaveLength(1);
	});

	it("byBranch не отравлен NaN — вклад 0 для невалидных значений", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.recordUsage("L1/node-1", { inputTokens: NaN, outputTokens: -100, costUsd: Infinity });
		const branch = agg.state().byBranch["L1/node-1"];
		expect(branch.tokens).toBe(0);
		expect(branch.usd).toBe(0);
		expect(Number.isFinite(branch.tokens)).toBe(true);
		expect(Number.isFinite(branch.usd)).toBe(true);
	});
});

describe("Robustness: onNodeComplete с NaN → no-op вклад (allocated не меняется)", () => {
	it("NaN tokens в allocatedAmount → allocated не меняется", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 0.5 });
		agg.onNodeComplete("L1/node-1", { tokens: NaN, usd: 0.5 });
		// usd корректно списан, tokens — нет (NaN → 0, т.е. вычитание 0)
		expect(agg.state().allocated.tokens).toBe(10_000);
		expect(agg.state().allocated.usd).toBe(0);
	});

	it("отрицательный tokens в allocatedAmount → allocated не меняется по tokens", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 0.5 });
		agg.onNodeComplete("L1/node-1", { tokens: -5_000, usd: 0.5 });
		expect(agg.state().allocated.tokens).toBe(10_000);
		expect(agg.state().allocated.usd).toBe(0);
	});

	it("Infinity usd в allocatedAmount → usd списан полностью (Infinity → 0)", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 5 });
		agg.onNodeComplete("L1/node-1", { tokens: 10_000, usd: Infinity });
		expect(agg.state().allocated.tokens).toBe(0);
		expect(agg.state().allocated.usd).toBe(5); // Infinity → 0, вычитание 0
	});

	it("оба NaN → allocated полностью сохранён", () => {
		const { agg } = makeAggregator(100_000, 100);
		agg.allocate("L1/node-1", { tokens: 10_000, usd: 5 });
		agg.onNodeComplete("L1/node-1", { tokens: NaN, usd: NaN });
		expect(agg.state().allocated.tokens).toBe(10_000);
		expect(agg.state().allocated.usd).toBe(5);
	});
});
