# Схема конфига feature-factory

> Reference-файл скилла feature-factory. Документирует каждое поле `config/default.json`
> и правила override через `.fan/feature-factory.json`. Все параметры фаз берутся
> **только** из активного конфига (см. Фаза 0 в SKILL.md).

## Источники конфига и мерж

| Приоритет | Источник | Путь |
|-----------|----------|------|
| 1 (высший) | Проектный override | `.fan/feature-factory.json` (в корне проекта) |
| 2 | Дефолт пакета | `<пакет скилла>/config/default.json` |

- Override опционален. **Отсутствие конфига — не вопрос пользователю**: уведомление в чат («используется дефолтный конфиг пакета») и продолжение.
- Мерж: **deep merge, проектный override > дефолт**. Объекты сливаются рекурсивно по ключам; **массивы заменяются целиком** (включая `rounds[].questions`, `approveKeywords`, `stagingStrategies`, `requestTypes`, `functionsPerStage`).
- Валидация: если `.fan/feature-factory.json` невалидный JSON — остановка с отчётом (не молча падать на дефолт).
- Неизвестные ключи в override — предупреждение в чат, ключ игнорируется.

## Секция `spec` (Фаза 1)

### `spec.requestTypes`
- **Тип:** `string[]`, **Дефолт:** `["feature","project","modification","integration","optimization","research"]`
- Допустимые элементы: `feature`, `project`, `modification`, `integration`, `optimization`, `research`.
- Влияние: категоризация запроса. Точка: **R-1** (исходный вопрос «Какой тип запроса?»).

### `spec.autoDetectType`
- **Тип:** `boolean`, **Дефолт:** `true`
- `true` — тип определяется автоматически по описанию (уведомление в чат); `false` — берётся первый подходящий тип из `requestTypes`, допущение фиксируется в спеке.
- Влияние: **R-1**.

### `spec.research.memory`
- **Тип:** `boolean`, **Дефолт:** `true`
- Использовать `memory_search` при исследовании.
- Влияние: объём исследования Фазы 1.

### `spec.research.projectFiles`
- **Тип:** `boolean`, **Дефолт:** `true`
- Анализ файлов проекта (`read`, `grep`/`find` через bash).
- Влияние: объём исследования Фазы 1.

### `spec.research.webSearch`
- **Тип:** `boolean`, **Дефолт:** `true`
- Внешнее исследование (`web_search` → `web_reader`).
- Влияние: объём исследования Фазы 1.

### `spec.research.minQuality`
- **Тип:** `number` (0–1), **Дефолт:** `0.8`
- Целевой средний балл раунда исследования; ниже — дополнительный раунд (макс. 3).
- Влияние: глубина исследования Фазы 1.

### `spec.interview.maxQuestionsPerRound`
- **Тип:** `number`, **Дефолт:** `5`
- Максимум вопросов в одном вызове `questionnaire`. Больше вопросов в раунде → несколько вызовов.
- Влияние: **R-2** (интервью — единственный интерактивный этап Фазы 1).

### `spec.interview.rounds`
- **Тип:** `object[]`, **Дефолт:** см. `config/default.json`
- Раунды интервью. Каждый раунд:

| Поле раунда | Тип | Описание |
|-------------|-----|----------|
| `id` | `string` | уникальный идентификатор раунда |
| `label` | `string` | ярлык (в чат-лог) |
| `trigger` | `"always" \| "on_gaps"` | `always` — выполняется всегда; `on_gaps` — только при оставшихся пробелах, закрываемых его вопросами |
| `questions` | `object[]` | вопросы раунда (пустой массив = раунд пропускается) |

| Поле вопроса | Тип | Описание |
|--------------|-----|----------|
| `id` | `string` | идентификатор (snake_case) |
| `label` | `string` | короткий ярлык таба |
| `prompt` | `string` | полный текст вопроса — подаётся как есть |
| `options` | `{value,label}[]` \| отсутствует | варианты ответа; отсутствуют → свободный ввод |
| `allowOther` | `boolean` | разрешить ответ вне вариантов |
| `required` | `boolean` | `true` — без опции «Пропустить», ответ обязателен для продолжения; `false` — добавляется опция `skip` |

- **Единственный разрешённый источник вопросов.** Импровизированные/динамические вопросы запрещены (жёсткое правило 1 SKILL.md).
- Влияние: **R-2**.

### Удалённые интерактивные точки

- **M-1** (выбор входа: путь/имя/описание) и **M-2** (подтверждение slug) — полей конфига не имеют: обе точки разрешаются аргументом запуска (resumable-логика в «Обзоре» SKILL.md) с уведомлением в чат. Осознанное решение: вход скилла — не параметр конфигурации.
- **R-3** (финальное подтверждение готовности к спеке) — в feature-factory не существует: роль подтверждения выполняет Lavish-аппрув (`lavish.specApproval`). Поля конфига для R-3 нет — это осознанное решение.

