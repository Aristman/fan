// F-27: Протокол «пакет работ» (L0 → L1).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-27
// Speка: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2
//
// Пакет работ — самодостаточное задание, которое L0 передаёт дочернему
// узлу L1 через SendMessageRequest (message = JSON.stringify({ work_package: wp }),
// streamingBehavior = "followUp"). Пакет несёт все лимиты и контекст,
// необходимые дочернему узлу для автономной работы.

import { validateManifest } from "./tool-manifest.js";

/** Необязательный контекст, передаваемый дочернему узлу. */
export interface WorkPackageContext {
	parentSummary?: string;
	relevantFiles?: string[];
	constraints?: string[];
}

/** Запись lineage (узел в иерархии от coordinator до родителя).
 *  Pass-through для расширенного SpawnWorkPackage (фаза F-D):
 *  в build-work-package.ts есть собственный LineageEntry, но work-package.ts
 *  остаётся canonical для типа WorkPackage — pass-through тип определён здесь. */
export interface LineageEntry {
	correlationId: string;
	url: string;
	token: string;
	role: "coordinator" | "super-orchestrator" | "orchestrator";
	profile?: string;
}

/** Пакет работ протокола L0 → L1.
 *  Поля после `depth` (role, role_profile, parent_*, lineage) — pass-through
 *  для расширенного SpawnWorkPackage из build-work-package.ts. Они optional:
 *  legacy depth-1 пакеты (createWorkPackage) их не используют; depth>0 пакеты
 *  (buildWorkPackage) несут все поля. parseWorkPackage пробрасывает их как есть. */
export interface WorkPackage {
	task: string;
	/** Формат: <mission-id>/L<N>/node-<M>. */
	correlationId: string;
	depth: number;
	/** NEW (F-D): роль нового узла (super-orchestrator | orchestrator). */
	role?: "super-orchestrator" | "orchestrator";
	/** NEW (F-D): профиль роли. */
	role_profile?: string;
	/** NEW (F-D): correlation id родителя (для обратной связи через ReportChannel). */
	parent_correlation_id?: string;
	/** NEW (F-D): URL родителя (для отправки финального отчёта). */
	parent_url?: string;
	/** NEW (F-D): токен родителя (для аутентификации отчёта). */
	parent_token?: string;
	/** NEW (F-D): idempotency key (по нему родитель ждёт отчёт). */
	parent_report_id?: string;
	/** NEW (F-D): полная lineage от coordinator до parent. */
	lineage?: LineageEntry[];
	/** Дефолт 0. */
	spawnBudget: number;
	tokenBudget: number;
	/** Дефолт 0. */
	costBudgetUsd: number;
	/** Дефолт 2. */
	maxRetries: number;
	/** Дефолт []. */
	toolManifest: string[];
	/** ISO-8601, обязателен (непустая строка). */
	deadline: string;
	verificationCommand?: string;
	context?: WorkPackageContext;
}

/** SendMessageRequest-подобная форма сериализованного пакета. */
export interface SerializedWorkPackage {
	message: string;
	streamingBehavior: "followUp";
}

/** Входящие данные для createWorkPackage (дефолтные поля опциональны). */
export type WorkPackageInput = Omit<WorkPackage, "spawnBudget" | "costBudgetUsd" | "maxRetries" | "toolManifest"> &
	Partial<Pick<WorkPackage, "spawnBudget" | "costBudgetUsd" | "maxRetries" | "toolManifest">>;

/** Ошибка валидации пакета работ. */
export class WorkPackageValidationError extends Error {
	readonly missingFields: string[];
	readonly invalidFields: string[];

	constructor(message: string, missingFields: string[] = [], invalidFields: string[] = []) {
		super(message);
		this.name = "WorkPackageValidationError";
		this.missingFields = missingFields;
		this.invalidFields = invalidFields;
	}
}

/** Формат correlationId: <mission-id>/L<N>/node-<M> (N, M — целые ≥ 0). */
const CORRELATION_ID_PATTERN = /^[^/]+\/L\d+\/node-\d+$/;

/** Charset missionId — тот же, что у граничного валидатора validateCorrelationId
 *  (message-sanitizer, F-38): [A-Za-z0-9._-]+. Синхронизация charset даёт
 *  fail-fast на старте (makeCorrelationId) вместо отказа на границе. */
const MISSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Обязательные поля пакета (без дефолтов). */
const REQUIRED_FIELDS = ["task", "correlationId", "depth", "tokenBudget", "deadline"] as const;

/** Проверка: значение — непустая строка (не whitespace-only). */
const isMissingString = (value: unknown): boolean => typeof value !== "string" || value.trim().length === 0;

/** Проверка: значение — finite number (не NaN). */
const isMissingNumber = (value: unknown): boolean => typeof value !== "number" || Number.isNaN(value);

