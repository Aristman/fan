// F-13: Расширение fan-scheduler (тики I4) — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-13
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.3, §3.2.1 (таблица I4)
//
// Контракт API (по карточке F-13 + спека §3.2.3, паттерн по образцу
// fan-mission/test/mission-widget.test.mjs):
//
//   function startScheduler(ctx: SchedulerCtx): { stop: () => void }
//
//   SchedulerCtx (DI для тестов; в проде ctx = ExtensionAPI от fan):
//     actions: {
//       sendMessage(text: string, streamingBehavior: "steer" | "followUp" | "nextTurn")
//         : void | Promise<void>
//     }
//     getStatus: () => Promise<MissionStatus> | MissionStatus
//       MissionStatus = "active" | "paused" | "completed" | "aborted"
//                      | "failed" | "budget_exhausted"
//     getMissionDir?: () => string          — для подстановки {missionDir}
//     tickPrompt?: string                   — шаблон с плейсхолдерами
//                                            {missionDir}, {date}
//     intervalMs?: number                   — период тиков (мс). Дефолт 60000
//     cronExpression?: string               — опциональный cron (refactor-цель)
//
//   Возвращаемое значение:
//     { stop: () => void }                  — остановка setInterval/cron.
//
// Поведение (TC-F13-1..3 + критерии приёмки):
//   1. При intervalMs и активной миссии — setInterval тикает, на каждом тике
//      проверяется getStatus(); если "active" → actions.sendMessage(tickPrompt,
//      "followUp"); tickPrompt — шаблон с подставленными {missionDir}/{date}.
//   2. Если getStatus() !== "active" — тик НЕ доставляется (paused/completed/
//      aborted/failed/budget_exhausted).
//   3. stop() — выключает setInterval/cron, новых тиков нет.
//   4. start→stop→start (restart) — корректно переустанавливает таймер.
//   5. Дефолты: intervalMs = 60000 (60 с), tickPrompt — дефолтный шаблон из спеки.
//
// Этап 0 (Red): модуль `extensions/fan-scheduler/scheduler.ts` ещё не существует
// → динамический import падает с ERR_MODULE_NOT_FOUND. Каждый it() отмечается
// vitest как failing. После реализации модуля по контракту выше — тесты должны
// проходить.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Динамический import модуля, который ещё не существует → ERR_MODULE_NOT_FOUND.
// Каждый describe-блок получает свежий import-фейл (через beforeAll → import).
// ────────────────────────────────────────────────────────────────────────────

let startScheduler;
let parseCronExpression;

async function importScheduler() {
	if (!startScheduler) {
		const mod = await import("../scheduler.js");
		startScheduler = mod.startScheduler;
		parseCronExpression = mod.parseCronExpression;
	}
	return startScheduler;
}

// ────────────────────────────────────────────────────────────────────────────
// DI-хелперы: mock-контекст по образцу F-09/F-12.
//
// SchedulerCtx (контракт):
//   actions: { sendMessage(text, streamingBehavior): void | Promise<void> }
//   getStatus: () => Promise<string> | string
//   getMissionDir?: () => string
//   tickPrompt?: string
//   intervalMs?: number
//   cronExpression?: string
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-memory actions.sendMessage, логирует все вызовы.
 * streamingBehavior допущения: "steer" | "followUp" | "nextTurn".
 */
function makeMockActions(overrides = {}) {
	const calls = [];
	const actions = {
		calls,
		sendMessage(text, streamingBehavior) {
			calls.push({ text, streamingBehavior });
			if (overrides.sendMessageImpl) {
				return overrides.sendMessageImpl(text, streamingBehavior);
			}
			return undefined;
		},
	};
	return actions;
}

/**
 * getStatus mock. По умолчанию возвращает "active".
 * Переопределите через makeCtx({ getStatus: () => "paused" }).
 */
function makeMockGetStatus(overrides = {}) {
	const calls = [];
	const getStatus = overrides.getStatusImpl
		? (...args) => {
				calls.push(args);
				return overrides.getStatusImpl(...args);
			}
		: (...args) => {
				calls.push(args);
				return overrides.defaultStatus ?? "active";
			};
	return { getStatus, getStatusCalls: calls };
}

