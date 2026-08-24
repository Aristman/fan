# Ручной сценарий тестирования bundle fan-mission 1.0.0

> Версия: 1.0.0 | Дата: 2026-08-24 | Статус: готов к прогону
>
> Цель: полный ручной прогон EPIC-delegation через fan-super-orchestrator —
> от установки бандла до spawn дочерних fan server и наблюдения дерева узлов.

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
| 0.7 | Тестовый проект | `cd C:/Users/User/projects/test-project && pwd` | Директория существует |

### Установка bundle (если ещё не установлен)

**Вариант A — FAN Store (если сервер доступен):**
```bash
fan store install fan-mission
```

**Вариант B — из локального архива:**
```bash
fan store install bundles/fan-mission-1.0.0.tar.gz
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
узлам через env `FAN_NODE_TOKEN` при spawn (`extensions/fan-super-orchestrator/node-auth.ts:23`).

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
> в `extensions/fan-super-orchestrator/index.ts`).

---

## 2. Создание тестовой миссии с EPIC (5 мин)

### 2.1 Инициализация миссии

```bash
cd C:/Users/User/projects/test-project

# Создать миссию (slug: bundle-test)
fan mission init bundle-test "Тест EPIC-delegation bundle fan-mission 1.0.0"
```

Команда создаст `docs/missions/bundle-test/` с файлами:
- `MISSION.md` — frontmatter (status: active, goal, budget)
- `ROADMAP.md` — чеклист задач
- `STATE.md`, `BACKLOG.md`, `DECISIONS.md`, `RECURRING.md`

> **Исходный код:** `packages/coding-agent/src/cli/mission-command.ts:690-720`,
> `extensions/fan-mission/file-state-manager.ts` (initMission)

### 2.2 Добавление EPIC-пункта в ROADMAP

Отредактировать `docs/missions/bundle-test/ROADMAP.md`:

```markdown
# Roadmap

- [ ] Bootstrap mission: bundle-test
- [ ] [EPIC] Создать docs/fiction/bundle-probe/ с 3 короткими md-файлами (по 5 строк): alpha.md, beta.md, index.md
```

**Формат EPIC-пункта:** маркер `[EPIC]` в начале текста (после `- [ ] `).
Источник: `extensions/fan-mission/epic-delegation.ts:27` — `EPIC_MARKER = "[EPIC]"`.

> ⚠️ **НЕ ТРОГАТЬ** существующие миссии в `docs/missions/gmail-watch/` и другие рабочие!

### 2.3 Как EPIC попадает в super-orchestrator

Механизм (из кода `extensions/fan-mission/epic-delegation.ts` и `extensions/fan-mission/mission-loop.ts`):

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
cd C:/Users/User/projects/test-project

# Вариант A: через CLI
fan mission start

# Вариант B: через TUI — slash-команда
# /mission:start
```

### 3.2 Наблюдение tree-journal в реальном времени

```bash
# Открыть ВТОРОЙ терминал Git Bash для наблюдения
tail -f C:/Users/User/projects/test-project/docs/missions/bundle-test/tree-journal.jsonl
```

**Ожидаемые события** (формат JSONL, одно событие на строку):

| Событие | Поля | Что означает |
|---------|------|--------------|
| `spawn` | `nodeId, parentId, port, pid, depth, via` | Дочерний узел порождён. `via: "spawn"` — реальный процесс. |
| `complete` | `nodeId, usage: {tokens, usd}` | Узел завершил задачу. |
| `fail` | `nodeId, diag?` | Узел не смог выполнить задачу. |
| `abort` | `nodeId` | Узел остановлен (shutdown). |
| `orphan_cleanup` | `nodeId, pid` | Startup-reconciliation зачистила orphan из прошлой сессии. |

Источник: `extensions/fan-super-orchestrator/tree-journal.ts:34-55` (TreeJournalEntry).

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
также используется в `extensions/fan-super-orchestrator/index.ts:236` (waitForReady poll).

### 3.5 Ожидаемый happy path

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

Из кода (`extensions/fan-super-orchestrator/routes/launch-child.ts`, `wiring/spawned-orchestrator.ts`):

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
   - Проверить что child поднял recursive circuit (в его логе)

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

