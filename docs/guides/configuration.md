# Руководство по конфигурации

Полный справочник по всем параметрам конфигурации FAN.

## Обзор конфигурационных файлов

| Файл | Расположение | Назначение |
|------|----------|---------|
| `.env` | Корень проекта | API-ключи и переменные окружения |
| `settings.json` | `~/.fan/agent/settings.json` | Глобальные настройки (все проекты) |
| `settings.json` | `<project>/.fan/settings.json` | Переопределения для конкретного проекта |
| `models.json` | `~/.fan/agent/models.json` | Пользовательские определения моделей |
| `config.json` | `packages/orchestrator/src/config.json` | Конфигурация мульти-агентного оркестратора |

## Правила приоритета

**Флаги CLI** > **Настройки проекта** > **Глобальные настройки** > **Значения по умолчанию**

Вложенные объекты объединяются рекурсивно (поддерживаются частичные переопределения).

## Переменные окружения

### API-ключи провайдеров ИИ

| Провайдер | Переменная FAN | Стандартная переменная |
|----------|-------------|-------------------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY` |
| Google Cloud (Vertex) | `GOOGLE_CLOUD_API_KEY` | — |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | — |
| Groq | `GROQ_API_KEY` | — |
| xAI | `XAI_API_KEY` | — |
| OpenRouter | `OPENROUTER_API_KEY` | — |
| Mistral | `MISTRAL_API_KEY` | — |
| Cerebras | `CEREBRAS_API_KEY` | — |
| DeepSeek | `DEEPSEEK_API_KEY` | — |
| Z.AI | `ZAI_API_KEY` | — |
| MiniMax | `MINIMAX_API_KEY` | — |
| Kimi | `KIMI_API_KEY` | — |
| Qwen (Aliyun Token Plan) | `QWEN_API_KEY` | — |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | — |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | `GH_TOKEN`, `GITHUB_TOKEN` |

Ключи также можно задавать для каждого провайдера в `models.json` через `apiKey` (имеет приоритет над переменными окружения) или через поле `envVar`, чтобы явно указать имя переменной окружения.

### Флаги среды выполнения

| Переменная | По умолчанию | Описание |
|----------|---------|-------------|
| `FAN_CODING_AGENT_DIR` | `~/.fan/agent` | Пользовательский каталог агента |
| `FAN_CACHE_RETENTION` | `"default"` | `"long"` для 24-часового TTL кэша Anthropic |
| `FAN_CLEAR_ON_SHRINK` | `"0"` | `"1"` для очистки пустых строк при сжатии |
| `FAN_HARDWARE_CURSOR` | `"0"` | `"1"` для отображения аппаратного курсора |

### Сервер и развёртывание

Переменные серверного режима (`fan server` / `fan --web` / Docker). Реализация: `packages/coding-agent/src/cli/server-config.ts`, `packages/api-gateway/src/cors-config.ts`, `packages/coding-agent/src/utils/file-logger.ts`. См. [Deployment Guide](deployment.md).

| Переменная | По умолчанию | Описание |
|----------|---------|-------------|
| `PORT` | `3456` | Порт сервера. Флаг `--port` переопределяет; некорректные значения возвращают значение по умолчанию |
| `HOST` | `"localhost"` | Хост привязки. Флаг `--host` переопределяет; используйте `0.0.0.0` внутри контейнеров |
| `FAN_WORKSPACE_ROOT` | `~/projects` | Корень рабочей области для серверного режима (F-1.11). Рабочий каталог по умолчанию для сессий, созданных без явного `cwd`, и белый список каталогов для `POST /api/sessions` — `cwd` за его пределами отклоняется с кодом 403 (F-1.13, с учётом symlink). Не установлена/пустая → `~/projects`. В контейнере устанавливается `/data/repos` |
| `FAN_PUBLIC` | не установлена | Публичный режим: `"1"`/`"true"`/`"yes"`/`"on"` делает обязательной аутентификацию по токену и игнорирует `FAN_NO_AUTH`. Нераспознанные значения трактуются как публичный режим (с предупреждением в stderr) |
| `ALLOWED_ORIGINS` | `"*"` | Белый список CORS — origins через запятую (пробелы обрезаются, пустые записи отбрасываются). `"*"` = полностью открыто (локальная разработка) |
| `LOG_DIR` | не установлена | Каталог для файлового логирования (`app.log` + ротация). Не установлена/пустая = файловое логирование отключено (только консоль). В контейнере устанавливается `/data/logs` |
| `LOG_LEVEL` | `"info"` | Детализация файловых логов: `error` \| `warn` \| `info` \| `debug`. Консольный вывод всегда передаётся без изменений |
| `LOG_MAX_SIZE` | `10485760` (10 MB) | Ротировать `app.log` при достижении этого размера. Число в байтах или суффикс `k`/`m`/`g` (например, `"5m"`) |
| `LOG_MAX_FILES` | `5` | Количество ротируемых файлов для хранения: `app.log.1` … `app.log.N` (самые старые удаляются) |

**Постоянная очередь сообщений (F-5.5/F-5.6).** В серверном режиме очередь диспетчера WS **по умолчанию является постоянной** (`PersistentMessageQueue`): поставленные в очередь payloads `sendMessage` сохраняются как JSONL в `<agentDir>/queues` (`FAN_CODING_AGENT_DIR` / `FAN_AGENT_DIR`, по умолчанию `~/.fan/agent`) и восстанавливаются при запуске (WS-фрейм `queues_restored`). Без переменной окружения — opt-out программно через `ServerOptions.persistentQueue: false` (унаследованная очередь в памяти). Подробности: [API Reference — Message Queueing](api-reference.md#message-queueing-phases-2--5).

**Токены по проектам (F-5.7).** Клиентские токены принимают необязательный `projectScope` при создании (`POST /api/tokens { "name", "projectScope" }`), ограничивая их одним проектом (принудительное применение, политика блокировки и правила анти-эскалации: [API Reference — Project Scope](api-reference.md#project-scope-f-57)). Существующие токены (`projectScope: null`) сохраняют полный доступ.

## Справочник настроек

### Конфигурация модели

| Параметр | Тип | По умолчанию | Описание |
|---------|------|---------|-------------|
| `defaultProvider` | `string` | — | Провайдер ИИ по умолчанию |
| `defaultModel` | `string` | — | ID модели по умолчанию |
| `defaultThinkingLevel` | `"off"`\|`"minimal"`\|`"low"`\|`"medium"`\|`"high"`\|`"xhigh"` | — | Бюджет мышления |

```json
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514", "defaultThinkingLevel": "medium" }
```

### Настройки для конкретных моделей

Переопределения для отдельных моделей по ключу `"provider/model-id"`. Хранятся в Prisma DB через Dashboard/API.

| Поле | Тип | Описание |
|-------|------|-------------|
| `temperature` | `number` | Температура сэмплирования (0–2) |
| `maxTokens` | `number` | Максимальное количество выходных токенов |
| `thinking` | `"off"`\|`"minimal"`\|`"low"`\|`"medium"`\|`"high"`\|`"xhigh"` | Бюджет мышления |

```json
{ "modelSettings": { "anthropic/claude-sonnet-4-20250514": { "temperature": 0.3, "thinking": "medium" } } }
```

### Правила маршрутизации

Маршрутизация по первому совпадению к предпочтительным провайдерам.

| Поле | Тип | Описание |
|-------|------|-------------|
| `name` | `string` | Имя правила |
| `provider` | `string` | Целевой провайдер |
| `model` | `string` | Целевая модель |
| `fallback` | `string?` | Запасной провайдер/модель |
| `enabled` | `boolean?` | Активно (по умолчанию: `true`) |

```json
{ "routingRules": [{ "name": "Cheap tasks", "provider": "groq", "model": "gpt-oss-20b", "fallback": "openai/gpt-5-mini" }] }
```

### Бюджет

| Поле | Тип | Описание |
|-------|------|-------------|
| `dailyTokenLimit` | `number?` | Максимум токенов в день |
| `dailyCostLimit` | `number?` | Максимум расходов в день (USD) |
| `monthlyTokenLimit` | `number?` | Максимум токенов в месяц |
| `monthlyCostLimit` | `number?` | Максимум расходов в месяц (USD) |

### Сессии и поведение

| Параметр | Тип | По умолчанию | Описание |
|---------|------|---------|-------------|
| `sessionDir` | `string?` | — | Пользовательский каталог сессий |
| `hideThinkingBlock` | `boolean` | `false` | Скрывать блоки мышления |
| `steeringMode` | `"all"`\|`"one-at-a-time"` | `"one-at-a-time"` | Обработка множественных вызовов инструментов |
| `followUpMode` | `"all"`\|`"one-at-a-time"` | `"one-at-a-time"` | Обработка follow-up запросов |
| `collapseChangelog` | `boolean` | `false` | Сжатый changelog |
| `quietStartup` | `boolean` | `false` | Подавить стартовые сообщения |

### Терминал и отображение

| Параметр | Тип | По умолчанию | Описание |
|---------|------|---------|-------------|
| `theme` | `string?` | — | Имя темы UI |
| `terminal.showImages` | `boolean` | `true` | Показывать изображения в терминале |
| `images.autoResize` | `boolean` | `true` | Масштабировать изображения до 2000×2000 |
| `images.blockImages` | `boolean` | `false` | Блокировать изображения от провайдеров |
| `markdown.codeBlockIndent` | `string` | `"  "` | Отступ блоков кода |
| `editorPaddingX` | `number` | `0` | Отступ редактора (0–3) |
| `autocompleteMaxVisible` | `number` | `5` | Видимые элементы автодополнения (3–20) |
| `doubleEscapeAction` | `"fork"`\|`"tree"`\|`"none"` | `"tree"` | Действие по двойному Escape |
| `treeFilterMode` | `"default"`\|`"no-tools"`\|`"user-only"`\|`"labeled-only"`\|`"all"` | `"default"` | Фильтр `/tree` |
| `showHardwareCursor` | `boolean` | `false` | Показывать аппаратный курсор |

### Сжатие (Compaction)

| Параметр | Тип | По умолчанию | Описание |
|---------|------|---------|-------------|
| `compaction.enabled` | `boolean` | `true` | Включить авто-сжатие |
| `compaction.reserveTokens` | `number` | `16384` | Токены, зарезервированные для промпта |
| `compaction.keepRecentTokens` | `number` | `20000` | Недавние токены для сохранения |

### Повторные попытки (Retry)

| Параметр | Тип | По умолчанию | Описание |
|---------|------|---------|-------------|
| `retry.enabled` | `boolean` | `true` | Включить авто-повтор |
| `retry.maxRetries` | `number` | `3` | Максимальное число попыток |
| `retry.baseDelayMs` | `number` | `2000` | Базовая задержка backoff (мс) |
| `retry.maxDelayMs` | `number` | `60000` | Максимальная задержка backoff (мс) |

### Бюджеты мышления

Пользовательские значения токенов: `thinkingBudgets.minimal`, `.low`, `.medium`, `.high` (все `number?`).

### Расширения и навыки

| Параметр | Тип | Описание |
|---------|------|-------------|
| `extensions` | `string[]` | Пути или каталоги расширений |
| `skills` | `string[]` | Пути или каталоги навыков |
| `enableSkillCommands` | `boolean` | Зарегистрировать как `/skill:name` (по умолчанию: `true`) |
| `prompts` | `string[]` | Пути к шаблонам промптов |
| `themes` | `string[]` | Пути к темам |
| `packages` | `PackageSource[]` | npm/git пакеты (строка или `{ source, extensions?, skills?, ... }`) |

> **Предустановленные навыки:** FAN поставляется с 8 навыками в `skills/` (auto-tests, bug-fix, code-research, deep-dive, fan-forge, idea-lab, repo-explorer, research-spec-generator). Они загружаются автоматически. Дополнительные навыки можно установить через FAN Store (`fan store install <name>`).

### Расширенные настройки

| Параметр | Тип | Описание |
|---------|------|-------------|
| `shellPath` | `string?` | Пользовательская оболочка (например, `/bin/zsh`) |
| `shellCommandPrefix` | `string?` | Префикс для команд оболочки |
| `npmCommand` | `string[]?` | argv команды npm (например, `["mise", "exec", "node@20", "--", "npm"]`) |
| `transport` | `"sse"`\|`"websocket"` | Транспортный протокол (по умолчанию: `"sse"`) |
| `enabledModels` | `string[]?` | Паттерны моделей для переключения |

## Конфигурация моделей (`models.json`)

`~/.fan/agent/models.json` — пользовательские модели и переопределения провайдеров.

Для встроенных провайдеров (например, `zai`, `openai`, `anthropic`) можно добавить новые модели только по ID — `baseUrl` и `api` наследуются:

```json
{
  "providers": {
    "zai": {
      "models": [
        { "id": "glm-5-turbo" },
        { "id": "glm-5" }
      ]
    }
  }
}
```

Для пользовательских провайдеров укажите `baseUrl`, `api` и опционально `apiKey` или `envVar`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "qwen3:32b",
          "name": "Qwen 3 32B (local)",
          "reasoning": true,
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "anthropic": {
      "baseUrl": "https://custom-proxy.example.com",
      "apiKey": "sk-ant-...",
      "modelOverrides": {
        "claude-sonnet-4-20250514": { "name": "Claude (proxy)", "contextWindow": 200000 }
      }
    }
  }
}
```

