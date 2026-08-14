// F-26: Sanitizer межагентных сообщений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-26
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §5.3, §9 (риск №4)
//
// Вывод дочернего узла — недоверенный ввод: перед добавлением в контекст
// родителя он проходит через clean() (чистая синхронная функция):
//
//   1. Prompt-injection паттерны заменяются на маркер "[FILTERED]"
//      (регистронезависимо): "ignore previous instructions",
//      "ignore all previous", "disregard (previous|above|prior) instructions",
//      "system:", "<system>", "</system>", role markers "[SYSTEM]",
//      "You are now", "new instructions:", "forget (everything|your
//      instructions)", инъекции promise-тегов "<promise>", "</promise>".
//   2. Нормальный текст (markdown, код, теги вида <div>) НЕ модифицируется —
//      фильтруются только управляющие последовательности injection.
//   3. Лимит длины: решение об обрезке принимается по длине исходного
//      текста (до фильтрации), чтобы замена паттернов на короткий маркер
//      не маскировала переполнение. Обрезка до maxLength + " [TRUNCATED]".
//   4. Пустая строка → пустая строка.

export interface SanitizerOptions {
	/** Максимальная длина текста в символах (default 10000). */
	maxLength?: number;
}

/** Дефолты санитизации (roadmap §F-26: максимум 10000 символов на отчёт). */
export const DEFAULT_SANITIZER_OPTIONS: Required<SanitizerOptions> = {
	maxLength: 10000,
};

/** Маркер замены injection-паттерна. */
const FILTERED = "[FILTERED]";

/** Суффикс обрезки — с ведущим пробелом: " [TRUNCATED]". */
const TRUNCATED = " [TRUNCATED]";

/** Injection-паттерны (регистронезависимые). Порядок: более специфичные
 *  фразы раньше общих, чтобы замена не разрывала длинный паттерн. */
const INJECTION_PATTERNS: readonly RegExp[] = [
	/ignore all previous instructions/gi,
	/ignore previous instructions/gi,
	/ignore all previous/gi,
	/disregard (previous|above|prior) instructions/gi,
	/forget (everything|your instructions)/gi,
	/new instructions:/gi,
	/you are now/gi,
	/\[SYSTEM\]/gi,
	/<\/?system>/gi,
	/system:/gi,
	/<\/?promise>/gi,
];

/**
 * Санитизировать межагентное сообщение: заменить injection-паттерны на
 * маркер "[FILTERED]", затем обрезать до maxLength с суффиксом
 * " [TRUNCATED]". Решение об обрезке — по длине исходного текста.
 *
 * Чистая функция: вход не мутируется, повторный вызов детерминирован.
 * Пустая строка возвращается как есть.
 */
export function clean(text: string, opts?: SanitizerOptions): string {
	if (text === "") {
		return "";
	}

	const maxLength = opts?.maxLength ?? DEFAULT_SANITIZER_OPTIONS.maxLength;

	// Шаг 1: решение об обрезке принимается по длине исходного текста,
	// чтобы фильтрация не маскировала переполнение (короткий маркер замены
	// может сделать текст короче maxLength).
	const needsTruncation = text.length > maxLength;

	// Шаг 2: фильтрация prompt-injection паттернов.
	let result = text;
	for (const pattern of INJECTION_PATTERNS) {
		result = result.replace(pattern, FILTERED);
	}

	// Шаг 3: обрезка (строго больше — граница maxLength не режется).
	if (needsTruncation || result.length > maxLength) {
		result = result.slice(0, maxLength) + TRUNCATED;
	}

	return result;
}
