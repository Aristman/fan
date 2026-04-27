# IDEA Plugin v2 — Roadmap (ORF Patterns)

> Upgrade FAN IDEA plugin (`idea-plugin/`) using proven patterns and components from the reference ORF plugin (
`~/projects/ailab-orf-plugin/`).

**Создано:** 2026-04-24  
**Статус:** Planned  
**Бранч:** TBD  
**Источник:** Сравнение ORF (190 файлов, ~31 934 строки) vs FAN (22 файла, ~3 258 строки)

---

## Требования

**JCEF (JBCefBrowser) — обязательное требование.** Все современные JetBrains IDE начиная с 2020.3 включают JCEF Runtime. Плагин будет работать только на JetBrains Runtime, не на plain JDK.

---

## Контекст

### FAN Plugin — текущее состояние

```
idea-plugin/src/main/kotlin/fan/idea/
├── api/
│   ├── FanApiClient.kt       — REST client (OkHttp)
│   └── FanWsClient.kt        — WebSocket client (OkHttp), reconnect
├── toolwindow/
│   ├── ChatPanel.kt           (407 строк) — streaming chat via Swing JTextArea
│   ├── InputPanel.kt          (143 строки) — JEditor, Ctrl+Enter to send
│   ├── SessionListPanel.kt    (284 строки) — session list
│   ├── WelcomePanel.kt        — empty state
│   ├── MessageRenderer.kt     (77 строк)  — simple regex markdown
│   └── StatusBar.kt           — connection indicator
├── settings/
│   ├── FanPluginSettings.kt   — persistent state
│   └── FanPluginConfigurable.kt — settings UI
├── actions/
│   └── FanPluginAction.kt     — tool window toggle
├── notifications/
│   ├── FanNotificationGroup.kt
│   └── NotificationHelper.kt
├── icons/
│   └── FanIcons.kt
└── FanPlugin.kt               (383 строки) — МОНОЛИТ: all state + logic
```

- **Build:** Kotlin 1.9.24, IntelliJ IC-2024.1, OkHttp 4.12.0, no coroutines
- **Rendering:** JTextArea + regex markdown — нет подсветки кода, нет сворачиваемых блоков
- **Сессии:** Server-side JSONL, клиент фильтрует по project path encoding
- **Проблемы:** Monolithic FanPlugin, no event system, minimal UX

### ORF Plugin — reference

```
~/projects/ailab-orf-plugin/src/main/kotlin/
├── core/services/
│   ├── app/                   — APP-level services (ConnectionService, NotificationService, StatusManager)
│   └── project/               — PROJECT-level services (SessionService, MessageService)
├── core/events/               — MessageBus listeners (ConnectionListener, SessionListener, MessageListener)
├── ui/chat/
│   ├── jcef/                  — JCEF browser wrapper (260 lines)
│   ├── manager/               — HtmlDocumentManager (1629 lines) — unified rendering API
│   ├── markdown/              — MarkdownParser + MarkdownRenderer
│   ├── components/            — CodeBlockComponent, SyntaxHighlighter, LanguageDetector
│   ├── agent/                 — AgentEventHandler, ToolCallFormatter, ClarificationHandler
│   ├── session/               — SessionNavigator, SessionListPanel, SessionListItem
│   └── InputPanel.kt          — auto-height, slash commands, history
├── ui/status/                 — StatusWidget, StatusManager, StatusIcons
└── resources/html/            — chat-jcef.html, chat-styles-jcef.css, chat.js (~590 lines)
```

- **Build:** Kotlin 2.1.0, Ktor HTTP + WebSocket, MigLayout, JSoup, JCEF
- **Rendering:** JCEF (Chromium)
- **Architecture:** Two-tier service layer (APP/PROJECT) + IntelliJ MessageBus
- **Ключевые паттерны:** Kotlin→JS bridge, 30 глобальных JS-функций, state machine для навигации

### Ключевые различия (что НЕ копируем)

