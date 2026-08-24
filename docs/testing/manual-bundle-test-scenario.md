# Ручной сценарий тестирования bundle fan-mission 1.1.0

> Версия: 1.1.0 | Дата: 2026-08-24 | Статус: готов к прогону (после фиксов cd1ebc1)
>
> Цель: полный ручной прогон EPIC-delegation через fan-super-orchestrator —
> от установки бандла до spawn дочерних fan server и наблюдения дерева узлов.
>
> **Что нового в 1.1.0:**
> - reconcile() не убивает своих детей — `skipped_own_child` вместо `orphan_cleanup` для свежих PID
> - stdout/stderr дочерних fan server пишутся в `<missionDir>/logs/child-<id>.log`
> - При смерти ребёнка до готовности — `diag`-событие с exitCode/signal/logPath
> - L0 бюджет безлимитен — миссия не уходит в `budget_exhausted`
> - Дочерний лимит: 1М токенов на узел (env `FAN_CHILD_BUDGET_TOKENS`)

---

## 0. Предусловия (checklist)

Перед началом убедитесь что всё на месте:

| # | Проверка | Команда | Ожидаемый результат |
|---|----------|---------|---------------------|
| 0.1 | `fan` в PATH | `fan --version` | Версия выводится |
| 0.2 | Bundle установлен | `ls ~/.fan/agent/extensions/` | 4 директории: `fan-mission`, `fan-scheduler`, `fan-super-orchestrator`, `fan-webhook` |
| 0.3 | Критичные файлы SO | `ls ~/.fan/agent/extensions/fan-super-orchestrator/roles/` | 10 yaml-файлов (architect, backend, devops, docs, frontend, mobile, pm, qa, refactor, research) |
| 0.4 | Routes/wiring на месте | `ls ~/.fan/agent/extensions/fan-super-orchestrator/routes/launch-child.ts` | Файл существует |
| 0.5 | Wiring spawned-orchestrator | `ls ~/.fan/agent/extensions/fan-super-orchestrator/wiring/spawned-orchestrator.ts` | Файл существует |
| 0.6 | Templates mission | `ls ~/.fan/agent/extensions/fan-mission/templates/default/` | MISSION.md.ts, ROADMAP.md.ts, STATE.md.ts и др. |
| 0.7 | Тестовый проект | `cd C:/Users/User/projects/e2e-tests/mission-manual-test-1 && pwd` | Директория существует |

> ⚠️ **Тестовый проект (шаг 0.7):** Актуальный тестовый проект —
> `C:\Users\User\projects\e2e-tests\mission-manual-test-1`. Там уже есть миссия
> `bundle-test` от прошлого прогона (статус `budget_exhausted` — терминальный,
> сброс невозможен). **Рекомендуется:** чистый прогон с новой миссией (например,
> `bundle-test-2`), либо удалить старую директорию `docs/missions/bundle-test/`
> перед началом.

### Установка bundle (если ещё не установлен)

> ⚠️ **Важно:** Оператор должен пересобрать архив `bundles/fan-mission-1.1.0.tar.gz`
> самостоятельно перед прогоном (из исходников `bundles/fan-mission/`). Архив не
> хранится в репозитории.

**Вариант A — FAN Store (если сервер доступен):**
```bash
fan store install fan-mission
```

**Вариант B — из локального архива:**
```bash
fan store install bundles/fan-mission-1.1.0.tar.gz
```

**Вариант C — ручное копирование:**
```bash
for ext in fan-mission fan-scheduler fan-super-orchestrator fan-webhook; do
  cp -r "bundles/fan-mission/extensions/$ext" ~/.fan/agent/extensions/
done
```

### FAN_NODE_TOKEN

Родительский процесс (основной fan server) генерирует токен автоматически через
`seedNodeToken()` (`packages/api-gateway/src/auth.ts:34`). Токен передаётся дочерним
узлам через env `FAN_NODE_TOKEN` при spawn (`bundles/fan-mission/extensions/fan-super-orchestrator/node-auth.ts:23`).

