# Backlog: Headless Mission Mode — миссия как daemon без TUI

> Дата: 2026-08-22 · Статус: предложено · Приоритет: P1 · Источник: запрос пользователя (CI/cron/server automation)
> Связанные файлы: `docs/features/super-orchestrator/manual-testing.md`, `extensions/fan-mission/mission-loop.ts`, `packages/coding-agent/src/cli/mission-command.ts`

---

## Цель

Запуск миссии как фоновый процесс без TUI-сессии. Команда `fan mission run <slug>` зацикливает `MissionLoop.tick()` по `tick_interval_ms`, логи пишутся в `mission.log`, решения `DECIDE` автоматические или через `approval.json`, EPIC-делегирование через super-orchestrator работает реально (spawn дочерних `fan server` процессов). Идеально для CI / cron / server-side automation.

---

## Проблема (подтверждено кодом, 2026-08-22)

### 1. `fan mission start` не запускает agent loop

**Файл:** `packages/coding-agent/src/cli/mission-command.ts:26`

Список субкоманд: `["init", "start", "stop", "status", "pause", "resume", "tree"]`. Команда `start`:
> «только проверки + FSM-переход через `file-state-manager`, реальный executor подключается на этапе 1» (комментарий строки 12-13).

**Результат:** CLI меняет `MISSION.md.status` на `active`, но `MissionLoop.tick()` не вызывается. Без TUI/IDE-сессии миссия «активна» лишь формально.

### 2. Executor жёстко привязан к живой agent-сессии

**Файл:** `extensions/fan-mission/default-run-agent.ts` (через DI в `extensions/fan-mission/index.ts:14-17`)

Дефолтный исполнитель = `sendUserMessage(followUp)` + ожидание `agent_end`. Контракт:
> «Default executor (no session_start hook → mock session)» — требуется живая сессия для `sendUserMessage`.

**Результат:** без TUI сессии executor не работает. Mission loop не может делать `runAgent(...)`.

### 3. Tick живёт в одном процессе через EventBus

**Файлы:**
- `extensions/fan-scheduler/scheduler.ts:174-215` — отправляет `mission_tick` через EventBus
- `extensions/fan-mission/tick-bridge.ts` — получает `mission_tick` → `loop.tick()`
- `packages/coding-agent/src/core/event-bus.ts:1-56` — EventBus = `EventEmitter` in-process only

**Результат:** scheduler не может тикать миссии в чужом процессе (нет IPC EventBus). Headless-режим должен поднимать весь runtime (extensions + EventBus) в одном процессе.

### 4. DECIDE вешает миссию на 1 час

**Файлы:**
- `extensions/fan-mission/mission-loop.ts:541` — DECIDE wait timeout default 1 час
- `mission-loop.ts:820-823` — обрыв тика на DECIDE
- `decision-dialog.ts:13-15` — есть headless-ветка, но только `headlessNotify warning`, **диалога нет**

**Результат:** без UI DECIDE → `awaiting_decision` → 1 час ожидания → abort. Не работает для automation.

### 5. fan-webhook — inbound only

**Файл:** `extensions/fan-webhook/index.ts:1-20`

Принимает внешние хуки → `sendMessage` в активную сессию. **Outbound нотификаций (notify on events) нет** — нужно явно добавлять.

---

## Use cases

### UC-1: CI pipeline

GitHub Actions / GitLab CI job:

```bash
fan mission run docs-fix --once
# Exit code: 0 = COMPLETE/нет работы, 1 = FAILED, 2 = DECIDE (при policy=fail)
# Логи в artifact: docs/missions/docs-fix/mission.log
```

Воспроизводимо в CI без терминала. Каждая итерация — отдельный job.

### UC-2: Cron / systemd timer

Ночной тик миссии дежурства (RECURRING.md):

```ini
# /etc/systemd/system/fan-mission-maintenance.service
[Service]
Type=simple
ExecStart=/usr/local/bin/fan mission run maintenance --foreground --log /var/log/fan/mission.log
Restart=on-failure
RestartSec=60
```

Проверяет новые письма / PR / issues / etc. Уведомления через webhook (UC-4).

### UC-3: Server-side automation (VPS, supervisor)

Долгоживущая миссия на VPS без терминала:

```ini
# /etc/supervisor/conf.d/fan.conf
[program:fan-mission]
command=/opt/fan/bin/fan mission run production-triage --foreground
autostart=true
autorestart=true
stderr_logfile=/var/log/fan/mission.err.log
stdout_logfile=/var/log/fan/mission.out.log
```

