// F-20: Конфигурация скорера идей — веса формулы и пороги статусов.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-20
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3
//           (оценка идей: score = 0.3×relevance + 0.2×value + 0.2×(1−risk) + 0.3×(1−cost)).
//
// Refactor-цель карточки F-20: веса формулы и пороги вынесены из idea-scorer.ts,
// чтобы их можно было переиспользовать и менять в одном месте.

/** Веса формулы score (сумма = 1.0). riskInverse/costInverse — веса (1−risk)/(1−cost). */
export const SCORER_WEIGHTS = {
	relevance: 0.3,
	value: 0.2,
	riskInverse: 0.2,
	costInverse: 0.3,
} as const;

/**
 * Пороги статусов:
 *   score >= roadmap → ROADMAP; decide <= score < roadmap → DECIDE; score < decide → REJECTED.
 */
export const THRESHOLDS = {
	roadmap: 0.7,
	decide: 0.5,
} as const;
