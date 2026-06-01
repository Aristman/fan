# feature-pipeline

## Описание

Полный TDD-пайплайн разработки фичи от roadmap до готового результата.
Берёт roadmap из `docs/features/<slug>/roadmap.md`, проходит по всем этапам
и функциям, для каждой выполняя: план → реализация → верификация (цикл до чистого
вердикта) → тестирование → коммит. В финале: полная верификация, smoke/e2e-тесты,
обновление документации, финальный коммит и отчёт.

## Установка

```bash
fan store install feature-pipeline
```

Или вручную:
```bash
cp -r skills/feature-pipeline/ ~/.fan/agent/skills/feature-pipeline/
```

После установки — `/reload`.

## Использование

```bash
/skill:feature-pipeline notification-system           # по slug
/skill:feature-pipeline docs/features/my-feature/roadmap.md  # по пути
/skill:feature-pipeline                                # интерактивный выбор
```

### Процесс работы

```
Фаза 0: Инициализация
  ├── Чтение roadmap
  ├── Создание feature-ветки (feature/<slug>)
  └── Создание pipeline-report.md

Фазы 1..N: Для каждой функции в roadmap (этап за этапом)
  ├── Шаг A: План (explore + plan workers)
  ├── Шаг B: Реализация (implement worker)
  ├── Шаг C: Верификация (verify worker) ← цикл до PASS, макс 3 попытки
  ├── Шаг D: Тестирование (юнит + интеграционные)
  ├── Шаг E: Коммит (feat(<slug>): implement <ID>)
  └── Шаг F: Обновление отчёта

Финальная фаза: Завершение
  ├── Полная верификация фичи
  ├── Smoke-тестирование
  ├── E2E-тестирование (если применимо)
  ├── Обновление документации
  ├── Финальный коммит
  └── Отчёт: docs/features/<slug>/pipeline-report.md
```

### Входные требования

- Должен существовать `docs/features/<slug>/roadmap.md`, сгенерированный `feature-roadmap`
- В roadmap должны быть функции с ID, TDD-тестами и критериями приёмки
- Проект должен быть git-репозиторием

### Результат

| Артефакт | Путь |
|----------|------|
| Реализованный код | В feature-ветке |
| Юнит-тесты | В соответствующих test-директориях |
| Интеграционные тесты | В соответствующих test-директориях |
| Smoke-тесты | В соответствующих test-директориях |
| Планы функций | `docs/features/<slug>/plans/<id>.md` |
| Обновлённая документация | README.md, CHANGELOG.md |
| Roadmap (синхронизирован) | `docs/features/<slug>/roadmap.md` |
| Отчёт о выполнении | `docs/features/<slug>/pipeline-report.md` |

## Конфигурация

Не требует конфигурации. Входные данные — roadmap из `feature-roadmap`.

## Зависимости

- [feature-roadmap](../feature-roadmap/) — для генерации roadmap (предварительный шаг)
- delegate_task — для запуска под-агентов

## Структура

```
feature-pipeline/
├── SKILL.md   # Главный файл скилла с инструкциями
└── README.md  # Этот файл
```

## См. также

- [feature-roadmap](../feature-roadmap/) — генерация TDD-роадмап
- [dev-docs-pack](../dev-docs-pack/) — полный пакет документации
- [fan-forge](../fan-forge/) — создание extensions и skills
