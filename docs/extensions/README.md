# Расширения FAN (Extensions)

## Обзор

Расширения FAN — это плагины, расширяющие функциональность FAN через API жизненного цикла, LLM-инструменты, команды и скилы. Они загружаются из директорий расширений и управляются ядром `fan-coding-agent`.

## Архитектура

```
┌────────────────────────────────────────────────────────────────────┐
│                    Core Extension Infrastructure                    │
│              packages/coding-agent/src/core/extensions/            │
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐       │
│  │  loader   │  │  runner  │  │  types   │  │  wrapper    │       │
│  │  .ts      │  │  .ts     │  │  .ts     │  │  .ts        │       │
│  └──────────┘  └──────────┘  └──────────┘  └─────────────┘       │
│                                                                    │
│  Loader: сканирует директории → находит package.json с type:       │
│  "fan-extension" → загружает `.js`-файлы                           │
│  Runner: выполняет lifecycle-хуки (session_start, tool_register,   │
│  command_register, config_validate, tool_call)                     │
│  Types: ExtensionFactory, ExtensionAPI, ToolRegistration,          │
│  CommandRegistration                                                │
│  Wrapper: адаптер/обёртка для совместимости                       │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                    9 Установленных Расширений                      │
│                         extensions/*                               │
│                                                                    │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌────────────────┐    │
│  │ fan-       │ │ fan-       │ │ fan-     │ │ fan-ask-       │    │
│  │ orchestrator│ │persistent- │ │web-search│ │ answer         │    │
│  │            │ │memory      │ │          │ │                │    │
│  └────────────┘ └────────────┘ └──────────┘ └────────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌────────────┐ ┌──────┐│
│  │ fan-soul │ │ fan-     │ │ fan-loop   │ │ stack-     │ │voice-││
│  │          │ │confluence│ │            │ │overflow-   │ │ollama││
│  │          │ │          │ │            │ │agents      │ │-tui  ││
│  └──────────┘ └──────────┘ └────────────┘ └────────────┘ └──────┘│
└────────────────────────────────────────────────────────────────────┘
```

## Инфраструктура

### `packages/coding-agent/src/core/extensions/`

| Файл | Назначение |
|------|-----------|
| `types.ts` | Типы: `ExtensionAPI`, `ExtensionFactory`, `ToolRegistration`, `CommandRegistration`, `LifecycleHooks`, `SessionContext` |
| `loader.ts` | Обнаружение и загрузка расширений. Сканирует `~/.fan/agent/extensions/`, `.fan/extensions/`, встроенные бандлы |
| `runner.ts` | Выполнение lifecycle-хуков в правильном порядке |
| `wrapper.ts` | Адаптер/обёртка |

### Жизненный цикл расширения

1. **Загрузка** — `loader.ts` находит package.json с `type: "fan-extension"`, загружает JS-модуль
2. **Инициализация** — вызывается функция-фабрика расширения (export default)
3. **Регистрация** — расширение регистрирует инструменты, команды, хоткеи
4. **Сессия** — хуки `session_start`, `tool_call`, `config_validate`
5. **Выгрузка** — хук `session_end` (очистка ресурсов)

### Lifecycle Hooks

| Хук | Вызывается | Назначение |
|-----|-----------|-----------|
| `session_start` | При старте сессии | Инициализация, автообновление |
| `tool_register` | При регистрации инструментов | Добавление LLM-инструментов |
| `command_register` | При регистрации команд | Добавление slash-команд |
| `config_validate` | При валидации конфига | Проверка настроек |
| `tool_call` | При вызове инструмента | Перехват/модификация вызова |
| `session_end` | При завершении сессии | Очистка |

## Расширения (extensions/)

Ниже перечислены все 9 расширений, расположенных в корневой директории `extensions/`.

---

### 1. fan-orchestrator — Мульти-агентный оркестратор v6.0.0

