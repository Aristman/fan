// F-13: Расширение fan-scheduler — entry-point (wiring).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-13
// Спека (I4): docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.3
//
// Контракт:
//   export default schedulerExtension(fan) — фабрика расширения: регистрирует
//     session_start (старт планировщика, ошибки глотаются + console.warn) и
//     session_shutdown (стоп) через fan.on(...).
//   export wireScheduler(fan, opts?) — тестируемый wiring: { start, stop }.
//     start() → startScheduler (actions.sendMessage → fan.sendUserMessage с
//     deliverAs), идемпотентен. stop() идемпотентен, безопасен без start().

import type { ExtensionAPI } from "@seaagents/fan-coding-agent";

import type { MissionStatus, SchedulerHandle } from "./scheduler.js";
import { startScheduler } from "./scheduler.js";

export interface SchedulerWireOptions {
	intervalMs?: number;
	cronExpression?: string;
	tickPrompt?: string;
	getStatus?: () => MissionStatus | Promise<MissionStatus>;
	getMissionDir?: () => string;
}

export interface SchedulerWiring {
	/** Запускает планировщик и возвращает handle. Идемпотентен. */
	start: () => SchedulerHandle | null;
	/** Останавливает планировщик. Идемпотентен; безопасен без start(). */
	stop: () => void;
}

export function wireScheduler(fan: ExtensionAPI, opts?: SchedulerWireOptions): SchedulerWiring {
	let handle: SchedulerHandle | null = null;

	const start = (): SchedulerHandle | null => {
		if (handle) {
			return handle; // идемпотентно
		}
		handle = startScheduler({
			actions: {
				sendMessage: (text, behavior) => fan.sendUserMessage(text, { deliverAs: behavior }),
			},
			getStatus: opts?.getStatus ?? (() => "active"),
			getMissionDir: opts?.getMissionDir,
			tickPrompt: opts?.tickPrompt,
			intervalMs: opts?.intervalMs,
			cronExpression: opts?.cronExpression,
		});
		return handle;
	};

	const stop = (): void => {
		const current = handle;
		handle = null;
		if (current) {
			current.stop();
		}
	};

	return { start, stop };
}

export default function schedulerExtension(fan: ExtensionAPI): void {
	const wiring = wireScheduler(fan);

	fan.on("session_start", () => {
		try {
			wiring.start();
		} catch (err) {
			console.warn("[fan-scheduler] failed to start scheduler:", err);
		}
	});

	fan.on("session_shutdown", () => {
		wiring.stop();
	});
}
