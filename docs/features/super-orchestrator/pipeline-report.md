# Pipeline Report: Сверх-оркестратор FAN

> **Старт:** 2026-08-10
> **Ветка:** FAN/feature/new-agents-flow
> **Roadmap (4):** docs/features/super-orchestrator/{mission-loop-0, mission-validation-1, http-hierarchy-2, depth-and-dashboard-3}/roadmap.md
> **Стратегия коммитов:** per-function · **Контрольные точки:** только в конце (+ при исчерпании попыток)
> **Режим:** все 4 roadmap подряд без остановки, phase-gate на границах

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего фич (4 roadmap) | 48 |
| Реализовано (✅) | 24 (этап 0: 15 фич + 1 phase-gate e2e; этап 1: F-16..F-22 + F-48 = 8) |
| Провалено (❌) | 0 |
| Коммитов | 30 (этап 0: 19 + этап 1: 11) |
| Тесты fan-mission | 475 зелёные |
| Тесты fan-orchestrator | 186 зелёные (158 + 28 новых F-48) |
| Тесты coding-agent | 1190 (1 pre-existing flake) |
| Verify final этапа 1 | PASS (2085+ тестов: fan-mission 475, fan-orchestrator 186, coding-agent 1190) |
| Phase-gate A/B/C этапа 1 | PASS (протокол результатов + идей/метрик + валидация) |

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

### Этап 1: mission-validation-1 (F-16..F-22 + F-48) — ✅ ЗАВЕРШЁН (8/8)

| Фича | Статус | Коммит | Тесты | Попыток |
|------|--------|--------|-------|---------|
| F-16 Парсер тегов обещаний | ✅ | c347059 | 40 (fan-mission 298) | 1 |
| F-17 DECIDE-прерывание | ✅ | f4119e0 | 19 (fan-mission 317) | 1 |
| F-18 Лестница верификации | ✅ | 0c42990 | 20 (fan-mission 337) | 2 (verify FAIL: spawn timeout no-op → bug-fix tree kill) |
| F-19 Генератор идей | ✅ | 6d27769 | 22 (fan-mission 376) | 1 |
| F-20 Скорер идей | ✅ | 8875b58 | 39 (fan-mission 415) | 1 |
| F-21 Сбор метрик | ✅ | 97ca862 | 37 (fan-mission 452) | 2 (verify FAIL: склейка JSONL без \n → bug-fix) |
| F-22 Интеграционные тесты | ✅ | ca344a3 | 7 validation (fan-mission 475) | 1 |
| F-48 Персистентность таск-листа | ✅ | db133a2 | Red 37 → Green 186/186 fan-orch + 9/9 core (28+9) | 1 (verify PASS: roundtrip, restore, recovered, backward compat) |

**Phase-gate фазы A ✅** — интеграция протокола результатов в контур (коммит `aecc3c6`, 17 тестов): маршрутизация COMPLETE/BLOCKED/FAILED через parsePromise (приоритет над iterResult.status), лестница DI в шаге 5, эскалация I3 (onEscalate DI). Решение одобрено оператором (модули фазы A не покрывали интеграцию — scope расширен).
**Phase-gate фазы B ✅** — интеграция идей/метрик в контур (коммит `fd615ba`, 16 тестов): metricsCollector на каждой итерации, ideaGenerator/ideaScorer после шага 7, DECIDE от скорера через enterAwaitingDecision (refactor decideTick). Та же стратегия что фаза A.
**Phase-gate фазы C ✅** — production-валидация этапа 1 (без отдельного коммита, покрытие компонентами): сценарий 1 (валидация на реальных модулях) — покрыт F-22 (validation suite: парсер/контур/генератор/скорер/лестница/метрики, mock только LLM/runCommand/executor, 4 тега e2e, скоринг 0.75/0.52/0.19, метрики 6 итераций failureRate 1/6 < 0.2 MAST, ladder-fail); сценарий 2 (mock LLM → 3 итерации → генерация → скоринг → ROADMAP/DECIDE/REJECTED → метрики) — PASS; сценарий 3 (персистентность таск-листа: roundtrip serialize/deserialize, restore после краша, in_progress→pending+recovered, backward compat) — покрыт F-48 (28 тестов fan-orch + 9 core). Smoke-критерии этапа 1: I0 <1c / I2 <500мс (F-01/F-11), DECIDE блокирует контур (F-17), failureRate <20% / prematureRate <15% (F-21), спорные идеи 0.5–0.7 → DECIDE (F-20), `npm run build` зелёный + unit-тесты проходят — PASS.

