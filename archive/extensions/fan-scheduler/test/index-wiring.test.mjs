// F-13: Расширение fan-scheduler — entry-point (index.ts) wiring — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-13
// Спека (I4): docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.3
//
// Контракт entry-point (для Green):
//   export function wireScheduler(fan, opts?): { start, stop }
//     — тестируемый wiring. opts: intervalMs?, cronExpression?, tickPrompt?,
//       getStatus?, getMissionDir?.
//       start() вызывает startScheduler с:
//         actions.sendMessage = (text, behavior) =>
//           fan.sendUserMessage(text, { deliverAs: behavior })
//         getStatus     = opts.getStatus     ?? (() => "active")
//         getMissionDir = opts.getMissionDir ?? (() => "")
//         intervalMs    = opts.intervalMs
//         cronExpression = opts.cronExpression
//         tickPrompt    = opts.tickPrompt
//       stop() останавливает планировщик (идемпотентен).
//   export default function(fan): void
//     — фабрика расширения: session_start → start, session_shutdown → stop
//       через fan.on(...).
//
// Тайминги: используется РЕАЛЬНЫЙ startScheduler (не мокается) под
// vi.useFakeTimers() — стабильно по образцу scheduler.test.mjs. Короткий
// intervalMs (5 мс) + vi.advanceTimersByTimeAsync.
//
// ────────────────────────────────────────────────────────────────────────────
// Этап 0 (Red): модуль `extensions/fan-scheduler/index.ts` ещё не существует →
// динамический import в beforeAll выбрасывает ERR_MODULE_NOT_FOUND, try/catch
// глушит его, символы (wireScheduler, factory) остаются undefined. Каждый it
// падает индивидуально на вызове undefined-функции (правильный TDD Red: тесты
// запускаются и падают, а не «файл не загрузился»). Существующие тесты
// scheduler.test.mjs НЕ затронуты — отдельный файл, импортирует scheduler.js.
// ────────────────────────────────────────────────────────────────────────────

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Динамический import SUT (index.ts → index.js через Vite-резолв .js→.ts).
// На Red-фазе модуля нет → ERR_MODULE_NOT_FOUND → catch → символы undefined.
// ────────────────────────────────────────────────────────────────────────────

let wireScheduler;
let factory;