| Аспект         | ORF Plugin                    | FAN Plugin                         | Решение                   |
|----------------|-------------------------------|------------------------------------|---------------------------|
| Backend API    | Filin REST + GraphQL WS       | FAN REST + plain WS                | Оставляем FAN API клиент  |
| Сессии         | Client-side JSON + шифрование | Server-side JSONL                  | Оставляем FAN сессии      |
| Agent protocol | SGR (custom binary WS)        | FAN coordinator (REST + WS events) | Адаптируем типы событий   |
| Completion     | Inline code completion        | N/A                                | Не в scope                |
| Refactoring    | Diff dialog + inline edit     | N/A                                | Не в scope                |
| HTTP client    | Ktor                          | OkHttp                             | Оставляем OkHttp          |
| WS client      | Ktor WebSocket                | OkHttp WebSocket                   | Оставляем OkHttp          |
| Шифрование     | AES для файлов сессий         | N/A                                | Не нужно                  |
| Звук           | WAV notifications             | N/A                                | Future (низкий приоритет) |
| RAG context    | Repository/doc selector       | File context (Phase 2)             | Адаптируем позже          |

---

## Phase 0: Архитектурная реструктуризация (Foundation)

**Цель:** Заменить монолитный `FanPlugin` на ORF-style двухуровневый service layer + MessageBus события.  
**Оценка:** 3-4 задачи, ~800 строк нового кода

### 0.1 Двухуровневый service layer

Создать пакеты:

- `fan.idea.core.services.app` — APP-level сервисы
- `fan.idea.core.services.project` — PROJECT-level сервисы

Извлечь из `FanPlugin` в сервисы:

| Сервис                 | Уровень | Источник                                         | Ответственность                                                                      |
|------------------------|---------|--------------------------------------------------|--------------------------------------------------------------------------------------|
| `FanConnectionService` | APP     | `FanPlugin` (connection state, api/ws lifecycle) | Управление `FanApiClient` + `FanWsClient`, состояние подключения, auto-start сервера |
| `FanSessionService`    | PROJECT | `FanPlugin` (session list, current)              | CRUD сессий через API, фильтрация, текущая сессия                                    |
| `FanMessageService`    | PROJECT | `ChatPanel` (send, stream)                       | sendMessage, обработка событий, история сообщений                                    |
| `FanServerService`     | PROJECT | `ServerDetector`                                 | Lifecycle процесса сервера, управление портом                                        |

Использовать аннотации `@Service(Service.Level.APP)` / `@Service(Service.Level.PROJECT)`.  
`FanPlugin` становится тонким координатором (50-80 строк), связывающим сервисы.

### 0.2 MessageBus event system

Создать `fan.idea.core.events` с listener-интерфейсами:

| Listener             | Topic                 | Методы                                                                            |
|----------------------|-----------------------|-----------------------------------------------------------------------------------|
| `ConnectionListener` | `@Topic.AppLevel`     | `onConnectionStateChanged(status)`, `onConnectionError(message)`                  |
| `SessionListener`    | `@Topic.ProjectLevel` | `onSessionCreated(session)`, `onSessionDeleted(id)`, `onSessionSelected(session)` |
| `MessageListener`    | `@Topic.ProjectLevel` | `onMessageReceived(event)`, `onGeneratingChanged(isGenerating)`                   |
| `SettingsListener`   | `@Topic.AppLevel`     | `onSettingsChanged(settings)`                                                     |

Заменить `SharedFlow`-based propagation на MessageBus publishers.  
UI-компоненты подписываются через MessageBus вместо прямого доступа к `FanPlugin`.

### 0.3 Cleanup

- Удалить `FanPluginManager.kt` (заменён на `@Service`)
- Удалить `FanPluginSettingsListener.kt` (dead code)
- Удалить `build.gradle.kts.orig`
- Зависимости: Ktor НЕ нужен (оставляем OkHttp). Добавить `com.jetbrains.jcef:jcef` для JCEF API
- Рассмотреть Kotlin upgrade: 1.9.24 → 2.1.0 (лучшие корутины + сериализация, как в ORF)

