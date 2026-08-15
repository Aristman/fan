// F-48.5: EPIC delegation — делегирование [EPIC]-пунктов ROADMAP
// супер-оркестратору через EventBus (request-response мост).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md (F-48.5)
//
// Контракт шага iterate для пункта с маркером [EPIC]:
//   1. runAgent с промптом декомпозиции (рус.) → JSON-массив подзадач
//      [{task, tokenBudget?, toolManifest?}];
//   2. parse + validate (массив непустой, task — непустые строки);
//   3. emit `mission_delegate` { missionDir, correlationId, packages[],
//      replyEvent: "mission_delegate_result:<correlationId>" };
//   4. await ответ на replyEvent с таймаутом (delegationTimeoutMs,
//      default 30 минут; таймер unref);
//   5. результат:
//      • { results[], totalUsage? } → синтез resultText в итоговый ответ
//        итерации с тегом <promise>COMPLETE</promise>; totalUsage
//        учитывается в бюджете итерации (costTokens/costUsd);
//      • { error } → FAILED-итерация с диагностикой (тег <promise>FAILED:…
//        </promise>); пункт уходит в blockers STATE.md;
//   6. ЛЮБАЯ неудача делегирования (декомпозиция не удалась, невалидный/
//      пустой JSON подзадач, нет подписчика, таймаут, ошибка emit) →
//      null ⇒ безопасный fallback на локальный executor.runIteration.
//
// Проверка подписчика: eventBus.listenerCount("mission_delegate") === 0
// (когда API доступен — mock/расширенный EventBus) → fallback БЕЗ emit и без
// ожидания таймаута. Если listenerCount недоступен (production EventBus),
// полагаемся на таймаут-fallback.

import { randomUUID } from "node:crypto";
import type { IterationResult } from "./mission-loop.js";

/** Маркер EPIC-пункта в ROADMAP. */
export const EPIC_MARKER = "[EPIC]";

/** Канал запроса делегирования (mission-loop → super-orchestrator). */
export const DELEGATE_CHANNEL = "mission_delegate";

/** Канал ответа для конкретного correlationId. */
export function delegateResultChannel(correlationId: string): string {
	return `mission_delegate_result:${correlationId}`;
}

/** Таймаут ожидания ответа делегирования по умолчанию (30 минут). */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 30 * 60 * 1000;

/** Минимальный EventBus-контракт для делегирования (production EventBus
 *  совместим структурно; listenerCount опционален — см. шапку модуля). */
export interface EpicEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
	listenerCount?: (channel: string) => number;
}

/** Драйвер декомпозиции (тот же контракт, что RunAgent session-executor). */
export type EpicRunAgent = (
	prompt: string,
	opts?: { cwd?: string; steer?: string },
) => Promise<{ response: string; costTokens?: number; costUsd?: number }>;

/** Подзадача EPIC в составе mission_delegate.packages. */
export interface EpicPackage {
	task: string;
	tokenBudget?: number;
	toolManifest?: string[];
}

/** Исходящее событие mission_delegate. */
export interface MissionDelegateEvent {
	missionDir: string;
	correlationId: string;
	packages: EpicPackage[];
	replyEvent: string;
}

/** Пункт ROADMAP является EPIC (маркер [EPIC] в начале текста). */
export function isEpicItem(itemText: string): boolean {
	return itemText.trimStart().startsWith(EPIC_MARKER);
}

/** Промпт декомпозиции EPIC-пункта (рус.; требует вернуть JSON-массив). */
export function buildDecompositionPrompt(itemText: string): string {
	const epicText = itemText.trimStart().slice(EPIC_MARKER.length).trim();
	return [
		"Декомпозиция EPIC-пункта миссии для делегирования супер-оркестратору.",
		"",
		`EPIC-пункт: ${epicText}`,
		"",
		"Выполни декомпозицию этого эпика на 3-4 независимые подзадачи для параллельного выполнения дочерними узлами.",
		'Верни ТОЛЬКО JSON-массив объектов вида: [{"task": "описание подзадачи", "tokenBudget": 5000, "toolManifest": ["read", "bash"]}].',
		"Поля tokenBudget (бюджет токенов) и toolManifest (допустимые инструменты: read/write/edit/bash/grep/find/ls) опциональны.",
		"Никакого текста кроме JSON-массива не выводи.",
	].join("\n");
}