/** Проверка: значение — finite integer ≥ 0. */
const isValidNonNegativeInteger = (value: unknown): boolean =>
	typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;

/** Проверка: значение — finite number ≥ 0. */
const isValidNonNegativeNumber = (value: unknown): boolean =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Проверка toolManifest (F-37): undefined/[] означает «не ограничен»
 * (дефолт — все инструменты родителя) и валидно; непустые манифесты
 * проверяются validateManifest из tool-manifest (имена из допустимого набора).
 */
const isValidToolManifest = (value: unknown): boolean => {
	if (value === undefined) {
		return true;
	}
	if (Array.isArray(value) && value.length === 0) {
		return true; // [] = «не ограничен» (дефолт)
	}
	try {
		validateManifest(value);
		return true;
	} catch {
		return false;
	}
};

/**
 * Внутренняя валидация полей пакета (используется createWorkPackage и parseWorkPackage).
 * Возвращает { missingFields, invalidFields }.
 */
function validateWorkPackageFields(data: Record<string, unknown>): {
	missingFields: string[];
	invalidFields: string[];
} {
	const missingFields: string[] = [];
	const invalidFields: string[] = [];

	// Строковые обязательные поля: task, correlationId, deadline.
	for (const field of ["task", "correlationId", "deadline"] as const) {
		if (isMissingString(data[field])) {
			missingFields.push(field);
		}
	}

	// Числовые обязательные поля: depth, tokenBudget.
	for (const field of ["depth", "tokenBudget"] as const) {
		if (isMissingNumber(data[field])) {
			missingFields.push(field);
		}
	}

	// Если обязательные поля отсутствуют, дальнейшая семантическая проверка бессмысленна.
	if (missingFields.length > 0) {
		return { missingFields, invalidFields };
	}

	// Семантическая валидация числовых полей (finite, ≥ 0, integer где нужно).
	if (!isValidNonNegativeInteger(data.depth)) {
		invalidFields.push("depth");
	}
	if (!isValidNonNegativeInteger(data.tokenBudget)) {
		invalidFields.push("tokenBudget");
	}

	// Опциональные числовые поля — проверяем только если присутствуют.
	if (data.spawnBudget !== undefined && !isValidNonNegativeInteger(data.spawnBudget)) {
		invalidFields.push("spawnBudget");
	}
	if (data.maxRetries !== undefined && !isValidNonNegativeInteger(data.maxRetries)) {
		invalidFields.push("maxRetries");
	}
	if (data.costBudgetUsd !== undefined && !isValidNonNegativeNumber(data.costBudgetUsd)) {
		invalidFields.push("costBudgetUsd");
	}

	// Формат correlationId.
	if (typeof data.correlationId === "string" && !CORRELATION_ID_PATTERN.test(data.correlationId)) {
		invalidFields.push("correlationId");
	}

	// toolManifest (F-37): [] — «не ограничен» (дефолт), иначе валидация имён.
	if (!isValidToolManifest(data.toolManifest)) {
		invalidFields.push("toolManifest");
	}

	return { missingFields, invalidFields };
}

/**
 * Создаёт валидированный пакет работ, подставляя дефолты
 * (maxRetries=2, spawnBudget=0, costBudgetUsd=0, toolManifest=[]).
 *
 * @throws WorkPackageValidationError — отсутствуют обязательные поля,
 *   невалидные значения или correlationId не соответствует формату.
 */
export function createWorkPackage(input: unknown): WorkPackage {
	// Не-объект / null / undefined → все обязательные поля отсутствуют.
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new WorkPackageValidationError(
			`Work package input must be an object, got ${input === null ? "null" : typeof input}`,
			[...REQUIRED_FIELDS],
		);
	}

	const data = input as Record<string, unknown>;
	const { missingFields, invalidFields } = validateWorkPackageFields(data);

	if (missingFields.length > 0 || invalidFields.length > 0) {
		const parts: string[] = [];
		if (missingFields.length > 0) parts.push(`missing: ${missingFields.join(", ")}`);
		if (invalidFields.length > 0) parts.push(`invalid: ${invalidFields.join(", ")}`);
		throw new WorkPackageValidationError(
			`Work package validation failed — ${parts.join("; ")}`,
			missingFields,
			invalidFields,
		);
	}

	const wp: WorkPackage = {
		task: data.task as string,
		correlationId: data.correlationId as string,
		depth: data.depth as number,
		spawnBudget: (data.spawnBudget as number | undefined) ?? 0,
		tokenBudget: data.tokenBudget as number,
		costBudgetUsd: (data.costBudgetUsd as number | undefined) ?? 0,
		maxRetries: (data.maxRetries as number | undefined) ?? 2,
		toolManifest: (data.toolManifest as string[] | undefined) ?? [],
		deadline: data.deadline as string,
	};
	if (data.verificationCommand !== undefined) {
		wp.verificationCommand = data.verificationCommand as string;
	}
	if (data.context !== undefined) {
		wp.context = data.context as WorkPackageContext;
	}
	return wp;
}

