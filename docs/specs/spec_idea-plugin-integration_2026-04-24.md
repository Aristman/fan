# Спецификация: Интеграция FAN Agent в IntelliJ Platform Plugin

## Метаданные
- **Дата**: 2026-04-24
- **Автор**: Specification Generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Интеграция
- **Связанные документы**: [spec_runtime-agent_2026-04-10.md](./spec_runtime-agent_2026-04-10.md), [api-reference.md](../guides/api-reference.md)

## 1. Обзор

### 1.1 Цель
Создать плагин для IntelliJ Platform, который интегрирует FAN Agent (Filin Agent Next) во все JetBrains IDE — PyCharm, WebStorm, GoLand, Rider, IntelliJ IDEA CE/UE и другие. Плагин предоставляет чат-интерфейс с AI-агентом, отображение файловых операций в редакторе и контекстную интеграцию с открытым кодом.

### 1.2 Контекст
FAN Runtime — локальный AI runtime-agent, который запускается на машине пользователя и предоставляет HTTP REST + WebSocket API (14 REST-эндпоинтов, стриминг через WS). Текущие клиенты: TUI (fan-tui), Dashboard (Lit web UI). IntelliJ Plugin — следующий клиент, работающий через тот же FAN API Gateway.

```
┌──────────────────────────────────────────────────────────┐
│                   FAN Runtime (localhost:3456)            │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │ Agent Loop │  │ Orchestr.  │  │ Model Manager      │ │
│  │ Tools      │  │ Extension  │  │ Router/Fallback    │ │
│  └─────┬──────┘  └─────┬──────┘  └──────┬─────────────┘ │
│        └───────────────┼────────────────┘                │
│                    API Gateway                           │
│              ┌──────────────────┐                        │
│              │ Hono REST + WS   │                        │
│              └────────┬─────────┘                        │
└───────────────────────┼──────────────────────────────────┘
                        │ HTTP + WebSocket
          ┌─────────────┼─────────────┐
          │             │             │
     ┌────┴────┐  ┌────┴────┐  ┌────┴──────────┐
     │  TUI    │  │Dashboard│  │ IntelliJ Plugin│
     │ (fan-tui│  │  (Lit)  │  │   (Kotlin)    │
     └─────────┘  └─────────┘  └───────────────┘
```

### 1.3 Описание решения
Плагин представляет собой стандартный IntelliJ Platform Plugin на Kotlin, подключающийся к запущенному FAN Server через HTTP REST и WebSocket. Основной UI — Tool Window с двумя видами: **Session List** (список сессий — первый/дефолтный вид) и **Chat** (чат — открывается при выборе или создании сессии). Файловые операции агента (read/write/edit) отображаются инлайново в редакторе. Контекст текущего файла и выделения автоматически прикрепляется к сообщениям.

## 2. Функциональные требования

### 2.1 Требования к фазам (обзор)

| Фаза | Название | Срок (оценка) | Зависимости |
|------|----------|---------------|-------------|
| 1 | Core Connection + Chat MVP | 2–3 недели | FAN Server запущен |
| 2 | File Operations + Editor Integration | 1–2 недели | Фаза 1 |
| 3 | IDE Context Integration | 1 неделя | Фаза 1 |
| 4 | Enhanced Features | 2 недели | Фаза 1 |
| 5 | Advanced Integration | 2–3 недели | Фазы 2–4 |

Каждая фаза **независимо поставляется** и приносит пользовательскую ценность.

---

## Фаза 1: Core Connection + Chat MVP

### 2.1.1 Управление подключением к серверу

- **Автоопределение сервера**: проверка `~/.fan/agent/server.json` — чтение `pid`, `port`, `host`, `token`
- **Проверка здоровья**: `GET /api/health` → статус `ok`/`degraded`
- **Автозапуск (опционально)**: если сервер не запущен — предложить запустить (`fan server start`)
- **Ручная конфигурация**: URL сервера и токен вводятся в Settings (для нестандартных портов/хостов)
- **Постоянное подключение**: reconnect при разрыве (экспоненциальный backoff 1с → 30с, max 10 попыток)
- **Статус подключения**: индикатор в Tool Window (зелёный/жёлтый/красный)

#### Пользовательские сценарии

**Сценарий 1.1: Первый запуск**
**Предусловия:** FAN Server не запущен, `server.json` отсутствует
**Шаги:**
1. Пользователь открывает Tool Window «FAN»
2. Плагин проверяет `~/.fan/agent/server.json` — не найден
3. Отображается Welcome-экран: «FAN Server не найден. Запустить?»
4. Пользователь нажимает «Запустить»
5. Плагин выполняет `fan server start` (через ProcessBuilder)
6. Проверяет `GET /api/health` (до 10 попыток с задержкой 1с)
7. При успехе — автоматически создаёт токен (`POST /api/tokens { "name": "IntelliJ" }`)
8. Сохраняет токен в persistent settings
9. Переключается на экран чата
**Ожидаемый результат:** подключение установлено, токен сохранён, чат готов к работе

**Сценарий 1.2: Сервер уже запущен**
**Предусловия:** FAN Server запущен, `server.json` существует
**Шаги:**
1. Пользователь открывает Tool Window «FAN»
2. Плагин читает `server.json` → `port`, `host`, `token` (если есть)
3. Проверяет `GET /api/health` → `200 OK`
4. Если `token` отсутствует в `server.json` — используется сохранённый в IDE settings
5. Отображает Session List со списком всех сессий
**Ожидаемый результат:** мгновенное подключение, пользователь видит список всех сессий

**Сценарий 1.3: Разрыв подключения**
**Предусловия:** чат активен, сервер перестаёт отвечать
**Шаги:**
1. Плагин обнаруживает разрыв (WS close / health check timeout)
2. Индикатор переключается на «жёлтый» (переподключение)
3. Экспоненциальный backoff reconnect
4. После восстановления — индикатор «зелёный», WS переподключён
5. Если max retries исчерпан — «красный», кнопка «Переподключить»
**Ожидаемый результат:** автоматическое восстановление, уведомление пользователя при неудаче

### 2.1.2 Чат: отправка и получение сообщений

- **Отправка**: `POST /api/sessions/:id/messages { message, streamingBehavior? }`
- **Получение**: WS-подписка `ws://host:port/api/ws/:sessionId?token=token`
- **Стриминг текста**: обработка `agent_event` с вложенными событиями (см. жизненный цикл ниже)
- **Отображение thinking**: сворачиваемый блок с «размышлениями» модели (аналог Dashboard)
- **Markdown-рендеринг**: рендеринг ответов агента (код-блоки, таблицы, списки)
- **Отмена генерации**: кнопка Stop (прерывает текущий поток, отписывается от WS)
- **Переподключение при смене сессии**: разрыв текущего WS → подключение к новому sessionId

#### Жизненный цикл стриминг-событий

Все события от агента доставляются через единственный WS-тип `agent_event`. Вложенное поле `event` содержит конкретный тип `AgentEvent` (определён в `packages/agent/src/types.ts:326-341`):

```
agent_start
  └→ turn_start
       └→ message_start { message: AgentMessage }
       │    └→ message_update { message, assistantMessageEvent }
       │         └→ assistantMessageEvent.type:
       │              - thinking_start / thinking_delta / thinking_end
       │              - text_start / text_delta / text_end
       │              - toolcall_start / toolcall_delta / toolcall_end
       └→ tool_execution_start  { toolName, toolCallId, args }
       └→ tool_execution_update { toolName, toolCallId, args, partialResult }
       └→ tool_execution_end    { toolName, toolCallId, result, isError }
       └→ message_end { message: AgentMessage }
  └→ turn_end { message, toolResults }
  └→ agent_end { messages }
```

