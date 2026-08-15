// F-36: Глубина 3–4 (расширение диапазона) — RED-фаза TDD.
//
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-36
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2
//
// Текущее состояние модуля (этап 2):
//   • maxDepth жёстко = 12, нет концепции maxWorkingDepth
//   • canSpawn(depth, currentChildren, opts?) → { allowed, reason? }
//     (без полей currentDepth / maxDepth в ответе)
//   • Нет хелпера currentDepthFromEnv
//   • Нет колбэка onDepthExceeded
//
// Целевое API (после GREEN):
//   interface DepthWidthGuardOptions {
//     maxDepth?: number;          // жёсткий предохранитель, default 12, clamp ≤ 12
//     maxWidth?: number;          // default 12
//     workingWidth?: number;      // default 4
//     maxWorkingDepth?: number;   // NEW — рабочая глубина, default 4
//     onDepthExceeded?: (info: { currentDepth: number; maxDepth: number }) => void;
//   }
//   interface SpawnDecision {
//     allowed: boolean;
//     reason?: "max_depth_exceeded" | "max_width_exceeded";
//     currentDepth?: number;   // NEW — текущая глубина (родитель / эффективный лимит)
//     maxDepth?: number;       // NEW — сработавший лимит глубины
//   }
//   canSpawn(depth, currentChildren, opts?) → SpawnDecision
//     — depth: глубина, на которой будет новый узел (0 = L0)
//     — Проверка рабочей глубины: depth > maxWorkingDepth → отказ
//     — Инфраструктурный предохранитель: depth > 12 → отказ (даже если maxWorkingDepth > 12)
//
//   currentDepthFromEnv(): number
//     — читает FAN_ORCHESTRATOR_DEPTH, возвращает число (default 0)
//
// Покрытие (TC-карточки roadmap):
//   TC-F36-1  maxWorkingDepth=4, depth=3 → allowed: true
//   TC-F36-2  maxWorkingDepth=4, depth=5 → отказ max_depth_exceeded { currentDepth: 4, maxDepth: 4 }
//   TC-F36-3  maxWorkingDepth=3, depth=4 → отказ max_depth_exceeded { maxDepth: 3 }
//   Доп.      дефолт maxWorkingDepth=4, инфра-предохранитель 12, onDepthExceeded,
//             currentDepthFromEnv, валидация конфига

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let canSpawn;
let currentDepthFromEnv;

beforeEach(async () => {
	const mod = await import("../depth-width-guard.js");
	canSpawn = mod.canSpawn;
	currentDepthFromEnv = mod.currentDepthFromEnv;
});

// ─── TC-F36-1: Порождение на глубине 3 разрешено ────────────────────────────

