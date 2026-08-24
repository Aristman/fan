# Предложение по автоматизированному тестированию миссий + super-orchestrator

> Версия: 1.0 | Дата: 2026-08-24 | Статус: proposal (не реализовано)
>
> Цель: описать пробелы в текущем покрытии и предложить многоуровневую стратегию
> тестирования bundle fan-mission 1.0.0 (fan-mission + fan-scheduler + fan-super-orchestrator + fan-webhook).

---

## 1. Что уже покрыто (инвентаризация)

### 1.1 fan-super-orchestrator: 43 тестовых файла

| Категория | Файлы | Что покрыто |
|-----------|-------|-------------|
| **Unit** | `role-loader.test.mjs`, `yaml-loader.test.mjs`, `depth-width-guard.test.mjs`, `port-pool.test.mjs`, `port-registry.test.mjs`, `process-manager.test.mjs`, `node-auth.test.mjs`, `node-report.test.mjs`, `message-sanitizer.test.mjs`, `tree-journal.test.mjs`, `tree-journal-onwrite.test.mjs`, `work-package.test.mjs`, `budget-aggregator.test.mjs`, `budget-coordinator.test.mjs`, `child-node-client.test.mjs`, `depth-range.test.mjs`, `hierarchy-budget.test.mjs`, `hierarchy-fixtures.test.mjs`, `hierarchy-guard-auth.test.mjs`, `hierarchy-journal.test.mjs`, `hierarchy-reconciliation.test.mjs`, `lineage-escalation.test.mjs`, `tool-manifest.test.mjs`, `tool-manifest-contract.test.mjs`, `spawn-protocol.test.mjs`, `boundary-validation.test.mjs`, `startup-reconciliation.test.mjs`, `orphan-recovery.test.mjs` (если есть) | Роли, пул портов, spawn/kill, auth, journal, budget, sanitizer, manifest |
| **Role** | `role-extensions.test.mjs`, `role-launch-child.test.mjs`, `role-spawn.test.mjs`, `spawned-so-wiring.test.mjs` | Role-aware launch, wiring recursive circuit, role profiles |
| **DI/Smoke** | `di-smoke.test.mjs`, `setup.test.mjs`, `entry-point.test.mjs`, `verify-subtree.test.mjs` | DI-конфигурация, entry point, smoke |
| **Phase-gate e2e** | `phase-gate-a.e2e.mjs`, `phase-gate-a3.e2e.mjs`, `phase-gate-b.e2e.mjs`, `phase-gate-c.e2e.mjs`, `phase-gate-c3.e2e.mjs` | Многоузловые сценарии с mock-серверами |
| **E2E depth-4** | `e2e/depth-4.test.mjs`, `e2e-depth34.test.mjs`, `e2e/walk-up.test.mjs`, `e2e/transport-regression.test.mjs` | Depth-3/4 цепочки, walk-up escalation, транспорт |
| **E2E recursive** | `e2e/recursive-spawn.test.mjs` (3 теста) | TC-F6-1: happy path chain, TC-F6-2: walk-up, TC-F6-3: graceful shutdown |
| **Smoke recursive** | `smoke-recursive-spawn.test.mjs` (7 тестов) | Smoke-проверки recursive spawn |

**Итого:** ~848 тестов (оценка по предыдущим данным; 43 файла, ~15913 строк).

### 1.2 fan-mission: 39 тестовых файлов

| Категория | Что покрыто |
|-----------|-------------|
| `mission-loop.test.mjs` | 7-шаговый цикл, recovery, abort, budget, drain, steer |
| `epic-delegation.test.mjs` | Декомпозиция, parseEpicSubtasks, runEpicDelegation, fallback |
| `file-state-manager.test.mjs` | STATE.md, ROADMAP.md, truncation fix (section-aware) |
| `slash-commands.test.mjs` | /mission:init, /mission:start, /mission:status, /mission:stop |
| `promise-parser.test.mjs` | Парсинг `<promise>` тегов |
| `verification-ladder.test.mjs` | Verification steps |
| Прочие (~33 файла) | Backlog, ideas, scoring, metrics, recurring, templates |

**Итого:** ~898 тестов (оценка).

### 1.3 api-gateway: тесты mission-delegate

