# Spec: Recursive Orchestrator Spawn (depth-4 в реальных процессах)

> **Дата:** 2026-08-22
> **Статус:** предложено
> **Приоритет:** P1
> **Источник:** запрос пользователя (после live-testing incident EPIC delegation, 2026-08-22)
> **Связанные:** `docs/features/super-orchestrator-v2/architecture.md` (depth-4 SPEC, 840 строк), `docs/specs/spec_super-orchestrator_v3_2026-08-10.md` (depth-2 SPEC), `docs/backlogs/headless-mission-mode-backlog.md` (смежная фича)

---

## Обзор

### Цель

Сделать super-orchestrator узлом, который может быть **spawn'ен как полноценный `fan server` subprocess** (наравне с worker'ами), сохраняя способность рекурсивно спавнить своих детей (worker'ов и других super-orchestrators) — до жёсткого cap depth=4.

Это финализирует архитектуру depth-4 (уже специфицированную в `architecture.md`), превращая её из теоретической конструкции в реальную цепочку процессов.

### Контекст

**Текущее состояние:**
- Worker spawn работает: `process-manager.ts` спавнит `fan server --port N`, передаёт `FAN_ORCHESTRATOR_DEPTH = current+1` через env.
- Super-orchestrator работает **in-process**: `extensions/fan-super-orchestrator/index.ts` подписан на `mission_delegate` через EventBus, обрабатывает делегации в том же `fan.exe` процессе, что и mission-loop.
- Реальные EPIC делегации спавнят **только worker'ов**, не других super-orchestrators.
- depth-4 в `architecture.md` описан концептуально, но рекурсивный SO spawn **не реализован**.

**Проблема:**
- EPIC с вложенными EPIC (EPIC → EPIC → work) невозможен — текущий код спавнит только worker'ов.
- Нет горизонтального масштабирования: один SO на parent node обрабатывает все делегации, что лимитирует throughput.
- Долгоживущие миссии (например, EPIC на 50 подзадач за 2 недели) не могут быть распараллелены через несколько SO узлов.

### Решение

Расширить существующий `process-manager.ts` и `depth2-integration.ts` чтобы super-orchestrator мог быть spawn'ен как полноценный `fan server` subprocess, с:

- Role-aware spawn (через env `FAN_NODE_ROLE=worker|super-orchestrator`)
- Configurable tool manifest через `role_profile.default_extensions` — какие инструменты доступны spawned узлу
- HTTP REST + WebSocket delegation transport (переиспользовать `child-node-client.ts`)
- Жёсткий recursion cap depth=4 в `can-spawn-batch.ts`

---

## Функциональные требования

### F-1: Role-aware process spawn

**Описание:** `process-manager.spawn()` должен принимать `role` параметр и передавать `FAN_NODE_ROLE` через env дочернему процессу.

**Поведение:**
- `role=worker` (default) → существующее поведение (sink, depth≤4, текущий tool manifest)
- `role=super-orchestrator` → spawned fan server инициализирует super-orchestrator wiring (init circuit, mission_delegate handler, role-loader, can-spawn-batch)

**Env vars передаваемые при spawn:**
```
FAN_NODE_ROLE=worker|super-orchestrator          # NEW
FAN_NODE_ROLE_PROFILE=<id>                       # NEW (e.g. "pm", "architect")
FAN_NODE_TOKEN=<random>                          # existing
FAN_ORCHESTRATOR_DEPTH=N                         # existing
FAN_NO_AUTH=0                                    # existing
FAN_PARENT_NODE_URL=http://host:port             # NEW — для обратной связи
FAN_PARENT_NODE_TOKEN=<random>                   # NEW
FAN_MISSION_DIR=/path/to/mission                 # existing
```

**Сценарии:**
- Mission-loop спавнит SO (depth=1) для EPIC делегации
- SO спавнит worker (depth=2) для подзадачи
- SO спавнит SO (depth=2) для вложенного EPIC (recursive)
- SO на depth=3 спавнит только worker (depth=4 = hard cap, не может spawnить SO на depth=5)

**Бизнес-правила:**
- Hard cap depth=4 enforced в `canSpawnBatch` (NEW rule `super_orch_at_max_depth` для depth=4)
- Width limits per depth (8/6/4/2 working, 12/10/8/4 max) enforced same place
- Total node cap 100 (global port registry)

### F-2: Configurable tool manifest для SO

**Описание:** Role profile может определить `default_extensions` — список инструментов, которые spawned узел получит. Это позволяет exclude sensitive tools (store, ops) из spawned SO процессов.

**Schema role profile (extension существующего `role-loader.ts`):**
```yaml
id: pm
description: Project manager role
allowed_depths: [1]
default_extensions:
  - mission       # core mission tools
  - scheduler     # scheduling tools
  - delegate_task # NEW — must be in spawned SO
  # НЕ включаем: store_search, store_install, ops_* — security boundary
default_tools: [read, write, edit]
extends: fullstack
verification_approach: standard
```

**Поведение:**
- Spawned SO получает только `default_extensions` + `default_tools` из role profile
- Если `default_extensions` отсутствует в role profile → fallback to standard worker tool set (без delegate_task)
- `default_extensions` + `default_tools` объединяются при spawn (не дублируются)
- Hard-coded allow-list остаётся в `ALLOWED_TOOLS` (tool-manifest.ts), role profile не может добавить инструмент вне allow-list

**Бизнес-правила:**
- Для role `super-orchestrator` всегда inject `delegate_task` (security audit point — SO без delegate_task не имеет смысла)
- `store_*` инструменты НЕ передаются spawned узлам (security boundary — parent fan не должен давать child полный доступ к FAN Store)
- Если role не имеет `default_extensions` → spawned node получит минимальный набор (только что в `default_tools`)

**Default exclusions (для первой итерации):**
- `store_search`, `store_install` — security boundary, parent only
- `ops_*` — операционные инструменты (если появятся), parent only

### F-3: HTTP REST + WebSocket delegation transport

**Описание:** При спавне SO создаётся endpoint `/api/mission-delegate` в api-gateway дочернего fan server. Parent отправляет delegation packages через POST на этот endpoint, child отвечает через WS `mission_delegate_result:<id>`.

**Reuse:** Переиспользовать существующий `child-node-client.ts` (L0 → L1 REST + WS). Расширить его для работы с SO узлами.

**Protocol:**
```
# Parent → spawned SO (POST)
POST /api/mission-delegate HTTP/1.1
Authorization: Bearer <FAN_PARENT_NODE_TOKEN>
Content-Type: application/json

{
  "parentCorrelationId": "parent-corr-id",
  "role": "super-orchestrator",
  "role_profile": "pm",
  "depth": 1,
  "packages": [
    { "task": "...", "tokenBudget": 5000, "toolManifest": [...] }
  ],
  "lineage": [ /* ancestor entries */ ],
  "parentReportId": "<uuid>"
}

# Spawned SO → Parent (WebSocket event)
WS /api/ws/<sessionId>
{ "type": "mission_delegate_result",
  "parentReportId": "<uuid>",
  "fromCorrelationId": "child-corr-id",
  "results": [ ... ],
  "totalUsage": { "tokens": ..., "usd": ... } }
```

**Сценарии:**
- Parent spawn SO, ждёт ready (poll /api/health), POST delegation
- SO на d=1 спавнит worker через process-manager (existing) **ИЛИ** SO на d=2 через тот же flow (recursive)
- Ответы через WS, parent получает `mission_delegate_result` event, integrate в budget

**Бизнес-правила:**
- Per-hop timeout 30s (existing in walk-up.ts)
- Idempotency по `parentReportId`
- WebSocket reconnect с exponential backoff (1s, 5s, 30s) — existing в child-node-client
- Walk-up protocol через lineage (existing в walk-up.ts) — если spawned SO не отвечает, escalate to parent.parent

### F-4: Config file для SO exclusions

**Описание:** Default exclusions (store, etc.) определяются в config файле, чтобы можно было изменять без правки кода.

**Файл:** `extensions/fan-super-orchestrator/role-config.toml` (или .json, .yaml — решим в реализации)

```toml
# Default extensions NOT inherited by spawned nodes (security boundary)
[spawn.excluded_extensions]
default = [
  "store_search",
  "store_install",
]

# Default extensions ALWAYS injected for super-orchestrator role
[role.super-orchestrator.required_extensions]
default = [
  "delegate_task",
]

# Width pyramid (existing в width-pyramid.ts, см. SPEC §5)
[width]
working = { 1 = 8, 2 = 6, 3 = 4, 4 = 2 }
max     = { 1 = 12, 2 = 10, 3 = 8, 4 = 4 }
max_depth = 4
```

**Поведение:**
- При загрузке role profile: исключить `excluded_extensions` из `default_extensions` для spawned SO
- Добавить `required_extensions` для role=super-orchestrator
- Если config отсутствует → hard-coded defaults (back-compat)

### F-5: Integration с существующим flow

**Изменения в существующем коде (минимальные, additive):**

1. **`process-manager.ts`** (extensions/fan-super-orchestrator/):
   - Расширить `SpawnOptions` полем `role: "worker" | "super-orchestrator"` (default "worker")
   - В `buildSpawnEnv` добавить `FAN_NODE_ROLE`, `FAN_NODE_ROLE_PROFILE`, `FAN_PARENT_NODE_URL`, `FAN_PARENT_NODE_TOKEN`
   - Backward-compat: default role=worker сохраняет существующее поведение

2. **`depth2-integration.ts`** (extensions/fan-super-orchestrator/):
   - В `launchChild` принимать `role` из work-package (new optional field)
   - При spawn role=super-orchestrator: child-node-client вызывает HTTP `/api/mission-delegate` вместо in-process EventBus
   - При spawn role=worker: существующий поток (POST /api/sessions/:id/messages + WS)

3. **`can-spawn-batch.ts`** (extensions/fan-super-orchestrator/):
   - Existing `super_orch_at_max_depth` rule (depth=4 → REFUSED) уже там
   - Добавить role-aware logic: если depth=4 + role=worker → ALLOWED (worker is sink)

4. **`role-loader.ts`** (extensions/fan-super-orchestrator/):
   - Расширить `RoleProfile` interface полем `default_extensions?: string[]`
   - Backward-compat: если отсутствует → fallback к worker tool set

5. **`tool-manifest.ts`** (extensions/fan-super-orchestrator/):
   - В `SpawnOptions` или новом `BuildSpawnEnvOptions` принимать `effectiveExtensions: string[]` (после exclusions)
   - Валидировать через `ALLOWED_TOOLS`

6. **`index.ts`** (extensions/fan-super-orchestrator/):
   - В `session_start` hook: если `FAN_NODE_ROLE=super-orchestrator` → инициализировать recursive SO wiring (init circuit, register delegate handler via HTTP)
   - Сохранить существующую логику для role=worker

7. **`api-gateway/src/http-server.ts`** (packages/api-gateway/):
   - Добавить endpoint `POST /api/mission-delegate` (NEW)
   - Делегирует в `api.events.emit("mission_delegate", payload)` для текущего fan server процесса
   - Авторизация через `FAN_NODE_TOKEN`

### F-6: Рекурсивный cap

**Описание:** На depth=4 super-orchestrator НЕ МОЖЕТ spawn'ить (только worker'ов — это sink). Enforced в `can-spawn-batch.ts`.

