---
name: feature-factory
description: >
  Полный цикл разработки фичи от описания до закоммиченного кода в одном запуске:
  исследование и спецификация (docs/specs/), TDD-роадмапа (docs/features/<slug>/roadmap.md),
  TDD-пайплайн Red-Green-Refactor с воркерами delegate_task. Интервью строго по вопросам
  из конфига (.fan/feature-factory.json) — никаких импровизированных вопросов. Спека и
  роадмапа рендерятся в HTML и проходят Lavish-аппрув (playbook → HTML → open → poll →
  правки → снова) — единственная интерактивность. Resumable: запуск по описанию фичи,
  пути к спеке или пути к roadmap продолжает с нужной фазы. Используйте, когда нужен
  полный цикл разработки фичи: спецификация, роадмапа, TDD-пайплайн — от идеи до реализации.
compatibility: "TaskCreate, TaskUpdate, list_tasks, TaskClear, delegate_task, read, write, edit, bash, question, questionnaire, memory_search, web_search, web_reader, lavish"
metadata:
  author: "FAN Team"
  version: "1.0.0"
  changelog: "v1.0.0 (2026-09-04): initial release — unified spec→roadmap→pipeline"
---

# feature-factory — полный цикл фичи: спека → роадмапа → pipeline

## Обзор

Один запуск `/skill:feature-factory <аргумент>` покрывает весь цикл разработки фичи.
Точка входа определяется по аргументу (resumable):

| Аргумент | Пример | Стартовая фаза |
|----------|--------|----------------|
| Описание фичи (свободный текст, нет `/` и `.md`) | `уведомления в реальном времени` | Фаза 1 (Спецификация) |
| Путь к спеке (`docs/specs/spec_*.md`) | `docs/specs/spec_notifications_2026-09-04.md` | Фаза 3 (Роадмапа) |
| Путь к roadmap (`docs/features/<slug>/roadmap.md`) | `docs/features/notifications/roadmap.md` | Фаза 5 (Pipeline) |

Правила определения:

1. Аргумент содержит `/` и заканчивается на `.md` → путь к файлу. Файл в `docs/specs/` → Фаза 3; файл `roadmap.md` в `docs/features/` → Фаза 5.
2. Иначе → свободное описание → Фаза 1.
3. Без аргумента: `find docs/specs/ docs/features/ -name '*.md'` — если найден один свежий артефакт, продолжить с соответствующей фазы и сообщить об этом в чат; если несколько — продолжить с самого свежего по дате в имени файла (уведомление в чат); если ни одного — остановка с отчётом (запуск без описания фичи невозможен).

Пропущенные фазы считаются выполненными: их артефакты уже существуют. Если запрошенная
фаза невозможна (например, Фаза 5, а roadmap пуст или отсутствует) — остановка с отчётом.

## Фаза 0: Конфигурация

1. Прочитать `.fan/feature-factory.json` в корне проекта. Если файла нет — прочитать `config/default.json` из пакета скилла и **уведомить в чат**: «Проектный конфиг не найден, используется дефолтный». Отсутствие конфига — НЕ вопрос пользователю.
2. Deep merge: проектный override > дефолт. Объекты сливаются рекурсивно, **массивы заменяются целиком**. Невалидный JSON override → остановка с отчётом.
3. **Все дальнейшие параметры — только из активного конфига.** Детали каждого поля: [`references/config-schema.md`](references/config-schema.md).

## Фаза 1: Спецификация

> Детали: [`references/spec-phase.md`](references/spec-phase.md)

- Исследование по `config.spec.research` (memory → файлы проекта → web), качество раунда ≥ `config.spec.research.minQuality`.
- Тип запроса — автоматически по `config.spec.autoDetectType` из `config.spec.requestTypes`.
- Интервью **СТРОГО** вопросами из `config.spec.interview.rounds[]` через `questionnaire`: ≤ `maxQuestionsPerRound` за раунд; `trigger: "always"` выполняется всегда, `"on_gaps"` — только при оставшихся пробелах; `required: true` — без опции skip. Динамические вопросы запрещены.
- Генерация `docs/specs/spec_<slug>_<YYYY-MM-DD>.md` по [`references/spec-template.md`](references/spec-template.md) — со структурированной секцией «Функции» (приоритет P0-P3 или MoSCoW, слой API/UI/storage/model/…), чтобы роадмапа не парсила эвристиками.
- MoSCoW → P0-P3 формализуется через `config.roadmap.priorityMapping`.

## Фаза 2: Lavish-аппрув спеки

> Детали: [`references/lavish-approval.md`](references/lavish-approval.md)

- Выполняется при `config.lavish.specApproval.enabled: true`; при `false` — уведомление в чат и продолжение.
- Цикл: `lavish({command:"playbook", playbook_id: config.lavish.specApproval.playbook})` **до** HTML → рендер HTML из [`templates/spec-preview.html`](templates/spec-preview.html) в `.fan/feature-factory/<slug>/spec-preview.html` → `open` → **poll-цикл до явного аппрува**: `layout_warnings` → fix → re-poll; `prompts` → правки интегрируются в markdown-спеку → перерендер → re-poll; `status:"ended"` → стоп.
- Продолжение без аппрува при `enabled: true` запрещено.

## Фаза 3: Роадмапа

> Детали: [`references/roadmap-phase.md`](references/roadmap-phase.md)