### UC-4: EPIC-heavy миссии (главная мотивация)

Делегирование `[EPIC]`-пунктов дочерним `fan server` процессам **без необходимости держать TUI открытым сутками**. Сейчас это невозможно: пользователь должен сидеть в TUI чтобы миссия тикала. Headless-mode позволяет запустить EPIC-миссию на сервере, закрыть ноутбук, утром получить результат через webhook или файл `docs/audit/`.

---

## Detailed design

### 5.1 CLI signature

```bash
fan mission run <slug> [--once] [--foreground] [--interval-ms N] \
                     [--log <path>] [--decision-policy auto-default|skip|fail] \
                     [--notify <url>] [--pidfile <path>]
```

| Флаг | Поведение |
|------|-----------|
| `--once` | один полный tick + exit. По умолчанию — зацикливается. |
| `--foreground` | не daemonize, не отвязывайся от stdin. По умолчанию — fork + pidfile. |
| `--interval-ms N` | перекрывает `tick_interval_ms` из frontmatter |
| `--log <path>` | путь к лог-файлу (по умолчанию `<missionDir>/mission.log`) |
| `--decision-policy` | auto-default (default) / skip / fail |
| `--notify <url>` | outbound webhook URL для уведомлений (overrides frontmatter `notify_webhook`) |
| `--pidfile <path>` | путь к pidfile (по умолчанию `<missionDir>/.mission-run.pid`) |

**Exit codes** (при `--once` или graceful shutdown):

| Код | Значение |
|-----|----------|
| 0 | COMPLETE / no unchecked work / shutdown чистый |
| 1 | FAILED (tick exception или budget_exhausted) |
| 2 | DECIDE при `--decision-policy=fail` (ждёт `approval.json`) |
| 3 | Invalid arguments (slug не найден / parse error) |
| 130 | SIGINT / SIGTERM (graceful) |

**Регистрация субкоманды:** расширить `SUBCOMMANDS` в `packages/coding-agent/src/cli/mission-command.ts:26`. Добавить `"run"` с handler `runMissionHeadless(args, ctx)`.

### 5.2 Tick loop architecture

Inline-цикл внутри процесса `run`. **Не использовать fan-scheduler** — он шлёт `mission_tick` в EventBus чужого процесса (а мы in-process).

```typescript
async function runMissionHeadless(slug: string, opts: RunOpts): Promise<number> {
  // 1. Load mission
  const mission = await loadMission(slug);  // existing helper
  const intervalMs = opts.intervalMs ?? readTickIntervalMs(mission.dir);
  const loop = createMissionLoop(mission, /* runAgent: */ headlessRunAgent, /* tickBridge: */ headlessTickBridge);
  
  // 2. Wire super-orchestrator (для EPIC delegation через real spawn)
  await wireSuperOrchestrator(mission.dir);  // existing pattern
  
  // 3. Acquire file-lock
  const lock = await acquireLock(mission.dir);
  
  // 4. Tick loop
  try {
    if (opts.once) {
      const result = await loop.tick();
      return mapExitCode(result);
    }
    while (!shutdownSignal()) {
      const result = await loop.tick();
      logTickResult(mission.dir, result);
      if (result === "completed") return 0;
      await sleep(intervalMs);
    }
  } finally {
    await lock.release();
    writeLoopStateSync(mission.dir, currentState);  // checkpoint
    removePidfile(opts.pidfile);
  }
}
```

**Переиспользовать R3-pattern** из `extensions/fan-scheduler/scheduler.ts:174-210`:
- per-mission throttle через `lastTickByMission`
- `readTickIntervalMs(missionDir)` — уже реализовано в scheduler
- busy-guard: если tick ещё выполняется, пропустить следующий

**Graceful shutdown:** SIGTERM/SIGINT → `shutdownSignal = true` → текущий tick завершается → checkpoint → exit.

### 5.3 Headless executor (LLM adapter)

**Новый файл:** `extensions/fan-mission/headless-run-agent.ts`

Аналог `default-run-agent.ts`, но без chat. Два варианта:

#### Вариант A: Эмулировать session через `fan server` runtime

Запустить `fan server` в фоне на dedicated порту, использовать как agent-runtime. Переиспользовать всю инфраструктуру (tools, providers, model management). **Минус:** overhead отдельного процесса на каждую миссию.

#### Вариант B: Прямой вызов ProviderRouter

Использовать `ProviderRouter` напрямую из mission-loop. Tools загружать через `tool-manifest.ts`. **Минус:** нужен новый runtime-loop (iterate → tool call → iterate), дублирование логики agent-loop.

