# dev-docs-pack

Генератор полного пакета разработки из спецификации.

## Что делает

Принимает спецификацию (или описание фичи) и генерирует полный комплект документов для разработки:

- **Основной roadmap** с этапами, блочными диаграммами, требованиями к smoke-тестам
- **Детальные TDD-roadmap** на каждый этап (Red → Green → Refactor)
- **UI/UX документы** — пользовательские потоки, сценарии, описания макетов
- **API документы** — спецификация эндпоинтов, changelog
- **Стратегию тестирования** — пирамида тестов, smoke-тесты, E2E
- **Релизные документы** — release notes, руководство по деплою

## Установка

```bash
fan store install dev-docs-pack
```

## Использование

```
/skill:dev-docs-pack docs/specs/spec_my-feature_2026-05-06.md
/skill:dev-docs-pack notification-system
/skill:dev-docs-pack Нужно сделать систему уведомлений с...
```

## Выход

```
docs/features/<feature>/
├── README.md                          # Обзор и индекс
├── roadmaps/
│   ├── roadmap-main.md                # Основной roadmap фичи
│   └── roadmap-stage-N-<name>.md      # Детальный TDD-roadmap этапа
├── ui-ux/                             # Если есть UI
│   ├── user-flows.md                  # Пользовательские потоки
│   ├── scenarios.md                   # Сценарии использования
│   └── wireframes.md                  # Описания макетов
├── api/                               # Если есть внешний API
│   ├── api-reference.md               # Спецификация API
│   └── api-changelog.md               # История изменений API
├── testing/
│   ├── test-strategy.md               # Стратегия тестирования
│   ├── smoke-tests.md                 # Smoke-тесты
│   └── e2e-tests.md                   # E2E-сценарии
└── release/
    ├── release-notes.md               # Release notes
    └── deployment-guide.md            # Руководство по деплою
```

## Процесс

Скилл работает в 9 фаз:

| Фаза | Название | Описание |
|------|----------|----------|
| 1 | Инициализация | Определение входных данных, контекста проекта |
| 2 | Оценка качества | 10 измерений, взвешенная оценка (порог 0.95) |
| 3 | Интервью | Циклический опрос для заполнения пробелов |
| 4 | Декомпозиция | Определение этапов и области документов |
| 5 | Основной roadmap | Генерация roadmap-main.md |
| 6 | Roadmap-и этапов | TDD-roadmap на каждый этап |
| 7 | Доп. документы | UI/UX, API, тесты, релиз |
| 8 | Верификация | Проверка полноты и согласованности |
| 9 | Финализация | README, MANIFEST, отчёт |

## Оценка качества

Входные данные оцениваются по 10 измерениям:

| Измерение | Вес |
|-----------|------|
| Цели и задачи | 0.15 |
| Функциональный охват | 0.20 |
| Техническая архитектура | 0.15 |
| UI/UX определение | 0.10 |
| API / интерфейсы | 0.10 |
| Требования к тестированию | 0.10 |
| Нефункциональные требования | 0.05 |
| Ограничения и риски | 0.05 |
| Контекст и стейкхолдеры | 0.05 |
| Критерии приёмки | 0.05 |

Целевой порог: **0.95** — до достижения этого уровня скилл проводит интервью.

## Частичный генерации

Можно сгенерировать только часть документов:
- Полный пакет (все по decision tree)
- Только roadmaps
- Roadmaps + тестирование
- Roadmaps + UI/UX
- Roadmaps + API
- Выборочно

## Структура файлов скилла

```
skills/dev-docs-pack/
├── SKILL.md              # Основной файл скилла (9 фаз)
├── README.md             # Этот файл
├── package.json          # Метаданные
└── references/
    ├── quality-rubric.md             # Рубрика оценки
    ├── interview-questions.md        # Банк вопросов для интервью
    ├── stage-decomposition-guide.md  # Гид по декомпозиции
    ├── block-diagram-patterns.md     # Паттерны ASCII-диаграмм
    ├── template-readme.md            # Шаблон README фичи
    ├── template-roadmap-main.md      # Шаблон основного roadmap
    ├── template-roadmap-stage.md     # Шаблон этапного roadmap
    ├── template-user-flows.md        # Шаблон пользовательских потоков
    ├── template-scenarios.md         # Шаблон сценариев
    ├── template-wireframes.md        # Шаблон макетов
    ├── template-api-reference.md     # Шаблон API reference
    ├── template-api-changelog.md     # Шаблон API changelog
    ├── template-test-strategy.md     # Шаблон стратегии тестирования
    ├── template-smoke-tests.md       # Шаблон smoke-тестов
    ├── template-e2e-tests.md         # Шаблон E2E-тестов
    ├── template-release-notes.md     # Шаблон release notes
    └── template-deployment-guide.md  # Шаблон руководства по деплою
```

## Зависимости

Нет внешних зависимостей. Использует стандартные инструменты FAN: `read`, `write`, `bash`, `question`, `questionnaire`.