/**
 * Сериализует пакет в SendMessageRequest-форму по спеке §3.3.2:
 * `message = JSON.stringify({ work_package: wp })`.
 */
export function serializeWorkPackage(workPackage: WorkPackage): SerializedWorkPackage {
	return {
		message: JSON.stringify({ work_package: workPackage }),
		streamingBehavior: "followUp",
	};
}

/**
 * Парсит сообщение как пакет работ по спеке §3.3.2.
 * Ожидает `{"work_package": {...}}`, полностью валидирует объект.
 * Не-JSON, не-объекты, массивы, отсутствие work_package или невалидные поля → null.
 */
export function parseWorkPackage(message: string): WorkPackage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const wp = (parsed as Record<string, unknown>).work_package;
	if (typeof wp !== "object" || wp === null || Array.isArray(wp)) {
		return null;
	}

	const { missingFields, invalidFields } = validateWorkPackageFields(wp as Record<string, unknown>);
	if (missingFields.length > 0 || invalidFields.length > 0) {
		return null;
	}

	// Все поля валидны — конструируем WorkPackage с дефолтами.
	const data = wp as Record<string, unknown>;
	const result: WorkPackage = {
		task: data.task as string,
		correlationId: data.correlationId as string,
		depth: data.depth as number,
		spawnBudget: (data.spawnBudget as number | undefined) ?? 0,
		tokenBudget: data.tokenBudget as number,
		costBudgetUsd: (data.costBudgetUsd as number | undefined) ?? 0,
		maxRetries: (data.maxRetries as number | undefined) ?? 2,
		toolManifest: (data.toolManifest as string[] | undefined) ?? [],
		deadline: data.deadline as string,
	};
	if (data.verificationCommand !== undefined) {
		result.verificationCommand = data.verificationCommand as string;
	}
	if (data.context !== undefined) {
		result.context = data.context as WorkPackageContext;
	}
	// Pass-through расширенных полей (F-D): role / role_profile / parent_* / lineage.
	// Эти поля optional — legacy depth-1 пакеты их не несут; depth>0 пакеты
	// (созданные через buildWorkPackage) несут все. parseWorkPackage не теряет ничего,
	// что прислал дочерний узел, и не задаёт default'ов.
	if (data.role !== undefined) {
		result.role = data.role as "super-orchestrator" | "orchestrator";
	}
	if (data.role_profile !== undefined) {
		result.role_profile = data.role_profile as string;
	}
	if (data.parent_correlation_id !== undefined) {
		result.parent_correlation_id = data.parent_correlation_id as string;
	}
	if (data.parent_url !== undefined) {
		result.parent_url = data.parent_url as string;
	}
	if (data.parent_token !== undefined) {
		result.parent_token = data.parent_token as string;
	}
	if (data.parent_report_id !== undefined) {
		result.parent_report_id = data.parent_report_id as string;
	}
	if (data.lineage !== undefined) {
		result.lineage = data.lineage as LineageEntry[];
	}
	return result;
}

/** Строит CLI-флаг инструментов: "--tools read,write" или "" для пустого manifest. */
export function buildToolFlag(manifest: readonly string[]): string {
	if (manifest.length === 0) {
		return "";
	}
	return `--tools ${manifest.join(",")}`;
}

/**
 * Строит argv-массив для spawn: `["--tools", "read,write,edit,bash"]`.
 * Безопасно для child_process.spawn (каждый элемент — отдельный argv).
 * НЕ для shell-конкатенации — используйте buildToolFlag для строкового флага.
 */
export function buildToolArgs(manifest: readonly string[]): string[] {
	if (manifest.length === 0) {
		return [];
	}
	return ["--tools", manifest.join(",")];
}

/**
 * Собирает correlationId: <missionId>/L<depth>/node-<node>.
 *
 * @throws WorkPackageValidationError — missionId не строка безопасного charset
 *   [A-Za-z0-9._-]+ (тот же charset, что у validateCorrelationId на границе),
 *   depth/node не finite integer ≥ 0.
 */
export function makeCorrelationId(missionId: string, depth: number, node: number): string {
	const invalidFields: string[] = [];
	if (typeof missionId !== "string" || !MISSION_ID_PATTERN.test(missionId)) {
		invalidFields.push("missionId");
	}
	if (!isValidNonNegativeInteger(depth)) {
		invalidFields.push("depth");
	}
	if (!isValidNonNegativeInteger(node)) {
		invalidFields.push("node");
	}
	if (invalidFields.length > 0) {
		throw new WorkPackageValidationError(
			`Invalid makeCorrelationId arguments: ${invalidFields.join(", ")}`,
			[],
			invalidFields,
		);
	}
	return `${missionId}/L${depth}/node-${node}`;
}