## Секция `roadmap` (Фаза 3)

### `roadmap.maxStages`
- **Тип:** `number`, **Дефолт:** `8`
- Лимит этапов roadmap. Превышение → `onStageLimitExceeded`.
- Влияние: **M-5** (исходный вопрос при превышении лимита этапов).

### `roadmap.maxFunctions`
- **Тип:** `number`, **Дефолт:** `15`
- Лимит функций в roadmap. Превышение → предупреждение ⚠️ в шапке roadmap (или abort, если `onStageLimitExceeded: "abort"`).
- Влияние: **M-5**.

### `roadmap.functionsPerStage`
- **Тип:** `[min, max]`, **Дефолт:** `[3, 30]`
- Допустимое число функций в одном этапе; вне диапазона — перебалансировка этапов.
- Влияние: **M-5** (лимиты), группировка функций.

### `roadmap.stagingStrategies`
- **Тип:** `{value,label}[]`, **Дефолт:** `mvp-first`, `core-integration`
- Поддерживаемые стратегии этапов. Кастомные значения допустимы, но фаза должна уметь их интерпретировать (логика распределения описывается в проектном override словами через label; без явной логики используется ближайшая встроенная).
- Влияние: **M-3** (исходный вопрос «На какие этапы разбить?»).

### `roadmap.defaultStrategy`
- **Тип:** `string`, **Дефолт:** `"mvp-first"`
- Значение `value` из `stagingStrategies`, применяемое без вопроса.
- Влияние: **M-3**.

### `roadmap.priorityMapping`
- **Тип:** `object` (ключи — labels приоритетов в спеке, значения — `"P0".."P3"` или `"exclude"`), **Дефолт:** `{"Must Have":"P0","Should Have":"P1","Could Have":"P2","Won't Have":"exclude"}`
- Перевод приоритетов из спеки (MoSCoW или кастомные) в P-уровни roadmap. `exclude` = функция не попадает в roadmap.
- Влияние: **M-4** (исходный вопрос «Какой приоритет у функции?» — для каждой функции!).

### `roadmap.onStageLimitExceeded`
- **Тип:** `"delegate" \| "warn" \| "truncate" \| "abort"`, **Дефолт:** `"delegate"`
- `"delegate"` — `delegate_task(agent="plan")` разбивает спеку на дочерние; остановка с отчётом и планом дочерних спек. `"warn"` — продолжить с ⚠️ в шапке. `"truncate"` — первые `maxStages` этапов, остальное в «Отложено». `"abort"` — остановка с отчётом.
- Влияние: **M-5**.

### `roadmap.onMissingSpecFields`
- **Тип:** `"infer" \| "abort"`, **Дефолт:** `"infer"`
- `"infer"` — вывести недостающие поля (приоритет/слой/зависимости) из контекста, пометить `<!-- inferred -->` и блоком «Допущения». `"abort"` — остановка с отчётом.
- Влияние: устойчивость Фазы 3 к внешним спекам.

## Секция `pipeline` (Фаза 5)

### `pipeline.commitStrategy`
- **Тип:** `"per-function" \| "per-phase" \| "manual"`, **Дефолт:** `"per-function"`
- Когда выполняются git-коммиты (conventional-commits, явный `git add`, без `-A`).
- Влияние: **P-1** (исходный questionnaire перед стартом: стратегия коммитов).

### `pipeline.controlPoints`
- **Тип:** `"on-error" \| "per-stage" \| "per-function" \| "final"`, **Дефолт:** `"on-error"`
- Где координатор пишет пользователю (уведомления, не вопросы).
- Влияние: **P-2** (исходные контрольные точки с вопросами).

### `pipeline.maxVerifyRetries`
- **Тип:** `number`, **Дефолт:** `3`
- Максимум циклов bug-fix → verify на функцию.
- Влияние: **P-3** (исходный вопрос после исчерпания попыток).

### `pipeline.onMaxRetriesExceeded`
- **Тип:** `"abort" \| "skip"`, **Дефолт:** `"abort"`
- `"abort"` — остановка запуска с отчётом (валидный исход). `"skip"` — пометить функцию ❌ и продолжить. `"ask"` (если указан в override) трактуется как `"abort"` — вопросов вне конфига нет.
- Влияние: **P-3**.

### `pipeline.phaseGate`
- **Тип:** `"auto" \| "off"`, **Дефолт:** `"auto"`
- `"auto"` — Smoke + E2E этапа на границах этапов выполняются автоматически, сводка в чат; опциональный security-аудит этапа (auth/секреты/ввод). `"off"` — gate не выполняется.
- Влияние: **P-4** (исходный вопрос на phase-gate).

