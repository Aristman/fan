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

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

import type { WebhookServerHandle } from "./types.js";
import { DEFAULT_WEBHOOK_PORT, startWebhookServer } from "./webhook-server.js";

export interface WebhookWireOptions {
	/** Порт для bind. Дефолт 9090; 0 → ephemeral (OS назначает сама). */
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

	const start = async (): Promise<WebhookServerHandle | null> => {
		if (handle) {
			return handle;
		}
		handle = await startWebhookServer({
			actions: {
				sendMessage: (text, behavior) => fan.sendUserMessage(text, { deliverAs: behavior }),
			},
			port:
				opts?.port ?? (process.env.FAN_WEBHOOK_PORT ? Number(process.env.FAN_WEBHOOK_PORT) : DEFAULT_WEBHOOK_PORT),
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
			console.warn("[fan-webhook] failed to start webhook server:", err);
		}
	});

	fan.on("session_shutdown", async () => {
		await wiring.stop();
	});

	return wiring;
}
