// F-C / TC-FC-1: Width pyramid constants.
//
// Карточка: docs/features/super-orchestrator/super-orchestrator-v2/roadmap.md §F-C
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §5
//
// Пирамида сужается с глубиной: depth=1 — самые широкие рамки (8/12),
// depth=4 — узкий финал (2/4). Правила (порядок проверок):
//   1. depth вне [1, 4] → DENIED, reason="max_depth_exceeded";
//   2. batch > max[depth] → DENIED, reason="max_width_exceeded";
//   3. batch > working[depth] → DENIED, reason="working_width_exceeded";
//   4. иначе → ALLOWED.
//
// Фаза F-D refactor: canSpawnBatch вынесен в can-spawn-batch.ts.
// Здесь остаются ТОЛЬКО константы пирамиды; canSpawnBatch ре-экспортируется
// для обратной совместимости с импортами вида
// `import { canSpawnBatch } from "./width-pyramid.js"` (TC-FC-1, TC-FD-1b).

/** Пирамида ширины: working (рабочая ширина) и max (жёсткий верх). */
export const PYRAMID_WIDTH = {
	working: { 1: 8, 2: 6, 3: 4, 4: 2 },
	max: { 1: 12, 2: 10, 3: 8, 4: 4 },
} as const;

/** Допустимая глубина пирамиды (нижняя граница = 1). */
export const PYRAMID_MIN_DEPTH = 1;
/** Допустимая глубина пирамиды (верхняя граница = 4). */
export const PYRAMID_MAX_DEPTH = 4;

export type { CanSpawnBatchOpts, CanSpawnBatchResult } from "./can-spawn-batch.js";
// Re-export canSpawnBatch и связанные типы из can-spawn-batch.ts для
// обратной совместимости (TC-FC-1c..1e, TC-FD-1b импортируют из width-pyramid.js).
export { canSpawnBatch } from "./can-spawn-batch.js";
