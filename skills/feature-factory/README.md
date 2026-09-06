# feature-factory

## Описание

Полный цикл разработки фичи от описания до закоммиченного кода в одном запуске.
Объединяет три скилла в конвейер: **research-spec-generator** (спецификация) →
**feature-roadmap** (TDD-роадмапа) → **feature-pipeline** (TDD-реализация Red-Green-Refactor).

Ключевые принципы:

- **Один kickoff-опрос на старте.** Единый `questionnaire` (табы «Скоуп»/«Роадмапа»/«Пайплайн»,
  суммарно ≤ 12 вопросов) собирает все решения на будущее: скоуп фичи, стратегию этапов,
  коммиты, контрольные точки, поведение при ретраях и FAIL phase-gate. После kickoff —
  **ноль вопросов** до конца пайплайна.
- **Решения персистятся.** Ответы kickoff + заполненные дефолты сохраняются в
  `.fan/feature-factory/<slug>/decisions.json`. Resumable: полный decisions — опрос не
  повторяется; запуск с середины (спека/roadmap) — kickoff проводится до целевой фазы,
  если решений ещё нет.
- **Конфиг — только общие настройки.** Никаких вопросов и вариантов ответов в
  `.fan/feature-factory.json`: исследование, лимиты, финальные проверки, lavish-аппрув.
- **Lavish-аппрув.** Спека и роадмапа рендерятся в HTML, открываются в Lavish Editor и
  проходят цикл poll → правки → снова, до явного аппрува (ключевые слова и лимит итераций
  настраиваются в конфиге).
- **Pipeline без вопросника.** Координатор управляет воркерами `delegate_task`; все
  развилки (коммиты, контрольные точки, ретраи, гейты) решаются по decisions.json —
  отсутствующий ключ → безопасный дефолт + запись в отчёт, не вопрос.
- **Работа в текущей ветке.** Скилл никогда не создаёт и не переключает ветки: пользователь
  создаёт рабочую ветку ДО запуска. Если текущая ветка защищённая (dev/develop/master/main/trunk) —
  скилл предупреждает в чат и продолжает (ответственность на операторе). После апрува роадмапы
  выполняется **baseline-коммит** артефактов планирования (`docs(<slug>): planning baseline`)
  — точка отсчёта dev-диффа; при `commitStrategy: none` baseline не делается.
- **Resumable.** Можно стартовать с описания фичи, со спеки или прямо с roadmap.

## Установка

```bash
fan store install feature-factory
```

Или вручную:
```bash
cp -r skills/feature-factory/ ~/.fan/agent/skills/feature-factory/
```

После установки — `/reload`.

## Использование

```bash
/skill:feature-factory Система уведомлений в реальном времени              # с нуля: kickoff → спека → roadmap → pipeline
/skill:feature-factory docs/specs/spec_notifications_2026-09-04.md         # со спеки: (kickoff при необходимости) → roadmap → pipeline
/skill:feature-factory docs/features/notifications/roadmap.md              # с roadmap: (kickoff при необходимости) → pipeline
```

### Схема фаз

```
Фаза 0: Конфигурация
  ├── .fan/feature-factory.json (override) или config/default.json (дефолт пакета)
  ├── deep merge: объекты рекурсивно, массивы заменяются целиком
  └── Проверка текущей ветки: защищённая (dev/develop/master/main/trunk) → предупреждение и продолжение; ветки не создаются

Фаза 1: Kickoff (исследование + единый опрос)
  ├── Resumable-проверка: полный decisions.json → kickoff пропускается
  ├── Лёгкое исследование (memory → файлы проекта → web) по config.spec.research
  ├── ОДИН questionnaire, ≤ 12 вопросов:
  │     «Скоуп» (3-5 контекстных, генерирует агент после исследования),
  │     «Роадмапа» (стратегия этапов; превышение лимита этапов),
  │     «Пайплайн» (коммиты; контрольные точки; ретраи; FAIL phase-gate)
  └── .fan/feature-factory/<slug>/decisions.json (scope/roadmap/pipeline/specAnswers)

Фаза 2: Спецификация
  ├── Углубление исследования по config.spec.research (minQuality)
  ├── Ответы kickoff — из decisions.scope / decisions.specAnswers (не спрашиваются повторно)
  └── docs/specs/spec_<slug>_<YYYY-MM-DD>.md (секция «Функции»: P0-P3/MoSCoW, слой)

Фаза 3: Lavish-аппрув спеки (config.lavish.specApproval)
  ├── playbook("plan") → templates/spec-preview.html → .fan/feature-factory/<slug>/spec-preview.html
  └── open → poll (layout_warnings → fix; prompts → правки в markdown → re-render) → approve

Фаза 4: Роадмапа
  ├── Парсинг «Функций» спеки → F-X.Y; приоритеты — фиксированный маппинг MoSCoW→P0-P3
  ├── Этапы по decisions.roadmap.stageStrategy; лимиты config.roadmap (maxStages/maxFunctions/functionsPerStage)
  └── docs/features/<slug>/roadmap.md (TC-F-X.Y-N, Red-тест, Refactor-цели, E2E + Smoke этапа)

Фаза 5: Lavish-аппрув роадмапы (config.lavish.roadmapApproval)
  ├── playbook → templates/roadmap-preview.html → .fan/feature-factory/<slug>/roadmap-preview.html → poll → approve
  └── Baseline-коммит (при commitStrategy ≠ none): docs(<slug>): planning baseline (spec + roadmap approved) — точка отсчёта dev-диффа

Фаза 6: Pipeline (TDD)
  ├── На каждую функцию: Red (tests-impl) → Green (implement) → verify → bug-fix (фикс. 3 попытки) → Refactor → commit
  ├── Коммиты/контрольные точки/ретраи/гейты — из decisions.pipeline
  ├── Phase-gate на границах этапов (Smoke + E2E этапа); FAIL → decisions.pipeline.phaseGateFail
  ├── Финальная фаза G: G.1 verify → G.1.5 code-review → G.1.6 security-аудит → G.2 smoke → G.3 e2e → G.4 docs → G.6 коммит
  └── Исчерпание попыток → decisions.pipeline.onMaxRetriesExceeded (abort = остановка с отчётом)

Фаза 7: Финал
  └── docs/features/<slug>/pipeline-report.md (+ технический долг) + сводка в чат
```