**Новые файлы:**

```
core/
├── events/
│   ├── ConnectionListener.kt
│   ├── SessionListener.kt
│   ├── MessageListener.kt
│   └── SettingsListener.kt
└── services/
    ├── app/
    │   ├── FanConnectionService.kt
    │   └── FanNotificationService.kt
    └── project/
        ├── FanSessionService.kt
        ├── FanMessageService.kt
        └── FanServerService.kt
```

**Модифицируемые:** `FanPlugin.kt` (slim down), `FanWsClient.kt` (typed events), `FanToolWindowFactory.kt`,
`build.gradle.kts`  
**Удаляемые:** `FanPluginManager.kt`, `FanPluginSettingsListener.kt`

---

## Phase 1: JCEF Rendering Engine (Visual Core, JCEF-only)

**Цель:** Заменить Swing JTextArea на JCEF (Chromium) для богатого HTML/CSS/JS рендеринга.  
**Оценка:** 5-6 задач, ~2 500 строк нового кода

### 1.1 JCEF Browser Wrapper (`JcefFanChatView`)

**Источник:** `ui/chat/jcef/JcefChatView.kt` (260 строк)

- `fan.idea.ui.chat.jcef.JcefFanChatView` — JPanel с встроенным `JBCefBrowser`
- Kotlin→JS bridge: `executeJs()` с очередью скриптов (`isReady` + `pendingScripts` + `flushPending()`)
- JS→Kotlin bridge: `JBCefJSQuery` для clarification callbacks (Phase 3)
- Загрузка HTML-шаблона с инжекцией CSS + JS
- `ensureNotDisposed()` guard
- **JCEF required — plugin will not work without JetBrains Runtime with JCEF support**

### 1.2 HTML/CSS/JS Resources

**Источник:** `resources/html/` (chat-jcef.html, chat-styles-jcef.css, chat.js)

```
idea-plugin/src/main/resources/
├── html/
│   ├── fan-chat.html          — base HTML template с #fan-messages-container
│   ├── css/
│   │   └── fan-chat-styles.css — CSS custom properties (--fan-bg-color, --fan-font-size, ...), dark theme oklch hue 260°
│   └── js/
│       └── fan-chat.js         — JS API с __fan_* prefix
```

JS API (`fan-chat.js`, ~590 строк):

| Категория      | Функции                                                                                                                          |
|----------------|----------------------------------------------------------------------------------------------------------------------------------|
| Core           | `__fan_appendHtml`, `__fan_setElementHtml`, `__fan_setElementText`, `__fan_clear`, `__fan_removeElement`, `__fan_scrollToBottom` |
| Code blocks    | `__fan_copyCode`, `__fan_initCopyIcons`                                                                                          |
| Highlight.js   | `__fan_initHl()` (lazy CDN load)                                                                                                 |
| Reasoning      | `__fan_createReasoningBlock`, `__fan_toggleReasoning`, `__fan_updateReasoningContent`                                            |
| Activity       | `__fan_createActivityBlock`, `__fan_toggleActivity`, `__fan_completeActivity`, `__fan_failActivity`, `__fan_setActivityTitle`    |
| Tool calls     | `__fan_addToolCallBlock`, `__fan_updateToolCallStatus`, `__fan_toggleToolCall`                                                   |
| Clarifications | `__fan_addClarificationButtons`, `__fan_removeClarificationButtons`                                                              |

### 1.3 Markdown Parser & Renderer

**Источник:** `ui/chat/markdown/MarkdownParser.kt` + `MarkdownRenderer.kt`

- `FanMarkdownParser` — парсит markdown → `ContentBlock` sealed interface (Text, CodeBlock, Heading, MarkdownList,
  Blockquote, HorizontalRule)