Это покрыто в `extensions/fan-super-orchestrator/test/e2e/recursive-spawn.test.mjs`
(3 теста: happy path, walk-up, graceful shutdown).

---

## 6. Graceful shutdown

### 6.1 Остановка миссии

```bash
cd C:/Users/User/projects/test-project

# Остановить миссию
fan mission stop

# Или через TUI:
# /mission:stop
```

### 6.2 Что происходит с child-узлами

Из кода (`extensions/fan-super-orchestrator/index.ts:465-480`, `shutdownCircuit`):

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
tail -5 docs/missions/bundle-test/tree-journal.jsonl
```

---

## 7. Диагностика известной проблемы: 4-секундная смерть child

> **Симптом:** tree-journal показывает `spawn` → через ~4 сек `fail` / `orphan_cleanup`.
> Child fan server умирает почти сразу после порождения.

### 7.1 Что проверить

#### A. waitForReady timeout

**Код:** `extensions/fan-super-orchestrator/index.ts:128,234-248`

- Общий таймаут: **60 секунд** (`DEFAULT_READY_TIMEOUT_MS = 60_000`)
- Интервал poll: **500 мс** (`READY_POLL_INTERVAL_MS`)
- Per-try timeout: **3000 мс** (`READY_POLL_PER_TRY_MS`)
- URL: `http://127.0.0.1:<port>/api/health`

Если child умирает через 4 сек, waitForReady НЕ успевает за 60 сек — он бросит
`"child node not ready on port X within 60000ms"`. Это означает что child **не
успевает подняться** (boot ~10 сек для расширений и провайдеров) и умирает раньше.

#### B. Stdout/stderr child-процесса

**Код:** `extensions/fan-super-orchestrator/process-manager.ts:152-155`

```typescript
const child = spawnFn(serverCommand.command, args, {
    detached: true,
    stdio: "ignore",  // ← ВСЕ ВЫВОДЫ ИГНОРИРУЮТСЯ
    env: { ... }
});
```

**Проблема:** `stdio: "ignore"` означает что stdout/stderr дочернего процесса
**полностью теряются**. Мы НЕ видим почему child умирает.

**Диагностика:** временно изменить `stdio` на `"pipe"` или `"inherit"` и перенаправить
в файл. Но это требует модификации кода (НЕ рекомендуется в production).

Альтернатива — проверить логи fan server:
```bash
# Fan server пишет в ~/.fan/logs/ (если настроено)
ls ~/.fan/logs/ 2>/dev/null
tail -50 ~/.fan/logs/*.log 2>/dev/null
```

#### C. Env propagation

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

#### D. Конфликт портов

**Код:** `extensions/fan-super-orchestrator/port-pool.ts`, `port-registry.ts`

- Диапазон: **7001–7099** (99 портов)
- PortPool блокирует порт в `portsFile` (JSON `{nodeId: port}`)
- Если порт уже занят (другим процессом) — spawn может succeed, но fan server
  не сможет bind и умрёт.

```bash
# Проверить занятые порты в диапазоне
netstat -ano | grep -E ":(700[1-9]|70[1-9][0-9])" | grep LISTENING
```

#### E. Orphan cleanup при рестарте

**Код:** `extensions/fan-super-orchestrator/startup-reconciliation.ts`

При старте нового контура, startup-reconciliation сканирует `portsFile` прошлой сессии:
- PID мёртв → `cleaned_dead`
- PID жив и не свой → SIGTERM → `orphan_cleanup` в journal

Если вы видите `orphan_cleanup` — это нормальная зачистка, не баг.

### 7.2 Сбор диагностики для репорта

```bash
# 1. Скопировать tree-journal
cp docs/missions/bundle-test/tree-journal.jsonl /tmp/tree-journal-bundle-test.jsonl

# 2. Скопировать portsFile (если есть)
cp docs/missions/bundle-test/child-ports.json /tmp/child-ports.json 2>/dev/null

# 3. Список PID-файлов
ls -la docs/missions/bundle-test/pids/ 2>/dev/null

# 4. Проверить живые процессы fan
tasklist | grep fan

# 5. Проверить порты
netstat -ano | grep ":7" | grep LISTENING

# 6. Логи fan (если есть)
ls ~/.fan/logs/ 2>/dev/null
```

