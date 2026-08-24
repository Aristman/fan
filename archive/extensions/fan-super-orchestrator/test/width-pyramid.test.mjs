// F-C / TC-FC-1: Width pyramid constants + canSpawnBatch validation — RED-фаза TDD.
//
// Модуль ../width-pyramid.js ещё НЕ существует: весь файл обязан падать
// с ошибкой импорта (ERR_MODULE_NOT_FOUND в beforeAll). После реализации
// (GREEN) тесты должны пройти БЕЗ изменений.
//
// Контракт модуля (roadmap §F-C, architecture §5):
//   PYRAMID_WIDTH = {
//     working: { 1: 8, 2: 6, 3: 4, 4: 2 },
//     max:     { 1: 12, 2: 10, 3: 8, 4: 4 },
//   }
//
//   canSpawnBatch({ depth, batch, role?, profile? }) → SpawnDecision
//     — depth   — глубина, НА КОТОРОЙ будут новые узлы (1–4)
//     — batch   — размер пачки (сколько детей порождается одновременно)
//     — role    — роль родителя ('super-orchestrator' | 'orchestrator' | undefined)
//     — profile — профиль роли (string | undefined)
//
// Логика (порядок проверок):
//   1. depth вне диапазона 1–4        → { allowed: false, reason: "max_depth_exceeded" }
//   2. batch > PYRAMID_MAX[depth]      → { allowed: false, reason: "max_width_exceeded" }
//   3. batch > PYRAMID_WORKING[depth]  → { allowed: false, reason: "working_width_exceeded" }
//   4. иначе                          → { allowed: true }
//
//   Для role='super-orchestrator' — лимиты берутся на уровень выше
//   (depth-1), т.к. супер-оркестратор управляет другими оркестраторами
//   и нуждается в более широком диапазоне. На depth=1 лимит = max[1]=12.
//
// Покрытие (TC-карточки roadmap):
//   TC-FC-1  Константы пирамиды + граничные значения canSpawnBatch

import { beforeAll, describe, expect, it } from "vitest";

let PYRAMID_WIDTH;
let canSpawnBatch;

beforeAll(async () => {
	const mod = await import("../width-pyramid.js");
	PYRAMID_WIDTH = mod.PYRAMID_WIDTH;
	canSpawnBatch = mod.canSpawnBatch;
});

// ─── TC-FC-1a: Константы пирамиды — working width ────────────────────────────

describe("TC-FC-1a: PYRAMID_WIDTH.working — рабочая ширина по глубине", () => {
	it("depth=1 → working width 8", () => {
		expect(PYRAMID_WIDTH.working[1]).toBe(8);
	});

	it("depth=2 → working width 6", () => {
		expect(PYRAMID_WIDTH.working[2]).toBe(6);
	});

	it("depth=3 → working width 4", () => {
		expect(PYRAMID_WIDTH.working[3]).toBe(4);
	});

	it("depth=4 → working width 2", () => {
		expect(PYRAMID_WIDTH.working[4]).toBe(2);
	});
});

// ─── TC-FC-1b: Константы пирамиды — max width (жёсткий верх) ─────────────────

describe("TC-FC-1b: PYRAMID_WIDTH.max — максимальная ширина по глубине", () => {
	it("depth=1 → max width 12", () => {
		expect(PYRAMID_WIDTH.max[1]).toBe(12);
	});

	it("depth=2 → max width 10", () => {
		expect(PYRAMID_WIDTH.max[2]).toBe(10);
	});

	it("depth=3 → max width 8", () => {
		expect(PYRAMID_WIDTH.max[3]).toBe(8);
	});

	it("depth=4 → max width 4", () => {
		expect(PYRAMID_WIDTH.max[4]).toBe(4);
	});
});

// ─── TC-FC-1c: canSpawnBatch — пирамидная валидация ──────────────────────────

