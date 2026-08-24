// F-14: Расширение fan-webhook (слушатель вебхуков) — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
// Спека (I2/I3):  docs/specs/spec_super-orchestrator_v3_2026-08-10.md
// Паттерн расширения: packages/coding-agent/examples/extensions/file-trigger.ts
//                      (onSessionStart/onSessionShutdown)
// Hono HTTP:       packages/api-gateway/src/http-server.ts
// DI-стиль тестов: extensions/fan-mission/test/mission-loop.test.mjs,
//                  extensions/fan-scheduler/test/scheduler.test.mjs
//
// ────────────────────────────────────────────────────────────────────────────
// Контракт API (по карточке F-14 + спека I2/I3):
//
//   function startWebhookServer(ctx: WebhookCtx): Promise<{
//     stop: () => Promise<void>;
//     port: number;          // фактически занятый порт (для тестов: 0 → ephemeral)
//   }>
//
//   WebhookCtx (DI для тестов; в проде ctx = ExtensionAPI + конфиг):
//     actions: {
//       sendMessage(text: string, streamingBehavior: "steer" | "followUp")
//         : Promise<void> | void
//     }
//     port?: number          // 0 → ephemeral; не задан → дефолт 9090
//
//   Маршруты (Hono):
//     POST /webhook
//       body: { type: "steer" | "followUp", message: string }
//       200 — успешная доставка
//       400 — unknown type / отсутствует type / отсутствует message /
//             невалидный JSON
//       500 — actions.sendMessage throws/rejects (REST-маппинг ошибки)
//
//     GET /health
//       200 — health-check (для k8s/monitoring)
//
//   Жизненный цикл:
//     1. onSessionStart → startWebhookServer(ctx) → порт слушается
//     2. POST /webhook → actions.sendMessage(text, streamingBehavior)
//     3. onSessionShutdown → handle.stop() → порт освобождён
//
// ────────────────────────────────────────────────────────────────────────────
// Поведение (TC-F14-1..3 + критерии приёмки):
//   1. type="steer"     → sendMessage(message, "steer"),     ответ 200
//   2. type="followUp"  → sendMessage(message, "followUp"),  ответ 200
//   3. type="unknown"   → 400 { error: "Unknown event type" }, sendMessage НЕ вызван
//   4. Без type/message → 400, sendMessage НЕ вызван
//   5. Невалидный JSON  → 400, sendMessage НЕ вызван
//   6. sendMessage throws → 500 (тело ошибки допустимо: {error: "..."} )
//   7. GET /health      → 200
//   8. start → stop     → порт освобождён (повторный bind на тот же порт — успешен)
//   9. port занят       → start rejects/throws
//  10. stop() идемпотентен
//
// ────────────────────────────────────────────────────────────────────────────
// Этап 0 (Red): модуль `extensions/fan-webhook/webhook-server.ts` ещё не
// существует → динамический import падает с ERR_MODULE_NOT_FOUND. Каждый
// it()/describe блок, ожидающий startWebhookServer, fail. Существующие
// тесты (fan-mission/fan-scheduler) — НЕ затронуты (изолированный пакет).
// ────────────────────────────────────────────────────────────────────────────

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
// Все describe-блоки получают свежий import-фейл через beforeEach.
// ────────────────────────────────────────────────────────────────────────────

let startWebhookServer;

async function importWebhookServer() {
	if (!startWebhookServer) {
		const mod = await import("../webhook-server.js");
		startWebhookServer = mod.startWebhookServer;
	}
	return startWebhookServer;
}

// ────────────────────────────────────────────────────────────────────────────
// DI-хелперы: mock-контекст по образцу fan-scheduler/fan-mission.
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-memory actions.sendMessage, логирует все вызовы.
 * streamingBehavior допущения: "steer" | "followUp" (по карточке F-14).
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
 * Полный DI-контекст для webhook-сервера.
 * По умолчанию: port=0 (ephemeral), actions.sendMessage — no-op.
 */
