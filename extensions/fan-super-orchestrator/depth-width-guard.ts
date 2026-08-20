// F-25 + F-36: Depth/width guard — ограничители глубины и ширины дерева узлов.
//
// Карточки:
//   • docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-25
//   • docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-36
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2, §5.4
//
// Чистая синхронная функция без состояния: вызывается ПЕРЕД
// processManager.spawn(), чтобы при отказе не блокировать порт и не
// поднимать процесс. Глубина передаётся через env FAN_ORCHESTRATOR_DEPTH,
// ширина — через env FAN_ORCHESTRATOR_WIDTH (счётчик детей родителя).
//
// Порядок проверок фиксирован:
//   1. depth > min(maxWorkingDepth, HARD_DEPTH_LIMIT)
//      → отказ max_depth_exceeded с полями currentDepth/maxDepth
//        (рабочая глубина, F-36; default 4, infra-предохранитель 12);
//   2. depth >= maxDepth → отказ max_depth_exceeded
//        (legacy жёсткий предохранитель; default HARD_DEPTH_LIMIT + 1,
//        т.е. по умолчанию не срабатывает раньше infra-лимита);
//   3. currentChildren >= maxWidth     → отказ max_width_exceeded
//      (предохранитель — жёсткий верх, действует даже при workingWidth выше);
//   4. currentChildren >= workingWidth → отказ max_width_exceeded;
//   5. иначе                           → { allowed: true }.
//
// Семантика границы рабочей глубины (F-36): depth > effectiveMax → отказ,
// depth == effectiveMax → allowed (последний рабочий уровень разрешён).
// effectiveMax = min(maxWorkingDepth, HARD_DEPTH_LIMIT): значения
// maxWorkingDepth выше 12 clamped до infra-предохранителя.
// Валидация конфига: maxWorkingDepth < 2 — вырожденная конфигурация
// (иерархия не работает) → effectiveMax 0, порождение детей запрещено.
// При depth-отказе (рабочем и инфраструктурном) ровно один раз
// вызывается onDepthExceeded; при width-отказе колбэк не вызывается.

/** Инфраструктурный предохранитель глубины: жёсткий предел, не поднимается выше. */
export const HARD_DEPTH_LIMIT = 12;

export interface DepthExceededInfo {
	/** Текущая глубина — сработавший лимит (родитель порождаемого узла). */
	currentDepth: number;
	/** Сработавший лимит глубины. */
	maxDepth: number;
}

export interface DepthWidthGuardOptions {
	/** Legacy жёсткий предел глубины (default HARD_DEPTH_LIMIT + 1):
	 *  отказ при depth >= maxDepth. По умолчанию не срабатывает раньше
	 *  инфраструктурного предохранителя (12). */
	maxDepth?: number;
	/** Предохранитель ширины на родителя — жёсткий верх (default 12). */
	maxWidth?: number;
	/** Рабочая ширина на родителя (default 4). */
	workingWidth?: number;
	/** F-36: рабочая глубина дерева (default 4). Значения > 12 clamped
	 *  до инфраструктурного предохранителя HARD_DEPTH_LIMIT; значения < 2
	 *  считаются вырожденными (effectiveMax = 0 — дети не порождаются). */
	maxWorkingDepth?: number;
	/** F-36: вызывается ровно один раз при каждом depth-отказе
	 *  (рабочем и инфраструктурном); при width-отказе не вызывается. */
	onDepthExceeded?: (info: DepthExceededInfo) => void;
}

export interface SpawnDecision {
	allowed: boolean;
	reason?: "max_depth_exceeded" | "max_width_exceeded";
	/** F-36: при depth-отказе — сработавший лимит (глубина родителя). */
	currentDepth?: number;
	/** F-36: при depth-отказе — сработавший лимит глубины. */
	maxDepth?: number;
}

export const DEFAULT_GUARD: Required<
	Pick<DepthWidthGuardOptions, "maxDepth" | "maxWidth" | "workingWidth" | "maxWorkingDepth">
> = {
	maxDepth: HARD_DEPTH_LIMIT + 1,
	maxWidth: 12,
	workingWidth: 4,
	maxWorkingDepth: 4,
};