**WS-протокол обёртка** — каждое событие доставляется в формате:
```json
{
  "type": "agent_event",
  "sessionId": "...",
  "timestamp": "...",
  "event": {
    "type": "message_update",
    "message": { ... },
    "assistantMessageEvent": {
      "type": "text_delta",
      "delta": "текст ответа",
      "contentIndex": 0,
      "partial": { ... }
    }
  }
}
```

> **Важно:** `text_delta` и `thinking_delta` — это **не** топ-уровневые WS-события. Они являются подтипами `AssistantMessageEvent`, вложенными в `message_update` через поле `assistantMessageEvent`.

Реализация: `FanWsClient` аналогичен Dashboard-реализации (`packages/dashboard/src/api/ws-client.ts`), но на Kotlin с OkHttp WebSocket.

### 2.1.3 Управление сессиями

- **Список сессий**: `GET /api/sessions` → Session List (первый/дефолтный вид в Tool Window)
- **Создание сессии**: ввод сообщения в text field на Session List → `POST /api/sessions { title? }` + отправка сообщения
- **Переключение сессии**: клик в Session List → `GET /api/sessions/:id` (загрузка истории) + WS reconnect → Chat View
- **Навигация назад**: кнопка «← Sessions» в app bar Chat View → возврат к Session List
- **Удаление сессии**: контекстное меню → `DELETE /api/sessions/:id`
- **Автозагрузка**: при старте IDE — восстановить последнюю активную сессию (persist в IDE settings)

#### Пользовательские сценарии

**Сценарий 1.4: Новый чат**
**Предусловия:** подключение установлено, открыт Session List
**Шаги:**
1. Пользователь вводит сообщение в text field в нижней части Session List
2. `POST /api/sessions` → получение `id` (создание новой сессии)
3. WS подключение к новой сессии
4. `POST /api/sessions/:id/messages { message: "..." }`
5. Session List заменяется на Chat View с новой сессией
6. Стриминг ответа через WS
**Ожидаемый результат:** ответ отображается в реальном времени, история сохраняется

**Сценарий 1.5: Переключение между сессиями**
**Предусловия:** есть 3+ сессии, открыт Chat View одной из них
**Шаги:**
1. Пользователь нажимает «← Sessions» в app bar (вверху Chat View)
2. Chat View заменяется на Session List
3. Пользователь кликает на другую сессию
4. Текущий WS закрывается
5. `GET /api/sessions/:id` → загрузка истории сообщений
6. Новый WS подключение, Session List заменяется на Chat View выбранной сессии
**Ожидаемый результат:** мгновенное переключение, полная история загружена

### 2.1.4 Критерии приёмки Фазы 1

| # | Критерий | Статус |
|---|----------|--------|
| 1.1 | Tool Window «FAN» отображается в боковой панели | |
| 1.2 | Автоопределение сервера через `server.json` | |
| 1.3 | Ручной ввод URL/token в Settings | |
| 1.4 | Health check с индикатором статуса | |
| 1.5 | Автозапуск сервера через `fan server start` | |
| 1.6 | Автоматическое создание токена при первом подключении | |
| 1.7 | Отправка сообщений (REST) | |
| 1.8 | Стриминг ответов (WebSocket) | |
| 1.9 | Отображение thinking-блоков (сворачиваемые) | |
| 1.10 | Markdown-рендеринг ответов | |
| 1.11 | Список/создание/удаление/переключение сессий | |
| 1.12 | Auto-reconnect при разрыве WebSocket | |
| 1.13 | Отмена генерации (Stop button) | |
| 1.14 | Сохранение последней сессии между перезапусками IDE | |
| 1.15 | Совместимость с IntelliJ IDEA 2023.2+ | |

### 2.1.5 Риски Фазы 1

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| FAN Server не установлен на машине пользователя | Высокая | Критичное | Welcome-экран с инструкцией установки + ссылка на INSTALL.md; автоустановка в перспективе |
| Несовместимость версий API при обновлении FAN | Средняя | Высокое | Versioned API (`/api/v1/` в будущем), fallback при ошибках; хранить API version в server.json |
| Проблемы с автозапуском сервера (PATH, permissions) | Средняя | Среднее | Настройка PATH к `fan` binary; fallback на ручной запуск |
| Swing UI сложнее чем Lit/Web | Средняя | Среднее | Использовать JBUI (JetBrains UI kit), Intentional UI Builder |
| Долгий стриминг блокирует EDT | Низкая | Среднее | Все WS-колбэки через `invokeLater` / `coroutineScope(Dispatchers.EDT)` |

---

## Фаза 2: File Operations + Editor Integration

### 2.2.1 Автоматическое открытие файлов в редакторе

Когда агент выполняет файловые операции (read/write/edit), плагин перехватывает соответствующие `tool_execution_start` события и открывает файлы в редакторе.

**Отслеживаемые операции:**
- `read` — агент читает файл → открыть в редакторе (read-only вкладка)
- `write` — агент создаёт/перезаписывает файл → открыть в редакторе
- `edit` — агент редактирует файл → открыть в редакторе

**Реализация:**
```
WS: agent_event → event.type = "tool_execution_start"
  └→ event.toolName = "read"|"write"|"edit"
       └→ event.args.path = "/absolute/path/to/file"
            └→ OpenFileCommand: VirtualFile → Editor
```

- Определение `VirtualFile` по абсолютному пути: `LocalFileSystem.getInstance().findFileByPath(path)`
- Открытие: `FileEditorManager.getInstance(project).openFile(vFile, true)`
- Индикация в чате: иконка файла рядом с сообщением о файловой операции
- Не открывать дубли — если файл уже открыт в активном редакторе, просто переключиться

### 2.2.2 Отображение содержимого файла (Read)

Когда агент читает файл:
1. Файл открывается в редакторе (read-only если нет изменений)
2. В чате отображается блок «📄 /path/to/file» — кликабельный, переходит к файлу
3. Опционально: подсветка строк, которые агент «обратил внимание на» (future: line ranges в tool output)

### 2.2.3 Inline Diff (Write/Edit)

Когда агент записывает или редактирует файл:
1. Агент применяет изменения немедленно (как в TUI — без ожидания одобрения пользователя)
2. Файл автоматически открывается в редакторе после `tool_execution_end` — пользователь видит результат
3. В чате отображается информационный блок с файлом и сводкой изменений
4. Кнопка `[Open Diff]` — открывает read-only diff (для просмотра, что именно изменилось)

**Флоу для Write/Edit:**
```
Agent: edit(path, oldText, newText)
  └→ WS: tool_execution_start { toolName: "edit", toolCallId: "...", args: { path, oldText, newText } }
       └→ Plugin запоминает текущее содержимое файла (для будущего Diff)
  └→ WS: tool_execution_end { toolName: "edit", toolCallId: "...", result: "File updated", isError: false }
       └→ VFS refresh → Plugin открывает файл в редакторе (изменения уже применены)
       └→ В чате: блок с путём + сводка изменений + [Open Diff] (read-only)
```

#### Пользовательские сценарии

