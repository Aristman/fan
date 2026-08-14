# fan-super-orchestrator

Сверх-оркестратор FAN: HTTP-иерархия узлов `fan server`. Расширение реализует
порождение дочерних узлов (менеджер процессов с пулом портов), аутентификацию
между узлами через `FAN_NODE_TOKEN`, ограничители глубины/ширины дерева,
санитизацию межагентных сообщений, протоколы «пакет работ» / «отчёт узла»,
клиент дочернего узла (REST + WS), агрегацию и координацию бюджета, JSONL-журнал
дерева узлов и стартовую сверку.

## Модули (этап 2 — ✅ завершён, 14 модулей)

| Модуль | Описание |
|--------|----------|
| `process-manager.ts` | Управление жизненным циклом дочерних `fan server` (spawn/kill/health) |
| `port-pool.ts` | Пул портов 7001–7099 с блокировкой в `child-ports.json` |
| `health-checker.ts` | Health-check `GET /api/health` с retry-логикой |
| `node-auth.ts` | Аутентификация узлов через `FAN_NODE_TOKEN` (Bearer) |
| `depth-width-guard.ts` | Ограничители глубины (≤12) и ширины (≤4 рабочая / ≤12 предохранитель) |
| `message-sanitizer.ts` | Санитизация ввода от дочерних узлов (prompt-injection, длина) |
| `work-package.ts` | Протокол «пакет работ» L0 → L1 (task, budget, tools, deadline) |
| `node-report.ts` | Протокол «отчёт узла» L1 → L0 (verdict, usage, children) |
| `child-node-client.ts` | REST+WS клиент дочернего узла (отправка пакетов, подписка на agent_end) |
| `budget-aggregator.ts` | Агрегация расхода по дереву с атрибуцией по веткам |
| `budget-coordinator.ts` | Глобальный координатор бюджета (`mission-budget.json`, атомарная запись) |
| `tree-journal.ts` | JSONL-журнал дерева узлов (spawn/complete/fail/abort, fsync) |
| `startup-reconciliation.ts` | Очистка orphaned процессов при старте |
| `depth2-integration.ts` | Сквозная интеграция: L0 → 3–4×L1 (пакеты, бюджет, журнал, kill-switch) |

## Изменения ядра

- `packages/api-gateway`: `seedNodeToken()` — сидинг `FAN_NODE_TOKEN` из env в ClientToken store
- `packages/coding-agent/src/main.ts`: сидинг `FAN_NODE_TOKEN` / `FAN_NODE_NAME` при старте дочернего узла

## Тесты

- **457 юнит/интеграционных тестов** (19 файлов, vitest)
- **3 e2e phase-gate скрипта:**
  - `test/phase-gate-a.e2e.mjs` — 11/11 (процессы, auth, guard, sanitizer)
  - `test/phase-gate-b.e2e.mjs` — 26/26 (протоколы, бюджет, журнал, reconciliation)
  - `test/phase-gate-c.e2e.mjs` — 20/20 (depth-2 интеграция, иерархия+бюджет)
- **Всего e2e-проверок:** 57 (11 + 26 + 20)

### Запуск тестов

```bash
# Юнит/интеграционные тесты
cd extensions/fan-super-orchestrator && npx vitest run

# E2E phase-gate скрипты
node test/phase-gate-a.e2e.mjs
node test/phase-gate-b.e2e.mjs
node test/phase-gate-c.e2e.mjs
```

## Что дальше (этап 3)

Этап 3 (`depth-and-dashboard-3`, F-36..F-47): глубина 3–4, манифесты узлов,
Dashboard-виджеты дерева, CLI `fan mission tree`.

Спека: `docs/specs/spec_super-orchestrator_v3_2026-08-10.md` (§3.3, §3.5, §8).
Roadmap: `docs/features/super-orchestrator/http-hierarchy-2/roadmap.md`.