/**
 * Парсинг и валидация ответа декомпозиции: JSON-массив непустых подзадач
 * ({task: непустая строка, tokenBudget?: число, toolManifest?: string[]}).
 * Невалидный ответ / пустой массив → null (fallback на локальное выполнение).
 */
export function parseEpicSubtasks(response: string): EpicPackage[] | null {
	if (typeof response !== "string") {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.trim());
	} catch {
		// Ответ может содержать пояснения вокруг JSON — пробуем вырезать массив.
		const match = /\[[\s\S]*\]/.exec(response);
		if (match === null) {
			return null;
		}
		try {
			parsed = JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return null;
	}
	const packages: EpicPackage[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return null;
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.task !== "string" || record.task.trim() === "") {
			return null;
		}
		const pkg: EpicPackage = { task: record.task };
		if (typeof record.tokenBudget === "number" && Number.isFinite(record.tokenBudget)) {
			pkg.tokenBudget = record.tokenBudget;
		}
		if (Array.isArray(record.toolManifest) && record.toolManifest.every((t) => typeof t === "string")) {
			pkg.toolManifest = [...record.toolManifest];
		}
		packages.push(pkg);
	}
	return packages;
}

export interface EpicDelegationOptions {
	missionDir: string;
	itemText: string;
	runAgent: EpicRunAgent;
	eventBus: EpicEventBus;
	/** Таймаут ожидания ответа (default 30 минут). */
	timeoutMs?: number;
	cwd?: string;
	steer?: string;
	/** Уведомление о pending-состоянии (cleanup для abort/shutdown либо null). */
	onPendingChange?: (cleanup: (() => void) | null) => void;
}

/** Санитизация причины для тега <promise>FAILED:…</promise> (без "<" и \n). */
function sanitizeTagReason(reason: string): string {
	return reason.replace(/[\r\n<]/g, " ").trim();
}

/** Defense-in-depth (FIX F-48.5): чужие resultText пересекают границу L1→L0.
 *  Основная санитизация — на стороне super-orchestrator (clean() перед
 *  emit); здесь — ЛОКАЛЬНАЯ мини-фильтрация promise-тегов без кросс-импорта
 *  (fan-mission не зависит от fan-super-orchestrator): чужой тег
 *  <promise>FAILED:…</promise> в resultText не должен подменять вердикт L0.
 *  Применяется ДО синтеза: parsePromise вызывается на итоговом тексте, где
 *  единственным валидным тегом обязан быть тег interpretDelegateReply. */
const FOREIGN_PROMISE_TAG_PATTERN = /<\/?promise[^>]*>/gi;

/** Маркер замены вырезанного чужого promise-тега (конвенция message-sanitizer). */
const FILTERED_MARK = "[FILTERED]";

/** Вырезает promise-теги из чужого текста результата (граница L1→L0). */
export function sanitizeDelegateResultText(text: string): string {
	return text.replace(FOREIGN_PROMISE_TAG_PATTERN, FILTERED_MARK);
}

/** FAILED-результат делегирования с диагностикой (promise-тег FAILED). */
function delegationFailed(reason: string, costTokens: number, costUsd: number): IterationResult {
	return {
		status: "FAILED",
		reason,
		response: `<promise>FAILED:${sanitizeTagReason(reason)}</promise>`,
		costTokens,
		costUsd,
	};
}

/**
 * Интерпретация ответа mission_delegate_result:<correlationId>:
 *   • { results[], totalUsage? } → COMPLETE-синтез (resultText объединяются);
 *   • { error } / невалидный ответ → FAILED с диагностикой.
 * Стоимость декомпозиции (costTokens/costUsd) плюс totalUsage ответа
 * суммируются в бюджет итерации.
 */