**Для прямого HTTP-теста (шаг 4)** нужен токен родительского процесса. Его можно найти:
- В логе запуска fan server (строка `seedNodeToken`)
- Или через БД: `sqlite3 ~/.fan/agent/db/prisma/dev.db "SELECT token FROM ClientToken WHERE name LIKE 'fan-node%'"`

> ⚠️ Если fan запущен без `--mode server` (TUI-режим), токен всё равно сидится в БД.

---

## 1. Smoke-проверка bundle (2 мин)

### 1.1 Проверка файлов

```bash
# Проверить что все 4 расширения на месте
ls ~/.fan/agent/extensions/ | grep -E "fan-mission|fan-scheduler|fan-super-orchestrator|fan-webhook"

# Проверить количество файлов в бандле (должно быть ~92)
find ~/.fan/agent/extensions/fan-super-orchestrator -type f | wc -l

# Проверить roles (должно быть 10 yaml)
ls ~/.fan/agent/extensions/fan-super-orchestrator/roles/*.yaml | wc -l
```

### 1.2 Проверка загрузки расширений

```bash
# Запустить fan и проверить что расширения загружены.
# В TUI-режиме расширения логируются при старте.
# Альтернативно — проверить через diagnostics:
fan doctor
```

> **Примечание:** `fan doctor` проверяет окружение и зависимости. Если расширения
> установлены корректно, они будут обнаружены при старте сессии (session_start hook
> в `bundles/fan-mission/extensions/fan-super-orchestrator/index.ts`).

---

## 2. Создание тестовой миссии с EPIC (5 мин)

### 2.1 Инициализация миссии

```bash
cd C:/Users/User/projects/e2e-tests/mission-manual-test-1

# Создать новую миссию (slug: bundle-test-2)
fan mission init bundle-test-2 "Тест EPIC-delegation bundle fan-mission 1.1.0"
```

Команда создаст `docs/missions/bundle-test-2/` с файлами:
- `MISSION.md` — frontmatter (status: active, goal, budget)
- `ROADMAP.md` — чеклист задач
- `STATE.md`, `BACKLOG.md`, `DECISIONS.md`, `RECURRING.md`

> **Исходный код:** `packages/coding-agent/src/cli/mission-command.ts:690-720`,
> `bundles/fan-mission/extensions/fan-mission/file-state-manager.ts` (initMission)

### 2.2 Добавление EPIC-пункта в ROADMAP

Отредактировать `docs/missions/bundle-test-2/ROADMAP.md`:

```markdown
# Roadmap

- [ ] Bootstrap mission: bundle-test-2
- [ ] [EPIC] Создать docs/fiction/bundle-probe/ с 3 короткими md-файлами (по 5 строк): alpha.md, beta.md, index.md
```

**Формат EPIC-пункта:** маркер `[EPIC]` в начале текста (после `- [ ] `).
Источник: `bundles/fan-mission/extensions/fan-mission/epic-delegation.ts:27` — `EPIC_MARKER = "[EPIC]"`.

> ⚠️ **НЕ ТРОГАТЬ** существующие миссии в `docs/missions/gmail-watch/` и другие рабочие!

### 2.3 Как EPIC попадает в super-orchestrator

Механизм (из кода `bundles/fan-mission/extensions/fan-mission/epic-delegation.ts` и `bundles/fan-mission/extensions/fan-mission/mission-loop.ts`):

1. **mission-loop.ts** (step 4: Iterate) — обнаруживает `[EPIC]` маркер через `isEpicItem(nextItem.text)` (`mission-loop.ts:1170`).
2. Вызывает `runEpicDelegation()` (`epic-delegation.ts:195`):
   - Декомпозиция через `runAgent` (LLM-промпт → JSON-массив подзадач, макс. 4 — `MAX_EPIC_SUBTASKS`).
   - Проверка подписчика: `eventBus.listenerCount("mission_delegate") === 0` → fallback на локальное исполнение.
   - Emit события на канал **`mission_delegate`** (`epic-delegation.ts:28`).