## Конфигурация

Проектный конфиг: `.fan/feature-factory.json` в корне проекта. При первом запуске в
проекте он создаётся автоматически — копией `config/default.json` из пакета (все поля
со значениями по умолчанию); правьте его под проект — изменения подхватятся при
следующих запусках. Если создать файл не удалось (ошибка записи/права), скилл работает
со встроенным дефолтом пакета (уведомление в чат, не вопрос).
Мерж: объекты рекурсивно, **массивы заменяются целиком** (проектный файл может
отставать от дефолта после обновления скилла — недостающие поля добираются из дефолта).
Все поля документированы в
[`references/config-schema.md`](references/config-schema.md).

Конфиг — **только общие настройки реализации**; решения по конкретной фиче собирает
kickoff-опрос (Фаза 1) и хранит `decisions.json`.

Мини-пример:

```json
{
  "spec": {
    "research": { "memory": true, "projectFiles": true, "webSearch": true, "minQuality": 0.9 }
  },
  "roadmap": {
    "maxStages": 6,
    "maxFunctions": 12
  },
  "pipeline": {
    "codeReview": "final",
    "securityAudit": "final",
    "docsUpdate": true
  },
  "lavish": {
    "specApproval": { "enabled": true, "playbook": "plan" },
    "maxRevisions": 3,
    "approveKeywords": ["approve", "аппрув", "ок"]
  }
}
```

## Артефакты

| Артефакт | Путь |
|----------|------|
| Решения kickoff | `.fan/feature-factory/<slug>/decisions.json` |
| Спецификация | `docs/specs/spec_<slug>_<YYYY-MM-DD>.md` |
| Превью спеки (Lavish) | `.fan/feature-factory/<slug>/spec-preview.html` |
| Роадмапа | `docs/features/<slug>/roadmap.md` |
| Превью роадмапы (Lavish) | `.fan/feature-factory/<slug>/roadmap-preview.html` |
| Baseline-коммит | git SHA после апрува роадмапы (точка отсчёта dev-диффа, фиксируется в pipeline-report.md) |
| Код, тесты, коммиты | текущая ветка (создаётся пользователем до запуска) |
| Отчёт pipeline | `docs/features/<slug>/pipeline-report.md` |
| Рабочие артефакты (с orchestrator) | `docs/development-plan.md`, `docs/development-log.md`, `.fan/tracking/phase-status.json` |

## Зависимости

- **delegate_task** — воркеры pipeline: `tests-impl`, `implement`, `verify`, `bug-fix`, `docs-impl`, `plan`, `security`, `code-review` (TaskCreate/TaskUpdate для управления задачами)
- **lavish extension** — аппрув спеки и роадмапы (playbook/open/poll)
- **fan-ask-answer** — `questionnaire` для единого kickoff-опроса (Фаза 1)
- **web-search / memory** — инструменты исследования спеки (опционально, по конфигу)

## Структура

```
feature-factory/
├── SKILL.md                      # Процесс: фазы 0-7 (kickoff → спека → роадмапа → pipeline), жёсткие правила, артефакты
├── config/
│   └── default.json              # Дефолтный конфиг (только общие настройки реализации)
├── references/
│   ├── config-schema.md          # Документация каждого поля конфига + что НЕ в конфиге (decisions.json)
│   ├── spec-phase.md             # Фаза 2: исследование + ответы kickoff + спека
│   ├── roadmap-phase.md          # Фаза 4: парсинг спеки, этапы по decisions, лимиты, roadmap.md
│   ├── pipeline-phase.md         # Фаза 6: TDD-цикл, решения kickoff → поведение, phase-gate, финальная фаза G
│   ├── lavish-approval.md        # Цикл аппрува: playbook → HTML → poll → правки
│   └── spec-template.md          # Markdown-шаблон спеки (структурные «Функции»)
├── templates/
│   ├── spec-preview.html         # Каркас Lavish-превью спеки
│   └── roadmap-preview.html      # Каркас Lavish-превью роадмапы
├── package.json                  # Метаданные FAN-пакета
├── DEPLOY.toml                   # Манифест деплоя
└── README.md                     # Этот файл
```

## См. также

- [research-spec-generator](../research-spec-generator/) — исследование + спека (база Фазы 2)
- [feature-roadmap](../feature-roadmap/) — TDD-роадмапа (база Фазы 4)
- [feature-pipeline](../feature-pipeline/) — TDD-пайплайн (база Фазы 6)