**Назначение:** Координация нескольких AI-агентов с разными ролями. Управление задачами, воркерами, очередями.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `orchestrator-extension.js` | Точка входа — скомпилированная фабрика расширения |
| `orchestrator-tools.js` | LLM-инструменты: delegate_task, TaskCreate, TaskUpdate и т.д. |
| `subagent-runner.js` | RPC-коммуникация с под-агентами |
| `task-manager.js` | Управление жизненным циклом задач |
| `agents.js` | Фабрика типов агентов (8 типов) |
| `agents/*.js + *.md` | Каждый тип агента + его system prompt |
| `workers.js` | Пул воркеров (очередь, слоты) |
| `permissions.js` | Управление разрешениями воркеров |
| `config.js + config.json` | Конфигурация (per-worker temperature, лимиты) |
| `prompts/*.md` | Универсальные промпты (implement, verify, plan) |
| `types.js` | Типы TypeScript |
| `README.md` | Документация |

**Типы агентов:** explore, plan, implement, verify, bug-fix, code-research, docs-impl, tests-impl

**Особенности:**
- Per-worker температура и лимиты
- Loop prevention (защита от бесконечных циклов)
- Динамический координаторский промпт
- RPC-воркеры (под-агенты в отдельных процессах)

---

### 2. fan-persistent-memory — Персистентная память v4.0.0

**Назначение:** Гибридное RAG-хранилище (FTS4 + embeddings) для долговременной памяти агента с автоматическим извлечением знаний.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `src/index.ts` | Точка входа |
| `src/config.ts` | Конфигурация |
| `src/types.ts` | Типы |
| `src/storage/database.ts` | SQLite через sql.js |
| `src/storage/repositories.ts` | Repository pattern |
| `src/rag/fts-engine.ts` | FTS4 (полнотекстовый поиск) |
| `src/rag/embeddings.ts` | Генерация эмбеддингов |
| `src/rag/vector-store.ts` | Векторное хранилище |
| `src/rag/retriever.ts` | Гибридный поиск (FTS + эмбеддинги) |
| `src/intelligence/auto-extract.ts` | Автоматическое извлечение знаний из диалогов |
| `src/maintenance/pipeline.ts` | Компактификация и очистка |
| `src/tools/memory-tools.ts` | LLM-инструменты памяти |
| `src/commands/memory.ts` | `/memory` slash-команда |
| `README.md` | Документация |

**Хранилище:** SQLite (sql.js) с FTS4 + эмбеддингами
**Гибридный поиск:** Комбинация FTS (ключевые слова) + embedding similarity (семантика)

---

### 3. fan-web-search — Веб-поиск v1.7.0

**Назначение:** Мульти-провайдерный веб-поиск с chain of fallback. Поддерживает Brave, SearXNG, Yandex, Z.AI, meta-search.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа |
| `config.ts` | Конфигурация |
| `types.ts` | Типы |
| `tools.ts` | LLM-инструменты: web_search, web_read |
| `provider-chain.ts` | Логика fallback — попытка провайдеров по приоритету |
| `providers/brave.ts` | Brave Search API |
| `providers/searxng.ts` | SearXNG |
| `providers/yandex.ts` | Yandex Search |
| `providers/zai.ts` | Z.AI Search |
| `providers/meta-search.ts` | Meta-search (агрегатор) |
| `providers/reader/*.ts` | HTML-to-Markdown конвертер + raw fetch |
| `format.ts` | Форматирование результатов |
| `tls.ts` | TLS настройки |
| `README.md` | Документация |

**Chain of fallback:** Пытается провайдеров в порядке приоритета → при ошибке переходит к следующему

---

### 4. fan-soul — Личность и профиль агента v1.0.0

**Назначение:** Динамическое управление личностью агента (SOUL.md) и профилем оператора (USER.md). Автоматическое извлечение и обновление.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа |
| `types.ts` | Типы |
| `drafts.ts` | Создание черновиков души |
| `extractor.ts` | Логика извлечения личности |
| `soul-files.ts` | I/O для soul-файлов |
| `README.md` | Документация |

---

### 5. fan-ask-answer — Интерактивный диалог v1.1.0

**Назначение:** Интерактивные вопросники для пользователя через TUI/RPC — `ask_question` и `ask_questionnaire` инструменты.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа — регистрирует инструменты question/questionnaire |
| `README.md` | Документация |

---

### 6. fan-confluence — Confluence Data Center v2.0.0