beforeAll(async () => {
	try {
		const mod = await import("../index.js");
		wireScheduler = mod.wireScheduler;
		factory = mod.default;
	} catch {
		// Red: index.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Mock fan-объект (минимальный): on() записывает хуки в Map (чтобы тест мог их
// эмитировать через _emit), sendUserMessage — vi.fn() для assertions.
// ────────────────────────────────────────────────────────────────────────────

function makeMockFan() {
	const hooks = new Map();
	const on = vi.fn((event, handler) => {
		hooks.set(event, handler);
	});
	const sendUserMessage = vi.fn();
	return {
		on,
		sendUserMessage,
		_hooks: hooks,
		/** Эмит событие: вызывает зарегистрированный хук и await-ит его. */
		async _emit(event, ...args) {
			const handler = hooks.get(event);
			if (handler) {
				await handler(...args);
			}
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Cleanup: гарантированный стоп запущенных wiring-ов + возврат к real timers.
// stop() идемпотентен — повторный вызов безопасен. vi.useRealTimers() также
// очищает все pending fake-таймеры (страховка от утечек между тестами).
// ────────────────────────────────────────────────────────────────────────────

const liveWirings = [];

afterEach(async () => {
	while (liveWirings.length > 0) {
		const w = liveWirings.pop();
		try {
			await w.stop();
		} catch {
			// ignore — тест уже упал или планировщик уже остановлен
		}
	}
	vi.useRealTimers();
});

// ────────────────────────────────────────────────────────────────────────────
// TC-1: factory(fan) — фабрика не бросает, регистрирует хуки session_start и
// session_shutdown через fan.on(...).
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / index-wiring: фабрика (default export)", () => {
	it("factory(fan) не бросает и регистрирует session_start и session_shutdown", () => {
		const fan = makeMockFan();
		expect(() => factory(fan)).not.toThrow();

		expect(fan.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(fan.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-2..6: wireScheduler — РЕАЛЬНЫЙ startScheduler (не мокается) под fake timers.
// Короткий intervalMs (5 мс) + vi.advanceTimersByTimeAsync — стабильно.
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / index-wiring: wireScheduler — реальный планировщик", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	it("TC-2: wireScheduler(fan,{intervalMs:5}).start() → через 20 мс sendUserMessage вызван ≥1 раза с {deliverAs:'followUp'}", async () => {
		const fan = makeMockFan();
		const wiring = wireScheduler(fan, { intervalMs: 5 });
		liveWirings.push(wiring);

		await wiring.start();
		await vi.advanceTimersByTimeAsync(20);

		expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(fan.sendUserMessage).toHaveBeenCalledWith(
			expect.any(String),
			{ deliverAs: "followUp" },
		);
	});

	it("TC-3: stop() останавливает — после stop вызовы sendUserMessage прекращаются", async () => {
		const fan = makeMockFan();
		const wiring = wireScheduler(fan, { intervalMs: 5 });
		liveWirings.push(wiring);

		await wiring.start();
		await vi.advanceTimersByTimeAsync(20);
		const before = fan.sendUserMessage.mock.calls.length;
		expect(before).toBeGreaterThanOrEqual(1);

		await wiring.stop();
		await vi.advanceTimersByTimeAsync(50);
		const after = fan.sendUserMessage.mock.calls.length;
		expect(after).toBe(before); // никаких новых вызовов
	});

	it("TC-4: кастомный tickPrompt передаётся в sendUserMessage", async () => {
		const fan = makeMockFan();
		const wiring = wireScheduler(fan, {
			intervalMs: 5,
			tickPrompt: "CUSTOM-TICK {missionDir}",
		});
		liveWirings.push(wiring);

		await wiring.start();
		await vi.advanceTimersByTimeAsync(20);

		expect(fan.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("CUSTOM-TICK"),
			{ deliverAs: "followUp" },
		);
	});

	it("TC-5: getStatus:()=>'paused' → тики НЕ идут (sendUserMessage не вызывается)", async () => {
		const fan = makeMockFan();
		const wiring = wireScheduler(fan, {
			intervalMs: 5,
			getStatus: () => "paused",
		});
		liveWirings.push(wiring);

		await wiring.start();
		await vi.advanceTimersByTimeAsync(30);

		expect(fan.sendUserMessage).not.toHaveBeenCalled();
	});

	it("TC-6: getMissionDir подставляется в {missionDir} плейсхолдер tickPrompt", async () => {
		const fan = makeMockFan();
		const wiring = wireScheduler(fan, {
			intervalMs: 5,
			tickPrompt: "DIR={missionDir} DATE={date}",
			getMissionDir: () => "/missions/xyz",
		});
		liveWirings.push(wiring);

		await wiring.start();
		await vi.advanceTimersByTimeAsync(20);

		expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
		const text = fan.sendUserMessage.mock.calls[0][0];
		expect(text).toContain("/missions/xyz");
		expect(text).not.toMatch(/\{missionDir\}/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-7: lifecycle через хуки factory — session_shutdown вызывает stop.
// factory(fan) без opts → дефолтный getStatus через детектор миссий: тики
// идут только при активной миссии в ctx.cwd. Тест готовит tempdir с
// docs/missions/m1/MISSION.md (status: active) и эмитит session_start с
// ctx {cwd}. Чтобы наблюдать тик до стопа — advance на 310000 мс.
// ────────────────────────────────────────────────────────────────────────────

describe("F-13 / index-wiring: lifecycle через хуки factory", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
	});

	it("TC-7: session_shutdown хук вызывает stop — планировщик останавливается", async () => {
		const fan = makeMockFan();
		// Фабрика тикает только при активной миссии в ctx.cwd — готовим tempdir.
		const tmp = mkdtempSync(join(tmpdir(), "fan-scheduler-tc7-"));
		const missionDir = join(tmp, "docs", "missions", "m1");
		mkdirSync(missionDir, { recursive: true });
		writeFileSync(join(missionDir, "MISSION.md"), "---\nstatus: active\n---\n", "utf8");
		try {
			factory(fan);

			// session_start → старт (дефолт intervalMs 60000; getStatus видит active)
			await fan._emit("session_start", { type: "session_start" }, { cwd: tmp });

			// тики на дефолтном интервале (60000 мс → 5 тиков за 310 с)
			await vi.advanceTimersByTimeAsync(310_000);
			expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
			const before = fan.sendUserMessage.mock.calls.length;

			// session_shutdown → стоп
			await fan._emit("session_shutdown", { type: "session_shutdown" });

			// ещё 2 интервала — новых тиков быть не должно
			await vi.advanceTimersByTimeAsync(600_000);
			expect(fan.sendUserMessage.mock.calls.length).toBe(before);
		} finally {
			// Гарантированный стоп, даже если тест упал посередине.
			// stop() идемпотентен — повторный вызов безопасен.
			try {
				await fan._emit("session_shutdown", { type: "session_shutdown" });
			} catch {
				// ignore
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