**Логика:**
```
if role === "super-orchestrator" && depth === 4:
    return { allowed: false, reason: "super_orch_at_max_depth" }
```

Уже реализовано в F-D Green phase (commit `cb48749`).

**Бизнес-правила:**
- depth=1: SO может spawn worker (depth=2) и SO (depth=2)
- depth=2: SO может spawn worker (depth=3) и SO (depth=3)
- depth=3: SO может spawn worker (depth=4 = SINK) и SO (depth=4 = FORBIDDEN)
- depth=4: только worker (sink), никакого рекурсивного spawn

---

## Нефункциональные требования

### Производительность

- Spawn child SO: ≤500ms (existing worker spawn ~200ms + SO init overhead)
- HTTP delegation latency (parent → SO): ≤50ms (loopback HTTP)
- Per-hop timeout: 30s (existing в walk-up.ts)
- Total delegation chain (4 hops max): ≤2 минут (4 × 30s + 3s backoff)

### Безопасность

- **Tool manifest isolation:** spawned SO НЕ получает `store_*` и другие sensitive tools (config-driven exclusions)
- **Token-based auth:** spawned SO авторизуется через `FAN_NODE_TOKEN` при приёме delegation
- **Token lifecycle:** токен генерируется при spawn, передаётся через env, валидируется на каждом HTTP request
- **No shell injection:** все env vars проходят через whitelist (existing в `buildSpawnEnv`)