### Конфигурация провайдера

| Поле | Тип | Описание |
|-------|------|-------------|
| `baseUrl` | `string?` | Переопределить базовый URL API |
| `apiKey` | `string?` | API-ключ (переопределяет переменную окружения) |
| `api` | `string?` | Тип API: `"openai-completions"`, `"openai-responses"`, `"anthropic"` и т.д. |
| `headers` | `Record<string, string>?` | Дополнительные HTTP-заголовки |
| `compat` | `object?` | Настройки совместимости |
| `authHeader` | `boolean?` | Использовать заголовок Authorization |
| `envVar` | `string?` | Имя переменной окружения для API-ключа данного провайдера |
| `models` | `ModelDef[]?` | Пользовательские определения моделей |
| `modelOverrides` | `Record<string, override>?` | Настройки для конкретных моделей по ID |

Примечания:
- Для **встроенных провайдеров** (например, `zai`, `openai`, `anthropic`), записи в `models` нуждаются только в `id` — `baseUrl` и `api` наследуются от существующих встроенных моделей.
- Для **пользовательских провайдеров** `baseUrl` и `api` обязательны, если провайдер не наследуется от встроенного.

### Определение модели

| Поле | Тип | Описание |
|-------|------|-------------|
| `id` | `string` **(обязательно)** | Идентификатор модели |
| `name` | `string?` | Отображаемое имя |
| `api` | `string?` | Протокол API |
| `baseUrl` | `string?` | URL для конкретной модели |
| `reasoning` | `boolean?` | Поддерживает мышление |
| `input` | `("text"\|"image")[]?` | Модальности ввода |
| `cost` | `object?` | За 1M токенов: `{ input, output, cacheRead, cacheWrite }` |
| `contextWindow` | `number?` | Максимальный контекст (токены) |
| `maxTokens` | `number?` | Максимальное количество выходных токенов |

