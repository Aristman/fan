// F-16: Promise tag parser — чистая функция, извлекающая тег терминального
// состояния (<promise>...</promise>) из ответа агента.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-16
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.4

export type PromiseTag = "COMPLETE" | "BLOCKED" | "DECIDE" | "FAILED";

export interface PromiseParseResult {
	tag: PromiseTag;
	reason?: string;
}

// База — regex из спеки §3.2.4, с двумя минимальными уточнениями под контракт
// тестов (TC-F16-3 / EDGE):
//  1. `(?<!\S)` — тег валиден только в начале текста или после whitespace,
//     иначе `<<promise>...` и `"<promise>..."` матчились бы с внутренней позиции;
//  2. причина берётся как `[^<]*`, а не `[^\n<]+`: структура тега остаётся
//     строгой (`</promise>` сразу после), но `BLOCKED:` с пустой причиной
//     (`BLOCKED:\n...`) даёт reason «не указана» вместо null.
const PROMISE_TAG_RE = /(?<!\S)<promise>(COMPLETE|BLOCKED|DECIDE|FAILED)(?::([^<]*))?<\/promise>/g;

// Fenced code blocks (``` ... ```) удаляются вместе с содержимым: теги внутри
// кода не являются обещаниями.
const FENCED_BLOCK_RE = /```[\s\S]*?```/g;

/** Удаляет из текста все fenced code blocks (``` ... ```). Переиспользуется в аудите (F-18). */
export function stripCodeBlocks(text: string): string {
	return text.replace(FENCED_BLOCK_RE, "");
}

/**
 * Извлекает тег обещания из ответа агента. Правила (спека §3.2.4):
 * теги внутри fenced code blocks игнорируются; при нескольких тегах
 * возвращается последний валидный; `BLOCKED` без причины → «не указана»;
 * нет тега / невалидный тип → null. Чистая функция: вход не мутируется.
 */
export function parsePromise(response: string): PromiseParseResult | null {
	let result: PromiseParseResult | null = null;

	for (const match of stripCodeBlocks(response).matchAll(PROMISE_TAG_RE)) {
		const tag = match[1] as PromiseTag;
		const rawReason = match[2];
		const reason = rawReason === undefined ? "" : rawReason.split("\n", 1)[0];

		const parsed: PromiseParseResult = { tag };
		if (reason !== "") {
			parsed.reason = reason;
		} else if (tag === "BLOCKED") {
			parsed.reason = "не указана";
		}
		result = parsed; // итерируем все матчи: побеждает последний валидный
	}

	return result;
}
