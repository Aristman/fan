// F-26 + F-38: Sanitizer межагентных сообщений.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-26
// Карточка: docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-38
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
//
// F-38 «Полная санитизация границ»: помимо clean() модуль валидирует ВСЕ
// межагентные сообщения по схеме (чистые функции, вход не мутируется):
//   • validateReport — схема отчёта узла (F-28): обязательные nodeId,
//     correlationId, status, usage; необязательные verdict/result/children
//     (рекурсия по children защищена от циклов (WeakSet) и переполнения
//     стека (лимит глубины 12, как HARD_DEPTH_LIMIT в depth-width-guard) —
//     цикл/превышение → validation error на поле children, НЕ краш);
//   • validateCorrelationId — формат <mission-id>/L<N>/node-<M>;
//   • validateDepth — согласованность: depth ребёнка = depth родителя + 1;
//   • validateWorkPackageSchema — схема пакета работ (F-27) с подробной
//     диагностикой (в отличие от parseWorkPackage, возвращающего null молча).
// Все валидаторы возвращают ValidationResult { valid, errors: [{field,
// message}] }; невалидные сообщения отклоняются с диагностикой, готовой
// для записи validation_failed в tree-journal (F-32).

import { validateManifest } from "./tool-manifest.js";

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

// ─── F-38: валидация схем межагентных сообщений ────────────────────────────

/** Одна ошибка валидации: поле + человекочитаемая диагностика. */
export interface ValidationIssue {
	field: string;
	message: string;
}

/** Результат валидации границы: флаг + список ошибок с диагностикой. */
export interface ValidationResult {
	valid: boolean;
	errors: ValidationIssue[];
}

/** Допустимые статусы отчёта узла (контракт NodeReport из node-report.ts). */
const REPORT_STATUSES = ["completed", "failed", "aborted", "timeout", "unknown"] as const;

/** Формат correlationId: <mission-id>/L<N>/node-<M> (N, M — целые ≥ 0).
 *
 *  Charset mission-сегмента намеренно строгий ([A-Za-z0-9._-]): граничный
 *  валидатор обязан отклонять служебные маркеры (например "[FILTERED]"),
 *  которые может содержать correlationId, пропущенный через clean(). */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]+\/L\d+\/node-\d+$/;

/** Проверка: значение — непустая строка (не whitespace-only). */
const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/** Проверка: значение — finite integer ≥ 0. */
const isNonNegativeInteger = (value: unknown): boolean =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Проверка: значение — finite number ≥ 0. */
const isNonNegativeNumber = (value: unknown): boolean =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** true для plain-объектов (не null, не массив). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Проверяет формат correlationId: `<mission-id>/L<N>/node-<M>`
 * (mission — непустой сегмент безопасного charset, N и M — целые ≥ 0,
 * ровно три сегмента).
 */
export function validateCorrelationId(id: unknown): ValidationResult {
	if (typeof id !== "string" || id.length === 0) {
		return {
			valid: false,
			errors: [{ field: "correlationId", message: "correlationId is required and must be a non-empty string" }],
		};
	}
	if (!CORRELATION_ID_PATTERN.test(id)) {
		return {
			valid: false,
			errors: [
				{
					field: "correlationId",
					message:
						"correlationId must match format <mission-id>/L<N>/node-<M> (mission non-empty, N and M integers >= 0)",
				},
			],
		};
	}
	return { valid: true, errors: [] };
}

/**
 * Проверяет согласованность глубин: depth ребёнка обязан быть равен
 * depth родителя + 1; обе глубины — целые ≥ 0 (NaN/Infinity/дроби/отрицательные
 * отклоняются). Диагностика содержит ожидаемую и фактическую глубину.
 */