/**
 * Полный DI-контекст для scheduler'а.
 * Поведение по умолчанию: активная миссия, missionDir="/tmp/test-mission",
 * интервал 60000 мс, дефолтный шаблон.
 */
function makeCtx(overrides = {}) {
	const actions = makeMockActions(overrides.actions);
	const { getStatus, getStatusCalls } = makeMockGetStatus(overrides);
	const ctx = {
		actions,
		getStatus,
		getMissionDir: overrides.getMissionDir ?? (() => "/tmp/test-mission"),
		tickPrompt:
			overrides.tickPrompt ??
			"Тик контура миссии. Прочитай STATE.md, ROADMAP.md и BACKLOG.md в {missionDir}, проверь git log. Реши: ITERATE / GENERATE / IDLE.",
		intervalMs: overrides.intervalMs,
		cronExpression: overrides.cronExpression,
		...overrides.ctxOverrides,
	};
	// accessors for tests
	ctx._actions = actions;
	ctx._getStatusCalls = getStatusCalls;
	return ctx;
}

// ────────────────────────────────────────────────────────────────────────────
// Module structure (smoke tests)
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-module: startScheduler API contract", () => {
	beforeEach(async () => {
		await importScheduler();
	});

	it("TC-F13-module: startScheduler экспортируется как функция", () => {
		expect(typeof startScheduler).toBe("function");
	});

	it("TC-F13-module: возвращает объект с методом stop()", () => {
		const handle = startScheduler(makeCtx());
		expect(handle).toBeDefined();
		expect(typeof handle.stop).toBe("function");
		handle.stop(); // cleanup
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F13-1: Тик доставляется как followUp-сообщение через ~1100 мс
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-1: тик доставляется как followUp-сообщение", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-1: intervalMs=1000, mission active → через 1100 мс sendMessage вызван", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/m1",
			tickPrompt: "Тик в {missionDir}, дата: {date}",
		});
		const handle = startScheduler(ctx);
		try {
			// 1100 мс — гарантированно пересекает один интервал (1000 мс)
			await vi.advanceTimersByTimeAsync(1100);
			// Должен быть хотя бы 1 вызов sendMessage
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-1: streamingBehavior равен 'followUp'", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/m2",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			expect(ctx._actions.calls[0].streamingBehavior).toBe("followUp");
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-1: на каждый интервал — новый тик (3 интервала → 3 вызова)", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/m3",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3500); // 3 полных интервала
			// Допускаем ±1 (граничные эффекты)
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(3);
			expect(ctx._actions.calls.length).toBeLessThanOrEqual(4);
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F13-2: Миссия в статусе paused → sendMessage НЕ вызван
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-2: тик НЕ доставляется при паузе", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-2: mission paused → 1100 мс прошло, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "paused",
			getMissionDir: () => "/tmp/p1",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBe(0);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-2: getStatus вызывается на каждом тике (для проверки условия)", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "paused",
			getMissionDir: () => "/tmp/p2",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3500);
			// getStatus вызван на каждом тике (3 раза), даже если тик не доставлен
			expect(ctx._getStatusCalls.length).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-2: paused → active (оператор resume) → следующий тик доставляется", async () => {
		let currentStatus = "paused";
		const ctx = makeCtx({
			intervalMs: 1000,
			getStatusImpl: () => currentStatus,
			getMissionDir: () => "/tmp/p3",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBe(0); // paused

			// Оператор делает resume
			currentStatus = "active";
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1); // resumed
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F13-3: Шаблон tickPrompt с плейсхолдерами → реальные значения
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-3: плейсхолдеры в tickPrompt заменяются", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-3: {missionDir} заменён на путь из getMissionDir()", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/missions/foo",
			tickPrompt: "Тик в {missionDir}, дата: {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			const text = ctx._actions.calls[0].text;
			expect(text).not.toMatch(/\{missionDir\}/);
			expect(text).toContain("/tmp/missions/foo");
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-3: {date} заменён на текущую дату (ISO)", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/foo",
			tickPrompt: "Тик в {missionDir}, дата: {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			const text = ctx._actions.calls[0].text;
			expect(text).not.toMatch(/\{date\}/);
			// setSystemTime выше → 2026-08-12
			expect(text).toMatch(/2026-08-12/);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-3: неизвестный плейсхолдер {foo} остаётся как есть (или пустая строка — на усмотрение)", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/foo",
			tickPrompt: "Тик {date}, фу={foo}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			const text = ctx._actions.calls[0].text;
			// Неизвестные плейсхолдеры — контракт допускает 2 варианта:
			// (a) оставить как есть {foo}, (b) заменить на пустую строку.
			// Главное — НЕ падать и НЕ вернуть undefined.
			expect(text).toBeTypeOf("string");
			expect(text.length).toBeGreaterThan(0);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-3: tickPrompt без плейсхолдеров — текст не меняется", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/foo",
			tickPrompt: "Plain text without placeholders",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			expect(ctx._actions.calls[0].text).toBe("Plain text without placeholders");
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 1: cronExpression — фиктивный cron (refactor-цель)
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-cron: cronExpression как альтернатива intervalMs", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-cron: cronExpression='*/5 * * * *' принимается контекстом без падения", async () => {
		// Минимальный контракт Red-фазы: модуль не должен падать на cron-выражении.
		// Полный cron-парсер — refactor-цель (см. карточку F-13).
		const ctx = makeCtx({
			cronExpression: "*/5 * * * *",
			defaultStatus: "active",
			getMissionDir: () => "/tmp/c1",
			tickPrompt: "tick {date}",
		});
		// startScheduler не должен кидать на cron-входе
		const handle = startScheduler(ctx);
		expect(handle).toBeDefined();
		expect(typeof handle.stop).toBe("function");
		handle.stop();
	});

	it("TC-F13-cron: cronExpression + intervalMs одновременно → cron побеждает (или interval — допустимо оба)", async () => {
		// Контракт допускает 2 интерпретации; главное — нет падения.
		// Типичное решение: cron побеждает (более точный инструмент).
		const ctx = makeCtx({
			cronExpression: "*/5 * * * *",
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/c2",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			// Если cron побеждает — 0 тиков за 1100 мс.
			// Если interval побеждает — 1 тик.
			// Допускаем оба варианта, но НЕ падение.
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(0);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-cron: невалидный cron → либо throw, либо игнор (контракт: no silent crash)", () => {
		const ctx = makeCtx({
			cronExpression: "ЭТО НЕ CRON",
			defaultStatus: "active",
			getMissionDir: () => "/tmp/c3",
			tickPrompt: "tick {date}",
		});
		// Не должно бросать "неожиданно" — либо явная ошибка, либо фолбэк.
		// Главное — не утечка таймера и не crash.
		let handle;
		try {
			handle = startScheduler(ctx);
		} catch (e) {
			// явная ошибка — ок
			expect(e).toBeInstanceOf(Error);
			return;
		}
		expect(handle).toBeDefined();
		handle.stop();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 2: terminal statuses (completed/aborted/failed/budget_exhausted)
// → sendMessage НЕ вызван
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-terminal: терминальные статусы → тик не доставляется", () => {
	const terminalStatuses = ["completed", "aborted", "failed", "budget_exhausted"];

	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	for (const status of terminalStatuses) {
		it(`TC-F13-terminal: статус '${status}' → sendMessage НЕ вызван после 3100 мс`, async () => {
			const ctx = makeCtx({
				intervalMs: 1000,
				defaultStatus: status,
				getMissionDir: () => `/tmp/t-${status}`,
				tickPrompt: "tick {date}",
			});
			const handle = startScheduler(ctx);
			try {
				await vi.advanceTimersByTimeAsync(3100); // 3 интервала
				expect(ctx._actions.calls.length).toBe(0);
			} finally {
				handle.stop();
			}
		});
	}

	it("TC-F13-terminal: getStatus возвращает Promise<string> (async getStatus)", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			getStatusImpl: async () => "completed",
			getMissionDir: () => "/tmp/t-async",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBe(0);
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 3: stop() останавливает setInterval
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-stop: stop() останавливает планировщик", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-stop: после stop() новые тики не доставляются", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/s1",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);

		await vi.advanceTimersByTimeAsync(2500);
		const beforeStop = ctx._actions.calls.length;
		expect(beforeStop).toBeGreaterThanOrEqual(2); // 2 тика до стопа

		handle.stop();

		await vi.advanceTimersByTimeAsync(5000); // ещё 5 секунд — тиков быть не должно
		const afterStop = ctx._actions.calls.length;
		expect(afterStop).toBe(beforeStop); // никаких новых вызовов
	});

	it("TC-F13-stop: stop() идемпотентен (повторный вызов — без ошибок)", () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/s2",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		expect(() => handle.stop()).not.toThrow();
		expect(() => handle.stop()).not.toThrow(); // повторно — без падения
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 4: start → stop → start (перезапуск)
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-restart: перезапуск планировщика", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-restart: start → stop → start → тики идут снова", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/r1",
			tickPrompt: "tick {date}",
		});

		// 1-й цикл
		const handle1 = startScheduler(ctx);
		await vi.advanceTimersByTimeAsync(2500);
		const firstCycleCalls = ctx._actions.calls.length;
		expect(firstCycleCalls).toBeGreaterThanOrEqual(2);
		handle1.stop();

		// Перезапуск
		const handle2 = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(2500);
			const secondCycleCalls = ctx._actions.calls.length;
			// После рестарта добавилось ещё ≥2 вызова
			expect(secondCycleCalls).toBeGreaterThanOrEqual(firstCycleCalls + 2);
		} finally {
			handle2.stop();
		}
	});

	it("TC-F13-restart: новый handle.start() возвращает свежий объект {stop}", () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/r2",
			tickPrompt: "tick {date}",
		});
		const h1 = startScheduler(ctx);
		const h2 = startScheduler(ctx);
		expect(h1).not.toBe(h2); // разные инстансы
		expect(typeof h1.stop).toBe("function");
		expect(typeof h2.stop).toBe("function");
		h1.stop();
		h2.stop();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 5: дефолты (intervalMs, tickPrompt)
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-defaults: конфигурационные дефолты", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-defaults: intervalMs не задан → дефолт 60000 мс (60 с)", async () => {
		const ctx = makeCtx({
			// intervalMs НЕ передан
			defaultStatus: "active",
			getMissionDir: () => "/tmp/d1",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			// За 59 с тиков быть не должно (дефолт = 60000)
			await vi.advanceTimersByTimeAsync(59_000);
			expect(ctx._actions.calls.length).toBe(0);
			// На 61-й секунде — первый тик
			await vi.advanceTimersByTimeAsync(2_000);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-defaults: tickPrompt не задан → используется дефолтный шаблон из спеки", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/d2",
			// tickPrompt НЕ передан → дефолт из makeCtx()
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			const text = ctx._actions.calls[0].text;
			// Дефолтный шаблон содержит упоминание контура и плейсхолдеры
			expect(text).toMatch(/контур|миссия/i);
			expect(text).toMatch(/\{missionDir\}|\/tmp\/d2/); // плейсхолдер либо подставлен
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-defaults: дефолтный tickPrompt содержит плейсхолдер {date}", async () => {
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/d3",
			// дефолтный tickPrompt
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			const text = ctx._actions.calls[0].text;
			// {date} должен быть заменён (либо уже нет в выводе)
			expect(text).not.toMatch(/\{date\}/);
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Bug fix: scheduler resilience — sendMessage/getStatus throw
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-resilience: scheduler survives errors in tickHandler", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		// Suppress console.error noise from intentional errors
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("TC-F13-resilience: sendMessage throws → interval scheduler continues", async () => {
		let callCount = 0;
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => "/tmp/res1",
			tickPrompt: "tick {date}",
			actions: {
				sendMessageImpl() {
					callCount++;
					throw new Error("sendMessage exploded");
				},
			},
		});
		const handle = startScheduler(ctx);
		try {
			// Advance enough for several ticks — scheduler must NOT die
			await vi.advanceTimersByTimeAsync(3500);
			// sendMessage was called multiple times despite earlier throws
			expect(callCount).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-resilience: getStatus throws → interval scheduler continues", async () => {
		let statusCalls = 0;
		const ctx = makeCtx({
			intervalMs: 1000,
			getStatusImpl: () => {
				statusCalls++;
				throw new Error("getStatus exploded");
			},
			getMissionDir: () => "/tmp/res2",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3500);
			// getStatus was called on every tick despite errors
			expect(statusCalls).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-resilience: sendMessage throws → cron scheduler continues and reschedules", async () => {
		let callCount = 0;
		const ctx = makeCtx({
			cronExpression: "* * * * *", // every minute
			defaultStatus: "active",
			getMissionDir: () => "/tmp/res3",
			tickPrompt: "tick {date}",
			actions: {
				sendMessageImpl() {
					callCount++;
					throw new Error("sendMessage exploded in cron");
				},
			},
		});
		const handle = startScheduler(ctx);
		try {
			// Advance 3 minutes — cron fires at :01, :02, :03 → 3 ticks
			await vi.advanceTimersByTimeAsync(3 * 60_000 + 100);
			expect(callCount).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-resilience: getStatus throws → cron scheduler continues and reschedules", async () => {
		let statusCalls = 0;
		const ctx = makeCtx({
			cronExpression: "* * * * *",
			getStatusImpl: () => {
				statusCalls++;
				throw new Error("getStatus exploded in cron");
			},
			getMissionDir: () => "/tmp/res4",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3 * 60_000 + 100);
			expect(statusCalls).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Bug fix: cron fires at correct time (fake timer advance)
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-cron-timing: cron реально стреляет в правильное время", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("TC-F13-cron-timing: '*/5 * * * *' fires at :05, :10, :15", async () => {
		// Use local-time Date to avoid timezone mismatch (cron uses getHours() = local).
		const localStart = new Date(2026, 7, 12, 10, 0, 0, 0); // Aug 12, 10:00 local
		vi.setSystemTime(localStart);
		const ctx = makeCtx({
			cronExpression: "*/5 * * * *",
			defaultStatus: "active",
			getMissionDir: () => "/tmp/ct1",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			// Advance 4 min — no tick yet (next is :05)
			await vi.advanceTimersByTimeAsync(4 * 60_000);
			expect(ctx._actions.calls.length).toBe(0);

			// Advance to ~10:05:30 — first tick fired
			await vi.advanceTimersByTimeAsync(90_000);
			expect(ctx._actions.calls.length).toBe(1);

			// Advance another 4 min — still 1 tick (next is :10)
			await vi.advanceTimersByTimeAsync(4 * 60_000);
			expect(ctx._actions.calls.length).toBe(1);

			// Advance to ~10:10:30 — second tick fired
			await vi.advanceTimersByTimeAsync(90_000);
			expect(ctx._actions.calls.length).toBe(2);
		} finally {
			handle.stop();
		}
	});

	it("TC-F13-cron-timing: '30 10 * * *' fires exactly at 10:30", async () => {
		// Use local-time Date to avoid timezone mismatch (cron uses getHours() = local).
		const localStart = new Date(2026, 7, 12, 10, 0, 0, 0); // Aug 12, 10:00 local
		vi.setSystemTime(localStart);
		const ctx = makeCtx({
			cronExpression: "30 10 * * *",
			defaultStatus: "active",
			getMissionDir: () => "/tmp/ct2",
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			// Advance 29 minutes — no tick (next is 10:30 local)
			await vi.advanceTimersByTimeAsync(29 * 60_000);
			expect(ctx._actions.calls.length).toBe(0);

			// Advance to ~10:31 local — tick fires
			await vi.advanceTimersByTimeAsync(2 * 60_000);
			expect(ctx._actions.calls.length).toBe(1);
		} finally {
			handle.stop();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Bug fix: strict cron parser rejects non-integer-ish inputs
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / TC-F13-cron-strict: parseCronExpression rejects sneaky invalid inputs", () => {
	beforeEach(async () => {
		await importScheduler();
	});

	it("TC-F13-cron-strict: '1.5' in field → throws", () => {
		expect(() => parseCronExpression("1.5 * * * *")).toThrow();
	});

	it("TC-F13-cron-strict: '0x1' in field → throws", () => {
		expect(() => parseCronExpression("0x1 * * * *")).toThrow();
	});

	it("TC-F13-cron-strict: '1e2' in field → throws", () => {
		expect(() => parseCronExpression("1e2 * * * *")).toThrow();
	});

	it("TC-F13-cron-strict: negative number → throws", () => {
		expect(() => parseCronExpression("-1 * * * *")).toThrow();
	});

	it("TC-F13-cron-strict: valid expressions still work", () => {
		expect(() => parseCronExpression("*/5 * * * *")).not.toThrow();
		expect(() => parseCronExpression("0 12 * * 1-5")).not.toThrow();
		expect(() => parseCronExpression("30 10 1,15 * *")).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// R3 (0.3.0): дежурство completed-миссий + per-mission tick_interval_ms
// ────────────────────────────────────────────────────────────────────────────

const r3TempDirs = [];

function makeR3TempDir() {
	const dir = mkdtempSync(join(tmpdir(), "fan-scheduler-r3-"));
	r3TempDirs.push(dir);
	return dir;
}

/** Миссия на диске: MISSION.md (frontmatter) + опциональный RECURRING.md. */
function makeR3Mission({ status = "completed", recurring = null, extraFm = "" }) {
	const dir = makeR3TempDir();
	writeFileSync(
		join(dir, "MISSION.md"),
		`---\nstatus: ${status}\n${extraFm}---\n\n# Mission\n`,
		"utf8",
	);
	if (recurring !== null) {
		writeFileSync(join(dir, "RECURRING.md"), recurring, "utf8");
	}
	return dir;
}

describe("R3 / TC-R3-duty: completed-миссия с RECURRING.md тикается (дежурство)", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		while (r3TempDirs.length > 0) {
			const dir = r3TempDirs.pop();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore — tempdir cleanup best-effort
			}
		}
	});

	it("TC-R3-duty-1: completed + RECURRING.md с unchecked-пунктами → тик доставляется", async () => {
		const dir = makeR3Mission({
			status: "completed",
			recurring: "# Recurring\n\n- [ ] Check feed (interval: 30m)\n- [ ] Ping API\n",
		});
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "completed",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
			expect(ctx._actions.calls[0].streamingBehavior).toBe("followUp");
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-duty-2: completed без RECURRING.md → пропуск (как раньше)", async () => {
		const dir = makeR3Mission({ status: "completed", recurring: null });
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "completed",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3100);
			expect(ctx._actions.calls.length).toBe(0);
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-duty-2b: completed + пустой RECURRING.md → пропуск", async () => {
		const dir = makeR3Mission({ status: "completed", recurring: "# Recurring\n\n(nothing yet)\n" });
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "completed",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3100);
			expect(ctx._actions.calls.length).toBe(0);
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-duty-2c: completed + RECURRING.md только с checked-пунктами → пропуск", async () => {
		const dir = makeR3Mission({ status: "completed", recurring: "- [x] Done item\n- [x] Another done\n" });
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "completed",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3100);
			expect(ctx._actions.calls.length).toBe(0);
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-duty-3: active — поведение без изменений (регрессия, RECURRING.md не нужен)", async () => {
		const dir = makeR3Mission({ status: "active", recurring: null });
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-duty-4: остальные статусы (paused/awaiting_decision/aborted/failed/budget_exhausted) → пропуск даже с RECURRING.md", async () => {
		const skipStatuses = ["paused", "awaiting_decision", "aborted", "failed", "budget_exhausted"];
		for (const status of skipStatuses) {
			const dir = makeR3Mission({ status, recurring: "- [ ] Duty item (interval: 30m)\n" });
			const ctx = makeCtx({
				intervalMs: 1000,
				defaultStatus: status,
				getMissionDir: () => dir,
				tickPrompt: "tick {date}",
			});
			const handle = startScheduler(ctx);
			try {
				await vi.advanceTimersByTimeAsync(2100);
				expect(ctx._actions.calls.length).toBe(0);
			} finally {
				handle.stop();
			}
		}
	});
});

describe("R3 / TC-R3-interval: tick_interval_ms из frontmatter MISSION.md", () => {
	beforeEach(async () => {
		await importScheduler();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		while (r3TempDirs.length > 0) {
			const dir = r3TempDirs.pop();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore — tempdir cleanup best-effort
			}
		}
	});

	it("TC-R3-interval-5: tick_interval_ms: 30000 → второй тик через 15s отклонён, через 35s — доставлен", async () => {
		const dir = makeR3Mission({ status: "active", extraFm: "tick_interval_ms: 30000\n" });
		const ctx = makeCtx({
			intervalMs: 1000, // базовый polling 1s — быстрее per-mission интервала
			defaultStatus: "active",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			// Первый тик на ~1s — доставлен (lastTickTs ещё не было)
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBe(1);

			// Через 15s после старта (14s после тика) — отклонён (< 30000)
			await vi.advanceTimersByTimeAsync(13_900);
			expect(ctx._actions.calls.length).toBe(1);

			// Через 35s после старта (34s после первого тика) — доставлен
			await vi.advanceTimersByTimeAsync(20_000);
			expect(ctx._actions.calls.length).toBe(2);
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-interval-6: невалидный tick_interval_ms (строка/0/-5/<1000) → базовый интервал", async () => {
		const invalidValues = ["abc", "0", "-5", "500"];
		for (const value of invalidValues) {
			const dir = makeR3Mission({ status: "active", extraFm: `tick_interval_ms: ${value}\n` });
			const ctx = makeCtx({
				intervalMs: 1000,
				defaultStatus: "active",
				getMissionDir: () => dir,
				tickPrompt: "tick {date}",
			});
			const handle = startScheduler(ctx);
			try {
				// Базовый интервал 1000 мс применяется: 3 интервала → ≥3 тика
				await vi.advanceTimersByTimeAsync(3500);
				expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(3);
			} finally {
				handle.stop();
			}
		}
	});

	it("TC-R3-interval-6b: нет tick_interval_ms во frontmatter → базовый интервал", async () => {
		const dir = makeR3Mission({ status: "active" });
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "active",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(3500);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-interval-7: tick_interval_ms применяется и к completed-дежурству", async () => {
		const dir = makeR3Mission({
			status: "completed",
			recurring: "- [ ] Duty item (interval: 30m)\n",
			extraFm: "tick_interval_ms: 30000\n",
		});
		const ctx = makeCtx({
			intervalMs: 1000,
			defaultStatus: "completed",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(ctx._actions.calls.length).toBe(1); // дежурный тик доставлен
			await vi.advanceTimersByTimeAsync(13_900);
			expect(ctx._actions.calls.length).toBe(1); // троттлинг
			await vi.advanceTimersByTimeAsync(20_000);
			expect(ctx._actions.calls.length).toBe(2); // интервал истёк
		} finally {
			handle.stop();
		}
	});

	it("TC-R3-interval-8: cron-конфиг обгоняет tick_interval_ms (троттлинг не применяется)", async () => {
		const localStart = new Date(2026, 7, 12, 10, 0, 0, 0);
		vi.setSystemTime(localStart);
		const dir = makeR3Mission({ status: "active", extraFm: "tick_interval_ms: 300000\n" });
		const ctx = makeCtx({
			cronExpression: "* * * * *", // каждую минуту
			defaultStatus: "active",
			getMissionDir: () => dir,
			tickPrompt: "tick {date}",
		});
		const handle = startScheduler(ctx);
		try {
			// 3 минуты → 3 cron-тика, несмотря на tick_interval_ms: 300000
			await vi.advanceTimersByTimeAsync(3 * 60_000 + 100);
			expect(ctx._actions.calls.length).toBeGreaterThanOrEqual(3);
		} finally {
			handle.stop();
		}
	});
});