- `FanMarkdownRenderer` — рендерит блоки → HTML
- Поддержка: fenced code blocks (с языком), h1-h6, bold/italic/strikethrough/links/inline code, списки, цитаты, hr
- XSS sanitization через JSoup (добавить зависимость)

### 1.4 Code Block Component

**Источник:** `ui/chat/components/CodeBlockComponent.kt` + `CodeBlockRenderer.kt` + `SyntaxHighlighter.kt` +
`LanguageDetector.kt`

- `CodeBlockComponent` — фасад (renderer + highlighter + language detector)
- `FanSyntaxHighlighter` — regex-based подсветка: Kotlin, Java, Python, JavaScript, TypeScript, Bash, SQL, JSON, YAML,
  XML, Markdown
- `FanLanguageDetector` — автоопределение языка по паттернам кода
- HTML output: header bar (язык + copy button) + подсвеченный код с прокруткой
- Copy: `navigator.clipboard.writeText()` с `execCommand('copy')` fallback
- Large blocks: коллапс >500 строк / >50KB

### 1.5 HtmlDocumentManager (Unified Rendering API)

**Источник:** `ui/chat/manager/HtmlDocumentManager.kt` (1629 строк) — ЗНАЧИТЕЛЬНО упрощён

- `FanHtmlDocumentManager` — единый API поверх JCEF

Методы для типов событий FAN:

| Категория  | Методы                                                                                     |
|------------|--------------------------------------------------------------------------------------------|
| Messages   | `addUserMessage(content)`, `addAssistantMessage(renderedHtml)`                             |
| Streaming  | `startAssistantStream(): String`, `updateAssistantStream(content)`, `endAssistantStream()` |
| Thinking   | `showThinkingIndicator()`, `removeThinkingIndicator()`                                     |
| Tool calls | `addToolCallBlock(name, status, details, data)`, `updateToolCallStatus(id, status)`        |
| Errors     | `addErrorMessage(title, message)`, `addWarningMessage(title, message)`                     |
| System     | `addSystemMessage(text)`                                                                   |
| UI         | `scrollToBottom()`, `updateFontSize(size)`, `clearMessages()`                              |

- Упрощён vs ORF: нет agent plans, sub-agents, multiple activity blocks

**Новые файлы:**

```
ui/chat/
├── jcef/
│   ├── JcefFanChatView.kt
│   └── FanHtmlResources.kt
├── markdown/
│   ├── FanMarkdownParser.kt
│   └── FanMarkdownRenderer.kt
├── components/
│   ├── CodeBlockComponent.kt
│   ├── FanSyntaxHighlighter.kt
│   └── FanLanguageDetector.kt
├── manager/
│   └── FanHtmlDocumentManager.kt
└── FanChatPanel.kt              (replace ChatPanel.kt)
```

**Модифицируемые:** `build.gradle.kts` (JSoup, JCEF), `FanPlugin.kt`  
**Удаляемые:** `MessageRenderer.kt`, `ChatPanel.kt`

---

## Phase 2: Session Navigation & Input UX (User Experience)

**Цель:** Навигация по сессиям и input panel уровня ORF.  
**Оценка:** 3-4 задачи, ~1 200 строк нового кода

### 2.1 Session Navigator

**Источник:** `ui/chat/session/SessionNavigator.kt` + `SessionListPanel.kt` + `SessionListItem.kt`

- `FanSessionNavigator` — state machine (SESSION_LIST ↔ SESSION_CHAT)
- `FanSessionListPanel` — `JList<SessionMetadata>` с кастомным renderer
    - Заголовок сессии, относительный timestamp (Сегодня/Вчера/дата), кол-во сообщений
    - Click → open, hover → delete button
    - Empty state: "Введите сообщение для создания нового чата"
- `FanSessionListItem` — `ListCellRenderer`
- Context menu: rename (JOptionPane), delete (с подтверждением)
- Оставляем текущее поведение FAN: сессии с сервера, фильтрация по project path

