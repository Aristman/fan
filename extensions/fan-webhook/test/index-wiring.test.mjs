// F-14: Расширение fan-webhook — entry-point (index.ts) wiring — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
// Спека (I2/I3): docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Контракт entry-point (для Green):
//   export default function(fan): void
//     — фабрика расширения: регистрирует хуки session_start (старт сервера) и
//       session_shutdown (стоп) через fan.on(...).
//   export function wireWebhook(fan, opts?): { start, stop, getServer }
//     — тестируемая функция wiring.
//       opts.port? (дефолт 9090; 0 → ephemeral).
//       start() вызывает startWebhookServer с actions.sendMessage = (text, behavior)
//         => fan.sendUserMessage(text, { deliverAs: behavior }).
//       stop() останавливает сервер (идемпотентен).
//       Возвращает handle { start, stop, getServer }.
//       start() возвращает { port, ... } (фактически занятый порт).
//
// Интеграционные тесты: используется РЕАЛЬНЫЙ startWebhookServer (не мокается)
// с port:0 (ephemeral). HTTP-запросы через node fetch на 127.0.0.1:<port>/webhook.
//
// ────────────────────────────────────────────────────────────────────────────
// Этап 0 (Red): модуль `extensions/fan-webhook/index.ts` ещё не существует →
// динамический import в beforeAll выбрасывает ERR_MODULE_NOT_FOUND, try/catch
// глушит его, символы (wireWebhook, factory) остаются undefined. Каждый it
// падает ИНДИВИДУАЛЬНО на вызове undefined-функции (правильный TDD Red: тесты
// запускаются и падают, а не «файл не загрузился»). Существующие тесты
// webhook-server.test.mjs НЕ затронуты — отдельный файл, импортирует уже
// реализованный webhook-server.js.
// ────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ────────────────────────────────────────────────────────────────────────────
// Динамический import SUT (index.ts → index.js через Vite-резолв .js→.ts).
// На Red-фазе модуля нет → ERR_MODULE_NOT_FOUND → catch → символы undefined.
// ────────────────────────────────────────────────────────────────────────────

let wireWebhook;
let factory;

