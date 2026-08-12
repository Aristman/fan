# Pipeline Report: Сверх-оркестратор FAN

> **Старт:** 2026-08-10
> **Ветка:** FAN/feature/new-agents-flow
> **Roadmap (4):** docs/features/super-orchestrator/{mission-loop-0, mission-validation-1, http-hierarchy-2, depth-and-dashboard-3}/roadmap.md
> **Стратегия коммитов:** per-function · **Контрольные точки:** только в конце (+ при исчерпании попыток)
> **Режим:** все 4 roadmap подряд без остановки, phase-gate на границах

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего фич (4 roadmap) | 47 (48 с F-48) |
| Реализовано (✅) | 15 (этап 0) |
| Провалено (❌) | 0 |
| Коммитов | 19 (15 фич + 2 phase-gate/docs + 2 doc) |
| Verify final | PASS (2100+ тестов зелёные) |
| Smoke e2e phase A | PASS (e2e-phase-a-interrupts 3/3) |
| Phase-gate | PASS |

## Прогресс

### Этап 0: mission-loop-0 (F-01..F-15) — ✅ ЗАВЕРШЁН (15/15)

| Фича | Статус | Коммит | Тесты | Попыток |
|------|--------|--------|-------|---------|
| F-01 REST abort | ✅ | f0a83af | 65/65 api-gateway | 1 (+1 fix) |
| F-02 Лимиты очередей | ✅ | 42360a6 | 54/54 + 3 phantom | 1 (+1 fix) |
| F-03 Watchdog | ✅ | bb273e3 | 19 watchdog / 1089 | 1 (+1 fix) |
| F-04 Детектор циклов | ✅ | 7a41f82 | 33 / 1121 | 1 (+2 fix) |
| F-05 Drain-флаг | ✅ | cb66834 | 17 drain + 55 agent | 1 (+2 fix) |
| F-06 Drain API | ✅ | 94c659d | 81/81 api-gateway | 1 |
| F-07 budget_alert | ✅ | 41fcf61 | 92/92 api-gateway | 1 (+1 fix) |
| F-08 File-state-manager | ✅ | 6e51409 | 84/84 | 1 (+1 fix) |
| F-09 Mission loop | ✅ | dcdde97 | 163/163 fan-mission | 1 (+3 fix) |
| F-10 CLI init | ✅ | 665a392 | 40 CLI + 171 fan-mission | 1 (+1 fix) |
| F-11 Slash-команды | ✅ | 0fb7284 | 207/207 fan-mission (+36 новых) | 1 |
| F-12 TUI-виджет | ✅ | 5fd84c1 | 29/29 (выровнены со спекой v3) | 1 |
| F-13 fan-scheduler | ✅ | a972f23 | 38 (27 + 11 resilience/timing/strict) | 1 |
| F-14 fan-webhook | ✅ | d9ef7d1 | 46 (25 integration + 21 router unit) | 1 |
| F-15 Интеграционные тесты | ✅ | d5c3b42 | 22 integration / 258 fan-mission total | 1 |

### Фаза A «Ядро прерываний» — ✅ ЗАВЕРШЕНА (phase-gate `31f605e`: 3 e2e + 131 unit, PASS)
### Фаза B «Контур миссии» — ✅ ЗАВЕРШЕНА (F-08, F-09, F-10, F-11, F-12)
### Фаза C «Внешние триггеры и интеграция» — ✅ ЗАВЕРШЕНА (F-13, F-14, F-15)

### Этап 1: mission-validation-1 (F-16..F-22) — ⏳ СЛЕДУЮЩИЙ (старт по команде)
- F-48 (tasklist persistence) включён в этап 1 (запланирован фичей, см. `mission-validation-1/roadmap.md`)

### Этап 2: http-hierarchy-2 (F-23..F-35) — ожидает
### Этап 3: depth-and-dashboard-3 (F-36..F-47) — ожидает

## Точка возобновления (2026-08-12, ЭТАП 0 ЗАВЕРШЁН)