| Файл | Что покрыто |
|------|-------------|
| `__tests__/mission-delegate-schema.test.ts` (если есть) | validateMissionDelegatePayload: required fields, edge cases |
| `__tests__/seed-node-token.test.ts` | seedNodeToken: создание записи, name, валидация |
| `__tests__/auth-mission-delegate.test.ts` (если есть) | verifyNodeToken: Bearer prefix, timingSafeEqual, edge cases |

**Итого:** ~148 тестов (оценка по предыдущим данным).

### 1.4 Что мокает mock-fan-server.mjs

`extensions/fan-super-orchestrator/test/helpers/mock-fan-server.mjs` — HTTP + WS stub:

- `GET /api/health` → 200 `{"status":"ok"}`
- `POST /api/mission-delegate` → 200 `{"status":"queued"}` (behavior: "respond") или 503 (behavior: "crash")
- `POST /api/deliver-report` → 200 (для walk-up тестов)
- WS `/api/ws` → ack на сообщения, broadcast `mission_delegate_result`
- `chainPropagation: "auto"` → forward delegation к следующему в lineage
- Auth: проверка `Authorization: Bearer <token>`

**Что НЕ покрыто моками:**
- Реальный boot fan server (расширения, провайдеры, ~10 сек)
- Реальный WS-коннект child-node-client (work package delivery)
- Реальный LLM-вызов для декомпозиции EPIC
- Реальный spawn процесса (child_process.spawn)
- Таймауты и race conditions реального процесса

---

## 2. Пробелы (что НЕ покрыто)

### 2.1 Real-subprocess e2e (КРИТИЧЕСКИЙ)

**Проблема:** Все текущие e2e-тесты используют mock fan servers (HTTP stubs).
Реальные fan.exe процессы НЕ тестируются.

**Симптом:** 4-секундная смерть child в live-тесте НЕ ловится моками, потому что
mock server:
- Мгновенно отвечает на `/api/health` (нет boot time)
- Не имеет extensions/providers (нет реальной инициализации)
- Не умирает от реальных причин (OOM, port conflict, missing config)

**Что нужно:** Тесты с РЕАЛЬНЫМИ fan server процессами (L3).

### 2.2 Mission-loop ↔ super-orchestrator integration

**Проблема:** EPIC-delegation в тестах fan-mission использует mock EventBus
(прямой emit → handler в том же процессе). В production:
- fan-mission emit'ит `mission_delegate` через EventBus
- fan-super-orchestrator подписывается в session_start
- Обработка идёт через depth2-integration → process-manager → spawn

**Нет теста** связывающего: `mission-loop → epic-delegation → EventBus → super-orchestrator handleDelegate → spawn → reply`.

### 2.3 Bundle install → extension load

**Проблема:** Нет теста что bundle `fan-mission-1.0.0.tar.gz`:
- Корректно распаковывается
- Все 4 расширения обнаруживаются extension loader
- Нет конфликтов между расширениями
- DEPLOY.toml включает все нужные файлы (ловит баг mtime=1970)

### 2.4 Roles end-to-end

**Проблема:** Role profiles (10 yaml) тестируются unit-тестами (role-loader),
но их влияние на реальный child (tool manifest, excluded_extensions) не проверяется
в integration.

### 2.5 Shutdown under load / orphan recovery

**Проблема:** Graceful shutdown тестируется в mock-среде (TC-F6-3). Реальные сценарии:
- Kill -9 parent → orphan children → startup-reconciliation
- Budget exhaustion mid-spawn → partial cleanup
- Port conflict → spawn failure → recovery

---

## 3. Предлагаемые уровни тестирования

### L1: Contract tests (быстрые, CI gate)

| Тест | Что проверяет | Файл |
|------|---------------|------|
| Payload schema | `mission_delegate` payload: required fields, types | `test/contracts/mission-delegate-payload.test.mjs` |
| Reply schema | `mission_delegate_result` reply: results[], totalUsage | `test/contracts/delegate-reply-schema.test.mjs` |
| Event channel names | DELEGATE_CHANNEL, delegateResultChannel() | `test/contracts/event-channels.test.mjs` |
| DEPLOY.toml completeness | Все файлы из include существуют (ловит mtime bug) | `test/contracts/deploy-toml.test.mjs` |
| Role profile schema | 10 yaml: id, name, allowed_depths, default_tools | `test/contracts/role-profiles.test.mjs` |
| EPIC marker | `[EPIC]` parsing, MAX_EPIC_SUBTASKS = 4 | `test/contracts/epic-marker.test.mjs` |

