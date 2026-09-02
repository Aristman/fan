# Руководство по миссиям FAN

> Миссии — автономный режим работы сверх-оркестратора для длительных (часы и дни) задач.
> Расширение `fan-mission` реализует миссионный контур: файловое состояние, 7-шаговый цикл,
> прерывания I0–I4, EPIC-делегирование в дерево узлов `fan-super-orchestrator`.

## Содержание

- [Обзор](#обзор)
- [Быстрый старт](#быстрый-старт)
- [Файловое состояние миссии](#файловое-состояние-миссии)
- [Миссионный цикл (7 шагов)](#миссионный-цикл-7-шагов)
- [Управление миссией](#управление-миссией)
- [Прерывания I0–I4](#прерывания-i0i4)
- [Promise-теги](#promise-теги)
- [EPIC-делегирование и дерево узлов](#epic-делегирование-и-дерево-узлов)
- [Манифесты инструментов](#манифесты-инструментов)
- [Бюджеты](#бюджеты)
- [Верификация](#верификация)
- [Наблюдаемость](#наблюдаемость)
- [Автотик (scheduler → mission_tick)](#автотик-scheduler--mission_tick)
- [Webhook](#webhook)
- [Troubleshooting](#troubleshooting)
- [Примеры](#примеры)

---

## Обзор

Миссия — это набор файлов в `docs/missions/<slug>/`, описывающий цель, план и состояние
долгосрочной задачи. Расширение `fan-mission` читает эти файлы и выполняет детерминированный
7-шаговый цикл (`tick`), пока все пункты ROADMAP.md не будут отмечены выполненными.

**Ключевые свойства:**

- **Файловое состояние** — миссия переживает перезапуск процесса (`.mission-loop.json`, `STATE.md`)
- **Прерывания** — 5 уровней (I0–I4): от немедленной остановки до плановых тиков
- **Promise-теги** — агент возвращает `<promise>COMPLETE|BLOCKED|DECIDE|FAILED</promise>`
- **EPIC-делегирование** — сложные пункты ROADMAP делегируются в дерево узлов `fan-super-orchestrator`
- **Бюджет** — двойной лимит (токены + USD), аллокация по веткам дерева
- **Верификация** — 5-ступенчатая лестница: typecheck → linters → build → tests → acceptance

**Архитектура:**

```
fan-mission (контур)
├── file-state-manager  — MISSION.md / STATE.md / ROADMAP.md / BACKLOG.md / DECISIONS.md
├── mission-loop        — 7-шаговый tick (wake → read → decide → iterate → verify → commit → backlog)
├── session-executor    — промпт → LLM → parsePromise → IterationResult
├── promise-parser      — извлечение <promise>TAG</promise> из ответа
├── verification-ladder — 5 ступеней верификации
├── epic-delegation     — [EPIC] маркер → декомпозиция → mission_delegate → дерево L1
├── slash-commands      — /mission:start|stop|pause|resume|steer|decide|status
├── mission-widget      — F9-виджет в TUI
├── tick-bridge         — авто-тик от fan-scheduler (mission_tick)
├── idea-generator      — генерация идей в BACKLOG (каждые 3 итерации)
├── idea-scorer         — оценка идей (ROADMAP / DECIDE / REJECTED)
└── metrics-collector   — JSONL-метрики итераций (failureRate, prematureTerminationRate)

fan-super-orchestrator (дерево узлов)
├── process-manager     — spawn/kill дочерних fan server
├── port-pool           — пул портов 7001–7099
├── depth-width-guard   — глубина ≤4 (рабочая), ≤12 (предохранитель)
├── tool-manifest       — манифесты инструментов (--tools)
├── message-sanitizer   — санитизация + валидация межагентных сообщений
├── work-package        — протокол пакета работ (L0 → L1)
├── node-report         — протокол отчёта узла (L1 → L0)
├── child-node-client   — REST+WS клиент дочернего узла
├── budget-coordinator  — глобальный координатор бюджета (mission-budget.json)
├── budget-aggregator   — агрегация расхода по дереву
├── tree-journal        — JSONL-журнал дерева узлов
└── depth2-integration  — сквозная интеграция (L0 → N×L1)
```

---

## Быстрый старт

### 1. Создание миссии

```bash
# Инициализация с шаблоном по умолчанию
fan mission init auth-refactor

# С шаблоном для рефакторинга
fan mission init auth-refactor --template refactor
```

Команда создаёт каталог `docs/missions/auth-refactor/` с 5 файлами:

| Файл | Назначение |
|------|-----------|
| `MISSION.md` | YAML-frontmatter (mission_id, статус, бюджет) + цель, скоуп, метрика |
| `ROADMAP.md` | Чеклист пунктов задачи (`- [ ] ...`) |
| `STATE.md` | Текущее состояние: «Сделано», «Блокеры», «Следующие шаги» |
| `BACKLOG.md` | Бэклог идей (заполняется автоматически генератором) |
| `DECISIONS.md` | Журнал решений |

### 2. Настройка MISSION.md

Отредактируйте frontmatter:

```yaml
---
mission_id: a1b2c3d4-...
created: 2026-08-15T10:00:00Z
status: active
metric_type: test_pass_rate
metric_command: npm test
budget_tokens: 500000
budget_usd: 10.00
max_depth: 4
max_width: 4
---
```

Заполните разделы: **Goal**, **Scope**, **Unbreakable Metric**, **Constraints**.

### 3. Заполнение ROADMAP.md

Добавьте пункты задачи:

```markdown
# Roadmap

- [ ] Настроить конфигурацию auth middleware
- [ ] Рефакторинг token validation
- [ ] Добавить rate limiting
- [ ] Написать интеграционные тесты
- [ ] Обновить документацию API
```

Для EPIC-делегирования пометьте пункт маркером `[EPIC]`:

```markdown
- [ ] [EPIC] Полная переработка auth middleware (дерево из 3 подзадач)
```

**Гранулярность пунктов.** Делайте пункты атомарными и проверяемыми: один пункт —
одно сфокусированное изменение, которое исполнитель успевает выполнить и проверить
за одну итерацию (~20–30 минут). Крупные области дробите на несколько пунктов ещё
на этапе планирования. Если чрезмерно большой пункт всё же попал в ROADMAP,
исполнитель по руководству в промпте сам раздробит его: вставит атомарные
проверяемые подпункты ниже исходного, пометит его `[x]` (decomposed) и завершит
итерацию — цикл выполнит подпункты по одному. Альтернатива для по-настоящему
крупной работы — делегирование через `[EPIC]`. Обратите внимание: per-step таймаут
у runAgent больше нет — длинные шаги предотвращаются только декомпозицией, а не
таймером.

### 4. Запуск миссии

```bash
# Запустить один тик цикла
fan mission start

# Или через slash-команду в TUI
/mission:start
```

Миссия переходит в статус `active` и начинает выполнять пункты ROADMAP по одному.

### 5. Автопилот (scheduler)

Для автоматических тиков настройте `fan-scheduler` — расширение шлёт событие `mission_tick`
по cron-расписанию, `tick-bridge` вызывает `MissionLoop.tick()` без LLM-промпта.

---

## Файловое состояние миссии

Миссия хранится в `docs/missions/<slug>/`. Помимо 5 основных файлов, расширение создаёт
служебные файлы:

| Файл | Назначение |
|------|-----------|
| `.mission-loop.json` | Состояние цикла: текущая итерация, последний шаг, бюджет, прерывания |
| `.mission-loop.lock` | Файловая блокировка (защита от конкурентных tick) |
| `.mission-drain-flag` | Сигнал drain (I1): завершить текущий ход и пауза |
| `.mission-steer-queue.json` | Очередь steer-сообщений (I2) |
| `.mission-abort-signal` | Сигнал abort (I0) |
| `.mission-ideas.json` | Маркер последней генерации идей |
| `tree-journal.jsonl` | Журнал дерева узлов (fan-super-orchestrator) |
| `mission-budget.json` | Состояние бюджета миссии |
| `metrics.jsonl` | Метрики итераций (append-only) |

**Восстановление после сбоя:** `.mission-loop.json` хранит точку остановки. При следующем
`tick()` цикл возобновляется с последнего сохранённого шага — потеря не более одной
незавершённой итерации.

---

## Миссионный цикл (7 шагов)

Каждый `tick()` выполняет 7 шагов строго последовательно:

| Шаг | Имя | Описание |
|-----|-----|----------|
| 1 | **wake** | Чтение `.mission-loop.json`, проверка abort-сигнала, terminal-статусов, drain |
| 2 | **read** | Чтение STATE.md, ROADMAP.md, git log; preflight STATE.md (архивирование при >5 КБ) |
| 3 | **decide** | Поиск первого невыполненного пункта ROADMAP; если все выполнены → `completed` |
| 4 | **iterate** | Выполнение пункта: промпт → LLM → `parsePromise` → IterationResult |
| 5 | **verify** | Лестница верификации (для COMPLETE-итераций) |
| 6 | **commit** | Git-commit результата + отметка `[x]` в ROADMAP |
| 7 | **backlog** | Генерация идей (F-19), оценка (F-20), запись метрик (F-21) |

**Восстановление:** если процесс упал на шаге 4–5, при следующем `tick()` цикл обнаружит
сохранённый `iterationResult` в `.mission-loop.json` и продолжит с шага 5 (verify),
не повторяя итерацию.

---

## Управление миссией

### CLI-команды

```bash
fan mission init <slug> [--template <name>]  # Создать миссию
fan mission start                             # Запустить (active)
fan mission stop                              # Остановить (aborted, I0)
fan mission pause                             # Пауза (paused, I1 drain)
fan mission resume                            # Возобновить (active)
fan mission status                            # Текущий статус
fan mission tree <slug> [--format json] [--depth N]  # Дерево узлов
```

### Slash-команды (TUI)

| Команда | Прерывание | Описание |
|---------|-----------|----------|
| `/mission:start` | — | Запустить один тик цикла |
| `/mission:stop` | I0 | Немедленная остановка (abort) |
| `/mission:pause` | I1 | Пауза после текущего хода (drain) |
| `/mission:resume` | — | Возобновление после паузы |
| `/mission:steer "<msg>"` | I2 | Вставить направляющее сообщение |
| `/mission:decide "<answer>"` | I3 | Ответить на вопрос агента (DECIDE) |
| `/mission:status` | — | Показать статус, итерацию, бюджет, текущий шаг |

---

## Прерывания I0–I4

Система прерываний по аналогии с приоритетами операционной системы:

| Уровень | Имя | Механизм | Описание |
|---------|-----|----------|----------|
| **I0** | abort | `/mission:stop` | Немедленная остановка. Kill-switch, потеря текущего хода |
| **I1** | drain | `/mission:pause` | Завершить текущий ход, затем пауза. Файл `.mission-drain-flag` |
| **I2** | steer | `/mission:steer` | Вставить направляющее сообщение в очередь (`.mission-steer-queue.json`) |
| **I3** | followUp | `/mission:decide` | Ответ на DECIDE-вопрос агента (эскалация от promise-тега) |
| **I4** | tick | `mission_tick` (EventBus) | Плановый тик от scheduler. Replay-guard + dedup в `tick-bridge` |

**Механизм drain (I1):** файл `.mission-drain-flag` проверяется в начале `tick()`.
Если флаг установлен — цикл не начинает новую итерацию, записывает паузу в MISSION.md
и возвращает статус `paused`.

**Механизм steer (I2):** сообщения накапливаются в `.mission-steer-queue.json`
и передаются в `executor.runIteration({ steer })` на следующем тике.

---

## Promise-теги

Агент в ответе возвращает тег `<promise>TAG</promise>`, определяющий дальнейшее поведение:

| Тег | Поведение |
|-----|----------|
| `<promise>COMPLETE</promise>` | Итерация успешна → верификация → commit → следующий пункт |
| `<promise>BLOCKED: причина</promise>` | Пункт заблокирован → запись в блокеры STATE.md → следующий пункт |
| `<promise>DECIDE: вопрос</promise>` | Эскалация I3: миссия ждёт ответа оператора (`awaiting_decision`) |
| `<promise>FAILED: причина</promise>` | Итерация провалена → запись в метрики → следующий пункт |

**Правила парсинга** (`promise-parser.ts`):
- Теги внутри fenced code blocks (` ``` `) игнорируются
- При нескольких тегах — возвращается последний валидный
- `BLOCKED` без причины → reason = «не указана»
- Нет тега → статус `COMPLETE` (эскалация I3 — на усмотрение лестницы верификации)

---

## EPIC-делегирование и дерево узлов

### Маркер [EPIC] в ROADMAP

Пункт ROADMAP с маркером `[EPIC]` в начале делегируется супер-оркестратору:

```markdown
- [ ] [EPIC] Полная переработка auth middleware
```

### Процесс делегирования

1. **Декомпозиция** — `runAgent` с промптом декомпозиции → JSON-массив подзадач:
   ```json
   [
     {"task": "Рефакторинг token validation", "tokenBudget": 50000, "toolManifest": ["read", "write", "bash"]},
     {"task": "Добавить rate limiting", "tokenBudget": 30000, "toolManifest": ["read", "write", "bash"]},
     {"task": "Интеграционные тесты", "tokenBudget": 40000, "toolManifest": ["read", "bash"]}
   ]
   ```

2. **Событие `mission_delegate`** — mission-loop эмитит в EventBus с `correlationId`
   и массивом пакетов работ.

3. **Дерево L1** — `fan-super-orchestrator` порождает дочерние узлы `fan server`
   (L0 → N×L1), каждый получает пакет работ через REST.

4. **Синтез** — после завершения всех L1-узлов результаты агрегируются в текст
   итерации с тегом `<promise>COMPLETE</promise>`.

### Дерево узлов (иерархия)

```
L0 (корень, координатор)
├── L1/node-1 ✓ $0.45    (завершён)
├── L1/node-2 ✓ $0.30    (завершён)
│   └── L2/node-2.1 ✓ $0.12  (вложенный узел, глубина 3)
└── L1/node-3 ● $0.33    (активен)
```

**Параметры:**
- Рабочая глубина: до 4 уровней (настраивается через `maxWorkingDepth`)
- Инфраструктурный предохранитель: 12 (жёсткий предел, не конфигурируется)
- Рабочая ширина: до 4 детей на родителя (предохранитель — 12)
- Переменная окружения: `FAN_ORCHESTRATOR_DEPTH` — текущая глубина узла

### Протоколы

**Пакет работ (L0 → L1)** — `WorkPackage`:

| Поле | Описание |
|------|----------|
| `task` | Задание |
| `correlationId` | Формат: `<mission-id>/L<N>/node-<M>` |
| `depth` | Глубина узла |
| `tokenBudget` | Бюджет токенов |
| `costBudgetUsd` | Бюджет USD |
| `toolManifest` | Разрешённые инструменты |
| `deadline` | ISO-8601 дедлайн |
| `maxRetries` | Максимум ретраев (дефолт 2) |

**Отчёт узла (L1 → L0)** — `NodeReport`:

| Поле | Описание |
|------|----------|
| `nodeId` | Идентификатор узла |
| `correlationId` | Сквозная трассировка |
| `status` | completed / failed / aborted / timeout / unknown |
| `verdict` | PASS / FAIL / PARTIAL / null |
| `result` | Текст + файлы (модифицированные/созданные/коммиты) |
| `usage` | inputTokens, outputTokens, costUsd, turns, durationMs |
| `children` | Рекурсивные отчёты дочерних узлов |

---

## Манифесты инструментов

Манифест — allow-list имён инструментов на узел. Ограничивает возможности дочернего узла.

**Допустимые инструменты:** `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`,
`store_search`, `store_install`.

**Двухуровневый enforcement:**

1. **Fail-fast (L0, до spawn):** `validateManifest()` валидирует манифест;
   при ошибке — запись `tool_blocked` в tree-journal, узел не порождается.

2. **Рантайм-блок (дочерний узел):** манифест конвертируется в `--tools read,write,...`
   в argv `fan server`. Инструменты вне манифеста физически не регистрируются
   в сессии — LLM не может их вызвать.

**Пример:**

```json
{
  "toolManifest": ["read", "bash", "grep"]
}
```

Узел с таким манифестом может только читать файлы, выполнять команды и искать по содержимому.
Попытка `write` или `edit` невозможна — инструмент не зарегистрирован.

---

## Бюджеты

### Глобальный бюджет миссии

Задаётся в frontmatter `MISSION.md`:

```yaml
budget_tokens: 500000
budget_usd: 10.00
```

Двойной лимит (токены + USD): оба жёсткие и независимые, срабатывает первый достигнутый.
Значение `0` по измерению = лимит не действует (unlimited).

### Аллокация по дереву

Формула выделения бюджета дочернему узлу:

```
allocation = min(0.8 × remaining / planned_children, per_hop_ceiling)
```

- **Резерв 20%** остаётся родителю на синтез и ретраи
- **per_hop_ceiling** — потолок на ребёнка (дефолт 30 000 токенов)
- USD делится пропорционально с округлением до 4 знаков

Состояние хранится в `mission-budget.json` (атомарная запись: tmp → rename).
В одном файле — состояния нескольких миссий (ключ — `missionId`).

### Пороги алертов

| Порог | Действие |
|-------|----------|
| 80% | `onWarn` — I2 steer (предупреждение оператору) |
| 100% | `onExhausted` — I1 drain (остановка новых порождений) |

Каждый порог однократный в рамках экземпляра агрегатора.

### Бюджет на итерацию (F-46)

Дополнительный потолок на одну итерацию:

| Параметр | Дефолт | Описание |
|----------|--------|----------|
| `iterationBudgetTokens` | 100 000 | Максимум токенов на итерацию |
| `iterationBudgetUsd` | 5.00 | Максимум USD на итерацию |

При превышении — drain текущей итерации (завершить tool call, не начинать новый) +
запись `iteration_budget_exceeded` в tree-journal.

---

## Верификация

Лестница верификации (`verification-ladder.ts`) — 5 ступеней, выполняемых последовательно
после COMPLETE-итерации:

| Ступень | Команда | Таймаут | Обязательная |
|---------|---------|---------|-------------|
| typecheck | `npx tsgo --noEmit` | 120 с | ✅ |
| linters | `npx biome check .` | 60 с | ✅ |
| build | `npm run build` | 300 с | ✅ |
| tests | `npm test` | 600 с | ✅ |
| acceptance | `fan mission audit` | 120 с | ✅ |

Провал обязательной ступени останавливает лестницу. Результат влияет на commit:
при `passed: false` — пункт не отмечается выполненным.

---

## Наблюдаемость

### CLI: `fan mission tree <slug>`

Выводит ASCII-дерево узлов из `tree-journal.jsonl`:

```
Mission: auth-refactor
Status:  active
├── L0 (root) ✓ $1.20
│   ├── L1/node-1 ✓ $0.45
│   ├── L1/node-2 ✓ $0.30
│   │   └── L2/node-2.1 ✓ $0.12
│   └── L1/node-3 ● $0.33
└── Total: $1.20 / $10.00 (12%)
```

Иконки: ✓ completed, ● active, ✗ failed, ○ pending.

**Опции:**
- `--format json` — структурированный JSON для скриптов
- `--depth N` — ограничить глубину вывода

### REST API (F-47)

| Эндпоинт | Описание |
|----------|----------|
| `GET /api/missions/:id/status` | Статус миссии, frontmatter + сводка бюджета |
| `GET /api/missions/:id/tree` | Топология дерева из tree-journal.jsonl |
| `GET /api/missions/:id/budget` | Состояние бюджета (passthrough mission-budget.json) |

Все эндпоинты требуют аутентификацию (ClientToken). Несуществующий slug → 404.

### Dashboard-компоненты

| Компонент | Описание |
|-----------|----------|
| `<mission-tree>` | Дерево узлов в реальном времени (WS `mission_event`) |
| `<mission-status>` | Статус, итерация, расход, этап, активные узлы |
| `<mission-log>` | Живой журнал событий (последние 100, append-only) |
| `<mission-budget>` | Столбчатая диаграмма расхода по веткам |

Обновление через WS `mission_event` (spawn/complete/fail/abort) с задержкой <5 сек.

### TUI-виджет (F9)

Виджет статуса миссии в TUI (шорткат F9):

```
┌─ Миссия: auth-refactor ──────────────┐
│ Статус:    ● активна                  │
│ Итерация:  5                          │
│ Бюджет:    250 000 / 500 000 токенов  │
│            $3.45 / $10.00             │
│ Шаг:       iterate                    │
└───────────────────────────────────────┘
```

### Tree-journal (JSONL)

Журнал дерева (`tree-journal.jsonl`) — append-only, durable-запись (fsync):

```jsonl
{"timestamp":"2026-08-15T10:00:00Z","event":"spawn","nodeId":"L1/node-1","parentId":"L0","depth":1,"port":7001}
{"timestamp":"2026-08-15T10:05:00Z","event":"complete","nodeId":"L1/node-1","usage":{"tokens":45000,"usd":0.45}}
{"timestamp":"2026-08-15T10:01:00Z","event":"spawn","nodeId":"L1/node-2","parentId":"L0","depth":1,"port":7002}
```

**Типы событий:** spawn, complete, fail, abort, orphan_cleanup, tool_blocked, validation_failed.

---

## Автотик (scheduler → mission_tick)

Расширение `fan-scheduler` эмитит событие `mission_tick` в EventBus по cron-расписанию.
Модуль `tick-bridge` (fan-mission) подписывается и вызывает `MissionLoop.tick()`
программно, без LLM-промпта.

**Защитные механизмы tick-bridge:**

1. **Replay-guard** — события с `ts <= armedAt` (момент подписки) игнорируются
2. **Dedupe** — повторная доставка того же `tickId` игнорируется
3. **Нет активного loop** — тихий игнор
4. **Чужой missionDir** — игнор (если в событии задан другой каталог)
5. **Lock is busy** — штатная ситуация (предыдущий tick ещё работает)

---

## Webhook

Расширение `fan-webhook` — Hono-сервер для внешних прерываний I2/I3:

```bash
# Запуск (авто-подбор порта 9090–9110)
# Порт настраивается через FAN_WEBHOOK_PORT

# Steer (I2)
curl -X POST http://localhost:9090/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "steer", "message": "Сосредоточься на тестах"}'

# FollowUp / DECIDE (I3)
curl -X POST http://localhost:9090/webhook \
  -H "Content-Type: application/json" \
  -d '{"type": "followUp", "message": "Используем JWT вместо session"}'

# Health check
curl http://localhost:9090/health
```

**Ответы:** 200 `{ ok: true }` при успехе, 400 — невалидный запрос, 500 — внутренняя ошибка.

---

## Troubleshooting

### Порт webhook занят

**Симптом:** `Error: listen EADDRINUSE :::9090`

**Решение:** `fan-webhook` автоматически подбирает порт (9090 → 9091 → ... → 9110).
Если все 21 порт заняты — задайте `FAN_WEBHOOK_PORT=<свободный порт>` явно.

### Budget exceeded

**Симптом:** миссия переходит в `budget_exhausted`, новые порождения остановлены.

**Решение:**
1. Проверьте расход: `fan mission tree <slug>` — какая ветка потребляет больше.
2. Увеличьте бюджет в `MISSION.md`: `budget_usd: 20.00`.
3. Проверьте `mission-budget.json` — аллокации активных узлов.

### DECIDE — миссия ждёт ответа

**Симптом:** статус `awaiting_decision`, цикл остановлен.

**Решение:**
```bash
# В TUI:
/mission:decide "Используем JWT-токены с refresh"

# Через webhook:
curl -X POST http://localhost:9090/webhook \
  -d '{"type": "followUp", "message": "Используем JWT-токены с refresh"}'
```

Если ответ не поступит в течение 1 часа (настраивается `decideTimeoutMs`) — миссия
перейдёт в `aborted`.

### Lock is busy

**Симптом:** `Error: Lock is busy — concurrent tick not allowed`

**Решение:** предыдущий `tick()` ещё выполняется. Дождитесь завершения или удалите
`.mission-loop.lock` вручную (если процесс мёртв — lock stale, снимается автоматически
через 60 секунд).

### tool_blocked — инструмент не в манифесте

**Симптом:** в tree-journal запись `tool_blocked`, дочерний узел не может вызвать инструмент.

**Решение:** расширьте `toolManifest` в пакете работ. Допустимые имена:
`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `store_search`, `store_install`.

### depth_exceeded — превышена глубина

**Симптом:** в tree-journal запись `depth_exceeded`, узел не порождён.

**Решение:** увеличьте `maxWorkingDepth` (дефолт 4) в конфигурации или уменьшите
глубину декомпозиции. Инфраструктурный предохранитель 12 не поднимается.

### STATE.md переполнен

**Симптом:** миссия переходит в `failed` — «STATE.md overflow».

**Решение:** автоматически архивирует старые выполненные пункты (keep=10). Если
архивирование невозможно — уменьшите STATE.md вручную. Лимит: 5 КБ.

---

## Примеры

См. готовые шаблоны миссий:

- [Пример: рефакторинг с EPIC-делегированием](./examples/mission-refactor.md)
- [Пример: иерархия дерева из 3 L1-узлов](./examples/mission-tree-hierarchy.md)

---

## Ссылки

- Спецификация: `docs/specs/spec_super-orchestrator_v3_2026-08-10.md`
- Roadmap этапа 0: `docs/features/super-orchestrator/mission-loop-0/roadmap.md`
- Roadmap этапа 1: `docs/features/super-orchestrator/mission-validation-1/roadmap.md`
- Roadmap этапа 2: `docs/features/super-orchestrator/http-hierarchy-2/roadmap.md`
- Roadmap этапа 3: `docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md`
- API Reference: `docs/guides/api-reference.md`
