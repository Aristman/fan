// F-14 (ТИКЕТ-14): auto-tick мост — обработчик события "mission_tick".
//
// fan-scheduler эмитит "mission_tick" в EventBus (fan.events); этот модуль
// программно вызывает MissionLoop.tick() без LLM-промпта. Все guard-ы
// тихие (без throw): EventBus вызывает handler вне контролируемого стека.
//
// Guards:
//   1. Replay-guard — EventBus РЕПЛЕИТ последнее событие новому подписчику
//      (event-bus.ts): события с ts <= armedAt (момент подписки) игнорируются.
//   2. Dedupe — повторная доставка того же tickId игнорируется.
//   3. Нет активного loop → игнор (+ log).
//   4. Чужой missionDir (задан в событии и не совпадает с текущим) → игнор.
//   5. tick() вызывается DETACHED: "Lock is busy" — штатная ситуация (log),
//      прочие ошибки — console.error. Handler возвращает undefined сразу.

import type { MissionLoop } from "./mission-loop.js";

/** Пейлоад события "mission_tick" (все поля опциональны для handler-а). */
export interface MissionTickEvent {
	missionDir?: string;
	ts?: number;
	tickId?: string;
}

export interface TickBridgeDeps {
	getLoop(): MissionLoop | null;
	getMissionDir(): string | undefined;
	now?: () => number;
	log?: (msg: string) => void;
}

export interface TickBridgeHandle {
	handler: (data: unknown) => void;
	dispose(): void;
}

/**
 * Создаёт handler для fan.events.on("mission_tick", handler) и dispose().
 * После dispose() handler игнорирует все события (no-op флаг).
 */
export function createMissionTickHandler(deps: TickBridgeDeps): TickBridgeHandle {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? (() => {});
	const armedAt = now();
	let lastTickId: string | undefined;
	let disposed = false;

	const handler = (data: unknown): void => {
		if (disposed) {
			return;
		}
		if (data === null || typeof data !== "object") {
			return; // мусорный пейлоад — тихий игнор
		}
		const ev = data as MissionTickEvent;

		// 1. Replay-guard: реплейнутое EventBus событие старше подписки.
		if (typeof ev.ts === "number" && ev.ts <= armedAt) {
			return;
		}

		// 2. Dedupe по tickId.
		if (typeof ev.tickId === "string") {
			if (ev.tickId === lastTickId) {
				return;
			}
			lastTickId = ev.tickId;
		}

		// 3. Нет активного loop — тикать нечего.
		const loop = deps.getLoop();
		if (!loop) {
			log("[fan-mission] tick-bridge: mission_tick ignored — no active loop");
			return;
		}

		// 4. Событие адресовано другой миссии.
		if (typeof ev.missionDir === "string" && ev.missionDir !== deps.getMissionDir()) {
			return;
		}

		// 5. Detached tick: handler не ждёт завершения и всегда возвращает void.
		void loop.tick().catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("Lock is busy")) {
				// Штатная ситуация: предыдущий тик ещё выполняется.
				log("[fan-mission] tick-bridge: tick skipped — lock is busy");
			} else {
				console.error("[fan-mission] tick-bridge: loop.tick() failed:", err);
			}
		});
	};

	return {
		handler,
		dispose(): void {
			disposed = true;
		},
	};
}
