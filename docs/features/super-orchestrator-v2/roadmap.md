# Roadmap: Супер-оркестратор FAN v2 (depth-4)

> **Дата генерации:** 2026-08-21
> **Источник:** `docs/features/super-orchestrator-v2/architecture.md` (840 строк, 15 секций, коммит `45c69b3`)
> **Версия SKILL:** 1.3.0
> **Функций / Этапов:** 8 / 8 (лимит: 15 / 8)
>
> **Контекст:** depth-2 работает (48/48 фич + F-48.5, 897 тестов fan-mission). Depth-3+4 — новое.

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 8 |
| Этапов | 8 |
| P0 (критические) | 1 (transport fix — блокер всех) |
| P1 (высокие) | 3 (role loader, width + ports, spawn protocol) |
| P2 (средние) | 3 (lineage escalation, verify_subtree, диагностика) |
| P3 (низкие) | 1 (integration test — gate для merge) |

## Легенда

- ✅ — Реализовано
- ☐ — Запланировано
- ⏳ — В работе
- ❌ — Заблокировано

### Приоритеты
- **P0** — Критично (блокер всех остальных фаз, без этого ничего не работает)
- **P1** — Высокий (ядро функциональности, блокер нижестоящих фаз)
- **P2** — Средний (безопасность/верификация, может быть упрощён в MVP)
- **P3** — Низкий (gate перед merge)

### Слои архитектуры
- **[INTEG]** — транспорт, спавн, эскалация
- **[DATA]** — схемы, каталоги, реестры
- **[BIZ]** — валидации, верификация
- **[TEST]** — e2e, smoke

---

## Этап 0: Transport pre-requisite

**Цель:** убрать Bun-ветку из `packages/api-gateway/src/http-server.ts`, перевести на `@hono/node-server` + `ws`; WS-upgrade, JSON health endpoint, dashboard regression и webhook port fix — все работают под `fan.exe` (Bun binary).

**Приоритет функций:** P0
**E2E-сценарий этапа:** запуск `fan.exe --port 7001 --host 127.0.0.1` под Bun runtime. Проверка: `GET /api/health` → 200 + JSON `{status:"ok"}`; `new WebSocket("ws://127.0.0.1:7001/api/ws")` → open event; `GET /api/sessions` с FAN_TOKEN → 200; `fan-webhook --port 9095` стартует на 9095, а не на hardcoded 9090.
**Smoke-критерий этапа:** `bun test packages/api-gateway/test/transport-smoke.test.ts` → 0 fail, runtime = bun.