export function validateDepth(parentDepth: number, childDepth: number): ValidationResult {
	const errors: ValidationIssue[] = [];
	const parentOk = isNonNegativeInteger(parentDepth);
	const childOk = isNonNegativeInteger(childDepth);
	if (!parentOk) {
		errors.push({ field: "parentDepth", message: `parentDepth must be an integer >= 0, got ${parentDepth}` });
	}
	if (!childOk) {
		errors.push({ field: "childDepth", message: `childDepth must be an integer >= 0, got ${childDepth}` });
	}
	if (parentOk && childOk && childDepth !== parentDepth + 1) {
		errors.push({
			field: "childDepth",
			message: `depth mismatch: expected child depth ${parentDepth + 1} (parent depth + 1), got ${childDepth}`,
		});
	}
	return { valid: errors.length === 0, errors };
}

/** Валидация поля usage отчёта: объект с неотрицательными finite-числами;
 *  отдельные метрики (inputTokens/outputTokens/costUsd) необязательны. */
function validateReportUsage(usage: unknown): ValidationIssue[] {
	if (!isPlainObject(usage)) {
		return [{ field: "usage", message: "usage is required and must be an object" }];
	}
	const errors: ValidationIssue[] = [];
	for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
		const value = usage[key];
		if (value === undefined) {
			continue; // поля usage необязательны (partial → валиден)
		}
		if (!isNonNegativeNumber(value)) {
			errors.push({ field: "usage", message: `usage.${key} must be a finite number >= 0` });
		}
	}
	return errors;
}

/** Максимальная глубина вложенности children в отчёте (как HARD_DEPTH_LIMIT
 *  в depth-width-guard, F-36). Превышение — validation error, НЕ краш:
 *  отчёт — недоверенный ввод, глубокая вложенность не должна ронять узел. */
const MAX_REPORT_DEPTH = 12;

/**
 * Валидирует схему отчёта узла (F-28). Обязательные поля: nodeId
 * (непустая строка), correlationId (формат <mission-id>/L<N>/node-<M>),
 * status (completed/failed/aborted/timeout/unknown), usage (объект с
 * неотрицательными числами). Необязательные verdict/result не проверяются;
 * children, если присутствует, — массив валидных отчётов (рекурсивно).
 *
 * Рекурсия по children защищена: WeakSet visited (цикл → ошибка на поле
 * children) + лимит глубины MAX_REPORT_DEPTH (превышение → ошибка). Недоверенный
 * ввод с циклическими/глубокими children отклоняется без stack overflow.
 *
 * Чистая функция: вход не мутируется, повторный вызов детерминирован.
 */
export function validateReport(report: unknown): ValidationResult {
	return validateReportNode(report, 0, new WeakSet());
}

/** Рекурсивное ядро validateReport: depth — глубина узла (корень = 0),
 *  visited — предки текущего узла (детект циклов; снимается при выходе,
 *  поэтому DAG с общими узлами без циклов валиден). */
function validateReportNode(report: unknown, depth: number, visited: WeakSet<object>): ValidationResult {
	if (depth > MAX_REPORT_DEPTH) {
		return {
			valid: false,
			errors: [{ field: "children", message: `children nesting exceeds maximum depth ${MAX_REPORT_DEPTH}` }],
		};
	}
	if (!isPlainObject(report)) {
		return { valid: false, errors: [{ field: "report", message: "report must be an object" }] };
	}
	if (visited.has(report)) {
		return {
			valid: false,
			errors: [{ field: "children", message: "cycle detected in children (report subtree must be a tree)" }],
		};
	}
	visited.add(report);
	const errors: ValidationIssue[] = [];

	if (!isNonEmptyString(report.nodeId)) {
		errors.push({ field: "nodeId", message: "nodeId is required and must be a non-empty string" });
	}

	if (!isNonEmptyString(report.correlationId)) {
		errors.push({
			field: "correlationId",
			message: "correlationId is required and must be a non-empty string",
		});
	} else {
		errors.push(...validateCorrelationId(report.correlationId).errors);
	}

	if (typeof report.status !== "string" || !(REPORT_STATUSES as readonly string[]).includes(report.status)) {
		errors.push({
			field: "status",
			message: `status is required and must be one of: ${REPORT_STATUSES.join(", ")}`,
		});
	}

	errors.push(...validateReportUsage(report.usage));

	if (report.children !== undefined) {
		if (!Array.isArray(report.children)) {
			errors.push({ field: "children", message: "children must be an array of node reports" });
		} else {
			for (let index = 0; index < report.children.length; index += 1) {
				for (const issue of validateReportNode(report.children[index], depth + 1, visited).errors) {
					errors.push({ field: `children[${index}].${issue.field}`, message: issue.message });
				}
			}
		}
	}

	visited.delete(report);
	return { valid: errors.length === 0, errors };
}

