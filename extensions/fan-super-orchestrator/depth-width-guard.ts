// F-25: Depth/width guard — ограничители глубины и ширины дерева узлов.
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-25
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.2, §5.4
//
// Чистая синхронная функция без состояния: вызывается ПЕРЕД
// processManager.spawn(), чтобы при отказе не блокировать порт и не
// поднимать процесс. Глубина передаётся через env FAN_ORCHESTRATOR_DEPTH,
// ширина — через env FAN_ORCHESTRATOR_WIDTH (счётчик детей родителя).
//
// Порядок проверок фиксирован:
//   1. depth >= maxDepth               → отказ max_depth_exceeded;
//   2. currentChildren >= maxWidth     → отказ max_width_exceeded
//      (предохранитель — жёсткий верх, действует даже при workingWidth выше);
//   3. currentChildren >= workingWidth → отказ max_width_exceeded;
//   4. иначе                           → { allowed: true }.

export interface DepthWidthGuardOptions {
	/** Жёсткий предел глубины дерева (default 12). */
	maxDepth?: number;
	/** Предохранитель ширины на родителя — жёсткий верх (default 12). */
	maxWidth?: number;
	/** Рабочая ширина на родителя (default 4). */
	workingWidth?: number;
}

export interface SpawnDecision {
	allowed: boolean;
	reason?: "max_depth_exceeded" | "max_width_exceeded";
}

export const DEFAULT_GUARD: Required<DepthWidthGuardOptions> = {
	maxDepth: 12,
	maxWidth: 12,
	workingWidth: 4,
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

	if (depth >= maxDepth) {
		return { allowed: false, reason: "max_depth_exceeded" };
	}
	if (currentChildren >= maxWidth || currentChildren >= workingWidth) {
		return { allowed: false, reason: "max_width_exceeded" };
	}
	return { allowed: true };
}