**Время:** <5 сек | **Зависимости:** нет | **Запуск:** каждый PR

### L2: Component e2e (CI, mock servers)

Расширение существующих тестов на mock-fan-server:

| Тест | Что добавляет | Файл |
|------|---------------|------|
| Recursion cap hit | depth guard rejects at max depth | `test/e2e/recursive-spawn-cap.test.mjs` |
| Role exclusions | excluded_tools в role profile → tool manifest filter | `test/e2e/role-exclusions-e2e.test.mjs` |
| Budget overflow | packages превышают budget → reject | `test/e2e/budget-overflow-e2e.test.mjs` |
| Orphan cleanup | spawn → kill -9 → restart → reconciliation | `test/e2e/orphan-recovery-e2e.test.mjs` |
| Multiple correlations | Параллельные mission_delegate не пересекаются | `test/e2e/parallel-delegation.test.mjs` |
| Width guard | packages.length > maxWidth → reject | `test/e2e/width-guard-e2e.test.mjs` |

**Время:** <30 сек | **Зависимости:** mock-fan-server.mjs | **Запуск:** каждый PR

### L3: Real-subprocess integration (nightly, staging) ⭐ P0

**Цель:** Ловит класс багов "4-секундная смерть" — реальные процессы, реальное boot time.

```
test/real-spawn/
├── real-fan-server-harness.mjs   # spawn fan.exe server --port X, waitForReady, teardown
├── real-spawn-basic.test.mjs     # spawn → health → kill
├── real-spawn-env.test.mjs       # env propagation (FAN_NODE_TOKEN, FAN_ORCHESTRATOR_DEPTH)
├── real-spawn-port-conflict.test.mjs  # port already in use → graceful fail
└── real-spawn-bundle.test.mjs    # bundle extensions load correctly in child
```

**Структура real-fan-server-harness.mjs:**

```javascript
// Концепт (не реализовано)
export async function createRealFanServer({ port, token, env = {} }) {
  const child = spawn("fan", ["server", "--port", String(port), "--host", "127.0.0.1"], {
    env: { ...process.env, FAN_NODE_TOKEN: token, FAN_NO_AUTH: "0", ...env },
    stdio: "pipe",  // НЕ "ignore" — нужен для диагностики
  });
  
  // waitForReady: poll /api/health, timeout 60s
  await waitForReady(port, 60_000);
  
  return {
    port, pid: child.pid, child,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(r => child.on("exit", r)),
        new Promise(r => setTimeout(r, 5000)).then(() => child.kill("SIGKILL"))
      ]);
    },
    // Captured output for diagnostics
    get stdout() { return child.stdout?.read()?.toString() ?? ""; },
    get stderr() { return child.stderr?.read()?.toString() ?? ""; },
  };
}
```

**Guard:** `skip-if-no-binary` — тесты пропускаются если `fan` не в PATH:

```javascript
const hasFanBinary = (() => {
  try { execSync("fan --version", { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const describeReal = hasFanBinary ? describe : describe.skip;
```

**Timeouts:** 60+ секунд (boot fan server ~10 сек + margin).

**Время:** 2-5 мин на тест | **Зависимости:** собранный fan.exe | **Запуск:** nightly

### L4: Mission e2e (staging)

Полная миссия с EPIC → spawn → выполнение → ROADMAP closed:

```
test/mission-e2e/
├── fixtures/
│   └── test-project/
│       └── docs/missions/
│           └── e2e-probe/
│               ├── MISSION.md      # status: active, budget: 100000 tokens
│               └── ROADMAP.md      # [EPIC] Создать 3 файла...
├── mission-epic-delegation.test.mjs  # полная миссия с EPIC
└── mission-lifecycle.test.mjs        # init → start → tick → complete → stop
```