**Рекомендация:** Вариант A (использовать existing agent-runtime). Меньше дублирования, проверенная инфраструктура.

#### Wiring

```typescript
// extensions/fan-mission/index.ts
export default defineExtension((api) => {
  // existing wiring
  const isHeadless = process.env.FAN_HEADLESS === "1";
  const runAgent = isHeadless
    ? createHeadlessRunAgent(api)  // NEW
    : createDefaultRunAgent(api);   // existing
  
  const mission = wireMission(api, { runAgent, /* ... */ });
});
```

`FAN_HEADLESS=1` env flag устанавливается автоматически `fan mission run` при старте.

### 5.4 Decision handling

| Policy | Поведение |
|--------|-----------|
| `auto-default` (default) | DECIDE → берём default-вариант («continue roadmap»), запись в `DECISIONS.md` + `mission.log`. |
| `skip` | DECIDE-пункт → `BLOCKED`, пропускаем, продолжаем следующий. |
| `fail` | DECIDE → `awaiting_decision`, процесс **ждёт escape hatch**: файл `docs/missions/<slug>/approval.json` `{"answer": "...", "decidedBy": "operator"}`. File-watcher подхватывает → `resolveDecision()`. |

**Реализация:** расширить headless-ветку в `extensions/fan-mission/decision-dialog.ts:13-15` (сейчас только warning). Добавить три policy-handler'а.

**Approval.json формат:**

```json
{
  "answer": "approve" | "reject" | "skip" | "...",
  "decidedBy": "operator",
  "decidedAt": "2026-08-22T03:14:02.123Z",
  "notes": "optional free text"
}
```

**Watcher:** `fs.watch` на `approval.json` или polling каждые5 сек в tick-loop. После consumption → `mv approval.json approval.processed.json` (атомарно).

### 5.5 Log format

**Файл:** `docs/missions/<slug>/mission.log`, append-only. Ротация:10 MB × 3 файла (`.log`, `.log.1`, `.log.2`).

**Структура строки:**

```
[2026-08-22T03:00:01Z] LEVEL message
```

**Уровни:** `DEBUG` / `INFO` / `WARN` / `ERROR`.

**Пример:**

```
[2026-08-22T03:00:01Z] INFO TICK #42 start (interval=60000ms, slug=gmail-watch)
[2026-08-22T03:00:03Z] INFO STEP wake → read → decide: item="Add rate limiting" [EPIC]
[2026-08-22T03:00:05Z] INFO DELEGATE correlationId=abc123 packages=3 → spawn depth=1
[2026-08-22T03:00:05Z] INFO spawn child fan server pid=27164 port=7101 depth=1
[2026-08-22T03:00:05Z] INFO spawn child fan server pid=27165 port=7102 depth=1
[2026-08-22T03:00:05Z] INFO spawn child fan server pid=27166 port=7103 depth=1
[2026-08-22T03:12:40Z] INFO DELEGATE result: 3/3 completed, usage={tokens:182000,usd:0.41}
[2026-08-22T03:12:41Z] INFO TICK #42 COMPLETE commit=a1b2c3d cost=$0.47 budget_remaining=9.53
[2026-08-22T03:14:02Z] INFO DECIDE "Включить breaking change?" → auto-default: continue (DECISIONS.md)
[2026-08-22T03:15:00Z] INFO TICK #43 start
[2026-08-22T03:15:30Z] ERROR TICK #43 FAILED: budget_exhausted
[2026-08-22T03:15:30Z] INFO MISSION status=budget_exhausted, stopping tick loop
[2026-08-22T03:15:30Z] INFO exit 1
```

### 5.6 EPIC delegation (real spawn)

Без изменений в протоколе:
- Канал `mission_delegate` / `mission_delegate_result:<correlationId>` (`extensions/fan-mission/epic-delegation.ts:38-47`)
- Таймаут30 мин
- Fallback на локальный executor при любой неудаче
- Super-orchestrator спавнит дочерние `fan server` через `process-manager` (`extensions/fan-super-orchestrator/index.ts:36-44`)

**Требование:** headless-процесс должен регистрировать super-orchestrator wiring (init-контур, tree-journal, budget, depth через `FAN_ORCHESTRATOR_DEPTH`). Это значит **headless-режим эмулирует session lifecycle hooks** (`session_start`, `session_end`).