- Парсинг спеки: функции из структурированной секции «Функции» → ID `F-X.Y`.
- Этапы — по `config.roadmap.defaultStrategy` (без опроса), приоритеты — из спеки через `config.roadmap.priorityMapping` (Must→P0, Should→P1, Could→P2, Won't→exclude).
- Лимиты: `config.roadmap.maxStages` / `maxFunctions` / `functionsPerStage`; превышение лимита этапов → `config.roadmap.onStageLimitExceeded` (`delegate` — делегировать разбиение plan-воркеру и остановиться с отчётом). Пробелы в спеке → `config.roadmap.onMissingSpecFields`.
- Генерация `docs/features/<slug>/roadmap.md`: чекбокс-карточки функций с TDD-тестами `TC-F-X.Y-N`, Red-тест, Refactor-цели, критерии приёмки; у каждого этапа — **E2E-сценарий** и **Smoke-критерий** (обязательные поля для pipeline phase-gate).

## Фаза 4: Lavish-аппрув роадмапы

> Детали: [`references/lavish-approval.md`](references/lavish-approval.md)

- Аналогично Фазе 2: `config.lavish.roadmapApproval` + [`templates/roadmap-preview.html`](templates/roadmap-preview.html) → `.fan/feature-factory/<slug>/roadmap-preview.html`.
- Правки из poll-фидбека интегрируются в `docs/features/<slug>/roadmap.md` (markdown — источник истины), затем перерендер и re-poll. Продолжение без аппрува при `enabled: true` запрещено.

## Фаза 5: Pipeline (TDD-реализация)

> Детали: [`references/pipeline-phase.md`](references/pipeline-phase.md)

- TDD-цикл на каждую функцию roadmap, каждый шаг — отдельный `delegate_task` воркеру:
  **Red** (tests-impl: failing-тесты по TC-F-X.Y-N, подтверждённый FAIL) → **Green** (implement: минимальная реализация) → **verify** (независимый adversarial-воркер) → **bug-fix** при FAIL (≤ `config.pipeline.maxVerifyRetries`) → **Refactor** (implement, по Refactor-целям, только при зелёных тестах) → **commit** по `config.pipeline.commitStrategy`.
- Контрольные точки — режим уведомлений из `config.pipeline.controlPoints`; координатор вопросов не задаёт.
- **Phase-gate** на границах этапов по `config.pipeline.phaseGate: auto`: Smoke-критерий + E2E-сценарий этапа из roadmap; FAIL → bug-fix до зелёного.
- Финальная фаза G: полная верификация (G.1), **G.1.5 code-review** (`config.pipeline.codeReview`), **G.1.6 security-аудит** (`config.pipeline.securityAudit`), smoke (G.2), e2e (G.3), документация (G.4, `config.pipeline.docsUpdate`), финальный коммит (G.6), отчёт (G.7).
- Исчерпание попыток → `config.pipeline.onMaxRetriesExceeded` (`abort` = остановка с отчётом — валидный исход).

## Фаза 6: Финал

- `pipeline-report.md` в `docs/features/<slug>/` — сводка: таблица функций (статус, коммиты, тесты, попытки), верификация, code-review/security findings, изменённые файлы, документация, рекомендации.
- Краткая сводка в чат: что сделано, где артефакты, как продолжить при остановке. Финального вопроса пользователю нет.

## ЖЁСТКИЕ ПРАВИЛА (анти-паттерны)

1. **ЗАПРЕЩЕНО задавать пользователю любые вопросы, кроме описанных в активном конфиге.** Единственные интерактивные инструменты в обычном потоке — `questionnaire` с вопросами из `config.spec.interview` (Фаза 1). `question` для импровизированных уточнений (типа запроса, приоритетов, стратегии коммитов, «что дальше») не используется. Уведомления в чат — не вопросы. Единственное ожидание реплики вне конфига — подтверждение аппрува в чате после `status:"ended"` (см. references/lavish-approval.md) — и это констатация состояния, а не вопрос.
2. **ЗАПРЕЩЕНО продолжать без аппрува спеки/роадмапы при `enabled: true`.** Нет явного аппрува → нет перехода к следующей фазе; остановка с отчётом — допустимый исход.
3. **ЗАПРЕЩЕНО пропускать playbook перед HTML и poll после open.** Порядок цикла lavish: playbook → HTML → open → poll. Нарушение порядка ломает аппрув.
4. **ЗАПРЕЩЕНО править markdown-артефакты без обратной синхронизации правок из Lavish-фидбека.** Правка только HTML-превью (без markdown) запрещена: markdown — источник истины, HTML — его рендер. Правка markdown без перерендера тоже запрещена.
5. **Остановка с отчётом — валидный исход.** При `onMaxRetriesExceeded: abort`, исчерпании 5 итераций Lavish-доработки, `onStageLimitExceeded: delegate/abort`, пустых артефактах — остановиться и отчитаться (статус, причина, артефакты, как продолжить), а не «дожимать» самостоятельно.

## Артефакты

| Артефакт | Путь | Фаза |
|----------|------|------|
| Спецификация | `docs/specs/spec_<slug>_<YYYY-MM-DD>.md` | 1 |
| Превью спеки (Lavish) | `.fan/feature-factory/<slug>/spec-preview.html` | 2 |
| Роадмапа | `docs/features/<slug>/roadmap.md` | 3 |
| Превью роадмапы (Lavish) | `.fan/feature-factory/<slug>/roadmap-preview.html` | 4 |
| Код, тесты, коммиты | ветка `feature/<slug>` | 5 |
| Отчёт pipeline | `docs/features/<slug>/pipeline-report.md` | 5 (G.7) / 6 |
| Рабочие артефакты (с orchestrator) | `docs/development-plan.md`, `docs/development-log.md`, `.fan/tracking/phase-status.json` | 5 |
| Конфиг | `.fan/feature-factory.json` (override), `config/default.json` (дефолт пакета) | 0 |
