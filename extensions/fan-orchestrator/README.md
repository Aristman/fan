# FAN Orchestrator v5

Multi-agent task decomposition and coordination for FAN.
Портирован из pi-orchestrator с сохранением стабильной архитектуры воркеров.

## Архитектура

- **Pi-style worker lifecycle** — единственный `stallTimer` (сбрасывается на любой stdout), нет жёсткого лимита выполнения
- **Recursive poll** — `setTimeout(2000)` рекурсивно, без ограничений по итерациям
- **RPC JSONL protocol** — stdin/stdout взаимодействие с subprocess: `prompt`, `get_state`, `get_last_assistant_text`
- **Direct id-matching** — ответы сопоставляются по id (PROMPT_ID, STATE_ID, TEXT_ID), без Promise-based resolvers
- **Worker pool** — read-only агенты параллельно (до `parallelWorkers`), write-агенты по одному

## Инструменты (Tools)

| Инструмент | Описание |
|------------|----------|
| `delegate_task` | Запуск одного, цепочки или параллельных воркеров |
| `list_tasks` | Просмотр списка задач с фильтрацией по статусу |
| `cancel_task` | Отмена задачи по ID |
| `classify_task` | Классификация описания задачи для выбора типа агента |
| `TaskCreate` | Создание задачи для отслеживания |
| `TaskUpdate` | Обновление статуса/описания задачи (любые переходы статусов) |
| `TaskClear` | Очистка завершённых и проваленных задач |
| `stop_worker` | Остановка работающего воркера |

## Типы агентов

| Агент | Доступ | Назначение |
|-------|--------|------------|
| 🔍 explore | Read-only | Быстрый поиск файлов, структура кодовой базы |
| 📋 plan | Read-only | Глубокий анализ архитектуры, планирование реализации |
| 🛡️ verify | Read-only | Адверсариальная проверка: сборка, тесты, линт, краевые случаи |
| 🔬 code-research | Read-only | Глубокое READ-ONLY исследование со структурированными отчётами |
| 🔧 implement | Write | Написание нового кода, создание фич, изменения |
| 🐛 bug-fix | Write | Исправление багов: воспроизведение → причина → фикс → проверка |
| 🧪 tests-impl | Write | Написание тестов для нового или модифицированного кода |
| 📝 docs-impl | Write | Создание и обновление документации |

## Slash-команды

| Команда | Описание |
|---------|----------|
| `/orchestrator on` | Включить режим координатора |
| `/orchestrator off` | Выключить режим координатора |
| `/orchestrator status` | Статус: провайдер, воркеры, задачи, агенты |
| `/orchestrator config` | Показать текущую конфигурацию |
| `/orchestrator init` | Интерактивный мастер настройки |
| `/orchestrator mode <auto\|cloud\|local>` | Переключить режим провайдера |
| `/orchestrator retry` | Повторить последнюю проваленную задачу |
| `/orchestrator stop` | Остановить все активные воркеры |
| `/plan <задача>` | Исследовать → Спланировать (документация на русском) |
| `/tasks [статус]` | Доска задач |
| `/agents [scope]` | Список доступных агентов |
| `/delegate <агент> <задача>` | Быстрый запуск одного воркера |

## Конфигурация

Конфиг создаётся через `/orchestrator init`. Файл: `~/.fan/agent/extensions/fan-orchestrator/config.json`.

**Без конфига** оркестратор неактивен (предупреждение при старте сессии).

```json
{
  "cloud": {
    "model": "",
    "models": {
      "explore": "",
      "plan": "",
      "implement": "",
      "verify": "",
      "bug-fix": "",
      "code-research": "",
      "tests-impl": "",
      "docs-impl": ""
    }
  },
  "local": {
    "model": "",
    "models": { "..." : "" }
  },
  "providerMode": "auto",
  "coordinatorDefault": true,
  "parallelWorkers": 3,
  "workerTimeout": 600,
  "stallTimeout": 300,
  "planTimeout": 300,
  "maxRetries": 2,
  "agentTimeouts": {
    "explore": 600,
    "plan": 600,
    "implement": 600,
    "verify": 600
  },
  "dangerousCommands": [
    "rm -rf",
    "git push --force",
    "npm publish",
    "DROP TABLE",
    "TRUNCATE",
    "DELETE FROM",
    "mkfs",
    "shutdown"
  ]
}
```

### Параметры

| Параметр | Тип | По умолч. | Описание |
|----------|-----|-----------|----------|
| `providerMode` | `auto\|cloud\|local` | `cloud` | Режим выбора провайдера. `auto` = cloud с fallback на local |
| `coordinatorDefault` | `boolean` | `true` | Координатор активен при старте сессии |
| `parallelWorkers` | `number` | `3` | Максимум параллельных read-only воркеров |
| `workerTimeout` | `number` | `600` | Максимальное время воркера в секундах (резервный лимит) |
| `stallTimeout` | `number` | `300` | Таймер зависания в секундах (нет stdout данных → kill) |
| `planTimeout` | `number` | `300` | Таймаут /plan в секундах |
| `maxRetries` | `number` | `2` | Количество повторных попыток при ошибке воркера |
| `agentTimeouts` | `object` | `{}` | Перекрытие stallTimeout для конкретных агентов (в секундах) |
| `dangerousCommands` | `string[]` | `[...]` | Паттерны команд, требующие подтверждения |
| `cloud.model` | `string` | `""` | Модель по умолчанию для cloud (пустая = модель сессии) |
| `cloud.models` | `object` | `{}` | Per-agent модели для cloud (пустая = cloud.model → модель сессии) |
| `local.model` | `string` | `""` | Модель по умолчанию для local |
| `local.models` | `object` | `{}` | Per-agent модели для local |

### Цепочка разрешения модели

```
config.{provider}.models[agentName]
  → config.{provider}.model
    → модель текущей сессии
```

## Режим координатора

Переключается: `/orchestrator on/off` или `Alt+O`.

Когда активен, координатор делегирует всю работу воркерам вместо прямого использования инструментов. Промпт координатора динамически генерируется из реестра агентов.

### Типичный рабочий процесс

1. Получить задачу → декомпозировать на подзадачи
2. Запустить explore/plan воркеры для исследования
3. Запустить implement/bug-fix воркер по спецификации
4. Запустить verify воркер для проверки результата
5. Итоговый отчёт: задачи, верификация, найденные проблемы

## Отображение воркера

При работе воркер показывает:
- **Шапка**: иконка агента + тип + модель (отрисовывается фреймворком)
- **Статусная строка**: `Thinking · 5 tools · 3 msgs · 02:35` (обновляется в реальном времени)
- **Список тулов**: последние вызванные инструменты с превью
- **Результат**: полный markdown-текст после завершения

## Система задач

- Задачи создаются автоматически для write-воркеров
- Доска задач отображается в виджете `📋 N/M tasks`
- Любые переходы статусов разрешены (pending → completed, failed → in_progress и т.д.)
- При ошибке обновления задача помечается как `failed`
- Свернуть/развернуть: `Alt+T`

## Безопасность

- **Интерактивный диалог** для опасных команд (bash) — Allow / Block
- **dangerousCommands** — настраиваемые паттерны команд
- **Sanitize** — чувствительные данные (API keys, passwords, tokens) не попадают в память
- **Изолированные воркеры** — `--no-extensions --no-skills --no-prompt-templates`

## Установка

```bash
fan store install fan-orchestrator
```

Затем настроить:
```bash
/orchestrator init
```

## Автор

FAN Team
