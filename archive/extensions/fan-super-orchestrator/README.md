# fan-super-orchestrator

Сверх-оркестратор FAN: HTTP-иерархия узлов `fan server`. Расширение реализует
порождение дочерних узлов (менеджер процессов с пулом портов), аутентификацию
между узлами через `FAN_NODE_TOKEN`, ограничители глубины/ширины дерева,
санитизацию межагентных сообщений, протоколы «пакет работ» / «отчёт узла»,
клиент дочернего узла (REST + WS), агрегацию и координацию бюджета, JSONL-журнал
дерева узлов, стартовую сверку, манифесты инструментов и EPIC-делегирование.

## Модули (этап 3 — ✅ завершён, 17 модулей)

| Модуль | Описание |
|--------|----------|
| `process-manager.ts` | Управление жизненным циклом дочерних `fan server` (spawn/kill/health) |
| `port-pool.ts` | Пул портов 7001–7099 с блокировкой в `child-ports.json` |
| `health-checker.ts` | Health-check `GET /api/health` с retry-логикой |
| `node-auth.ts` | Аутентификация узлов через `FAN_NODE_TOKEN` (Bearer) |
| `depth-width-guard.ts` | Ограничители глубины (≤4 рабочая / ≤12 предохранитель) и ширины (≤4) |
| `message-sanitizer.ts` | Полная санитизация: prompt-injection, длина, correlationId, depth, схема отчёта |
| `work-package.ts` | Протокол «пакет работ» L0 → L1 (task, budget, tools, deadline, toolManifest) |
| `node-report.ts` | Протокол «отчёт узла» L1 → L0 (verdict, usage, children) |
| `child-node-client.ts` | REST+WS клиент дочернего узла (отправка пакетов, подписка на agent_end) |
| `budget-aggregator.ts` | Агрегация расхода по дереву с атрибуцией по веткам |
| `budget-coordinator.ts` | Глобальный координатор бюджета (`mission-budget.json`, атомарная запись) |
| `tree-journal.ts` | JSONL-журнал дерева узлов (spawn/complete/fail/abort, tool_blocked, validation_failed) |
| `startup-reconciliation.ts` | Очистка orphaned процессов при старте |
| `depth2-integration.ts` | Сквозная интеграция: L0 → 3–4×L1 (пакеты, бюджет, журнал, kill-switch) |
| `tool-manifest.ts` | **Этап 3:** декларативные манифесты инструментов на узел (validateManifest, --tools флаг) |
| `index.ts` | **Этап 3:** entry-point wiring — EPIC-делегирование (mission_delegate → spawn L1 → journal/budget) |

## Изменения ядра

- `packages/api-gateway`: `seedNodeToken()` — сидинг `FAN_NODE_TOKEN` из env в ClientToken store; mission API endpoints (GET /status, /tree, /budget + WS mission_event)
- `packages/coding-agent/src/main.ts`: сидинг `FAN_NODE_TOKEN` / `FAN_NODE_NAME` при старте дочернего узла; Checkpoint API в AgentSession (F-45); CLI `fan mission tree` (F-42)
- `packages/model-manager/src/budget.ts`: per-iteration budget (F-46)
- `packages/dashboard`: `<mission-tree>`, `<mission-status>`, `<mission-log>`, `<mission-budget>` (F-39/40/41)

## EPIC-делегирование (F-48.5)

Миссионный контур `fan-mission` интегрирован со сверх-оркестратором: при старте
итерации с EPIC-пунктом контур генерирует событие `mission_delegate`, которое
перехватывается `index.ts` расширения. Далее:
1. `runAgent` вызывает LLM для декомпозиции EPIC → список L1-задач с toolManifest.
2. Для каждой задачи spawn реального дочернего `fan server` (port-pool, health-check).
3. Отчёты L1 агрегируются в tree-journal и mission-budget.json.
4. Checkpoint (git commit) до/после итерации.
5. Бюджет итерации контролируется через BudgetTracker (drain при превышении).

## Тесты

- **716 юнит/интеграционных тестов** (26 файлов, vitest)
- **Phase-gate скрипты:**
  - Этап 2: `phase-gate-a.e2e.mjs` (11/11), `phase-gate-b.e2e.mjs` (26/26), `phase-gate-c.e2e.mjs` (20/20)
  - Этап 3: `phase-gate-a3.e2e.mjs` (17/17), `phase-gate-b3.e2e.test.ts` (12/12, api-gateway), `phase-gate-c3.e2e.mjs` (32/32)
- **Всего e2e-проверок:** 118 (57 этап 2 + 61 этап 3)

### Запуск тестов

```bash
# Юнит/интеграционные тесты
cd extensions/fan-super-orchestrator && npx vitest run

# E2E phase-gate скрипты (этап 2)
node test/phase-gate-a.e2e.mjs
node test/phase-gate-b.e2e.mjs
node test/phase-gate-c.e2e.mjs

# E2E phase-gate скрипты (этап 3)
node test/phase-gate-a3.e2e.mjs
cd packages/api-gateway && npx vitest run src/__tests__/phase-gate-b3.e2e.test.ts
node test/phase-gate-c3.e2e.mjs
```

## Статус

- **Этап 0** ✅ (15/15 фич, mission-loop-0)
- **Этап 1** ✅ (8/8 фич, mission-validation-1)
- **Этап 2** ✅ (13/13 фич, http-hierarchy-2)
- **Этап 3** ✅ (13/13 фич + F-48.5, depth-and-dashboard-3)

Спека: `docs/specs/spec_super-orchestrator_v3_2026-08-10.md` (§3.3, §3.5, §8).
Roadmap: `docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md`.
Pipeline: `docs/features/super-orchestrator/pipeline-report.md`.