/** toolManifest пакета: [] означает «не ограничен» (дефолт, валиден);
 *  непустые манифесты проверяются validateManifest (tool-manifest, F-37). */
function validateToolManifestField(value: unknown): ValidationIssue[] {
	if (Array.isArray(value) && value.length === 0) {
		return []; // [] = «не ограничен» (семантика work-package.ts)
	}
	try {
		validateManifest(value);
		return [];
	} catch (error) {
		return [{ field: "toolManifest", message: error instanceof Error ? error.message : "toolManifest is invalid" }];
	}
}

/**
 * Валидирует схему пакета работ (F-27) с подробной диагностикой по каждому
 * полю. Обязательные поля: task (непустая строка), correlationId (формат
 * <mission-id>/L<N>/node-<M>), depth (integer ≥ 0), tokenBudget (integer ≥ 0),
 * deadline (непустая ISO-8601 строка). Опциональные spawnBudget,
 * costBudgetUsd, maxRetries, toolManifest проверяются только если присутствуют.
 *
 * В отличие от parseWorkPackage (возвращает null молча), возвращает
 * детальную диагностику для записи validation_failed в tree-journal.
 * Чистая функция: вход не мутируется.
 */
export function validateWorkPackageSchema(workPackage: unknown): ValidationResult {
	if (!isPlainObject(workPackage)) {
		return { valid: false, errors: [{ field: "workPackage", message: "work package must be an object" }] };
	}
	const errors: ValidationIssue[] = [];

	if (!isNonEmptyString(workPackage.task)) {
		errors.push({ field: "task", message: "task is required and must be a non-empty string" });
	}

	if (!isNonEmptyString(workPackage.correlationId)) {
		errors.push({
			field: "correlationId",
			message: "correlationId is required and must be a non-empty string",
		});
	} else {
		errors.push(...validateCorrelationId(workPackage.correlationId).errors);
	}

	if (!isNonNegativeInteger(workPackage.depth)) {
		errors.push({ field: "depth", message: "depth is required and must be an integer >= 0" });
	}

	if (!isNonNegativeInteger(workPackage.tokenBudget)) {
		errors.push({ field: "tokenBudget", message: "tokenBudget is required and must be an integer >= 0" });
	}

	if (!isNonEmptyString(workPackage.deadline)) {
		errors.push({
			field: "deadline",
			message: "deadline is required and must be a non-empty ISO-8601 string",
		});
	}

	if (workPackage.spawnBudget !== undefined && !isNonNegativeInteger(workPackage.spawnBudget)) {
		errors.push({ field: "spawnBudget", message: "spawnBudget must be an integer >= 0" });
	}
	if (workPackage.costBudgetUsd !== undefined && !isNonNegativeNumber(workPackage.costBudgetUsd)) {
		errors.push({ field: "costBudgetUsd", message: "costBudgetUsd must be a finite number >= 0" });
	}
	if (workPackage.maxRetries !== undefined && !isNonNegativeInteger(workPackage.maxRetries)) {
		errors.push({ field: "maxRetries", message: "maxRetries must be an integer >= 0" });
	}
	if (workPackage.toolManifest !== undefined) {
		errors.push(...validateToolManifestField(workPackage.toolManifest));
	}

	return { valid: errors.length === 0, errors };
}
