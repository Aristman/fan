# feature-factory

## Описание

Полный цикл разработки фичи от описания до закоммиченного кода в одном запуске.
Объединяет три скилла в конвейер: **research-spec-generator** (спецификация) →
**feature-roadmap** (TDD-роадмапа) → **feature-pipeline** (TDD-реализация Red-Green-Refactor).

Ключевые принципы:

- **Интервью строго по конфигу.** Единственные вопросы пользователю — из
  `.fan/feature-factory.json` (секция `spec.interview`). Импровизированный опрос запрещён.
- **Lavish-аппрув — единственная интерактивность.** Спека и роадмапа рендерятся в HTML,
  открываются в Lavish Editor и проходят цикл poll → правки → снова, до явного аппрува
  (ключевые слова настраиваются в конфиге).
- **Pipeline без вопросника.** Стратегия коммитов, контрольные точки, лимиты повторов —
  из конфига; координатор управляет воркерами `delegate_task` и не задаёт вопросов.
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
/skill:feature-factory Система уведомлений в реальном времени              # с нуля: спека → roadmap → pipeline
/skill:feature-factory docs/specs/spec_notifications_2026-09-04.md         # со спеки: roadmap → pipeline
/skill:feature-factory docs/features/notifications/roadmap.md              # с roadmap: pipeline
```

### Схема фаз

```
Фаза 0: Конфигурация
  ├── .fan/feature-factory.json (override) или config/default.json (дефолт пакета)
  └── deep merge: объекты рекурсивно, массивы заменяются целиком

Фаза 1: Спецификация
  ├── Исследование (memory → файлы проекта → web) по config.spec.research
  ├── Интервью — ТОЛЬКО вопросы из config.spec.interview (questionnaire)
  └── docs/specs/spec_<slug>_<YYYY-MM-DD>.md (секция «Функции»: P0-P3/MoSCoW, слой)

Фаза 2: Lavish-аппрув спеки (config.lavish.specApproval)
  ├── playbook("plan") → templates/spec-preview.html → .fan/feature-factory/<slug>/spec-preview.html
  └── open → poll (layout_warnings → fix; prompts → правки в markdown → re-render) → approve

Фаза 3: Роадмапа
  ├── Парсинг «Функций» спеки → F-X.Y, обособленность, приоритеты через priorityMapping
  ├── Этапы по config.roadmap.defaultStrategy, лимиты maxStages/maxFunctions/functionsPerStage
  └── docs/features/<slug>/roadmap.md (TC-F-X.Y-N, Red-тест, Refactor-цели, E2E + Smoke этапа)

Фаза 4: Lavish-аппрув роадмапы (config.lavish.roadmapApproval)
  └── playbook → templates/roadmap-preview.html → .fan/feature-factory/<slug>/roadmap-preview.html → poll → approve

Фаза 5: Pipeline (TDD)
  ├── На каждую функцию: Red (tests-impl) → Green (implement) → verify → bug-fix → Refactor → commit
  ├── Phase-gate на границах этапов (Smoke + E2E этапа) по config.pipeline.phaseGate
  ├── Финальная фаза G: G.1 verify → G.1.5 code-review → G.1.6 security-аудит → G.2 smoke → G.3 e2e → G.4 docs → G.6 коммит
  └── Исчерпание попыток → config.pipeline.onMaxRetriesExceeded (abort = остановка с отчётом)

Фаза 6: Финал
  └── docs/features/<slug>/pipeline-report.md + сводка в чат
```

## Конфигурация

Проектный override: `.fan/feature-factory.json` в корне проекта. Если его нет —
используется `config/default.json` из пакета (уведомление в чат, не вопрос).
Мерж: объекты рекурсивно, **массивы заменяются целиком**. Все поля документированы в
[`references/config-schema.md`](references/config-schema.md).

Мини-пример:

```json
{
  "spec": {
    "interview": {
      "maxQuestionsPerRound": 3,
      "rounds": [
        { "id": "round-1", "label": "Скоуп", "trigger": "always", "questions": [
          { "id": "success_criteria", "label": "Успех", "prompt": "Как измерим успех фичи?", "allowOther": true, "required": true }
        ]}
      ]
    }
  },
  "pipeline": {
    "commitStrategy": "per-function",
    "onMaxRetriesExceeded": "abort"
  },
  "lavish": {
    "specApproval": { "enabled": true, "playbook": "plan" },
    "approveKeywords": ["approve", "аппрув", "ок"]
  }
}
```

## Артефакты

| Артефакт | Путь |
|----------|------|
| Спецификация | `docs/specs/spec_<slug>_<YYYY-MM-DD>.md` |
| Превью спеки (Lavish) | `.fan/feature-factory/<slug>/spec-preview.html` |
| Роадмапа | `docs/features/<slug>/roadmap.md` |
| Превью роадмапы (Lavish) | `.fan/feature-factory/<slug>/roadmap-preview.html` |
| Отчёт pipeline | `docs/features/<slug>/pipeline-report.md` |
| Рабочие артефакты (с orchestrator) | `docs/development-plan.md`, `docs/development-log.md`, `.fan/tracking/phase-status.json` |

## Зависимости

- **delegate_task** — воркеры pipeline: `tests-impl`, `implement`, `verify`, `bug-fix`, `docs-impl`, `plan`, `security`, `code-review` (TaskCreate/TaskUpdate для управления задачами)
- **lavish extension** — аппрув спеки и роадмапы (playbook/open/poll)
- **fan-ask-answer** — `questionnaire` для интервью по конфигу
- **web-search / memory** — инструменты исследования спеки (опционально, по конфигу)

## Структура

```
feature-factory/
├── SKILL.md                      # Процесс: фазы 0-6, жёсткие правила, артефакты
├── config/
│   └── default.json              # Дефолтный конфиг (все параметры фаз)
├── references/
│   ├── config-schema.md          # Документация каждого поля конфига + override
│   ├── spec-phase.md             # Фаза 1: исследование + интервью по конфигу + спека
│   ├── roadmap-phase.md          # Фаза 3: парсинг спеки, этапы, лимиты, roadmap.md
│   ├── pipeline-phase.md         # Фаза 5: TDD-цикл, phase-gate, финальная фаза G
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

- [research-spec-generator](../research-spec-generator/) — исследование + спека (база Фазы 1)
- [feature-roadmap](../feature-roadmap/) — TDD-роадмапа (база Фазы 3)
- [feature-pipeline](../feature-pipeline/) — TDD-пайплайн (база Фазы 5)
