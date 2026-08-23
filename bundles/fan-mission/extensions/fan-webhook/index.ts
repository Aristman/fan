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
//   CLI --port <n> (или --port=<n>) задан → Number(arg) передаётся как ctx.port.
//   env FAN_WEBHOOK_PORT задан → Number(env) передаётся как ctx.port.
//   Ничего не задано → ctx.port = undefined → авто-подбор (скан 9090–9110).

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

import type { WebhookServerHandle } from "./types.js";
import { startWebhookServer } from "./webhook-server.js";

export interface WebhookWireOptions {
	/** Порт для bind. Число → явный порт (EADDRINUSE → reject). Не задан → CLI --port / env / авто-подбор. */
	port?: number;
}

/** Валидный TCP-порт: конечное целое 0–65535. */
function isValidPort(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 65535;
}

/**
 * F-0: читает порт из CLI-аргументов процесса (`--port 9095` или `--port=9095`).
 * Невалидное/отсутствующее значение → undefined (fallback на env/авто-подбор).
 */
function readCliPort(argv: string[] = process.argv): number | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		let raw: string | undefined;
		if (arg === "--port") {
			raw = argv[i + 1];
		} else if (arg?.startsWith("--port=")) {
			raw = arg.slice("--port=".length);
		} else {
			continue;
		}
		if (raw === undefined || raw === "") {
			continue;
		}
		const parsed = Number(raw);
		if (isValidPort(parsed)) {
			return parsed;
		}
		console.warn(`[fan-webhook] invalid --port "${raw}", ignoring`);
	}
	return undefined;
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
	const envPortValid = isValidPort(envPort);
	if (envPortRaw && !envPortValid) {
		console.warn(`[fan-webhook] invalid FAN_WEBHOOK_PORT "${envPortRaw}", falling back to auto-scan`);
	}
	// Приоритет: opts.port → CLI --port → env FAN_WEBHOOK_PORT → авто-подбор.
	const cliPort = readCliPort();
	const explicitPort = opts?.port ?? cliPort ?? (envPortValid ? envPort : undefined);

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