Собрать всё в репорт:
- Время spawn → время fail (из tree-journal timestamps)
- PID из journal → tasklist (жив/мёртв)
- Порт из journal → netstat (занят/свободен)
- Есть ли child-логи

---

## 8. Чек-лист результатов

Заполняется после прогона:

| # | Шаг | Ожидание | Факт | PASS/FAIL |
|---|-----|----------|------|-----------|
| 1 | Smoke: файлы bundle | 4 extensions, 10 roles, routes/wiring | | |
| 2 | Smoke: загрузка расширений | fan doctor — нет ошибок | | |
| 3 | Init миссии | `docs/missions/bundle-test/` создан | | |
| 4 | EPIC в ROADMAP | `[EPIC]` пункт добавлен | | |
| 5 | mission start | Сессия запущена, mission-loop tick | | |
| 6 | tree-journal: spawn | Запись `{"event":"spawn",...,"via":"spawn"}` | | |
| 7 | Port 7001+ listening | `netstat` показывает порт | | |
| 8 | /api/health child | `curl` → 200 `{"status":"ok"}` | | |
| 9 | EPIC выполнение | Child создал файлы из EPIC | | |
| 10 | tree-journal: complete | Запись `{"event":"complete",...}` | | |
| 11 | ROADMAP closed | `[x]` напротив EPIC-пункта | | |
| 12 | HTTP delegate (curl) | 200 `{"status":"queued"}` | | |
| 13 | mission stop | Миссия остановлена | | |
| 14 | Ports освобождены | `netstat` — порты 7xxx свободны | | |
| 15 | 4-сек смерть? | Child жив >10 сек после spawn | | |

### Итоговый вердикт

- **Все PASS** → bundle работает корректно
- **FAIL на шагах 6-8** → проблема spawn (см. §7)
- **FAIL на шаге 9** → EPIC-delegation не сработал (проверить listenerCount, EventBus)
- **FAIL на шаге 12** → auth/payload проблема (проверить токен, schema)
- **FAIL на шаге 15** → 4-секундная смерть (см. §7, диагностика)

---

## Приложение A: Карта ключевых файлов

| Файл | Что в нём |
|------|-----------|
| `extensions/fan-mission/epic-delegation.ts` | EPIC-декомпозиция, emit `mission_delegate`, таймаут 30 мин |
| `extensions/fan-mission/mission-loop.ts:1170` | Обнаружение `[EPIC]`, вызов `runEpicDelegation` |
| `extensions/fan-super-orchestrator/index.ts:483-515` | session_start → findActiveMission → initCircuit |
| `extensions/fan-super-orchestrator/index.ts:350-420` | handleDelegate → canSpawnBatch → depth2.run |
| `extensions/fan-super-orchestrator/process-manager.ts:140-175` | spawn: `fan server --port N --host 127.0.0.1` |
| `extensions/fan-super-orchestrator/process-manager.ts:152` | `stdio: "ignore"` — причина невидимости логов child |
| `extensions/fan-super-orchestrator/index.ts:128` | `DEFAULT_READY_TIMEOUT_MS = 60_000` |
| `extensions/fan-super-orchestrator/node-auth.ts:23` | `buildSpawnEnv(token)` → FAN_NODE_TOKEN + FAN_NO_AUTH=0 |
| `packages/api-gateway/src/auth-mission-delegate.ts` | `verifyNodeToken` — Bearer + timingSafeEqual |
| `packages/api-gateway/src/mission-delegate-schema.ts` | Payload: parentReportId (req), packages (req) |
| `extensions/fan-super-orchestrator/wiring/spawned-orchestrator.ts:67` | initRecursiveCircuit — FAN_NODE_ROLE=super-orchestrator |
| `extensions/fan-super-orchestrator/routes/launch-child.ts:340-380` | launchSoChild — HTTP delegation |