Переопределения используют те же поля (все необязательные) и глубоко объединяются со встроенными значениями.

## Конфигурация оркестратора

`packages/orchestrator/src/config.json` — конфигурация мульти-агентной системы.

| Поле | Тип | По умолчанию | Описание |
|-------|------|---------|-------------|
| `cloud.model` | `string` | — | Облачная модель (например, `"anthropic/claude-sonnet-4-20250514"`) |
| `cloud.provider` | `string?` | — | Облачный провайдер (определяется автоматически, если не указан) |
| `local.model` | `string` | — | Локальная модель (например, `"ollama/qwen3:32b"`) |
| `local.provider` | `string?` | — | Локальный провайдер (определяется автоматически, если не указан) |
| `providerMode` | `"cloud"`\|`"local"` | `"cloud"` | Активный набор провайдеров |
| `parallelWorkers` | `number` | `3` | Максимум параллельных воркеров |
| `workerTimeout` | `number` | `300000` | Таймаут воркера (мс) |
| `maxRetries` | `number` | `2` | Количество повторных попыток |
| `planTimeout` | `number` | `300000` | Таймаут планирования (мс) |
| `agentTimeouts` | `Record<WorkerType, number>` | — | По типам: `explore`, `plan`, `implement`, `verify` |
| `dangerousCommands` | `string[]` | — | Команды, требующие подтверждения |