### Этап 2: http-hierarchy-2 (F-23..F-35) — ожидает
### Этап 3: depth-and-dashboard-3 (F-36..F-47) — ожидает

## Точка возобновления (2026-08-13, ЭТАП 1 ЗАВЕРШЁН — СЛЕДУЮЩИЙ: ЭТАП 2)

**Состояние:** этап 1 завершён. Все 8 фич (F-16..F-22, F-48) закоммичены. Phase-gate фаз A/B/C ✅ (интеграционные коммиты `aecc3c6`, `fd615ba`; фаза C — покрытие компонентами F-22/F-48 без отдельного коммита). Verify final этапа 1: PASS (2085+ тестов). Docs-сессия обновляет pipeline-report/roadmap/README/CHANGELOG/MANIFEST без коммитов (по инструкции).

**Следующий шаг:**
1. Прочитать roadmap `http-hierarchy-2/roadmap.md` (F-23..F-35, 13 фич).
2. Создать таск-лист по зависимостям — первая фича корневая P0 без зависимостей (по графу roadmap этапа 2).
3. Реализовать F-23 per-function TDD (Red → Green → verify → commit).
4. Phase-gate на границах фаз этапа 2 (A/B/C).
5. Verify final этапа 2 → Smoke → Docs → отчёт.
6. Далее этап 3 (`depth-and-dashboard-3`, F-36..F-47).

**Протокол возобновления:**
1. Прочитать этот файл + roadmap `http-hierarchy-2/roadmap.md`.
2. Проверить `git status` — рабочая копия чиста (этап 1 полностью закоммичен в `db133a2`).
3. Создать таск-лист: F-23..F-35 по фазам + 3 phase-gate + verify/smoke/docs, зависимости wired.
4. Ветка: FAN/feature/new-agents-flow.