3. **Payload события** (`MissionDelegateEvent`):
   ```typescript
   {
     missionDir: string,         // путь к директории миссии
     correlationId: string,      // UUID (randomUUID)
     packages: [{ task, tokenBudget?, toolManifest? }],  // подзадачи
     replyEvent: "mission_delegate_result:<correlationId>"  // канал ответа
   }
   ```
4. **fan-super-orchestrator** подписывается на `mission_delegate` в `session_start` hook
   (`index.ts:495-515`). При обнаружении активной миссии (`findActiveMission(cwd)`) —
   создаёт circuit и регистрирует handler (`handleDelegate`).

**Нужен ли config-флаг?** Нет — wiring автоматический. Если fan-super-orchestrator загружен
как расширение и сессия имеет активную миссию (status ∈ {active, paused, awaiting_decision}),
контур инициализируется автоматически (`index.ts:483-515`).

---

## 3. Запуск и наблюдение spawn (10 мин)

### 3.1 Запуск миссии

```bash
cd C:/Users/User/projects/e2e-tests/mission-manual-test-1

# Вариант A: через CLI
fan mission start

# Вариант B: через TUI — slash-команда
# /mission:start
```

### 3.2 Наблюдение tree-journal в реальном времени

```bash
# Открыть ВТОРОЙ терминал Git Bash для наблюдения
tail -f C:/Users/User/projects/e2e-tests/mission-manual-test-1/docs/missions/bundle-test-2/tree-journal.jsonl
```

**Ожидаемые события** (формат JSONL, одно событие на строку):

| Событие | Поля | Что означает |
|---------|------|--------------|
| `spawn` | `nodeId, parentId, port, pid, depth, via` | Дочерний узел порождён. `via: "spawn"` — реальный процесс. |
| `complete` | `nodeId, usage: {tokens, usd}` | Узел завершил задачу. |
| `fail` | `nodeId, diag?` | Узел не смог выполнить задачу. |
| `abort` | `nodeId` | Узел остановлен (shutdown). |
| `orphan_cleanup` | `nodeId, pid` | Startup-reconciliation зачистила orphan **из прошлой сессии** (не своего ребёнка). |
| `diag` | `nodeId, exitCode, signal, logPath` | Ребёнок умер до готовности — постмортемная диагностика (только при реальной смерти). |
| `tool_blocked` | `nodeId, diag` | Отказ манифеста инструментов (fail-fast до spawn). |
| `validation_failed` | `nodeId, diag` | Отклонение невалидного межагентного сообщения. |

Источник: `bundles/fan-mission/extensions/fan-super-orchestrator/tree-journal.ts:29-37` (TreeJournalEventType).

> ✅ **Фикс 1.1.0 — orphan_cleanup:** Свежеспавненные дети текущей сессии **НЕ
> должны** получать `orphan_cleanup`. reconcile() проверяет `isOwnChild(pid)` и
> пишет `skipped_own_child` (запись остаётся в portsFile). `orphan_cleanup`
> появляется только для PID из **прошлой** сессии, которые не принадлежат текущему
> процессу. Если вы видите `orphan_cleanup` для свежеспавненного ребёнка — это баг.

> ✅ **Фикс 1.1.0 — diag события:** Событие `diag` с `exitCode`/`signal`/`logPath`
> пишется **только** если ребёнок действительно умер до готовности (до того как
> `/api/health` ответил 200) или во время `sendPackage`. В успешном прогоне
> `diag`-событий быть **не должно**.

### 3.3 Проверка дочерних процессов

```bash
# Проверить порты 7001+ (дочерние fan server)
netstat -ano | grep "700[1-9]"

# Или более точно — LISTENING на 7xxx
netstat -ano | grep LISTENING | grep ":7"

# Проверить процесс по PID (из tree-journal)
tasklist | grep <PID>
```

### 3.4 Проверка HTTP health дочернего узла

```bash
# Порт из tree-journal (поле "port", обычно 7001+)
curl -s http://127.0.0.1:7001/api/health
# Ожидаемый ответ: {"status":"ok","version":"...","uptime":...}
```