describe("TC-F36-1: maxWorkingDepth=4, depth=3 → allowed", () => {
	it("depth=3, currentChildren=0 → allowed:true", () => {
		const decision = canSpawn(3, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBeUndefined();
	});

	it("depth=3 с width=3 (в пределах workingWidth) → allowed", () => {
		const decision = canSpawn(3, 3, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(true);
	});

	it("depth=4 при maxWorkingDepth=4 → allowed (последний рабочий уровень)", () => {
		const decision = canSpawn(4, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(true);
	});

	it("depth=1 при maxWorkingDepth=4 → allowed (начальные уровни свободны)", () => {
		const decision = canSpawn(1, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(true);
	});

	it("depth=0 (L0) при maxWorkingDepth=4 → allowed", () => {
		const decision = canSpawn(0, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(true);
	});
});

// ─── TC-F36-2: Порождение на глубине 5 отклонено ────────────────────────────

describe("TC-F36-2: maxWorkingDepth=4, depth=5 → max_depth_exceeded", () => {
	it("depth=5 → { allowed:false, reason:'max_depth_exceeded', currentDepth:4, maxDepth:4 }", () => {
		const decision = canSpawn(5, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.currentDepth).toBe(4);
		expect(decision.maxDepth).toBe(4);
	});

	it("depth=10 (выше рабочей глубины, ниже инфра-предохранителя) → отказ max_depth_exceeded", () => {
		const decision = canSpawn(10, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.maxDepth).toBe(4);
	});

	it("depth=5 + ширина=100: depth проверяется ПЕРЕД шириной → max_depth_exceeded", () => {
		const decision = canSpawn(5, 100, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});
});

// ─── TC-F36-3: Диапазон конфигурируется через config ────────────────────────

describe("TC-F36-3: maxWorkingDepth=3, depth=4 → отказ", () => {
	it("depth=4 → { allowed:false, reason:'max_depth_exceeded', maxDepth:3 }", () => {
		const decision = canSpawn(4, 0, { maxWorkingDepth: 3 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.maxDepth).toBe(3);
	});

	it("depth=3 при maxWorkingDepth=3 → allowed (граница рабочей глубины)", () => {
		const decision = canSpawn(3, 0, { maxWorkingDepth: 3 });
		expect(decision.allowed).toBe(true);
	});

	it("maxWorkingDepth=2, depth=3 → отказ max_depth_exceeded, maxDepth:2", () => {
		const decision = canSpawn(3, 0, { maxWorkingDepth: 2 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.maxDepth).toBe(2);
	});

	it("maxWorkingDepth=1, depth=1 → отказ, depth=0 → allowed", () => {
		expect(canSpawn(1, 0, { maxWorkingDepth: 1 }).allowed).toBe(false);
		expect(canSpawn(0, 0, { maxWorkingDepth: 1 }).allowed).toBe(true);
	});
});

// ─── Дефолт maxWorkingDepth = 4 ─────────────────────────────────────────────

describe("дефолт maxWorkingDepth=4 (без явного конфига)", () => {
	it("depth=4 → allowed (дефолтная рабочая глубина)", () => {
		const decision = canSpawn(4, 0);
		expect(decision.allowed).toBe(true);
	});

	it("depth=5 → отказ max_depth_exceeded (дефолтный лимит 4)", () => {
		const decision = canSpawn(5, 0);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.maxDepth).toBe(4);
	});

	it("depth=3 → allowed (в пределах дефолтного рабочего диапазона)", () => {
		const decision = canSpawn(3, 0);
		expect(decision.allowed).toBe(true);
	});

	it("пустой opts {} → maxWorkingDepth=4", () => {
		const decision = canSpawn(5, 0, {});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.maxDepth).toBe(4);
	});
});

// ─── Инфраструктурный предохранитель (жёсткий лимит 12) ────────────────────

describe("инфраструктурный предохранитель: жёсткий лимит 12", () => {
	it("depth=13 при maxWorkingDepth=12 → отказ (инфра-предохранитель выше 12 не поднимается)", () => {
		const decision = canSpawn(13, 0, { maxWorkingDepth: 12 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		expect(decision.maxDepth).toBe(12);
	});

	it("depth=12 при maxWorkingDepth=12 → allowed (граница инфра-предохранителя)", () => {
		const decision = canSpawn(12, 0, { maxWorkingDepth: 12 });
		expect(decision.allowed).toBe(true);
	});

	it("maxWorkingDepth=13 → clamp: depth=13 всё равно отказ (предохранитель 12)", () => {
		// Конфигурация maxWorkingDepth > 12: система либо clamps до 12,
		// либо отклоняет валидацией. В обоих случаях depth=13 → отказ.
		const decision = canSpawn(13, 0, { maxWorkingDepth: 13 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});

	it("maxWorkingDepth=100 → clamp: эффективный лимит не выше 12", () => {
		const decision = canSpawn(13, 0, { maxWorkingDepth: 100 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		// maxDepth в ответе = 12 (инфра-предохранитель), а не 100
		expect(decision.maxDepth).toBeLessThanOrEqual(12);
	});

	it("depth=20 (далеко за инфра-пределом) → отказ", () => {
		const decision = canSpawn(20, 0, { maxWorkingDepth: 12 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
	});
});

// ─── depth_exceeded событие (onDepthExceeded колбэк) ────────────────────────

describe("depth_exceeded: onDepthExceeded колбэк", () => {
	it("при отказе на рабочей глубине колбэк вызван с { currentDepth, maxDepth }", () => {
		const events = [];
		const onDepthExceeded = (info) => events.push(info);

		canSpawn(5, 0, { maxWorkingDepth: 4, onDepthExceeded });

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(
			expect.objectContaining({ currentDepth: 4, maxDepth: 4 }),
		);
	});

	it("при allowed=true колбэк НЕ вызван", () => {
		let called = false;
		const onDepthExceeded = () => {
			called = true;
		};

		const decision = canSpawn(3, 0, { maxWorkingDepth: 4, onDepthExceeded });

		expect(decision.allowed).toBe(true);
		expect(called).toBe(false);
	});

	it("при отказе на инфра-предохранителе (depth=13) колбэк тоже вызван", () => {
		const events = [];
		const onDepthExceeded = (info) => events.push(info);

		canSpawn(13, 0, { maxWorkingDepth: 12, onDepthExceeded });

		expect(events).toHaveLength(1);
		expect(events[0].maxDepth).toBeLessThanOrEqual(12);
	});

	it("колбэк вызван ровно один раз за каждый отказ", () => {
		let count = 0;
		const onDepthExceeded = () => {
			count++;
		};

		canSpawn(5, 0, { maxWorkingDepth: 4, onDepthExceeded });
		expect(count).toBe(1);

		canSpawn(6, 0, { maxWorkingDepth: 4, onDepthExceeded });
		expect(count).toBe(2);
	});

	it("без onDepthExceeded: отказ всё равно возвращает решение (колбэк опционален)", () => {
		const decision = canSpawn(5, 0, { maxWorkingDepth: 4 });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("max_depth_exceeded");
		// Не должно бросать исключение при отсутствии колбэка
	});
});

// ─── FAN_ORCHESTRATOR_DEPTH env хелпер ──────────────────────────────────────

describe("currentDepthFromEnv: чтение FAN_ORCHESTRATOR_DEPTH", () => {
	const ENV_KEY = "FAN_ORCHESTRATOR_DEPTH";
	let savedEnv;

	beforeEach(() => {
		savedEnv = process.env[ENV_KEY];
	});

	afterEach(() => {
		if (savedEnv !== undefined) {
			process.env[ENV_KEY] = savedEnv;
		} else {
			delete process.env[ENV_KEY];
		}
	});

	it("FAN_ORCHESTRATOR_DEPTH='3' → возвращает 3", () => {
		process.env[ENV_KEY] = "3";
		expect(currentDepthFromEnv()).toBe(3);
	});

	it("FAN_ORCHESTRATOR_DEPTH='0' → возвращает 0", () => {
		process.env[ENV_KEY] = "0";
		expect(currentDepthFromEnv()).toBe(0);
	});

	it("FAN_ORCHESTRATOR_DEPTH='12' → возвращает 12", () => {
		process.env[ENV_KEY] = "12";
		expect(currentDepthFromEnv()).toBe(12);
	});

	it("FAN_ORCHESTRATOR_DEPTH не задан → default 0", () => {
		delete process.env[ENV_KEY];
		expect(currentDepthFromEnv()).toBe(0);
	});

	it("FAN_ORCHESTRATOR_DEPTH='' (пустая строка) → default 0", () => {
		process.env[ENV_KEY] = "";
		expect(currentDepthFromEnv()).toBe(0);
	});

	it("FAN_ORCHESTRATOR_DEPTH='abc' (невалидное значение) → default 0", () => {
		process.env[ENV_KEY] = "abc";
		expect(currentDepthFromEnv()).toBe(0);
	});

	it("FAN_ORCHESTRATOR_DEPTH='-1' (отрицательное) → default 0 или 0+", () => {
		process.env[ENV_KEY] = "-1";
		const result = currentDepthFromEnv();
		expect(typeof result).toBe("number");
		// Реализация может вернуть 0 (clamp) или -1 (как есть);
		// как минимум — возвращает число без исключения
		expect(Number.isNaN(result)).toBe(false);
	});

	it("возвращает number (не string) при валидном значении", () => {
		process.env[ENV_KEY] = "5";
		expect(typeof currentDepthFromEnv()).toBe("number");
	});
});
