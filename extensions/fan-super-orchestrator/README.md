# fan-super-orchestrator

Сверх-оркестратор FAN: HTTP-иерархия узлов `fan server`. Расширение реализует
порождение дочерних узлов (менеджер процессов с пулом портов), аутентификацию
между узлами через `FAN_NODE_TOKEN`, ограничители глубины/ширины дерева,
санитизацию межагентных сообщений, протоколы «пакет работ» / «отчёт узла»,
клиент дочернего узла (REST + WS), агрегацию и координацию бюджета, JSONL-журнал
дерева узлов и стартовую сверку.

Планируемые модули (этап 2, карточки F-23..F-35):
`process-manager`, `node-auth`, `depth-width-guard`, `message-sanitizer`,
`work-package`, `node-report`, `child-node-client`, `budget-aggregator`,
`budget-coordinator`, `tree-journal`, `startup-reconciliation`,
`depth2-integration`.

**Статус:** этап 2 в разработке. Сейчас создан только каркас расширения
(entry-point stub, vitest-конфиг, deploy-манифест); модули будут добавляться
по мере реализации карточек F-23..F-35.

Спека: `docs/specs/spec_super-orchestrator_v3_2026-08-10.md` (§3.3, §3.5, §8).
Roadmap: `docs/features/super-orchestrator/http-hierarchy-2/roadmap.md`.