**Что проверяет:**
1. `fan mission init e2e-probe` → файлы созданы
2. ROADMAP с `[EPIC]` → mission-loop detect
3. EventBus → super-orchestrator handleDelegate
4. Spawn child → waitForReady → sendWorkPackage
5. Child выполняет → reply → ROADMAP closed
6. `fan mission stop` → graceful shutdown

**Время:** 5-10 мин | **Зависимости:** fan.exe + L3 harness | **Запуск:** nightly

### L5: Soak/stability (weekly)

| Тест | Длительность | Что проверяет |
|------|-------------|---------------|
| Long mission | 1 час+ | Memory leak, STATE.md growth, journal size |
| Rotation stress | 30 мин | ralph-loop session rotation, no data loss |
| Rapid spawn/kill | 100 циклов | Port leak, PID file cleanup, no zombie processes |
| Budget exhaustion | До исчерпания | Graceful stop, no orphan children |

**Время:** 1-2 часа | **Запуск:** weekly (weekend)

---

## 4. Инфраструктура

### 4.1 Test runner

| Уровень | Runner | Обоснование |
|---------|--------|-------------|
| L1-L2 | vitest | Уже используется, быстрая интеграция |
| L3 | vitest + increased timeouts | `testTimeout: 120_000`, `hookTimeout: 60_000` |
| L4-L5 | vitest или custom script | L5 может требовать отдельный runner (cron) |

### 4.2 CI матрица

| Уровень | PR gate | Nightly | Weekly |
|---------|---------|---------|--------|
| L1 (contract) | ✅ | ✅ | ✅ |
| L2 (component e2e) | ✅ | ✅ | ✅ |
| L3 (real-subprocess) | ❌ | ✅ | ✅ |
| L4 (mission e2e) | ❌ | ✅ | ✅ |
| L5 (soak) | ❌ | ❌ | ✅ |

**Обоснование:** L3-L5 требуют собранный fan.exe — недоступен в PR-gate (только после merge).

### 4.3 Flakiness policy

**Известная проблема:** TC-F6-2 flaky under full-suite (15s timeout).

**Предлагаемые mitigation:**
- Retry: 2 (vitest `retry: 2`)
- Timeout: увеличить до 30s для recursive-spawn тестов
- Isolation: `--pool=forks` для e2e тестов (не share state)
- Quarantine: flaky тесты помечаются `@flaky` и НЕ блокируют CI gate

```javascript
// vitest.config.ts
export default {
  test: {
    retry: process.env.CI ? 2 : 0,
    testTimeout: 30_000,  // default
    hookTimeout: 60_000,
  },
}
```

### 4.4 Test fixtures

**Уже есть:**
- `mock-fan-server.mjs` — HTTP + WS stub
- `test/fixtures/` — статические fixtures

**Нужно добавить:**
- `real-fan-server-harness.mjs` — spawn/kill real fan.exe (L3)
- `test/mission-e2e/fixtures/` — test-project с миссией (L4)
- `test/contracts/fixtures/` — sample payloads для contract tests (L1)

---

## 5. Приоритеты

| Приоритет | Уровень | Обоснование |
|-----------|---------|-------------|
| **P0** | L3 (real-subprocess) | **Ловит 4-секундную смерть.** Единственный способ обнаружить реальные баги spawn. Без него все mock-тесты — "тестим моки, не код". |
| **P1** | L1 (contract) | **Ловит regression контрактов.** Быстрые (<5 сек), стабильные, покрывают payload schema, event channels, DEPLOY.toml. Минимум усилий, максимум пользы. |
| **P2** | L4 (mission e2e) | **Полный end-to-end сценарий.** Проверяет интеграцию mission-loop ↔ super-orchestrator, которую не покрывают L2-L3. |
| **P3** | L2 (component e2e) | **Расширяет существующие тесты.** Добавляет edge cases (recursion cap, budget overflow, orphan recovery). |
| **P4** | L5 (soak) | **Стабильность.** Важно для production, но не критично для текущей стадии. |

### Дорожная карта

```
Неделя 1: L1 contract tests (4-6 тестов, 1 день работы)
Неделя 2: L3 real-subprocess harness + 3 базовых теста (2-3 дня)
Неделя 3: L4 mission e2e (2-3 теста, 2 дня)
Неделя 4: L2 расширение e2e (4-6 тестов, 2 дня)
Неделя 5+: L5 soak (по мере необходимости)
```

