---
name: feature-factory
description: >
  Полный цикл разработки фичи от описания до закоммиченного кода в одном запуске:
  исследование и спецификация (docs/specs/), TDD-роадмапа (docs/features/<slug>/roadmap.md),
  TDD-пайплайн Red-Green-Refactor с воркерами delegate_task. ЕДИНЫЙ kickoff-опрос на старте
  (≤ 12 вопросов, табы «Скоуп»/«Роадмапа»/«Пайплайн») собирает все решения на будущее;
  после kickoff — ноль вопросов до конца пайплайна, любые развилки решаются по decisions.json.
  Конфиг (.fan/feature-factory.json) — только общие настройки реализации, никаких вопросов
  и вариантов ответов в нём нет. Ответы kickoff персистятся в
  .fan/feature-factory/<slug>/decisions.json (resumable: полный decisions — опрос не
  повторяется). Спека и роадмапа рендерятся в HTML и проходят Lavish-аппрув
  (playbook → HTML → open → poll → правки → снова). Resumable: запуск по описанию фичи,
  пути к спеке или пути к roadmap продолжает с нужной фазы. Используйте, когда нужен
  полный цикл разработки фичи: спецификация, роадмапа, TDD-пайплайн — от идеи до реализации.
compatibility: "TaskCreate, TaskUpdate, list_tasks, TaskClear, delegate_task, read, write, edit, bash, question, questionnaire, memory_search, web_search, web_reader, lavish"
metadata:
  author: "FAN Team"
  version: "1.3.0"
  changelog: "v1.3.0 (2026-09-04): Фаза 0 автосоздаёт .fan/feature-factory.json копией дефолта, если конфига нет; fallback — дефолт пакета при ошибке записи. v1.2.0 (2026-09-04): baseline-коммит после апрува роадмапы (точка начала разработки); скилл больше не создаёт веток — работа в текущей ветке оператора, проверка защищённых веток (dev/develop/master/main/trunk) с предупреждением. v1.1.0 (2026-09-04): вопросы вынесены из конфига в единый kickoff-опрос на старте; конфиг — только общие настройки реализации; решения персистятся в .fan/feature-factory/<slug>/decisions.json (resumable). v1.0.0 (2026-09-04): initial release — unified spec→roadmap→pipeline"
---

# feature-factory — полный цикл фичи: спека → роадмапа → pipeline

## Обзор

Один запуск `/skill:feature-factory <аргумент>` покрывает весь цикл разработки фичи.
Точка входа определяется по аргументу (resumable):

| Аргумент | Пример | Стартовая фаза |
|----------|--------|----------------|
| Описание фичи (свободный текст, нет `/` и `.md`) | `уведомления в реальном времени` | Фаза 1 (Kickoff) |
| Путь к спеке (`docs/specs/spec_*.md`) | `docs/specs/spec_notifications_2026-09-04.md` | Фаза 4 (Роадмапа) |
| Путь к roadmap (`docs/features/<slug>/roadmap.md`) | `docs/features/notifications/roadmap.md` | Фаза 6 (Pipeline) |

Правила определения:

1. Аргумент содержит `/` и заканчивается на `.md` → путь к файлу. Файл в `docs/specs/` → Фаза 4; файл `roadmap.md` в `docs/features/` → Фаза 6.
2. Иначе → свободное описание → Фаза 1.
3. Без аргумента: `find docs/specs/ docs/features/ -name '*.md'` — если найден один свежий артефакт, продолжить с соответствующей фазы и сообщить об этом в чат; если несколько — продолжить с самого свежего по дате в имени файла (уведомление в чат); если ни одного — остановка с отчётом (запуск без описания фичи невозможен).

**Kickoff обязателен при любом старте:** если стартовая фаза ≥ 2 (путь к спеке или roadmap) и `.fan/feature-factory/<slug>/decisions.json` отсутствует или неполон — сначала Фаза 1 (Kickoff), затем целевая фаза. Slug берётся из аргумента/пути.

Пропущенные фазы считаются выполненными: их артефакты уже существуют. Если запрошенная
фаза невозможна (например, Фаза 6, а roadmap пуст или отсутствует) — остановка с отчётом.

## Фаза 0: Конфигурация

