// F-25: Depth/width guard — RED-фаза TDD.
//
// Модуль ../depth-width-guard.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт модуля:
//   interface DepthWidthGuardOptions {
//     maxDepth?: number;     // default 12
//     maxWidth?: number;     // default 12 (предохранитель — жёсткий верх)
//     workingWidth?: number; // default 4  (рабочая ширина)
//   }
//   interface SpawnDecision {
//     allowed: boolean;
//     reason?: "max_depth_exceeded" | "max_width_exceeded";
//   }
//   canSpawn(depth, currentChildren, opts?) → SpawnDecision
//     — depth — глубина НА КОТОРОЙ будет новый узел (0 = L0)
//     — currentChildren — сколько детей УЖЕ есть у родителя
//
// Логика (порядок проверок):
//   1. depth >= maxDepth            → { allowed: false, reason: "max_depth_exceeded" }
//   2. currentChildren >= maxWidth  → { allowed: false, reason: "max_width_exceeded" }
//      (предохранитель maxWidth — жёсткий верх, даже если workingWidth больше)
//   3. currentChildren >= workingWidth → { allowed: false, reason: "max_width_exceeded" }
//   4. иначе                        → { allowed: true }
//
// Покрытие (TC-карточки roadmap):
//   TC-F25-1  depth=12 при maxDepth=12 → отказ max_depth_exceeded
//   TC-F25-2  currentChildren=4 при workingWidth=4 → отказ max_width_exceeded
//   TC-F25-3  depth=1, currentChildren=2 → allowed
//   Доп.      границы, предохранитель maxWidth, кастомный maxDepth, дефолты

import { beforeAll, describe, expect, it } from "vitest";

let canSpawn;
let canSpawnBatch;

beforeAll(async () => {
	const mod = await import("../depth-width-guard.js");
	canSpawn = mod.canSpawn;
	canSpawnBatch = mod.canSpawnBatch;
});

// ─── TC-F25-1: лимит глубины ────────────────────────────────────────────────

describe("TC-F25-1: depth >= maxDepth → max_depth_exceeded", () => {
	it("depth=12 при maxDepth=12 (дефолт) → отказ", () => {
		const decision = canSpawn(12, 0);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});

	it("depth=13 (выше лимита) → отказ", () => {
		const decision = canSpawn(13, 0);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});

	it("глубина проверяется ПЕРЕД шириной: depth=12 + переполненная ширина → max_depth_exceeded", () => {
		const decision = canSpawn(12, 100);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});
});

// ─── TC-F25-2: лимит рабочей ширины ─────────────────────────────────────────

