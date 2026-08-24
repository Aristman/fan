// F-14: Маршрутизация событий вебхука — отдельный модуль для расширяемости.
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-14
// Спека (I2/I3): docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Контракт:
//   routeWebhookEvent(body, actions) → Promise<void>
//   - Парсит и валидирует тело запроса.
//   - Диспетчеризирует на actions.sendMessage(message, type).
//   - Бросает ошибки с понятными сообщениями для маппинга в HTTP-коды.
//
// Ошибки (бросает routeWebhookEvent):
//   "Invalid JSON"         — тело не является валидным JSON-объектом.
//   "Missing 'type'"       — отсутствует поле type.
//   "Unknown event type"   — type не входит в список поддерживаемых.
//   "Missing 'message'"    — отсутствует или не строка поле message.
//
// Ошибки actions.sendMessage пробрасываются как есть (для маппинга в 500).

import type { WebhookActions, WebhookStreamingBehavior } from "./types.js";

/** Список допустимых типов событий (расширяется при добавлении новых Ix). */
const WEBHOOK_EVENT_TYPES: readonly WebhookStreamingBehavior[] = ["steer", "followUp"];

function isWebhookEventType(value: unknown): value is WebhookStreamingBehavior {
	return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Маршрутизирует одно webhook-событие.
 *
 * @param body — распарсенное тело HTTP-запроса (или сырой текст/объект).
 * @param actions — DI-интерфейс для доставки сообщения.
 * @throws {Error} с сообщением из контракта при невалидном входе.
 * @throws пробрасывает ошибки actions.sendMessage без обёртки.
 */
export async function routeWebhookEvent(body: unknown, actions: WebhookActions): Promise<void> {
	// 1. Валидация структуры: тело должно быть plain-объектом
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new Error("Invalid JSON");
	}

	const payload = body as { type?: unknown; message?: unknown };

	// 2. Валидация обязательных полей
	if (payload.type === undefined || payload.type === null) {
		throw new Error("Missing 'type'");
	}
	if (!isWebhookEventType(payload.type)) {
		throw new Error("Unknown event type");
	}
	if (typeof payload.message !== "string") {
		throw new Error("Missing 'message'");
	}

	// 3. Доставка сообщения (ошибки sendMessage пробрасываются)
	await actions.sendMessage(payload.message, payload.type);
}