function makeCtx(overrides = {}) {
	const actions = makeMockActions(overrides.actions);
	const ctx = {
		actions,
		port: overrides.port ?? 0,
		...overrides.ctxOverrides,
	};
	// accessor for tests
	ctx._actions = actions;
	return ctx;
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP-хелперы: fetch к запущенному серверу.
// ────────────────────────────────────────────────────────────────────────────

async function readBody(res) {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * POST с JSON-телом на /webhook. body — объект (сериализуется) или строка
 * (отправляется как есть — для негативных тестов на невалидный JSON).
 */
async function postWebhook(port, body, opts = {}) {
	const url = `http://127.0.0.1:${port}/webhook`;
	const init = {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
		body: typeof body === "string" ? body : JSON.stringify(body),
	};
	const res = await fetch(url, init);
	return { status: res.status, body: await readBody(res) };
}

/**
 * GET на произвольный путь (по умолчанию /health).
 */
async function getPath(port, path = "/health") {
	const url = `http://127.0.0.1:${port}${path}`;
	const res = await fetch(url);
	return { status: res.status, body: await readBody(res) };
}

// Стек живых серверов для гарантированной остановки (даже при падении теста).
const liveHandles = [];

afterEach(async () => {
	// Остановить все серверы, которые не были остановлены в try/finally
	while (liveHandles.length > 0) {
		const h = liveHandles.pop();
		try {
			await h.stop();
		} catch {
			// ignore — тест уже упал
		}
	}
});

/**
 * Поднимает сервер и кладёт handle в стек для гарантированной остановки.
 */
async function bootServer(ctx) {
	const handle = await startWebhookServer(ctx);
	liveHandles.push(handle);
	return handle;
}

// ────────────────────────────────────────────────────────────────────────────
// Module structure (smoke tests)
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-module: startWebhookServer API contract", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-module: startWebhookServer экспортируется как функция", () => {
		expect(typeof startWebhookServer).toBe("function");
	});

	it("TC-F14-module: возвращает объект с методом stop() и полем port", async () => {
		const handle = await bootServer(makeCtx());
		expect(handle).toBeDefined();
		expect(typeof handle.stop).toBe("function");
		expect(typeof handle.port).toBe("number");
		expect(handle.port).toBeGreaterThan(0); // 0 → ephemeral, реальный порт > 0
	});

	it("TC-F14-module: startWebhookServer возвращает Promise (async)", () => {
		// Возвращаемое значение — Promise (контракт: async function).
		const ret = startWebhookServer(makeCtx());
		expect(ret).toBeInstanceOf(Promise);
		// Cleanup: дождёмся и остановим
		ret.then((h) => liveHandles.push(h)).catch(() => {});
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F14-1: Вебхук доставляет steer-сообщение (I2)
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-1: steer-событие → sendMessage с streamingBehavior 'steer'", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-1: POST /webhook с type='steer' → sendMessage вызван, ответ 200", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, {
			type: "steer",
			message: "CI failed, fix tests",
		});
		expect(res.status).toBe(200);
		expect(ctx._actions.calls.length).toBe(1);
		expect(ctx._actions.calls[0]).toEqual({
			text: "CI failed, fix tests",
			streamingBehavior: "steer",
		});
	});

	it("TC-F14-1: streamingBehavior строго равен 'steer'", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		await postWebhook(handle.port, { type: "steer", message: "abort build" });
		expect(ctx._actions.calls[0].streamingBehavior).toBe("steer");
		expect(ctx._actions.calls[0].streamingBehavior).not.toBe("followUp");
	});

	it("TC-F14-1: текст message передаётся в sendMessage без модификаций", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const longText =
			"CI failed:\n  - test_webhook_server.test.mjs:42\n  - assertion failed";
		await postWebhook(handle.port, { type: "steer", message: longText });
		expect(ctx._actions.calls[0].text).toBe(longText);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F14-2: Вебхук доставляет followUp-сообщение (I3)
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-2: followUp-событие → sendMessage с streamingBehavior 'followUp'", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-2: POST /webhook с type='followUp' → sendMessage вызван, ответ 200", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, {
			type: "followUp",
			message: "New PR merged",
		});
		expect(res.status).toBe(200);
		expect(ctx._actions.calls.length).toBe(1);
		expect(ctx._actions.calls[0]).toEqual({
			text: "New PR merged",
			streamingBehavior: "followUp",
		});
	});

	it("TC-F14-2: streamingBehavior строго равен 'followUp'", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		await postWebhook(handle.port, { type: "followUp", message: "check status" });
		expect(ctx._actions.calls[0].streamingBehavior).toBe("followUp");
		expect(ctx._actions.calls[0].streamingBehavior).not.toBe("steer");
	});

	it("TC-F14-2: два steer'а + один followUp → порядок и типы сохранены", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		await postWebhook(handle.port, { type: "steer", message: "A" });
		await postWebhook(handle.port, { type: "followUp", message: "B" });
		await postWebhook(handle.port, { type: "steer", message: "C" });
		expect(ctx._actions.calls).toEqual([
			{ text: "A", streamingBehavior: "steer" },
			{ text: "B", streamingBehavior: "followUp" },
			{ text: "C", streamingBehavior: "steer" },
		]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F14-3: Неизвестный тип события → 400
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-3: неизвестный тип события → 400", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-3: type='unknown' → 400 { error: 'Unknown event type' }, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, { type: "unknown" });
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: "Unknown event type" });
		expect(ctx._actions.calls.length).toBe(0);
	});

	it("TC-F14-3: type='bogus' (произвольная строка) → 400", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, { type: "bogus" });
		expect(res.status).toBe(400);
		expect(ctx._actions.calls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 1: missing fields → 400
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-missing-fields: отсутствуют обязательные поля → 400", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-missing-type: нет type в теле → 400, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, { message: "hi" });
		expect(res.status).toBe(400);
		expect(ctx._actions.calls.length).toBe(0);
	});

	it("TC-F14-missing-message: нет message в теле → 400, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, { type: "steer" });
		expect(res.status).toBe(400);
		expect(ctx._actions.calls.length).toBe(0);
	});

	it("TC-F14-empty-body: {} → 400, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, {});
		expect(res.status).toBe(400);
		expect(ctx._actions.calls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 2: invalid JSON → 400
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-invalid-json: невалидный JSON → 400", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-invalid-json: '{not json' → 400, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, "{not json");
		expect(res.status).toBe(400);
		expect(ctx._actions.calls.length).toBe(0);
	});

	it("TC-F14-empty-body: '' (пустое тело) → 400, sendMessage НЕ вызван", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, "");
		expect(res.status).toBe(400);
		expect(ctx._actions.calls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 3: actions.sendMessage throws → 500
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-send-error: actions.sendMessage throws → 500", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-send-error-sync: sendMessage throws sync → 500", async () => {
		const ctx = makeCtx({
			actions: {
				sendMessageImpl() {
					throw new Error("sendMessage exploded");
				},
			},
		});
		const handle = await bootServer(ctx);
		// suppress expected server-side error log
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await postWebhook(handle.port, {
				type: "steer",
				message: "boom",
			});
			expect(res.status).toBe(500);
		} finally {
			errSpy.mockRestore();
		}
	});

	it("TC-F14-send-error-async: sendMessage returns rejected Promise → 500", async () => {
		const ctx = makeCtx({
			actions: {
				sendMessageImpl: async () => {
					throw new Error("sendMessage async exploded");
				},
			},
		});
		const handle = await bootServer(ctx);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await postWebhook(handle.port, {
				type: "followUp",
				message: "boom async",
			});
			expect(res.status).toBe(500);
		} finally {
			errSpy.mockRestore();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 4: GET /health
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-health: GET /health → 200", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-health: GET /health → 200", async () => {
		const handle = await bootServer(makeCtx());
		const res = await getPath(handle.port, "/health");
		expect(res.status).toBe(200);
	});

	it("TC-F14-health: GET /unknown → 404 (маршрут не зарегистрирован)", async () => {
		const handle = await bootServer(makeCtx());
		const res = await getPath(handle.port, "/this-route-does-not-exist");
		expect(res.status).toBe(404);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 5: server lifecycle (start → stop)
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-lifecycle: start → stop → порт освобождён", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-lifecycle: после stop() запросы на тот же порт → ECONNREFUSED", async () => {
		const ctx = makeCtx();
		const handle = await bootServer(ctx);
		const port = handle.port;
		// Сначала сервер работает
		const ok = await postWebhook(port, { type: "steer", message: "hi" });
		expect(ok.status).toBe(200);

		// Останавливаем
		await handle.stop();

		// Теперь порт свободен: повторный запрос должен упасть с ECONNREFUSED
		await expect(
			postWebhook(port, { type: "steer", message: "after stop" }),
		).rejects.toThrow();
	});

	it("TC-F14-stop-idempotent: stop() можно вызывать повторно без падения", async () => {
		const handle = await bootServer(makeCtx());
		await handle.stop();
		await expect(handle.stop()).resolves.toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 6: port in use → start rejects/throws
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-port-conflict: занятый порт → start rejects", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-port-conflict: второй startWebhookServer на занятом порту → reject", async () => {
		// 1) Поднимаем первый сервер на ephemeral-порту
		const handle1 = await bootServer(makeCtx());
		const occupiedPort = handle1.port;

		// 2) Пытаемся поднять второй на том же порту — ожидаем отказ
		await expect(
			startWebhookServer(makeCtx({ port: occupiedPort })),
		).rejects.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case 7: кастомный порт через ctx.port
// ────────────────────────────────────────────────────────────────────────────

describe("F-14 / TC-F14-custom-port: ctx.port управляет занятым портом", () => {
	beforeEach(async () => {
		await importWebhookServer();
	});

	it("TC-F14-custom-port: ctx.port=0 → handle.port = ephemeral (не 0)", async () => {
		const handle = await bootServer(makeCtx({ port: 0 }));
		expect(handle.port).not.toBe(0);
		expect(handle.port).toBeGreaterThan(0);
	});

	it("TC-F14-custom-port: ctx.port=0 → запросы доходят до сервера", async () => {
		const ctx = makeCtx({ port: 0 });
		const handle = await bootServer(ctx);
		const res = await postWebhook(handle.port, {
			type: "steer",
			message: "ephemeral port works",
		});
		expect(res.status).toBe(200);
		expect(ctx._actions.calls.length).toBe(1);
	});
});