### 2.2 Input Panel Upgrade

**Источник:** `ui/chat/InputPanel.kt` + `CommandPopup.kt`

Замена `InputPanel.kt` (143 строки) на ORF-style:

| Фича           | Текущее            | Новое                                                  |
|----------------|--------------------|--------------------------------------------------------|
| Компонент      | JEditor (1 строка) | JTextArea (1-6 строк, auto-height)                     |
| Отправка       | Ctrl+Enter         | **Enter** (Shift+Enter = newline)                      |
| Placeholder    | нет                | "Ask anything..." / "Введите ответ..." (clarification) |
| Stop button    | нет                | Кнопка остановки при генерации                         |
| History        | нет                | Up/Down, 100 entries, persist per session              |
| Commands       | нет                | `/` → popup slash commands                             |
| Context toggle | нет                | Кнопка прикрепления текущего файла                     |

### 2.3 Header & Footer Panels

**Источник:** `ui/chat/HeaderPanel.kt` + `FooterPanel.kt`

- Header: "FAN Agent" title, "← Sessions" back button, заголовок сессии, connection status dot
- Footer: индикатор активного файла, info о контексте (future)

**Новые файлы:**

```
ui/chat/
├── FanInputPanel.kt             (replace InputPanel.kt)
├── FanSessionListPanel.kt       (replace SessionListPanel.kt)
├── FanSessionNavigator.kt       (new)
├── FanSessionListItem.kt        (new)
├── FanHeaderPanel.kt            (new)
├── FanFooterPanel.kt            (new)
├── session/
│   ├── FanSessionActions.kt     (new)
│   └── FanSessionDeleteDialog.kt (new)
└── components/
    └── FanCommandPopup.kt       (new)
```

**Модифицируемые:** `FanToolWindowFactory.kt` (use navigator)  
**Удаляемые:** `InputPanel.kt`, `SessionListPanel.kt`, `WelcomePanel.kt`

---

## Phase 3: Agent Run UI (Rich Event Visualization)

**Цель:** Визуализация событий FAN agent (coordinator mode) — activity blocks, tool calls, reasoning.  
**Оценка:** 4-5 задач, ~1 000 строк нового кода

### 3.1 Event Type Mapping (FAN ↔ ORF)

| FAN WS Event    | ORF Equivalent            | Визуализация                                |
|-----------------|---------------------------|---------------------------------------------|
| `text_chunk`    | Streaming assistant text  | Streaming markdown в assistant message      |
| `thinking`      | ReasoningStepEvent        | Collapsible reasoning block со спиннером    |
| `tool_use`      | ToolCallEvent (started)   | Tool call block со статусом running         |
| `tool_result`   | ToolCallEvent (completed) | Tool call block с результатом, status badge |
| `error`         | RunErrorEvent             | Error message block                         |
| `session_start` | (internal)                | System message                              |
| `message_added` | (internal)                | Final assistant message                     |
| `session_end`   | RunEndEvent               | Complete activity block                     |

### 3.2 Activity Block System

**Источник:** `ui/chat/agent/AgentEventHandler.kt` + `ChatPanelAgentConsumer.kt` + `AgentRunState.kt`

- `FanAgentEventHandler` — диспетчер FAN events → UI consumer callbacks
- `FanAgentEventConsumer` interface:
    - `onTextChunk(content: String)`
    - `onThinkingStart()`, `onThinkingUpdate(text: String)`, `onThinkingEnd()`
    - `onToolUse(toolName: String, args: String)`
    - `onToolResult(toolName: String, result: String, isError: Boolean)`
    - `onError(message: String)`
    - `onSessionEnd()`
- `FanAgentRunState` — mutable state для текущего run
- Wiring: `FanWsClient` → `FanAgentEventHandler` → UI

### 3.3 Tool Call Visualization

**Источник:** `ui/chat/agent/ToolCallFormatter.kt` + chat.js tool call functions