---

## 6. Метрики успеха

| Метрика | Текущее | Цель (после реализации) |
|---------|---------|------------------------|
| Покрытие spawn (mock) | ✅ 43 файла | ✅ 43 + 6 файлов (L2) |
| Покрытие spawn (real) | ❌ 0 | ✅ 3+ файла (L3) |
| Покрытие mission e2e | ❌ 0 | ✅ 2+ файла (L4) |
| Время до обнаружения 4-сек бага | ∞ (не ловится) | <5 мин (L3 nightly) |
| Flaky тестов в CI | 1 (TC-F6-2) | 0 (retry + timeout fix) |
| Contract regression | Не покрыто | 6+ тестов (L1) |

---

## Приложение: Карта существующих тестов super-orchestrator

```
extensions/fan-super-orchestrator/test/
├── boundary-validation.test.mjs     # F-38: граничная валидация depth
├── budget-aggregator.test.mjs       # Аллокация/агрегация бюджета
├── budget-coordinator.test.mjs      # Координация бюджета между узлами
├── child-node-client.test.mjs       # WS-клиент для отправки пакетов
├── depth-range.test.mjs             # Depth range validation
├── depth-width-guard.test.mjs       # Guard: max depth/width
├── depth2-integration.test.mjs      # Depth-2 handle: spawn/send/kill
├── di-smoke.test.mjs                # DI конфигурация
├── diagnostics.test.mjs             # Chat-logger, extension-health
├── e2e-depth34.test.mjs             # Depth-3/4 e2e
├── entry-point.test.mjs             # Extension entry point
├── hierarchy-budget.test.mjs        # Иерархический бюджет
├── hierarchy-fixtures.test.mjs      # Hierarchy fixtures
├── hierarchy-guard-auth.test.mjs    # Guard + auth
├── hierarchy-journal.test.mjs       # Journal в иерархии
├── hierarchy-reconciliation.test.mjs # Reconciliation
├── lineage-escalation.test.mjs      # Walk-up escalation
├── message-sanitizer.test.mjs       # Санитизация сообщений
├── node-auth.test.mjs               # FAN_NODE_TOKEN, buildSpawnEnv
├── node-report.test.mjs             # NodeReport parsing
├── phase-gate-a.e2e.mjs             # Phase gate A
├── phase-gate-a3.e2e.mjs            # Phase gate A3
├── phase-gate-b.e2e.mjs             # Phase gate B
├── phase-gate-c.e2e.mjs             # Phase gate C
├── phase-gate-c3.e2e.mjs            # Phase gate C3
├── port-pool.test.mjs               # Пул портов 7001-7099
├── port-registry.test.mjs           # Реестр портов (v2)
├── process-manager.test.mjs         # Spawn/kill/health
├── role-extensions.test.mjs         # Role → tool manifest
├── role-launch-child.test.mjs       # Role-aware launch
├── role-loader.test.mjs             # YAML role loading
├── role-spawn.test.mjs              # Role-aware spawn
├── smoke-recursive-spawn.test.mjs   # 7 smoke тестов recursive
├── spawn-protocol.test.mjs          # Spawn protocol
├── spawned-so-wiring.test.mjs       # Recursive circuit wiring
├── startup-reconciliation.test.mjs  # Orphan cleanup
├── tool-manifest-contract.test.mjs  # Tool manifest contract
├── tool-manifest.test.mjs           # Tool manifest
├── tree-journal-onwrite.test.mjs    # Journal hook (F-47)
├── tree-journal.test.mjs            # Tree journal (JSONL)
├── verify-subtree.test.mjs          # Subtree verification
├── width-pyramid.test.mjs           # Width pyramid guard
├── work-package.test.mjs            # Work package creation
├── e2e/
│   ├── depth-4.test.mjs             # Depth-4 e2e
│   ├── recursive-spawn.test.mjs     # 3 теста: happy, walk-up, shutdown
│   ├── transport-regression.test.mjs # Transport regression
│   └── walk-up.test.mjs             # Walk-up e2e
└── helpers/
    └── mock-fan-server.mjs          # Mock fan server (HTTP + WS)
```
