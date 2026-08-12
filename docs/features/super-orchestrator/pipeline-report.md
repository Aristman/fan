# Pipeline Report: Сверх-оркестратор FAN

> **Старт:** 2026-08-10
> **Ветка:** FAN/feature/new-agents-flow
> **Roadmap (4):** docs/features/super-orchestrator/{mission-loop-0, mission-validation-1, http-hierarchy-2, depth-and-dashboard-3}/roadmap.md
> **Стратегия коммитов:** per-function · **Контрольные точки:** только в конце (+ при исчерпании попыток)
> **Режим:** все 4 roadmap подряд без остановки, phase-gate на границах

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего фич (4 roadmap) | 47 |
| Реализовано (✅) | 10 |
| Провалено (❌) | 0 |
| Коммитов | 13 |

## Прогресс

### Этап 0: mission-loop-0 (F-01..F-15)

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
| F-11 Slash-команды | ☐ | — | — | — |
| F-12 TUI-виджет | ☐ | — | — | — |
| F-13 fan-scheduler | ☐ | — | — | — |
| F-14 fan-webhook | ☐ | — | — | — |
| F-15 Интеграционные тесты | ☐ | — | — | — |

### Фаза B «Контур миссии» — В РАБОТЕ (2/5 в фазе до F-10: F-08, F-09 ✅; F-10 ✅)

### Фаза A «Ядро прерываний» — ✅ ЗАВЕРШЕНА (phase-gate `31f605e`: 3 e2e + 131 unit, PASS)

### Этап 1: mission-validation-1 (F-16..F-22) — ожидает
### Этап 2: http-hierarchy-2 (F-23..F-35) — ожидает
### Этап 3: depth-and-dashboard-3 (F-36..F-47) — ожидает

## Точка возобновления (2026-08-10, остановка по команде оператора)

**Состояние:** этап 0, фаза B в работе. Сделано 9/15 фич этапа 0 (фаза A ✅ 7/7 + phase-gate, фаза B: F-08 ✅, F-09 ✅).

**Следующий шаг:** F-10 «CLI fan mission init + шаблоны» (зависимость F-08 ✅ — разблокирована). Далее F-11 (F-09 ✅, F-06 ✅), F-12 (F-09 ✅), фаза C: F-13, F-14, F-15. После фазы B — phase-gate (smoke + e2e фазы B из roadmap).

**Протокол возобновления:** прочитать этот файл + roadmap `mission-loop-0/roadmap.md` (статусы ✅). ВАЖНО: таск-лист оркестратора (TaskCreate/TaskUpdate) живёт только в памяти процесса и после перезапуска пуст — taskId из этого отчёта будут недействительны. Пересоздать задачи на оставшиеся фичи (F-10..F-15 + verify/smoke/docs) по roadmap, затем взять первую фичу ☐, Red → Green → verify → commit per-function. Контрольные точки: только в конце. Ветка: FAN/feature/new-agents-flow.

**Ключевые решения по ходу (для будущих фич):**
- `writeMissionStatus` — единственный легальный способ менять MISSION.md (только status, через FSM canTransition);
- abort-гонка исправлена глобально: agent-loop чекает signal.aborted между ходами;
- drain state-машина: idle→draining→drained→idle, события 1:1:1;
- budget=0 = unlimited (везде); budgetCountedFor привязан к item;
- recovery контура: по наличию iterationResult в журнале, независимо от interrupted;
- **таск-лист эфемерен** (`TaskManager` в `extensions/fan-orchestrator/task-manager.js:11` хранит задачи в `new Map()`, `serialize()` ~273 написан, но нигде не вызывается) — персистентность запланирована фичей **F-48** (этап 1, `mission-validation-1`), подробности — backlog `docs/backlogs/tasklist-persistence-backlog.md`; до тех пор доска пересоздаётся из этого `pipeline-report.md` и соответствующего roadmap;
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
- **2026-08-10** — **F-09 ✅** Mission loop. Red 22/22 → Green 387 LOC → verify FAIL (recovery работал только в сконструированном тесте: lastStep на 3/7, abort mid-tick коммитил после I0, шаг 6 неатомарен, budget_usd не enforced, зомби-цикл, нет межпроцессного lock) → fix1 (глубокий: журнал по шагам, abort-сигнал, file-lock, архивация) → verify FAIL (SIGKILL recovery, double-count, paused, zombie-дубли) → fix2 → verify FAIL (writeRoadmap неатомарен, stale budgetCounted → under-count) → fix3 (budgetCountedFor per-item, atomic writeRoadmap) → **PASS** (окна W3/W4/W5 эмпирически). 163/163. Коммит `dcdde97`. **Остановка по команде оператора** — точка возобновления выше.

## Бэклог (follow-ups, не блокеры)

1. **Флаки/падеж** `agent-session-concurrent > should queue extension-origin steering messages while streaming` — падает и на базовом HEAD (stash-подтверждено), держит `npm test` в exit 1. Нужен quarantine/тикет.
2. **F-02 P3:** `messageQueueLimit` не проброшен в sdk.ts/настройки (доступен только прямым пользователям Agent API).
3. **F-02 P4:** REST `classifyErrorStatus` не знает QueueOverflowError → 500 вместо 429/структурированной диагностики.
4. **F-03 P3:** событие `watchdog_timeout` не персистится в JSONL и не показывается в TUI; docs (sdk.md/rpc.md) не описывают. То же для `loop_detected` и drain-событий (F-04/F-05).
5. **F-04:** `normalizeErrorText` не гасит Windows-пути, перенормализует host:port/время; ban-message хардкод на русском (i18n).
6. **F-04:** провайдеры без поддержки AbortSignal — abort проигрывает (gap agent-core, честные провайдеры сигнал чтят).
7. **Персистентность таск-листа** — теперь запланирована в этапе 1 как фича **F-48** (`mission-validation-1/roadmap.md`), подробности — backlog `docs/backlogs/tasklist-persistence-backlog.md`. Snapshot `TaskManager` в session JSONL, десериализация, restore-семантика `in_progress`→`pending`+`recovered`.