### Надёжность

- Graceful shutdown всей цепочки: SIGTERM parent → пропагирует SIGTERM children
- kill-switch ≤1s (existing в `depth2-integration.abort`)
- Walk-up escalation при недоступности spawned SO (existing в `walk-up.ts`)
- Orphan-reports atomic write (existing в `orphan-storage.ts`)
- Idempotency по `parentReportId` (existing в `report-delivery.ts`)

### Масштабируемость

- Global node cap: 100 одновременных spawned nodes (existing в `port-registry.ts`)
- Total port budget: 256 ports (API 100 + webhook 100 + reserve 56)
- Memory per SO subprocess: ~300 MB (full fan server)
- 100 nodes × 300 MB = 30 GB max — соответствует SPEC §12.5

---

## Технические требования

### Стек

- **TypeScript** (existing)
- **Node.js / Bun** (existing runtime)
- **WebSocket** (`ws` package, existing)
- **HTTP** (`@hono/node-server`, existing после F-0 fix)
- **YAML parsing** (`yaml` package, existing в `role-loader.ts`)
- **TOML config** (`@iarna/toml` или подобный — NEW dependency, добавляем если нет в репо)

### Архитектура

```
Parent fan process (depth=N)
  │
  ├─ process-manager.spawn({role: "super-orchestrator", ...})
  │   │
  │   cpSpawn("fan", ["server", "--port", M, "--host", "127.0.0.1"], {
  │     env: {
  │       FAN_NODE_ROLE: "super-orchestrator",
  │       FAN_NODE_ROLE_PROFILE: "pm",
  │       FAN_NODE_TOKEN: <random>,
  │       FAN_ORCHESTRATOR_DEPTH: N+1,
  │       FAN_PARENT_NODE_URL: "http://127.0.0.1:parent_port",
  │       FAN_PARENT_NODE_TOKEN: <random>,
  │       FAN_NO_AUTH: "0",
  │       FAN_MISSION_DIR: "/path",
  │   }
  │   })
  │
  └─ Spawned fan server process (depth=N+1, role=super-orchestrator)
      │
      ├─ session_start hook проверяет FAN_NODE_ROLE=super-orchestrator
      ├─ Init circuit (mission_loop, tree-journal, budget aggregator)
      ├─ Register delegate handler:
      │   api.events.on("mission_delegate", handleDelegate)
      │   где handleDelegate знает что он spawned (не in-process root)
      │
      └─ HTTP server expose POST /api/mission-delegate
          авторизация через FAN_NODE_TOKEN
          payload → api.events.emit("mission_delegate", payload)
          → handleDelegate (same as in-process)
          → canSpawnBatch → spawn children (recursive!)
```

