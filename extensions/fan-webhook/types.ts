// F-14: Общие типы расширения fan-webhook.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
// Спека (I2/I3): docs/specs/spec_super-orchestrator_v3_2026-08-10.md

/** Поддерживаемые типы событий вебхука (I2: steer, I3: followUp). */
export type WebhookStreamingBehavior = "steer" | "followUp";

/** Действия, доступные обработчику вебхука (DI-интерфейс). */
export interface WebhookActions {
	sendMessage(text: string, streamingBehavior: WebhookStreamingBehavior): void | Promise<void>;
}

/** Контекст для запуска webhook-сервера. */
export interface WebhookCtx {
	actions: WebhookActions;
	/** Порт для bind.
	 *  - Число (включая 0) → ровно одна попытка (EADDRINUSE → reject).
	 *  - undefined → авто-подбор: скан DEFAULT_WEBHOOK_PORT .. +_scanMax.
	 */
	port?: number;

	// ── Внутренние параметры для тестов (не публичный API) ──────────────
	/** Начальный порт диапазона авто-подбора (дефолт DEFAULT_WEBHOOK_PORT). */
	_scanStart?: number;
	/** Максимальное количество попыток в диапазоне (дефолт 21). */
	_scanMax?: number;
}

/** Handle запущенного webhook-сервера. */
export interface WebhookServerHandle {
	/** Останавливает сервер и освобождает порт. Идемпотентен. */
	stop: () => Promise<void>;
	/** Фактически занятый порт (для port=0 — назначенный OS). */
	port: number;
}
