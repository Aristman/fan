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
| Реализовано (✅) | 6 |
| Провалено (❌) | 0 |
| Коммитов | 6 |

## Прогресс

### Этап 0: mission-loop-0 (F-01..F-15)

| Фича | Статус | Коммит | Тесты | Попыток |
|------|--------|--------|-------|---------|
| F-01 REST abort | ✅ | f0a83af | 65/65 api-gateway | 1 (+1 fix) |
| F-02 Лимиты очередей | ✅ | 42360a6 | 54/54 + 3 phantom | 1 (+1 fix) |
| F-03 Watchdog | ✅ | bb273e3 | 19 watchdog / 1089 | 1 (+1 fix) |
| F-04 Детектор циклов | ✅ | 7a41f82 | 33 / 1121 | 1 (+2 fix) |
| F-05 Drain-флаг | ✅ | cb66834 | 17 drain + 55 agent | 1 (+2 fix) |
| F-06 Drain API | ✅ | 0f03f90 | 81/81 api-gateway | 1 |
| F-07 budget_alert | ☐ | — | — | — |
| F-08 File-state-manager | ☐ | — | — | — |
| F-09 Mission loop | ☐ | — | — | — |
| F-10 CLI init | ☐ | — | — | — |
| F-11 Slash-команды | ☐ | — | — | — |
| F-12 TUI-виджет | ☐ | — | — | — |
| F-13 fan-scheduler | ☐ | — | — | — |
| F-14 fan-webhook | ☐ | — | — | — |
| F-15 Интеграционные тесты | ☐ | — | — | — |

### Этап 1: mission-validation-1 (F-16..F-22) — ожидает
### Этап 2: http-hierarchy-2 (F-23..F-35) — ожидает
### Этап 3: depth-and-dashboard-3 (F-36..F-47) — ожидает

## Журнал

- **2026-08-10** — Pipeline инициализирован. Создано 18 задач (15 фич + verify/smoke/docs), зависимости wired.
- **2026-08-10** — **F-01 ✅** REST abort + WS abort. Red 14/14 FAIL → Green +31/−2 → verify FAIL (biome format, 1 строка) → bug-fix (format + reason-параметр + console.warn) → PASS. Коммит `f0a83af`.
- **2026-08-10** — **F-02 ✅** Лимиты очередей (QueueOverflowError, дефолт 50). Red 14/15 → Green +18 LOC → verify PASS (находки: P1 фантом в shadow-очереди, P2 нет валидации лимита) → bug-fix P1+P2+ниты → 54/54. Коммит `42360a6`.
- **2026-08-10** — **F-03 ✅** Watchdog. Red 3/7 → Green (+105 LOC) → verify FAIL (блокер: один таймер разоружался параллельными tool calls — дефолтный режим!) → bug-fix: WatchdogTimer класс с Map per-toolCallId + валидация timeoutMs + elapsedMs от последнего reset → 1089/1089. Коммит `bb273e3`.
- **2026-08-10** — **F-04 ✅** Детектор циклов. Red 5/11 → Green → verify FAIL (микротаск-эстафета 700×count, one-shot на сессию, biome) → fix1 → verify FAIL (гонка abort в runLoop, reset за extensionRunner) → fix2 (чек signal.aborted между ходами в agent-loop — глобальный фикс abort-гонки; reset на agent_start) → **PASS**. Коммит `7a41f82`.
- **2026-08-10** — **F-05 ✅** Drain-флаг. Red 10/10 → Green (+36 LOC) → verify FAIL (P1 потеря followUp после text-only хода, P2 prompt-байпас, P3 retry-байпас, P4 гонка resume) → fix1 (state-машина idle→draining→drained→idle, guard'ы) → verify FAIL (гонка установки drain в окне turn_end→agent_end) → fix2 (условие `_drainStopPending || _drainAfterCurrentTurn`, drain_cancelled, compaction-гварды) → гейт PASS. Коммит `cb66834`. Старт: F-06.
- **2026-08-10** — ⚠️ Инцидент: pipeline-report.md потерял несохранённые правки после stash-проверки флаки-теста. Восстановлен из контекста координатора; отныне коммитится вместе с каждой фичей.

## Бэклог (follow-ups, не блокеры)

1. **Флаки/падеж** `agent-session-concurrent > should queue extension-origin steering messages while streaming` — падает и на базовом HEAD (stash-подтверждено), держит `npm test` в exit 1. Нужен quarantine/тикет.
2. **F-02 P3:** `messageQueueLimit` не проброшен в sdk.ts/настройки (доступен только прямым пользователям Agent API).
3. **F-02 P4:** REST `classifyErrorStatus` не знает QueueOverflowError → 500 вместо 429/структурированной диагностики.
4. **F-03 P3:** событие `watchdog_timeout` не персистится в JSONL и не показывается в TUI; docs (sdk.md/rpc.md) не описывают. То же для `loop_detected` и drain-событий (F-04/F-05).
5. **F-04:** `normalizeErrorText` не гасит Windows-пути, перенормализует host:port/время; ban-message хардкод на русском (i18n).
6. **F-04:** провайдеры без поддержки AbortSignal — abort проигрывает (gap agent-core, честные провайдеры сигнал чтят).