### Интеграции

- `process-manager.ts` — расширяется env
- `depth2-integration.ts` — расширяется role support
- `child-node-client.ts` — переиспользуется as-is
- `can-spawn-batch.ts` — уже имеет depth cap rule
- `role-loader.ts` — расширяется `default_extensions` schema
- `tool-manifest.ts` — расширяется effective extensions
- `port-registry.ts` — уже глобальный, capacity 100 nodes
- `walk-up.ts` — переиспользуется для orphaned spawned SO
- `api-gateway/src/http-server.ts` — добавить `/api/mission-delegate` endpoint

---

## Данные

### Новые поля в `WorkPackage` (depth>0)

```typescript
{
  // existing
  role: "super-orchestrator" | "orchestrator",
  role_profile?: string,
  parent_correlation_id?: string,
  parent_url?: string,
  parent_token?: string,
  parent_report_id?: string,
  lineage?: LineageEntry[],
  // existing depth, deadline, etc.
}
```

Уже реализовано в `build-work-package.ts` (F-D phase).

### Config schema (TOML/YAML)

```yaml
# extensions/fan-super-orchestrator/role-config.yaml
spawn:
  excluded_extensions:
    - store_search
    - store_install
role:
  super-orchestrator:
    required_extensions:
      - delegate_task
width:
  max_depth: 4
  working: { 1: 8, 2: 6, 3: 4, 4: 2 }
  max: { 1: 12, 2: 10, 3: 8, 4: 4 }
```