describe("TC-F25-2: currentChildren >= workingWidth → max_width_exceeded", () => {
	it("currentChildren=4 при workingWidth=4 (дефолт) → отказ", () => {
		const decision = canSpawn(1, 4);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("currentChildren=5 (выше рабочей ширины) → отказ", () => {
		const decision = canSpawn(1, 5);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("кастомный workingWidth=2: currentChildren=2 → отказ", () => {
		const decision = canSpawn(1, 2, { workingWidth: 2 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});
});

// ─── TC-F25-3: happy path ───────────────────────────────────────────────────

describe("TC-F25-3: в пределах лимитов → allowed", () => {
	it("depth=1, currentChildren=2 → allowed:true без reason", () => {
		const decision = canSpawn(1, 2);
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
	});

	it("depth=0 (L0), currentChildren=0 (первый узел) → allowed", () => {
		const decision = canSpawn(0, 0);
		expect(decision.allowed).toBe(true);
	});
});

// ─── Граничные значения ─────────────────────────────────────────────────────

describe("границы: последний разрешённый шаг", () => {
	// F-36: дефолт maxWorkingDepth=4 — глубина 11 вне рабочего диапазона.
	// Граница infra-предохранителя проверяется с явным maxWorkingDepth=12.
	it("depth=11 при maxWorkingDepth=12 → allowed (граница глубины)", () => {
		const decision = canSpawn(11, 0, { maxWorkingDepth: 12 });
		expect(decision.allowed).toBe(true);
	});

	it("currentChildren=3 при workingWidth=4 → allowed (граница ширины)", () => {
		const decision = canSpawn(1, 3);
		expect(decision.allowed).toBe(true);
	});

	it("depth=11 и currentChildren=3 одновременно → allowed (обе границы)", () => {
		const decision = canSpawn(11, 3, { maxWorkingDepth: 12 }); // F-36: см. выше
		expect(decision.allowed).toBe(true);
	});
});

// ─── Предохранитель maxWidth (жёсткий верх) ─────────────────────────────────

describe("предохранитель maxWidth: жёсткий верх независимо от workingWidth", () => {
	it("workingWidth=20 (выше предохранителя), currentChildren=12 → отказ max_width_exceeded", () => {
		const decision = canSpawn(1, 12, { workingWidth: 20 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("workingWidth=20, currentChildren=11 (ниже предохранителя 12) → allowed", () => {
		const decision = canSpawn(1, 11, { workingWidth: 20 });
		expect(decision.allowed).toBe(true);
	});

	it("кастомный maxWidth=6 при workingWidth=10: currentChildren=6 → отказ", () => {
		const decision = canSpawn(1, 6, { workingWidth: 10, maxWidth: 6 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("кастомный maxWidth=6 при workingWidth=10: currentChildren=5 → allowed", () => {
		const decision = canSpawn(1, 5, { workingWidth: 10, maxWidth: 6 });
		expect(decision.allowed).toBe(true);
	});
});

// ─── Кастомный maxDepth ─────────────────────────────────────────────────────

describe("кастомный maxDepth", () => {
	it("maxDepth=3: depth=3 → отказ max_depth_exceeded", () => {
		const decision = canSpawn(3, 0, { maxDepth: 3 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});

	it("maxDepth=3: depth=2 → allowed", () => {
		const decision = canSpawn(2, 0, { maxDepth: 3 });
		expect(decision.allowed).toBe(true);
	});

	it("maxDepth=1: depth=0 → allowed, depth=1 → отказ", () => {
		expect(canSpawn(0, 0, { maxDepth: 1 }).allowed).toBe(true);
		const denied = canSpawn(1, 0, { maxDepth: 1 });
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toBe("max_depth_exceeded");
	});
});

// ─── Дефолты опций ──────────────────────────────────────────────────────────

describe("опции по умолчанию (maxDepth=12, workingWidth=4, maxWidth=12)", () => {
	it("вызов без opts эквивалентен явным дефолтам", () => {
		for (const [depth, children] of [
			[0, 0],
			[11, 3],
			[12, 0],
			[1, 4],
		]) {
			expect(canSpawn(depth, children)).toEqual(
				canSpawn(depth, children, { maxDepth: 12, workingWidth: 4, maxWidth: 12 }),
			);
		}
	});

	it("пустой opts {} эквивалентен дефолтам", () => {
		expect(canSpawn(12, 0, {})).toEqual(canSpawn(12, 0));
		expect(canSpawn(1, 4, {})).toEqual(canSpawn(1, 4));
	});

	it("частичные opts: задан только maxDepth — workingWidth остаётся 4", () => {
		const decision = canSpawn(1, 4, { maxDepth: 100 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});
});

// ─── canSpawnBatch: batch-вариант для EPIC-делегирования ──────────────────
// Пачка из N новых детей допустима при N <= workingWidth и N <= maxWidth
// (граница `>`, в отличие от поштучного `>=`). Дефолт workingWidth=4 синхронен
// с MAX_EPIC_SUBTASKS в fan-mission/epic-delegation.ts.

describe("canSpawnBatch: размер пачки против лимитов ширины", () => {
	it("4 пакета при default workingWidth=4 → allowed (граница `>`: 4 не превышает 4)", () => {
		const decision = canSpawnBatch(1, 4);
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
	});

	it("5 пакетов при default workingWidth=4 → отказ max_width_exceeded", () => {
		const decision = canSpawnBatch(1, 5);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("13 пакетов при maxWidth=12 → отказ max_width_exceeded (жёсткий верх)", () => {
		// workingWidth=12 поднят до предохранителя, чтобы проверять именно maxWidth
		const decision = canSpawnBatch(1, 13, { maxWidth: 12, workingWidth: 12 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	it("12 пакетов при maxWidth=12, workingWidth=12 → allowed (граница предохранителя)", () => {
		const decision = canSpawnBatch(1, 12, { maxWidth: 12, workingWidth: 12 });
		expect(decision.allowed).toBe(true);
	});

	it("кастомный workingWidth=2: пачка 3 → отказ, пачка 2 → allowed", () => {
		expect(canSpawnBatch(1, 3, { workingWidth: 2 }).allowed).toBe(false);
		expect(canSpawnBatch(1, 2, { workingWidth: 2 }).allowed).toBe(true);
	});
});

describe("canSpawnBatch: depth-отказ сохранён (как в поштучном canSpawn)", () => {
	it("depth=5 при default maxWorkingDepth=4 → отказ max_depth_exceeded", () => {
		const decision = canSpawnBatch(5, 1);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.currentDepth).toBe(4);
		expect(decision.maxDepth).toBe(4);
	});

	it("depth=4 == effectiveMax → allowed (последний рабочий уровень)", () => {
		const decision = canSpawnBatch(4, 1);
		expect(decision.allowed).toBe(true);
	});

	it("depth-отказ приоритетнее width-отказа и вызывает onDepthExceeded ровно один раз", () => {
		let calls = 0;
		const decision = canSpawnBatch(5, 100, { onDepthExceeded: () => calls++ });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(calls).toBe(1);
	});

	it("width-отказ НЕ вызывает onDepthExceeded", () => {
		let calls = 0;
		const decision = canSpawnBatch(1, 5, { onDepthExceeded: () => calls++ });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
		expect(calls).toBe(0);
	});
});