**Сценарий 2.1: Агент редактирует файл**
**Предусловия:** файл открыт в редакторе (или нет), чат активен
**Шаги:**
1. Агент вызывает `edit` tool
2. WS-событие `tool_execution_start` → плагин запоминает текущее содержимое файла (для будущего Diff)
3. WS-событие `tool_execution_end` → изменения уже применены агентом на диске
4. `VirtualFileManager.syncRefresh()` → файл открывается в редакторе (пользователь видит результат)
5. В чате: «📄 src/main.kt — +12 -3 строк» с кнопкой [Open Diff]
**Ожидаемый результат:** файл автоматически открыт в редакторе с применёнными изменениями, пользователь видит результат без необходимости одобрения

**Сценарий 2.2: Агент создаёт новый файл**
**Предусловия:** файла не существовало
**Шаги:**
1. Агент вызывает `write` tool
2. WS-событие `tool_execution_start` → запомнить путь
3. WS-событие `tool_execution_end` → файл создан на диске
4. `VfsUtil.findFileByIoFile()` → открыть в редакторе
5. В чате: «📄 src/NewFile.kt — создан»
**Ожидаемый результат:** файл открыт в редакторе, пользователь видит содержимое

### 2.2.4 Критерии приёмки Фазы 2

| # | Критерий | Статус |
|---|----------|--------|
| 2.1 | Файлы автоматически открываются при read/write/edit | |
| 2.2 | Индикация файловых операций в чате (иконка + путь) | |
| 2.3 | Inline diff для write-операций | |
| 2.4 | Inline diff для edit-операций | |
| 2.5 | [Open Diff] — read-only просмотр изменений (без одобрения) | |
| 2.6 | Read-only индикация для файлов, которые агент только читает | |
| 2.7 | Не дублировать вкладки для уже открытых файлов | |
| 2.8 | Корректная работа с файлами вне проекта (absolute paths) | |

### 2.2.5 Риски Фазы 2

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Tool output содержит неструктурированный текст (не JSON) | Средняя | Высокое | Парсить path из текста через regex; фильтр по известным tool-именам |
| Файл изменён между read и diff (race condition) | Низкая | Среднее | Сохранять Document content в момент tool_execution_start |
| Diff для больших файлов (>10000 строк) | Низкая | Низкое | Ограничить diff-view на первые 500 строк изменений |
| Виртуальная файловая система IntelliJ не синхронизирована с диском | Средняя | Среднее | `VirtualFileManager.getInstance().syncRefresh()` перед открытием |

---

## Фаза 3: IDE Context Integration

### 2.3.1 Автоприкрепление контекста файла

При отправке сообщения в чат — автоматически прикреплять контекст текущего файла:
- Путь к файлу (относительно project root)
- Язык (определяется IntelliJ по расширению)
- Содержимое файла (если < 200 строк, иначе — первые 100 + последние 50 строк с маркером `[...]`)
- Номера строк

**Формат прикрепления (префикс к сообщению):**
```
[Context: src/main/kotlin/App.kt (lines 1-200)]
\`\`\`kotlin
// file content
\`\`\`

<user message>
```

### 2.3.2 Selection-Aware Mode

Если пользователь выделил текст в редакторе перед отправкой сообщения:
- Прикреплять только выделенный фрагмент + surrounding context (5 строк до и после)
- Показывать индикатор «📎 Selected 15 lines from App.kt» в input field
- Переключатель «📎 контекст» рядом с полем ввода — вкл/выкл отправку с контекстом

> **Примечание:** Shift+Enter зарезервирован для перевода строки в многострочном поле ввода (стандартное поведение), поэтому для управления контекстом используется отдельный переключатель.

```
[Context: src/main/kotlin/App.kt (lines 42-62, selected)]
\`\`\`kotlin
// 5 lines before selection
fun processData(input: Data): Result {
    >>> выделенный текст <<<
// 5 lines after selection
}
\`\`\`

<user message>
```

### 2.3.3 Действие «Ask FAN» (Right-click)

Контекстное действие в редакторе:
- **Триггер:** Right-click → «Ask FAN» (или `Alt+F` hotkey)
- **Поведение:** открывает Tool Window, автоматически вставляет выделенный текст + контекст, устанавливает фокус в input field
- **Без выделения:** прикрепляет весь файл

**Регистрация в IntelliJ:**
```kotlin
class AskFanAction : AnAction("Ask FAN") {
    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val project = e.getData(CommonDataKeys.PROJECT)
        // → open Tool Window + populate context
    }
}
```

### 2.3.4 Быстрый action через клавиатуру