1. Проверить `.fan/feature-factory.json` в корне проекта. Существует — читать его. НЕ существует — **создать**: `mkdir -p .fan/` (при необходимости) и скопировать `config/default.json` из пакета скилла в `.fan/feature-factory.json` (все поля, значения по умолчанию, валидный JSON). **Уведомить в чат** (НЕ вопрос): «Проектный конфиг .fan/feature-factory.json отсутствовал — создан с настройками по умолчанию. Отредактируйте под проект (см. references/config-schema.md) — изменения подхватятся при следующих запусках».
2. Fallback: если создать файл не удалось (ошибка записи/права) — работать с `config/default.json` из пакета, уведомить в чат («Не удалось создать .fan/feature-factory.json — использую config/default.json из пакета») и продолжить.
3. Deep merge: проектный конфиг (свежесозданный или существующий) + дефолт пакета, проектный > дефолт. Объекты сливаются рекурсивно, **массивы заменяются целиком**. Проектный файл может отставать от дефолта при обновлении скилла — недостающие поля добираются из дефолта. Невалидный JSON override → остановка с отчётом.
4. **Конфиг — только общие настройки реализации** (исследование, лимиты, финальные проверки, lavish-аппрув). Решения по конкретной фиче в конфиге НЕ хранятся: они собираются единым kickoff-опросом (Фаза 1) и персистятся в `.fan/feature-factory/<slug>/decisions.json`. Детали каждого поля: [`references/config-schema.md`](references/config-schema.md).
5. **Проверка текущей ветки**: `git branch --show-current` (если не git-репозиторий — остановка с отчётом, как при любой блокирующей ошибке). Если текущая ветка ∈ {`dev`, `develop`, `master`, `main`, `trunk`} (case-insensitive) — 💬 предупреждение в чат: «Текущая ветка <имя> — защищённая. Разработка должна вестись в рабочей ветке, созданной ДО запуска. Продолжаю — ответственность на операторе» — и продолжить (НЕ вопрос, НЕ остановка). Скилл ветки не создаёт и не переключает: вся разработка ведётся в текущей ветке оператора.

## Фаза 1: Kickoff — исследование и единый опрос

Единственная фаза, где пользователю задаются вопросы. Всё остальное время — ноль вопросов.

1. **Определить slug**: kebab-case из описания фичи (например, `notification-system`) или из пути (resumable).
2. **Resumable-проверка**: если `.fan/feature-factory/<slug>/decisions.json` существует и содержит все секции (`slug`, `scope`, `roadmap`, `pipeline`, `specAnswers`) — kickoff **пропускается** (уведомление в чат, опрос не повторяется), переход к целевой фазе.
3. **Лёгкое исследование** по `config.spec.research` (memory → файлы проекта → web): цель — собрать контекст, достаточный для формирования контекстных вопросов таба «Скоуп».
4. **Единый kickoff-опрос** — ОДИН вызов `questionnaire` с таб-навигацией, суммарно ≤ 12 вопросов:

   **Таб «Скоуп»** (3–5 контекстных вопросов — агент формирует сам ПОСЛЕ исследования; единственное место импровизированных вопросов):
   - границы/скоуп фичи (что входит, что не входит);
   - критерии успеха (измеримые);
   - ограничения/зависимости (технические, сроковые, интеграционные);
   - целевые пользователи.

   **Таб «Роадмапа»** (2 вопроса — темы фиксированы, агент не вправе их забыть или заменить):

   | # | Решение | Варианты | Пропуск → |
   |---|---------|----------|-----------|
   | 1 | Стратегия этапов | `mvp-first` (MVP → Расширение → Полировка) / `core-integration` (Ядро → Интеграция → Продвинутые) / свой вариант (свободный ввод) | `mvp-first` |
   | 2 | При превышении лимита этапов (`config.roadmap.maxStages`) | `delegate` (делегировать разбиение plan-воркеру, остановка с отчётом) / `truncate` (сократить до лимита, остальное в «Отложено») / `warn` (продолжить с предупреждением) | `delegate` |

   **Таб «Пайплайн»** (4 вопроса — темы фиксированы):

   | # | Решение | Варианты | Пропуск → |
   |---|---------|----------|-----------|
   | 1 | Стратегия коммитов | `per-function` / `per-phase` / `manual` (авто-коммитов нет, только финальный) / `none` (без коммитов) | `per-function` |
   | 2 | Контрольные точки/остановки | `on-error` / `per-function` / `per-stage` / `end-only` | `on-error` |
   | 3 | Исчерпание verify-ретраев (фиксированные 3 попытки) | `abort` (остановка с отчётом) / `skip` (пометить функцию ❌, продолжить) | `abort` |
   | 4 | FAIL phase-gate | `stop` (остановка с отчётом) / `continue` (продолжить, долг фиксируется в отчёте) | `stop` |

   Для необязательных вопросов добавляется опция `{ value: "skip", label: "Пропустить" }`; пропуск фиксирует безопасный дефолт из таблицы. Обязательные темы всех табов фиксируются здесь, в SKILL.md.