## Типовые конфигурации

### Только локальная работа (офлайн)

```jsonc
{ "defaultProvider": "ollama", "defaultModel": "qwen3:32b", "budget": { "dailyTokenLimit": 500000 } }
```

### Только облако

```jsonc
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium", "budget": { "dailyCostLimit": 10.0, "monthlyCostLimit": 100.0 } }
```

### Гибридный (облако + локальный fallback)

```jsonc
// settings.json
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514",
  "routingRules": [{ "name": "Fallback", "provider": "ollama", "model": "qwen3:32b" }] }
// config.json
{ "cloud": { "model": "anthropic/claude-sonnet-4-20250514" },
  "local": { "model": "ollama/qwen3:32b" }, "providerMode": "cloud" }
```

### Экономия бюджета

```jsonc
{ "defaultProvider": "groq", "defaultModel": "gpt-oss-20b", "defaultThinkingLevel": "low",
  "budget": { "dailyTokenLimit": 200000, "dailyCostLimit": 2.0, "monthlyCostLimit": 30.0 },
  "routingRules": [{ "name": "Complex", "provider": "anthropic", "model": "claude-sonnet-4-20250514" }] }
```

### Мульти-провайдер

```jsonc
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514",
  "modelSettings": { "anthropic/claude-sonnet-4-20250514": { "thinking": "medium" }, "openai/gpt-5-mini": { "temperature": 0.5 } },
  "routingRules": [
    { "name": "Fast", "provider": "groq", "model": "gpt-oss-20b" },
    { "name": "Vision", "provider": "openai", "model": "gpt-5-mini" },
    { "name": "Reasoning", "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
  ] }
```

## Быстрая настройка

Запустите **`fan init`** для интерактивного мастера настройки (провайдер, API-ключи, бюджет, уровень мышления).

Или используйте **Dashboard** по адресу `http://localhost:5174` (`cd packages/dashboard && npm run dev`) для визуальной настройки моделей, маршрутизации и бюджета.