- `Alt+F` — «Ask FAN» (аналог GitHub Copilot `Alt+\`)
- Работает из любого места: редактор, Project view, Terminal

### 2.3.5 Критерии приёмки Фазы 3

| # | Критерий | Статус |
|---|----------|--------|
| 3.1 | Контекст файла автоматически прикрепляется к сообщениям | |
| 3.2 | Selection-aware: выделенный текст + surrounding context | |
| 3.3 | Индикатор прикреплённого контекста в input field | |
| 3.4 | Переключатель контекста (вкл/выкл) рядом с полем ввода | |
| 3.5 | «Ask FAN» в контекстном меню редактора | |
| 3.6 | `Alt+F` hotkey для быстрого вызова | |
| 3.7 | Ограничение размера контекста (200 строк / truncate) | |

### 2.3.6 Риски Фазы 3

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Контекст файла слишком большой → превышение token limit модели | Средняя | Среднее | Truncate до лимита; показывать предупреждение «файл обрезан» |
| Неправильный формат контекста → агент не понимает | Низкая | Среднее | Test с разными моделями; стандартный формат с маркерами |
| Hotkey конфликт с другими плагинами | Низкая | Низкое | Настройка hotkey в Settings → Keymap |

---

## Фаза 4: Enhanced Features

### 2.4.1 Выбор модели (Model Selection UI)

- Dropdown в заголовке Tool Window — текущая активная модель
- Данные: `GET /api/models` → `ModelInfo[]` + `RoutingRuleInfo[]`
- Выбор модели для следующего сообщения (per-message override)
- Переключение «auto» (routing по правилам) / «manual» (указанная модель)

> ⚠️ **TODO: WS `model_switch` event.** Тип `WsModelSwitch` определён в `packages/api-gateway/src/types.ts:197-202`, но **не отправляется** серверным кодом (ws-handler отправляет только `agent_event` и `connected`). Для уведомлений о смене модели можно:
> - Использовать polling `GET /api/models` с интервалом;
> - Или отслеживать изменения модели через `agent_start` event → сравнивать с предыдущим значением.

### 2.4.2 Визуализация бюджета

- Отдельная вкладка в Tool Window (или панель в header)
- Данные: `GET /api/budget` → `BudgetStatus[]`
- Progress bars: `tokensUsed / tokenLimit`, `costUsed / costLimit`
- Цветовая индикация: зелёный <60%, жёлтый 60–85%, красный >85%
- Auto-refresh каждые 30 секунд

> ⚠️ **TODO: WS `budget_alert` event.** Тип `WsBudgetAlert` определён в `packages/api-gateway/src/types.ts:186-193`, но **не отправляется** серверным кодом (ws-handler отправляет только `agent_event` и `connected`).
>
> **Workaround для Фазы 4:** вместо WS-уведомлений использовать polling `GET /api/budget` каждые 30 секунд и сравнивать с предыдущими значениями для определения превышения порогов. При достижении порога (>85%) — показывать toast notification.

### 2.4.3 Визуализация tool execution

В чате — сворачиваемые блоки для каждого tool call агента:
```
🔧 Running: read(/src/main/kotlin/App.kt)
  └─ Result: 200 lines loaded (0.3s)

🔧 Running: edit(/src/main/kotlin/App.kt)
  └─ Changes: +12 -3 lines
  └─ [Open Diff]

🔧 Running: bash(git status)
  └─ Result: On branch FAN/feature/xxx
```

**Данные из WS:**
- `tool_execution_start` → `toolName`, `toolCallId`, `args` (map/dict)
- `tool_execution_update` → `toolName`, `partialResult` (парциальный результат, новая строка progress) — опциональное событие для длительных операций
- `tool_execution_end` → `toolName`, `result`, `isError`

### 2.4.4 Поиск по сессиям

- Text field в Session List — поиск по названию и содержимому сессий
- Локальный поиск по загруженным `SessionSummary` (title, messageCount)
- Future: server-side search (если появится эндпоинт)

### 2.4.5 Code completion (feasibility study)

**Предпосылка:** FAN API не имеет dedicated endpoint для code completion. Возможные подходы:
1. **Prompt-based**: отправлять текущий файл prefix + cursor position как chat message → парсить код из ответа
2. **Inline generation**: пользователь вводит комментарий → Ctrl+Space → отправить контекст в FAN → вставить

**Оценка feasibility:** низкая latency — неизвестно (зависит от модели). Требуется отдельное исследование.

**Решение:** пометить как feasibility study в Фазе 5, не включать в Фазу 4.

### 2.4.6 Критерии приёмки Фазы 4

| # | Критерий | Статус |
|---|----------|--------|
| 4.1 | Model selection dropdown (auto/manual) | |
| 4.2 | Budget visualization с progress bars | |
| 4.3 | Budget alert toast notifications (polling GET /api/budget) | |
| 4.4 | Model switch detection (polling GET /api/models или через agent_start event) | |
| 4.5 | Сворачиваемые блоки tool execution в чате | |
| 4.6 | [Open Diff] в tool execution блоках (read-only просмотр) | |
| 4.7 | Поиск по сессиям | |

### 2.4.7 Риски Фазы 4

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Model list очень длинный (>100 моделей) | Средняя | Низкое | Фильтрация по provider, поиск по названию |
| Budget data отсутствует (модели без оплаты) | Низкая | Низкое | Скрывать budget panel если данных нет |
| Tool execution events формат нестабилен | Средняя | Среднее | Best-effort парсинг; fallback на text display |

---

## Фаза 5: Advanced Integration

### 2.5.1 Multi-project поддержка

- Один FAN Server → несколько открытых проектов в IDE
- Tool Window привязан к project (context aware)
- Workspace-level session: по умолчанию — сессия привязана к project root
- Переключение workspace: dropdown с открытыми проектами

### 2.5.2 Inline code actions

Предложения FAN прямо в редакторе (аналог GitHub Copilot suggestions):
- **Intentions:** `Alt+Enter` → «Generate test for this function» → отправить в FAN → вставить результат
- **Inspections:** аннотации в gutter (margin) — «FAN suggests: extract method»

**Требует:** специальный prompt template, быстрый ответ (<2с), поддерживается только для быстрых моделей.

### 2.5.3 Terminal Integration

- Встроенный терминал IntelliJ → автоопределение запущенного `fan` процесса
- Интеграция с FAN CLI: `fan` команды доступны во встроенном терминале
- Terminal hyperlink: кликабельные пути файлов в ответах агента

### 2.5.4 Система уведомлений

- IntelliJ `NotificationGroup` (balloon notifications):
  - Долгая операция агента (>30с) → «FAN: агент работает...»
  - Ошибка подключения → «FAN Server unavailable»
  - Budget exceeded → «FAN: бюджет исчерпан»
  - Agent idle → «FAN: готов к работе»
- Настройка уведомлений в Settings (вкл/выкл по типу)
- Event Log panel: история уведомлений

### 2.5.5 Settings Sync между IDE

- Токены и URL сохраняются в **global** IDE settings (shared между всеми IDE JetBrains на машине)
- Model preference — per-project setting
- FAN Plugin settings export/import

### 2.5.6 Критерии приёмки Фазы 5

| # | Критерий | Статус |
|---|----------|--------|
| 5.1 | Multi-project: отдельные сессии по project | |
| 5.2 | Inline intentions (Alt+Enter → FAN actions) | |
| 5.3 | Terminal hyperlink support | |
| 5.4 | Notification system (balloon + Event Log) | |
| 5.5 | Настройка уведомлений в Settings | |
| 5.6 | Settings sync (global token, per-project model) | |

### 2.5.7 Риски Фазы 5

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Inline suggestions latency (>3с) — непригодны для UX | Высокая | Среднее | Только для быстрых моделей; async preview; offload в background |
| Notification spam при частых операциях агента | Средняя | Низкое | Debounce (не чаще 1 уведомления в 30с); batched notifications |
| Multi-project session confusion | Средняя | Среднее | Чёткая привязка sessionId ↔ project; label в Session List |

---

## 3. UI/UX требования

### 3.1 Структура Tool Window

Tool Window содержит **два вида**, переключаемых при навигации:

#### View 1: Session List (дефолтный вид)

```
┌─────────────────────────────────────────────────────────┐
│ 🤖 FAN Agent                          🟢 Connected  │
│ ┌─ Model: Claude 3.5 Sonnet (auto) ──── [⚙] ─┐       │
├─────────────────────────────────────────────────────────┤
│  🔍 Search sessions...                                │
│  ────────────                                         │
│                                                       │
│  ▸ Refactor auth module                    2h ago     │
│  ▸ Fix null pointer in Parser              5h ago     │
│  ▸ Add unit tests for UserService     yesterday      │
│  ▸ Implement OAuth2 flow              2 days ago      │
│  ▸ Debug memory leak                  3 days ago      │
│                                                       │
│                                                       │
│                                                       │
│                                                       │
│                                                       │
│                                                       │
│                                                       │
│                                                       │
│                                                       │
├─────────────────────────────────────────────────────────┤
│  📎 src/Main.kt (L42-62)                              │
│  ┌──────────────────────────────────────────┐         │
│  │ Type your message...              [Send] │         │
│  └──────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────┘
```
- **Создание новой сессии:** пользователь вводит сообщение в input field внизу → создаётся новая сессия и открывается Chat View

#### View 2: Chat (открывается при выборе/создании сессии)

```
┌─────────────────────────────────────────────────────────┐
│ ← Sessions    Refactor auth module        🟢 Connected │
│ ┌─ Model: Claude 3.5 Sonnet (auto) ──── [⚙] ─┐       │
├─────────────────────────────────────────────────────────┤
│                                                       │
│  Chat Area                                            │
│  ────────────                                         │
│                                                       │
│  User: Refactor the authenticate function              │
│        to use JWT tokens                               │
│                                                       │
│  Assistant: I'll refactor the authenticate...         │
│  ┌──────────────────────┐                             │
│  │ 📄 src/Main.kt (read) │                             │
│  │ 42 lines loaded      │                             │
│  └──────────────────────┘                             │
│                                                       │
│  🔧 bash(git status)                                  │
│  └─ On branch master                                  │
│                                                       │
│  I'll now apply the changes to the file...            │
│                                                       │
│                                                       │
│                                                       │
├─────────────────────────────────────────────────────────┤
│  📎 src/Main.kt (L42-62)                              │
│  ┌──────────────────────────────────────────┐         │
│  │ Type your message...              [Send] │         │
│  └──────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────┘
```
- **Возврат к сессиям:** кнопка «← Sessions» в app bar (вверху) → Session List
- **App bar** показывает заголовок текущей сессии и индикатор подключения

### 3.2 Компоненты UI

| Компонент | IntelliJ API | Описание |
|-----------|-------------|----------|
| Tool Window | `ToolWindowFactory`, `ToolWindow` | Основной контейнер плагина |
| Chat Panel | `JPanel` + `JBScrollPane` | Scrollable область сообщений |
| Session List | `JBList` | Самостоятельная панель списка сессий (первый вид) |
| Input Field | `EditorTextField` (многострочный) | Ввод сообщений с поддержкой Markdown |
| Status Bar | `ToolWindow.setAdditionalGearActions` | Индикатор подключения |
| Diff Viewer | `DiffManager.getInstance().showDiff()` | Инлайн diff для file operations |
| Notifications | `NotificationGroup`, `Notification` | Balloon + Event Log |
| Settings | `Configurable`, `BoundConfigurable` | Settings → Tools → FAN Agent |

### 3.3 Обработка ошибок

| Ошибка | UI Response |
|--------|-------------|
| Server not running | Welcome screen с инструкцией запуска |
| Connection timeout | Yellow indicator + toast «Connection timeout» |
| Auth failure (401/403) | Red indicator + dialog «Invalid token» + перенаправление в Settings |
| Message send failure | Error message в чате + кнопка «Retry» |
| Session not found (404) | Remove from Session List + toast «Session deleted» |
| Streaming error | Остановка рендеринга + «Connection lost» banner |
| File not found | Warning в чате: «File not found: /path/to/file» |

### 3.4 Threading модель

```
┌─────────────────────────────────────────────────────┐
│ EDT (Event Dispatch Thread)                         │
│ • Все обновления UI                                 │
│ • Swing компоненты                                  │
│ • invokeLater { ... }                               │
├─────────────────────────────────────────────────────┤
│ Background Pool (coroutineScope + Dispatchers.IO)   │
│ • HTTP-запросы (REST)                               │
│ • Чтение/запись файлов                             │
│ • Парсинг WS-сообщений                              │
│ • invokeLater { ui.update(...) } ← пересылка на EDT│
├─────────────────────────────────────────────────────┤
│ WebSocket Thread (OkHttp)                           │
│ • Приём WS-фреймов                                  │
│ • Ping/pong keep-alive                              │
│ • invokeLater { ... } → EDT                         │
└─────────────────────────────────────────────────────┘
```

**Ключевое правило:** все обращения к UI-компонентам — только на EDT. Все сетевые вызовы — только на background thread.

---

## 4. Нефункциональные требования

### 4.1 Производительность
- **Чат input latency:** < 50ms (UI-отклик)
- **WS message → UI update:** < 100ms (от получения фрейма до перерисовки)
- **Plugin startup:** < 500ms (открытие Tool Window ленивое — по первому клику)
- **Memory overhead:** < 100MB (без учёта кэша сообщений)
- **Session list loading:** < 500ms для 100 сессий

### 4.2 Безопасность
- **Token storage:** Persistent settings (encrypted на macOS Keychain / Windows Credential Manager через IntelliJ `PasswordSafe`)
- **Local-only**: FAN Server — localhost, плагин не отправляет данные наружу
- **No telemetry**: плагин не собирает метрики использования
- **Token rotation**: возможность обновить токен в Settings

### 4.3 Надёжность
- **Graceful degradation**: при unavailable сервере — UI работает offline (отображение кэшированных сообщений)
- **Crash recovery**: при падении плагина — состояние восстанавливается из persistent settings + FAN API
- **WebSocket stability**: auto-reconnect с backoff, keep-alive ping каждые 30с
- **Concurrent access**: несколько IDE → один FAN Server — работает (multi-client)

### 4.4 Совместимость
- **IntelliJ IDEA**: 2023.2+ (build 233+)
- **PyCharm**: 2023.2+
- **WebStorm**: 2023.2+
- **GoLand**: 2023.2+
- **Rider**: 2023.2+
- **Other JetBrains**: 2023.2+ (универсальная платформа)
- **Java**: 17+ (требование IntelliJ Platform 2023.2+)
- **OS**: Windows 10+, macOS 12+, Linux (GTK3)

---

## 5. Технические требования

### 5.1 Стек технологий

| Компонент | Технология | Обоснование |
|-----------|-----------|-------------|
| **Language** | Kotlin 1.9+ | Стандарт для IntelliJ Platform Plugin |
| **Build** | Gradle + IntelliJ Platform Gradle Plugin 2.x | Стандартная сборка, version management |
| **HTTP Client** | OkHttp 4.x | HTTP/REST запросы к FAN API |
| **WebSocket** | OkHttp WebSocket | WS-подключение к FAN Server |
| **JSON** | kotlinx.serialization / Gson | Парсинг JSON-ответов и WS-сообщений |
| **Coroutines** | kotlinx.coroutines | Асинхронные операции, threading |
| **DI** | None (manual) | Плагин достаточно прост; Koin/Kodein — overkill |
| **UI** | Swing + JBUI | Стандартная UI-фреймворк IntelliJ Platform |
| **Markdown** | flexmark-java | Рендеринг Markdown в JEditorPane / JBLabel |
| **Testing** | JUnit 5 + TestKit | Unit + интеграционные тесты |
| **Diff** | IntelliJ Diff API | `DiffManager`, `SimpleDiffRequest` |

### 5.2 Структура проекта

```
fan-idea-plugin/
├── build.gradle.kts
├── settings.gradle.kts
├── src/
│   └── main/
│       ├── kotlin/
│       │   └── fan/
│       │       └── idea/
│       │           ├── FanPlugin.kt                    # Application service
│       │           ├── settings/
│       │           │   ├── FanPluginSettings.kt        # Settings state
│       │           │   ├── FanPluginConfigurable.kt    # Settings UI
│       │           │   └── FanPluginSettingsListener.kt # Settings change listener
│       │           ├── api/
│       │           │   ├── FanApiClient.kt             # REST API wrapper
│       │           │   ├── FanWsClient.kt              # WebSocket client
│       │           │   ├── FanApiTypes.kt              # Data classes (types)
│       │           │   └── ServerDetector.kt           # Auto-detect server.json
│       │           ├── toolwindow/
│       │           │   ├── FanToolWindowFactory.kt     # ToolWindow registration
│       │           │   ├── ChatPanel.kt                # Chat messages UI
│       │           │   ├── SessionListPanel.kt           # Standalone session list panel (default view)
│       │           │   ├── InputPanel.kt               # Message input
│       │           │   ├── MessageRenderer.kt          # Markdown rendering
│       │           │   ├── StatusBar.kt                # Connection indicator
│       │           │   └── WelcomePanel.kt             # First-run / server-not-found
│       │           ├── editor/
│       │           │   ├── FileOpener.kt               # Auto-open files
│       │           │   ├── DiffPresenter.kt            # Inline diff display
│       │           │   ├── ContextExtractor.kt         # File context extraction
│       │           │   └── AskFanAction.kt             # Right-click action
│       │           ├── notifications/
│       │           │   ├── FanNotificationGroup.kt     # Notification registration
│       │           │   └── NotificationHelper.kt       # Show notifications
│       │           └── actions/
│       │               ├── DeleteSessionAction.kt
│       │               └── OpenSettingsAction.kt
│       └── resources/
│           ├── META-INF/
│           │   └── plugin.xml                          # Plugin descriptor
│           ├── icons/
│           │   └── fan_icon.svg
│           └── messages/
│               └── FanBundle.properties                # i18n
├── src/
│   └── test/
│       └── kotlin/
│           └── fan/
│               └── idea/
│                   ├── api/
│                   │   ├── FanApiClientTest.kt
│                   │   ├── FanWsClientTest.kt
│                   │   └── ServerDetectorTest.kt
│                   ├── toolwindow/
│                   │   └── ChatPanelTest.kt
│                   └── editor/
│                       └── ContextExtractorTest.kt
└── gradle.properties
```

### 5.3 Архитектурные паттерны

#### Service Layer (FanPlugin)

```kotlin
class FanPlugin(private val project: Project) {
    // Dependencies
    val settings: FanPluginSettings
    val apiClient: FanApiClient
    val wsClient: FanWsClient
    
    // State
    var currentSessionId: String?
    val connectionStatus: StateFlow<ConnectionStatus>
    
    // Operations
    suspend fun connect(): Result<Unit>
    suspend fun sendMessage(text: String): Result<Unit>
    suspend fun createSession(title: String?): Result<SessionSummary>
    suspend fun switchSession(sessionId: String): Result<Unit>
    fun disconnect()
}
```

#### Event Flow (Kotlin Coroutines + SharedFlow)

```kotlin
// SharedFlow для трансляции WS-событий
sealed interface FanEvent {
    data class AgentStart(val timestamp: Instant) : FanEvent
    data class TurnStart(val timestamp: Instant) : FanEvent
    data class MessageStart(val message: Map<String, Any>) : FanEvent
    data class MessageUpdate(val message: Map<String, Any>, val assistantMessageEvent: AssistantMessageEventData) : FanEvent
    data class MessageEnd(val message: Map<String, Any>) : FanEvent
    data class TurnEnd(val message: Map<String, Any>, val toolResults: List<Map<String, Any>>) : FanEvent
    data class ToolExecutionStart(val toolName: String, val toolCallId: String, val args: Map<String, Any>) : FanEvent
    data class ToolExecutionUpdate(val toolName: String, val toolCallId: String, val args: Map<String, Any>, val partialResult: Any?) : FanEvent
    data class ToolExecutionEnd(val toolName: String, val toolCallId: String, val result: Any?, val isError: Boolean) : FanEvent
    data class AgentEnd(val timestamp: Instant, val messages: List<Map<String, Any>>) : FanEvent
    data class Error(val message: String) : FanEvent
}

// Вложенный тип для assistantMessageEvent (text_delta, thinking_delta, etc.)
sealed interface AssistantMessageEventData {
    val type: String
    data class ThinkingStart(val contentIndex: Int, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "thinking_start" }
    data class ThinkingDelta(val contentIndex: Int, val delta: String, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "thinking_delta" }
    data class ThinkingEnd(val contentIndex: Int, val content: String, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "thinking_end" }
    data class TextStart(val contentIndex: Int, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "text_start" }
    data class TextDelta(val contentIndex: Int, val delta: String, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "text_delta" }
    data class TextEnd(val contentIndex: Int, val content: String, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "text_end" }
    data class ToolcallStart(val contentIndex: Int, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "toolcall_start" }
    data class ToolcallDelta(val contentIndex: Int, val delta: String, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "toolcall_delta" }
    data class ToolcallEnd(val contentIndex: Int, val toolCall: Map<String, Any>, val partial: Map<String, Any>) : AssistantMessageEventData { override val type = "toolcall_end" }
}

// В FanWsClient:
private val _events = MutableSharedFlow<FanEvent>(extraBufferCapacity = 256)
val events: SharedFlow<FanEvent> = _events.asSharedFlow()

// ⚠️ Следующие WS event-типы ОПРЕДЕЛЕНЫ в packages/api-gateway/src/types.ts,
// но НЕ ОТПРАВЛЯЮТСЯ сервером (phantom features):
//   WsBudgetAlert (budget_alert) — определён, но ws-handler его не emitит
//   WsModelSwitch (model_switch) — определён, но ws-handler его не emitит
// Workaround: использовать polling GET /api/budget и GET /api/models.
```

### 5.4 plugin.xml (основной дескриптор)

```xml
<idea-plugin>
    <id>fan.idea.plugin</id>
    <name>FAN Agent</name>
    <version>1.0.0</version>
    <vendor>Filin Agent Next</vendor>
    <description>AI coding agent integration powered by FAN Runtime</description>
    
    <depends>com.intellij.modules.platform</depends>
    <depends>com.intellij.modules.lang</depends>
    
    <extensions defaultExtensionNs="com.intellij">
        <!-- Tool Window -->
        <toolWindow id="FAN Agent"
                    factoryClass="fan.idea.toolwindow.FanToolWindowFactory"
                    anchor="right"
                    icon="fan.idea.icons.FanIcon"/>
        
        <!-- Settings -->
        <applicationConfigurable
            instance="fan.idea.settings.FanPluginConfigurable"
            id="fan.settings"
            displayName="FAN Agent"/>
        
        <!-- Notifications -->
        <notificationGroup
            id="fan.notifications"
            displayType="BALLOON"/>
        
        <!-- Actions -->
        <action id="fan.askFan"
                class="fan.idea.editor.AskFanAction"
                text="Ask FAN"
                description="Send selected code to FAN Agent">
            <add-to-group group-id="EditorPopupMenu" anchor="last"/>
            <keyboard-shortcut first-keystroke="alt F" keymap="$default"/>
        </action>
    </extensions>
</idea-plugin>
```

### 5.5 Ключевые API-типы (Kotlin data classes)

```kotlin
// === REST types ===

data class SessionSummary(
    val id: String,
    val title: String,
    val model: String?,
    val provider: String?,
    val createdAt: String,
    val updatedAt: String,
    val messageCount: Int,
    val sessionFile: String?
)

data class SessionMessage(
    val id: String,
    val role: String,  // "user" | "assistant" | "tool"
    val content: String,
    val model: String?,
    val tokens: Int?,
    val cost: Double?,
    val createdAt: String
)

data class SendMessageRequest(
    val message: String,
    val streamingBehavior: String? = null  // "steer" | "followUp"
)

data class HealthResponse(
    val status: String,  // "ok" | "degraded"
    val version: String,
    val uptime: Int
)

data class ModelInfo(
    val provider: String,
    val model: String,
    val displayName: String? = null  // опциональное человекочитаемое имя
)

data class UpdateModelSettingsRequest(
    val provider: String,
    val model: String,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    // ⚠️ Несоответствие типов: API reference docs описывают thinking как Boolean,
    // но фактический TypeScript тип — String. Используем String? для безопасности.
    val thinking: String? = null
)

// ⚠️ Несоответствие API reference: документация упоминает period "weekly",
// но TypeScript тип UpdateBudgetRequest.period допускает только "daily" | "monthly".
enum class BudgetPeriod(val value: String) {
    DAILY("daily"),
    MONTHLY("monthly")
}

data class UpdateBudgetRequest(
    val provider: String? = null,
    val period: BudgetPeriod,
    val tokenLimit: Int? = null,
    val costLimit: Double? = null
)

// === WS types ===

// Все события от сервера оборачиваются в WsOutgoingMessage.
// Фактически ws-handler отправляет только "agent_event" и "connected".
// Типы WsBudgetAlert и WsModelSwitch определены, но НЕ используются (см. §2.4.1, §2.4.2).

sealed interface WsServerMessage {
    val type: String
    val sessionId: String
    val timestamp: String
}

data class WsConnected(
    override val type: String = "connected",
    override val sessionId: String,
    override val timestamp: String
) : WsServerMessage

data class WsAgentEvent(
    override val type: String = "agent_event",
    override val sessionId: String,
    override val timestamp: String,
    val event: AgentEventData  // Десериализуется в один из подтипов AgentEvent
) : WsServerMessage

data class WsError(
    override val type: String = "error",
    override val sessionId: String,
    override val timestamp: String,
    val code: String,
    val message: String
) : WsServerMessage

// === AgentEvent типы (вложенные в WsAgentEvent.event) ===
// Источник: packages/agent/src/types.ts:326-341

sealed interface AgentEventData {
    val type: String
}

data class AgentStart(override val type: String = "agent_start") : AgentEventData
data class AgentEnd(override val type: String = "agent_end", val messages: List<Map<String, Any>>) : AgentEventData
data class TurnStart(override val type: String = "turn_start") : AgentEventData
data class TurnEnd(override val type: String = "turn_end", val message: Map<String, Any>, val toolResults: List<Map<String, Any>>) : AgentEventData

data class MessageStart(override val type: String = "message_start", val message: Map<String, Any>) : AgentEventData
data class MessageUpdate(
    override val type: String = "message_update",
    val message: Map<String, Any>,
    val assistantMessageEvent: AssistantMessageEventData
) : AgentEventData
data class MessageEnd(override val type: String = "message_end", val message: Map<String, Any>) : AgentEventData

data class ToolExecutionStart(
    override val type: String = "tool_execution_start",
    val toolName: String,
    val toolCallId: String,
    val args: Map<String, Any>
) : AgentEventData

data class ToolExecutionUpdate(
    override val type: String = "tool_execution_update",
    val toolName: String,
    val toolCallId: String,
    val args: Map<String, Any>,
    val partialResult: Any?
) : AgentEventData

data class ToolExecutionEnd(
    override val type: String = "tool_execution_end",
    val toolName: String,
    val toolCallId: String,
    val result: Any?,
    val isError: Boolean
) : AgentEventData

// === AssistantMessageEvent типы (вложенные в MessageUpdate.assistantMessageEvent) ===
// Источник: packages/ai/src/types.ts:237-247
// text_delta и thinking_delta НЕ являются топ-уровневыми WS-событиями!

sealed interface AssistantMessageEventData {
    val type: String
}

data class ThinkingStart(override val type: String = "thinking_start", val contentIndex: Int, val partial: Map<String, Any>) : AssistantMessageEventData
data class ThinkingDelta(override val type: String = "thinking_delta", val contentIndex: Int, val delta: String, val partial: Map<String, Any>) : AssistantMessageEventData
data class ThinkingEnd(override val type: String = "thinking_end", val contentIndex: Int, val content: String, val partial: Map<String, Any>) : AssistantMessageEventData
data class TextStart(override val type: String = "text_start", val contentIndex: Int, val partial: Map<String, Any>) : AssistantMessageEventData
data class TextDelta(override val type: String = "text_delta", val contentIndex: Int, val delta: String, val partial: Map<String, Any>) : AssistantMessageEventData
data class TextEnd(override val type: String = "text_end", val contentIndex: Int, val content: String, val partial: Map<String, Any>) : AssistantMessageEventData
data class ToolcallStart(override val type: String = "toolcall_start", val contentIndex: Int, val partial: Map<String, Any>) : AssistantMessageEventData
data class ToolcallDelta(override val type: String = "toolcall_delta", val contentIndex: Int, val delta: String, val partial: Map<String, Any>) : AssistantMessageEventData
data class ToolcallEnd(override val type: String = "toolcall_end", val contentIndex: Int, val toolCall: Map<String, Any>, val partial: Map<String, Any>) : AssistantMessageEventData

// === Phantom WS типы (определены в api-gateway/src/types.ts, но НЕ отправляются сервером) ===

// ⚠️ WsBudgetAlert — тип определён, но ws-handler его не emitит.
// Использовать polling GET /api/budget (см. §2.4.2).
data class WsBudgetAlert(
    override val type: String = "budget_alert",
    override val sessionId: String,
    override val timestamp: String,
    val alert: BudgetAlertPayload
) : WsServerMessage

data class BudgetAlertPayload(
    val provider: String,
    val period: String,
    val alertType: String,  // "warning" | "critical" | "exceeded"
    val message: String
)

// ⚠️ WsModelSwitch — тип определён, но ws-handler его не emitит.
// Использовать polling GET /api/models (см. §2.4.1).
data class WsModelSwitch(
    override val type: String = "model_switch",
    override val sessionId: String,
    override val timestamp: String,
    val from: ModelRef,
    val to: ModelRef,
    val reason: String
) : WsServerMessage

data class ModelRef(val provider: String, val model: String)
```

### 5.6 Справочная реализация

Ключевые классы Dashboard (`packages/dashboard/src/api/`) используются как **референс-реализация**:

| Dashboard (TypeScript) | Plugin (Kotlin) | Назначение |
|------------------------|-----------------|------------|
| `FanApiClient` | `FanApiClient.kt` | REST wrapper, auth, error handling |
| `FanWsClient` | `FanWsClient.kt` | WebSocket, reconnect, ping/pong |
| `@fan/api-gateway/types` | `FanApiTypes.kt` | Shared data types |
| `ws-handler.ts` (server) | — | Reference for WS protocol |

---

## 6. Данные

### 6.1 Persistent Settings (IDE)

Хранятся в IntelliJ persistent settings (`com.intellij.ide.util.PropertiesComponent` или `PersistentStateComponent`):

```kotlin
data class FanPluginSettings(
    // Connection
    var serverUrl: String = "http://localhost:3456",
    var authToken: String = "",
    
    // Session
    var lastSessionId: String? = null,
    var lastProjectPath: String? = null,
    
    // UI
    var toolWindowAnchor: String = "right",
    var showThinking: Boolean = true,
    var contextAutoAttach: Boolean = true,
    var maxContextLines: Int = 200,
    
    // Notifications
    var notifyBudgetAlerts: Boolean = true,
    var notifyModelSwitch: Boolean = true,
    var notifyConnectionLost: Boolean = true,
    var notifyAgentDone: Boolean = false
)
```

### 6.2 Внешние данные (FAN Server)

| Источник | Путь | Описание |
|----------|------|----------|
| `~/.fan/agent/server.json` | `{ pid, port, host, token?, startTime }` | Информация о запущенном сервере |
| `~/.fan/agent/server.pid` | PID number | PID демона |
| FAN REST API | `GET /api/*` | Все runtime-данные |
| FAN WebSocket | `ws://host:port/api/ws/:sessionId` | Стриминг событий |

### 6.3 Валидация

- **Token format:** строка, не пустая, ASCII-only (как в Dashboard: `replace(/[^\x20-\x7E]/g, "")`)
- **URL format:** валидный HTTP URL, hostname = `localhost` / `127.0.0.1`
- **Session ID:** не пустой, формат CUID (как у FAN)
- **Context size:** max 200 строк файла, max 10000 символов контекста

---

## 7. Риски и митигация (сводная)

| Риск | Вероятность | Влияние | Митигация | Фаза |
|------|-------------|---------|-----------|------|
| FAN Server не установлен | Высокая | Критичное | Welcome-screen с инструкцией, auto-install (future) | 1 |
| Breaking changes в FAN API | Средняя | Высокое | Versioned API, compatibility check на startup | 1 |
| IntelliJ Platform API changes (major update) | Низкая | Среднее | Pin min version, test на EAP builds | 1 |
| Swing UI сложнее Web UI | Средняя | Среднее | JBUI components, reuse JetBrains patterns | 1 |
| EDT threading issues (deadlocks, freeze) | Средняя | Высокое | Strict coroutine dispatch, tests | 1 |
| Tool output parsing instability | Средняя | Высокое | Best-effort regex, fallback to text | 2 |
| Race conditions (file changed between read/diff) | Низкая | Среднее | Snapshot at tool_execution_start | 2 |
| Large context exceeds model token limit | Средняя | Среднее | Truncate, warn user | 3 |
| Inline suggestions latency | Высокая | Среднее | Only fast models, async, Phase 5 only | 5 |
| Multi-IDE concurrent file access | Средняя | Низкое | Multi-client WS, no shared state in plugin | 5 |

---

## 8. Компромиссы (Tradeoffs)

### 8.1 Принятые решения

- **Решение**: Плагин подключается к внешнему FAN Server (а не встраивает runtime)
- **Альтернатива**: Встраивать FAN runtime в плагин (как Gradle daemon)
- **Обоснование**: FAN runtime = Bun + Node.js = тяжёлый embedded runtime. Проще и надёжнее подключаться к уже запущенному серверу. Упрощает обновление: обновляется FAN — обновляется клиент.

- **Решение**: Swing UI (а не JCEF / WebView)
- **Альтернатива**: Использовать JCEF (Embedded Chromium) для чата, как у GitHub Copilot Chat
- **Обоснование**: JCEF = +50MB к плагину, сложности с версионированием Chrome. Swing + JBUI даёт нативный look-and-feel, меньше зависимостей, проще debug. Markdown-рендеринг через flexmark-java достаточен.

- **Решение**: OkHttp для HTTP + WebSocket (а не Ktor Client)
- **Альтернатива**: Ktor Client, java.net.http.HttpClient
- **Обоснование**: OkHttp — battle-tested, встроенный WS support, используется в IntelliJ Platform internally. Минимум зависимостей.

- **Решение**: Контекст прикрепляется как текст-префикс к сообщению
- **Альтернатива**: Отдельное поле `context` в `SendMessageRequest`
- **Обоснование**: Не требует изменений в FAN API. Агент привык к текстовому формату. 未来: отдельное field при расширении API.

- **Решение**: Нет offline mode (при недоступном сервере — read-only view кэшированных сообщений)
- **Альтернатива**: Полный offline mode с очередью сообщений
- **Обоснование**: FAN = online runtime. Offline mode без смысла — агент не может работать без LLM. Кэш только для чтения истории.

---

## 9. Приоритеты (MoSCoW)

### Must Have (P0) — Фаза 1
- Tool Window с чат-интерфейсом
- Подключение к FAN Server (автоопределение + ручная конфигурация)
- Отправка/получение сообщений (REST + WS streaming)
- Markdown-рендеринг ответов
- Session management (CRUD + переключение)
- Auto-reconnect при разрыве
- Thinking blocks (сворачиваемые)
- Отмена генерации (Stop)
- Сохранение состояния между перезапусками IDE

### Should Have (P1) — Фазы 2–3
- Автоматическое открытие файлов при read/write/edit
- Inline diff (просмотр изменений, без одобрения)
- Автоприкрепление контекста файла
- Selection-aware mode (выделенный текст)
- «Ask FAN» right-click action + `Alt+F` hotkey
- Budget visualization
- Tool execution visualization

### Could Have (P2) — Фазы 4–5
- Model selection dropdown
- Поиск по сессиям
- Multi-project поддержка
- Notification system
- Inline code actions (intentions)
- Terminal integration
- Settings sync между IDE

### Won't Have (в текущей спецификации)
- **Embedded FAN runtime** — слишком тяжёлый, отдельный продукт
- **Code completion** — требует feasibility study, неизвестна latency
- **Multi-user / remote server** — FAN = local-only runtime
- **Voice input/output** — за scope
- **Custom plugin themes** — следуем JetBrains theming guidelines
- **Mobile IDE support** — FAN = desktop runtime

---

## 10. План реализации

### Фаза 1: Core Connection + Chat MVP (2–3 недели)

```
Неделя 1:
  □ Setup: Gradle project, plugin.xml, IntelliJ Platform SDK
  □ Settings: FanPluginConfigurable (URL, token)
  □ ServerDetector: чтение server.json, health check
  □ WelcomePanel: first-run UX

Неделя 2:
  □ FanApiClient: REST wrapper (sessions, messages)
  □ FanWsClient: WebSocket, reconnect, ping/pong
  □ FanApiTypes: data classes

Неделя 3:
  □ ChatPanel: UI компонент, message rendering
  □ SessionListPanel: standalone session list view (default), search, create via input
  □ InputPanel: text field, send/stop buttons
  □ StatusBar: connection indicator
  □ Markdown rendering (flexmark-java)
  □ Testing: unit + integration
```

### Фаза 2: File Operations + Editor Integration (1–2 недели)

```
Неделя 1:
  □ Tool event parser: извлечение path из tool_execution_start/end
  □ FileOpener: openFile в редакторе
  □ DiffPresenter: inline diff для write/edit

Неделя 2:
  □ Context attachment в чате (иконка файла)
  □ Edge cases: file not found, file outside project
  □ Testing: mock WS events → verify editor actions
```

### Фаза 3: IDE Context Integration (1 неделя)

```
  □ ContextExtractor: текущий файл + selection + surrounding
  □ Context formatting: [Context: path (lines)] block
  □ InputPanel integration: indicator + context toggle
  □ AskFanAction: right-click menu + Alt+F
  □ Testing: verify context format for various scenarios
```

### Фаза 4: Enhanced Features (2 недели)

```
Неделя 1:
  □ Model selection dropdown (GET /api/models)
  □ Budget panel (GET /api/budget, progress bars)
  □ Tool execution visualization (collapsible blocks)

Неделя 2:
  □ Budget alert notifications (WS)
  □ Model switch notifications (WS)
  □ Session search
  □ Code completion feasibility study
```

### Фаза 5: Advanced Integration (2–3 недели)

```
Неделя 1:
  □ Multi-project: project → session binding
  □ Notification system (NotificationGroup, Event Log)

Неделя 2:
  □ Inline intentions (Alt+Enter → FAN)
  □ Terminal hyperlink support
  □ Settings sync (global vs per-project)

Неделя 3:
  □ Polish: keyboard navigation, accessibility
  □ Documentation: README, CHANGELOG
  □ Release: build plugin artifact, publish to JetBrains Marketplace
```

---

## 11. Следующие шаги

- [ ] Утвердить спецификацию
- [ ] Создать репозиторий плагина (fan-idea-plugin)
- [ ] Setup Gradle project + IntelliJ Platform SDK
- [ ] Реализовать Фазу 1 MVP
- [ ] Написать unit/integration тесты
- [ ] Ручное тестирование на IntelliJ IDEA 2023.2+
- [ ] Обновить MANIFEST.md и ARCHITECTURE.md (ссылка на плагин)
- [ ] Подготовить публикацию на JetBrains Marketplace

---

*Создано: research-spec-generator skill*
*Исходный запрос: Comprehensive multi-phase specification for FAN Agent IntelliJ Platform Plugin integration*