Файл кладётся в deployed `extensions/fan-super-orchestrator/`. Optional — если отсутствует, hard-coded defaults.

---

## Риски и митигация

| # | Риск | Вероятность | Митигация |
|---|------|-------------|-----------|
| 1 | Рекурсия SO → SO → SO создаёт циклы | Средняя | `canSpawnBatch` уже enforce'ит depth cap depth=4, cycle detection в role-loader extends |
| 2 | Token leakage между parent/child | Низкая | `FAN_NODE_TOKEN` per-process random, только parent знает, передаётся через secure channel (process env, не HTTP body) |
| 3 | Spawned SO падает, orphan-reports не доходят | Средняя | Walk-up escalation через lineage (existing в walk-up.ts), orphan-reports atomic write |
| 4 | Memory exhaustion при 100 spawned SO | Низкая | Global cap 100 в port-registry, проверка до spawn |
| 5 | Backward compat с existing depth-2 flow | Низкая | Default role=worker сохраняет существующее поведение, defaultExtensions = current tool set |
| 6 | HTTP loopback overhead | Низкая | Per-hop latency ≤50ms acceptable для 4-hop chain |
| 7 | TOML parser — новая dependency | Низкая | Проверить `@iarna/toml` в существующих deps; иначе inline mini-parser или YAML (yaml уже есть) |
| 8 | Tool manifest regression — spawned SO без delegate_task | Средняя | Hardcoded injection `delegate_task` для role=super-orchestrator в role-loader.ts (security audit point) |
| 9 | Misconfigured spawn loop (SO спавнит себя) | Низкая | Hard cap depth=4 в canSpawnBatch не позволит depth > 4 |

---

## Компромиссы

### Trade-off #1: Full fan server vs lightweight orchestrator