**Состояние:** этап 0 полностью завершён. Все 15/15 фич реализованы и зелёные. Phase-gate фазы A пройден (commit `31f605e`, 3/3 e2e + 131 unit). Verify final: PASS (2100+ тестов). Smoke `e2e-phase-a-interrupts`: PASS (3/3).

**Следующий шаг:** начать этап 1 — `mission-validation-1` (F-16..F-22) + F-48 (персистентность таск-листа). Прочитать `docs/features/super-orchestrator/mission-validation-1/roadmap.md`, сгенерировать таск-лист (TaskCreate) на все 8 фич этапа 1, и взять первую P1-фичу (F-16 «Парсер тегов обещаний», нет зависимостей). Все фичи этапа 1 — P1, ни одна не блокирует другую по жёстким зависимостям (F-16 самостоятелен, F-17 ↔ F-09, F-18 ↔ F-09, F-19..F-22 самостоятельны или последовательны).

**Протокол возобновления:**
1. Прочитать этот файл + roadmap `mission-validation-1/roadmap.md` (статусы ☐).
2. Создать таск-лист оркестратора (TaskCreate) на F-16..F-22 + F-48 + verify/smoke/docs (контрольная точка в конце этапа 1). Зависимости wired.
3. Взять первую фичу ☐ (F-16), выполнить Red → Green → verify → commit per-function.
4. Контрольные точки: только в конце этапа 1 (фазы A, B, C) — phase-gate там.
5. Ветка: FAN/feature/new-agents-flow (та же).

**Ключевые решения по ходу (для будущих фич):**
- `writeMissionStatus` — единственный легальный способ менять MISSION.md (только status, через FSM canTransition);
- abort-гонка исправлена глобально: agent-loop чекает signal.aborted между ходами;
- drain state-машина: idle→draining→drained→idle, события 1:1:1;
- budget=0 = unlimited (везде); budgetCountedFor привязан к item;
- recovery контура: по наличию iterationResult в журнале, независимо от interrupted;
- integration через файловые сигналы: `.mission-steer-queue.json` (webhook→executor), `.mission-drain-flag` (drain→paused) — позволяет расширениям общаться без прямых импортов (DI-style);
- **персистентность таск-листа** запланирована в этапе 1 как фича **F-48** (`mission-validation-1/roadmap.md`), подробности — backlog `docs/backlogs/tasklist-persistence-backlog.md`. До тех пор доска пересоздаётся из `pipeline-report.md` и соответствующего roadmap;
- известный pre-existing падеж: agent-session-concurrent steering-тест (quarantine-тикет в бэклоге).

## Журнал