Подход: внутри headless-runner вызвать `wireSuperOrchestrator(mission.dir)` явно, передавая `missionDir` и `eventBus`. Не полагаться на `api.on("session_start")` (он не сработает — мы не TUI).

**Уже существующая проблема** (из live-testing incident): `listenerCount?.()` отсутствовал в EventBus (исправлен в commit `0756fbd`). В headless-режиме проблема может проявиться ярче — без TUI fallback на "no subscribers" должен срабатывать чётко.

### 5.7 Webhook notify (outbound)

**Новый мини-модуль:** `extensions/fan-mission/notify-webhook.ts` (или часть `headless-runner.ts`).

**Frontmatter поле:** `notify_webhook: <url>` в MISSION.md, или CLI `--notify <url>`.

**События для нотификации:**
- tick COMPLETE / FAILED
- DECIDE при `--decision-policy=fail` (ждущий approval)
- mission completed / budget_exhausted
- EPIC delegation failure (например, `node_cap_exceeded`)

**POST JSON формат:**

```json
{
  "slug": "gmail-watch",
  "event": "tick_completed" | "tick_failed" | "decide_pending" | "mission_completed" | "budget_exhausted" | "delegation_failed",
",
  "tick": 42,
  "status": "active" | "completed" | "failed" | "budget_exhausted",
  "ts": "2026-08-22T03:00:01.000Z",
  "cost": { "tokens": 182000, "usd": 0.41 },
  "details": { ... }
}
```

**Retry:** exponential backoff (1s, 5s, 30s), max 3 попытки. При permanent fail → `mission.log` ERROR.

### 5.8 Graceful shutdown

```
SIGTERM / SIGINT
  ↓
shutdownSignal = true (atomic flag)
  ↓
Текущий tick завершается (НЕ прерывается)
  ↓
writeLoopStateSync(mission.dir, currentState)  // checkpoint
  ↓
release file-lock
  ↓
removePidfile
  ↓
exit 0
```

**Stop command** (расширение существующего `fan mission stop`): если есть pidfile и процесс жив → послать SIGTERM. Иначе → release file-lock.

**PID файл:** `<missionDir>/.mission-run.pid`, atomic write (tmp + rename).

---

## Open questions

1. **Headless executor: Variant A или B?** Вариант A (эмулировать через `fan server` runtime) переиспользует проверенную инфраструктуру, но overhead процесса. Вариант B (прямой ProviderRouter) проще, но дублирует agent-loop. **Требуется решение пользователя.**

2. **Daemonize на Windows:** использовать process-detach, Windows Task Scheduler, или только `--foreground` для supervisor/systemd? **В Unix-окружении — fork+pidfile. На Windows — NSSM/Task Scheduler.**

3. **Auto-default для DECIDE:** всегда «continue», или читать default из frontmatter (`decision_default: "approve" | "reject" | "skip"`)? **Требуется решение пользователя.**

4. **REST/WS endpoint в api-gateway для headless?** Управление через CLI достаточно, или нужен HTTP endpoint для `GET /api/missions/<slug>/status` в headless-режиме? **По scope — отложить в V2.**

5. **Множественные headless-миссии на одной машине:** один процесс на миссию (текущий план), или мульти-mission daemon (один процесс тикает несколько миссий)? **Мульти-mission daemon — V2.**

6. **Взаимодействие с TUI-сессией на той же миссии:** `MissionLock` (`mission-loop.ts:96-99`) уже защищает. Достаточно ли его, или нужна дополнительная логика? **Проверить через тесты.**

---

## Out of scope

- UI / дашборд для headless-миссий (V2)
- Распределённые миссии на нескольких машинах
- Изменение протокола `mission_delegate`
- Переписывание fan-scheduler
- Изменения inbound webhook (fan-webhook)
- Windows service registration (NSSM, sc.exe) — задокументировать, но не реализовать
- Multi-mission daemon (один процесс тикает несколько) — V2
- Поддержка мульти-process orchestration через systemd socket activation

---

## Acceptance criteria

### AC-1: `--once` в CI без TUI

```bash
git clone https://github.com/test/repo
cd repo
fan mission init docs-fix "Fix outdated documentation"
fan mission run docs-fix --once
# Ожидаемое: exit 0, mission.log создан, ≤1 tick выполнен
```

Воспроизводимо в CI pipeline (GitHub Actions, GitLab CI) без выделенного терминала. Exit code корректен (0=COMPLETE, 1=FAILED).

### AC-2: EPIC delegation → real spawn