5. **Сохранить `.fan/feature-factory/<slug>/decisions.json`** (`mkdir -p .fan/feature-factory/<slug>/`):

   ```json
   {
     "slug": "<slug>",
     "createdAt": "<ISO 8601>",
     "scope": {
       "boundaries": "<границы/скоуп>",
       "successCriteria": "<критерии успеха>",
       "constraints": "<ограничения/зависимости>",
       "targetUsers": "<целевые пользователи>"
     },
     "roadmap": { "stageStrategy": "mvp-first", "onStageLimitExceeded": "delegate" },
     "pipeline": { "commitStrategy": "per-function", "controlPoints": "on-error", "onMaxRetriesExceeded": "abort", "phaseGateFail": "stop" },
     "specAnswers": { "<questionId>": "<сырой ответ>", "...": "..." }
   }
   ```

   - `scope` — нормализованные решения по скоупу (агент приводит ответы к 4 каноническим полям; без ответа — пустая строка + обоснованное допущение с пометкой `(assumption)`);
   - `roadmap` / `pipeline` — решения табов (пропущенные — безопасные дефолты из таблиц);
   - `specAnswers` — сырые ответы на контекстные вопросы таба «Скоуп» (ключи = id вопросов).
6. Переход к Фазе 2 (или к целевой фазе при resumable-старте с середины).

## Фаза 2: Спецификация

> Детали: [`references/spec-phase.md`](references/spec-phase.md)

- Исследование продолжается/углубляется по `config.spec.research` (качество раунда ≥ `config.spec.research.minQuality`); лёгкое исследование Фазы 1 — база.
- Тип запроса — автоматически по `config.spec.autoDetectType` (типы — фиксированная логика скилла); уведомление в чат.
- Ответы kickoff — из `decisions.scope` / `decisions.specAnswers` (не спрашиваются повторно).
- Генерация `docs/specs/spec_<slug>_<YYYY-MM-DD>.md` по [`references/spec-template.md`](references/spec-template.md) — со структурированной секцией «Функции» (приоритет P0-P3 или MoSCoW, слой API/UI/storage/model/…), чтобы роадмапа не парсила эвристиками.

## Фаза 3: Lavish-аппрув спеки

> Детали: [`references/lavish-approval.md`](references/lavish-approval.md)

- Выполняется при `config.lavish.specApproval.enabled: true`; при `false` — уведомление в чат и продолжение.
- Цикл: `lavish({command:"playbook", playbook_id: config.lavish.specApproval.playbook})` **до** HTML → рендер HTML из [`templates/spec-preview.html`](templates/spec-preview.html) в `.fan/feature-factory/<slug>/spec-preview.html` → `open` → **poll-цикл до явного аппрува**: `layout_warnings` → fix → re-poll; `prompts` → правки интегрируются в markdown-спеку → перерендер → re-poll; `status:"ended"` → стоп.
- Лимит итераций доработки — `config.lavish.maxRevisions`. Продолжение без аппрува при `enabled: true` запрещено.

## Фаза 4: Роадмапа

> Детали: [`references/roadmap-phase.md`](references/roadmap-phase.md)