### `pipeline.codeReview`
- **Тип:** `"final" \| "off"`, **Дефолт:** `"final"`
- `"final"` — шаг G.1.5 (code-review-воркер на полный дифф, один раз на фичу). `"off"` — пропустить.
- Влияние: состав финальной фазы G.

### `pipeline.securityAudit`
- **Тип:** `"final" \| "off"`, **Дефолт:** `"final"`
- `"final"` — шаг G.1.6 (security-воркер: OWASP/CWE, secrets, deps) + опциональный аудит критичных этапов при `phaseGate: "auto"`. `"off"` — пропустить.
- Влияние: состав финальной фазы G.

### `pipeline.docsUpdate`
- **Тип:** `boolean`, **Дефолт:** `true`
- Шаг G.4: обновление README/CHANGELOG/roadmap документации.
- Влияние: состав финальной фазы G.

### Удалённые интерактивные точки

- **P-5** (финальный вопрос «Что дальше?») — не существует: финал = pipeline-report.md + сводка в чат. Поля конфига нет — осознанное решение.

## Секция `lavish` (Фазы 2 и 4)

### `lavish.specApproval.enabled`
- **Тип:** `boolean`, **Дефолт:** `true`
- Обязательность Lavish-аппрува спеки. `true` — продолжение без аппрува запрещено.
- Влияние: **R-3/M-6-аналог** для спеки (единственная интерактивность скилла).

### `lavish.specApproval.playbook`
- **Тип:** `string`, **Дефолт:** `"plan"`
- `playbook_id` для `lavish({command:"playbook"})` перед рендером HTML спеки. Допустимые по роутеру lavish: `plan`, `diagram`, `comparison` (один ID; комбинировать нельзя — поле скалярное).

### `lavish.roadmapApproval.enabled`
- **Тип:** `boolean`, **Дефолт:** `true`
- Обязательность Lavish-аппрува роадмапы.
- Влияние: **M-6** (исходный финальный вопрос «Roadmap создан. Что дальше?» → заменён этим аппрувом).

### `lavish.roadmapApproval.playbook`
- **Тип:** `string`, **Дефолт:** `"plan"` — аналогично `specApproval.playbook`.

### `lavish.approveKeywords`
- **Тип:** `string[]`, **Дефолт:** `["approve","approved","аппрув","ок","согласовано","всё отлично","выглядит хорошо"]`
- Ключевые слова, распознаваемые в `prompts` poll как аппрув. **Массив заменяется целиком** при override — добавляй полный список.
- Влияние: распознавание аппрува в Фазах 2 и 4 (см. `references/lavish-approval.md`).

## Полный пример override `.fan/feature-factory.json`

```json
{
  "spec": {
    "autoDetectType": true,
    "research": { "memory": true, "projectFiles": true, "webSearch": false, "minQuality": 0.9 },
    "interview": {
      "maxQuestionsPerRound": 4,
      "rounds": [
        { "id": "round-1", "label": "Скоуп", "trigger": "always", "questions": [
          { "id": "success_criteria", "label": "Успех", "prompt": "Как измерим успех фичи?", "allowOther": true, "required": true }
        ]},
        { "id": "round-2", "label": "Интеграции", "trigger": "on_gaps", "questions": [
          { "id": "external_systems", "label": "Системы", "prompt": "Какие внешние системы затрагиваем?", "allowOther": true, "required": false }
        ]}
      ]
    }
  },
  "roadmap": {
    "maxStages": 6,
    "maxFunctions": 12,
    "functionsPerStage": [3, 20],
    "stagingStrategies": [{"value":"core-integration","label":"Ядро → Интеграция → Продвинутые"}],
    "defaultStrategy": "core-integration",
    "priorityMapping": {"Must Have":"P0","Should Have":"P1","Could Have":"P2","Won't Have":"exclude"},
    "onStageLimitExceeded": "warn",
    "onMissingSpecFields": "infer"
  },
  "pipeline": {
    "commitStrategy": "per-phase",
    "controlPoints": "per-stage",
    "maxVerifyRetries": 2,
    "onMaxRetriesExceeded": "skip",
    "phaseGate": "auto",
    "codeReview": "final",
    "securityAudit": "off",
    "docsUpdate": false
  },
  "lavish": {
    "specApproval": { "enabled": true, "playbook": "plan" },
    "roadmapApproval": { "enabled": false, "playbook": "plan" },
    "approveKeywords": ["approve","аппрув","ок","лг","выглядит хорошо"]
  }
}
```

> Внимание: в примере `approveKeywords` **заменяет** дефолтный список целиком (мерж массивов);
> `webSearch: false` отключает только веб-исследование, memory и projectFiles остаются
> из дефолта (deep merge по объекту `research`).