**Выбрано:** Full fan server (per user's preference).

**Плюсы:**
- Переиспользование всего agent runtime (LLM, tools, providers)
- Единый путь delegation через `child-node-client`
- Проще тестирование (тот же mock infra)

**Минусы:**
- 300 MB per subprocess (vs 50 MB lightweight)
- 100 nodes max ограничение памяти
- Дольше spawn (~500ms)

### Trade-off #2: HTTP+WS transport vs Unix socket vs stdio

**Выбрано:** HTTP+WS (per user's preference).

**Плюсы:**
- Переиспользование `child-node-client.ts` (уже тестирован)
- Совместимость с production debugging (curl, ws clients)
- Совместимость с Windows (no Unix socket)

**Минусы:**
- TCP overhead (~5-10ms per delegation)
- Использует порты (но уже в budget API 7001-7100)

### Trade-off #3: Config file (TOML/YAML) vs hard-coded defaults

**Выбрано:** Optional config file с hard-coded fallback.

**Плюсы:**
- Можно exclude другие tools без правки кода
- Гибкость для enterprise deployments

**Минусы:**
- Дополнительная complexity
- Default exclusions могут быть забыты в config

---

## Приоритеты (MoSCoW)

### Must Have (M)
- F-1: Role-aware spawn через env FAN_NODE_ROLE
- F-3: HTTP+WS delegation transport (переиспользовать child-node-client)
- F-4: Config file для exclusions (store_search, store_install)
- F-6: Recursion cap depth=4 (уже реализован)

### Should Have (S)
- F-2: Configurable tool manifest через `default_extensions` в role profile
- F-5: Минимальные изменения в существующем коде

### Could Have (C)
- Универсальная schema для role profiles (расширение существующей YAML)
- Метрики для SO subprocess (latency, memory, throughput)

### Won't Have (W)
- Lightweight orchestrator mode (separate binary)
- Stdout/stdio transport
- Auto-scaling spawned SO по нагрузке

---

## Следующие шаги

1. **Подтверждение scope** — пользователь утверждает спеку
2. **Feature roadmap** — генерация TDD roadmap через `feature-roadmap` skill
3. **Implementation** — feature-pipeline (Red → Green → Refactor per функция)
4. **Integration test** — e2e depth-4 happy path с реальными spawned chain (Coord → SO → SO → worker)
5. **Documentation** — обновить README, CHANGELOG, ARCHITECTURE
6. **Test live** — EPIC с рекурсивным spawn в test-project

**Этапы (предварительно, через feature-roadmap уточним):**
- Phase 1: Role-aware spawn (process-manager + env vars)
- Phase 2: Spawned SO wiring (session_start + init circuit + delegate handler)
- Phase 3: HTTP delegation endpoint (api-gateway)
- Phase 4: Tool manifest extensions (role profile + config)
- Phase 5: Integration test (recursive SO → SO)
- Phase 6: Docs + live testing

**Оценка объёма:** ~10-14 дней для полной реализации (с тестами и docs).

**Связь с существующими фичами:**
- Depth-4 v2 SPEC (architecture.md, 840 строк) — концептуальная база, реализуемая этой фичей
- Headless mission mode (backlog) — orthogonal, может комбинироваться (headless + recursive spawn)
- EPIC delegation (existing in epic-delegation.ts) — прозрачно использует recursive SO при spawn

---

## Источники

- `docs/features/super-orchestrator-v2/architecture.md` — depth-4 SPEC
- `docs/specs/spec_super-orchestrator_v3_2026-08-10.md` — depth-2 SPEC
- `extensions/fan-super-orchestrator/process-manager.ts` — current spawn implementation
- `extensions/fan-super-orchestrator/child-node-client.ts` — L0 → L1 REST+WS client
- `extensions/fan-super-orchestrator/depth2-integration.ts` — launchChild pipeline
- `extensions/fan-super-orchestrator/can-spawn-batch.ts` — guard logic
- `extensions/fan-super-orchestrator/role-loader.ts` — role profile schema
- `extensions/fan-super-orchestrator/tool-manifest.ts` — tool allow-list
- `extensions/fan-super-orchestrator/width-pyramid.ts` — width limits
- `extensions/fan-super-orchestrator/port-registry.ts` — global node registry
- `extensions/fan-super-orchestrator/walk-up.ts` — escalation protocol

## История

- **2026-08-22:** Спека создана в ответ на запрос пользователя после live-testing incident EPIC delegation. Ответы на блокирующие вопросы: full fan server, HTTP+WS transport, configurable tool manifest с exclusions, hard cap depth=4.