Endpoint `/api/health` — публичный (без auth). Источник: `packages/api-gateway/src/http-server.ts`,
также используется в `bundles/fan-mission/extensions/fan-super-orchestrator/index.ts:236` (waitForReady poll).

### 3.5 Проверка логов дочерних процессов (новое в 1.1.0)

> ✅ **Фикс 1.1.0 — child logs:** Stdout/stderr дочерних fan server теперь
> записываются в `<missionDir>/logs/child-<id>.log`. Раньше `stdio: "ignore"`
> полностью терял вывод — причину смерти ребёнка невозможно было определить.

```bash
# Список логов детей
ls -la docs/missions/bundle-test-2/logs/

# Просмотр лога конкретного ребёнка (id из tree-journal)
cat docs/missions/bundle-test-2/logs/child-<id>.log
```

**Правило диагностики:** Если узел не поднялся (fail в tree-journal), **первое
место для поиска причины** — файл `<missionDir>/logs/child-<id>.log`. Там виден
полный stdout/stderr ребёнка, включая ошибки загрузки расширений, провайдеров,
порт-конфликты и т.д.

> Формат имени: `child-<sanitized-id>.log`, где `/` в nodeId заменяется на `-`.
> Код: `bundles/fan-mission/extensions/fan-super-orchestrator/process-manager.ts:265`

### 3.6 Ожидаемый happy path

```
1. fan mission start → session_start hook → findActiveMission → initCircuit
2. mission-loop tick → step 3: decide → находит [EPIC] пункт
3. runEpicDelegation → декомпозиция (LLM) → JSON [{task: "..."}]
4. eventBus.emit("mission_delegate", payload)
5. handleDelegate → canSpawnBatch guard → createDepth2 → spawn child fan server
6. waitForReady (poll /api/health, до 60 сек)
7. sendWorkPackage через child-node-client (WS)
8. Child выполняет → отчёт → journal "complete"
9. emit replyEvent → mission-loop получает результат → ROADMAP пункт закрыт
10. Все [x] в ROADMAP → статус миссии "completed"
```

---

## 4. Прямой тест HTTP /api/mission-delegate (5 мин)

### 4.1 Подготовка

Нужен запущенный fan server с известным `FAN_NODE_TOKEN`.

```bash
# Найти токен (если fan server уже запущен)
# Вариант A: из переменной окружения (если задан явно)
echo $FAN_NODE_TOKEN

# Вариант B: из БД
sqlite3 ~/.fan/agent/db/prisma/dev.db "SELECT token, name FROM ClientToken WHERE name LIKE 'fan-node%';"
```

### 4.2 Auth header

**Формат:** `Authorization: Bearer <FAN_NODE_TOKEN>`

Источник: `packages/api-gateway/src/auth-mission-delegate.ts:33-35` — проверка начинается
с `authHeader.startsWith("Bearer ")`. Токен сравнивается с `process.env.FAN_NODE_TOKEN`
через `timingSafeEqual` (constant-time).

### 4.3 Payload schema

Обязательные поля (из `packages/api-gateway/src/mission-delegate-schema.ts`):

| Поле | Тип | Обязательность |
|------|-----|----------------|
| `parentReportId` | string | ✅ Обязательное |
| `packages` | array | ✅ Обязательное |
| `parentCorrelationId` | string | Опциональное |
| `role` | string | Опциональное |
| `role_profile` | string | Опциональное |
| `depth` | number | Опциональное |
| `lineage` | array | Опциональное |

### 4.4 Curl-пример

```bash
# Заменить <TOKEN> на реальный FAN_NODE_TOKEN
# Заменить <PORT> на порт запущенного fan server (обычно основной порт, не 7xxx)

curl -s -X POST http://127.0.0.1:<PORT>/api/mission-delegate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "parentReportId": "test-manual-001",
    "parentCorrelationId": "manual-test",
    "role": "super-orchestrator",
    "role_profile": "backend",
    "depth": 1,
    "packages": [{"task": "Создать файл /tmp/probe.txt с содержимым: hello from delegate"}],
    "lineage": ["manual-test"]
  }'
```

### 4.5 Ожидаемые ответы

