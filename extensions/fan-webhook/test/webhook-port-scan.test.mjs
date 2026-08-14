// F-14: Тесты авто-подбора порта (множество экземпляров fan, EADDRINUSE).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
//
// Контракт авто-подбора:
//   ctx.port === undefined → скан _scanStart .. _scanStart + _scanMax - 1.
//   ctx.port задан (число) → ровно одна попытка bind.
//   port=0 → ephemeral (OS назначает).
//
// Тесты используют _scanStart / _scanMax для изоляции (высокие порты 19500+),
// чтобы не конфликтовать с запущенным у пользователя fan.

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";

import { startWebhookServer } from "../webhook-server.js";

// ─── DI-хелперы ──────────────────────────────────────────────────────────────

function makeActions() {
	const calls = [];
	return {
		calls,
		sendMessage(text, streamingBehavior) {
			calls.push({ text, streamingBehavior });
		},
	};
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const cleanupFns = [];

afterEach(async () => {
	while (cleanupFns.length > 0) {
		const fn = cleanupFns.pop();
		try {
			await fn();
		} catch {
			// ignore
		}
	}
});

function trackHandle(handle) {
	cleanupFns.push(() => handle.stop());
	return handle;
}

/** Запустить raw TCP-сервер на порту (занимает порт для EADDRINUSE). */
function occupyPort(port) {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(port, "127.0.0.1", () => {
			cleanupFns.push(
				() =>
					new Promise((res) => {
						srv.close(() => res());
					}),
			);
			resolve(srv);
		});
	});
}

// ─── HTTP-хелперы ────────────────────────────────────────────────────────────

async function postWebhook(port, body) {
	const url = `http://127.0.0.1:${port}/webhook`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, body: json };
}

async function getHealth(port) {
	const url = `http://127.0.0.1:${port}/health`;
	const res = await fetch(url);
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, body: json };
}

// ─── Константы для тестов (высокие порты, не конфликтуют с 9090) ─────────────

const SCAN_START = 19500;
const SCAN_MAX = 5; // узкий диапазон для скорости тестов

// ─── Тесты ───────────────────────────────────────────────────────────────────

describe("F-14 / port-scan: авто-подбор", () => {
	it("первый сервер получает scanStart, второй — scanStart+1, оба health 200", async () => {
		const h1 = trackHandle(
			await startWebhookServer({
				actions: makeActions(),
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		);
		expect(h1.port).toBe(SCAN_START);

		const h2 = trackHandle(
			await startWebhookServer({
				actions: makeActions(),
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		);
		expect(h2.port).toBe(SCAN_START + 1);
		expect(h2.port).not.toBe(h1.port);

		// Оба сервера отвечают health 200
		const r1 = await getHealth(h1.port);
		const r2 = await getHealth(h2.port);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
	});

	it("явно заданный занятый порт → reject EADDRINUSE", async () => {
		const h1 = trackHandle(
			await startWebhookServer({
				actions: makeActions(),
				port: SCAN_START,
			}),
		);
		expect(h1.port).toBe(SCAN_START);

		// Второй сервер на том же явном порту → reject
		await expect(
			startWebhookServer({
				actions: makeActions(),
				port: SCAN_START,
			}),
		).rejects.toThrow();
	});

	it("все порты диапазона заняты → reject", async () => {
		// Занимаем все порты диапазона TCP-серверами
		for (let i = 0; i < SCAN_MAX; i++) {
			await occupyPort(SCAN_START + i);
		}

		await expect(
			startWebhookServer({
				actions: makeActions(),
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		).rejects.toThrow(/all ports.*in use/i);
	});

	it("port=0 ephemeral: два сервера → разные реальные порты", async () => {
		const h1 = trackHandle(
			await startWebhookServer({ actions: makeActions(), port: 0 }),
		);
		const h2 = trackHandle(
			await startWebhookServer({ actions: makeActions(), port: 0 }),
		);
		expect(h1.port).toBeGreaterThan(0);
		expect(h2.port).toBeGreaterThan(0);
		expect(h1.port).not.toBe(h2.port);
	});

	it("stop() освобождает авто-подобранный порт — повторный старт получает тот же", async () => {
		const h1 = trackHandle(
			await startWebhookServer({
				actions: makeActions(),
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		);
		const freedPort = h1.port;

		// Останавливаем — порт освобождается
		await h1.stop();

		// Повторный старт — должен получить тот же порт (он первый в скане)
		const h2 = trackHandle(
			await startWebhookServer({
				actions: makeActions(),
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		);
		expect(h2.port).toBe(freedPort);
	});

	it("авто-подбор пропускает занятый scanStart и берёт следующий свободный", async () => {
		// Занимаем scanStart
		await occupyPort(SCAN_START);

		const h = trackHandle(
			await startWebhookServer({
				actions: makeActions(),
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		);
		expect(h.port).toBe(SCAN_START + 1);

		// Сервер работает
		const r = await getHealth(h.port);
		expect(r.status).toBe(200);
	});

	it("POST /webhook работает на авто-подобранном порту", async () => {
		const actions = makeActions();
		const h = trackHandle(
			await startWebhookServer({
				actions,
				_scanStart: SCAN_START,
				_scanMax: SCAN_MAX,
			}),
		);

		const r = await postWebhook(h.port, { type: "steer", message: "auto-port" });
		expect(r.status).toBe(200);
		expect(actions.calls).toHaveLength(1);
		expect(actions.calls[0]).toEqual({ text: "auto-port", streamingBehavior: "steer" });
	});
});
