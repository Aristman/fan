# Changelog

## [0.7.4] - 2026-08-18

### Fixed
- **STATE.md schema violation**: Added explicit guidance in prompt-builder that STATE.md sections must use exact Russian names ("## Сделано", "## Блокеры", "## Следующие шаги"). Previously agents would sometimes write English names or incorrect translations, causing InvalidStateSchema errors during commit phase.

## [2.8.1] — 2026-08-15

### Added

- **Описание миссии при init + bootstrap-планирование Goal→ROADMAP.**
  Раньше `fan mission init` создавал шаблон с пустым `## Goal`, и оператору
  приходилось править MISSION.md/ROADMAP.md руками; bootstrap-пункт выполнялся
  и миссия молча становилась `completed`. Теперь описание задаётся при init:
  CLI принимает позициональные аргументы (`fan mission init <slug>
  [описание...]` — остаток слов склеивается в описание), новая slash-команда
  `/mission:init <slug> [описание]` (extensions/fan-mission/slash-commands.ts)
  при отсутствии описания и наличии TUI запрашивает диалоги Goal
  (обязательный) / Scope / Constraints; без UI (RPC/headless) создаёт миссию
  без описания. Описание подставляется в секцию `## Goal` шаблона MISSION.md
  (новая переменная `{{description}}`; init без описания работает как раньше).
  Bootstrap-планирование (extensions/fan-mission/prompt-builder.ts,
  mission-loop.ts): если текущий пункт — bootstrap («Bootstrap mission:…»,
  первый пункт ROADMAP) и Goal непустой, в Guidance промпта добавляется
  указание декомпозировать Goal в unchecked-пункты ROADMAP.md; если после
  этого в ROADMAP не осталось unchecked-пунктов, Goal непуст и ROADMAP валиден
  (есть checked-пункты) — тик не завершает миссию `completed`, а запускает
  planning-итерацию на синтетическом пункте «Plan: decompose mission Goal
  into ROADMAP items» (пустой Goal → `completed` как раньше; ROADMAP без
  парсящихся пунктов → `failed` как в 0.4.1). Шаг 6 перечитывает ROADMAP с
  диска перед отметкой пункта (правки executor'а — новые пункты — больше не
  затираются снапшотом шага 2) и пропускает git-commit, если менять нечего.
  Существующая миссия в `/mission:init` → ошибка через output (аналог
  MissionAlreadyExistsError из CLI). Тесты — init с описанием в
  `file-state-manager.test.mjs`, CLI-склейка в
  `packages/coding-agent/test/cli/mission-command.test.ts`, `/mission:init`
  в `slash-commands.test.mjs`, guidance в `prompt-builder.test.mjs`,
  planning-итерация в `mission-loop-planning.test.mjs`.
  fan-mission 0.6.3 → 0.7.0, fan-coding-agent 2.7.4 → 2.7.5.

- **Промоушн одобренных идей BACKLOG→ROADMAP (задача D).**
  Скорер идей (F-20) ставил идеям статус ROADMAP в BACKLOG.md, но в
  физический ROADMAP.md они не попадали — одобренные идеи никогда не
  исполнялись. Новый модуль `extensions/fan-mission/idea-promoter.ts`
  (шаг 7 контура): идеи со статусом ROADMAP добавляются в ROADMAP.md как
  unchecked-пункты `- [ ] <текст> (idea:<id>)`, затем получают статус
  PROMOTED (дедупликация по маркеру `(idea:<id>)`, ≤3 промоушна за тик,
  ≤50 пунктов в roadmap). DECIDE-идеи: ответ оператора «да» через
  `/mission:decide` переводит идею DECIDE→ROADMAP, промоушн на следующем
  тике; сама `/mission:decide` теперь вызывает `loop.resolveDecision()`
  (раньше — sendMessage followUp без FSM-перехода). Попутно исправлен
  regex accept-ответа: `\b` не работает с кириллицей → lookahead
  `(?=[\s,.!?:;]|$)`. Тесты — `idea-promoter.test.mjs` (20).
  fan-mission 0.7.0 → 0.7.1.

- **Recurring-пункты `(recur)` для миссий-вахт.**
  Миссии типа «вахта» (watch-loop: «Проверяй почту и сообщай в Telegram о
  важных письмах») требовали повторяющегося исполнения одного и того же
  пункта ROADMAP, но выполненный пункт помечался `[x]` → миссия завершалась
  `completed` после первой проверки. Новый маркер `(recur)` в тексте пункта
  ROADMAP (регистронезависимый): `parseFirstUnchecked` по-прежнему возвращает
  такой пункт (он остаётся `[ ]`), а `markRoadmapDone` — no-op (строка не
  меняется на `[x]`). Миссия с recur-пунктами живёт вечно: тики исполняют
  recur каждый раз, обычные пункты выполняются и помечаются `[x]` как раньше,
  когда кончаются — recur продолжает. Planning-ветка не срабатывает, пока
  recur unchecked (это корректно — миссия не завершается). Шаг 6: git commit
  происходит если изменился STATE.md ИЛИ ROADMAP.md (для recur — только
  STATE.md). Guidance в промпте (prompt-builder.ts): «This is a RECURRING
  task (recur): it stays on the ROADMAP unchecked — perform the work for
  this tick only, report results, do NOT mark or remove the item.». Экспорт:
  `RECUR_MARKER`, `isRecurringItem(text)` из file-state-manager.ts. Тесты —
  `mission-loop-recurring.test.mjs` ( recur не [x], два тика подряд,
  обычный+recur, только-recur не completed, guidance в промпте, регрессия
  обычных пунктов). fan-mission 0.7.2 → 0.7.3.

### Fixed

- **Вывод slash-команд `/mission:*` рендерился в строку ввода TUI.**
  `slashCtx.output` в fan-mission был `console.log` (TODO fallback) — вывод
  команд печатался в область редактора вместо диалога. Обёртка
  `fan.registerCommand` (extensions/fan-mission/index.ts) теперь батчит строки
  `output()` в буфер и после handler делает ОДИН `ctx.ui.notify` (TUI
  `showStatus` ЗАМЕНЯЕТ предыдущий status-текст, поэтому построчный notify
  потерял бы все строки, кроме последней — `/mission:status` выводит 4
  строки). Тип уведомления — `error`, если хотя бы одна строка начинается с
  `Error:`, иначе `info` (серое служебное сообщение в диалоге). Без UI
  (тесты, RPC) — прежний fallback построчно в `console.log`. Контракт
  `SlashCtx.output` не изменён (slash-commands.test.mjs мокирует его напрямую).
  Тесты — блок `TC-11` в `index-wiring.test.mjs`.
  fan-mission 0.6.1 → 0.6.2.

