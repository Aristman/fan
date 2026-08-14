// F-14: Расширение fan-webhook — entry-point (wiring).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
// Спека (I2/I3): docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Контракт:
//   export default webhookExtension(fan) — фабрика расширения: регистрирует
//     session_start (старт сервера, ошибки глотаются + console.warn) и
//     session_shutdown (стоп) через fan.on(...).
//   export wireWebhook(fan, opts?) — тестируемый wiring: { start, stop }.
//     start() → startWebhookServer (actions.sendMessage → fan.sendUserMessage
//     с deliverAs), возвращает handle { port } (фактически занятый порт).
//     stop() идемпотентен, безопасен без start().
//
// Авто-подбор порта:
//   opts.port задан → передаётся в startWebhookServer как ctx.port (число).
//   env FAN_WEBHOOK_PORT задан → Number(env) передаётся как ctx.port.
//   Ни opts, ни env → ctx.port = undefined → авто-подбор (скан 9090–9110).

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

import type { WebhookServerHandle } from "./types.js";
import { startWebhookServer } from "./webhook-server.js";

export interface WebhookWireOptions {
	/** Порт для bind. Число → явный порт (EADDRINUSE → reject). Не задан → авто-подбор (скан 9090–9110). */
	port?: number;
}

export interface WebhookWiring {
	/** Запускает сервер и возвращает handle. Ошибки (EADDRINUSE) пробрасывает. */
	start: () => Promise<WebhookServerHandle | null>;
	/** Останавливает сервер. Идемпотентен; безопасен, если start() не вызывался. */
	stop: () => Promise<void>;
}

export function wireWebhook(fan: ExtensionAPI, opts?: WebhookWireOptions): WebhookWiring {
	let handle: WebhookServerHandle | null = null;

	// Определяем, был ли порт задан явно (opts или env).
	// Валидация env: не-число / NaN / вне диапазона 0–65535 → fallback на авто-скан.
	const envPortRaw = process.env.FAN_WEBHOOK_PORT;
	const envPort = envPortRaw !== undefined && envPortRaw !== "" ? Number(envPortRaw) : undefined;
	const envPortValid = envPort !== undefined && Number.isFinite(envPort) && envPort >= 0 && envPort <= 65535;
	if (envPortRaw && !envPortValid) {
		console.warn(`[fan-webhook] invalid FAN_WEBHOOK_PORT "${envPortRaw}", falling back to auto-scan`);
	}
	const explicitPort = opts?.port ?? (envPortValid ? envPort : undefined);

	const start = async (): Promise<WebhookServerHandle | null> => {
		if (handle) {
			return handle;
		}
		handle = await startWebhookServer({
			actions: {
				sendMessage: (text, behavior) => fan.sendUserMessage(text, { deliverAs: behavior }),
			},
			// explicitPort === undefined → авто-подбор; число → одна попытка.
			port: explicitPort,
		});
		return handle;
	};

	const stop = async (): Promise<void> => {
		const current = handle;
		handle = null;
		if (current) {
			await current.stop();
		}
	};

	return { start, stop };
}

export default function webhookExtension(fan: ExtensionAPI): WebhookWiring {
	const wiring = wireWebhook(fan);

	fan.on("session_start", async () => {
		try {
			await wiring.start();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Hint про FAN_WEBHOOK_PORT показываем только при явно заданном порте
			// (авто-подбор сам решает проблему EADDRINUSE сканом диапазона).
			const hint = /EADDRINUSE|in use/i.test(msg)
				? " Port занят — освободите его или задайте другой через FAN_WEBHOOK_PORT=<порт>."
				: "";
			console.warn(`[fan-webhook] failed to start webhook server:${hint}`, err);
		}
	});

	fan.on("session_shutdown", async () => {
		await wiring.stop();
	});

	return wiring;
}