| Код | Значение | Причина |
|-----|----------|---------|
| 200 | `{ status: "queued", ... }` | Успех — делегация принята |
| 401 | `{ error: "missing_token" }` | Нет Authorization header |
| 401 | `{ error: "invalid_token" }` | Токен не совпадает с FAN_NODE_TOKEN |
| 400 | Валидация | `parentReportId` отсутствует или `packages` не массив |

> **Где смотреть эффект:** `docs/missions/<slug>/tree-journal.jsonl` — должна появиться
> запись `spawn` с `via: "http_delegate"` (если delegation дошла до super-orchestrator).

---

## 5. Проверка recursive spawn (depth-4) — ОПЦИОНАЛЬНО

> ⚠️ **Честное ограничение:** ручная проверка рекурсивного spawn ограничена.
> Полноценная проверка требует автоматизации (см. `automated-test-proposal.md`, L3).

### 5.1 Что нужно для recursive spawn

Из кода (`bundles/fan-mission/extensions/fan-super-orchestrator/routes/launch-child.ts`, `wiring/spawned-orchestrator.ts`):

1. **Родитель** (depth=0, coordinator) → spawn child с `role: "super-orchestrator"`:
   - `process-manager.ts` `buildRoleEnv()`: env `FAN_NODE_ROLE=super-orchestrator`
   - Опционально: `FAN_NODE_ROLE_PROFILE`, `FAN_PARENT_NODE_URL`, `FAN_PARENT_NODE_TOKEN`

2. **Spawned SO** (depth=1) — в `session_start` видит `FAN_NODE_ROLE=super-orchestrator`:
   - `wiring/spawned-orchestrator.ts:67` — `initRecursiveCircuit()` вместо `initCircuit()`
   - Подписывается на `mission_delegate` но handler — **trivial no-op** (`handleDelegateRecursive`)
   - Делегация дальше идёт через HTTP POST к parent `/api/mission-delegate`

3. **Для ручной проверки** нужно:
   - Запустить миссию с EPIC, который декомпозируется на подзадачи с `role: "super-orchestrator"`
   - Проверить что spawned child (port 7001+) получил `FAN_NODE_ROLE=super-orchestrator` в env
   - Проверить что child поднял recursive circuit (в его логе `logs/child-<id>.log`)

### 5.2 Что можно проверить вручную

```bash
# После spawn — проверить env дочернего процесса (Windows)
# Найти PID из tree-journal
wmic process where "ProcessId=<PID>" get CommandLine,EnvironmentVariables 2>/dev/null

# Или через PowerShell:
powershell -Command "Get-Process -Id <PID> | Select-Object Id,Path"
```

### 5.3 Почему полноценная проверка = автотест

Рекурсивный spawn требует:
- Каскад из 3+ mock-серверов с разными ролями
- HTTP delegation chain (parent → child → grandchild)
- Walk-up при крахе промежуточного узла

Это покрыто в `bundles/fan-mission/extensions/fan-super-orchestrator/test/e2e/recursive-spawn.test.mjs`
(3 теста: happy path, walk-up, graceful shutdown).

---

## 6. Graceful shutdown

### 6.1 Остановка миссии

```bash
cd C:/Users/User/projects/e2e-tests/mission-manual-test-1

# Остановить миссию
fan mission stop

# Или через TUI:
# /mission:stop
```

### 6.2 Что происходит с child-узлами

Из кода (`bundles/fan-mission/extensions/fan-super-orchestrator/index.ts:465-480`, `shutdownCircuit`):

1. `session_shutdown` hook → `shutdownCircuit()`
2. Для recursive circuit → `shutdownRecursiveCircuit()` пишет `abort` event в journal
3. Kill-switch всех in-flight depth2-handle → `handle.abort()` для каждого
4. Process-manager: `kill(id)` → SIGTERM → grace 5 сек → SIGKILL → cleanup (порт, PID-файл)

> **Порядок:** все активные узлы останавливаются параллельно (не leaf-first в текущей
> реализации — leaf-first shutdown в chain-manager для mock-тестов, не для production).

### 6.3 Проверка после остановки