#### ☐ F-0: Transport fix (Bun → @hono/node-server + ws)
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Удалить Bun-ветку (`if (hasBun)` блок в `packages/api-gateway/src/http-server.ts:475-485`), всегда использовать `@hono/node-server` + `ws`. WS-обработчик должен работать в compiled binary (fan.exe). Дополнительно: webhook port fix (убрать hardcoded `9090` в `extensions/fan-webhook/index.ts`), transport smoke test под Bun, dashboard regression smoke (4 endpoint'а).
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F0-1:** Transport smoke под Bun binary — health JSON
    - *Условие:* `fan.exe --port 7001 --host 127.0.0.1` запущен (Bun runtime)
    - *Шаги:* `fetch("http://127.0.0.1:7001/api/health")`, парсинг JSON
    - *Ожидаемый результат:* status 200, content-type `application/json`, body содержит `status:"ok"`, version, uptime (не fallback "Welcome to Bun!")
  - [ ] **TC-F0-2:** WebSocket upgrade работает на `/api/ws` под Bun binary
    - *Условие:* `fan.exe --port 7001 --host 127.0.0.1` запущен
    - *Шаги:* `new WebSocket("ws://127.0.0.1:7001/api/ws")`, ожидание `open` event (10s timeout)
    - *Ожидаемый результат:* WS connection открывается, send+receive работают, close graceful
  - [ ] **TC-F0-3:** Webhook port fix + dashboard regression (объединённый smoke)
    - *Условие:* `fan.exe` + `fan-webhook --port 9095` запущены, FAN_TOKEN задан
    - *Шаги:* (a) `fan-webhook` слушает на 9095 (не 9090), POST webhook → 200; (b) `GET /api/sessions` с токеном → 200 + JSON; (c) `GET /api/models` → 200 + JSON
    - *Ожидаемый результат:* все 4 проверки зелёные (webhook port + 3 dashboard endpoints)
- **Red-тест:** TC-F0-1 — до фикса возвращает HTML "Welcome to Bun!" (status 200, но content-type text/html, без поля `status`).
- **Критерии приёмки:**
  1. `bun build --compile` собирает `fan.exe` без ошибок; runtime использует `@hono/node-server`
  2. Все 3 transport smoke теста проходят под Bun binary (НЕ под Node runtime)
  3. `fan-webhook` стартует на произвольном порту из `--port` (не hardcoded), и dashboard endpoints не сломаны
- **Refactor-цели:** Удалить все `if (hasBun)` ветки из api-gateway, вынести server bootstrap в `server-bootstrap.ts` helper, добавить unit-тест на bootstrap без spawn
- **Ожидаемый результат:** `packages/api-gateway/test/transport-smoke.test.ts` зелёный под Bun; `fan.exe` запускается и принимает WS; webhook стартует на произвольном порту
- **Оценка объёма:** M (3 файла: api-gateway/http-server.ts, fan-webhook/index.ts, transport-smoke.test.ts)

---

## Этап B: Role loader

**Цель:** загрузчик каталога ролей из 3 слоёв (проектный > глобальный > дефолтный) с merge по `id`, наследование через `extends` (≤3 уровней, cycle detection), 10 стартовых профилей в дефолтном каталоге.

**Приоритет функций:** P1
**E2E-сценарий этапа:** инициализация `fan-super-orchestrator` с пустым project слоем, дефолтным каталогом (`extensions/fan-super-orchestrator/roles/`). Проверка: 10 профилей загружены, schema валидна, extends в дефолте не имеют циклов. Дополнительно: пользовательский проект создаёт override для `backend` (allowed_depths: [3]) — merge работает, `pm` остаётся дефолтным.
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/role-loader.test.ts` → 0 fail, 10 профилей загружены.

#### ☐ F-B: Role loader (YAML schema, 3-слойный merge, extends + cycle detection)
- **Приоритет:** P1
- **Слой:** [DATA]
- **Описание:** Модуль `extensions/fan-super-orchestrator/role-loader.ts`. Сканирует 3 слоя (`<project_root>/roles/`, `~/.fan/agent/roles/`, `extensions/fan-super-orchestrator/roles/`), merge по `id` с приоритетом сверху-вниз, deep merge для вложенных полей. Resolves `extends` цепочки (≤3 уровня), cycle detection через DFS (visited/current marking). 10 стартовых YAML-файлов в дефолтном каталоге (pm, architect, research, backend, frontend, mobile, qa, refactor, docs, devops).
- **Зависимости:** F-0
- **TDD-тесты:**
  - [ ] **TC-FB-1:** 3-слойная загрузка + merge по приоритету (project > global > default)
    - *Условие:* project role `backend.yaml` с `description:"custom"`, global role `backend.yaml` с `default_tools:[custom_tool]`, default role `backend.yaml` со всеми полями
    - *Шаги:* `loadRoleCatalog({projectDir, globalDir, defaultDir})` → загрузить `backend`
    - *Ожидаемый результат:* `backend.description === "custom"` (project), `default_tools === [...defaults, custom_tool]` (deep merge global в default), `allowed_depths` остаётся default
  - [ ] **TC-FB-2:** Extends chain resolution (≤3 уровней) + cycle detection (DFS)
    - *Условие:* role A extends B extends C, plus отдельный fixture A extends B extends A (цикл)
    - *Шаги:* (a) загрузить A; (b) попытка загрузить fixture с A→B→A
    - *Ожидаемый результат:* (a) A содержит все поля C (deep merge через B), B переопределяет где задано; (b) throws `Error("Cycle detected in extends: A → B → A")` с понятным путём
    *Дополнительно:* (c) загрузить fixture с A extends B extends C extends D (4 уровня — превышает лимит)
    *Ожидаемый результат:* (c) throws Error("Extends chain too deep: A → B → C → D (max 3)")
  - [ ] **TC-FB-3:** 10 стартовых профилей в дефолтном каталоге (smoke)
    - *Условие:* расширение `fan-super-orchestrator` установлено
    - *Шаги:* `fs.readdir(roles/)`, парсинг каждого YAML, проверка schema
    - *Ожидаемый результат:* 10 .yaml файлов: `pm.yaml`, `architect.yaml`, `research.yaml`, `backend.yaml`, `frontend.yaml`, `mobile.yaml`, `qa.yaml`, `refactor.yaml`, `docs.yaml`, `devops.yaml`. Все парсятся, все обязательные поля присутствуют, `allowed_depths` соответствует §3.4
- **Red-тест:** TC-FB-2 (cycle) — без DFS detection цикл A→B→A приводит к stack overflow при deep merge. Тест обязан упасть первым, подтверждая safety.
- **Критерии приёмки:**
  1. Role loader загружает 3 слоя без ошибок при валидных конфигах; дубликаты `id` в пределах слоя → halt с понятной ошибкой
  2. Cycle detection работает для всех 2-уровневых циклов (тест на A→B→A); extends chain > 3 уровней → halt
  3. Дефолтный каталог содержит 10 профилей, каждый парсится, `allowed_depths` соответствует §3.4 таблицы
- **Refactor-цели:** Выделить YAML parsing в `yaml-loader.ts`, schema validation через zod (или ручной guard с типизированными ошибками), cache loaded catalog в singleton (не перезагружать на каждый spawn)
- **Ожидаемый результат:** `extensions/fan-super-orchestrator/role-loader.ts` + `roles/*.yaml` (10 файлов) + `test/role-loader.test.ts` зелёный
- **Оценка объёма:** M (1 новый модуль + 10 YAML + 3 теста)

---

## Этап C: Width pyramid + port registry

**Цель:** константы пирамиды ширины (8/6/4/2 working, 12/10/8/4 max) + глобальный port registry v2 (`~/.fan/agent/port-registry.json`) с caps 100 nodes + 256 ports, lock-protected access (file-locking), atomic cap check (race-free), orphan PID cleanup, migration v1→v2.

**Приоритет функций:** P1
**E2E-сценарий этапа:** init миссии → registry создан с `version: 2`, `global_caps.max_nodes_workers: 100`. Concurrent spawn двух Super-Orch (parallel test) — один ALLOWED, второй REFUSED с `node_cap_exceeded` (race-free). После SIGKILL mock-процесса — следующий init удаляет orphan PID и освобождает порт.
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/port-registry.test.ts` → 0 fail; `bun test extensions/fan-super-orchestrator/test/width-pyramid.test.ts` → 0 fail.

#### ☐ F-C: Width pyramid + port registry (cap, lock, atomic, migration)
- **Приоритет:** P1
- **Слой:** [DATA]
- **Описание:** Расширяет существующий `extensions/fan-super-orchestrator/depth-width-guard.ts:119` (содержит `canSpawnBatch(depth, newChildren, opts?)` с flat `workingWidth=4`/`maxWidth=12` defaults, используется в `index.ts:429`, покрыт 10+ тестами `test/depth-width-guard.test.mjs`). Стратегия: **делегировать** старый `canSpawnBatch` новой пирамиде — `width-pyramid.ts` экспортирует `PYRAMID_WIDTH = { working: {1:8, 2:6, 3:4, 4:2}, max: {1:12, 2:10, 3:8, 4:4} }`; `depth-width-guard.ts` модифицируется для per-depth lookup (читает из `width-pyramid.ts`). Back-compat: существующие depth-2 вызовы продолжают работать (defaults = pyramid[2]). Новый модуль `extensions/fan-super-orchestrator/port-registry.ts` (schema v2, lock-protected access, atomic cap check). Расширяет существующий `port-pool.ts` для работы с глобальным реестром. Schema v2: `global_caps`, `current_state` (active_nodes/workers/webhooks), `api_pool` (7001-7100), `webhook_pool` (9090-9189), `orphan_pids`. Cap: 100 nodes+workers одновременно. Lock: file-locking через `proper-lockfile` или SQLite-based registry.
- **Зависимости:** F-0
- **TDD-тесты:**
  - [ ] **TC-FC-1:** Width pyramid constants + canSpawnBatch validation
    - *Условие:* width-pyramid.ts импортирован
    - *Шаги:* (a) `WORKING_WIDTH[1]=8, MAX_WIDTH[1]=12, WORKING_WIDTH[4]=2, MAX_WIDTH[4]=4`; (b) `canSpawnBatch(depth=2, batch=11, role=super-orch)` → ALLOWED (≤ max_width=10), `canSpawnBatch(depth=2, batch=12, ...)` → DENIED с reason `max_width_exceeded`
    - *Ожидаемый результат:* константы соответствуют §5 (8/6/4/2 + 12/10/8/4), граничные значения корректны
  - [ ] **TC-FC-2:** Port registry atomic cap check (race-free для concurrent spawn)
    - *Условие:* registry с `active_nodes=99, active_workers=0`
    - *Шаги:* два параллельных `tryAllocatePort({role, profile, depth})` через `Promise.all` (mock: 5ms latency между read и write)
    - *Ожидаемый результат:* один ALLOWED (active_nodes → 100), второй REFUSED с error `node_cap_exceeded` (НЕ оба ALLOWED, что было бы TOCTOU race)
  - [ ] **TC-FC-3:** Orphan PID cleanup + migration v1 → v2
    - *Условие:* (a) registry с `orphan_pids: [99999]` (PID не существует); (b) registry с `version: 1`
    - *Шаги:* (a) `startRegistry()` → cleanup hook; (b) `startRegistry()` на v1
    *Ожидаемый результат:* (a) PID 99999 удалён, порт освобождён; (b) registry пересоздан с `version: 2`, `current_state: {active_nodes:0, active_workers:0, active_webhooks:0}`, существующие процессы продолжают работу (не миграция in-place)
- **Red-тест:** TC-FC-2 (atomicity) — race condition должен быть воспроизводим иначе сложно доказать, что lock работает. Тест без lock → оба ALLOWED (Red); с lock → один ALLOWED, второй REFUSED (Green).
- **Критерии приёмки:**
  1. Width pyramid constants соответствуют таблице §5 (8/6/4/2 + 12/10/8/4); canSpawnBatch отказывает при превышении любого лимита
  2. Port registry thread-safe: file-locking через `proper-lockfile` ИЛИ SQLite-based registry; без race conditions на concurrent spawn
  3. Migration v1 → v2 не ломает существующие активные процессы (orphan-PID cleanup до миграции)
- **Refactor-цели:** Выделить PortRegistry в `port-registry.ts` отдельный модуль (не часть port-pool), инкапсулировать lock logic. Configurable backend (proper-lockfile | SQLite) через DI. **Модифицировать `depth-width-guard.ts`**: добавить PYRAMID_WIDTH lookup (читать из `width-pyramid.ts`), back-compat — текущий flat API → pyramid[2] = working=6/max=10.
- **Ожидаемый результат:** 3 TDD-теста (TC-FC-1..3) с ~6 assert'ами суммарно; планируется ещё 3 follow-up теста (webhook pool, lock contention) в backlog #40.5
- **Оценка объёма:** L (2 новых модуля + расширение port-pool.ts + 3 теста + lock backend)

---

## Этап D: Spawn protocol (extended work-package + port allocation)

**Цель:** расширенный `SpawnWorkPackage` с полями `role`, `role_profile`, `parent_correlation_id`, `parent_url`, `parent_token`, `parent_report_id`, `lineage[]`, `depth`; валидация `canSpawnBatch`; spawn flow с port allocation через registry; построение lineage (parent + ancestors append).

**Приоритет функций:** P1
**E2E-сценарий этапа:** Coordinator (d=0) → spawn Super-Orch pm (d=1, profile=pm, allowed_depths=[1]). pm (d=1) → spawn Super-Orch architect (d=2, profile=architect, allowed_depths=[1,2]). architect (d=2) → spawn Orch backend (d=3, profile=backend, allowed_depths=[2,3,4]). На каждом уровне — child процесс реально стартует через process-manager на allocated API+webhook портах; lineage включает всех предков.
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/spawn-protocol.test.ts` → 0 fail; TC-FD-1.b (canSpawnBatch для Super-Orch at depth=4) returns REFUSED с `super_orch_at_max_depth`; TC-FD-2 (real spawn с port allocation) запускает mock child fan server, lineage корректный.

#### ☐ F-D: Spawn protocol (extended work-package + port allocation + lineage)
- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** Расширяет существующий `extensions/fan-super-orchestrator/work-package.ts` (содержит `WorkPackage` interface: task, correlationId, depth, spawnBudget, tokenBudget, costBudgetUsd, maxRetries, toolManifest, deadline; `parseWorkPackage()` и `validateWorkPackageFields()`). Стратегия: **расширить** `WorkPackage` interface новыми optional-полями (`role?: "super-orchestrator" | "orchestrator"`, `role_profile?: string`, `parent_correlation_id?: string`, `parent_url?: string`, `parent_token?: string`, `parent_report_id?: string`, `lineage?: Array<{...}>`). `parseWorkPackage()` сохраняет новые поля при наличии. `validateWorkPackageFields()` валидирует новые поля ТОЛЬКО для depth>0 пакетов (depth-1 пакеты — без них, back-compat). Расширяет `extensions/fan-super-orchestrator/depth2-integration.ts`. Новый `spawnNode(workPackage)` flow с port allocation через registry → process-manager.spawn (с `waitForReady` из Phase 0) → journal spawn → WS send. Построение lineage — parent добавляет свой entry к существующему lineage.
- **Зависимости:** F-B, F-C
- **TDD-тесты:**
  - [ ] **TC-FD-1:** Extended SpawnWorkPackage + canSpawnBatch validation
    - *Условие:* typescript компилируется, role_profile catalog загружен (Phase B)
    - *Шаги:* (a) создать work-package со всеми новыми полями (role, role_profile, parent_*, lineage, depth); (b) `canSpawnBatch({depth:4, role:'super-orchestrator', profile:'backend'})` (запрещено для SO), `canSpawnBatch({depth:2, batch:7, role:'super-orchestrator', profile:'backend'})` (allowed)
    *Ожидаемый результат:* (a) тип валиден, обязательные поля заполнены; (b) depth=4 SO → REFUSED `super_orch_at_max_depth`; depth=2 batch=7 → ALLOWED (working_width=6, max_width=10)
    *Дополнительно:* (c) `canSpawnBatch({depth:2, role:'super-orchestrator', profile:'non-existent-profile'})`
    *Ожидаемый результат:* (c) REFUSED с reason `role_profile_not_found`
  - [ ] **TC-FD-2:** Spawn flow с port allocation через registry
    - *Условие:* registry пуст, mocked process-manager возвращает fake child PID
    - *Шаги:* `spawnNode({role:'super-orchestrator', profile:'backend', depth:2, ...})`
    *Ожидаемый результат:* registry после: `api_pool.allocated` имеет один entry (например 7001), `webhook_pool.allocated` имеет один entry (9090), `current_state.active_nodes === 1`; child PID записан в journal
  - [ ] **TC-FD-3:** Lineage construction (parent + ancestors append)
    - *Условие:* Coordinator (d=0) → Super-Orch pm (d=1, lineage=[Coordinator]) → spawn Super-Orch architect (d=2)
    *Шаги:* pm формирует work-package для architect
    *Ожидаемый результат:* architect.workPackage.lineage === [{corrId:Coordinator, url, token, role:'coordinator'}, {corrId:pm, url, token, role:'super-orchestrator', profile:'pm'}] (length 2), depth === 2
- **Red-тест:** TC-FD-1 (canSpawnBatch для Super-Orch at d=4) — без проверки spawn Super-Orch на d=4 → превышение depth limit → broken tree.
- **Критерии приёмки:**
  1. Extended `SpawnWorkPackage` (через миграцию `work-package.ts`) содержит все поля §4.1; `canSpawnBatch` отказывает для невалидных depth/profile/batch (см. §4.3)
  2. Spawn flow реально стартует child через process-manager на allocated API+webhook портах (из F-C registry)
  3. Lineage включает ВСЕХ предков с URL+token+role+profile; depth = parent_depth + 1
- **Refactor-цели:** Вынести формирование work-package в `build-work-package.ts` (отделить от spawn); `canSpawnBatch` в `can-spawn-batch.ts`; `spawnNode` только orchestrates. **Модифицировать `work-package.ts`**: `WorkPackage` interface расширяется новыми optional полями; `validateWorkPackageFields()` — новая ветка для depth>0; `parseWorkPackage()` — pass-through новых полей; существующие depth-2 парсеры не сломаны.
- **Ожидаемый результат:** spawn Super-Orch с правильным lineage + port (использует Phase 0 transport); depth=4 SO запрещён; 3 теста в `test/spawn-protocol.test.ts` зелёные
- **Оценка объёма:** L (расширение depth2-integration.ts + 3 новых модуля + 3 теста)

---

## Этап E: Lineage escalation (walk-up + orphan-reports)

**Цель:** walk-up протокол эскалации отчёта вверх по lineage при недоступности parent (30s per-hop + backoff 1s); orphan-report storage (`<mission_dir>/orphan-reports/<report_id>.json`, atomic write); recovery на `session_start` любого узла миссии; `_index.json` для быстрого листинга; idempotency по `parent_report_id`.

**Приоритет функций:** P2
**E2E-сценарий этапа:** child (d=3) завершает работу → POST report на parent (d=2). Mock: d=2 крашится сразу. Walk-up → POST на grandparent (d=1) → timeout 30s → POST на Coordinator (d=0) → 200 OK + ack. Завершение успешно (escalation спасла отчёт).
Альтернативный сценарий: ВСЕ предки недоступны → orphan-report записан в `<mission_dir>/orphan-reports/`. Coordinator session_start → recovery scan → попытка доставить → файл удалён.
**Smoke-критерий этапа:** walk-up успешен с первого hop; orphan-report atomic write создаёт `.tmp` и renames; idempotency по `parent_report_id`.

#### ☐ F-E: Lineage escalation (walk-up + orphan-reports + recovery)
- **Приоритет:** P2
- **Слой:** [INTEG]
- **Описание:** Модули `extensions/fan-super-orchestrator/walk-up.ts` (per-hop 30s timeout, 1s backoff, idempotency cache), `orphan-storage.ts` (atomic write через `.tmp` + rename, `_index.json` параллельный). Recovery hook на `session_start` (любого узла миссии) + `mission_rejoin` (Coordinator) сканирует `<mission_dir>/orphan-reports/` и пытается доставить.
- **Зависимости:** F-D
- **TDD-тесты:**
  - [ ] **TC-FE-1:** Walk-up протокол — успех с первого hop + эскалация на grandparent
    - *Условие:* child (d=3), lineage: [Coordinator, Super-Orch d=1, Super-Orch d=2]. Mock: d=2 timeout 30s, d=1 200 OK.
    *Шаги:* `deliverReport(report, lineage)` (где lineage в обратном порядке: [d=2, d=1, d=0])
    *Ожидаемый результат:* первая попытка на d=2 timeout (>30s), вторая на d=1 200 OK + ack; общее время < 45s (с буфером для CI latency); orphan НЕ записан
  - [ ] **TC-FE-2:** Orphan-report atomic write + _index.json при exhausted lineage
    *Условие:* ВСЕ предки недоступны (3 hops mocked на timeout/refused)
    *Шаги:* `deliverReport(report, lineage)` → все hops fail → orphan-write
    *Ожидаемый результат:* `<mission_dir>/orphan-reports/<report_id>.json` создан (атомарно через `.tmp` → rename), содержит schema из §6.5; `<mission_dir>/orphan-reports/_index.json` обновлён (entry для report_id); размер файла соответствует schema (нет truncated write)
  - [ ] **TC-FE-3:** Recovery на session_start + idempotency по parent_report_id
    *Условие:* (a) orphan-reports/ содержит 1 непрочитанный отчёт, теперь предок доступен; (b) два POST с одним `parent_report_id` на родителя
    *Шаги:* (a) вызвать recovery hook из session_start родителя; (b) первый POST → обработан, второй POST с тем же id → попытка повторной обработки
    *Ожидаемый результат:* (a) recovery нашёл файл, попытка доставить, успех → файл удалён, `_index.json` синхронизирован; (b) второй POST возвращает ack (NO_OP), без двойной обработки (idempotency cache hit)
- **Red-тест:** TC-FE-2 (orphan) — без атомарной записи crash посреди write → truncated/corrupt JSON; без recovery отчёт теряется навсегда.
- **Критерии приёмки:**
  1. Walk-up работает в порядке: parent → grandparent → ... → Coordinator, per-hop timeout 30s + backoff 1s (max chain 2.5 мин); orphan-report записан atomically при exhausted lineage
  2. `session_start` recovery находит недоставленные отчёты и пытается доставить (max 1 попытка); `_index.json` синхронизирован с `orphan-reports/`
  3. Идемпотентность по `parent_report_id` (cache на стороне получателя, persist в `.mission-loop.json`)
- **Refactor-цели:** Выделить walk-up в `walk-up.ts`, orphan-reports в `orphan-storage.ts`; разделить доставку (HTTP POST) и запись (file IO); orphan-recovery в отдельный `orphan-recovery.ts`
- **Ожидаемый результат:** 3 теста в `test/lineage-escalation.test.ts` зелёные; e2e «child + crashed parent + orphan recovery на Coordinator» работает
- **Оценка объёма:** L (3 новых модуля + 3 теста + atomic write logic + recovery hook)

---

## Этап F: verify_subtree tool

**Цель:** встроенный tool на каждом Super-Orch для верификации отчётов своего поддерева. Проверяет completeness (все задачи выполнены), interface consistency (смежные части согласованы), budget (cost ≤ costBudget), quality (по `role_profile.verification_approach`). Результат — `VerificationResult { issues[], summary }`. Mandatory invocation ДО финализации или следующей фазы.

**Приоритет функций:** P2
**E2E-сценарий этапа:** Super-Orch (d=1, profile=pm) агрегирует отчёты от 2 детей (Orch d=2). Вызов `verify_subtree(reports)` → проверка: все 2 отчёта есть (completeness ✓), интерфейсы согласованы (оба ссылаются на `/api/notifications` — consistent ✓), бюджет не превышен (cost < budget ✓), quality per pm.verification_approach ✓. Возврат `VerificationResult{issues:[], summary:{verified:true, total:2}}`. Integration: verify_subtree вызывается ДО отправки отчёта Coordinator'у.
**Smoke-критерий этапа:** verify_subtree на пустых reports → `issues:[{kind:"no_reports"}]`; на валидах → `issues:[]`.

#### ☐ F-F: verify_subtree tool (completeness + interface + budget + quality)
- **Приоритет:** P2
- **Слой:** [BIZ]
- **Описание:** Модуль `extensions/fan-super-orchestrator/verify-subtree.ts`. Tool `verify_subtree(reports: NodeReport[]): VerificationResult`. Реализует 4 проверки: completeness (все ожидаемые отчёты present), interface consistency (cross-references между отчётами), budget (суммарный cost ≤ costBudget), quality (per `role_profile.verification_approach` — pluggable модули). Super-Orch реагирует на issues: retry/re-plan/escalate. Mandatory invocation после агрегации, ДО report to parent.
- **Зависимости:** F-D
- **TDD-тесты:**
  - [ ] **TC-FF-1:** Completeness + budget checks
    - *Условие:* reports = [valid_report_1, valid_report_2], expected=2, costBudget=10.00; отдельно reports = [] (пустой массив); отдельно reports с суммарным cost=15.00 (превышение budget=10.00)
    *Шаги:* `verify_subtree(reports, {expected: 2, costBudget: 10.00})` для каждого
    *Ожидаемый результат:* (a) 2 валидных → `issues:[]`, `summary.verified:true`; (b) пустой → `issues:[{severity:"error", kind:"no_reports"}]`; (c) over-budget → `issues:[{severity:"error", kind:"budget_exceeded", actual:15.00, budget:10.00}]`
    *Дополнительно:* (d) profile='qa' с `verification_approach:"strict"`, reports = [report_with_quality_score=0.3 (<0.5 threshold)]
    *Ожидаемый результат:* (d) `issues:[{severity:"warning", kind:"quality_below_threshold", score:0.3, threshold:0.5}]`
  - [ ] **TC-FF-2:** Interface consistency check
    - *Условие:* report_A объявляет `output.api_endpoint: "/api/notifications"`, report_B ссылается на `input.depends_on: "/api/notifications"`. Отдельно: report_C ссылается на несуществующий `/api/unknown`
    *Шаги:* `verify_subtree([report_A, report_B])`, `verify_subtree([report_A, report_C])`
    *Ожидаемый результат:* (a) consistent → `issues:[]`; (b) broken ref → `issues:[{severity:"warning", kind:"broken_interface_ref", endpoint:"/api/unknown", referenced_by:"report_C"}]`
  - [ ] **TC-FF-3:** Mandatory invocation integration в Super-Orch flow
    *Условие:* Super-Orch (mocked) агрегирует 2 reports, готовит report_to_parent
    *Шаги:* (a) вызвать Super-Orch flow с валидными отчётами; (b) вызвать с reports содержащими issues
    *Ожидаемый результат:* (a) verify_subtree вызван, result=OK, report отправлен parent; (b) verify_subtree вызван, result=issues, Super-Orch НЕ отправляет report, вместо этого retry/re-plan (логируется)
- **Red-тест:** TC-FF-1 (budget) — без проверки бюджет может быть превышен (cost > budget), mission превысит бюджет без видимого сигнала.
- **Критерии приёмки:**
  1. `verify_subtree` возвращает `VerificationResult` (`issues: Issue[]`, `summary: {verified, total, totalCost}`)
  2. Обязательная проверка: completeness, interface, budget, quality — все 4 видны в результате
  3. Super-Orch реагирует на issues: retry/re-plan/escalate (НЕ продолжает молча)
- **Refactor-цели:** Вынести quality checks в pluggable модули per `role_profile.verification_approach` (registry pattern); добавить unit-тесты на каждый check отдельно
- **Ожидаемый результат:** verify_subtree доступен как tool на каждом Super-Orch; 3 теста в `test/verify-subtree.test.ts` зелёные
- **Оценка объёма:** M (1 новый модуль + интеграция в flow + 3 теста)

---

## Этап I: Диагностика (SPEC §14)

**Цель:** реализовать обязательные диагностические требования из SPEC §14: видимые сообщения в чат на session_start/handler entry/error, extension health-check на session_start, console.error debug-логи. Без них отладка depth-4 невозможна.

**Приоритет функций:** P2
**E2E-сценарий этапа:** spawn Super-Orch (d=2, profile=backend) под Bun-binary. Проверка: в чат приходит сообщение `[<correlation_id>] super-orchestrator:backend initialized, depth=2, lineage_len=2` в течение 1 секунды после spawn. При handler entry (mission_delegate) — `[handler:<corr>] received packages=N, role_profile=backend`. При error (mock timeout) — `[<corr>] delegation failed: <error>, attempted escalation to grandparent=<corr>`. Extension health-check проходит (initCircuit OK). При F-0 transport broken — видимый halt с actionable message.
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/diagnostics.test.ts` → 0 fail; session_start chat message отправлен в течение 1s; extension health-check проходит.

#### ☐ F-Diag: Диагностика (SPEC §14)
- **Приоритет:** P2
- **Слой:** [INTEG]
- **Описание:** Реализует обязательные требования §14. (a) Chat messages на session_start: `[<corr>] <role>:<role_profile> initialized, depth=N, lineage_len=M` через `console.log` + visible-to-user API. (b) Handler entry: `[handler:<corr>] received packages=N, role_profile=...`. (c) Error-reply: `[<corr>] delegation failed: <error>; attempted escalation to grandparent=<corr>`. (d) Extension health-check на session_start: smoke initCircuit, halt с actionable message при failure. (e) `console.error` debug-логи на каждом handler entry/error.
- **Зависимости:** F-D, F-E (требуют рабочих spawn и escalation flows для диагностики)
- **TDD-тесты:**
  - [ ] **TC-FDiag-1:** Session_start chat message отправлен с правильным форматом
    - *Условие:* Super-Orch (d=2, profile=backend, corr=abc123) заспавнен
    - *Шаги:* перехватить chat-message-stream в течение 1 сек после spawn
    - *Ожидаемый результат:* получено сообщение вида `[abc123] super-orchestrator:backend initialized, depth=2, lineage_len=2` (regex match)
  - [ ] **TC-FDiag-2:** Handler entry chat message + console.error на каждом entry
    - *Условие:* Super-Orch получает `mission_delegate` event с `correlationId=xyz, packages=3, role_profile=backend`
    - *Шаги:* вызвать handler; перехватить chat + console.error
    - *Ожидаемый результат:* chat: `[handler:xyz] received packages=3, role_profile=backend`; `console.error` содержит строку `[fan-super-orchestrator] delegate handler entered: corr=xyz, packages=3`
  - [ ] **TC-FDiag-3:** Extension health-check на session_start + error-reply chat
    - *Условие:* (a) extension initCircuit mock успешен; (b) extension initCircuit mock throws; (c) mock timeout на parent → walk-up error
    - *Шаги:* session_start каждого варианта
    - *Ожидаемый результат:* (a) health-check OK, нет halt; (b) halt с actionable message «super-orchestrator не загрузился — проверьте ~/.fan/agent/extensions/fan-super-orchestrator/»; (c) error-reply chat: `[<corr>] delegation failed: timeout; attempted escalation to grandparent=<grandparent_corr>`
- **Red-тест:** TC-FDiag-3 (halt with actionable message) — без этого при broken extension пользователь видит silent failure без подсказки куда смотреть.
- **Критерии приёмки:**
  1. Все session_start, handler entry, error events логируются и в chat, и в console.error
  2. Extension health-check блокирует start при broken init с actionable message
  3. Error-reply содержит attempted escalation info для debugging walk-up
- **Refactor-цели:** Выделить chat-message helper в `chat-logger.ts`; extension health-check в `extension-health.ts`; подключить к существующей `console.error` инфраструктуре depth-2
- **Ожидаемый результат:** 3 теста в `test/diagnostics.test.ts` зелёные; при broken transport/extension — видимые actionable сообщения
- **Оценка объёма:** M (1-2 новых модуля + интеграция в spawn/escalation flows + 3 теста)

---

## Этап H: Integration test (depth-4 e2e + walk-up recovery e2e)

**Цель:** e2e-тесты с mock-детьми: depth-4 happy path (use case C из §8), walk-up + orphan-reports (use case E), регистрация всех тестов для CI. Gate перед merge в `develop`.

**Приоритет функций:** P3
**E2E-сценарий этапа:** depth-4 flow — Coordinator → Super-Orch pm (d=1, real) → mock Super-Orch architect (d=2) → mock Super-Orch backend (d=3) → mock Orch qa (d=4, real workers). Все 4 уровня работают, финальный отчёт доставлен Coordinator'у через WS.
Альтернативный: walk-up e2e — spawn d=3 child, kill d=2 parent во время report delivery, дождаться walk-up + orphan recovery.
**Smoke-критерий этапа:** Mock depth-2 happy path (Coordinator → Super-Orch → Orch) завершается за < 30 сек с mock-children. + полный e2e depth-4 (< 5 мин) — основной gate. Команда: `bun test extensions/fan-super-orchestrator/test/e2e/depth-2-smoke.test.ts` (быстрый) + `bun test extensions/fan-super-orchestrator/test/e2e/depth-4.test.ts` (gate).

#### ☐ F-H: Integration tests (depth-4 e2e + walk-up e2e + mock infra)
- **Приоритет:** P3
- **Слой:** [TEST]
- **Описание:** Mock-children infrastructure (тестовый helper: spin up N mock fan servers с заданным поведением). E2E тесты под Bun runtime: (a) depth-4 happy path — use case C из §8; (b) walk-up + orphan-reports — use case E из §8; (c) width pyramid test — use case D из §8 (192 workers peak, проверка что нет deadlock). CI integration — запуск e2e перед merge.
- **Зависимости:** F-E, F-F, F-Diag
- **TDD-тесты:**
  - [ ] **TC-FH-1:** Mock-children infrastructure
    - *Условие:* test setup
    *Шаги:* `createMockFanServer({port, role, profile, behavior: 'respond|report|crash', latency: 50})`
    *Ожидаемый результат:* mock отвечает на `/api/health` (200 JSON), принимает WS upgrade, отвечает на report с заданным behavior (delay/latency мок работает), graceful shutdown по SIGTERM
  - [ ] **TC-FH-2:** Depth-4 happy path (use case C — Ralph-loop)
    - *Условие:* Coordinator (real) → Super-Orch pm (real) → mock SO architect (d=2) → mock SO backend (d=3) → mock Orch qa (d=4, real workers)
    *Шаги:* запустить full flow с реальным spawn через process-manager, ожидать финальный report на Coordinator
    *Ожидаемый результат:* все 4 уровня работают, lineage корректный на каждом уровне, финальный report доставлен через WS, verify_subtree вызван, общее время < 5 минут, все порты освобождены после teardown
  - [ ] **TC-FH-3:** Walk-up + orphan-reports e2e (use case E)
    - *Условие:* spawn d=3 child, kill d=2 parent (SIGKILL) во время report delivery
    *Шаги:* (a) дождаться walk-up (>30s на d=2 timeout); (b) walk-up на d=1, доставка; (c) или все fail → orphan-report
    *Ожидаемый результат:* walk-up успешен на d=1 (или orphan записан), recovery на Coordinator session_start доставляет; total time < 2 минуты per §15.3 fail-fast
- **Red-тест:** TC-FH-2 (depth-4 happy path) — это gate для merge. Без него нельзя гарантировать, что все 7 фаз интегрируются.
- **Критерии приёмки:**
  1. Mock-children работают как реальные fan servers для тестов (health, WS, report, graceful shutdown)
  2. Depth-4 flow end-to-end завершается с финальным отчётом на Coordinator; lineage корректный; verify_subtree вызван
  3. Walk-up + orphan-recovery работают под integration сценарий (use case E); recovery на Coordinator доставляет
- **Refactor-цели:** Выделить mock-server в `test/helpers/mock-fan-server.ts`; переиспользовать для регрессионных тестов (transport fix, role loader); добавить `--reporter=spec` для CI читаемого вывода
- **Ожидаемый результат:** 3 e2e-теста в `test/e2e/` зелёные под Bun runtime; CI hook перед merge в `develop`
- **Оценка объёма:** L (mock infra + 3 e2e теста + CI integration). **Flaky mitigation:** retry 2x на Windows CI, timeout 2x (Bun startup медленнее на Windows), skip markers для known-flaky; pre-merge обязателен зелёный на Linux.

---

## Полный чеклист по приоритетам

### P0 — Критические
- [ ] F-0 [INTEG]: Transport fix (Bun → @hono/node-server + ws + smoke)

### P1 — Высокие
- [ ] F-B [DATA]: Role loader (YAML schema, 3-слойный merge, extends + cycle detection)
- [ ] F-C [DATA]: Width pyramid + port registry (cap, lock, atomic, migration)
- [ ] F-D [INTEG]: Spawn protocol (extended work-package + port allocation + lineage)

### P2 — Средние
- [ ] F-E [INTEG]: Lineage escalation (walk-up + orphan-reports + recovery)
- [ ] F-F [BIZ]: verify_subtree tool (completeness + interface + budget + quality)
- [ ] F-Diag [INTEG]: Диагностика (SPEC §14) (chat messages + health-check + console.error)

### P3 — Низкие
- [ ] F-H [TEST]: Integration tests (depth-4 e2e + walk-up e2e + mock infra)

---

## Граф зависимостей

```
F-0 ──→ F-B ──→ F-D ──→ F-E ──→ F-Diag ──→ F-H ──→ merge
    └─→ F-C ──↗        └──→ F-F ──↗          ──↗
```

Текстовое представление:
- F-0 ← (none) — транспорт pre-requisite, блокирует все
- F-B ← F-0 — role loader требует транспорт
- F-C ← F-0 — port registry требует транспорт для smoke тестов
- F-D ← F-B, F-C — spawn protocol требует roles + ports
- F-E ← F-D — escalation требует spawn protocol (lineage)
- F-F ← F-D — verify_subtree требует spawn (отчёты от детей)
- F-Diag ← F-D, F-E — диагностика требует рабочих spawn и escalation flows
- F-H ← F-E, F-F, F-Diag — e2e тесты требуют все предыдущие

**Проверка на циклы:** нет циклов. DAG от F-0 до F-H.

---

## Делегирование

Не применимо — фича единая, не превышает лимиты 8/15.

---

## Связь с существующей кодовой базой

**Расширяемые файлы:**
- `extensions/fan-super-orchestrator/depth2-integration.ts` — spawn flow расширяется до work-package + port allocation (Phase D)
- `extensions/fan-super-orchestrator/depth-width-guard.ts` — модифицируется для per-depth PYRAMID_WIDTH lookup из width-pyramid.ts (Phase C)
- `extensions/fan-super-orchestrator/work-package.ts` — WorkPackage interface расширяется новыми optional полями (Phase D)
- `extensions/fan-super-orchestrator/port-pool.ts` — переключается на глобальный registry (Phase C)
- `extensions/fan-webhook/index.ts` — убирается hardcoded 9090 (Phase 0)
- `packages/api-gateway/src/http-server.ts` — убирается Bun-ветка (Phase 0)

**Примечание:** SPEC §12.1 содержит «7001-7099 (99 портов)» — устаревшее (до фикса re-verify). Roadmap использует §12.2 «7001-7100 (100 портов)» как канонический.

**Новые файлы (12):**
- `extensions/fan-super-orchestrator/role-loader.ts` (B)
- `extensions/fan-super-orchestrator/roles/*.yaml` × 10 (B)
- `extensions/fan-super-orchestrator/width-pyramid.ts` (C)
- `extensions/fan-super-orchestrator/port-registry.ts` (C)
- `extensions/fan-super-orchestrator/can-spawn-batch.ts` (D)
- `extensions/fan-super-orchestrator/build-work-package.ts` (D)
- `extensions/fan-super-orchestrator/walk-up.ts` (E)
- `extensions/fan-super-orchestrator/orphan-storage.ts` (E)
- `extensions/fan-super-orchestrator/orphan-recovery.ts` (E)
- `extensions/fan-super-orchestrator/verify-subtree.ts` (F)
- `extensions/fan-super-orchestrator/chat-logger.ts` (I / F-Diag)
- `extensions/fan-super-orchestrator/extension-health.ts` (I / F-Diag)
- `extensions/fan-super-orchestrator/test/helpers/mock-fan-server.ts` (H)

**Новые тесты (9 файлов, ~27 теста):**
- `packages/api-gateway/test/transport-smoke.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/role-loader.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/width-pyramid.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/port-registry.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/spawn-protocol.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/lineage-escalation.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/verify-subtree.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/diagnostics.test.ts` (3 теста)
- `extensions/fan-super-orchestrator/test/e2e/depth-2-smoke.test.ts` + depth-4.test.ts + walk-up.test.ts + width.test.ts (4 e2e)

---

## Фазы vs. Фичи: маппинг

Из SPEC §9:

| Phase SPEC | Feature roadmap | Приоритет | Статус |
|---|---|---|---|
| 0 | F-0 | P0 | ☐ |
| A | — | — | ✅ (SPEC написан, коммит `45c69b3`) |
| B | F-B | P1 | ☐ |
| C | F-C | P1 | ☐ |
| D | F-D | P1 | ☐ |
| E | F-E | P2 | ☐ |
| F | F-F | P2 | ☐ |
| H | F-H | P3 | ☐ |
| I | F-Diag | P2 | ☐ |

---

## Открытые вопросы (для следующих итераций)

Из SPEC §10 (НЕ включены в roadmap, остаются как future):
- **Observer** — отдельный узел для E2E координирования
- **Per-role spawn limits** — если узкоспециализированные профили начнут конкурировать за ресурсы
- **Cross-mission coordination** — общий Coordinator для нескольких миссий
- **Динамическое расширение каталога** через FAN Store
- **Динамическая балансировка ширины** по фактическому потреблению
- **Hot-reload каталога ролей** без перезапуска
- **Cross-process port visibility** — file-locking vs SQLite (Open Issue, реализация в F-C)
- **Port range exhaustion** — если миссия исчерпала свой range (depth-4 × 8 = больше 100) — нужен overflow в следующий range (расширяемый pool). Out of scope для v2.
- **Webhook port isolation** — webhook трафик может быть sensitive (Telegram tokens); проверять что webhook range не пересекается с API range при allocation. Out of scope для v2 (уже решено в §12 — webhook 9090-9189 + API 7001-7100 не пересекаются).

Все эти вопросы будут вынесены в отдельные фичи после стабилизации v2.