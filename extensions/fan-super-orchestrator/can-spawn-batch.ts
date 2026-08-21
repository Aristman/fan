// F-C / TC-FC-1: canSpawnBatch — extracted from width-pyramid.ts.
//
// Карточка: docs/features/super-orchestrator/super-orchestrator-v2/roadmap.md §F-C
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §5
//
// Вынесено из width-pyramid.ts (фаза F-D refactor): width-pyramid.ts теперь
// содержит ТОЛЬКО константы PYRAMID_WIDTH / PYRAMID_MIN_DEPTH / PYRAMID_MAX_DEPTH,
// а canSpawnBatch живёт здесь. PYRAMID_WIDTH импортируется из width-pyramid.ts.
//
// Пирамида сужается с глубиной: depth=1 — самые широкие рамки (8/12),
// depth=4 — узкий финал (2/4). Правила (порядок проверок):
//   1. depth вне [1, 4] → DENIED, reason="max_depth_exceeded";
//   1a. role="super-orchestrator" && depth=4 → DENIED, reason="super_orch_at_max_depth";
//   2. batch > max[depth]  → DENIED, reason="max_width_exceeded";
//   3. batch > working[depth] для role ≠ "super-orchestrator"
//                            → DENIED, reason="working_width_exceeded";
//   4. иначе → ALLOWED.
//
// Для role="super-orchestrator" лимиты берутся на уровень выше
// (depth-1): он координирует другие оркестраторы и нуждается в более
// широком диапазоне. На depth=1 это даёт max[1]=12, working[1]=8;
// working_width для super-orchestrator не проверяется (только max):
// batch=11 при depth=2 (limits=depth=1) → ALLOWED, т.к. 11 ≤ max[1]=12.

import { PYRAMID_WIDTH, PYRAMID_MAX_DEPTH, PYRAMID_MIN_DEPTH } from "./width-pyramid.js";

/** Опции canSpawnBatch. */
export interface CanSpawnBatchOpts {
	/** Глубина, НА КОТОРОЙ будут новые узлы (1–4). */
	depth: number;
	/** Размер пачки (сколько детей порождается одновременно). */
	batch: number;
	/** Роль родителя: 'super-orchestrator' управляет другими орк. */
	role?: "super-orchestrator" | "orchestrator";
	/** Профиль роли (зарезервировано для будущих расширений). */
	profile?: string;
}

/** Решение canSpawnBatch. */
export interface CanSpawnBatchResult {
	allowed: boolean;
	/** Причина отказа (undefined при allowed=true). */
	reason?:
		| "max_depth_exceeded"
		| "max_width_exceeded"
		| "working_width_exceeded"
		| "super_orch_at_max_depth";
	/** Диагностические детали (для логов). */
	details?: Record<string, unknown>;
}

/**
 * Проверить, допустима ли пачка `batch` новых узлов на глубине `depth`.
 * Для role="super-orchestrator" лимиты берутся на уровень выше
 * (depth-1, clamped до PYRAMID_MIN_DEPTH), и working_width не проверяется.
 */
export function canSpawnBatch(opts: CanSpawnBatchOpts): CanSpawnBatchResult {
	const { depth, batch, role } = opts;

	// 1. Глубина вне [1, 4] — пирамида определена только для этого диапазона.
	if (depth < PYRAMID_MIN_DEPTH || depth > PYRAMID_MAX_DEPTH) {
		return {
			allowed: false,
			reason: "max_depth_exceeded",
			details: { depth, valid: `${PYRAMID_MIN_DEPTH}..${PYRAMID_MAX_DEPTH}` },
		};
	}

	// 1a. Super-Orchestrator на depth=4 = самом узком уровне пирамиды
	//     запрещён: должен порождать только Orch, а Orch depth=4 — это уже
	//     потолок пирамиды. Дальше расти некуда (worker'ы считаются
	//     отдельным измерением и не входят в depth-проверку).
	if (role === "super-orchestrator" && depth === PYRAMID_MAX_DEPTH) {
		return {
			allowed: false,
			reason: "super_orch_at_max_depth",
			details: { depth, max: PYRAMID_MAX_DEPTH },
		};
	}

	// 2. Для super-orchestrator: лимиты на уровень выше (depth-1, ≥ PYRAMID_MIN_DEPTH),
	//    working_width не проверяется — нуждается в более широком диапазоне.
	const isSuperOrch = role === "super-orchestrator";
	const effectiveDepth = isSuperOrch ? Math.max(PYRAMID_MIN_DEPTH, depth - 1) : depth;

	const working = PYRAMID_WIDTH.working[effectiveDepth as 1 | 2 | 3 | 4];
	const max = PYRAMID_WIDTH.max[effectiveDepth as 1 | 2 | 3 | 4];

	// 3. Жёсткий верх (max) проверяется всегда.
	if (batch > max) {
		return {
			allowed: false,
			reason: "max_width_exceeded",
			details: { batch, max, depth, effectiveDepth, role: role ?? null },
		};
	}

	// 4. Рабочая ширина (working) — только для не super-orchestrator.
	if (!isSuperOrch && batch > working) {
		return {
			allowed: false,
			reason: "working_width_exceeded",
			details: { batch, working, depth, effectiveDepth, role: role ?? null },
		};
	}

	return { allowed: true };
}