beforeAll(async () => {
	try {
		const mod = await import("../index.js");
		wireWebhook = mod.wireWebhook;
		factory = mod.default;
	} catch {
		// Red: index.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Mock fan-объект (минимальный): on() записывает хуки в Map (чтобы тест мог их
// эмитировать через _emit), sendUserMessage — vi.fn() для assertions.
// Достаточно методов on и sendUserMessage; остальные не нужны.
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
// HTTP-хелперы (копия паттерна из webhook-server.test.mjs).
// ────────────────────────────────────────────────────────────────────────────

async function readBody(res) {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function postWebhook(port, body) {
	const url = `http://127.0.0.1:${port}/webhook`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	return { status: res.status, body: await readBody(res) };
}

// ────────────────────────────────────────────────────────────────────────────
// Cleanup: гарантированный стоп запущенных wiring-ов, чтобы не утекали порты.
// stop() идемпотентен, поэтому повторный вызов в afterEach безопасен.
// ────────────────────────────────────────────────────────────────────────────

const liveWirings = [];

afterEach(async () => {
	while (liveWirings.length > 0) {
		const w = liveWirings.pop();
		try {
			await w.stop();
		} catch {
			// ignore — тест уже упал или сервер уже остановлен
		}
	}
});

// ────────────────────────────────────────────────────────────────────────────
// TC-1: factory(fan) — фабрика не бросает, регистрирует хуки session_start и
// session_shutdown через fan.on(...).
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / index-wiring: фабрика (default export)", () => {
	it("factory(fan) не бросает и регистрирует хуки session_start и session_shutdown", () => {
		const fan = makeMockFan();
		expect(() => factory(fan)).not.toThrow();

		expect(fan.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(fan.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-2..5: wireWebhook — РЕАЛЬНЫЙ сервер на ephemeral порту (port:0).
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / index-wiring: wireWebhook — реальный сервер", () => {
	it("wireWebhook(fan, {port:0}).start() стартует сервер и возвращает {port} с port > 0", async () => {
		const fan = makeMockFan();
		const wiring = wireWebhook(fan, { port: 0 });
		liveWirings.push(wiring);

		const handle = await wiring.start();
		expect(handle).toBeDefined();
		expect(typeof handle.port).toBe("number");
		expect(handle.port).toBeGreaterThan(0);
	});

	it("POST {type:'steer', message:'test msg'} → fan.sendUserMessage('test msg', {deliverAs:'steer'})", async () => {
		const fan = makeMockFan();
		const wiring = wireWebhook(fan, { port: 0 });
		liveWirings.push(wiring);

		const handle = await wiring.start();
		const res = await postWebhook(handle.port, {
			type: "steer",
			message: "test msg",
		});
		expect(res.status).toBe(200);
		expect(fan.sendUserMessage).toHaveBeenCalledWith("test msg", { deliverAs: "steer" });
	});

	it("POST {type:'followUp', message:'fu'} → fan.sendUserMessage('fu', {deliverAs:'followUp'})", async () => {
		const fan = makeMockFan();
		const wiring = wireWebhook(fan, { port: 0 });
		liveWirings.push(wiring);

		const handle = await wiring.start();
		const res = await postWebhook(handle.port, {
			type: "followUp",
			message: "fu",
		});
		expect(res.status).toBe(200);
		expect(fan.sendUserMessage).toHaveBeenCalledWith("fu", { deliverAs: "followUp" });
	});

	it("stop() останавливает сервер — повторный POST не проходит (порт закрыт)", async () => {
		const fan = makeMockFan();
		const wiring = wireWebhook(fan, { port: 0 });
		liveWirings.push(wiring);

		const handle = await wiring.start();
		// До stop — сервер отвечает 200
		const ok = await postWebhook(handle.port, { type: "steer", message: "before stop" });
		expect(ok.status).toBe(200);

		await wiring.stop();

		// После stop — порт закрыт, запрос падает (ECONNREFUSED)
		await expect(
			postWebhook(handle.port, { type: "steer", message: "after stop" }),
		).rejects.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-6: wireWebhook без opts — дефолтный порт 9090 передаётся в startWebhookServer
// (проверяется через port, возвращённый start()). Если 9090 занят внешним
// процессом — тест пропускается gracefully.
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / index-wiring: дефолтный порт 9090", () => {
	it("wireWebhook(fan) без opts → start() возвращает port === 9090", async () => {
		const fan = makeMockFan();
		const wiring = wireWebhook(fan); // без opts → дефолт 9090
		liveWirings.push(wiring);

		let handle;
		try {
			handle = await wiring.start();
		} catch {
			// Порт 9090 занят внешним процессом — пропускаем gracefully.
			return;
		}

		expect(handle.port).toBe(9090);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-7: session_shutdown хук вызывает stop — сервер останавливается.
// Сценарий: factory(fan) → emit session_start (старт на 9090) → POST работает →
// emit session_shutdown (стоп) → POST не проходит. Если 9090 занят — skip.
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / index-wiring: lifecycle через хуки factory", () => {
	it("session_shutdown хук вызывает stop — сервер останавливается", async () => {
		const fan = makeMockFan();
		// factory регистрирует session_start (старт) и session_shutdown (стоп)
		factory(fan);

		try {
			// session_start → старт сервера (дефолтный порт 9090)
			try {
				await fan._emit(
					"session_start",
					{ type: "session_start", reason: "startup" },
					{ hasUI: false },
				);
			} catch {
				// 9090 занят внешним процессом — пропускаем gracefully
				return;
			}

			// Сервер работает: POST /webhook доходит, ответ 200
			const up = await postWebhook(9090, { type: "steer", message: "lifecycle up" });
			expect(up.status).toBe(200);

			// session_shutdown → стоп сервера
			await fan._emit("session_shutdown", { type: "session_shutdown" });

			// Порт закрыт: повторный POST не проходит (ECONNREFUSED)
			await expect(
				postWebhook(9090, { type: "steer", message: "after shutdown" }),
			).rejects.toThrow();
		} finally {
			// Гарантированный стоп, чтобы не утекал порт 9090, даже если тест
			// упал посреди сценария. stop() идемпотентен — повторный вызов безопасен.
			try {
				await fan._emit("session_shutdown", { type: "session_shutdown" });
			} catch {
				// ignore
			}
		}
	});
});
