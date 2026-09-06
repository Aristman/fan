# Схема конфига feature-factory

> Reference-файл скилла feature-factory. Документирует каждое поле `config/default.json`
> и правила override через `.fan/feature-factory.json`.
>
> **Конфиг — только общие настройки реализации фичей.** Вопросов, опросов и вариантов
> ответов в конфиге НЕТ: всё интерактивное — единый kickoff-опрос (Фаза 1, SKILL.md),
> его ответы персистятся в `.fan/feature-factory/<slug>/decisions.json`.

## Источники конфига и мерж

| Приоритет | Источник | Путь |
|-----------|----------|------|
| 1 (высший) | Проектный override | `.fan/feature-factory.json` (в корне проекта) |
| 2 | Дефолт пакета | `<пакет скилла>/config/default.json` |

- **Автосоздание (Фаза 0):** если `.fan/feature-factory.json` отсутствует — скилл создаёт его копией `config/default.json` из пакета (все поля, значения по умолчанию, валидный JSON) и уведомляет в чат: файл создан, правьте под проект — изменения подхватятся при следующих запусках. Отсутствие конфига — не вопрос пользователю.
- **Fallback:** если создать файл не удалось (ошибка записи/права) — скилл работает с `config/default.json` из пакета, уведомляет в чат и продолжает.
- Мерж: **deep merge, проектный конфиг (свежесозданный или существующий) > дефолт**. Объекты сливаются рекурсивно по ключам; **массивы заменяются целиком** (включая `approveKeywords` и `functionsPerStage`). Merge нужен и при автосоздании: проектный файл может отставать от дефолта после обновления скилла — недостающие поля добираются из дефолта.
- Валидация: если `.fan/feature-factory.json` невалидный JSON — остановка с отчётом (не молча падать на дефолт).
- Неизвестные ключи в override — предупреждение в чат, ключ игнорируется.

## Что НЕ в конфиге (и почему)

| Что | Где живёт | Почему |
|-----|-----------|--------|
| Вопросы пользователю (опросники, лимиты вопросов) | Структура kickoff зафиксирована в SKILL.md (Фаза 1): табы «Скоуп»/«Роадмапа»/«Пайплайн», суммарно ≤ 12 вопросов; контекстные вопросы таба «Скоуп» агент генерирует сам после исследования | Опрос — часть процесса скилла, а не настройка проекта; конфиг с вопросами провоцирует рассинхрон вопросов и кода фаз |
| Решения по фиче: скоуп (границы, критерии успеха, ограничения, пользователи) | `.fan/feature-factory/<slug>/decisions.json` → секция `scope` | per-feature решения: у каждой фичи свой скоуп |
| Стратегия этапов роадмапы и действие при превышении лимита этапов | `decisions.json` → секция `roadmap` (два ключа; точные имена — в схеме в SKILL.md, Фаза 1) | per-feature выбор пользователя из kickoff (таб «Роадмапа»); поведение — `references/roadmap-phase.md` |
| Стратегия коммитов, контрольные точки, verify-повторы и реакция на их исчерпание, поведение при FAIL phase-gate | `decisions.json` → секция `pipeline` (четыре ключа; точные имена — в схеме в SKILL.md, Фаза 1) | per-feature выбор из kickoff (таб «Пайплайн»); поведение — `references/pipeline-phase.md`. Лимит verify-повторов фиксированный: **3** (не настраивается нигде) |
| Маппинг приоритетов MoSCoW → P0-P3 | Фиксированный формат roadmap-файла — таблица в `references/roadmap-phase.md` | Это часть формата артефакта, а не предпочтение проекта |
| Поведение при пробелах в спеке | Фиксированное: вывод с пометкой `<!-- inferred -->` + блок «Допущения» (`references/roadmap-phase.md`) | Вопрос пользователю невозможен после kickoff, настраивать нечего |
| Сырые ответы на контекстные вопросы | `decisions.json` → секция `specAnswers` (ключи = id вопросов) | Нужны для resumable: kickoff не повторяется, пока decisions полон |

Схема `decisions.json` целиком — в SKILL.md (Фаза 1).

## Секция `spec` (Фаза 2)

### `spec.autoDetectType`
- **Тип:** `boolean`, **Дефолт:** `true`
- `true` — тип запроса определяется агентом автоматически по описанию (уведомление в чат); `false` — авто-детекция отключена, используется тип `feature` (безопасный дефолт), допущение фиксируется в метаданных спеки.
- Набор типов (`feature/project/modification/integration/optimization/research`) — фиксированная логика скилла, не настройка. Влияние: **R-1** (см. `references/spec-phase.md`).

### `spec.research.memory`
- **Тип:** `boolean`, **Дефолт:** `true`
- Использовать `memory_search` при исследовании (лёгкое исследование Фазы 1 и углубление Фазы 2).