- `FanToolCallFormatter` — форматирует tool calls в HTML:

| Tool    | Отображение                         |
|---------|-------------------------------------|
| `read`  | "Read: /path/to/file"               |
| `write` | "Write: /path/to/file"              |
| `edit`  | "Edit: /path/to/file"               |
| `bash`  | "Cmd: command" (truncated 80 chars) |
| Generic | "Tool: name"                        |

- Collapsible blocks в chat.js: name, status icon (running/done/error), details, expandable data
- Content fields rendering: code blocks для `content`, `diff`, `output`, `stdout`, `stderr`

### 3.4 Clarification / Question Tool

**Источник:** `ui/chat/agent/ClarificationHandler.kt` + `components/ClarificationPopup.kt`

- FAN agent использует `question` tool (ask-answer skill) → clarification block
- Блок с фиолетовой рамкой + текст вопроса + интерактивные кнопки
- User click → response через `POST /api/sessions/{id}/messages`
- `JBCefJSQuery` bridge: JS `__fan_onClarificationClick(blockId, option)` → Kotlin handler
- Input panel placeholder меняется на "Введите ответ..."

**Новые файлы:**

```
ui/chat/
├── agent/
│   ├── FanAgentEventHandler.kt
│   ├── FanAgentEventConsumer.kt   (interface)
│   ├── FanAgentRunState.kt
│   ├── FanToolCallFormatter.kt
│   └── FanClarificationHandler.kt
```

---

## Phase 4: Status Bar & Notifications (Polish)

**Цель:** Профессиональный индикатор подключения и система уведомлений.  
**Оценка:** 2-3 задачи, ~400 строк нового кода

### 4.1 Status Bar Widget

**Источник:** `ui/status/OrfStatusWidgetFactory.kt` + `OrfStatusWidget.kt` + `StatusManager.kt` + `StatusIcons.kt`

- `FanStatusWidgetFactory` — `StatusBarWidgetFactory`
- `FanStatusWidget` — `CustomStatusBarWidget`
    - Состояния: CONNECTED (green), ERROR (red), CONNECTING (spinner), DISCONNECTED (gray)
    - SVG иконки для каждого состояния
    - Click → popup menu: "Reconnect", "Settings...", "About"
- `FanStatusManager` (APP-level) — reactive state machine
    - Подписка на `ConnectionListener` через MessageBus
    - Публикация на `StatusListener` при смене состояния
    - Auto-recheck при изменении настроек
- Регистрация в `plugin.xml`: `statusBarWidgetFactory`

### 4.2 Notification System

**Источник:** `core/services/app/NotificationService.kt`

- `FanNotificationService` (APP-level) — уже частично есть через `FanNotificationGroup.kt` + `NotificationHelper.kt`
- Exception-to-notification mapping:

| Exception              | Балун           | In-chat |
|------------------------|-----------------|---------|
| Network error          | WARNING balloon | Да      |
| Server error           | ERROR balloon   | Да      |
| Connection lost        | WARNING balloon | Да      |
| Non-critical (timeout) | Нет             | Да      |

**Новые файлы:**

```
ui/status/
├── FanStatusWidgetFactory.kt
├── FanStatusWidget.kt
├── FanStatusManager.kt
└── FanStatusIcons.kt

resources/icons/status/
├── connected.svg
├── error.svg
└── disconnected.svg
```

**Модифицируемые:** `plugin.xml` (statusBarWidgetFactory)  
**Удаляемые:** `StatusBar.kt`

---

## Phase 5: Theme & Final Polish

**Цель:** Dark/light theme поддержка, размер шрифта, плавные анимации.  
**Оценка:** 2 задачи, ~300 строк нового кода

### 5.1 Theme Integration

**Источник:** `ui/chat/ChatColors.kt` + CSS custom properties

CSS variables в `fan-chat-styles.css` — динамически обновляются из IntelliJ LaF:

```css
--fan-bg-color /* Editor background */
--fan-text-color /* Editor foreground */
--fan-border-color /* Component border */
--fan-accent-color /* FAN blue (oklch hue 260°) */
--fan-code-bg /* Code block background */
--fan-code-text /* Code block text */
--fan-user-msg-bg /* User message bubble */
--fan-assistant-msg-bg

/* Assistant message bubble */
```

- Слушать `EditorColorsManager.TOPIC` / `UiDefaultsEvent` для смены темы
- JCEF: `__fan_setBackgroundColor()` + `__fan_updateTheme()` JS calls при смене

### 5.2 Font Size & Accessibility

- Настройка в FAN Agent settings panel: 12/13/14/15/16px
- `__fan_setFontSize()` JS call при изменении
- Default: `editor.fontSize` из IDE настроек

**Модифицируемые:** `FanPluginSettings.kt` (chatFontSize), `FanPluginConfigurable.kt` (font size UI),
`fan-chat-styles.css`

---

## Полная карта файлов

### Новые файлы (~33)

```
idea-plugin/src/main/kotlin/fan/idea/
├── core/
│   ├── events/
│   │   ├── ConnectionListener.kt
│   │   ├── SessionListener.kt
│   │   ├── MessageListener.kt
│   │   └── SettingsListener.kt
│   └── services/
│       ├── app/
│       │   ├── FanConnectionService.kt
│       │   └── FanNotificationService.kt
│       └── project/
│           ├── FanSessionService.kt
│           ├── FanMessageService.kt
│           └── FanServerService.kt
├── ui/
│   ├── chat/
│   │   ├── FanChatPanel.kt
│   │   ├── FanInputPanel.kt
│   │   ├── FanSessionListPanel.kt
│   │   ├── FanSessionNavigator.kt
│   │   ├── FanSessionListItem.kt
│   │   ├── FanHeaderPanel.kt
│   │   ├── FanFooterPanel.kt
│   │   ├── FanChatConstants.kt
│   │   ├── FanChatColors.kt
│   │   ├── agent/
│   │   │   ├── FanAgentEventHandler.kt
│   │   │   ├── FanAgentEventConsumer.kt
│   │   │   ├── FanAgentRunState.kt
│   │   │   ├── FanToolCallFormatter.kt
│   │   │   └── FanClarificationHandler.kt
│   │   ├── components/
│   │   │   ├── CodeBlockComponent.kt
│   │   │   ├── FanSyntaxHighlighter.kt
│   │   │   ├── FanLanguageDetector.kt
│   │   │   └── FanCommandPopup.kt
│   │   ├── jcef/
│   │   │   ├── JcefFanChatView.kt
│   │   │   └── FanHtmlResources.kt
│   │   ├── manager/
│   │   │   └── FanHtmlDocumentManager.kt
│   │   ├── markdown/
│   │   │   ├── FanMarkdownParser.kt
│   │   │   └── FanMarkdownRenderer.kt
│   │   └── session/
│   │       ├── FanSessionActions.kt
│   │       └── FanSessionDeleteDialog.kt
│   └── status/
│       ├── FanStatusWidgetFactory.kt
│       ├── FanStatusWidget.kt
│       ├── FanStatusManager.kt
│       └── FanStatusIcons.kt

idea-plugin/src/main/resources/
├── html/
│   ├── fan-chat.html
│   ├── css/
│   │   └── fan-chat-styles.css
│   └── js/
│       └── fan-chat.js
└── icons/status/
    ├── connected.svg
    ├── error.svg
    └── disconnected.svg
```

### Модифицируемые файлы (~15)