```bash
# Порты 7xxx должны быть освобождены
netstat -ano | grep LISTENING | grep ":7"

# Процессы fan server (дочерние) должны завершиться
tasklist | grep fan

# tree-journal должен содержать "abort" события
tail -5 docs/missions/bundle-test-2/tree-journal.jsonl
```

---

## 7. Диагностика проблем с дочерними узлами

### 7.1 Первое место диагностики — child-*.log (новое в 1.1.0)

> ✅ **Фикс 1.1.0 (F-2):** Stdout/stderr ребёнка теперь пишутся в файл
> `<missionDir>/logs/child-<id>.log`. Раньше `stdio: "ignore"` полностью терял
> вывод — причину смерти ребёнка невозможно было определить.

**Если узел не поднялся (fail/diag в tree-journal):**

```bash
# 1. Найти nodeId из tree-journal
grep '"event":"fail"\|"event":"diag"' docs/missions/bundle-test-2/tree-journal.jsonl

# 2. Посмотреть лог ребёнка (id = nodeId с "/" → "-")
cat docs/missions/bundle-test-2/logs/child-<sanitized-id>.log
```

Типичные причины смерти, видимые в логе:
- `EADDRINUSE` — порт уже занят (конфликт портов)
- `Unable to connect` — провайдер недоступен
- Ошибка загрузки расширения (syntax error, missing dependency)
- Crash при инициализации (unhandled exception)

### 7.2 waitForReady timeout

**Код:** `bundles/fan-mission/extensions/fan-super-orchestrator/index.ts:128,234-248`

- Общий таймаут: **60 секунд** (`DEFAULT_READY_TIMEOUT_MS = 60_000`)
- Интервал poll: **500 мс** (`READY_POLL_INTERVAL_MS`)
- Per-try timeout: **3000 мс** (`READY_POLL_PER_TRY_MS`)
- URL: `http://127.0.0.1:<port>/api/health`

Если child умирает до того как waitForReady завершится — в tree-journal появится
`diag`-событие с `exitCode`/`signal`/`logPath`.

### 7.3 Env propagation

Проверить что FAN_NODE_TOKEN доходит до child:

```bash
# Код: process-manager.ts launch() формирует env:
#   process.env (inherit) + FAN_ORCHESTRATOR_DEPTH + authBase (FAN_NODE_TOKEN, FAN_NO_AUTH=0)
#   + FAN_NODE_NAME + role env (FAN_NODE_ROLE и др.)

# Проверить: запустить fan server вручную с теми же env
export FAN_NODE_TOKEN="test-token-123"
export FAN_NO_AUTH="0"
export FAN_ORCHESTRATOR_DEPTH="1"
fan server --port 7099 --host 127.0.0.1

# В другом терминале:
curl -s http://127.0.0.1:7099/api/health
# Если отвечает — env не проблема
```

### 7.4 Конфликт портов

**Код:** `bundles/fan-mission/extensions/fan-super-orchestrator/port-pool.ts`, `port-registry.ts`

- Диапазон: **7001–7099** (99 портов)
- PortPool блокирует порт в `portsFile` (JSON `{nodeId: port}`)
- Если порт уже занят (другим процессом) — spawn может succeed, но fan server
  не сможет bind и умрёт.

```bash
# Проверить занятые порты в диапазоне
netstat -ano | grep -E ":(700[1-9]|70[1-9][0-9])" | grep LISTENING
```

### 7.5 Orphan cleanup — нормальное поведение

**Код:** `bundles/fan-mission/extensions/fan-super-orchestrator/startup-reconciliation.ts`

При старте нового контура, startup-reconciliation сканирует `portsFile` прошлой сессии:
- PID мёртв → `cleaned_dead`
- PID жив и isOwnChild(pid) → `skipped_own_child` (запись остаётся) ✅ **Фикс 1.1.0**
- PID жив и не свой → SIGTERM → `orphan_cleanup` в journal

