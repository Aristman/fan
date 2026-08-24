# Roadmap: Recursive Orchestrator Spawn (depth-4 в реальных процессах)

> **Дата генерации:** 2026-08-22
> **Источник:** `docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md` (500 строк, 15 секций)
> **Версия SKILL:** 1.3.0
> **Функций / Этапов:** 6 / 6 (лимит: 15 / 8)
**Версия:** 0.1.0 (Шипчено: 2026-08-22)
**Статус:** ✅ Все 6 функций реализованы и закоммичены

> ⚠️ **Предупреждения:** нет. 60% инфраструктуры уже реализовано в depth-4 v2 pipeline (commits `c985dbb`...`cf5879f`, branch `FAN/feature/super-orchestrator-v2`).

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 6 |
| Этапов | 6 |
| P0 (критические) | 3 |
| P1 (высокие) | 3 |
| P2 (средние) | 0 |
| P3 (низкие) | 0 |

## Легенда

- ✅ — Реализовано
- ☐ — Запланировано
- ⏳ — В работе
- ❌ — Заблокировано

### Приоритеты
- **P0** — Критично (без этого фича не имеет смысла)
- **P1** — Высокий (важно для большинства пользователей)
- **P2** — Средний (полезно, но не срочно)
- **P3** — Низкий (future enhancement)

### Слои архитектуры
- **[API]** — Backend endpoint / RPC / middleware
- **[UI]** — React-компонент / страница / форма
- **[DATA]** — Модель / миграция / схема
- **[INTEG]** — Интеграция с внешним сервисом
- **[BIZ]** — Бизнес-правило / процесс
- **[CLI]** — Команда / скрипт

---

## Этап 1: Role-aware process spawn

**Цель:** `process-manager.spawn()` принимает `role: "worker" | "super-orchestrator"` и передаёт `FAN_NODE_ROLE` через env дочернему процессу. Backward-compat: default role=worker сохраняет существующее поведение.