**Назначение:** Интеграция с Atlassian Confluence Data Center — чтение, запись, конвертация Markdown ↔ Confluence Storage Format.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа |
| `config.ts` | Конфигурация (URL, токен) |
| `client.ts` | REST API клиент Confluence |
| `converters/md-to-storage.ts` | Markdown → Confluence Storage Format (XML) |
| `converters/storage-to-md.ts` | Confluence Storage Format → Markdown |
| `tools/errors.ts` | Типы ошибок |
| `tests/converters.test.ts` | Тесты конвертеров |
| `README.md` | Документация |

**Зависимости:** turndown (HTML→MD), marked (MD→HTML)

---

### 7. fan-loop — Итеративный цикл v1.0.0

**Назначение:** Автономное итеративное выполнение задач до достижения критериев приёмки. Loop-механизм.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа |
| `loop-controller.ts` | Логика управления циклом |
| `types.ts` | Типы |
| `config.json` | Дефолтная конфигурация |
| `README.md` | Документация |

**Особенности:**
- Запускает итерации до выполнения acceptance criteria
- Проверка результатов после каждой итерации
- Лимит итераций (защита от бесконечного цикла)

---

### 8. stack-overflow-agents — Stack Overflow для агентов v1.1.0

**Назначение:** Гибрид (расширение + скил) для работы со Stack Overflow for Agents (SOFA) — поиск, чтение, голосование, создание постов.

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа расширения |
| `SKILL.md` | Скил-файл (расширение также является скилом) |
| `config.ts` | Конфигурация |
| `client.ts` | SOFA API клиент |
| `types.ts` | Типы |
| `utils.ts` | Утилиты |
| `tools/contribute.ts` | Инструмент создания постов |
| `tools/search-read.ts` | Инструмент поиска и чтения |
| `README.md` | Документация |

**Особенности:** Расширение регистрирует LLM-инструменты для работы с SOFA. SKILL.md делает его доступным как скил через `/skill:stack-overflow-agents`.

---

### 9. voice-ollama-tui — Голосовой ввод v2.4.0

**Назначение:** Голосовой ввод через Ollama/whisper.cpp — запись микрофона → распознавание (whisper) → улучшение (Ollama).

**Ключевые файлы:**

| Файл | Назначение |
|------|-----------|
| `index.ts` | Точка входа |
| `config.ts` + `config.test.ts` | Конфигурация + тесты |
| `audio-recorder.ts` + `.test.ts` | Запись аудио через ffmpeg |
| `bin-manager.ts` + `.test.ts` | Управление бинарными зависимостями |
| `whisper-service.ts` + `.test.ts` | Интеграция whisper.cpp |
| `ollama-service.ts` + `.test.ts` | Улучшение текста через Ollama |
| `pipeline.ts` + `.test.ts` | Полный пайплайн аудио→текст |
| `model-downloader.ts` + `.test.ts` | Загрузка whisper-моделей |
| `dependencies.ts` + `.test.ts` | Проверка зависимостей |
| `init-wizard.ts` + `.test.ts` | `/voice init` — мастер настройки |
| `ui-overlay.ts` + `.test.ts` | TUI-оверлей записи |
| `errors.ts` | Типы ошибок |
| `smoke.test.ts` | Smoke-тесты |
| `README.md` | Документация |
| `vitest.config.ts` | Vitest конфиг |

**Пайплайн:** Микрофон → ffmpeg (WAV) → whisper.cpp (текст) → Ollama (улучшение/контекст)

## Документация и примеры

| Файл | Назначение |
|------|-----------|
| `packages/coding-agent/docs/extensions.md` | Полная документация: создание, lifecycle, API reference |
| `packages/coding-agent/examples/extensions/` | 6+ примеров расширений (command, event, gate, tool, ui, multi) |
| `packages/coding-agent/examples/rpc-extension-ui.ts` | Пример RPC-расширения с UI |
| `packages/coding-agent/examples/sdk/06-extensions.ts` | SDK-пример для расширений |

## Тесты

| Файл | Назначение |
|------|-----------|
| `packages/coding-agent/test/extensions-discovery.test.ts` | Тест обнаружения расширений |
| `packages/coding-agent/test/extensions-runner.test.ts` | Тест runner'а |
| `packages/coding-agent/test/extensions-input-event.test.ts` | Тест input-ивентов |

## Структура package.json расширения

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "type": "fan-extension",
  "main": "index.js",
  "fan": {
    "name": "my-extension",
    "type": "extension",
    "version": "1.0.0",
    "bundled": false
  }
}
```