- Парсинг спеки: функции из структурированной секции «Функции» → ID `F-X.Y`.
- Приоритеты — из спеки по **фиксированному** маппингу MoSCoW → P0-P3 (формат скилла, не настройка; таблица в roadmap-phase.md).
- Этапы — по `decisions.roadmap.stageStrategy`; превышение лимита этапов → `decisions.roadmap.onStageLimitExceeded`. Пробелы в спеке → вывод с пометкой `<!-- inferred -->` и блоком «Допущения» (фиксированное поведение).
- Лимиты: `config.roadmap.maxStages` / `maxFunctions` / `functionsPerStage`.
- Генерация `docs/features/<slug>/roadmap.md`: чекбокс-карточки функций с TDD-тестами `TC-F-X.Y-N`, Red-тест, Refactor-цели, критерии приёмки; у каждого этапа — **E2E-сценарий** и **Smoke-критерий** (обязательные поля для pipeline phase-gate).

## Фаза 5: Lavish-аппрув роадмапы

> Детали: [`references/lavish-approval.md`](references/lavish-approval.md)

- Аналогично Фазе 3: `config.lavish.roadmapApproval` + [`templates/roadmap-preview.html`](templates/roadmap-preview.html) → `.fan/feature-factory/<slug>/roadmap-preview.html`.
- Правки из poll-фидбека интегрируются в `docs/features/<slug>/roadmap.md` (markdown — источник истины), затем перерендер и re-poll. Лимит итераций — `config.lavish.maxRevisions`. Продолжение без аппрува при `enabled: true` запрещено.

### Baseline-коммит точки начала разработки

После успешного аппрува роадмапы (или сразу после Фазы 4, если `config.lavish.roadmapApproval.enabled: false`), и если `decisions.pipeline.commitStrategy ≠ none`:

1. `git add` **явным списком** артефактов планирования: `docs/specs/spec_<slug>_<YYYY-MM-DD>.md`, `docs/features/<slug>/roadmap.md` (плюс прочие появившиеся docs-артефакты планирования).
2. Коммит: `docs(<slug>): planning baseline (spec + roadmap approved)` — это формат MESSAGE, не ветка; ветка не создаётся и не переключается.
3. SHA baseline запомнить (в decisions.json НЕ писать — файл процессный, некоммитится; SHA фиксируется в pipeline-report.md как точка отсчёта dev-диффа).
4. При `commitStrategy: none` — baseline-коммит не делается вовсе (нет коммитов — нет baseline).
5. **Resumable/idempotency**: при resumable-старте, если артефакты планирования уже закоммичены (`git status` чист по этим путям) — baseline пропускается; если не закоммичены (untracked/modified) — baseline выполняется перед Фазой 6.

Разработка после baseline идёт в текущей ветке оператора: скилл ветки не создаёт и не переключает (жёсткое правило 7).

## Фаза 6: Pipeline (TDD-реализация)

> Детали: [`references/pipeline-phase.md`](references/pipeline-phase.md)

- TDD-цикл на каждую функцию roadmap, каждый шаг — отдельный `delegate_task` воркеру:
  **Red** (tests-impl: failing-тесты по TC-F-X.Y-N, подтверждённый FAIL) → **Green** (implement: минимальная реализация) → **verify** (независимый adversarial-воркер) → **bug-fix** при FAIL (фиксированные 3 попытки) → **Refactor** (implement, по Refactor-целям, только при зелёных тестах) → **commit** по `decisions.pipeline.commitStrategy`.
- Исчерпание ретраев → `decisions.pipeline.onMaxRetriesExceeded`; контрольные точки → `decisions.pipeline.controlPoints` (координатор вопросов не задаёт).
- **Phase-gate** на границах этапов: Smoke-критерий + E2E-сценарий этапа из roadmap; FAIL → `decisions.pipeline.phaseGateFail` (`stop` — остановка с отчётом / `continue` — продолжить с фиксацией долга).
- Финальная фаза G: полная верификация (G.1), **G.1.5 code-review** (`config.pipeline.codeReview`), **G.1.6 security-аудит** (`config.pipeline.securityAudit`), smoke (G.2), e2e (G.3), документация (G.4, `config.pipeline.docsUpdate`), финальный коммит (G.6), отчёт (G.7).

## Фаза 7: Финал

