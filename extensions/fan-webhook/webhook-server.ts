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

// ─── Запуск/остановка сервера ────────────────────────────────────────────────

/**
 * Запуск webhook-сервера на указанном порту.
 *
 * - port не задан → дефолт 9090; port=0 → ephemeral (handle.port вернёт реальный).
 * - Порт занят → Promise reject (EADDRINUSE).
 * - Возвращаемый stop() идемпотентен и освобождает порт.
 */
export async function startWebhookServer(ctx: WebhookCtx): Promise<WebhookServerHandle> {
	const port = ctx.port ?? DEFAULT_WEBHOOK_PORT;
	const app = createWebhookApp(ctx.actions);

	const server: Server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

	// Ждём реального bind: при конфликте порта Node эмитит 'error' (EADDRINUSE).
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			server.removeListener("listening", onListening);
			server.removeListener("error", onError);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		server.on("listening", onListening);
		server.on("error", onError);
	});

	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;

	let stopped = false;
	const stop = (): Promise<void> => {
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

	return { stop, port: actualPort };
}