function interpretDelegateReply(data: unknown, decompositionTokens: number, decompositionUsd: number): IterationResult {
	if (typeof data !== "object" || data === null) {
		return delegationFailed(
			"EPIC delegation: невалидный ответ оркестратора (ожидался объект)",
			decompositionTokens,
			decompositionUsd,
		);
	}
	const reply = data as Record<string, unknown>;
	if (typeof reply.error === "string") {
		return delegationFailed(reply.error, decompositionTokens, decompositionUsd);
	}
	if (!Array.isArray(reply.results)) {
		return delegationFailed(
			"EPIC delegation: невалидный ответ оркестратора (отсутствует results[])",
			decompositionTokens,
			decompositionUsd,
		);
	}

	const parts: string[] = [];
	for (const entry of reply.results) {
		const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
		// FIX F-48.5: чужой resultText фильтруется ДО синтеза (promise-теги
		// вырезаются, иначе теги L1 подменяют вердикт L0 — parsePromise
		// применяется к итоговому синтезу).
		const rawText = typeof record.resultText === "string" ? record.resultText : JSON.stringify(entry);
		parts.push(sanitizeDelegateResultText(rawText));
	}

	let usageTokens = 0;
	let usageUsd = 0;
	if (typeof reply.totalUsage === "object" && reply.totalUsage !== null) {
		const usage = reply.totalUsage as Record<string, unknown>;
		if (typeof usage.tokens === "number" && Number.isFinite(usage.tokens)) {
			usageTokens = usage.tokens;
		}
		if (typeof usage.usd === "number" && Number.isFinite(usage.usd)) {
			usageUsd = usage.usd;
		}
	}

	const synthesis = [
		`EPIC-делегирование: завершено подзадач — ${reply.results.length}.`,
		"",
		...parts.map((text, index) => `${index + 1}. ${text}`),
		"",
		"<promise>COMPLETE</promise>",
	].join("\n");

	return {
		status: "COMPLETE",
		response: synthesis,
		costTokens: decompositionTokens + usageTokens,
		costUsd: decompositionUsd + usageUsd,
	};
}

/**
 * Полный цикл делегирования EPIC-пункта. Возвращает IterationResult
 * (успех-синтез либо FAILED при ответе {error}) или null, когда нужен
 * fallback на локальное выполнение (невалидная декомпозиция, нет подписчика,
 * таймаут, ошибка emit).
 */
export async function runEpicDelegation(opts: EpicDelegationOptions): Promise<IterationResult | null> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;

	// 1. Декомпозиция через runAgent.
	let response: string;
	let costTokens = 0;
	let costUsd = 0;
	try {
		const decomposition = await opts.runAgent(buildDecompositionPrompt(opts.itemText), {
			...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
			...(opts.steer !== undefined ? { steer: opts.steer } : {}),
		});
		response = decomposition.response;
		costTokens = decomposition.costTokens ?? 0;
		costUsd = decomposition.costUsd ?? 0;
	} catch {
		return null; // декомпозиция не удалась → локальный fallback
	}

	// 2. Парсинг/валидация подзадач.
	const packages = parseEpicSubtasks(response);
	if (packages === null) {
		return null; // невалидный/пустой JSON → локальный fallback
	}

	// 3. Проверка подписчика (когда API доступен): нет слушателей
	//    mission_delegate → fallback без emit и без ожидания таймаута.
	if (typeof opts.eventBus.listenerCount === "function" && opts.eventBus.listenerCount(DELEGATE_CHANNEL) === 0) {
		return null;
	}

	// 4. Request-response мост: подписка на replyEvent ДО emit запроса.
	const correlationId = randomUUID();
	const replyEvent = delegateResultChannel(correlationId);

	return await new Promise<IterationResult | null>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;

		const finish = (result: IterationResult | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			try {
				unsubscribe?.();
			} catch {
				// best-effort отписка
			}
			opts.onPendingChange?.(null);
			resolve(result);
		};

		try {
			unsubscribe = opts.eventBus.on(replyEvent, (data) => {
				finish(interpretDelegateReply(data, costTokens, costUsd));
			});
		} catch {
			resolve(null); // подписка невозможна → fallback
			return;
		}
		// cleanup для abort/shutdown: прерывает ожидание и ведёт к fallback.
		opts.onPendingChange?.(() => finish(null));

		timer = setTimeout(() => finish(null), timeoutMs);
		if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
			timer.unref(); // не держать процесс ради таймаута делегирования
		}

		const payload: MissionDelegateEvent = {
			missionDir: opts.missionDir,
			correlationId,
			packages,
			replyEvent,
		};
		try {
			opts.eventBus.emit(DELEGATE_CHANNEL, payload);
		} catch {
			finish(null); // ошибка emit → fallback
		}
	});
}