**Приоритет функций:** P0
**E2E-сценарий этапа:** Spawn SO с role=super-orchestrator → env содержит `FAN_NODE_ROLE=super-orchestrator`, `FAN_NODE_ROLE_PROFILE=pm`, `FAN_PARENT_NODE_URL/TOKEN`, `FAN_ORCHESTRATOR_DEPTH=N+1`. Spawn worker без role (default) → env НЕ содержит `FAN_NODE_ROLE`. Проверка через `child_process.spawn` mock (env var captures).
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/role-spawn.test.mjs → 6 pass`. Все существующие worker-spawn тесты не сломаны (back-compat).

#### ✅ F-1: Role-aware spawn в process-manager
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Расширить `process-manager.spawn()` параметром `role: "worker" | "super-orchestrator"` (default `"worker"`). Добавить env vars `FAN_NODE_ROLE`, `FAN_NODE_ROLE_PROFILE`, `FAN_PARENT_NODE_URL`, `FAN_PARENT_NODE_TOKEN`. Worker spawn (default) сохраняет существующее поведение. SO spawn передаёт дополнительные env vars для recursive wiring.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F1-1:** Worker spawn (default, role не указан) НЕ содержит `FAN_NODE_ROLE` в env
    - *Условие:* `SpawnOptions { port: 7001, host: "127.0.0.1" }` без поля `role`
    - *Шаги:* mock `cpSpawn`, вызвать `processManager.spawn()`, проверить `opts.env`
    - *Ожидаемый результат:* `opts.env.FAN_NODE_ROLE === undefined`, остальные env vars (FAN_NODE_TOKEN, FAN_NO_AUTH, FAN_ORCHESTRATOR_DEPTH) присутствуют
  - [ ] **TC-F1-2:** SO spawn содержит `FAN_NODE_ROLE=super-orchestrator` + `FAN_NODE_ROLE_PROFILE=<id>` + `FAN_PARENT_NODE_URL=<parent_url>`
    - *Условие:* `SpawnOptions { role: "super-orchestrator", roleProfile: "pm", parentUrl: "http://127.0.0.1:7001", parentToken: "tok", port: 7002 }`
    - *Шаги:* mock `cpSpawn`, вызвать `processManager.spawn()`, проверить env
    - *Ожидаемый результат:* `opts.env.FAN_NODE_ROLE === "super-orchestrator"`, `FAN_NODE_ROLE_PROFILE === "pm"`, `FAN_PARENT_NODE_URL === "http://127.0.0.1:7001"`, `FAN_PARENT_NODE_TOKEN === "tok"`
  - [ ] **TC-F1-3:** `buildSpawnEnv` включает `FAN_NODE_ROLE` только при `opts.role === "super-orchestrator"` (защита от leak в worker spawn)
    - *Условие:* модуль `process-manager.ts`, функция `buildSpawnEnv`
    - *Шаги:* вызвать с `(opts, parentDepth)` для role=undefined, role=worker, role=super-orchestrator
    - *Ожидаемый результат:* role=undefined и role=worker → env без `FAN_NODE_ROLE`; role=super-orchestrator → env с `FAN_NODE_ROLE`
- **Red-тест:** TC-F1-1 — до реализации worker spawn (existing) тоже содержит FAN_NODE_ROLE если новый env vars добавляются безусловно; тест должен упасть, подтверждая что нужно условное добавление.
- **Критерии приёмки:**
  1. Worker spawn без role сохраняет существующее env (FAN_NODE_TOKEN, FAN_NO_AUTH=0, FAN_ORCHESTRATOR_DEPTH), без FAN_NODE_ROLE/FAN_NODE_ROLE_PROFILE/FAN_PARENT_NODE_URL/FAN_PARENT_NODE_TOKEN
  2. SO spawn с role=super-orchestrator добавляет все 4 новых env vars, остальные сохраняются
  3. Существующие 716+ super-orch tests PASS без модификаций (back-compat)
- **Refactor-цели:** Выделить `buildRoleEnv(opts: SpawnRoleOpts): NodeJS.ProcessEnv` в отдельный helper; объединить существующий `buildSpawnEnv` + новый через композицию
- **Ожидаемый результат:** `extensions/fan-super-orchestrator/process-manager.ts` расширен; `test/role-spawn.test.mjs` NEW (3 теста); существующие тесты PASS
- **Оценка объёма:** M (≤ 1 день)

---

## Этап 2: Role profile schema extension

**Цель:** `RoleProfile` interface расширен полем `default_extensions`, YAML loader валидирует, deep merge применяется, role-config defaults (exclusions для store + required для SO) применяются.

**Приоритет функций:** P1
**E2E-сценарий этапа:** Загрузить role profile `pm.yaml` с `default_extensions: [mission, scheduler, delegate_task]`. Если в role-config.excluded есть `mission` → финальный список = `[scheduler, delegate_task]`. Если role=super-orchestrator → к финальному списку добавляется `delegate_task` (always required).
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/role-extensions.test.mjs → 6 pass`. Все 14 role-loader tests не сломаны.

#### ✅ F-2: Role profile `default_extensions` + exclusions config
- **Приоритет:** P1
- **Слой:** [DATA]
- **Описание:** Расширить `RoleProfile` interface полем `default_extensions?: string[]`. В `loadRoleCatalog` при merge учитывать LIST_CONCAT для `default_extensions`. Добавить `role-config.yaml` (или .json) с `spawn.excluded_extensions` (default: `[store_search, store_install]`) и `role.super-orchestrator.required_extensions` (default: `[delegate_task]`). Функция `getEffectiveExtensions(role, config)` возвращает финальный список extensions для spawned узла.
- **Зависимости:** F-1
- **TDD-тесты:**
  - [ ] **TC-F2-1:** Role profile с `default_extensions` парсится корректно
    - *Условие:* YAML файл `pm.yaml` с `default_extensions: [mission, scheduler, delegate_task]`
    - *Шаги:* `loadRoleCatalog({ defaultDir: ... })`, `getRoleProfile(catalog, "pm")`
    - *Ожидаемый результат:* `profile.default_extensions === ["mission", "scheduler", "delegate_task"]`
  - [ ] **TC-F2-2:** Excluded extensions удаляются из role.default_extensions
    - *Условие:* role=pm с `default_extensions: [mission, scheduler, store_search, delegate_task]`; config=`{ excluded: [store_search, store_install] }`
    - *Шаги:* `getEffectiveExtensions(role, config)`
    - *Ожидаемый результат:* `result === ["mission", "scheduler", "delegate_task"]` (store_search удалён, store_install не было)
  - [ ] **TC-F2-3:** Required extensions для super-orchestrator добавляются
    - *Условие:* role=pm с `default_extensions: [mission]` (БЕЗ delegate_task); role.type=super-orchestrator; config=`{ required: [delegate_task] }`
    - *Шаги:* `getEffectiveExtensions(role, config)`
    - *Ожидаемый результат:* `result.includes("delegate_task") === true`, остальные из role.default_extensions присутствуют