/**
 * Разрешить порождение нового узла на глубине `depth` родителем, у которого
 * уже есть `currentChildren` детей. `depth` — глубина, НА КОТОРОЙ будет
 * новый узел (0 = L0). Возвращает решение с причиной отказа либо
 * `{ allowed: true }` без `reason`.
 */
export function canSpawn(depth: number, currentChildren: number, opts?: DepthWidthGuardOptions): SpawnDecision {
	const maxDepth = opts?.maxDepth ?? DEFAULT_GUARD.maxDepth;
	const maxWidth = opts?.maxWidth ?? DEFAULT_GUARD.maxWidth;
	const workingWidth = opts?.workingWidth ?? DEFAULT_GUARD.workingWidth;
	const maxWorkingDepth = opts?.maxWorkingDepth ?? DEFAULT_GUARD.maxWorkingDepth;
	// Валидация конфига: < 2 — вырожденный диапазон (иерархия отключена),
	// > HARD_DEPTH_LIMIT — clamp до infra-предохранителя.
	const effectiveMax = maxWorkingDepth < 2 ? 0 : Math.min(maxWorkingDepth, HARD_DEPTH_LIMIT);

	// 1. Рабочая глубина (F-36): depth == effectiveMax ещё разрешено.
	if (depth > effectiveMax) {
		opts?.onDepthExceeded?.({ currentDepth: effectiveMax, maxDepth: effectiveMax });
		return { allowed: false, reason: "max_depth_exceeded", currentDepth: effectiveMax, maxDepth: effectiveMax };
	}
	// 2. Legacy жёсткий предохранитель (depth >= maxDepth).
	if (depth >= maxDepth) {
		opts?.onDepthExceeded?.({ currentDepth: maxDepth, maxDepth });
		return { allowed: false, reason: "max_depth_exceeded" };
	}
	// 3–4. Ширина: предохранитель, затем рабочая ширина.
	if (currentChildren >= maxWidth || currentChildren >= workingWidth) {
		return { allowed: false, reason: "max_width_exceeded" };
	}
	return { allowed: true };
}

/**
 * Batch-вариант canSpawn: разрешить одновременное порождение `newChildren`
 * детей на глубине `depth`. Пачка из N новых детей допустима, если
 * N <= workingWidth и N <= maxWidth (поштучный guard использует `>=`,
 * потому что currentChildren — уже существующие дети; здесь счётчик —
 * размер порождаемой пачки, поэтому граница — `>`).
 */
export function canSpawnBatch(depth: number, newChildren: number, opts?: DepthWidthGuardOptions): SpawnDecision {
	const maxDepth = opts?.maxDepth ?? DEFAULT_GUARD.maxDepth;
	const maxWidth = opts?.maxWidth ?? DEFAULT_GUARD.maxWidth;
	const workingWidth = opts?.workingWidth ?? DEFAULT_GUARD.workingWidth;
	const maxWorkingDepth = opts?.maxWorkingDepth ?? DEFAULT_GUARD.maxWorkingDepth;
	const effectiveMax = maxWorkingDepth < 2 ? 0 : Math.min(maxWorkingDepth, HARD_DEPTH_LIMIT);

	if (depth > effectiveMax) {
		opts?.onDepthExceeded?.({ currentDepth: effectiveMax, maxDepth: effectiveMax });
		return { allowed: false, reason: "max_depth_exceeded", currentDepth: effectiveMax, maxDepth: effectiveMax };
	}
	if (depth >= maxDepth) {
		opts?.onDepthExceeded?.({ currentDepth: maxDepth, maxDepth });
		return { allowed: false, reason: "max_depth_exceeded" };
	}
	if (newChildren > maxWidth || newChildren > workingWidth) {
		return { allowed: false, reason: "max_width_exceeded" };
	}
	return { allowed: true };
}

/**
 * F-36: глубина текущего узла из env FAN_ORCHESTRATOR_DEPTH.
 * Отсутствующее, пустое или невалидное значение → 0 (L0).
 */
export function currentDepthFromEnv(): number {
	const raw = process.env.FAN_ORCHESTRATOR_DEPTH;
	if (raw === undefined || raw === "") {
		return 0;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return 0;
	}
	return parsed;
}