**Ключевые решения этапа 1 (для будущих фич):**
- **Тесты = контракт.** Девиации от regex спеки §3.2.4 в парсере (lookbehind, reason capture) закреплены тестами и задокументированы в коде; спека требует синхронизации (drift).
- **Интеграция модулей в контур делается на phase-gate** (стратегия одобрена оператором): e2e-тесты → реализация DI-хуков. DI-опции MissionLoop: verificationLadder, onEscalate, ideaGenerator, ideaScorer, metricsCollector.
- **Приоритет тегов:** parsePromise-тег перезаписывает iterResult.status; нет тега → I3-эскалация + fallback на status.
- **Лестница в шаге 5:** ladder-fail → итерация FAILED, бюджет учтён (работа сделана), чекбокс ROADMAP не отмечается, журнала персистится для recovery.
- **enterAwaitingDecision** — общий метод для DECIDE агента и DECIDE скорера (pendingDecision персистится в .mission-loop.json).
- **Генератор идей:** порог 3 итераций, маркер .mission-ideas.json персистентен; скорер: формула FP-нормализована (Math.round*1e5), BACKLOG обновляется in-place (updateBacklogEntry, CRLF-safe).
- **Метрики:** классификация статусов: failed/failed_watchdog → failureRate; failed_watchdog/watchdog/budget_exhausted → prematureRate; aborted → ни то ни другое.
- **F-48:** validateTransition реализован (latent bug: метод вызывался но не существовал — updateTask работал, startTask/completeTask падали); serialize полный формат; getCustomEntries — новый core API (session-manager + extension types/loader/runner/agent-session wiring); snapshot на tool_result TaskCreate/TaskUpdate/TaskClear/cancel_task, restore на session_start.
- Известный pre-existing падеж: agent-session-concurrent steering-тест (quarantine-тикет в бэклоге).

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
- **2026-08-13** — **Этап 1 старт.** Создано 14 задач (8 фич + 3 phase-gate + verify/smoke/docs), зависимости wired.
- **2026-08-13** — **F-16 ✅** Парсер тегов обещаний `promise-parser.ts` (56 LOC): parsePromise + stripCodeBlocks (refactor-цель). 2 осознанные девиации от regex спеки закреплены тестами (lookbehind, reason capture). 40 тестов. Коммит `c347059`.
- **2026-08-13** — **F-17 ✅** DECIDE-прерывание: статус awaiting_decision (FSM), resolveDecision, decideTimeoutMs (1h, unref) → abort + decide_timeout, pendingDecision персистится (.mission-loop.json), операторский ответ → следующая итерация (operator_answer). 19 тестов. Коммит `f4119e0`.
- **2026-08-13** — **F-18 ✅** Лестница верификации: verification-config.ts (DEFAULT_STEPS: typecheck/linters/build/tests/acceptance) + verification-ladder.ts (DI runCommand, diagnosis tail 2000). Verify FAIL: spawn(shell:true, timeout) — timeout игнорируется, hang навсегда → bug-fix: ручной setTimeout + killProcessTree (taskkill /T /F Windows, SIGKILL pg POSIX), settled-guard. Re-verify PASS (450ms при лимите 400ms). 20 тестов. Коммит `0c42990`.
- **2026-08-13** — **Phase-gate A ✅** code-research выявил разрыв: модули фазы A не интегрированы в контур (только DECIDE). Вопрос оператору → стратегия «интегрировать сейчас TDD». Red 11 → Green (+92 LOC mission-loop): маршрутизация 4 тегов через parsePromise, лестница DI в шаге 5, onEscalate I3. 17 интеграционных тестов (3 e2e-сценария фазы + smoke 4 тега). Коммит `aecc3c6`.
- **2026-08-13** — **F-19 ✅** Генератор идей: протокол 5 вопросов, порог 3 итераций (.mission-ideas.json маркер персистентен), дедупликация normalizeIdea, graceful на мусор LLM. backlog-format.ts (refactor-цель). 22 теста. Коммит `6d27769`.
- **2026-08-13** — **F-20 ✅** Скорер идей: computeScore 0.3/0.2/0.2/0.3 + FP-нормализация, пороги 0.7/0.5, REJECTED → ADR в DECISIONS.md, updateBacklogEntry in-place (atomic, CRLF-safe). scorer-config.ts (refactor-цель). 39 тестов. Коммит `8875b58`.
- **2026-08-13** — **F-21 ✅** Метрики: metrics.jsonl append-only, getMetrics агрегация (failureRate/prematureRate/totalTokens), классификация статусов. Verify FAIL: файл без финального \n → склейка записей → bug-fix: last-byte read + prefix \n (+3 регресс-теста). 37 тестов. Коммит `97ca862`.
- **2026-08-13** — **Phase-gate B ✅** интеграция идей/метрик в контур (+131 LOC): metricsCollector на каждой итерации, ideaGenerator/ideaScorer после шага 7, DECIDE скорера через enterAwaitingDecision (общий с decideTick), хуки после журнала (recovery-safe). 16 тестов. Коммит `fd615ba`.
- **2026-08-13** — **F-22 ✅** Валидационный suite: реальные модули (парсер/контур/генератор/скорер/лестница/метрики), mock только LLM/runCommand/executor. 4 тега e2e, скоринг 0.75/0.52/0.19, метрики 6 итераций (failureRate 1/6 < 0.2 MAST), ladder-fail. Фикстуры mission-validation. MockMissionValidationEnvironment helper (refactor-цель). Воркер tests-impl умер от контекста на 1-й попытке (читал весь mission-loop.ts) — перезапуск с компактным заданием. 7 тестов, fan-mission 475. Коммит `ca344a3`.
- **2026-08-13** — **F-48 ⏳** Red 37 тестов (3 файла: task-manager-persistence 20, task-snapshot-hooks 8, extension-custom-entries-read 9) → Green: fan-orchestrator 186/186, core getCustomEntries 9/9, coding-agent suite зелёный. Разведка нашла latent bug: validateTransition вызывался но не существовал (updateTask ок, startTask/completeTask падали) — исправлен в Green. **Verify + коммит не выполнены.**
- **2026-08-13** — **F-48 ✅** Verify-воркер PASS: roundtrip serialize/deserialize (3 задачи, связи blocks/blockedBy целы), restore после краша (snapshot → list_tasks), in_progress→pending+recovered, backward compat (сессия без snapshot → пустая доска без ошибок), 158 старых тестов fan-orch зелёные. Коммит `db133a2` (`feat(fan-orchestrator): task list persistence via session JSONL (F-48)`). fan-orchestrator 186/186, core getCustomEntries 9/9.
- **2026-08-13** — **Phase-gate C ✅** production-валидация этапа 1 (без отдельного коммита, покрытие компонентами): сценарий 1 — F-22 validation suite (реальные модули, 4 тега e2e, скоринг 0.75/0.52/0.19, failureRate 1/6 < 0.2 MAST, ladder-fail); сценарий 2 — mock LLM → генерация → скоринг → ROADMAP/DECIDE/REJECTED → метрики PASS; сценарий 3 — персистентность F-48 (roundtrip/restore/recovered/backward compat). Smoke-критерии этапа 1 (I0 <1c, I2 <500мс, DECIDE блокирует контур, failureRate <20%, prematureRate <15%, спорные идеи 0.5–0.7 → DECIDE, build зелёный + unit-тесты) — PASS.
- **2026-08-13** — 🏁 **Verify final этапа 1: PASS.** 2085+ тестов зелёные: fan-mission 475, fan-orchestrator 186, coding-agent 1190 (1 pre-existing flake `agent-session-concurrent` steering — backlog #1, quarantine-тикет). Phase-gate A/B/C: PASS.
- **2026-08-13** — 🏁 **Этап 1 ЗАВЕРШЁН.** 8/8 фич реализовано. Verify final PASS (2085+ тестов). Phase-gate A/B/C PASS. Точка возобновления: этап 2 (`http-hierarchy-2`, F-23..F-35).
- **2026-08-13** — 📝 **Docs-сессия:** обновлены `pipeline-report.md` (этап 1 ✅ 8/8, F-48 `db133a2`, phase-gate C, verify final, точка возобновления → этап 2), `mission-validation-1/roadmap.md` (секция «Этап 1 завершён»), `packages/coding-agent/README.md` (протокол тегов обещаний, DECIDE, лестница верификации, персистентность таск-листа), `CHANGELOG.md` (запись этапа 1 в [Unreleased]), `docs/MANIFEST.md`. Коммиты НЕ делаются (по инструкции).
- **2026-08-13** — 🔌 **Entry-point wiring (gap закрыт).** Расширения fan-mission/scheduler/webhook не имели точек входа (модули были мёртвым кодом без рантайм-запуска). Реализовано по TDD: **E-1** git-adapter.ts (production MissionGit, shell-injection-safe + root-commit parse fix, 17 тестов, `89d4b0b`); **E-2** session-executor.ts (MissionExecutor с DI runAgent, 11 тестов, `5fc3590`); **E-3** fan-webhook/index.ts (wireWebhook + фабрика, 7 интеграционных тестов с реальным сервером, `f94b55f`); **E-4** fan-scheduler/index.ts (wireScheduler + фабрика, 7 тестов, `2d0d436`); **E-5** fan-mission/index.ts (wireMission: MissionLoop с production deps + 7 slash-команд + виджет alt+m, ленивый slashCtx, 18 тестов, `415b3d2`). Попутно: fix phantom-импорта getFileStateManager в виджете (`63e3ee1`), fix flaky порта 9090 через FAN_WEBHOOK_PORT env (`a3c4532`), интеграционный тест загрузки всех 3 расширений (15 тестов, `72882c1`). Итог: fan-mission 538, fan-scheduler 45, fan-webhook 53, build 0.
- **2026-08-13** — ⚠️ **Deployment-факт:** рантайм ищет расширения в `<cwd>/.fan/extensions/` и `~/.fan/agent/extensions/`, НЕ в `extensions/` репо. Deployed-копии в `~/.fan/agent/extensions/` СТАРЫЕ (orchestrator от 29 июля без F-48; mission/scheduler/webhook отсутствуют). Для реальной работы новых расширений нужен релиз в store + установка (отложено оператором). `index.ts` fallback достаточен для discovery (fan.extensions в package.json не требуется).

## Бэклог (follow-ups, не блокеры)

1. **Флаки/падеж** `agent-session-concurrent > should queue extension-origin steering messages while streaming` — падает и на базовом HEAD (stash-подтверждено), держит `npm test` в exit 1. Нужен quarantine/тикет.
2. **F-02 P3:** `messageQueueLimit` не проброшен в sdk.ts/настройки (доступен только прямым пользователям Agent API).
3. **F-02 P4:** REST `classifyErrorStatus` не знает QueueOverflowError → 500 вместо 429/структурированной диагностики.
4. **F-03 P3:** событие `watchdog_timeout` не персистится в JSONL и не показывается в TUI; docs (sdk.md/rpc.md) не описывают. То же для `loop_detected` и drain-событий (F-04/F-05).
5. **F-04:** `normalizeErrorText` не гасит Windows-пути, перенормализует host:port/время; ban-message хардкод на русском (i18n).
6. **F-04:** провайдеры без поддержки AbortSignal — abort проигрывает (gap agent-core, честные провайдеры сигнал чтят).
7. **Персистентность таск-листа** — ✅ РЕАЛИЗОВАНО F-48 (коммит `db133a2`, этап 1): snapshot `TaskManager` в session JSONL custom entries, restore на session_start, `in_progress`→`pending`+`recovered`. Открытый follow-up — backlog #10 (compaction survival custom entries).
8. **Спека §3.2.4 drift:** regex тегов в спеке расходится с реализацией F-16 (lookbehind + reason capture закреплены тестами). Синхронизировать спеку при обновлении документации.
9. **task-manager.js.map** — stale source map после правок (runtime не влияет).
10. **Compaction survival:** custom entries (snapshots F-48) не проверены на выживание при compaction контекста (backlog P2 риск).
11. **Deployment расширений:** fan-mission/scheduler/webhook entry-points готовы, но НЕ загружаются рантаймом из `extensions/` репо. Нужен релиз в store + установка в `~/.fan/agent/extensions/` (или конфиг `extensions:[...]`). Отложено оператором. Deployed-копия orchestrator в `~/.fan/agent/extensions/` старая (без F-48).
12. **Production runAgent захват ответа** — ✅ ЗАКРЫТО (`f120db5`, fan-mission 0.2.0): новый default-run-agent.ts дожидается agent_end, коррелирует по prompt (последний matching), извлекает последний assistant-текст + Σ usage (totalTokens/cost.total); timeout/settle/error → `<promise>FAILED</promise>` (никогда пустой ответ — иначе ложный COMPLETE). Promise-теги агента теперь попадают в контур в production.
13. **Виджет ui-заглушка** — ✅ ЗАКРЫТО (`f94669b`, fan-mission 0.1.3): widgetUi.render подключён к ctx.ui.setWidget, handler захватывает ctx. Виджет реально рисуется по F9.
14. **Auto-tick loop** — ✅ ЗАКРЫТО (`3a32fb4`, fan-scheduler 0.2.0 + fan-mission 0.3.0): мост EventBus — scheduler эмитит `mission_tick` (только при активной миссии), fan-mission подписан и вызывает loop.tick() программно (guards: replay/dedupe/чужой dir/Lock-is-busy). Холостые тики без миссии устранены ранее (`cf45deb`).
15. **Этап 2 (http-hierarchy-2, F-23..F-35):** process-manager, node-auth, depth-width-guard, message-sanitizer, work-package, node-report, child-node-client, budget-aggregator, budget-coordinator, tree-journal, startup-reconciliation, MVP глубины 2, тесты. Это следующий большой блок для полноценного супер-оркестратора.
