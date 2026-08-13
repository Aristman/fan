// F-18: Лестница верификации — конфигурация ступеней.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-18
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3 (шаг 4
//           «Верификация»: статика → линтеры → сборка → тесты → приёмочная
//           команда пункта → независимый аудитор в свежем контексте).

export interface VerificationStep {
	name: string; // имя ступени: typecheck | linters | build | tests | acceptance
	command: string; // shell-команда ступени
	timeoutMs: number; // таймаут ступени (мс)
	required: boolean; // false → провал не останавливает лестницу
}

/**
 * Дефолтная лестница из 5 ступеней (порядок важен: от быстрых статических
 * проверок к дорогим, приёмочная ступень — последней).
 */
export const DEFAULT_STEPS: VerificationStep[] = [
	{ name: "typecheck", command: "npx tsgo --noEmit", timeoutMs: 120_000, required: true },
	{ name: "linters", command: "npx biome check .", timeoutMs: 60_000, required: true },
	{ name: "build", command: "npm run build", timeoutMs: 300_000, required: true },
	{ name: "tests", command: "npm test", timeoutMs: 600_000, required: true },
	// Placeholder для LLM-as-Judge аудитора (F-18+): команда приёмки пункта.
	{ name: "acceptance", command: "fan mission audit", timeoutMs: 120_000, required: true },
];
