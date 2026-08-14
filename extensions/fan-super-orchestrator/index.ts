// F-SO-INDEX: Расширение fan-super-orchestrator — entry-point (каркас).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-23..§F-35
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3, §3.5, §8 «Этап 2»
//
// Сверх-оркестратор FAN: HTTP-иерархия узлов fan server (порождение,
// аутентификация, бюджет, журнал дерева). Расширение будет наполнено
// модулями в F-23..F-35:
//   process-manager, node-auth, depth-width-guard, message-sanitizer,
//   work-package, node-report, child-node-client, budget-aggregator,
//   budget-coordinator, tree-journal, startup-reconciliation,
//   depth2-integration.
//
// Сейчас — no-op фабрика: loader ожидает default export (ExtensionFactory),
// поэтому каркас уже корректен для загрузки и не падает.

export default function superOrchestratorExtension(_fan: unknown): void {
	// no-op: каркас будет наполнен модулями в F-23..F-35.
}