- **lazy-attach: `/mission:start|resume|status` подхватывают контур в запущенной сессии без рестарта fan.**
  Миссионный контур аттачился только в `session_start`: если миссию остановили
  (`status: aborted`) или она стала active после старта сессии (через CLI
  `fan mission`), запущенный TUI оставался без контура — `/mission:status`
  выводил "No active mission (mission loop is not attached)", виджет F9 был
  пуст, единственным выходом был рестарт fan. Скан миссий извлечён из
  `session_start` в переиспользуемый `findAttachableMission(cwd, accept?)`
  (extensions/fan-mission/index.ts), и команды аттачат контур лениво:
  `/mission:start` находит миссию (любой статус кроме `completed`), при
  необходимости делает разрешённый FSM-переход в `active`, аттачит loop и
  выполняет tick (для `completed` — отказ с подсказкой `fan mission init`,
  без миссии — "No mission found in <cwd> — run `fan mission init <slug>`
  first"); `/mission:resume` возобновляет `paused`-миссию; `/mission:status`
  аттачит любую не-completed миссию read-only. stop/pause/steer/decide без
  изменений (требуют аттаченный loop). ТИКЕТ-14 мост (scheduler → tick) и
  виджет F9 подхватываются автоматически — они читают loop через замыкания.
  `SlashCtx` расширен полями `cwd`/`findAttachableMission`/`attach`/
  `writeStatus` (slash-commands.ts). Тесты — блок `TC-F11-lazy` в
  `extensions/fan-mission/test/slash-commands.test.mjs`, `TC-10` в
  `index-wiring.test.mjs`, `TC-8` в `extensions-load.test.mjs`.
  fan-mission 0.5.0 → 0.6.0.

- **CLI `fan mission start` не работал ни из одного статуса (бэклог #26).**
  В `missionStart` проверка `canTransition` была инвертирована: переход,
  разрешённый FSM, бросал `InvalidTransitionError`, а недоступная ветка
  падала на безусловный `throw` ниже — обе ветки бросали, и
  `writeMissionStatus` не вызывалась никогда. Исправлено на канонический
  паттерн (`if (!canTransition) throw; writeMissionStatus; log`): start
  корректно переводит `aborted`/`failed`/`budget_exhausted`/`paused` →
  `active`, из терминального `completed` — `InvalidTransitionError`, при уже
  `active` — сообщение без записи. Устаревшая подсказка про F-09 заменена на
  указание `/mission:start`. Тесты — P-5 блок в
  `packages/coding-agent/test/cli/mission-command.test.ts`.
  fan-coding-agent 2.7.2 → 2.7.3.

- **Терминальный UX миссии: `completed`-миссия больше не молчит.**
  Миссия с полностью вычеркнутым ROADMAP переходила в `completed`, после чего
  пользователь получал молчание или ложные сообщения: `/mission:status` без
  аттача выводил "No active mission" (lazy-скан исключал `completed`),
  `/mission:start` молча выходил из tick (терминальный статус — no-op в
  mission-loop), `/mission:stop` падал с сырым `InvalidTransitionError`
  (completed → aborted запрещён FSM), виджет F9 был пуст (терминальные статусы
  скрывались), а после рестарта fan `/mission:start` лгал "No mission found".
  Исправлено: дефолтный `accept` в `findAttachableMission` находит миссию
  ЛЮБОГО статуса (политика переходов — на уровне команд; session_start-путь
  со строгим фильтром не-терминальных не изменён, регрессия TC-10b зелёная);
  `/mission:status` лениво аттачит read-only миссию любого статуса и показывает
  реальный `completed`; `/mission:start` без аттача на `completed` выводит
  подсказку "Mission \<slug\> is completed. Add new unchecked items to
  ROADMAP.md and run /mission:start, or create a new mission: fan mission init
  \<new-slug\>" (без attach), а с аттаченным loop — "Mission is \<status\> —
  tick skipped." + ту же подсказку для `completed`; `/mission:stop` сообщает
  "Mission already \<status\>." на терминальном статусе и "Mission stopped
  (status: aborted)." при успешной остановке (FSM-ошибки не глотаются);
  виджет F9 рендерит строку терминального статуса (`○ завершена │ Итерация: N`)
  вместо пустого виджета. Тесты — блок `TC-F11-terminal-ux` в
  `extensions/fan-mission/test/slash-commands.test.mjs`, `TC-10d/TC-10e` в
  `index-wiring.test.mjs`, обновлённый `TC-F12-2` в `mission-widget.test.mjs`.
  fan-mission 0.6.0 → 0.6.1.

- **Регрессия F-46: дефолтный per-iteration budget ломал интерактивные сессии.**
  `createAgentSession` применял roadmap-дефолты (100k токенов / $5.00 на
  итерацию), если в settings.json не заданы `budget.iterationTokenLimit` /
  `budget.iterationCostLimit`: в длинных сессиях один turn с большим контекстом
  превышал 100k totalTokens → хук `turn_end` вызывал `agent.abort()` и ход
  обрывался после первого же tool call. Лимиты стали opt-in: без явных
  настроек — 0 (безлимит), бюджетом основного агента является контекстное окно
  модели; миссионный контур задаёт лимиты через settings.json.
  Регрессионный тест — `packages/coding-agent/test/sdk-iteration-budget-defaults.test.ts`.
  fan-coding-agent 2.7.0 → 2.7.1.

- **CLI `fan mission` не находил file-state-manager вне монорепо.**
  `loadFileStateManager()` искал модуль только по `FAN_MISSION_DIR` и
  монорепо-путям (`<root>/extensions/fan-mission`): у deployed-бинаря в
  произвольном проекте ни один кандидат не существовал →
  `MissionExtensionMissingError("file-state-manager module not found")`.
  Добавлены runtime discovery paths (как в `core/extensions/loader.ts`):
  project-local `<cwd>/.fan/extensions/fan-mission/` и global
  `<agentDir>/extensions/fan-mission/` — с приоритетом выше монорепо-путей.
  Регрессионный тест — `packages/coding-agent/test/cli/mission-command-deployed.test.ts`.
  fan-coding-agent 2.7.1 → 2.7.2.

- **Ложный `completed` миссии при `*`-маркерах ROADMAP.**
  `parseFirstUnchecked` / `markRoadmapDone` / `isRoadmapItemChecked`
  (extensions/fan-mission/mission-loop.ts) принимали только `-`-маркер:
  ROADMAP с пунктами `* [ ] Задача` (валидный markdown, пользовательский файл)
  → `parseFirstUnchecked` возвращал `null` → шаг 3 контура решал «All items
  done» → миссия завершалась `completed` с iteration 0, пустым журналом и
  нулевой работой (фабрикация результата). Все три функции принимают оба
  маркера `-` и `*`; `markRoadmapDone` сохраняет исходный маркер списка.
  Дополнительная защита: ROADMAP вообще без парсящихся чеклист-пунктов
  (ни checked, ни unchecked) → статус `failed` с диагностикой
  "ROADMAP contains no parseable checklist items" вместо ложного `completed`.
  Регрессионные тесты — `extensions/fan-mission/test/mission-loop-star-marker.test.mjs`.
  fan-mission 0.4.0 → 0.4.1.

### Improved

- **Обогащение промпта исполнения миссионного пункта контекстом (prompt-builder).**
  Промпт шага 4 (iterate) mission-loop был просто `Execute mission item: <text>`
  (+ steer): агент получал задание без контекста миссии и тратил итерацию на
  rediscovery (memory_search → find → чтение всех файлов миссии → исследование
  проекта), а также не знал протокол отчёта `<promise>`. Новый модуль
  `extensions/fan-mission/prompt-builder.ts` (`buildExecutionPrompt`) собирает
  контекстный промпт: агенту передаются MISSION.md (body без frontmatter),
  ROADMAP (текущий пункт помечен `▶ `), STATE.md, BACKLOG.md (если непустой),
  протокол отчёта `<promise>COMPLETE|BLOCKED|DECIDE|FAILED</promise>` и guidance
  («не перечитывай предоставленные файлы, работай напрямую»). Защита от
  разросшегося состояния: каждая секция ≤ 4000 символов, общий промпт ≤ 20000
  (обрезка с `...[truncated]`). Первая строка `Execute mission item: <text>`
  сохранена для совместимости. EPIC-путь делегирования не затронут.
  Тесты — `extensions/fan-mission/test/prompt-builder.test.mjs`.
  fan-mission 0.4.1 → 0.5.0.

## [2.8.0] — 2026-08-15

### Сверх-оркестратор FAN — Этап 1 «Валидация миссионного контура» завершён

Закрытие roadmap `docs/features/super-orchestrator/mission-validation-1/roadmap.md`:
все 8 фич (F-16..F-22 + F-48) реализованы, phase-gate фаз A/B/C пройдены
(интеграционные коммиты [`aecc3c6`](https://github.com/seaagents/fan/commit/aecc3c6)
и [`fd615ba`](https://github.com/seaagents/fan/commit/fd615ba); фаза C — покрытие
компонентами F-22/F-48 без отдельного коммита), verify final 2085+ тестов зелёные.
Подробный отчёт — `docs/features/super-orchestrator/pipeline-report.md`.

**Фаза A «Протокол результатов» (F-16..F-18):**

- **Расширение `fan-mission`** — парсер тегов обещаний `promise-parser.ts`
  (`<promise>COMPLETE|BLOCKED|DECIDE|FAILED</promise>`, теги в code-блоках
  игнорируются) в [`c347059`](https://github.com/seaagents/fan/commit/c347059);
  DECIDE-прерывание: статус `awaiting_decision`, `resolveDecision`,
  `decideTimeoutMs` (1h) → abort в [`f4119e0`](https://github.com/seaagents/fan/commit/f4119e0);
  лестница верификации `verification-ladder.ts` + `verification-config.ts`
  (5 ступеней, tree-kill таймаут) в [`0c42990`](https://github.com/seaagents/fan/commit/0c42990).
- **Phase-gate A** — интеграция протокола результатов в контур
  ([`aecc3c6`](https://github.com/seaagents/fan/commit/aecc3c6)): маршрутизация 4
  тегов через `parsePromise` (приоритет над `iterResult.status`), лестница DI в
  шаге 5, эскалация I3 (`onEscalate`).

**Фаза B «Идеи и метрики» (F-19..F-21):**

- **Расширение `fan-mission`** — генератор идей `idea-generator.ts` (протокол 5
  вопросов, порог 3 итераций, дедупликация) в [`6d27769`](https://github.com/seaagents/fan/commit/6d27769);
  скорер идей `idea-scorer.ts` (формула 0.3/0.2/0.2/0.3, пороги 0.7/0.5,
  REJECTED → ADR) в [`8875b58`](https://github.com/seaagents/fan/commit/8875b58);
  сбор метрик `metrics-collector.ts` (`metrics.jsonl`, `failureRate`/`prematureRate`)
  в [`97ca862`](https://github.com/seaagents/fan/commit/97ca862).
- **Phase-gate B** — интеграция идей/метрик в контур
  ([`fd615ba`](https://github.com/seaagents/fan/commit/fd615ba)): `metricsCollector`
  на каждой итерации, `ideaGenerator`/`ideaScorer` после шага 7, DECIDE скорера
  через `enterAwaitingDecision`.

**Фаза C «Валидация» (F-22, F-48):**

- **Расширение `fan-mission`** — валидационный suite с реальными модулями (mock
  только LLM/runCommand/executor): 4 тега e2e, скоринг, метрики 6 итераций
  (failureRate 1/6 < 0.2 MAST), ladder-fail в [`ca344a3`](https://github.com/seaagents/fan/commit/ca344a3).
- **Расширение `fan-orchestrator`** — персистентность таск-листа: `TaskManager`
  `serialize`/`deserialize` в session JSONL custom entries, snapshot на
  `TaskCreate`/`TaskUpdate`/`TaskClear`/`cancel_task`, restore на session start,
  `in_progress`→`pending`+`recovered` (новый core API `getCustomEntries`) в
  [`db133a2`](https://github.com/seaagents/fan/commit/db133a2).
- **Phase-gate C** — production-валидация этапа 1 (без отдельного коммита):
  сценарий 1 (F-22), сценарий 2 (mock LLM → генерация → скоринг →
  ROADMAP/DECIDE/REJECTED), сценарий 3 (персистентность F-48). Smoke-критерии
  этапа 1 (I0 <1c, I2 <500мс, DECIDE блокирует контур, failureRate <20%,
  prematureRate <15%, build зелёный + unit-тесты) — PASS.

**Тесты:** fan-mission 475, fan-orchestrator 186 (158 + 28 новых F-48),
coding-agent 1190 (1 pre-existing flake `agent-session-concurrent` steering),
итого 2085+ зелёные.

**Следующий шаг:** этап 2 `http-hierarchy-2` (F-23..F-35, 13 фич).

### Сверх-оркестратор FAN — Этап 0 «Миссионный контур» завершён

Закрытие roadmap `docs/features/super-orchestrator/mission-loop-0/roadmap.md`:
все 15 фич (F-01..F-15) реализованы, phase-gate фазы A пройден
([`31f605e`](https://github.com/seaagents/fan/commit/31f605e)), verify final
2100+ тестов зелёные, smoke `e2e-phase-a-interrupts` 3/3 PASS. Подробный
отчёт — `docs/features/super-orchestrator/pipeline-report.md`.

**Фаза A «Ядро прерываний» (F-01..F-07):**

- **`fan-coding-agent`/`api-gateway`/`agent`** — REST+WS abort (`f0a83af`),
  лимиты очередей + `QueueOverflowError` (`42360a6`), `WatchdogTimer` для
  зависших tool call (`bb273e3`), `LoopDetector` для повторных ошибок
  (`7a41f82`), drain state-машина `idle→draining→drained→idle` (`cb66834`),
  REST+WS drain endpoint (`94c659d`), `budget_alert` WS-продюсер с порогами
  80%/95%/100% и дедупликацией по периоду (`41fcf61`).

**Фаза B «Контур миссии» (F-08..F-12):**

- **Расширение `fan-mission`** — `file-state-manager.ts` (MISSION/ROADMAP/STATE/
  BACKLOG/DECISIONS, FSM статусов, лимит STATE.md 5 KB, immutable MISSION.md)
  в [`6e51409`](https://github.com/seaagents/fan/commit/6e51409);
  7-шаговый mission loop с crash recovery и file-lock в [`dcdde97`](https://github.com/seaagents/fan/commit/dcdde97).
- **`fan-coding-agent` CLI** — `fan mission init|start|stop|status|pause|resume`
  + `--template <T>` (default + refactor), `InvalidTransitionError` в
  [`665a392`](https://github.com/seaagents/fan/commit/665a392); slash-команды
  `/mission:*` (start/stop/pause/resume/status/steer/decide, 7 шт.) в
  [`0fb7284`](https://github.com/seaagents/fan/commit/0fb7284); TUI-виджет
  статуса миссии (Alt+M) в [`5fd84c1`](https://github.com/seaagents/fan/commit/5fd84c1).

**Фаза C «Внешние триггеры и интеграция» (F-13..F-15):**

- **Расширение `fan-scheduler`** — cron-планировщик тиков I4, 5-field cron со
  строгой валидацией, resilience к падениям `sendMessage` в
  [`a972f23`](https://github.com/seaagents/fan/commit/a972f23).
- **Расширение `fan-webhook`** — Hono-сервер на порту 9090, event-router
  для steer/followUp в [`d9ef7d1`](https://github.com/seaagents/fan/commit/d9ef7d1).
- **Интеграция** — 22 интеграционных теста + 5 фикстур в
  `extensions/fan-mission/test/fixtures/mission/sample/`, общение расширений
  через файловые сигналы `.mission-steer-queue.json` и `.mission-drain-flag`
  в [`d5c3b42`](https://github.com/seaagents/fan/commit/d5c3b42).

**Следующий шаг:** этап 1 `mission-validation-1` (F-16..F-22) + F-48
(персистентность таск-листа оркестратора).

### Сверх-оркестратор FAN — развёртывание и автопилот миссий

**Entry-point wiring расширений (E-1..E-6):**

- **`fan-orchestrator`** — git-adapter в [`89d4b0b`](https://github.com/seaagents/fan/commit/89d4b0b),
  session-executor в [`5fc3590`](https://github.com/seaagents/fan/commit/5fc3590)
- **`fan-webhook`** — entry-point в [`f94b55f`](https://github.com/seaagents/fan/commit/f94b55f)
- **`fan-scheduler`** — entry-point в [`2d0d436`](https://github.com/seaagents/fan/commit/2d0d436)
- **`fan-mission`** — entry-point: MissionLoop + 7 slash-команд + виджет
  в [`415b3d2`](https://github.com/seaagents/fan/commit/415b3d2);
  integration load test в [`72882c1`](https://github.com/seaagents/fan/commit/72882c1)

**Доводка:**

- Виджет F9 через `ctx.ui.setWidget` в [`f94669b`](https://github.com/seaagents/fan/commit/f94669b)
  (fan-mission 0.1.3)
- Scheduler без холостых тиков в [`cf45deb`](https://github.com/seaagents/fan/commit/cf45deb)
  (fan-scheduler 0.1.1)
- Webhook подсказка `FAN_WEBHOOK_PORT` в [`a183566`](https://github.com/seaagents/fan/commit/a183566)

**TICKET-12 production runAgent:** захват реального результата итерации
(agent_end, usage, FAILED-теги, таймаут 30 мин) в [`f120db5`](https://github.com/seaagents/fan/commit/f120db5)
(fan-mission 0.2.0)

**TICKET-14 авто-тик:** мост scheduler→missionLoop.tick() через EventBus
`mission_tick` в [`3a32fb4`](https://github.com/seaagents/fan/commit/3a32fb4)
(scheduler 0.2.0 + mission 0.3.0)

**fan-webhook multi-instance:** авто-подбор порта 9090–9110 когда порт не задан
явно в [`ec658d1`](https://github.com/seaagents/fan/commit/ec658d1) (0.1.3)

### Сверх-оркестратор FAN — Этап 2 «HTTP-иерархия узлов» завершён

**Фаза A «Управление процессами и аутентификация»:**

- **`fan-super-orchestrator`** — process-manager
  ([`be8c75d`](https://github.com/seaagents/fan/commit/be8c75d): spawn/kill/health,
  PortPool), node-auth
  ([`60411db`](https://github.com/seaagents/fan/commit/60411db): FAN_NODE_TOKEN +
  сидинг в api-gateway auth.ts + main.ts), depth-width-guard
  ([`18de279`](https://github.com/seaagents/fan/commit/18de279)),
  message-sanitizer ([`02dce72`](https://github.com/seaagents/fan/commit/02dce72))
- **Phase-gate A** — [`fe1f6d8`](https://github.com/seaagents/fan/commit/fe1f6d8)
  (11/11 реальный fan server)

**Фаза B «Рабочие пакеты и бюджет»:**

- **`fan-super-orchestrator`** — work-package
  ([`34192ab`](https://github.com/seaagents/fan/commit/34192ab)),
  node-report ([`5bd41c9`](https://github.com/seaagents/fan/commit/5bd41c9)),
  child-node-client ([`0a90f49`](https://github.com/seaagents/fan/commit/0a90f49):
  REST+WS reconnect), budget-aggregator
  ([`5a78656`](https://github.com/seaagents/fan/commit/5a78656)),
  budget-coordinator ([`c1fce7a`](https://github.com/seaagents/fan/commit/c1fce7a):
  mission-budget.json, min(0.8×remaining/n, ceiling), инвариант
  Σallocated ≤ budget_total), tree-journal
  ([`6af95ac`](https://github.com/seaagents/fan/commit/6af95ac): JSONL+fsync),
  startup-reconciliation ([`6ab3d96`](https://github.com/seaagents/fan/commit/6ab3d96))
- **Phase-gate B** — [`571076b`](https://github.com/seaagents/fan/commit/571076b)
  (26/26)

**Фаза C «Глубина 2»:**

- **`fan-super-orchestrator`** — depth2-integration
  ([`ebd309f`](https://github.com/seaagents/fan/commit/ebd309f): MVP глубины 2:
  L0 → 3–4×L1 на реальных процессах, kill-switch 0.3с),
  иерархические тесты ([`61cd0ee`](https://github.com/seaagents/fan/commit/61cd0ee))
- **Phase-gate C** — [`060cf82`](https://github.com/seaagents/fan/commit/060cf82)
  (20/20)

**Итог:** 457 тестов расширения + 57 e2e-проверок; verify final PASS;
отчёт [`b4a97e1`](https://github.com/seaagents/fan/commit/b4a97e1).

### Сверх-оркестратор FAN — Этап 3 завершён — пайплайн закрыт полностью (48/48 + F-48.5)

**Фаза A «Глубина 3–4, манифесты, санитизация» (F-36..F-38):**

- **F-36** глубина 3–4 в [`d3fa7ed`](https://github.com/seaagents/fan/commit/d3fa7ed)
  (maxWorkingDepth дефолт 4, предохранитель 12, FAN_ORCHESTRATOR_DEPTH)
- **F-37** манифесты инструментов в [`8e89bcc`](https://github.com/seaagents/fan/commit/8e89bcc)
  (--tools enforcement на дочернем, tool_blocked)
- **F-38** полная санитизация границ в [`2c8d0b5`](https://github.com/seaagents/fan/commit/2c8d0b5)
  (4 валидатора, cycle-защита, validation_failed)
- **Phase-gate A** — [`50da3f3`](https://github.com/seaagents/fan/commit/50da3f3) (17/17)

**Фаза B «Mission API и CLI» (F-39..F-42, F-47):**

- **F-47** Mission API в [`72b9fc4`](https://github.com/seaagents/fan/commit/72b9fc4)
  (GET /api/missions/:id/status|tree|budget + WS mission_event, slug traversal
  hardening)
- **F-39** mission-tree в [`9b57fb5`](https://github.com/seaagents/fan/commit/9b57fb5)
- **F-40** mission-status+log в [`a4e2567`](https://github.com/seaagents/fan/commit/a4e2567)
- **F-41** mission-budget в [`ace89c3`](https://github.com/seaagents/fan/commit/ace89c3)
- **F-42** CLI `fan mission tree` в [`bfac439`](https://github.com/seaagents/fan/commit/bfac439)
- Parity-фикс [`36b1773`](https://github.com/seaagents/fan/commit/36b1773)
- **Phase-gate B** — [`b24122d`](https://github.com/seaagents/fan/commit/b24122d) (12/12)

**Фаза C «Checkpoint, бюджет на итерацию, wiring» (F-43..F-46, F-48.5):**

- **F-45** Checkpoint API в [`039b241`](https://github.com/seaagents/fan/commit/039b241)
  (git commit + state-файл, restore без --hard)
- **F-46** бюджет на итерацию в [`c07cfc8`](https://github.com/seaagents/fan/commit/c07cfc8)
  (100k/$5 на turn, iteration_budget_exceeded → FAILED-тег в fan-mission)
- **F-48.5** wiring EPIC-делегирование в [`6a9eb6d`](https://github.com/seaagents/fan/commit/6a9eb6d)
  ([EPIC] → декомпозиция → mission_delegate → реальные дочерние fan server →
  синтез; verify поймал и предотвратил ложный COMPLETE)
- **F-44** e2e в [`7d171cb`](https://github.com/seaagents/fan/commit/7d171cb)
- **F-43** гайд `docs/guides/missions.md` в [`8e3d142`](https://github.com/seaagents/fan/commit/8e3d142)
- **Phase-gate C** — [`3498a9f`](https://github.com/seaagents/fan/commit/3498a9f) (32/32)

**Итог:** тесты super-orch 716 / mission 585 / api-gateway 137 / dashboard 98 /
model-manager 53 / coding-agent 1244; e2e gates 118/118; verify final PASS;
бэклог #22–#29 (minor) в pipeline-report.

**Версии релиза** [`4d89d81`](https://github.com/seaagents/fan/commit/4d89d81) +
[`d56a7ed`](https://github.com/seaagents/fan/commit/d56a7ed): FAN 2.8.0,
fan-coding-agent 2.7.0, @fan/api-gateway 1.5.0, @fan/dashboard 1.1.0,
@fan/model-manager 1.2.0, fan-mission 0.4.0, fan-super-orchestrator 0.3.0
(fan-scheduler 0.2.0, fan-webhook 0.1.3 без изменений в этапе 3).

## [2.5.1] — 2026-08-09

### Исправлено

**`@seaagents/fan-coding-agent` 2.4.1:**

- **`fan list-models` (subcommand) маршрутизируется в early-exit** — раньше
  уходил в полный bootstrap (~17 с), теперь ~1 с
- **Per-extension таймеры с именами пакетов** в выводе FAN_TIMING

### Изменения версий

- **fan** (root) — `2.5.0` → `2.5.1`
- **`@seaagents/fan-coding-agent`** — `2.4.0` → `2.4.1`

## [2.5.0] — 2026-08-09

### Startup Optimization Release

Релиз производительности запуска. 15 коммитов оптимизации: гранулярные таймеры,
ленивые импорты, parallel resource discovery, jiti singleton, ранние выходы CLI.
Time-to-health API Gateway ~6.5s → ~2.7s.

### Новое

**`@seaagents/fan-coding-agent` 2.4.0:**

- **Гранулярные FAN_TIMING таймеры startup** — `resolvePackages`, `loadExtensions`,
  `ext:<name>`, `loadSkills`, `loadPromptTemplates`, `loadThemes`,
  `loadProjectContext`, `initDatabase`, `createAgentSessionRuntime`
- **Ранние выходы CLI** — `--help` ~4.2x, `--list-models` ~15x быстрее
  (завершение ДО bootstrap, без загрузки extensions/skills/models)
- **jiti singleton + fsCache** — −31% времени загрузки extensions;
  bundled-модули вынесены в `bundled-modules.ts`
- **Lazy dynamic import** — `@fan/api-gateway`, `@fan/mcp`, `@fan/store`
  грузятся только при реальном использовании
- **Async parallel resource discovery** — skills/prompts/themes/context
  через `Promise.all` с `fs/promises`
- **findMostRecentSession** — stat-first + top-10 валидация (42x на 2000 файлах)
- **fd/rg скачивание в фоне** после `ui.start()`, атомарные загрузки

**`@fan/api-gateway` 1.2.0:**

- **HTTP-сервер стартует без ожидания extension binding** — `MCP connectAll`
  в фоне; `SessionAdapter.whenReady()` для гейтинга session-endpoints;
  `/api/health` отвечает мгновенно. Time-to-health ~6.5s → ~2.7s

**`@fan/db` 1.1.0:**

- **`ensureDatabase()`** — идемпотентный singleton для schema init
  (ошибки логируются, промис всегда resolved)
- **`closePrismaClient()`** сбрасывает init-singleton (reconnect сценарии)
- Первая тест-суита пакета (5 тестов, vitest)

**`@fan/model-manager` 1.1.0:**

- **`db()` helper** триггерит `ensureDatabase()` как safety net

### Изменено

- **Context-walk останавливается на git-root** — `loadProjectContextFiles`
  больше не поднимается выше корня репозитория. `FAN_CONTEXT_WALK=fsroot`
  восстанавливает старое поведение
- **Удалена мёртвая зависимость** `@seaagents/fan-web-ui`
- **Extensions**: удалены мёртвые экспорты (`fan-persistent-memory` 4.1.0,
  `fan-session-analytics` 1.4.1)

### Исправлено

- **getPackageDir() пропускает dist/package.json** — устранён crash server/TUI
  с ENOENT dark.json (артефакт `build:binary`); `resolveAssetDir` helper
- **printTimings TOTAL** — исключён двойной учёт parallel-веток
- **bindSessionExtensions** — fire-and-forget rebind, нет unhandled rejection

### Breaking Changes

- **`loadSkills()` и `loadSkillsFromDir()` возвращают `Promise`** — все
  внешние SDK-потребители должны `await` эти вызовы

### Изменения версий

- **fan** (root) — `2.4.2` → `2.5.0`
- **`@seaagents/fan-coding-agent`** — `2.3.7` → `2.4.0`
- **`@fan/api-gateway`** — `1.1.1` → `1.2.0`
- **`@fan/db`** — `1.0.1` → `1.1.0`
- **`@fan/model-manager`** — `1.0.1` → `1.1.0`
- **fan-persistent-memory** — `4.0.1` → `4.1.0`
- **fan-session-analytics** — `1.4.0` → `1.4.1`

## [2.4.2] — 2026-08-07

### Новое

**Таймер футера — по циклам разработки** (`@seaagents/fan-coding-agent` 2.3.7):

- Таймер в футере показывает время ТЕКУЩЕГО цикла разработки: тикает во
  время работы агента (`agent_start` → `agent_end`), при завершении цикла
  сбрасывается и начинает отсчёт заново на следующем ходе
- В конце каждого цикла в чат выводится итоговая строка:
  `⏱ 04:21 · ↑ 12.3k ↓ 1.2k tokens · $0.045 (session)` — затраченное время
  цикла и статистика сессии (dim-цветом, после ответа агента)
- Корректная обработка auto-retry (сообщение не дублируется на ретраях)
  и compaction (итог выводится после пересборки чата)
- Финальная сводка при shutdown показывает полное активное время сессии
  (отдельный несбрасываемый счётчик)

**Модель в live-статусе воркера** (`fan-orchestrator` 7.10.7):

- `buildWorkerContent` выводит модель в статусной строке работающего
  воркера: `Thinking · N tools · N msgs · 🤖 model · MM:SS`
  (скрывается, если модель не определена)

### Исправлено

- **`@seaagents/fan-ai` 1.1.2** — `reasoningEffortMap` для groq теперь
  ссылается на существующую модель `qwen/qwen3.6-27b` вместо удалённой
  `qwen/qwen3-32b` (условие было мёртвым кодом: старая модель никогда не
  существовала под провайдером groq). Все reasoning levels qwen-серии
  корректно мапятся в `"default"`, как требует Groq API
- **Тесты синхронизированы с регенерированным реестром моделей** —
  обновлены ссылки на удалённые модели (`qwen/qwen3-32b`, `glm-4.5-air`)
  в `openai-completions-tool-choice.test.ts` и `model-registry.test.ts`
  с сохранением семантики проверок. Полный прогон монорепо зелёный:
  0 failed по всем 10 пакетам, tsgo/biome/build чисто

### Прочее

- **`fan-orchestrator` 7.10.8** — удалён мёртвый код:
  `runSingleAgentWithRetry` (содержал ReferenceError на необъявленный
  `temperature`, не вызывался) и `runSingleAgentWithFallback`
  (не использовался); вычищены экспорты и .d.ts декларации

---

## [2.4.1] — 2026-08-07

### Исправлено

**Доработки по итогам боевого прогона 2.4.0:**

- **Модель воркера в running-рендере** (`fan-orchestrator` 7.10.6) — модель
  теперь передаётся на верхний уровень `details` в onUpdate
  (`subagent-runner.js`) и видна во время выполнения во всех режимах
  (single/chain/parallel), а не только в parallel; ранее single/chain
  показывали `initializing...` всё время работы
- **Окно воркера при принудительном прерывании** (`fan-orchestrator` 7.10.6) —
  исправлена потеря `details`: `onUpdate` в catch-блоке `runSingleAgent`
  обёрнут в try/catch (исключение из onUpdate не отменяет возврат
  errorResult), во все три режима `delegate_task` добавлен `catch` с синтезом
  полного результата. Теперь при ESC окно воркера показывает статус
  `aborted`, модель, таймер и `─── Partial work (N tools) ───` вместо
  пустой строки с текстом ошибки
- **Таймер в футере — активное время агента** (`@seaagents/fan-coding-agent`
  2.3.6) — таймер больше не идёт непрерывно от старта сессии: отсчёт
  работает во время хода агента (`agent_start` → `agent_end`), при
  завершении или принудительном прерывании останавливается, при новом ходе
  продолжает с накопленного значения. Compaction, auto-retry и `!`-bash
  в счёт не идут. Финальная сводка при shutdown показывает накопленное
  активное время. Новый метод `FooterComponent.setElapsedProvider()`
  (опциональный, `setSessionStartTime()` сохранён как fallback)

### Прочее

- Release-скрипты (`release-binaries.sh` / `release-binaries.ps1`) копируют
  корневой CHANGELOG.md в dist-репозиторий (для ссылки из уведомления
  об обновлении)
- Тесты: footer 9/9 (2 новых кейса на `setElapsedProvider`), оркестратор
  158/158

---

## [2.4.0] — 2026-08-07

### Новое

**Таймер сессии в футере TUI** (`@seaagents/fan-coding-agent` 2.3.5):

- В строке футера с токенами и моделью в конце добавлен живой таймер общего
  времени запуска (формат `MM:SS`, после часа — `H:MM:SS`), обновление раз в
  секунду через батчированный `requestRender()`
- Таймер сбрасывается при new/resume/fork/import/clear сессии и сохраняется
  при reload; extension-футеры без `setSessionStartTime()` работают как раньше
  (таймер опционален, публичный API `FooterComponent` не изменён)
- При завершении сессии (`shutdown`) в терминал выводится финальная сводка:
  `Session ended — duration: 12:34 • tokens: 45.2k • cost: $0.123`

**Модель в хедере воркеров** (`fan-orchestrator` 7.10.5):

- Модель воркера показывается перед таймером во всех местах рендера:
  single running (`🤖 model | ⏱ elapsed | 💬 | 🔧`), parallel running,
  chain/parallel expanded/collapsed хедеры, plan-воркер, task widget

### Исправлено

**Проброс ошибок из воркеров в оркестратор** (`fan-orchestrator` 7.10.5):

- `runSingleAgent` проставляет `stopReason: "error" | "aborted"` на всех путях
  падения (exit code, stall-таймер, abort) — ранее ошибка терялась и
  оркестратор видел нормальное завершение
- `onWorkerStop` получает полный `result` и сохраняет `error`/`stopReason`
  в registry (новый хелпер `finalizeWorker()`)
- `isError: true` теперь возвращается во всех режимах `delegate_task`,
  включая parallel (раньше parallel глотал ошибки воркеров)
- Иконки и `failCount` в renderResult учитывают `stopReason`, а не только
  exit code; исправлен race с pre-aborted signal (`wasAborted` выставляется
  до подписки на событие)

**Прерывание воркеров без потери результатов** (`fan-orchestrator` 7.10.5):

- `stop_worker` реально останавливает subprocess: per-worker
  `AbortController`, `child.kill(SIGTERM)` через существующий обработчик
- Статус `aborted` больше не перезаписывается естественным завершением
  subprocess (guard в `finalizeWorker`)
- Registry не очищается при stop/shutdown (`resetSlots()` вместо
  `_resetRegistry()`): виджет показывает прерванных/упавших воркеров 5 минут
  со статусом и фрагментом ошибки, inline collapsed-рендер выводит
  `─── Partial work (N tools) ───`
- `pruneOldWorkers()` (TTL 10 минут) предотвращает утечку registry
  в длинных сессиях

### Прочее

- `@seaagents/fan-tui` 1.1.0 — biome lint-фиксы (character class в regex
  стража редактора, отступы в `terminal.ts`)
- 14 новых тестов `worker-lifecycle` (оркестратор, 158/158 зелёные),
  тесты таймера футера (7/7)

---

## [2.3.11] — 2026-08-03

### Исправлено

**TUI: утечки escape-последовательностей в редактор на Windows ConPTY** (`@seaagents/fan-tui` 1.0.3):

Пользователь наблюдал обрывки escape-кодов в строке ввода: `[1G` (фрагмент
позиционирования курсора, который TUI пишет в stdout) и `A[` при нажатии
Alt+Up (фрагмент `\x1b[1;3A`). Цепочка причин: ConPTY эхо возвращал
escape-коды в stdin → буфер ввода по таймауту выпускал недособранную
последовательность как ложный Escape → хвост вставлялся в редактор как текст.

- `terminal.ts` — сброс `ENABLE_ECHO_INPUT` при включении VT-режима;
  `ENABLE_PROCESSED_INPUT` намеренно НЕ устанавливается (иначе Ctrl+C
  уходит в SIGINT и ломает перехват кейбиндингов TUI)
- `stdin-buffer.ts` — sequence-aware flush: недособранная
  escape-последовательность ждёт до 3 дополнительных циклов, затем тихо
  выбрасывается; одинокий настоящий Escape работает как раньше
- `editor.ts` — fallback вставки отбрасывает многосимвольные CSI-обрывки
  (`[1G`, `[1;3A`); одиночные печатные символы вставляются как прежде
- `keys.ts` — `alt+up`/`alt+down` распознаются и в CSI-формате
  `\x1b[1;3A`/`\x1b[1;3B` (ранее только legacy `\x1bp`/`\x1bn`); полная карта
  модификаторов в `parseKey`
- 8 новых тестов на фрагментацию, модификаторы и страж редактора;
  508/508 тестов пакета зелёные

---

## [2.3.10] — 2026-08-02

### Расширение fan-session-analytics — полная реализация (v1.4.0)

Новое standalone-расширение FAN для анализа истории сессий: читает JSONL-сессии
(read-only), оценивает использование скилов и расширений, скорость, полноту и
правильность флоу работы. Цель — самоулучшение агента через измеримую
обратную связь. Спецификация: `docs/specs/spec_session-analytics_2026-08-02.md`,
план использования: `docs/backlogs/session-analytics-usage-plan.md`.

**Этап A — детерминированный анализ (0 токенов):**
- Парсер JSONL через `parseSessionEntries()` + нормализатор траекторий
  (main branch, multi-toolCall сообщения)
- 13 детекторов: ошибки инструментов (D1), петли (D2), длительность шагов
  только по агентскому времени (D3, user-idle исключён), эффективность пути
  (D4), флоу оркестратора (D5), использование скилов (D6) и расширений (D7),
  уплотнения (D8), токены/стоимость (D9), брошенные вызовы (D10),
  пропорциональность флоу — тяжёлый пайплайн на мелкой задаче (D11),
  маршрутизация воркеров (D12), пустые ретраи после FAIL (D13)
- Markdown-отчёты с баллом 0–100, инструмент `session_analyze` и команда
  `/session-analytics`
- Интерактивный мастер `/session-analytics init` (мультиселект тяжёлых
  скилов из установленных, двухшаговый выбор модели судьи из registry)

**Этап B — LLM-судья:**
- Прямой вызов `complete()` из `@seaagents/fan-ai` (без сабпроцессов),
  цепочка выбора модели: configured → cheapest → current → unavailable
- 6 рубрик 0–3 с явными критериями (уместность скилла, полнота, декомпозиция,
  экономность, регламент, качество оркестрации), батчинг сжатой траектории,
  валидация ответов с retry, combined score = det×0.6 + судья×0.4

**Этап C — автоматизация и интеграции:**
- F9: авто-анализ на `session_shutdown`, однострочный итог при следующем старте
- F10: еженедельный пакетный анализ с трендом против прошлого периода
- F11: вкладка «Аналитика» в дашборде + endpoints `GET /api/analytics/reports[/:name]`
- F12: золотые траектории (`mark-golden`) — сравнение с эталоном через судью
- F13: майнинг паттернов (цепочки воркеров, n-граммы инструментов, шаблоны
  промптов) → рекомендации по синтезу новых скилов/воркеров

**v1.4.0:** единый глобальный архив отчётов `~/.fan/reports/session-analytics/`
(вместо размазывания по проектам, дашборд читает оба места); инкрементальный
анализ — проанализированные сессии помечаются и пропускаются при повторах
(`--force` для полного перепрогона), weekly — только сравнительный.

**Тесты:** 267 (расширение) + 51 (api-gateway) + 23 (dashboard).

### Добавлено

- **`ExtensionUIDialogOptions.initialValue`** (coding-agent 2.3.4) — начальная
  позиция курсора в `ctx.ui.select()` для расширений; используется
  мультиселектом fan-session-analytics
- **Дашборд**: вкладка «Аналитика» — список отчётов с polling 30 с,
  просмотр markdown (dashboard 1.0.3)

### Исправлено

- `store`: проверка обновлений по всем репозиториям отдельно (per-repo)
- `orchestrator`: баги редактирования пресетов, видимость локального
  репозитория store, разрешение неоднозначных ID моделей с префиксом
  провайдера
- Провайдер `qwen`: работа с оркестратором
- CI: циклическая зависимость сборки coding-agent ↔ @fan/mcp; @fan/mcp
  добавлен в цепочку сборки

---

## [2.3.1] — 2026-07-16

### MCP Интеграция — Полный цикл (Phase 1 + 2 + 3)

Пакет `@fan/mcp` (внутреннее имя `fan-mcp`) — встроенное расширение FAN для
подключения к внешним MCP-серверам (Model Context Protocol). Реализован полный
набор roadmap функций (31/32, 96.9%), включая координаторный MCP, прокси
для воркеров, OAuth, авто-восстановление и observability.

Расширение внедрено в ядро FAN так же, как `@fan/store` — через статический
импорт в `loader.ts` + `VIRTUAL_MODULES` + `tsconfig.json paths` + зависимость
в `coding-agent/package.json`. При компиляции FAN бинарника код mcp-расширения
включается статически и доступен сразу после установки без дополнительных шагов.

**Состояние:** 31/32 roadmap-функций реализованы (96.9%). 1 функция (Dashboard
Lit-компонент) отложена на Phase 4 как UX-улучшение.

**Тесты:**
- `packages/mcp`: 283 теста (20 test files)
- `packages/coding-agent`: 1 029 тестов (без регрессий)
- `packages/tui`: 500 тестов
- `packages/api-gateway`: 45 тестов
- Total: ~1 857 тестов

#### Добавлено

**Новый пакет `@fan/mcp`** (ранее `packages/mcp-extension`, переименован в
`packages/mcp`):

- **Координаторный MCP (Phase 1)** — основной агент подключается к
  MCP-серверам напрямую:
  - Транспорты: `stdio` (спавн дочернего процесса) и `Streamable HTTP`
  - Обнаружение инструментов через `tools/list`, динамическое обновление
    каталога через `notifications/tools/list_changed`
  - Конвертер JSON Schema → TypeBox для параметров инструментов
  - Маппинг `CallToolResult` → `AgentToolResult` (текст, изображения,
    fallback для неподдерживаемых типов контента)
  - Сохранение `structuredContent` в `result.details`
  - Загрузчик `mcp.json` с объединением глобального/проектного конфига
  - Фильтрация инструментов: `allowedTools`/`deniedTools` (glob-шаблоны)
  - Permission gate через хук `tool_call` (блокировка до выполнения)
  - Отмена вызовов через `AbortSignal` → MCP cancel
  - Таймауты per-call (по умолчанию 60 с)
  - Разрешение `${ENV_VAR}` в `mcp.json`
  - Graceful shutdown (закрытие клиентов, kill stdio-процессов)
  - Атомарное обновление реестра при `list_changed`
  - Обработка ошибок: недоступный сервер, краш stdio-процесса,
    невалидный `mcp.json` (graceful skip с warning)

- **Worker Proxy (Phase 2)** — воркеры получают MCP-инструменты через
  protocol-neutral прокси без прямой загрузки расширения и без открытия
  собственных MCP-соединений:
  - Типы `RpcRemoteToolRequest` / `Response` / `Cancel` / `Catalog`
    в `rpc-types.ts` (protocol-neutral, без привязки к MCP SDK)
  - Карта корреляции `remoteToolPendingRegistry` в `rpc-mode.ts`
  - CLI-флаг `--remote-tools=<list>` для режима воркера
  - `RemoteProxyTool` — локальный прокси, отправляющий `remote_tool_request`
    на stdout и ожидающий `remote_tool_response` от родителя
  - `broker-handler` в расширении оркестратора — подписывается на
    EventBus `mcp:catalog`, хранит каталог, маршрутизирует вызовы
  - Профильная фильтрация per-worker:
    - `explore` / `plan` / `verify` / `code-research` → только чтение
    - `implement` / `bug-fix` / `tests-impl` → полный доступ
  - Кеш `lastEvent` на `EventBus` (replay-on-subscribe) для опоздавших
    подписчиков

- **Polish & Hardening (Phase 3)**:
  - **OAuth 2.0 + PKCE** — генерация code_verifier/challenge (S256),
    локальный callback-сервер, обмен code→token, refresh-логика,
    файловое хранилище токенов (`~/.fan/agent/mcp-tokens.json`, mode 0o600)
  - **Авто-перезапуск** упавших stdio-серверов с экспоненциальной
    задержкой (1 с → 2 с → 4 с → 8 с → 16 с, макс. 5 попыток за 60 с)
  - **Slash-команды** `/mcp status` и `/mcp reload`
  - **Логгер** — структурированные JSON-lines в
    `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`
  - **Progress forwarding** — MCP progress → FAN `onUpdate` с
    throttle 50 мс (батчинг высокочастотных событий)
  - **API Gateway** — эндпоинт `GET /api/mcp/servers` (заглушка,
    полный runtime-мост в Phase 4)
  - **Seed starter mcp.json** — при первом запуске FAN автоматически
    создаётся `~/.fan/agent/mcp.json` с пустым списком серверов
    (idempotent, не перезаписывает существующий)

#### Изменения в core

| Файл | Строк | Описание |
|------|-------|----------|
| `extensions/types.ts` | +15 | `unregisterTool`, `updateTool` на ExtensionAPI |
| `extensions/loader.ts` | +2 | Импорт `@fan/mcp` + `VIRTUAL_MODULES` entry |
| `event-bus.ts` | +10 | Кеш `lastEvent` (replay-on-subscribe) |
| `rpc-types.ts` | +90 | Protocol-neutral `RpcRemoteTool*` types |
| `rpc-mode.ts` | +60 | Карта корреляции + хендлеры |
| `rpc/remote-proxy-tool.ts` | новый | `RemoteProxyTool` class |
| `cli/args.ts` | +5 | `--remote-tools` CLI-флаг |
| `agent-session.ts` | +10 | `registerCustomTools` метод |
| **Total core** | **~192 строк** | **Ноль импортов MCP SDK в core** |

#### Исправления безопасности (10 багов найдено при adversarial review)

| # | Severity | Баг |
|---|----------|-----|
| BUG-1 | **CRITICAL** | Permission gate создавался с пустым config — все MCP-вызовы блокировались в runtime |
| BUG-2 | HIGH | Server ID alias injection через `Number("0e0") === 0` |
| BUG-3 | HIGH | SSRF через диапазон 127.0.0.0/8 (loopback bypass) |
| BUG-4 | HIGH | Детерминированный баг в тесте TC-F1.7-9 (неправильная позиция аргумента) |
| BUG-5 | CRITICAL | `list_changed` двойной fetch (SDK `autoRefresh` + ручной вызов) |
| BUG-6 | HIGH | matchGlob ReDoS через неограниченные wildcard-шаблоны |
| BUG-7 | LOW | Мёртвый код `pendingRemoteToolRequests` Map |
| BUG-8 | MEDIUM | Несоответствие имён filterToolsByConfig (raw имена) и permission gate (полные имена) |
| BUG-9 | LOW | Утечка секретов в логгер (Bearer-токены, API-ключи) |
| BUG-10 | MEDIUM | 36 TypeScript-ошибок в тестовых файлах |

#### Изменения версий

- **fan** (root) — `2.3.0` → `2.3.1`
- **@fan/mcp** (новый пакет) — `1.0.0`
- Пакет `@fan/mcp-extension` переименован в `@fan/mcp`,
  директория `packages/mcp-extension/` → `packages/mcp/`

---

## [2.3.0] - 2026-07-14

### 📋 Вставка картинок из буфера (TUI)

- **`alt+v` вставляет `[image_N]` вместо полного пути к файлу** — картинка из
  буфера обмена кладётся в `os.tmpdir()` (по-прежнему доступна для `read`),
  а в редактор вставляется компактный маркер `[image_1]`, `[image_2]`, …,
  с монотонным счётчиком за сессию.
- **Картинки уходят агенту напрямую как vision content** — `ImageContent`
  очередь `pendingImages` пробрасывается в `session.prompt(text, { images })`
  во всех 5 submit-путях (compaction, streaming steer/followUp, main loop,
  Alt+Enter followUp). LLM получает base64 + mimeType — никаких лишних
  `read` tool calls.
- Поддерживаемые форматы: PNG / JPEG / WebP / GIF нативно, BMP / TIFF / и др.
  конвертируются в PNG через `@silvia-odwyer/photon-node` (WASM).
- Платформы: Windows / macOS / Linux (Wayland, X11) / WSL.
- `@mariozechner/clipboard` — N-API, optionalDependency (если не установлен —
  вставка молча игнорируется).

### 🎨 Стартовая информация (TUI)

- **Компактные списки Skills и Extensions** — вместо многострочного перечня
  полных путей в startup header теперь одна строка имён через запятую:
  ```
  [Skills]
    code-research, deep-dive, dev-docs-pack, feature-pipeline, feature-roadmap, idea-lab, repo-explorer, research-spec-generator
  ```
  Аналогично для `[Extensions]`.
- **Новый хоткей `alt+s` Store** в начале списка — жирным шрифтом,
  акцентным цветом. Активирует FAN Store (fan-store extension).

### 🔒 Безопасность (оркестратор)

- **Respect `FAN_DANGEROUSLY_SKIP_PERMISSIONS` в permission hook** — теперь
  переменная окружения проверяется первой и UI-аппрув полностью обходится.
  Поведение согласовано с core bash tool: обе стороны пропускают проверки
  опасных команд при установленном флаге.
  (`extensions/fan-orchestrator/orchestrator-extension.js`).

### 🧹 Прочее

- **Linter fixes** в `packages/coding-agent/test/security/permissions.test.ts` —
  убраны избыточные проверки и упрощена структура тестов.

### Изменения версий

- **fan** (root) — `2.2.2` → `2.2.3`.
- **@seaagents/fan-coding-agent** — `2.2.1` → `2.2.3`.

---

## [2.2.0] - 2026-07-08

### 🚀 Pipeline Mode (feature-pipeline v3.1.0)

- **Рабочие артефакты pipeline** — три файла на диске, которые создаются 1 раз
  и обновляются автоматически на каждый `TaskCreate`/`TaskUpdate`:
  - `docs/development-plan.md` — машиночитаемый roadmap.
  - `docs/development-log.md` — append-only журнал выполнения.
  - `.fan/tracking/phase-status.json` — JSON state machine.

- **Команда `/pipeline`** (в `fan-orchestrator` v7.4.0):
  - `init` — интерактивная инициализация: feature-name, commit-strategy, фазы.
  - `status` — прогресс по фазам (widget, 10 сек).
  - `log [N]` — последние N записей из журнала.
  - `finish` — пометить завершённым + выбор: Keep / Delete артефакты.
  - `cancel` — деактивировать в памяти, артефакты сохраняются.

- **Авто-обновление артефактов** — `fan.on("tool_result", ...)` хук:
  на каждый `TaskCreate`/`TaskUpdate` синхронно обновляет `phase-status.json`
  и append в `development-log.md`. Координатор не делает это вручную.

- **State Recovery** — `session_start` автоматически читает
  `.fan/tracking/phase-status.json` и восстанавливает pipeline в памяти.
  После обрыва сессии работа продолжается с места остановки.

- **Commit policy** через conventional-commits:
  - `per-phase` — `feat(phase-N): <name> complete` после завершения фазы.
  - `per-function` — `feat(phase-N/F-X.Y): <summary>` после завершения функции.
  - `manual` — без автокоммитов.

- **Новый модуль `pipeline-state.js`** в `extensions/fan-orchestrator/`:
  атомарные операции (temp + rename), per-path lock Map, UTF-8, без external
  deps.

### Изменения версий

- **fan** (root) — `2.1.0` → `2.2.0`.
- **fan-orchestrator** — `7.3.0` → `7.4.0` (Pipeline Mode).
- **feature-pipeline** skill — `3.0.0` → `3.1.0` (рабочие артефакты, commit policy).

### Документация

- `docs/guides/orchestrator.md` — добавлена секция «Pipeline Mode (v3.1.0)»
  с 10 подразделами (149 строк).

---

## [2.1.0] - 2026-07-08

### 🔒 Безопасность (критическое обновление)

- **Dangerous command detection встроен в core bash tool** — теперь проверка
  опасных команд работает для ВСЕХ процессов FAN (координатор, воркеры, CLI,
  RPC), а не только для оркестратора:
  - `packages/coding-agent/src/core/security/permissions.js` — новый модуль
    с полным набором детекторов.
  - `packages/coding-agent/src/core/tools/bash.ts` — блокировка опасных команд
    непосредственно перед `ops.exec()` через `reject(new Error("Blocked: ..."))`.
  - Экспорт `isDangerousCommand` из `@seaagents/fan-coding-agent` public API.

- **Расширенный набор детекторов** (heredoc, pipes, interpreters, и др.):
  - **Heredoc** — `sh << EOF ... EOF`, `bash <<< "..."` — извлекается тело и
    проверяется.
  - **Pipe analysis** — `curl ... | sh`, `wget ... | bash`, `echo "rm" | bash`.
  - **Interpreter inline** — `node -e`, `python -c`, `perl -e`, `ruby -e` — код
    извлекается и рекурсивно проверяется.
  - **Subshell** — `bash -lc`, `env sh -c`, `xargs sh -c`, `time bash -c`,
    `nohup bash -c`, `sudo bash -c`.
  - **Fork bomb** — `:(){ :|:\& };:`.
  - **dd** — `dd ... of=/dev/sda|hd|nvme|vd|xvd`.
  - **mv** — `mv ... /(etc|boot|usr|var|sys|proc)`.
  - **chmod без -R** — `chmod 777 /etc` и другие критические пути.
  - **rm через переменные** — `rm -${FLAG}f /`.
  - **rm brace expansion** — `rm -r{f,} /`.
  - **chmod/chown -R** — расширено на `/etc`, `/usr`, `/var`, `/boot`, `/home`.
  - **Service whitelist** — `systemctl stop X` и `service X stop` не считаются
    опасными (ранее любое упоминание слова "service" отключало проверку).

- **Audit log** — `~/.fan/agent/audit/orchestrator.log` (JSONL):
  - `timestamp`, `command`, `reason`, `decision` (`allow` | `block` |
    `headless_block`), `agentType`, `workerId`.
  - Записывается при каждом решении (Allow / Block / Headless).

- **Orchestrator hook убран из пути блокировки** — теперь только audit-only:
  - Раньше: хук оркестратора проверял → показывал UI → core тоже проверял →
    двойная блокировка (пользователь Allow → core всё равно Block).
  - Теперь: единая точка блокировки в core bash tool, хук только логирует.

- **Init-wizard UI для dangerous commands** — в `/orchestrator init` добавлен
  шаг редактирования списка опасных паттернов: Keep / Edit / Remove / Add new.

### Пользовательский интерфейс для опасных команд

- **CLI флаг `--dangerously-skip-permissions`** — глобальное отключение проверки
  опасных команд для всей сессии:
  - `packages/coding-agent/src/cli/args.ts` — парсинг флага в
    `result.dangerouslySkipPermissions = true`.
  - `packages/coding-agent/src/main.ts` (строка 841) — установка
    `process.env.FAN_DANGEROUSLY_SKIP_PERMISSIONS = "true"` при старте;
    переменная окружения прозрачно передаётся всем дочерним процессам.
  - Предназначен для доверенных окружений (локальная dev-машина,
    CI/CD с фиксированными скриптами).

- **Интерактивное UI подтверждение** (Allow / Block) при срабатывании детектора
  опасных команд:
  - `extensions/fan-orchestrator/orchestrator-extension.js` (hook `tool_call`,
    строка 270) — перехват вызова `bash`-инструмента, проверка через
    `isDangerousCommand()` с учётом пользовательских паттернов.
  - При наличии `ctx.ui.select` показывается диалог:
    - **Allow** — устанавливает `event.input._fanDangerouslyApproved = true`,
      что передаётся в core bash tool и снимает блокировку для этой конкретной
      команды.
    - **Block** — возвращает `{ block: true, reason }`, команда не исполняется.
  - Механизм `_fanDangerouslyApproved`:
    - `packages/coding-agent/src/core/tools/bash.ts` (строка 339) — guard:
      `if (_fanDangerouslyApproved !== true && ...)` — если флаг установлен,
      вызов `isDangerousCommand()` пропускается.
    - Флаг живёт только на время одного вызова `bash`-инструмента, не сохраняется
      между вызовами — каждое выполнение требует отдельного подтверждения.
    - Если пользовательские паттерны настроены, они проверяются до UI;
      Allow снимает блокировку и для пользовательских паттернов.

- **Headless mode** — при отсутствии `ctx.ui` (нет TUI/интерактивного ввода):
  - Команда автоматически блокируется с решением `headless_block`.
  - Единственное исключение — флаг `--dangerously-skip-permissions`,
    установленный до старта сессии.
  - Все решения записываются в audit log
    (`~/.fan/agent/audit/orchestrator.log`, JSONL) с полем `decision`:
    `allow` | `block` | `headless_block`.

### Тестирование

- **50 тестов** в `extensions/fan-orchestrator/test/permissions.test.mjs`.
- **26 тестов** в `packages/coding-agent/test/security/permissions.test.ts`.
- Все тесты проходят. Build — 0 ошибок.

### Изменения версий

- **@seaagents/fan-coding-agent** — `2.0.2` → `2.1.0` (core security module).
- **fan-orchestrator** — `7.2.0` → `7.3.0` (permission hardening, audit log,
  init-wizard UI).

---

## [1.0.3] - 2026-06-25

### Новое

- **Конфигурация LLM через `models.json`** — теперь новые провайдеры и модели можно
  добавлять без изменений в коде:
  - Поддержка произвольных имён провайдеров с указанием `api` (например,
    `openai-completions`, `anthropic-messages`).
  - Добавлено поле `envVar` в конфигурации провайдера для явной привязки
    переменной окружения с API-ключом.
  - Поле `apiKey` больше не является обязательным в `models.json` — FAN
    разрешает ключ через `--api-key`, `auth.json`, OAuth, переменные окружения
    или `models.json`.
  - `AuthStorage` теперь получает динамические `envVar`-маппинги из
    `models.json`, включая после `refresh()`.
  - Для существующих встроенных провайдеров новые модели можно добавлять
    только по `id` — `baseUrl` и `api` наследуются от built-in моделей
    провайдера.

### Изменения

- **@seaagents/fan-coding-agent** — версия пакета поднята с `1.0.2` до `1.0.3`.

### Исправления

- **model-registry** — метод `refresh()` теперь синхронизирует обновлённые
  `envVar`-маппинги с `AuthStorage`, чтобы изменения `models.json` применялись
  без перезапуска процесса.

### Документация

- `packages/coding-agent/docs/models.md` — добавлены разделы: добавление
  кастомных провайдеров без изменений кода, наследование `baseUrl`/`api` от
  встроенных моделей, поле `envVar`, порядок разрешения API-ключей, когда
  `apiKey` обязателен, ограничения.

## [1.0.2] - 2026-06-25

### Изменения

- **Документация** — `packages/coding-agent/docs/models.md` — добавлены разделы: добавление
  кастомных провайдеров без изменений кода, поле `envVar`, порядок разрешения API-ключей,
  когда `apiKey` обязателен, ограничения.

## [1.0.1] - 2026-06-15

### Исправления

- **Сборка** — удалён `scripts/sync-version.mjs` и корневой `prebuild` хук.
  `npm run build` больше не синхронизирует версии всех пакетов с корневой.
  Версии пакетов теперь обновляются вручную (независимое версионирование).
- **Ребрендинг** — массовая замена оставшихся упоминаний `pi` на `fan` в
  коде, логах, скриптах и примерах расширений.
- **FAN Store** — параметры `pi` переименованы в `fan` в командах и
  инструментах store.
- **TUI** — пути лог-файлов отладки изменены с `pi-debug.log` / `pi-crash.log`
  на `fan-debug.log` / `fan-crash.log`.
- **export-html** — meta-теги в шаблоне экспорта переименованы в
  `fan-url-params` / `fan-share-base-url`.

### Новое

- **Лэндинг FAN** — добавлена директория `lending/` с одностраничным сайтом
  в стиле терминала Fallout 3 / PipBoy. Содержит описание проекта, ключевые
  возможности, команды установки и ссылки на документацию.

### Документация

- `docs/RELEASE.md` — актуализировано описание процесса релиза с учётом
  удаления `sync-version.mjs`.

---

## [1.0.0] - 2026-06-14

### 🚀 FAN 1.0.0 — Первый стабильный релиз

Этот релиз знаменует собой стабилизацию API и архитектуры FAN. Все компоненты
достигли production-ready состояния. Основные направления разработки в этом цикле:
интеграция с IntelliJ IDEA, улучшение FAN Store, новый набор навыков, провайдеры LLM.

**Ключевые пакеты:**
- `@seaagents/fan-coding-agent` — CLI-интерфейс, runtime, набор инструментов
- `@seaagents/fan-ai` — унифицированное LLM API (10+ провайдеров)
- `@seaagents/fan-agent-core` — абстракция агента с транспортами и состоянием
- `@seaagents/fan-tui` — TUI-библиотека с дифференциальным рендерингом (отдельный npm-пакет)
- `@seaagents/fan-web-ui` — компоненты веб-интерфейса (отдельный npm-пакет)
- `@fan/api-gateway` — HTTP/WebSocket сервер для клиентских подключений
- `@fan/db` — слой базы данных (Prisma + SQLite)
- `@fan/model-manager` — маршрутизация провайдеров, fallback-цепочки, бюджет
- `@fan/dashboard` — веб-панель управления (Lit + Tailwind)
- `@fan/store` — менеджер пакетов (расширения, навыки, темы)

**Поставляемые навыки (8шт):**
`auto-tests`, `bug-fix`, `code-research`, `deep-dive`, `fan-forge`, `idea-lab`, `repo-explorer`, `research-spec-generator`

---

### Новое

- **IntelliJ IDEA Plugin** — полноценная интеграция FAN в IntelliJ Platform
  - JCEF-движок рендеринга чата (TUI-стиль визуализации)
  - Панели: Welcome, SessionList, Chat, Input, Renderer, StatusBar
  - Автостарт локального FAN-сервера, авто-провижинг без токенов
  - Уведомления, Actions (DeleteSession, OpenSettings, AskFan)
  - Поддержка IC-2024.2.2+, JCEF на Ubuntu 24.04
- **Расширение `fan-soul`** — управление идентичностью агента (SOUL.md / USER.md)
- **Расширение `fan-loop`** — цикл самостоятельного выполнения задач
- **Расширение `fan-confluence`** — интеграция с Confluence Data Center
- **Инструмент `confluence`** — чтение/запись/поиск страниц Confluence
- **Провайдеры LLM:**
  - MiniMax-M3, MiniMax-M1
  - MiMo (Mistral + Moonshot)
  - DeepSeek (встроенный провайдер)
  - Filin-LightLLM (лёгкий инференс)
  - Kimi
- **dev-docs-pack skill v1.1.0** — генератор полного пакета документации разработки
- **feature-pipeline + feature-roadmap skills** — TDD-пайплайн разработки фич

### Улучшения

- **FAN Store** — полная адаптация pi-store v1.7.1
  - `/store browse` — интерактивный браузер пакетов
  - Анимация операций install/remove/update
  - 11 предустановленных навыков (FAN Store)
  - SHA-256 верификация, path traversal защита, backup & rollback
  - Репозиторий по умолчанию: `https://fan.sea-agents.ru/fan-store/`
- **Оркестратор v5** — PI-style воркеры, новый протокол взаимодействия
- **Менеджер моделей** — обновление моделей перед `getAvailable`
- **TLS skip** — всегда пропускать верификацию TLS для fd/rg download
- **Корпоративные прокси** — поддержка прокси с самоподписанными сертификатами
- **Windows** — скрытие окна терминала при self-update
- **Версия инлайнится** в api-gateway dist на этапе сборки (bun compile)

### Исправления

- **build** — использование `bun install` вместо `npm`, работа с bun isolated linker
- **build** — cross-platform native bindings через `--ignore-scripts`
- **build** — исправление относительных require('./package.json') для bun compile
- **server** — режим foreground для корректного project CWD
- **server** — `resolveAppMode()` проверяет `--mode` флаг перед `FAN_FORCE_SERVER_MODE`
- **store** — переписана установка (bun CLI, staging, очистка workspace deps)
- **store** — показ локально установленных пакетов не из удалённого индекса
- **idea-plugin** — 40+ исправлений компиляции, рантайм-конфликты, JCEF краши
- **idea-plugin** — отключение корутин в UI-слое, замена на IntelliJ native threading
- **idea-plugin** — отображение статуса подключения, блокировка Send до коннекта
- **extensions** — `session_start` событие для серверного режима
- **fan-repo** — `rsync` без `--delete`, чтобы не терять пакеты
- **Загрузка системных CA-сертификатов** для HTTPS-соединений
- **Очистка зависимостей** — удалены неиспользуемые зависимости и сборки

### Технический долг / Архитектура

- Оркестратор вынесен в отдельное расширение FAN Store (v4 → v5)
- Удалён `--delete` из rsync при публикации в fan-repo
- Обновлён CLAUDE.md с правилами импорта
- Роадмапы фич и документация по плагину

---

## [0.10.0] - 2026-06-02

- Bump версии до 0.10.0
- Миграция FAN Store на новый сервер `fan.sea-agents.ru/fan-store`

---

## [0.9.0] - 2026-05-30

- Bump версии до 0.9.0
- Исправление inlining версии в api-gateway dist для bun compile
- Refactor: извлечение orchestrator в FAN Store, исправление версионирования

---

## [0.8.4] - 2026-05-25

- Исправления сборки: отключение autoload для dotenv и package.json
- Поддержка system CA-сертификатов
- Добавлен DeepSeek как встроенный провайдер

---

## [0.7.8] - 2026-05-20

- Провайдер MiMo
- Исправление Windows: скрытие окна терминала при self-update

---

## [0.7.5] - 2026-05-18

### IntelliJ IDEA Plugin (масштабная интеграция)

- JCEF-движок рендеринга (TUI-стиль визуализации)
- Панели: Welcome, SessionList, Chat, Input, Renderer, StatusBar
- Работа с сессиями, навигация, отправка сообщений
- Автостарт/стоп FAN-сервера в проекте
- Состояние подключения, уведомления, Actions
- 40+ исправлений: компиляция, рантайм-конфликты, JCEF краши

### Прочее

- `session_start` событие для серверного режима
- Фильтрация сессий по project CWD

---

## [0.7.4] - 2026-05-10

- 11 предустановленных навыков для FAN Store
- Оркестратор v2 — мульти-агентная платформа (миграция)

---

## [0.7.1] - 2026-05-08

- FAN Store v0.7.0 — полная адаптация pi-store v1.7.1
- `/store browse` — интерактивный браузер пакетов
- Анимация операций install/remove/update

---

## [0.6.0] - 2026-05-05

- Bump версии до 0.6.0
- Исправление сборки: build-binaries.sh переписан для bun isolated linker
- Self-update: `fan update` + install.sh / install.ps1
- Авто-копирование артефактов сборки в `~/fan-repo/dist/`

---

## [0.5.1] - 2026-05-01

- Исправление установки: полная директория + symlink + realpath resolution
- Trim бинарной дистрибуции до runtime-необходимого
- Хэндлинг существующей директории в install.sh

---

## [0.4.5] - 2026-04-28

- Добавлен fan-repo как репозиторий по умолчанию
- Переписан установщик FAN Store: bun CLI, staging, очистка workspace deps

---

## [0.4.3] - 2026-04-25

- Исправления сборки: --no-scripts для cross-platform deps, skip native compilation

---

## [0.4.1] - 2026-04-22

- Исправления build: bun add вместо npm, работа с isolated linker
- FAN Store: animation install/remove/update

---

## [0.4.0] - 2026-04-20

- **Оркестратор вынесен** в standalone расширение FAN Store (v0.4.0)
- Удалена жёсткая интеграция из core, авто-обнаружение через Store

---

## [0.3.5] - 2026-04-18

- `/store browse` — интерактивный браузер пакетов

---

## [0.3.4] - 2026-04-17

### FAN Store — Package Manager Extension

#### Новый пакет: `@fan/store`
- Менеджер пакетов для установки расширений, навыков и тем
- 5 LLM-инструментов: `store_search`, `store_install`, `store_remove`, `store_update`, `store_list`
- `/store` slash-команда с подкомандами
- Управление репозиториями, multi-repo поиск
- Установка из архивов (.tar.gz, .tgz, .zip)
- Bundle support (extensions/, skills/, themes/)
- SHA-256 верификация, path traversal protection, backup & rollback
- Оффлайн-режим, file:// URL поддержка

---

## [0.3.3] - 2026-04-17

- Исправление: восстановлены агенты в оркестраторе

---

## [0.3.1] - 2026-04-16

- Исправление: загрузка глобального `.env` в process.env при старте

---

## [0.3.0] - 2026-04-16

### Новый пакет: `@fan/persistent-memory` v2.0.0
- Расширение для сохранения знаний между сессиями
- Память вынесена из core в отдельный пакет

---

## [0.2.2] - 2026-04-15

- Исправление бага загрузки .env
- Обновление README, CHANGELOG и roadmap ссылок

---

## [0.2.1] - 2026-04-15

- TLS skip для fd/rg download
- Поддержка корпоративных прокси

---

## [0.2.0] - 2026-04-15

### Оркестратор — TUI работников и архитектура

- Живое отображение инструментов работников
- Состояния: running, completed collapsed/expanded
- Task List Widget с авто-скрытием
- Slot pool для контроля конкурентности
- stop_worker, parseVerdict()
- Документация и обновление системного промпта координатора