> ✅ **Фикс 1.1.0 (F-1):** reconcile() больше не убивает своих детей. Свежеспавненные
> PID определяются через `isOwnChild()` и пропускаются (`skipped_own_child`).
> `orphan_cleanup` появляется **только** для чужих PID из прошлой сессии.

### 7.6 Бюджет: L0 безлимитен, L1+ = 1М токенов

> ✅ **Фикс 1.1.0 (F-3):** L0 бюджет безлимитен. Миссия **не уходит** в
> `budget_exhausted`. При всех `[x]` в ROADMAP итоговый статус миссии — `completed`.

| Уровень | Лимит | Настройка |
|---------|-------|-----------|
| **L0 (главный процесс)** | Не ограничен | `budget_tokens`/`budget_usd` в MISSION.md — информационные |
| **L1+ (дочерние узлы)** | 1 000 000 токенов | env `FAN_CHILD_BUDGET_TOKENS` (default) |

```bash
# Изменить лимит на дочерний узел:
export FAN_CHILD_BUDGET_TOKENS=2000000  # 2М токенов
```

> Если ROADMAP выполнен (все `[x]`), но статус миссии не `completed` — это баг.

### 7.7 Сбор диагностики для репорта

```bash
# 1. Скопировать tree-journal
cp docs/missions/bundle-test-2/tree-journal.jsonl /tmp/tree-journal-bundle-test-2.jsonl

# 2. Скопировать логи детей
cp -r docs/missions/bundle-test-2/logs/ /tmp/mission-logs/ 2>/dev/null

# 3. Скопировать portsFile (если есть)
cp docs/missions/bundle-test-2/child-ports.json /tmp/child-ports.json 2>/dev/null

# 4. Список PID-файлов
ls -la docs/missions/bundle-test-2/pids/ 2>/dev/null

# 5. Проверить живые процессы fan
tasklist | grep fan

# 6. Проверить порты
netstat -ano | grep ":7" | grep LISTENING
```

Собрать всё в репорт:
- Время spawn → время fail/complete (из tree-journal timestamps)
- PID из journal → tasklist (жив/мёртв)
- Порт из journal → netstat (занят/свободен)
- Логи детей (`logs/child-*.log`) — причина смерти если есть

---

## 8. Чек-лист результатов

Заполняется после прогона:

| # | Шаг | Ожидание | Факт | PASS/FAIL |
|---|-----|----------|------|-----------|
| 1 | Smoke: файлы bundle | 4 extensions, 10 roles, routes/wiring | | |
| 2 | Smoke: загрузка расширений | fan doctor — нет ошибок | | |
| 3 | Init миссии | `docs/missions/bundle-test-2/` создан | | |
| 4 | EPIC в ROADMAP | `[EPIC]` пункт добавлен | | |
| 5 | mission start | Сессия запущена, mission-loop tick | | |
| 6 | tree-journal: spawn | Запись `{"event":"spawn",...,"via":"spawn"}` | | |
| 7 | Port 7001+ listening | `netstat` показывает порт | | |
| 8 | /api/health child | `curl` → 200 `{"status":"ok"}` | | |
| 9 | Child логи пишутся | `logs/child-<id>.log` существует и не пуст | | |
| 10 | Нет orphan_cleanup для своих | В journal нет `orphan_cleanup` для свежеспавненных PID | | |
| 11 | EPIC выполнение | Child создал файлы из EPIC | | |
| 12 | tree-journal: complete | Запись `{"event":"complete",...}` | | |
| 13 | ROADMAP closed | `[x]` напротив EPIC-пункта | | |
| 14 | Статус миссии = completed | При всех `[x]` статус `completed` (не `budget_exhausted`) | | |
| 15 | Нет diag в успешном прогоне | `diag`-события отсутствуют (дети не умирали) | | |
| 16 | HTTP delegate (curl) | 200 `{"status":"queued"}` | | |
| 17 | mission stop | Миссия остановлена | | |
| 18 | Ports освобождены | `netstat` — порты 7xxx свободны | | |

### Итоговый вердикт