- **Red-тест:** TC-F2-2 — без exclusions config `getEffectiveExtensions` возвращает весь role.default_extensions (включая store_search, что нежелательно); тест должен упасть, подтверждая что exclusions применяются.
- **Критерии приёмки:**
  1. `RoleProfile.default_extensions` опционально, default `undefined`, при наличии — массив строк
  2. `getEffectiveExtensions(role, config)` возвращает финальный список с применёнными exclusions и required для роли
  3. Deep merge по `default_extensions` корректно работает (LIST_CONCAT с dedup)
- **Refactor-цели:** Выделить `role-config.ts` (или .yaml loader) в отдельный модуль; default config in-code если файл отсутствует (back-compat)
- **Ожидаемый результат:** `extensions/fan-super-orchestrator/role-loader.ts` расширен; `extensions/fan-super-orchestrator/role-config.ts` NEW; `test/role-extensions.test.mjs` NEW (3 теста); существующие14 role-loader tests PASS
- **Оценка объёма:** M (≤ 1 день)

---

## Этап 3: HTTP delegation endpoint в api-gateway

**Цель:** `POST /api/mission-delegate` в api-gateway, авторизация через `FAN_NODE_TOKEN`, делегирует в `api.events.emit("mission_delegate", payload)` для текущего fan server процесса.

**Приоритет функций:** P0
**E2E-сценарий этапа:** Spawn mock SO с `FAN_NODE_TOKEN=test-token`. Parent отправляет `POST /api/mission-delegate` с `Authorization: Bearer test-token`, payload с `packages`. Endpoint emit `mission_delegate` event, in-process handler ловит. Response: 200 + ack. Без токена — 401. С невалидным payload — 400.
**Smoke-критерий этапа:** `bun test packages/api-gateway/test/mission-delegate-endpoint.test.ts → 4 pass`. Все 143 api-gateway tests не сломаны.

#### ✅ F-3: HTTP delegation endpoint `POST /api/mission-delegate`
- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Добавить endpoint `POST /api/mission-delegate` в `packages/api-gateway/src/http-server.ts`. Авторизация через `Authorization: Bearer <FAN_NODE_TOKEN>` (сравнивается с `process.env.FAN_NODE_TOKEN`). Payload: `{ parentCorrelationId, role, role_profile, depth, packages, lineage, parentReportId }`. Emit `api.events.emit("mission_delegate", payload)`. Response: 200 с `{ status: "queued", parentReportId }` или 202 (accepted).
- **Зависимости:** F-1
- **TDD-тесты:**
  - [ ] **TC-F3-1:** Endpoint принимает delegation с валидным token
    - *Условие:* `process.env.FAN_NODE_TOKEN = "test-token"`, request: `POST /api/mission-delegate` с `Authorization: Bearer test-token`, payload = `{ parentReportId: "rep-1", packages: [...] }`
    - *Шаги:* отправить через `fetch`, проверить response
    - *Ожидаемый результат:* status 200, body `{ status: "queued", parentReportId: "rep-1" }`, в EventBus emit'нут event `mission_delegate`
  - [ ] **TC-F3-2:** Endpoint отклоняет request без токена
    - *Условие:* request без `Authorization` header
    - *Шаги:* `fetch` без header
    - *Ожидаемый результат:* status 401, body `{ error: "missing_token" }`
  - [ ] **TC-F3-3:** Endpoint отклоняет невалидный token
    - *Условие:* request с `Authorization: Bearer wrong-token`
    - *Шаги:* `fetch` с неверным токеном
    - *Ожидаемый результат:* status 401, body `{ error: "invalid_token" }`
  - [ ] **TC-F3-4:** Endpoint валидирует payload schema
    - *Условие:* request с `parentReportId: "valid"` но `packages: "not-array"` (должен быть массив)
    - *Шаги:* `fetch` с невалидным payload
    - *Ожидаемый результат:* status 400, body `{ error: "invalid_payload", field: "packages" }`