| Файл                       | Изменение                                                |
|----------------------------|----------------------------------------------------------|
| `FanPlugin.kt`             | Slim down → тонкий координатор (50-80 строк)             |
| `FanToolWindowFactory.kt`  | FanSessionNavigator вместо ViewSwitcher, JcefFanChatView |
| `build.gradle.kts`         | JSoup, возможно Kotlin upgrade, JCEF API dependency      |
| `plugin.xml`               | `statusBarWidgetFactory`, обновление tool window         |
| `FanPluginSettings.kt`     | Добавить `chatFontSize`                                  |
| `FanPluginConfigurable.kt` | Font size setting UI                                     |
| `FanWsClient.kt`           | Typed events, MessageBus integration                     |
| `FanApiClient.kt`          | Minor: добавить endpoint methods по необходимости        |

### Удаляемые файлы (~7)

| Файл                           | Причина                                |
|--------------------------------|----------------------------------------|
| `FanPluginManager.kt`          | Заменён на `@Service` аннотации        |
| `FanPluginSettingsListener.kt` | Dead code, не реализован               |
| `MessageRenderer.kt`           | Заменён на FanMarkdownParser + JCEF    |
| `StatusBar.kt`                 | Заменён на FanStatusWidget             |
| `WelcomePanel.kt`              | Слит с empty state FanSessionListPanel |
| `ChatPanel.kt`                 | Заменён на FanChatPanel                |
| `InputPanel.kt`                | Заменён на FanInputPanel               |

---

## Сводка по фазам

| Phase              | Новых   | Модиф.  | Удал.  | ~Строк кода | Зависимости              |
|--------------------|---------|---------|--------|-------------|--------------------------|
| 0: Architecture    | 8       | 4       | 2      | ~800        | —                        |
| 1: JCEF Rendering  | 8       | 3       | 1      | ~2 500      | Phase 0                  |
| 2: Session & Input | 8       | 2       | 3      | ~1 200      | Phase 1                  |
| 3: Agent UI        | 5       | 2       | 0      | ~1 000      | Phase 2                  |
| 4: Status & Notif. | 4       | 1       | 1      | ~400        | Phase 3                  |
| 5: Theme           | 0       | 3       | 0      | ~300        | Phase 1 (parallel с 3-4) |
| **Итого**          | **~33** | **~15** | **~7** | **~6 200**  |                          |

### Граф зависимостей

```
Phase 0 ──→ Phase 1 ──┬──→ Phase 2 ──→ Phase 3 ──→ Phase 4
                       │                        ↗
                       └──→ Phase 5 ─────────────┘
```

- **Phase 0** → все остальные (foundation)
- **Phase 1** → Phases 2, 3, 4, 5 (rendering engine нужен первым)
- **Phase 2** → Phase 3 (навигация перед agent UI)
- **Phase 3** → Phase 4 (agent UI перед status integration)
- **Phase 5** может параллелиться с Phase 3-4

---

## Риски

| # | Риск                                                           | Влияние            | Митигация                                                    |
|---|----------------------------------------------------------------|--------------------|--------------------------------------------------------------|
| 1 | **Kotlin upgrade** 1.9.24 → 2.1.0 — compilation issues         | Блокировка         | Инкрементальный тест                                         |
| 2 | **Bundle size** — JSoup + JCEF resources                       | Больше плагин      | JSoup ~1MB, приемлемо                                        |
| 3 | **Performance** — JCEF startup vs Swing                        | Медленный старт    | Lazy init, script queuing                                    |
| 4 | **Coroutines** — зависимость от IntelliJ bundled version       | Ограничения        | `executeOnPooledThread` для Swing UI, no explicit dependency |

> **Примечание:** JCEF (JBCefBrowser) является обязательным требованием. Все современные JetBrains IDE начиная с 2020.3 включают JCEF Runtime. Плагин требует JetBrains Runtime — работа на plain JDK не поддерживается.

---

## Not in scope

Следующие возможности ORF plugin намеренно исключены из данной дорожной карты:

- Inline code completion (комплементация в редакторе)
- Refactoring diff dialog + inline edit
- Client-side session encryption (AES)
- Sound notifications (WAV)
- RAG context selectors (repository/doc)
- Multi-agent activity blocks
- Agent plan visualization