- `pipeline-report.md` в `docs/features/<slug>/` — сводка: SHA baseline-коммита (точка отсчёта dev-диффа), таблица функций (статус, коммиты, тесты, попытки), верификация, code-review/security findings, изменённые файлы, документация, технический долг (если `phaseGateFail: continue` или были `skip`), рекомендации.
- Краткая сводка в чат: что сделано, где артефакты, как продолжить при остановке. Финального вопроса пользователю нет.

## ЖЁСТКИЕ ПРАВИЛА (анти-паттерны)

1. **Вопросы пользователю возможны ТОЛЬКО в Фазе 1 (Kickoff) — одним вызовом `questionnaire`.** Контекстные вопросы таба «Скоуп» агент генерирует сам после исследования — это единственное место импровизированных вопросов; темы табов «Роадмапа»/«Пайплайн» фиксированы в SKILL.md. Вне kickoff `question` для уточнений (типа запроса, приоритетов, стратегии коммитов, «что дальше») не используется. Уведомления в чат — не вопросы. Единственное ожидание реплики вне kickoff — подтверждение аппрува в чате после `status:"ended"` (см. references/lavish-approval.md) — и это констатация состояния, а не вопрос.
2. **После kickoff — ноль вопросов до конца пайплайна.** Любые развилки (стратегия этапов, превышение лимитов, коммиты, контрольные точки, ретраи, FAIL gate) решаются по `decisions.json`. Отсутствующий или незаполненный ключ → **безопасный дефолт** (`stageStrategy: mvp-first`, `onStageLimitExceeded: delegate`, `commitStrategy: per-function`, `controlPoints: on-error`, `onMaxRetriesExceeded: abort`, `phaseGateFail: stop`, verify-ретраи = 3) **+ запись в отчёт, НЕ вопрос**.
3. **ЗАПРЕЩЕНО продолжать без аппрува спеки/роадмапы при `enabled: true`.** Нет явного аппрува → нет перехода к следующей фазе; остановка с отчётом — допустимый исход.
4. **ЗАПРЕЩЕНО пропускать playbook перед HTML и poll после open.** Порядок цикла lavish: playbook → HTML → open → poll. Нарушение порядка ломает аппрув.
5. **ЗАПРЕЩЕНО править markdown-артефакты без обратной синхронизации правок из Lavish-фидбека.** Правка только HTML-превью (без markdown) запрещена: markdown — источник истины, HTML — его рендер. Правка markdown без перерендера тоже запрещена.
6. **Остановка с отчётом — валидный исход.** При `onMaxRetriesExceeded: abort` (из decisions), исчерпании `config.lavish.maxRevisions` итераций Lavish-доработки, `onStageLimitExceeded: delegate` (из decisions), пустых артефактах — остановиться и отчитаться (статус, причина, артефакты, как продолжить), а не «дожимать» самостоятельно.
7. **Скилл никогда не создаёт и не переключает ветки.** Разработка ведётся в текущей ветке оператора; при защищённой ветке (dev/develop/master/main/trunk) — предупреждение и продолжение. Формат сообщений коммитов `feat(<slug>/F-X.Y): ...` — это формат MESSAGE, а не ветка.

## Артефакты

| Артефакт | Путь | Фаза |
|----------|------|------|
| Решения kickoff | `.fan/feature-factory/<slug>/decisions.json` | 1 |
| Спецификация | `docs/specs/spec_<slug>_<YYYY-MM-DD>.md` | 2 |
| Превью спеки (Lavish) | `.fan/feature-factory/<slug>/spec-preview.html` | 3 |
| Роадмапа | `docs/features/<slug>/roadmap.md` | 4 |
| Превью роадмапы (Lavish) | `.fan/feature-factory/<slug>/roadmap-preview.html` | 5 |
| Baseline-коммит | git SHA после апрува роадмапы (точка отсчёта dev-диффа, фиксируется в pipeline-report.md) | 5 |
| Код, тесты, коммиты | текущая ветка (создаётся пользователем до запуска) | 6 |
| Отчёт pipeline | `docs/features/<slug>/pipeline-report.md` | 6 (G.7) / 7 |
| Рабочие артефакты (с orchestrator) | `docs/development-plan.md`, `docs/development-log.md`, `.fan/tracking/phase-status.json` | 6 |
| Конфиг | `.fan/feature-factory.json` (override), `config/default.json` (дефолт пакета) | 0 |
