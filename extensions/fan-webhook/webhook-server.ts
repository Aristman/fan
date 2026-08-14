// F-14: Расширение fan-webhook — слушатель вебхуков (микро-Hono сервер).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
// Спека (I2/I3): docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Контракт: startWebhookServer(ctx) → { stop(), port }.
//   POST /webhook  { type: "steer" | "followUp", message: string }
//     → actions.sendMessage(message, type); 200 { ok: true } при успехе.
//     400 — unknown type / отсутствует type / отсутствует message / невалидный JSON.
//     500 — actions.sendMessage throws/rejects.
//   GET /health → 200 { status: "ok" }.
//
// Авто-подбор порта (множество экземпляров fan):
//   ctx.port === undefined → скан: _scanStart (дефолт 9090), +1, +2, ... до
//     +_scanMax-1 (дефолт 21 попытка, 9090–9110). EADDRINUSE → следующая попытка;
//     все заняты → reject. Прочие ошибки bind → reject сразу.
//   ctx.port задан (число, включая 0) → ровно одна попытка bind (как раньше).
//   handle.port всегда = фактический порт (server.address().port).
//
// Жизненный цикл: onSessionStart → startWebhookServer(ctx) → порт слушается;
// onSessionShutdown → handle.stop() → порт освобождён. stop() идемпотентен.

import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { routeWebhookEvent } from "./event-router.js";
import type { WebhookActions, WebhookCtx, WebhookServerHandle } from "./types.js";

// Re-export types for backward compatibility (consumers may have imported
// from webhook-server.js before the refactor).
export type {
	WebhookActions,
	WebhookCtx,
	WebhookServerHandle,
	WebhookStreamingBehavior,
} from "./types.js";

export const DEFAULT_WEBHOOK_PORT = 9090;

/** Максимальное количество попыток авто-подбора (9090..9110 = 21 порт). */
const DEFAULT_SCAN_MAX = 21;

// ─── Hono-приложение ─────────────────────────────────────────────────────────

function createWebhookApp(actions: WebhookActions): Hono {
	const app = new Hono();

	app.post("/webhook", async (c) => {
		// 1. Парсинг JSON-тела: невалидный JSON → 400
		let body: unknown;
		try {
			const text = await c.req.text();
			body = JSON.parse(text);
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		// 2. Маршрутизация события через event-router
		try {
			await routeWebhookEvent(body, actions);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			// Ошибки валидации (из event-router) → 400.
			// Ошибки actions.sendMessage (проброшенные) → 500.
			const validationErrors = new Set([
				"Invalid JSON",
				"Missing 'type'",
				"Unknown event type",
				"Missing 'message'",
			]);

			if (validationErrors.has(message)) {
				return c.json({ error: message }, 400);
			}

			console.error("[fan-webhook] actions.sendMessage failed:", err);
			return c.json({ error: message }, 500);
		}

		return c.json({ ok: true }, 200);
	});

	app.get("/health", (c) => c.json({ status: "ok" }, 200));

	// Fallback для непредвиденных ошибок внутри Hono (неизвестные маршруты
	// отдают дефолтный 404 Hono).
	app.onError((err, c) => {
		console.error("[fan-webhook] unhandled error:", err);
		return c.json({ error: err.message || "Internal Server Error" }, 500);
	});

	return app;
}

// ─── Внутренний хелпер: bind сервера на конкретном порту ─────────────────────

interface BindResult {
	server: Server;
	port: number;
}

/**
 * Пытается bind-ить Hono-сервер на указанный порт.
 * - Успех → resolve { server, port (фактический из server.address()) }.
 * - Ошибка → reject (EADDRINUSE и прочие — без различия, решение принимает
 *   вызывающий код).
 */
function bindServer(app: Hono, port: number): Promise<BindResult> {
	return new Promise<BindResult>((resolve, reject) => {
		const server: Server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

		const cleanup = () => {
			server.removeListener("listening", onListening);
			server.removeListener("error", onError);
		};
		const onListening = () => {
			cleanup();
			const address = server.address();
			const actualPort = typeof address === "object" && address !== null ? address.port : port;
			resolve({ server, port: actualPort });
		};
		const onError = (err: Error) => {
			cleanup();
			// server.close() не нужен — bind не удался, сервер не слушает.
			reject(err);
		};
		server.on("listening", onListening);
		server.on("error", onError);
	});
}

// ─── Stop-хелпер ──────────────────────────────────────────────────────────────

function makeStop(server: Server): () => Promise<void> {
	let stopped = false;
	return (): Promise<void> => {
		if (stopped) {
			return Promise.resolve();
		}
		stopped = true;
		return new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
			// Иначе close() будет ждать, пока keep-alive клиенты закроют
			// idle-соединения (fetch-пул undici держит их открытыми).
			server.closeIdleConnections?.();
		});
	};
}

// ─── Запуск/остановка сервера ────────────────────────────────────────────────

/**
 * Запуск webhook-сервера.
 *
 * - ctx.port задан (число, включая 0) → одна попытка bind; EADDRINUSE → reject.
 * - ctx.port === undefined → авто-подбор: скан от _scanStart (дефолт 9090)
 *   до _scanStart + _scanMax - 1 (дефолт 21 попытка). EADDRINUSE → следующий;
 *   все заняты → reject с понятным сообщением. Прочие ошибки → reject сразу.
 *   Если выбран порт ≠ _scanStart → console.log.
 * - handle.port = фактический порт (server.address().port).
 * - stop() идемпотентен и освобождает порт.
 */
export async function startWebhookServer(ctx: WebhookCtx): Promise<WebhookServerHandle> {
	const app = createWebhookApp(ctx.actions);

	// ── Explicit port (число, включая 0) — одна попытка ──────────────────
	if (ctx.port !== undefined) {
		const { server, port } = await bindServer(app, ctx.port);
		return { stop: makeStop(server), port };
	}

	// ── Авто-подбор (port === undefined) — скан диапазона ────────────────
	const scanStart = ctx._scanStart ?? DEFAULT_WEBHOOK_PORT;
	const scanMax = ctx._scanMax ?? DEFAULT_SCAN_MAX;

	let lastError: Error | null = null;

	for (let i = 0; i < scanMax; i++) {
		const candidate = scanStart + i;
		try {
			const { server, port } = await bindServer(app, candidate);
			if (port !== scanStart) {
				console.log(`[fan-webhook] port ${scanStart} busy, listening on ${port}`);
			}
			return { stop: makeStop(server), port };
		} catch (err) {
			const isAddrInUse = err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE";
			if (!isAddrInUse) {
				// Прочие ошибки (EACCES, etc.) — reject сразу.
				throw err;
			}
			lastError = err as Error;
			// EADDRINUSE → пробуем следующий порт.
		}
	}

	// Все порты диапазона заняты.
	const rangeEnd = scanStart + scanMax - 1;
	const msg =
		`[fan-webhook] all ports ${scanStart}–${rangeEnd} are in use. ` +
		"Free a port or set an explicit one via FAN_WEBHOOK_PORT=<port>.";
	const err = new Error(msg);
	(err as NodeJS.ErrnoException).code = "EADDRINUSE";
	if (lastError) {
		err.cause = lastError;
	}
	throw err;
}