Миссия с `[EPIC]`-пунктом в ROADMAP в headless-режиме **реально спавнит дочерний `fan` процесс**:
- В `mission.log` видно `INFO spawn child fan server pid=... port=...`
- `tree-journal.jsonl` содержит записи `spawn` с `correlationId, nodeId, parentId`
- Дочерний процесс виден в `ps aux | grep "fan server"` / Task Manager
- Результаты приходят через `mission_delegate_result:<id>` и учитываются в бюджете

### AC-3: Decision policies работают

```bash
# auto-default (default)
fan mission run foo --once  # exit 0
# DECIDE в DECISIONS.md + mission.log, тик продолжается

# fail с approval.json
echo '{"answer":"approve","decidedBy":"operator"}' > docs/missions/foo/approval.json
# Процесс видит файл, resolveDecision(), продолжает
```

С policy=fail миссия ждёт `approval.json`, корректно резолвится после появления (≤5 сек latency от watcher'а).

### AC-4: Graceful shutdown

```bash
fan mission run foo &
PID=$!
sleep 30
kill -TERM $PID
wait $PID
echo "exit code: $?"  # 0
```

`kill -TERM` во время ожидания между тиками → checkpoint в `.mission-loop.json`, чистый exit. Повторный `fan mission run foo` продолжает с checkpoint.

---

## Dependencies

| Модуль | Использование |
|--------|--------------|
| `extensions/fan-mission/mission-loop.ts` | tick, LoopState, checkpoint, MissionLock (1-1500, 2200-2300) |
| `extensions/fan-mission/index.ts` + `default-run-agent.ts` | wiring, DI runAgent (1-50, default-run-agent.ts) |
| `extensions/fan-mission/decision-dialog.ts` | headless-ветка расширяется (1-50, 100-150) |
| `extensions/fan-mission/epic-delegation.ts` | без изменений, протокол остаётся (1-280) |
| `extensions/fan-scheduler/scheduler.ts` | только как референс pattern (R3 tick_interval_ms) |
| `extensions/fan-super-orchestrator/index.ts` | mission_delegate handler, init-контур (1-100, 500-580) |
| `packages/coding-agent/src/core/event-bus.ts` | in-process события (1-56) |
| `packages/coding-agent/src/cli/mission-command.ts` | регистрация субкоманды `run` (12-26) |
| `extensions/fan-webhook` | только как референс — outbound новый |

---

## Risks

| # | Risk | Смягчение |
|---|------|-----------|
| 1 | Дублирование lifecycle wiring (session_start эмуляция может разойтись с реальным TUI) | Выделить `wireSuperOrchestrator(missionDir)` в отдельный exported helper, использовать и в TUI, и в headless |
| 2 | Race с TUI-сессией на той же миссии | `MissionLock` уже защищает; добавить явный error message при lock conflict |
| 3 | Auto-default DECIDE принимает нежелательное решение | policy=fail + approval.json + webhook-алерт при DECIDE |
| 4 | Бесконтрольный loop съедает бюджет | `budget_usd` enforcement уже в `mission-loop.ts`; добавить `--max-runtime` флаг |
| 5 | Daemonize на Windows: detached процесс может не иметь console output | `--foreground` обязателен на Windows, документировать |
| 6 | PID file race при kill/restart | atomic write через tmp+rename, проверка pid живой через `kill -0` перед записью |
| 7 | Mission log растёт неограниченно | Ротация (5.5):10 MB ×3 файла |
| 8 | Headless-runner start до загрузки extensions | Strict ordering: extensions → wire mission → start tick |

---

## Effort estimate

**~3-5 дней** для одного разработчика:

| Задача | Дней |
|--------|------|
| CLI-команда + inline tick-loop | 1 |
| Headless executor-адаптер (Variant A) | 1-2 (самый неопределённый) |
| Decision policies + approval.json watcher | 0.5 |
| Mission.log + ротация | 0.5 |
| Webhook notify (outbound) | 0.5 |
| Graceful shutdown + tests | 1 |
| Docs (минималь) | 0.5 |

---

## Связанные backlog'и

- `docs/backlogs/tasklist-persistence-backlog.md` — TaskList persistence (отдельная фича)
- `docs/backlogs/setup-wizard-backlog.md` — init-wizard (отдельная фича)
- `docs/backlogs/session-analytics-usage-plan.md` — analytics (отдельная фича)
- `docs/backlogs/package-fork-backlog.md` — package fork (отдельная фича)

## История

- **2026-08-22:** Спека создана (этот файл). Источник: live-testing incident с EPIC delegation, где обнаружено что `fan mission start` не запускает agent loop без TUI.