- **Все PASS** → bundle 1.1.0 работает корректно
- **FAIL на шагах 6-8** → проблема spawn (см. §7.1 — смотреть `logs/child-<id>.log`)
- **FAIL на шаге 9** → stdio pipe не работает (баг process-manager)
- **FAIL на шаге 10** → reconcile() убивает своих детей (баг startup-reconciliation, регрессия F-1)
- **FAIL на шаге 11** → EPIC-delegation не сработал (проверить listenerCount, EventBus)
- **FAIL на шаге 14** → бюджет L0 не безлимитен (баг/регрессия F-3)
- **FAIL на шаге 15** → дети умирают — смотреть `logs/child-<id>.log` для причины
- **FAIL на шаге 16** → auth/payload проблема (проверить токен, schema)

---

## Приложение A: Карта ключевых файлов

> Пути указаны относительно `bundles/fan-mission/extensions/` (source of truth).
> После установки копии находятся в `~/.fan/agent/extensions/`.

| Файл | Что в нём |
|------|-----------|
| `fan-mission/epic-delegation.ts` | EPIC-декомпозиция, emit `mission_delegate`, таймаут 30 мин |
| `fan-mission/mission-loop.ts:1170` | Обнаружение `[EPIC]`, вызов `runEpicDelegation` |
| `fan-super-orchestrator/index.ts:483-515` | session_start → findActiveMission → initCircuit |
| `fan-super-orchestrator/index.ts:350-420` | handleDelegate → canSpawnBatch → depth2.run |
| `fan-super-orchestrator/process-manager.ts:286-289` | spawn: `stdio: ["ignore","pipe","pipe"]` — логи в `child-<id>.log` |
| `fan-super-orchestrator/process-manager.ts:265` | `logFileFor(id)` → `<logsDir>/child-<id>.log` |
| `fan-super-orchestrator/process-manager.ts:365-421` | logStream createWriteStream + exitInfo/logPath в NodeRecord |
| `fan-super-orchestrator/index.ts:128` | `DEFAULT_READY_TIMEOUT_MS = 60_000` |
| `fan-super-orchestrator/node-auth.ts:23` | `buildSpawnEnv(token)` → FAN_NODE_TOKEN + FAN_NO_AUTH=0 |
| `fan-super-orchestrator/startup-reconciliation.ts:147-150` | `isOwnChild` → `skipped_own_child` (не убивает своих) |
| `fan-super-orchestrator/tree-journal.ts:29-37` | TreeJournalEventType: incl. `diag`, `tool_blocked`, `validation_failed` |
| `fan-super-orchestrator/routes/launch-child.ts:242-272` | writeDiagIfDead — diag event с exitCode/signal/logPath |
| `fan-super-orchestrator/wiring/spawned-orchestrator.ts:67` | initRecursiveCircuit — FAN_NODE_ROLE=super-orchestrator |
| `fan-super-orchestrator/routes/launch-child.ts:340-380` | launchSoChild — HTTP delegation |
| `packages/api-gateway/src/auth-mission-delegate.ts` | `verifyNodeToken` — Bearer + timingSafeEqual |
| `packages/api-gateway/src/mission-delegate-schema.ts` | Payload: parentReportId (req), packages (req) |

---

## Приложение B: Известные проблемы (история и статус)

| Проблема | Статус | Комментарий |
|----------|--------|-------------|
| Дети умирают через ~4с после spawn | ✅ **Исправлено в 1.1.0** | Причина была в `stdio: "ignore"` + reconcile убивал своих. При повторении — смотреть `logs/child-<id>.log` |
| `orphan_cleanup` для свежеспавненных PID | ✅ **Исправлено в 1.1.0** | reconcile() теперь использует `isOwnChild()` → `skipped_own_child` |
| `budget_exhausted` при выполненном ROADMAP | ✅ **Исправлено в 1.1.0** | L0 бюджет безлимитен; при всех `[x]` → `completed` |
| Stderr ребёнка терялся | ✅ **Исправлено в 1.1.0** | `stdio: ["ignore","pipe","pipe"]` → `child-<id>.log` |
| `Unable to connect` в child | ℹ️ Зависит от окружения | Проверить провайдер в `models.json`; причина видна в `child-<id>.log` |