### `spec.research.projectFiles`
- **Тип:** `boolean`, **Дефолт:** `true`
- Анализ файлов проекта (`read`, `grep`/`find` через bash).

### `spec.research.webSearch`
- **Тип:** `boolean`, **Дефолт:** `true`
- Внешнее исследование (`web_search` → `web_reader`).

### `spec.research.minQuality`
- **Тип:** `number` (0–1), **Дефолт:** `0.8`
- Целевой средний балл раунда исследования; ниже — дополнительный раунд (макс. 3).
- Влияние: глубина исследования Фаз 1–2.

## Секция `roadmap` (Фаза 4)

### `roadmap.maxStages`
- **Тип:** `number`, **Дефолт:** `8`
- Лимит этапов roadmap. Превышение → решение kickoff из секции `roadmap` в `decisions.json` (см. `references/roadmap-phase.md`).

### `roadmap.maxFunctions`
- **Тип:** `number`, **Дефолт:** `15`
- Лимит функций в roadmap. Превышение → предупреждение ⚠️ в шапке roadmap (или delegate-сценарий, если так решено в kickoff — см. `references/roadmap-phase.md`).

### `roadmap.functionsPerStage`
- **Тип:** `[min, max]`, **Дефолт:** `[3, 30]`
- Допустимое число функций в одном этапе; вне диапазона — перебалансировка этапов в пределах выбранной стратегии.

## Секция `pipeline` (Фаза 6)

### `pipeline.codeReview`
- **Тип:** `"final" \| "off"`, **Дефолт:** `"final"`
- `"final"` — шаг G.1.5 (code-review-воркер на полный дифф, один раз на фичу). `"off"` — пропустить.

### `pipeline.securityAudit`
- **Тип:** `"final" \| "off"`, **Дефолт:** `"final"`
- `"final"` — шаг G.1.6 (security-воркер: OWASP/CWE, secrets, deps) + опциональный аудит критичных этапов (auth/секреты/ввод). `"off"` — пропустить.

### `pipeline.docsUpdate`
- **Тип:** `boolean`, **Дефолт:** `true`
- Шаг G.4: обновление README/CHANGELOG/roadmap документации.

## Секция `lavish` (Фазы 3 и 5)

### `lavish.specApproval.enabled`
- **Тип:** `boolean`, **Дефолт:** `true`
- Обязательность Lavish-аппрува спеки. `true` — продолжение без аппрува запрещено.

### `lavish.specApproval.playbook`
- **Тип:** `string`, **Дефолт:** `"plan"`
- `playbook_id` для `lavish({command:"playbook"})` перед рендером HTML спеки. Допустимые по роутеру lavish: `plan`, `diagram`, `comparison` (один ID; комбинировать нельзя — поле скалярное).

### `lavish.roadmapApproval.enabled`
- **Тип:** `boolean`, **Дефолт:** `true`
- Обязательность Lavish-аппрува роадмапы.

### `lavish.roadmapApproval.playbook`
- **Тип:** `string`, **Дефолт:** `"plan"` — аналогично `specApproval.playbook`.

### `lavish.maxRevisions`
- **Тип:** `number`, **Дефолт:** `5`
- Максимум итераций доработки на артефакт в poll-цикле (итерация = «правки → перерендер → poll»). Исчерпание → остановка с отчётом (жёсткое правило 6 SKILL.md).

### `lavish.approveKeywords`
- **Тип:** `string[]`, **Дефолт:** `["approve","approved","аппрув","ок","согласовано","всё отлично","выглядит хорошо"]`
- Ключевые слова, распознаваемые в `prompts` poll как аппрув. **Массив заменяется целиком** при override — добавляй полный список.

## Полный пример override `.fan/feature-factory.json`

```json
{
  "spec": {
    "autoDetectType": true,
    "research": { "memory": true, "projectFiles": true, "webSearch": false, "minQuality": 0.9 }
  },
  "roadmap": {
    "maxStages": 6,
    "maxFunctions": 12,
    "functionsPerStage": [3, 20]
  },
  "pipeline": {
    "codeReview": "final",
    "securityAudit": "off",
    "docsUpdate": false
  },
  "lavish": {
    "specApproval": { "enabled": true, "playbook": "plan" },
    "roadmapApproval": { "enabled": false, "playbook": "plan" },
    "maxRevisions": 3,
    "approveKeywords": ["approve","аппрув","ок","лг","выглядит хорошо"]
  }
}
```

> Внимание: в примере `approveKeywords` и `functionsPerStage` **заменяют** дефолтные
> массивы целиком (мерж массивов); `webSearch: false` отключает только веб-исследование,
> memory и projectFiles остаются из дефолта (deep merge по объекту `research`).
> Решения по конкретной фиче (этапы, коммиты, гейты, скоуп) сюда не пишутся —
> их собирает kickoff и хранит `decisions.json`.