- **Red-тест:** TC-F3-1 — без endpoint handler request уходит в 404; тест должен упасть, подтверждая что endpoint нужно добавить.
- **Критерии приёмки:**
  1. Endpoint зарегистрирован в api-gateway до `app.use("/api/*", tokenAuth)` (как health endpoint — no-auth для super-orchestrator'ов)
  2. Авторизация через `Authorization: Bearer <token>`, сравнение с `FAN_NODE_TOKEN` env var (constant-time)
  3. Payload содержит обязательные поля: `parentReportId`, `packages`. Опциональные: `parentCorrelationId`, `role`, `role_profile`, `depth`, `lineage`
- **Refactor-цели:** Выделить валидацию payload в `mission-delegate-schema.ts`; выделить token verification в `auth-mission-delegate.ts`
- **Ожидаемый результат:** `packages/api-gateway/src/http-server.ts` extended; `packages/api-gateway/test/mission-delegate-endpoint.test.ts` NEW (4 теста); существующие 143 api-gateway tests PASS
- **Оценка объёма:** M (≤ 1 день)

---

## Этап 4: Role-aware launchChild в depth2-integration

**Цель:** `launchChild` в `depth2-integration.ts` принимает `role` из work-package, при role=super-orchestrator вызывает HTTP delegation вместо in-process worker spawn (existing path).

**Приоритет функций:** P1
**E2E-сценарий этапа:** Mock depth-2 integration с work-package `{ role: "super-orchestrator", role_profile: "pm", depth: 1, packages: [...] }`. Вызвать `launchChild`. Ожидаем: HTTP POST на `/api/mission-delegate` (mock fetch проверяет URL и payload), NOT worker spawn (`cpSpawn` не вызван). Mock response — 200 + ack. Для worker role — existing path (cpSpawn для `fan server`).
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/role-launch-child.test.mjs → 5 pass`. 35 existing depth2-integration tests PASS.

#### ✅ F-4: Role-aware launchChild (HTTP для SO, spawn для worker)
- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** Расширить `Depth2SpawnOpts` полем `role` (from work-package). В `launchChild` switch: role=worker → existing `process-manager.spawn()` (back-compat). role=super-orchestrator → HTTP POST `/api/mission-delegate` через переиспользованный `child-node-client.ts`. Tree-journal spawn entry: `via: "spawn" | "http_delegate"`.
- **Зависимости:** F-1, F-3
- **TDD-тесты:**
  - [ ] **TC-F4-1:** Worker role launchChild → process-manager.spawn (existing path)
    - *Условие:* `Depth2SpawnOpts { role: "worker", depth: 2, ... }`
    - *Шаги:* mock `processManager.spawn` + mock `fetch`, вызвать `launchChild`
    - *Ожидаемый результат:* `processManager.spawn` вызван 1 раз с портом из registry; `fetch` НЕ вызван; journal spawn entry `via: "spawn"`
  - [ ] **TC-F4-2:** SO role launchChild → HTTP delegation (no process spawn)
    - *Условие:* `Depth2SpawnOpts { role: "super-orchestrator", role_profile: "pm", depth: 1, packages: [...] }`
    - *Шаги:* mock `fetch` (POST `/api/mission-delegate`), mock `processManager.spawn`, вызвать `launchChild`
    - *Ожидаемый результат:* `fetch` вызван 1 раз с правильным URL/payload/Authorization; `processManager.spawn` НЕ вызван; journal spawn entry `via: "http_delegate"`
  - [ ] **TC-F4-3:** SO role без role_profile → REFUSED (mandatory field)
    - *Условие:* `Depth2SpawnOpts { role: "super-orchestrator", depth: 1 }` (нет role_profile)
    - *Шаги:* вызвать `launchChild`
    - *Ожидаемый результат:* throws `Error("role_profile required for super-orchestrator")`; ни spawn, ни HTTP
- **Red-тест:** TC-F4-2 — без role-aware switch SO launchChild пытается spawn `fan server` (existing path); тест должен упасть, подтверждая что нужен HTTP path для SO.
- **Критерии приёмки:**
  1. Worker role: existing flow без изменений (process-manager.spawn для `fan server`)
  2. SO role: HTTP POST `/api/mission-delegate` через `child-node-client.ts` с правильным payload и `Authorization: Bearer <token>`
  3. Tree-journal корректно записывает `via: "spawn"` для worker, `via: "http_delegate"` для SO
- **Refactor-цели:** Выделить role-routing в `routes/launch-child.ts` для лучшей тестируемости
- **Ожидаемый результат:** `extensions/fan-super-orchestrator/depth2-integration.ts` extended; `test/role-launch-child.test.mjs` NEW (3 теста); 35 existing tests PASS
- **Оценка объёма:** L (≤ 2 дня)

---

## Этап 5: Spawned SO wiring в session_start

**Цель:** При `FAN_NODE_ROLE=super-orchestrator` в session_start hook инициализировать recursive SO wiring: register `/api/mission-delegate` listener (через api-gateway endpoint), init circuit (mission-loop lite, tree-journal, budget), загрузить role profile, register delegate handler через `child-node-client`.

**Приоритет функций:** P0
**E2E-сценарий этапа:** Spawn mock fan server с env `FAN_NODE_ROLE=super-orchestrator`. В `session_start` hook создаётся circuit (missionDir, journal), register handler для `mission_delegate` event. После init, parent отправляет POST `/api/mission-delegate` → handler срабатывает → emit processed event → response ack.
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/spawned-so-wiring.test.mjs → 5 pass`. 821 super-orch tests не сломаны.

#### ✅ F-5: Spawned SO init в session_start (recursive wiring)
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** В `extensions/fan-super-orchestrator/index.ts` session_start hook: проверить `process.env.FAN_NODE_ROLE`. Если `super-orchestrator` → recursive init: (a) init circuit (mission-loop lite, tree-journal, budget aggregator), (b) register delegate handler `api.events.on("mission_delegate", handleDelegateRecursive)`, (c) load role profile через `loadRoleCatalog` (d) init `child-node-client` для отправки дочерним worker'ам. Если role=worker или undefined → existing path (no changes).
- **Зависимости:** F-1, F-2, F-3, F-4
- **TDD-тесты:**
  - [ ] **TC-F5-1:** Spawned SO init создаёт circuit при `FAN_NODE_ROLE=super-orchestrator`
    - *Условие:* mock api с `ctx.env.FAN_NODE_ROLE = "super-orchestrator"`, mock `loadRoleCatalog`
    - *Шаги:* вызвать session_start handler
    - *Ожидаемый результат:* `circuit` создан с `missionDir`, `journal`, `unsubDelegate`; `handleDelegateRecursive` зарегистрирован в api.events
  - [ ] **TC-F5-2:** Spawned SO register delegate handler через api.events
    - *Условие:* session_start handler вызван для SO
    - *Шаги:* emit test event `mission_delegate` через mock api.events
    - *Ожидаемый результат:* handler вызван с правильным payload, response через `mission_delegate_result:<id>` (если есть ack mechanism)
  - [ ] **TC-F5-3:** Spawned SO init загружает role profile
    - *Условие:* `FAN_NODE_ROLE=super-orchestrator`, `FAN_NODE_ROLE_PROFILE=pm`
    - *Шаги:* вызвать session_start handler, проверить что role-loader вызван
    - *Ожидаемый результат:* `loadRoleCatalog` вызван с правильными путями; profile "pm" доступен через `getRoleProfile`
  - [ ] **TC-F5-4:** Worker role (`FAN_NODE_ROLE=worker` или undefined) НЕ инициализирует recursive wiring
    - *Условие:* `ctx.env.FAN_NODE_ROLE = "worker"`
    - *Шаги:* вызвать session_start handler
    - *Ожидаемый результат:* existing flow (без recursive init); circuit может быть инициализирован (existing поведение), но без recursive delegate handler
  - [ ] **TC-F5-5:** Spawned SO abort propagation (kill-switch recursive)
    - *Условие:* session_start завершён, spawned SO работает; parent получает SIGTERM
    - *Шаги:* вызвать `circuit.abort()`, дождаться cleanup
    - *Ожидаемый результат:* spawned SO graceful shutdown, journal `abort` event, no hanging processes
- **Red-тест:** TC-F5-1 — без role check session_start НЕ создаёт recursive circuit для spawned SO; тест должен упасть, подтверждая что нужен conditional init.
- **Критерии приёмки:**
  1. `session_start` в `index.ts` проверяет `FAN_NODE_ROLE` env, branching на recursive vs existing flow
  2. Recursive init создаёт circuit (missionDir, journal, budget aggregator) + register delegate handler + load role profile
  3. Worker role path unchanged (back-compat с existing 716+ tests)
  4. Abort propagation работает для spawned SO (graceful shutdown ≤1с)
- **Refactor-цели:** Выделить recursive init в `wiring/spawned-orchestrator.ts`; existing init оставить в `initCircuit`
- **Ожидаемый результат:** `extensions/fan-super-orchestrator/index.ts` extended; `wiring/spawned-orchestrator.ts` NEW; `test/spawned-so-wiring.test.mjs` NEW (5 тестов); 821 existing super-orch tests PASS
- **Оценка объёма:** L (≤ 2 дня)

---

## Этап 6: Integration test (depth-4 e2e с реальными spawned chain)

**Цель:** E2E тест с реальными spawned fan server процессами: Coordinator (real) → spawned SO (real, depth=1) → spawned SO (real, depth=2) → spawned worker (real, depth=3). Проверить: tree-journal цепочка, lineage escalation при crash, graceful shutdown всей цепочки.

**Приоритет функций:** P0
**E2E-сценарий этапа:** Test setup: запустить 3 spawned fan server процесса (depth 1, 2, 3). Parent (mock) отправляет delegation в depth=1. depth=1 спавнит depth=2 через HTTP. depth=2 спавнит worker через process-manager. Worker выполняет задачу, отправляет report вверх по chain. Проверка: tree-journal.jsonl содержит 3 spawn entries + 3 complete entries с правильными parent_id.
**Smoke-критерий этапа:** `bun test extensions/fan-super-orchestrator/test/e2e/recursive-spawn.test.mjs → 3 pass`. Все остальные tests не сломаны.

#### ✅ F-6: Integration test (depth-4 chain с recursive spawned SO)
- **Приоритет:** P0
- **Слой:** [TEST]
- **Описание:** E2E тест с реальными `fan server` subprocess: depth-1 SO спавнит depth-2 SO (recursive), который спавнит worker. Mock-children infrastructure (existing из F-H phase в depth-4 v2 pipeline) переиспользуется. Тесты: (a) full depth-4 happy path, (b) crash mid-chain → walk-up escalation, (c) graceful shutdown всей цепочки.
- **Зависимости:** F-1, F-2, F-3, F-4, F-5
- **TDD-тесты:**
  - [ ] **TC-F6-1:** Depth-4 happy path: spawned chain (Coord → SO → SO → worker)
    - *Условие:* 4 mock fan server processes (ports 7101-7104), env FAN_NODE_ROLE super-orchestrator для 7101, 7102
    - *Шаги:* parent отправляет delegation в 7101; ждать chain propagation; verify tree-journal entries
    - *Ожидаемый результат:* 3 spawn entries (coordinator→so1, so1→so2, so2→worker); 3 complete entries; total cost aggregated
  - [ ] **TC-F6-2:** Crash mid-chain → walk-up escalation через lineage
    - *Условие:* chain spawned; spawn SO depth=2 crashes mid-delegation
    - *Шаги:* initiate delegation; SIGKILL depth=2 process; verify walk-up to depth=1 → coordinator
    - *Ожидаемый результат:* walk-up attempts delivery to depth=1 → 200 OK; if depth=1 fails → orphan-report written; recovery на coordinator session_start
  - [ ] **TC-F6-3:** Graceful shutdown всей цепочки
    - *Условие:* 4 spawned processes работают
    - *Шаги:* abort parent; дождаться завершения children
    - *Ожидаемый результат:* все 4 процесса завершились ≤1с; journals корректные; no hanging ports
- **Red-тест:** TC-F6-1 — без recursive SO wiring spawned SO на depth=1 не может спавнить следующего SO (existing depth-2 spawn только worker); тест должен упасть, подтверждая что recursive работает.
- **Критерии приёмки:**
  1. Real `fan server` subprocesses спавнятся через process-manager, depth-2 SO через HTTP delegation
  2. Tree-journal содержит полную chain (3 spawn + 3 complete entries с правильными parent_id)
  3. Walk-up escalation работает через lineage при crash любого узла
  4. Graceful shutdown пропагируется через всю цепочку ≤1с
- **Refactor-цели:** Переиспользовать `test/helpers/mock-fan-server.mjs` (existing из F-H) с дополнительной поддержкой FAN_NODE_ROLE env var
- **Ожидаемый результат:** `test/e2e/recursive-spawn.test.mjs` NEW (3 теста); CI integration; flaky mitigation (retry 2x, timeout 2x на Windows)
- **Оценка объёма:** L (≤ 2 дня)

---

## Полный чеклист по приоритетам

### P0 — Критические
- [x] F-1 [INTEG]: Role-aware spawn в process-manager (env vars) — ✅ c39566e
- [x] F-3 [API]: HTTP delegation endpoint `POST /api/mission-delegate` — ✅ c29c049
- [x] F-5 [INTEG]: Spawned SO init в session_start (recursive wiring) — ✅ 7912684
- [x] F-6 [TEST]: Integration test (depth-4 e2e с recursive spawned SO) — ✅ a086aa0

### P1 — Высокие
- [x] F-2 [DATA]: Role profile `default_extensions` + exclusions config — ✅ 14ea4ef
- [x] F-4 [INTEG]: Role-aware launchChild в depth2-integration — ✅ 2504946

### P2 — Средние
(нет)

### P3 — Низкие
(нет)

---

## Граф зависимостей

```
F-1 (env vars)
├─→ F-2 (role profile schema)        ──┐
├─→ F-3 (HTTP endpoint)               ──┼─→ F-5 (session_start wiring) ──→ F-6 (e2e test)
└─→ F-4 (launchChild routing)         ──┘                                       ↑
                                                                                 │
                                  Все → F-6 ←────────────────────────────────────┘
```

**Текстовое представление:**
- F-1 ← (none)
- F-2 ← F-1
- F-3 ← F-1
- F-4 ← F-1, F-3
- F-5 ← F-1, F-2, F-3, F-4
- F-6 ← F-1, F-2, F-3, F-4, F-5 (все)

**Проверка на циклы:** DAG, нет циклов.

---

## Делегирование

- Сгенерировано из родительской спецификации: `docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md`
- Дочерние roadmap-ы не требуются (фича атомарна, 6 этапов в пределах лимитов)
- **Связь с другими roadmap'ами:**
  - `docs/features/super-orchestrator-v2/roadmap.md` — depth-4 v2 (8 фич, реализован). Эта фича (F-6) естественно следует за v2.
  - `docs/backlogs/headless-mission-mode-backlog.md` — headless mode (отдельная фича, может комбинироваться)

---

## Подготовка к feature-pipeline

Roadmap готов. Для запуска TDD-pipeline нужен feature-pipeline skill:

```
/skill:feature-pipeline docs/features/recursive-orchestrator-spawn/roadmap.md
```

**Ожидаемая последовательность (6 features × 5 TDD-шагов = 30 delegate_task):**

1. F-1 (Red → Green → Verify → Refactor → Commit) — ~1 день
2. F-2 + F-3 parallel (no inter-deps) — ~1 день (если параллельно)
3. F-4 (depends on F-3) — ~2 дня
4. F-5 (depends on F-4) — ~2 дня
5. F-6 (depends on F-5) — ~2 дня
6. Verify final + Smoke + Docs — ~1 день

**Total estimate:** 9-10 дней с тестами и docs.

**Branch:** `FAN/feature/recursive-orchestrator-spawn` (от текущего `FAN/feature/new-agents-flow` с уже merged depth-4 v2).