describe("TC-FC-1c: canSpawnBatch — batch vs pyramid limits", () => {
	// Super-orchestrator на depth=2 использует лимиты depth=1 (max=12).
	// batch=11 ≤ 12 → ALLOWED.
	it("batch=11 at depth=2, role=super-orchestrator → ALLOWED (super-orch использует лимиты уровнем выше: max=12)", () => {
		const decision = canSpawnBatch({
			depth: 2,
			batch: 11,
			role: "super-orchestrator",
			profile: "backend",
		});
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
	});

	// Без роли: depth=2, max=10. batch=12 > 10 → DENIED.
	it("batch=12 at depth=2 (без роли) → DENIED, reason=max_width_exceeded", () => {
		const decision = canSpawnBatch({ depth: 2, batch: 12 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});

	// depth=4: working=2, max=4. batch=4 > working=2, но ≤ max=4 → working_width_exceeded.
	it("batch=4 at depth=4 → DENIED, reason=working_width_exceeded (> working=2, ≤ max=4)", () => {
		const decision = canSpawnBatch({ depth: 4, batch: 4 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("working_width_exceeded");
	});

	// depth=4: batch=5 > max=4 → max_width_exceeded (жёсткий верх).
	it("batch=5 at depth=4 → DENIED, reason=max_width_exceeded (> max=4)", () => {
		const decision = canSpawnBatch({ depth: 4, batch: 5 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_width_exceeded");
	});
});

// ─── TC-FC-1d: canSpawnBatch — граничные значения (happy path) ───────────────

describe("TC-FC-1d: canSpawnBatch — границы разрешённого", () => {
	// depth=1, batch=8 = working[1] → ALLOWED (граница `>`: 8 не превышает 8).
	it("batch=8 at depth=1 → ALLOWED (граница working width)", () => {
		const decision = canSpawnBatch({ depth: 1, batch: 8 });
		expect(decision.allowed).toBe(true);
	});

	// depth=1, batch=9 > working[1]=8, но ≤ max[1]=12 → working_width_exceeded.
	it("batch=9 at depth=1 → DENIED, reason=working_width_exceeded", () => {
		const decision = canSpawnBatch({ depth: 1, batch: 9 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("working_width_exceeded");
	});

	// depth=2, batch=6 = working[2] → ALLOWED.
	it("batch=6 at depth=2 → ALLOWED (граница working width)", () => {
		const decision = canSpawnBatch({ depth: 2, batch: 6 });
		expect(decision.allowed).toBe(true);
	});

	// depth=2, batch=10 = max[2] → DENIED working_width_exceeded (> working=6, ≤ max=10).
	it("batch=10 at depth=2 → DENIED, reason=working_width_exceeded (> working=6, ≤ max=10)", () => {
		const decision = canSpawnBatch({ depth: 2, batch: 10 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("working_width_exceeded");
	});

	// depth=4, batch=2 = working[4] → ALLOWED.
	it("batch=2 at depth=4 → ALLOWED (граница working width)", () => {
		const decision = canSpawnBatch({ depth: 4, batch: 2 });
		expect(decision.allowed).toBe(true);
	});

	// depth=4, batch=4 = max[4] → DENIED working_width_exceeded (> working=2, ≤ max=4).
	it("batch=4 at depth=4 → DENIED working_width_exceeded (= max, но > working)", () => {
		const decision = canSpawnBatch({ depth: 4, batch: 4 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("working_width_exceeded");
	});
});

// ─── TC-FC-1e: canSpawnBatch — depth out of range ────────────────────────────

describe("TC-FC-1e: canSpawnBatch — глубина вне диапазона", () => {
	it("depth=0 → DENIED, reason=max_depth_exceeded (пирамида определена для 1–4)", () => {
		const decision = canSpawnBatch({ depth: 0, batch: 1 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});

	it("depth=5 → DENIED, reason=max_depth_exceeded (выше максимума пирамиды)", () => {
		const decision = canSpawnBatch({ depth: 5, batch: 1 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});
});