- **2026-08-10** — Pipeline инициализирован. Создано 18 задач (15 фич + verify/smoke/docs), зависимости wired.
- **2026-08-10** — **F-01 ✅** REST abort + WS abort. Red 14/14 FAIL → Green +31/−2 → verify FAIL (biome format, 1 строка) → bug-fix (format + reason-параметр + console.warn) → PASS. Коммит `f0a83af`.
- **2026-08-10** — **F-02 ✅** Лимиты очередей (QueueOverflowError, дефолт 50). Red 14/15 → Green +18 LOC → verify PASS (находки: P1 фантом в shadow-очереди, P2 нет валидации лимита) → bug-fix P1+P2+ниты → 54/54. Коммит `42360a6`.
- **2026-08-10** — **F-03 ✅** Watchdog. Red 3/7 → Green (+105 LOC) → verify FAIL (блокер: один таймер разоружался параллельными tool calls — дефолтный режим!) → bug-fix: WatchdogTimer класс с Map per-toolCallId + валидация timeoutMs + elapsedMs от последнего reset → 1089/1089. Коммит `bb273e3`.
- **2026-08-10** — **F-04 ✅** Детектор циклов. Red 5/11 → Green → verify FAIL (микротаск-эстафета 700×count, one-shot на сессию, biome) → fix1 → verify FAIL (гонка abort в runLoop, reset за extensionRunner) → fix2 (чек signal.aborted между ходами в agent-loop — глобальный фикс abort-гонки; reset на agent_start) → **PASS**. Коммит `7a41f82`.
- **2026-08-10** — **F-05 ✅** Drain-флаг. Red 10/10 → Green (+36 LOC) → verify FAIL (P1 потеря followUp после text-only хода, P2 prompt-байпас, P3 retry-байпас, P4 гонка resume) → fix1 (state-машина idle→draining→drained→idle, guard'ы) → verify FAIL (гонка установки drain в окне turn_end→agent_end) → fix2 (условие `_drainStopPending || _drainAfterCurrentTurn`, drain_cancelled, compaction-гварды) → гейт PASS. Коммит `cb66834`. Старт: F-06.
- **2026-08-10** — ⚠️ Инцидент: pipeline-report.md потерял несохранённые правки после stash-проверки флаки-теста. Восстановлен из контекста координатора; отныне коммитится вместе с каждой фичей.
- **2026-08-10** — ⚠️ Сеть: 4 воркера убиты обрывами (verify F-09, bug-fix ×3). Перезапуск роутера решил. Урок: воркеры чувствительны к сети; умершие воркеры не оставляют правок — повторять делегацию.
- **2026-08-10** — **F-09 ✅** Mission loop. Red 22/22 → Green 387 LOC → verify FAIL (recovery работал только в сконструированном тесте: lastStep на 3/7, abort mid-tick коммитил после I0, шаг 6 неатомарен, budget_usd не enforced, зомби-цикл, нет межпроцессного lock) → fix1 (глубокий: журнал по шагам, abort-сигнал, file-lock, архивация) → verify FAIL (SIGKILL recovery, double-count, paused, zombie-дубли) → fix2 → verify FAIL (writeRoadmap неатомарен, stale budgetCounted → under-count) → fix3 (budgetCountedFor per-item, atomic writeRoadmap) → **PASS** (окна W3/W4/W5 эмпирически). 163/163. Коммит `dcdde97`.
- **2026-08-10** — **F-06 ✅** Drain API. REST `POST /api/sessions/:id/drain` + WS `drain` команда. 81/81 api-gateway. Коммит `94c659d`.
- **2026-08-10** — **F-07 ✅** budget_alert WS продюсер. Пороги 80%/95%/100%, дедупликация по периоду. 92/92. Коммит `41fcf61`.
- **2026-08-10** — **F-08 ✅** File-state-manager. Чтение/запись 5 файлов миссии (MISSION.md immutable), валидация схемы, FSM статусов, STATE.md 5 KB лимит. 84/84. Коммит `6e51409`.
- **2026-08-10** — **phase-gate ✅** `31f605e` — full stack e2e (AgentSession + SessionAdapter + Hono + WS + node:http), REST abort <1s с agent_end, WS abort симметричен, watchdog на hung tool. Фаза A complete: 7/7 фич, 131 unit + 3 e2e зелёные.
- **2026-08-10** — 📌 Checkpoint `2583e3a` (docs/pipeline: checkpoint after F-09). Остановка по команде оператора; точка возобновления F-10.
- **2026-08-10** — 📌 Backlog note `545ba1b` (docs/pipeline: note task-list ephemerality in resumption protocol).
- **2026-08-10** — 📌 Backlog `f2233bf` (docs/backlogs: task list persistence for orchestrator) + feature `931e9fb` (docs: add task-list persistence feature (F-48)) — таск-лист persistence включён в этап 1 как F-48.
- **2026-08-12** — **F-10 ✅** CLI `fan mission init|start|stop|status|pause|resume` + `--template <T>` (default + refactor). Шаблоны вынесены в `extensions/fan-mission/templates/`. `InvalidTransitionError` + dispatcher error handling. CLI help + README mission section. 40 mission-command + 92 file-state-manager + 171 fan-mission total. Коммит `665a392`.
- **2026-08-12** — **F-11 ✅** Slash-команды `/mission:*`. 7 команд: `start`, `stop` (I0), `pause` (I1/drain), `resume`, `status`, `steer` (I2), `decide` (I3). DI-style регистрация (callback + ctx). Guarded handlers: не бросают наружу, выводят `Error:...`. 36 новых тестов, 207/207 fan-mission зелёные. Коммит `0fb7284`.
- **2026-08-12** — **F-12 ✅** TUI-виджет статуса миссии (`Alt+M`). DI: registerShortcut, ui, missionLoop, uiEvents, getStatusSnapshot. Подписка на `mission_iteration_end` с override payload. Default `visible=true` по спеке (всегда видим при активной миссии). Строка: `Статус / Итерация / Расход / Этап`. 29/29. Коммит `5fd84c1`.
- **2026-08-12** — **F-13 ✅** `fan-scheduler` — cron-планировщик тиков I4. `startScheduler(ctx) → { stop }` через `setInterval` или `cronExpression`. `cron-parser.ts`: 5-field cron со строгой валидацией (отвергает `1.5`/`0x1`/`1e2`). `.catch()` resilience: scheduler переживает падения `sendMessage`/`getStatus`. Плейсхолдеры `{missionDir}`, `{date}` в `tickPrompt`. 38 тестов (27 + 11 resilience/timing/strict), fan-mission 236/236 не сломаны. Коммит `a972f23`.
- **2026-08-12** — **F-14 ✅** `fan-webhook` — Hono-сервер на порту 9090. `POST /webhook`: steer/followUp dispatch через `actions.sendMessage`. `event-router.ts`: валидация + маршрутизация (расширяемо для новых типов). `types.ts`: `WebhookActions`, `WebhookCtx`, `WebhookServerHandle`. 400 на валидации, 500 на падении sendMessage. `GET /health`, `stop()` идемпотентен, port conflict detection. 46 тестов (25 integration + 21 unit), все extensions не сломаны. Коммит `d9ef7d1`.
- **2026-08-12** — **F-15 ✅** Интеграционные тесты + фикстуры контура. Steer/drain/scheduler integration через файловые сигналы: `.mission-steer-queue.json` (webhook→executor), `.mission-drain-flag` (drain→paused). Scheduler→missionLoop.tick() wiring. `MockMissionEnvironment` helper для переиспользования. 5 фикстур в `test/fixtures/mission/sample/`. Biome lint fixes (mission-widget.ts). 22 integration-теста (258 total fan-mission), все зелёные. Коммит `d5c3b42`.
- **2026-08-12** — 🏁 **Этап 0 ЗАВЕРШЁН.** 15/15 фич реализовано. Verify final: PASS (2100+ тестов). Smoke e2e phase A: PASS (3/3). Phase-gate: PASS (`31f605e`). Точка возобновления: этап 1 (`mission-validation-1`, F-16..F-22 + F-48).

## Бэклог (follow-ups, не блокеры)

1. **Флаки/падеж** `agent-session-concurrent > should queue extension-origin steering messages while streaming` — падает и на базовом HEAD (stash-подтверждено), держит `npm test` в exit 1. Нужен quarantine/тикет.
2. **F-02 P3:** `messageQueueLimit` не проброшен в sdk.ts/настройки (доступен только прямым пользователям Agent API).
3. **F-02 P4:** REST `classifyErrorStatus` не знает QueueOverflowError → 500 вместо 429/структурированной диагностики.
4. **F-03 P3:** событие `watchdog_timeout` не персистится в JSONL и не показывается в TUI; docs (sdk.md/rpc.md) не описывают. То же для `loop_detected` и drain-событий (F-04/F-05).
5. **F-04:** `normalizeErrorText` не гасит Windows-пути, перенормализует host:port/время; ban-message хардкод на русском (i18n).
6. **F-04:** провайдеры без поддержки AbortSignal — abort проигрывает (gap agent-core, честные провайдеры сигнал чтят).
7. **Персистентность таск-листа** — запланирована в этапе 1 как фича **F-48** (`mission-validation-1/roadmap.md`), подробности — backlog `docs/backlogs/tasklist-persistence-backlog.md`. Snapshot `TaskManager` в session JSONL, десериализация, restore-семантика `in_progress`→`pending`+`recovered`.
