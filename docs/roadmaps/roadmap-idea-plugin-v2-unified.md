# IDEA Plugin v2 — Unified Roadmap (TUI-Style JCEF)

> Объединённый план реализации: архитектура (ORF patterns) + визуальная система (TUI-style styling spec)  
> **Создано:** 2026-04-24  
> **Статус:** Planned  
> **Бранч:** TBD  
> **Источник 1 (Structure):** `roadmap-idea-plugin-v2-from-orf-ed2.md` — 6 фаз, декомпозиция задач, карты файлов  
> **Источник 2 (UI Design):** `spec_idea-plugin-tui-styling_2026-04-24.md` — CSS-переменные, HTML, JS API, Kotlin-интеграция

---

## Требования (JCEF-only)

**JCEF (JBCefBrowser) — обязательное требование.** Все современные JetBrains IDE начиная с 2020.3 включают JCEF Runtime. Плагин будет работать только на JetBrains Runtime, не на plain JDK.

**Минимальная версия IDE:** IC-2024.1+

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

### Источники истины (визуальная система)

| Сущность | Файл/Расположение |
|----------|-------------------|
| TUI-тема (тёмная) | `packages/coding-agent/src/modes/interactive/theme/dark.json` |
| TUI-тема (светлая) | `packages/coding-agent/src/modes/interactive/theme/light.json` |
| ORF HTML-шаблон | `~/projects/ailab-orf-plugin/src/main/resources/html/chat-jcef.html` |
| ORF CSS | `~/projects/ailab-orf-plugin/src/main/resources/html/chat-styles-jcef.css` + `code-block-styles.css` |
| ORF JS | `~/projects/ailab-orf-plugin/src/main/resources/html/chat.js` |
| ORF Kotlin | `~/projects/ailab-orf-plugin/src/main/kotlin/orf/ui/chat/jcef/JcefChatView.kt` |
| ORF HTML-генерация | `~/projects/ailab-orf-plugin/src/main/kotlin/orf/ui/chat/HtmlDocumentManager.kt` |

---

## Ключевые различия (что НЕ копируем)

| Аспект         | ORF Plugin                    | FAN Plugin                         | Решение                   |
|----------------|-------------------------------|------------------------------------|---------------------------|
| Backend API    | Filin REST + GraphQL WS       | FAN REST + plain WS                | Оставляем FAN API клиент  |
| Сессии         | Client-side JSON + шифрование | Server-side JSONL                  | Оставляем FAN сессии      |
| Agent protocol | SGR (custom binary WS)        | FAN coordinator (REST + WS events) | Адаптируем типы событий   |
| Completion     | Inline code completion        | N/A                                | Не в scope                |
| Refactoring    | Diff dialog + inline edit     | N/A                                | Не в scope                |
| HTTP client    | Ktor                          | OkHttp                             | Оставляем OkHttp          |
| WS client      | Ktor WebSocket                | OkHttp WebSocket                   | Оставляем OkHttp WebSocket |
| Шифрование     | AES для файлов сессий         | N/A                                | Не нужно                  |
| Звук           | WAV notifications             | N/A                                | Future (низкий приоритет) |
| RAG context    | Repository/doc selector       | File context (Phase 2)             | Адаптируем позже          |

### Пользовательские решения (визуальная система)

| Решение | Выбор |
|---------|-------|
| **Раскладка сообщений** | ORF-style bubble — пользовательские сообщения: 80% max-width, выровнены вправо, скруглённые углы |
| **Тема** | Адаптированные цвета TUI — основной акцент/сообщения/инструменты из `dark.json`/`light.json`, базовый bg/fg адаптирован к IntelliJ LaF (чуть ярче/мягче) |
| **Подсветка кода** | highlight.js (ленивая загрузка с CDN, как в ORF) |
| **Tool-блоки** | Сворачиваемые блоки (как в ORF) — имя инструмента + status badge, раскрываемое содержимое |
| **Футер** | Полный футер TUI внутри JCEF — CWD+branch, token stats, model name, context usage bar |

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
- Зависимости: Ktor НЕ нужен (оставляем OkHttp). Добавить `com.jetbrains.jcef:jcef` для JCEF API, `org.jsoup:jsoup` для санитизации
- Рассмотреть Kotlin upgrade: 1.9.24 → 2.1.0 (лучшие корутины + сериализация, как в ORF)

### Новые/модифицируемые/удаляемые файлы (Phase 0)

**Новые:**

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

**Модифицируемые:** `FanPlugin.kt` (slim down), `FanWsClient.kt` (typed events), `FanToolWindowFactory.kt`, `build.gradle.kts`  
**Удаляемые:** `FanPluginManager.kt`, `FanPluginSettingsListener.kt`

---

## Phase 1: JCEF Rendering Engine (Visual Core, TUI-Style)

**Цель:** Заменить Swing JTextArea на JCEF (Chromium) для богатого HTML/CSS/JS рендеринга в стиле TUI FAN. Это основная фаза — содержит полную визуальную систему, CSS-переменные, JS API, рендеринг всех типов блоков.  
**Оценка:** 6-8 задач, ~3 500 строк нового кода (включая CSS/JS ресурсы)

### 1.1 JCEF Browser Wrapper (`JcefFanChatView`)

`fan.idea.ui.chat.jcef.JcefFanChatView` — JPanel с встроенным `JBCefBrowser`.

**Ответственность:** обёртка JCEF, загрузка HTML-шаблона, Kotlin↔JS bridge.

**Методы:**

| Метод | Описание |
|-------|----------|
| `loadHtml(html: String)` | Загрузить начальный HTML-шаблон |
| `executeJs(script: String)` | Выполнить JavaScript |
| `isReady: Boolean` | Отслеживание состояния загрузки Cef |
| `pendingScripts: MutableList<String>` | Очередь скриптов до готовности |
| `flushPending()` | Выполнить отложенные скрипты при `onLoadingStateChanged(LoadingState.COMPLETE)` |

**Bridge Kotlin→JS:**

- `executeJs()` с очередью скриптов (`isReady` + `pendingScripts` + `flushPending()`)
- Все вызовы обёрнуты в try-catch с логированием
- HTML-экранирование во всех параметрах (XSS-предотвращение)
- JSON-сериализация для комплексных объектов

**Bridge JS→Kotlin:**

- `JBCefJSQuery` для clarification callbacks (Phase 3)
- `JBCefJSQuery` для других коллбэков из JS в Kotlin (например, copy feedback)
- Обработка query result через `JBCefJSQueryHandler`

**Lifecycle:**

- `ensureNotDisposed()` guard — предотвращение вызовов после dispose
- Lazy init — JCEF создаётся только при первом отображении tool window
- Script queuing — скрипты, вызванные до загрузки страницы, ставятся в очередь и выполняются при `onLoadingStateChanged(LoadingState.COMPLETE)`

**JCEF required — plugin will not work without JetBrains Runtime with JCEF support.** Fallback на `JEditorPane` **не предусмотрен**.

---

### 1.2 Система цветов и CSS

Полная цветовая система на основе CSS custom properties. Палитра TUI FAN (`dark.json`/`light.json`), адаптированная под IntelliJ LaF — чуть более яркие и мягкие цвета для десктопа.

#### Тёмная тема — адаптировано из TUI `dark.json`

```css
:root, [data-fan-theme="dark"] {
  /* === Основные === */
  --fan-bg-color: #1e1e2e;           /* базовый фон (адаптирован под IntelliJ Darcula; TUI default — terminal bg) */
  --fan-text-color: #d4d4d4;         /* основной текст (мягче чистого white) */
  --fan-text-secondary: #8abeb7;     /* акцентный текст (TUI accent #8abeb7) */

  /* === Сообщения === */
  --fan-user-bg: #343541;            /* фон пользовательского сообщения (TUI userMsgBg, точно) */
  --fan-user-text: #e4e4e4;          /* текст пользовательского сообщения */
  --fan-assistant-bg: transparent;   /* фон ассистента (TUI: без фона) */

  /* === Системные === */
  --fan-system-color: #808080;       /* системные сообщения (TUI muted/gray) */
  --fan-border-color: #3d3d5c;       /* рамки (TUI border #5f87ff, но приглушённее для десктопа) */
  --fan-accent: #8abeb7;             /* основной акцент (TUI accent, точно) */
  --fan-accent-secondary: #f0c674;   /* вторичный акцент (TUI mdHeading gold) */

  /* === Блоки кода === */
  --fan-code-bg: #282c34;            /* фон блока кода (адаптировано из TUI toolPendingBg #282832) */
  --fan-code-border: #3d3d5c;        /* рамка блока кода */
  --fan-code-text: #b5bd68;          /* содержимое кода (TUI mdCodeBlock green, точно) */
  --fan-code-lang-label: #8abeb7;    /* метка языка (TUI mdCode/accent) */

  /* === Tool-блоки === */
  --fan-tool-pending-bg: #282832;    /* pending (TUI, точно) */
  --fan-tool-success-bg: #283228;    /* success (TUI, точно) */
  --fan-tool-error-bg: #3c2828;      /* error (TUI, точно) */

  /* === Ошибки и предупреждения === */
  --fan-error-bg: #3c2828;           /* фон ошибки (TUI toolErrorBg) */
  --fan-error-text: #cc6666;         /* текст ошибки (TUI error/red, точно) */
  --fan-warning-text: #f0c674;       /* текст предупреждения (TUI mdHeading, тёплый) */

  /* === Thinking-блоки === */
  --fan-thinking-text: #808080;      /* текст thinking (TUI thinkingText gray, точно) */
  --fan-thinking-bg: #282832;        /* фон thinking-блока (приглушённый) */

  /* === Markdown === */
  --fan-md-heading: #f0c674;         /* заголовки (TUI, точно) */
  --fan-md-link: #81a2be;            /* ссылки (TUI, точно) */
  --fan-md-code: #8abeb7;            /* inline-код (TUI mdCode/accent, точно) */
  --fan-md-quote: #808080;           /* цитаты (TUI, точно) */
  --fan-md-list-bullet: #8abeb7;     /* маркеры списка (TUI, точно) */

  /* === Diff === */
  --fan-diff-added: #b5bd68;         /* добавленные строки (TUI toolDiffAdded green, точно) */
  --fan-diff-removed: #cc6666;       /* удалённые строки (TUI toolDiffRemoved red, точно) */
  --fan-diff-context: #808080;       /* контекстные строки (TUI, точно) */

  /* === Футер === */
  --fan-footer-text: #666666;        /* текст футера (TUI dimGray) */
}
```

#### Светлая тема — адаптировано из TUI `light.json`

```css
[data-fan-theme="light"] {
  /* === Основные === */
  --fan-bg-color: #fafafa;
  --fan-text-color: #1e1e2e;
  --fan-text-secondary: #5a8080;

  /* === Сообщения === */
  --fan-user-bg: #e8e8e8;
  --fan-user-text: #2a2a2a;
  --fan-assistant-bg: transparent;

  /* === Системные === */
  --fan-system-color: #6c6c6c;
  --fan-border-color: #d0d0d0;
  --fan-accent: #5a8080;
  --fan-accent-secondary: #9a7326;

  /* === Блоки кода === */
  --fan-code-bg: #f0f0f0;
  --fan-code-border: #d0d0d0;
  --fan-code-text: #588458;
  --fan-code-lang-label: #5a8080;

  /* === Tool-блоки === */
  --fan-tool-pending-bg: #e8e8f0;
  --fan-tool-success-bg: #e8f0e8;
  --fan-tool-error-bg: #f0e8e8;

  /* === Ошибки и предупреждения === */
  --fan-error-bg: #f0e8e8;
  --fan-error-text: #aa5555;
  --fan-warning-text: #9a7326;

  /* === Thinking-блоки === */
  --fan-thinking-text: #6c6c6c;
  --fan-thinking-bg: #e8e8f0;

  /* === Markdown === */
  --fan-md-heading: #9a7326;
  --fan-md-link: #547da7;
  --fan-md-code: #5a8080;
  --fan-md-quote: #6c6c6c;
  --fan-md-list-bullet: #588458;

  /* === Diff === */
  --fan-diff-added: #588458;
  --fan-diff-removed: #aa5555;
  --fan-diff-context: #6c6c6c;

  /* === Футер === */
  --fan-footer-text: #767676;
}
```

#### Общие переменные (не зависят от темы)

```css
:root {
  --fan-font-size: 14px;
  --fan-font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  --fan-message-radius: 12px;        /* скругление bubble (ORF-style) */
  --fan-block-radius: 8px;           /* скругление tool/thinking блоков */
}
```

#### Механизм переключения тем

- **Определение IntelliJ LaF:** `UIUtil.isUnderDarcula()` или `EditorColorsManager.getInstance().isDarkEditor`
- **Установка темы:** через JS-функцию `__fan_updateTheme(isDark)` — устанавливает `data-fan-theme` attribute на `<html>`
- **Прослушивание изменений:** `EditorColorsManager.TOPIC` + `UiDefaultsEvent` (аналогично ORF)
- **Реактивность:** при смене темы IDE — мгновенное обновление без перезагрузки страницы
- CSS-переменные определяются в `:root` для тёмной (по умолчанию) и в `[data-fan-theme="light"]` для светлой

---

### 1.3 HTML-шаблон (`fan-chat.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${FAN_CHAT_STYLES}</style>
  <style>${CODE_BLOCK_STYLES}</style>
</head>
<body>
  <div id="fan-messages-container">
    <!-- Messages rendered here -->
  </div>
  <div id="fan-footer" class="fan-footer">
    <div class="fan-footer-line-1">
      <span id="fan-footer-cwd"></span>
      <span id="fan-footer-branch"></span>
      <span id="fan-footer-session"></span>
    </div>
    <div class="fan-footer-line-2">
      <span id="fan-footer-stats"></span>
      <span id="fan-footer-context"></span>
      <span id="fan-footer-model"></span>
    </div>
  </div>
  <script>${FAN_CHAT_JS}</script>
</body>
</html>
```

CSS/JS инжектируются через подстановку placeholder'ов (как в ORF `ChatHtmlResources.kt`). Класс `FanHtmlResources` загружает `fan-chat-styles.css` и `fan-chat.js`, подставляет их содержимое в шаблон.

---

### 1.4 JavaScript API (`fan-chat.js`)

Функции адаптированы из ORF `chat.js` с префиксом `__fan_*`. Примерный объём: ~590 строк JavaScript.

#### 1.4.1 Базовые DOM-операции

| Функция | Описание |
|---------|----------|
| `__fan_appendHtml(html)` | Добавить дочерние узлы в `#fan-messages-container` |
| `__fan_setBody(html)` | Заменить всё содержимое чата (загрузка сессии) |
| `__fan_clear()` | Очистить все сообщения |
| `__fan_removeElement(id)` | Удалить элемент по ID |
| `__fan_setElementHtml(id, html)` | Заменить innerHTML элемента |
| `__fan_setElementText(id, text)` | Заменить textContent элемента |
| `__fan_scrollToBottom()` | Плавная прокрутка вниз |

#### 1.4.2 Сообщения

| Функция | Описание |
|---------|----------|
| `__fan_addUserMessage(content)` | Создать div пользовательского сообщения (`.fan-user-message`) |
| `__fan_addAssistantMessage(content)` | Создать div сообщения ассистента (`.fan-assistant-message`) |
| `__fan_addSystemMessage(text)` | Создать div системного сообщения (`.fan-system-message`) |
| `__fan_addErrorMessage(title, message)` | Создать div сообщения об ошибке (`.fan-error-message`) |

#### 1.4.3 Стриминг

| Функция | Описание |
|---------|----------|
| `__fan_startAssistantStream()` | Создать контейнер стриминга, вернуть ID элемента |
| `__fan_updateAssistantStream(id, content)` | Обновить содержимое стрима |
| `__fan_endAssistantStream(id)` | Финализировать стрим, удалить курсор |

#### 1.4.4 Thinking-блоки

| Функция | Описание |
|---------|----------|
| `__fan_createReasoningBlock(id)` | Создать thinking-блок со спиннером |
| `__fan_updateReasoningContent(id, content)` | Обновить текст thinking |
| `__fan_completeReasoning(id)` | Остановить спиннер, показать ✓ |
| `__fan_toggleReasoning(id)` | Свернуть/развернуть |

#### 1.4.5 Tool Call-блоки

| Функция | Описание |
|---------|----------|
| `__fan_addToolCallBlock(id, toolName, status, icon, summary)` | Создать tool-блок |
| `__fan_updateToolCallStatus(id, status)` | Изменить pending→success/error |
| `__fan_updateToolCallResult(id, resultHtml)` | Установить содержимое результата |
| `__fan_toggleToolCall(id)` | Свернуть/развернуть |

#### 1.4.6 Код

| Функция | Описание |
|---------|----------|
| `__fan_copyCode(button)` | Скопировать содержимое блока кода, переключить иконку |
| `__fan_initHl()` | Ленивая загрузка highlight.js |
| `__fan_highlightAll()` | Подсветить все новые `<pre><code>` блоки |

#### 1.4.7 Тема

| Функция | Описание |
|---------|----------|
| `__fan_updateTheme(isDark)` | Установить `data-fan-theme` attribute (dark/light), обновить все CSS-переменные |
| `__fan_setFontSize(px)` | Обновить `--fan-font-size` |

#### 1.4.8 Футер

| Функция | Описание |
|---------|----------|
| `__fan_updateFooter(data)` | Обновить статистику футера (CWD, branch, stats, model, context) |

#### 1.4.9 Уточнения

| Функция | Описание |
|---------|----------|
| `__fan_addClarificationButtons(id, options)` | Отрендерить блок вопросов с кнопками |
| `__fan_removeClarificationButtons(id)` | Удалить после ответа |

#### 1.4.10 Автопрокрутка

После каждого `appendHtml`, `updateAssistantStream` — автопрокрутка через `requestAnimationFrame`.

---

### 1.5 Markdown Parser & Renderer

**Источник:** `ui/chat/markdown/MarkdownParser.kt` + `MarkdownRenderer.kt`

#### 1.5.1 FanMarkdownParser

**Вход:** сырой markdown-текст  
**Выход:** `ContentBlock` sealed interface (аналогично ORF `MarkdownParser`):

```kotlin
sealed interface ContentBlock {
  data class TextBlock(val content: String, val styles: List<InlineStyle>) : ContentBlock
  data class CodeBlock(val language: String?, val code: String) : ContentBlock
  data class HeadingBlock(val level: Int, val content: String) : ContentBlock
  data class ListBlock(val ordered: Boolean, val items: List<ListItem>, val depth: Int) : ContentBlock
  data class BlockquoteBlock(val content: String) : ContentBlock
  object HorizontalRuleBlock : ContentBlock
  data class TableBlock(val headers: List<String>, val rows: List<List<String>>) : ContentBlock
  data class ImageBlock(val alt: String, val url: String) : ContentBlock
}
```

#### 1.5.2 FanMarkdownRenderer

**Вход:** `List<ContentBlock>`  
**Выход:** HTML-строка

Поддержка: fenced code blocks (с языком), h1-h6, bold/italic/strikethrough/links/inline code, списки, цитаты, hr, таблицы, изображения.

**CSS для markdown-элементов:**

```css
/* Заголовки */
h1, h2, h3, h4, h5, h6 {
  color: var(--fan-md-heading);
  font-weight: 700;
}
h1 { text-decoration: underline; }

/* Ссылки */
a {
  color: var(--fan-md-link);
  text-decoration: underline;
}

/* Цитаты */
blockquote {
  border-left: 3px solid var(--fan-md-quote);
  color: var(--fan-md-quote);
  padding-left: 12px;
  margin: 8px 0;
  font-style: italic;
}

/* Списки */
ul, ol { padding-left: 20px; }
li { color: var(--fan-text-color); }
li::marker { color: var(--fan-md-list-bullet); }
ol li::marker { color: var(--fan-md-list-bullet); }

/* Горизонтальная линия */
hr {
  border: none;
  border-top: 1px solid var(--fan-md-quote);
  margin: 12px 0;
}

/* Инлайн-форматирование */
strong { font-weight: 700; }
em { font-style: italic; }
del { text-decoration: line-through; opacity: 0.7; }
```

#### 1.5.3 XSS-санитизация

- Использование JSoup `Whitelist.relaxed()` для HTML-санитизации
- Весь пользовательский контент санитизируется перед инъекцией в JCEF
- Атрибуты `onclick`, `onerror`, `javascript:` полностью удаляются
- JSoup зависимость добавляется в `build.gradle.kts`

---

### 1.6 Блоки кода (Code Blocks)

На основе структуры ORF с цветами TUI.

**Компоненты:** `CodeBlockComponent` (фасад), `FanSyntaxHighlighter` (regex-based), `FanLanguageDetector` (автоопределение языка).

**HTML-структура:**

```html
<div class="fan-code-block">
  <div class="fan-code-header">
    <span class="fan-code-lang">{language}</span>
    <button class="fan-code-copy" onclick="__fan_copyCode(this)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
      </svg>
    </button>
  </div>
  <pre><code class="language-{language}">{code content}</code></pre>
</div>
```

**CSS:**

```css
.fan-code-block {
  margin: 8px 0;
  border-radius: var(--fan-block-radius);
  background: var(--fan-code-bg);
  border: 1px solid var(--fan-code-border);
  overflow: hidden;
}

.fan-code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid var(--fan-code-border);
}

.fan-code-lang {
  color: var(--fan-code-lang-label);
  font-style: italic;
  font-size: 0.85em;
  font-family: var(--fan-font-family);
}

.fan-code-copy {
  background: none;
  border: none;
  color: var(--fan-system-color);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8em;
  transition: background 0.15s ease, color 0.15s ease;
}

.fan-code-copy:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--fan-text-color);
}

.fan-code-copy.copied {
  color: var(--fan-diff-added);
}

pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  font-family: var(--fan-font-family);
  font-size: 0.9em;
  line-height: 1.5;
}

code {
  color: var(--fan-code-text);
  font-family: var(--fan-font-family);
}

/* Inline-код */
code:not(pre code) {
  background: var(--fan-code-bg);
  color: var(--fan-md-code);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: var(--fan-font-family);
}
```

**Интеграция highlight.js:**

- Ленивая загрузка с CDN: `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js`
- Тема для тёмной: GitHub Dark Dimmed (соответствует эстетике TUI)
- Тема для светлой: GitHub Light
- Определение языка: auto + атрибут `data-language`
- Применение: при `__fan_appendHtml()` только к новым элементам `<pre><code>` (инкрементально, как ORF)
- Языки подсветки: Kotlin, Java, Python, JavaScript, TypeScript, Bash, SQL, JSON, YAML, XML, Markdown

**Copy:**

- `navigator.clipboard.writeText()` с `execCommand('copy')` fallback
- При копировании — кнопка меняет цвет на `var(--fan-diff-added)` (класс `.copied`)

**Large blocks:**

- Коллапс >500 строк / >50KB по умолчанию

---

### 1.7 Рендеринг сообщений (User/Assistant/System/Error)

#### 1.7.1 Пользовательские сообщения (User Messages)

ORF-style bubble: 80% max-width, выровнены вправо, скруглённые углы.

**HTML-структура:**

```html
<div class="fan-message fan-user-message">
  {rendered markdown}
</div>
```

**CSS:**

```css
.fan-user-message {
  background: var(--fan-user-bg);
  color: var(--fan-user-text);
  max-width: 80%;
  margin-left: auto;                   /* выравнивание вправо */
  padding: 10px 14px;
  border-radius: var(--fan-message-radius);
  border-bottom-right-radius: 4px;     /* адаптация: маленький нижний правый угол */
  word-wrap: break-word;
  overflow-wrap: break-word;
}
```

#### 1.7.2 Сообщения ассистента (Assistant Messages)

Без фона (transparent), на полную ширину, минимальные отступы — точно как TUI.

**HTML-структура:**

```html
<div class="fan-message fan-assistant-message">
  {rendered markdown}
</div>
```

**CSS:**

```css
.fan-assistant-message {
  background: var(--fan-assistant-bg);
  color: var(--fan-text-color);
  max-width: 100%;
  padding: 6px 8px;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
```

#### 1.7.3 Системные сообщения

**CSS:**

```css
.fan-system-message {
  color: var(--fan-system-color);
  font-style: italic;
  text-align: center;
  padding: 8px 0;
  font-size: 0.85em;
}
```

#### 1.7.4 Сообщения об ошибках

**HTML-структура:**

```html
<div class="fan-message fan-error-message">
  <div class="fan-error-title">{title}</div>
  <div class="fan-error-body">{message}</div>
</div>
```

**CSS:**

```css
.fan-error-message {
  background: var(--fan-error-bg);
  border-left: 3px solid var(--fan-error-text);
  color: var(--fan-error-text);
  padding: 10px 14px;
  border-radius: var(--fan-block-radius);
}
.fan-error-title {
  font-weight: 700;
  margin-bottom: 4px;
}
.fan-error-body {
  opacity: 0.9;
}
```

#### 1.7.5 Курсор стриминга

Во время стриминга к содержимому добавляется мигающий курсор:

**CSS:**

```css
.fan-streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--fan-accent);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: fan-blink 1s step-end infinite;
}

@keyframes fan-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

---

### 1.8 Thinking-блоки

Сворачиваемые блоки рассуждений, соответствующие TUI-форматированию: курсив, серый текст, braille-спиннер.

**HTML-структура:**

```html
<div class="fan-thinking-block" id="thinking-{id}">
  <div class="fan-thinking-header" onclick="__fan_toggleReasoning('{id}')">
    <span class="fan-thinking-arrow">▼</span>
    <span class="fan-thinking-label">💭 Thinking...</span>
    <span class="fan-thinking-spinner" id="thinking-spinner-{id}">⠋</span>
  </div>
  <div class="fan-thinking-content">
    <div class="fan-thinking-text">{markdown content}</div>
  </div>
</div>
```

**CSS:**

```css
.fan-thinking-block {
  margin: 6px 0;
  border-radius: var(--fan-block-radius);
  background: var(--fan-thinking-bg);
  border-left: 3px solid var(--fan-accent);
}

.fan-thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}

.fan-thinking-label {
  color: var(--fan-thinking-text);
  font-style: italic;
}

.fan-thinking-text {
  padding: 4px 12px 12px;
  color: var(--fan-thinking-text);
  font-style: italic;
}

.fan-thinking-arrow {
  color: var(--fan-system-color);
  transition: transform 0.2s ease;
  font-size: 0.8em;
}

.fan-thinking-arrow.collapsed {
  transform: rotate(-90deg);
}

.fan-thinking-content {
  max-height: 5000px;
  opacity: 1;
  transition: max-height 0.3s ease, opacity 0.3s ease;
  overflow: hidden;
}

.fan-thinking-content.collapsed {
  max-height: 0;
  opacity: 0;
}
```

**Анимация спиннера** (braille, соответствует TUI `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`):

```css
@keyframes fan-braille-spin {
  0%  { content: "⠋"; }
  10% { content: "⠙"; }
  20% { content: "⠹"; }
  30% { content: "⠸"; }
  40% { content: "⠼"; }
  50% { content: "⠴"; }
  60% { content: "⠦"; }
  70% { content: "⠧"; }
  80% { content: "⠇"; }
  90% { content: "⠏"; }
}

.fan-thinking-spinner {
  animation: fan-braille-spin 0.8s steps(10) infinite;
  color: var(--fan-accent);
}
```

> **Примечание:** CSS `content` не анимируется стандартными средствами. Реализация через JS-интервал, меняющий `textContent` элемента (как ORF), либо через CSS `@property` + `content` (поддерживается в JCEF/Chromium).

**Завершение:** при завершении thinking — замена спиннера на `✓` в success-цвете.

---

### 1.9 Tool Call-блоки

Сворачиваемые блоки инструментов с трёхцветной системой фона (pending/success/error), соответствующей TUI.

**HTML-структура:**

```html
<div class="fan-tool-block fan-tool-{status}" id="tool-{id}">
  <div class="fan-tool-header" onclick="__fan_toggleToolCall('{id}')">
    <span class="fan-tool-arrow">▼</span>
    <span class="fan-tool-icon">{icon}</span>
    <span class="fan-tool-name">{toolName}</span>
    <span class="fan-tool-summary">{summary}</span>
    <span class="fan-tool-status">
      <span class="fan-tool-spinner">⠋</span>  <!-- pending -->
    </span>
  </div>
  <div class="fan-tool-content">
    <div class="fan-tool-args">{formatted args}</div>
    <div class="fan-tool-result">{formatted result}</div>
  </div>
</div>
```

**Маппинг иконок инструментов:**

| Инструмент | Иконка |
|-----------|--------|
| `read` | `📄` |
| `write` | `✏️` |
| `edit` | `📝` |
| `bash` | `$` |
| `grep` / `find` | `🔍` |
| По умолчанию | `🔧` |

**CSS:**

```css
.fan-tool-block {
  margin: 6px 0;
  border-radius: var(--fan-block-radius);
  overflow: hidden;
}

/* Статусы */
.fan-tool-pending {
  background: var(--fan-tool-pending-bg);
  border-left: 3px solid var(--fan-accent);
}
.fan-tool-success {
  background: var(--fan-tool-success-bg);
  border-left: 3px solid var(--fan-diff-added);
}
.fan-tool-error {
  background: var(--fan-tool-error-bg);
  border-left: 3px solid var(--fan-error-text);
}

/* Заголовок */
.fan-tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 0.9em;
}

.fan-tool-name {
  font-weight: 600;
  color: var(--fan-text-color);
}

.fan-tool-summary {
  color: var(--fan-system-color);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Сворачивание */
.fan-tool-content {
  max-height: 5000px;
  opacity: 1;
  transition: max-height 0.3s ease, opacity 0.3s ease;
  overflow: hidden;
}

.fan-tool-content.collapsed {
  max-height: 0;
  opacity: 0;
}
```

**Форматирование результатов по типу инструмента:**

| Инструмент | Формат вывода |
|-----------|---------------|
| `read` | Путь файла + диапазон строк в заголовке, блок кода с highlight.js |
| `write` | Целевой путь файла, подтверждение записи |
| `edit` | Diff-style с `+added` (зелёный) и `-removed` (красный) строками |
| `bash` | Команда + вывод в моноширинном блоке |
| Generic | JSON-форматирование аргументов + текстовый результат |

**Diff-рендеринг (для `edit` tool):**

```css
.fan-diff-added {
  color: var(--fan-diff-added);
  background: rgba(181, 189, 104, 0.1);
}
.fan-diff-removed {
  color: var(--fan-diff-removed);
  background: rgba(204, 102, 102, 0.1);
}
.fan-diff-context {
  color: var(--fan-diff-context);
}
```

Content fields rendering: code blocks для `content`, `diff`, `output`, `stdout`, `stderr`.

---

### 1.10 Clarification-блоки

Когда FAN-агент использует инструмент `question` (skill ask-answer):

**HTML-структура:**

```html
<div class="fan-clarification-block" id="clarification-{id}">
  <div class="fan-clarification-question">{question text}</div>
  <div class="fan-clarification-options">
    <button class="fan-clarification-option"
            onclick="__fan_onClarificationClick('{id}', 'option1')">
      <span class="fan-option-prefix">→</span>
      <span class="fan-option-label">Option 1</span>
      <span class="fan-option-desc">Description text</span>
    </button>
    <!-- additional options... -->
  </div>
</div>
```

**CSS:**

```css
.fan-clarification-block {
  margin: 12px 0;
  padding: 12px;
  border-radius: var(--fan-block-radius);
  background: rgba(138, 190, 183, 0.08);   /* subtle accent tint */
  border: 1px solid var(--fan-accent);
}

.fan-clarification-question {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--fan-text-color);
}

.fan-clarification-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fan-clarification-option {
  background: none;
  border: 1px solid transparent;
  padding: 8px 12px;
  cursor: pointer;
  text-align: left;
  display: flex;
  gap: 8px;
  border-radius: 6px;
  color: var(--fan-text-color);
  font-family: var(--fan-font-family);
  font-size: 0.95em;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.fan-clarification-option:hover {
  background: rgba(138, 190, 183, 0.15);
  border-color: var(--fan-accent);
}

.fan-option-prefix {
  color: var(--fan-accent);
  font-weight: 700;
}

.fan-option-desc {
  color: var(--fan-system-color);
  font-size: 0.85em;
  margin-left: auto;
}
```

> Соответствует TUI select-list с префиксом `→ `.

**JS→Kotlin bridge:** `__fan_onClarificationClick(blockId, option)` → `JBCefJSQuery` → Kotlin handler → `POST /api/sessions/{id}/messages`.

---

### 1.11 Footer (Status Bar внутри JCEF)

Отображается внутри JCEF внизу чата, sticky, точно как TUI-футер (2 строки). Не путать с IDE Status Bar (Phase 4) — это внутренний футер чата.

**HTML-структура:**

```html
<div class="fan-footer">
  <div class="fan-footer-line-1">
    <span id="fan-footer-cwd">~/projects/fan</span>
    <span id="fan-footer-branch">(main)</span>
    <span id="fan-footer-session">• session-name</span>
  </div>
  <div class="fan-footer-line-2">
    <span id="fan-footer-stats">↑12.5k ↓3.2k R8.1k $0.023</span>
    <span id="fan-footer-context" class="fan-context-normal">45.2%</span>
    <span class="fan-footer-context-separator">/</span>
    <span id="fan-footer-context-max">200k</span>
    <span id="fan-footer-model">claude-3-opus • medium</span>
  </div>
</div>
```

**CSS:**

```css
.fan-footer {
  border-top: 1px solid var(--fan-border-color);
  padding: 6px 12px;
  font-size: 0.8em;
  color: var(--fan-footer-text);
  font-family: var(--fan-font-family);
  position: sticky;
  bottom: 0;
  background: var(--fan-bg-color);
}

.fan-footer-line-2 {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.fan-footer-context {
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
}

/* Цветовые уровни контекста */
.fan-context-normal { color: var(--fan-diff-added); }           /* <70% — зелёный */
.fan-context-warning { color: var(--fan-accent-secondary); }    /* 70-90% — золотой */
.fan-context-critical { color: var(--fan-error-text); }         /* >90% — красный */

.fan-footer-model {
  font-style: italic;
}
```

**Источник данных:** события `FanWsClient` → `FanMessageService` → JS-вызов `__fan_updateFooter(data)`.

---

### 1.12 Typography, Scrollbar, Animations

#### 1.12.1 Типографика (body)

```css
body {
  font-family: var(--fan-font-family);
  font-size: var(--fan-font-size);
  line-height: 1.6;
  color: var(--fan-text-color);
  background: var(--fan-bg-color);
  padding: 12px;
  margin: 0;
  -webkit-font-smoothing: antialiased;
}
```

- **Размер по умолчанию:** 14px (настраивается через Settings)
- **Приоритет шрифтов:** JetBrains Mono → Fira Code → Cascadia Code → monospace
- **Линейная высота:** 1.6 (для читаемости моноширинного шрифта)

#### 1.12.2 Стилизация скроллбаров

```css
::-webkit-scrollbar {
  width: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--fan-border-color);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--fan-accent);
}
```

#### 1.12.3 Таблица анимаций

| Элемент | Анимация | Длительность | Easing |
|---------|----------|-------------|--------|
| Скролл | `scroll-behavior: smooth` | — | — |
| Сворачиваемые блоки | `max-height` + `opacity` | 300ms | ease |
| Курсор стриминга | `fan-blink` (step-end) | 1s loop | step-end |
| Braille-спиннер | `fan-braille-spin` (steps(10)) | 0.8s loop | steps |
| Смена статуса tool | background-color transition | 200ms | ease |
| Стрелка collapse | `transform: rotate(-90deg)` | 200ms | ease |
| Кнопка copy | background + color transition | 150ms | ease |
| Кнопка clarification | background + border-color transition | 150ms | ease |

---

### 1.13 HtmlDocumentManager (Unified API)

`FanHtmlDocumentManager` — единый Kotlin API поверх JCEF для рендеринга всех типов блоков. Методы маппятся 1:1 к `__fan_*` JS-функциям.

**Паттерн вызова:** `view.executeJs("__fan_addUserMessage('$html')")` — Kotlin → JS bridge.

#### Методы для типов событий FAN

| Категория  | Метод                                                                                     | CSS-класс результата                               |
|------------|-------------------------------------------------------------------------------------------|----------------------------------------------------|
| Messages   | `addUserMessage(content: String)`                                                         | `.fan-message .fan-user-message`                   |
| Messages   | `addAssistantMessage(renderedHtml: String)`                                               | `.fan-message .fan-assistant-message`              |
| Messages   | `addSystemMessage(text: String)`                                                          | `.fan-system-message`                              |
| Messages   | `addErrorMessage(title: String, message: String)`                                         | `.fan-message .fan-error-message`                  |
| Streaming  | `startAssistantStream(): String` → element ID                                             | `.fan-assistant-message` + `.fan-streaming-cursor` |
| Streaming  | `updateAssistantStream(elementId: String, content: String)`                               | (update existing)                                  |
| Streaming  | `endAssistantStream(elementId: String)`                                                   | (remove `.fan-streaming-cursor`)                   |
| Thinking   | `showThinkingIndicator(id: String)`                                                       | `.fan-thinking-block`                              |
| Thinking   | `updateThinkingContent(id: String, text: String)`                                         | (update `.fan-thinking-text`)                      |
| Thinking   | `completeThinking(id: String)`                                                            | (spinner → ✓)                                      |
| Tool calls | `addToolCallBlock(name: String, status: String, icon: String, summary: String, args: String)` | `.fan-tool-block .fan-tool-{status}`               |
| Tool calls | `updateToolCallStatus(id: String, status: String)`                                        | (class change: pending→success/error)              |
| Tool calls | `updateToolCallResult(id: String, resultHtml: String)`                                    | (update `.fan-tool-result`)                        |
| Clarif.    | `addClarificationBlock(id: String, question: String, options: List<ClarificationOption>)` | `.fan-clarification-block`                         |
| Clarif.    | `removeClarificationBlock(id: String)`                                                    | (remove by ID)                                     |
| Footer     | `updateFooter(data: FooterData)`                                                          | (update `#fan-footer-*` spans)                     |
| UI         | `scrollToBottom()`                                                                        | —                                                  |
| UI         | `updateFontSize(size: Int)`                                                               | (update `--fan-font-size`)                         |
| UI         | `updateTheme(isDark: Boolean)`                                                            | (update `data-fan-theme`)                          |
| UI         | `clearMessages()`                                                                         | (clear `#fan-messages-container`)                  |
| UI         | `loadSessionMessages(messages: List<Message>)`                                            | (full reload via `__fan_setBody`)                  |

**Упрощён vs ORF:** нет agent plans, sub-agents, multiple activity blocks.

**FooterData:**

```kotlin
data class FooterData(
  val cwd: String,
  val branch: String,
  val sessionName: String,
  val statsUp: String,        // "↑12.5k"
  val statsDown: String,      // "↓3.2k"
  val statsRead: String,      // "R8.1k"
  val cost: String,           // "$0.023"
  val contextUsed: String,    // "45.2%"
  val contextMax: String,     // "200k"
  val modelName: String,      // "claude-3-opus"
  val temperature: String     // "medium"
)
```

---

### 1.14 Безопасность и NFR

#### 1.14.1 Производительность
- highlight.js загружается лениво (не бандлится), только инкрементальная подсветка новых блоков
- DOM-операции батчатся при стриминге (не на каждый токен)
- Большие код-блоки (>500 строк / >50KB) сворачиваются по умолчанию
- Lazy init JCEF — создаётся только при первом отображении tool window
- Script queuing — скрипты до загрузки страницы ставятся в очередь

#### 1.14.2 Безопасность
- JSoup-санитизация (`Whitelist.relaxed()`) всего пользовательского контента
- JCEF работает в песочнице Chromium
- Все параметры в Kotlin→JS-вызовах экранируются (HTML + JSON-сериализация)
- `javascript:` URL и `on*` атрибуты удаляются при санитизации
- Все JS-вызовы обёрнуты в try-catch с логированием

#### 1.14.3 Доступность
- Кнопки уточнений навигируемы с клавиатурой
- Минимальный контраст WCAG AA для всех цветовых пар
- Focus-visible стили для интерактивных элементов

#### 1.14.4 Память
- Очистка DOM-узлов при переключении сессии
- Лимит DOM-узлов: при превышении порога (~10000) — удаление старых сообщений из DOM (но не из истории)

#### 1.14.5 Совместимость
- JCEF обязателен (IC-2024.1+)
- Fallback на `JEditorPane` **не предусмотрен**

---

### Новые/модифицируемые/удаляемые файлы (Phase 1)

**Новые:**

```
ui/chat/
├── jcef/
│   ├── JcefFanChatView.kt          — JCEF browser wrapper
│   └── FanHtmlResources.kt         — CSS/JS injection, template loading
├── markdown/
│   ├── FanMarkdownParser.kt        — Markdown → ContentBlock
│   ├── FanMarkdownRenderer.kt      — ContentBlock → HTML
│   └── ContentBlock.kt             — Sealed interface блоков
├── components/
│   ├── CodeBlockComponent.kt       — Фасад (renderer + highlighter + detector)
│   ├── FanSyntaxHighlighter.kt     — Regex-based подсветка (11 языков)
│   └── FanLanguageDetector.kt      — Автоопределение языка
├── manager/
│   └── FanHtmlDocumentManager.kt   — Unified rendering API (~800 строк, упрощён vs ORF 1629)
└── FanChatPanel.kt                 — Замена ChatPanel.kt (JCEF container)

resources/
├── html/
│   ├── fan-chat.html               — HTML-шаблон чата
│   ├── css/
│   │   └── fan-chat-styles.css     — Основные стили (все CSS-переменные, сообщения, markdown, footer, scrollbar, typography)
│   └── js/
│       └── fan-chat.js             — JS API __fan_* (~590 строк)
```

**Модифицируемые:** `build.gradle.kts` (JSoup dependency), `FanPlugin.kt` (wire JCEF view)

**Удаляемые:** `MessageRenderer.kt` (заменён на FanMarkdownParser + JCEF), `ChatPanel.kt` (заменён на FanChatPanel)

---

## Phase 2: Session Navigation & Input UX (User Experience)

**Цель:** Навигация по сессиям и input panel уровня ORF.  
**Оценка:** 3-4 задачи, ~1 200 строк нового кода  
**Зависимость:** Phase 1

### 2.1 Session Navigator

- `FanSessionNavigator` — state machine (SESSION_LIST ↔ SESSION_CHAT)
- `FanSessionListPanel` — `JList<SessionMetadata>` с кастомным renderer
    - Заголовок сессии, относительный timestamp (Сегодня/Вчера/дата), кол-во сообщений
    - Click → open, hover → delete button
    - Empty state: "Введите сообщение для создания нового чата"
- `FanSessionListItem` — `ListCellRenderer`
- Context menu: rename (JOptionPane), delete (с подтверждением)
- Оставляем текущее поведение FAN: сессии с сервера, фильтрация по project path

> **Примечание:** Session list panel — это Swing-компонент, НЕ JCEF. Использует стандартные цвета JetBrains LaF (UIManager defaults), не `--fan-*` переменные.

### 2.2 Input Panel Upgrade

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

> **Стилизация:** Input panel — Swing-компонент. Рамки ввода используют `--fan-accent` для border color (согласованность с thinking/tool-блоками в JCEF). Это достигается через чтение цвета из `FanChatColors` при установке border.

### 2.3 Header & Footer Panels

- **Header** (`FanHeaderPanel.kt`): "FAN Agent" title, "← Sessions" back button, заголовок сессии, connection status dot
    - Swing-компонент, использует `--fan-text-color` для текста и `--fan-accent` для кнопки «← Sessions»
    - Цвета читаются из `EditorColorsManager` при инициализации и обновляются через `EditorColorsManager.TOPIC`
- **Footer** (`FanFooterPanel.kt`): индикатор активного файла, info о контексте (future)
    - Swing-компонент (не путать с JCEF footer из Phase 1 Section 1.11)

### Новые/модифицируемые/удаляемые файлы (Phase 2)

**Новые:**

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

**Цель:** Визуализация событий FAN agent (coordinator mode) — tool calls, reasoning, clarification.  
**Оценка:** 4-5 задачи, ~1 000 строк нового кода  
**Зависимость:** Phase 2

### 3.1 Event Type Mapping (FAN ↔ ORF)

| FAN WS Event    | ORF Equivalent            | CSS-класс визуализации                          | Визуализация                                |
|-----------------|---------------------------|-------------------------------------------------|---------------------------------------------|
| `text_chunk`    | Streaming assistant text  | `.fan-assistant-message` + `.fan-streaming-cursor` | Streaming markdown в assistant message      |
| `thinking`      | ReasoningStepEvent        | `.fan-thinking-block`                           | Collapsible reasoning block со спиннером    |
| `tool_use`      | ToolCallEvent (started)   | `.fan-tool-block .fan-tool-pending`             | Tool call block со статусом running         |
| `tool_result`   | ToolCallEvent (completed) | `.fan-tool-block .fan-tool-success` / `.fan-tool-error` | Tool call block с результатом, status badge |
| `error`         | RunErrorEvent             | `.fan-error-message`                            | Error message block                         |
| `session_start` | (internal)                | `.fan-system-message`                           | System message                              |
| `message_added` | (internal)                | `.fan-assistant-message`                        | Final assistant message                     |
| `session_end`   | RunEndEvent               | —                                               | System message "completed"                  |

### 3.2 Activity Block System

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

`FanToolCallFormatter` — форматирует tool calls в HTML:

| Tool    | Иконка | Отображение                         |
|---------|--------|-------------------------------------|
| `read`  | `📄`   | "Read: /path/to/file"               |
| `write` | `✏️`   | "Write: /path/to/file"              |
| `edit`  | `📝`   | "Edit: /path/to/file"               |
| `bash`  | `$`    | "Cmd: command" (truncated 80 chars) |
| `grep`  | `🔍`   | "Grep: pattern"                     |
| `find`  | `🔍`   | "Find: pattern"                     |
| Generic | `🔧`   | "Tool: name"                        |

CSS-классы для статусов (определены в Phase 1 Section 1.9):
- `.fan-tool-pending` — background: `var(--fan-tool-pending-bg)`, border-left: `var(--fan-accent)`
- `.fan-tool-success` — background: `var(--fan-tool-success-bg)`, border-left: `var(--fan-diff-added)`
- `.fan-tool-error` — background: `var(--fan-tool-error-bg)`, border-left: `var(--fan-error-text)`

Diff-рендеринг (для `edit` tool, CSS из Phase 1 Section 1.9):
```css
.fan-diff-added {
  color: var(--fan-diff-added);
  background: rgba(181, 189, 104, 0.1);
}
.fan-diff-removed {
  color: var(--fan-diff-removed);
  background: rgba(204, 102, 102, 0.1);
}
.fan-diff-context {
  color: var(--fan-diff-context);
}
```

Collapsible blocks в chat.js: name, status icon (running/done/error), details, expandable data.

### 3.4 Clarification / Question Tool

- FAN agent использует `question` tool (ask-answer skill) → clarification block
- CSS-класс: `.fan-clarification-block` (определён в Phase 1 Section 1.10)
- Блок с акцентной рамкой (`--fan-accent`) + текст вопроса + интерактивные кнопки
- User click → response через `POST /api/sessions/{id}/messages`
- `JBCefJSQuery` bridge: JS `__fan_onClarificationClick(blockId, option)` → Kotlin handler
- Input panel placeholder меняется на "Введите ответ..."

### Новые/модифицируемые/удаляемые файлы (Phase 3)

**Новые:**

```
ui/chat/
├── agent/
│   ├── FanAgentEventHandler.kt
│   ├── FanAgentEventConsumer.kt   (interface)
│   ├── FanAgentRunState.kt
│   ├── FanToolCallFormatter.kt
│   └── FanClarificationHandler.kt
```

**Модифицируемые:** `FanWsClient.kt` (typed events integration), `FanMessageService.kt` (agent event dispatch)

---

## Phase 4: Status Bar & Notifications (Polish)

**Цель:** Профессиональный индикатор подключения и система уведомлений.  
**Оценка:** 2-3 задачи, ~400 строк нового кода  
**Зависимость:** Phase 3

> **Примечание:** Status bar widget находится в IDE status bar (Swing), НЕ в JCEF. Footer внутри JCEF (CWD, branch, stats, model, context) уже реализован в Phase 1 Section 1.11.

### 4.1 Status Bar Widget

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

- `FanNotificationService` (APP-level) — уже частично есть через `FanNotificationGroup.kt` + `NotificationHelper.kt`
- Exception-to-notification mapping:

| Exception              | Балун           | In-chat CSS-класс                |
|------------------------|-----------------|----------------------------------|
| Network error          | WARNING balloon | `.fan-system-message` (warning)  |
| Server error           | ERROR balloon   | `.fan-error-message`             |
| Connection lost        | WARNING balloon | `.fan-system-message` (warning)  |
| Non-critical (timeout) | Нет             | `.fan-system-message`            |

### Новые/модифицируемые/удаляемые файлы (Phase 4)

**Новые:**

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

**Цель:** Подключение theme system к IntelliJ LaF, настройка размера шрифта в Settings UI, тестирование.  
**Оценка:** 1-2 задачи, ~200 строк нового кода  
**Зависимость:** Phase 1 (parallel с Phase 3-4)

> **Важно:** CSS variable system и полный набор переменных (тёмная/светлая) УЖЕ реализованы в Phase 1 (Section 1.2). Phase 5 — только wiring и UI.

### 5.1 Theme Integration

CSS-переменные в `fan-chat-styles.css` **уже определены** (Phase 1 Section 1.2). Phase 5 занимается:

- **Listener wiring:** подключение `EditorColorsManager.TOPIC` + `UiDefaultsEvent` listener
- **Bridge:** при событии смены темы → вызов `__fan_updateTheme(isDark)` через `JcefFanChatView`
- **Initial detection:** при инициализации JCEF — определение текущей темы через `UIUtil.isUnderDarcula()` и установка через `__fan_updateTheme(isDark)`
- **Тестирование:** переключение Darcula ↔ Light тема, проверка всех 32 CSS-переменных

### 5.2 Font Size & Accessibility

- Настройка в FAN Agent settings panel: 12/13/14/15/16px
- При изменении — вызов `__fan_setFontSize(px)` через `JcefFanChatView`
- Default: 14px (жёстко задан в CSS, можно перезаписать через настройку)
- Future: поддержка `editor.fontSize` из IDE настроек (опционально)

### Модифицируемые файлы (Phase 5)

| Файл                       | Изменение                                      |
|----------------------------|------------------------------------------------|
| `FanPluginSettings.kt`     | Добавить `chatFontSize: Int = 14`              |
| `FanPluginConfigurable.kt` | Font size dropdown/combobox в settings UI       |
| `FanHtmlDocumentManager.kt`| Обновить `updateFontSize()` wiring              |

> Фаза значительно меньше, чем предполагалось в Source 1 (~300 строк → ~200 строк), т.к. вся визуальная система уже реализована в Phase 1.

---

## Полная карта файлов (merged)

### Новые файлы (~36)

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
│   │   │   ├── FanMarkdownRenderer.kt
│   │   │   └── ContentBlock.kt
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

| Файл                       | Изменение                                                                   | Фаза   |
|----------------------------|-----------------------------------------------------------------------------|--------|
| `FanPlugin.kt`             | Slim down → тонкий координатор (50-80 строк)                                | 0      |
| `FanToolWindowFactory.kt`  | FanSessionNavigator вместо ViewSwitcher, JcefFanChatView                     | 1, 2   |
| `build.gradle.kts`         | JSoup, возможно Kotlin upgrade, JCEF API dependency                          | 0, 1   |
| `plugin.xml`               | `statusBarWidgetFactory`, обновление tool window                             | 4      |
| `FanPluginSettings.kt`     | Добавить `chatFontSize: Int = 14`                                           | 5      |
| `FanPluginConfigurable.kt` | Font size setting UI                                                         | 5      |
| `FanWsClient.kt`           | Typed events, MessageBus integration, agent event dispatch                   | 0, 3   |
| `FanApiClient.kt`          | Minor: добавить endpoint methods по необходимости                            | 0      |
| `FanMessageService.kt`     | Agent event dispatch, footer data relay                                      | 0, 3   |
| `FanHtmlDocumentManager.kt`| Font size wiring                                                              | 5      |

### Удаляемые файлы (~7)

| Файл                           | Причина                                | Фаза   |
|--------------------------------|----------------------------------------|--------|
| `FanPluginManager.kt`          | Заменён на `@Service` аннотации        | 0      |
| `FanPluginSettingsListener.kt` | Dead code, не реализован               | 0      |
| `MessageRenderer.kt`           | Заменён на FanMarkdownParser + JCEF    | 1      |
| `ChatPanel.kt`                 | Заменён на FanChatPanel (JCEF)         | 1      |
| `InputPanel.kt`                | Заменён на FanInputPanel               | 2      |
| `SessionListPanel.kt`          | Заменён на FanSessionListPanel         | 2      |
| `StatusBar.kt`                 | Заменён на FanStatusWidget             | 4      |
| `WelcomePanel.kt`              | Слит с empty state FanSessionListPanel | 2      |

---

## Сводка по фазам

| Phase              | Новых   | Модиф.  | Удал.  | ~Строк кода | Зависимости              |
|--------------------|---------|---------|--------|-------------|--------------------------|
| 0: Architecture    | 8       | 4       | 2      | ~800        | —                        |
| 1: JCEF Rendering  | 12      | 2       | 2      | ~3 500      | Phase 0                  |
| 2: Session & Input | 8       | 1       | 3      | ~1 200      | Phase 1                  |
| 3: Agent UI        | 5       | 2       | 0      | ~1 000      | Phase 2                  |
| 4: Status & Notif. | 4       | 1       | 1      | ~400        | Phase 3                  |
| 5: Theme           | 0       | 3       | 0      | ~200        | Phase 1 (parallel с 3-4) |
| **Итого**          | **~37** | **~13** | **~8** | **~7 100**  |                          |

> По сравнению с Source 1: Phase 1 выросла (~2 500 → ~3 500 строк) за счёт включения полной визуальной системы, Phase 5 уменьшилась (~300 → ~200 строк) т.к. CSS variable system перенесена в Phase 1.

---

## Граф зависимостей

```
Phase 0 ──→ Phase 1 ──┬──→ Phase 2 ──→ Phase 3 ──→ Phase 4
                       │                        ↗
                       └──→ Phase 5 ─────────────┘
```

- **Phase 0** → все остальные (foundation)
- **Phase 1** → Phases 2, 3, 4, 5 (rendering engine нужен первым)
- **Phase 2** → Phase 3 (навигация перед agent UI)
- **Phase 3** → Phase 4 (agent UI перед status integration)
- **Phase 5** может параллелиться с Phase 3-4 (CSS variables уже есть в Phase 1)

---

## Риски (merged, дедуплицировано)

| # | Риск                                                           | Вероятность | Влияние            | Митигация                                                    |
|---|----------------------------------------------------------------|-------------|--------------------|--------------------------------------------------------------|
| 1 | **Kotlin upgrade** 1.9.24 → 2.1.0 — compilation issues        | Средняя     | Блокировка         | Инкрементальный тест                                         |
| 2 | **Bundle size** — JSoup + JCEF resources                        | —           | Больше плагин      | JSoup ~1MB, приемлемо                                        |
| 3 | **Performance** — JCEF startup vs Swing                         | —           | Медленный старт    | Lazy init, script queuing                                    |
| 4 | **Coroutines** — зависимость от IntelliJ bundled version        | —           | Ограничения        | `executeOnPooledThread` для Swing UI, no explicit dependency |
| 5 | **JCEF не загружен** в старых IDE                               | Средняя     | Критичное          | Требование IC-2024.1+, проверка при старте плагина           |
| 6 | **highlight.js CDN недоступен**                                  | Низкая      | Среднее            | Fallback: code-блоки без подсветки, попытка повторной загрузки |
| 7 | **Несоответствие цветов** при смене темы IDE                    | Средняя     | Низкое             | Прослушивание `EditorColorsManager.TOPIC`, мгновенное обновление через `__fan_updateTheme` |
| 8 | **XSS через markdown**                                          | Низкая      | Критичное          | JSoup sanitization (`Whitelist.relaxed()`) + атрибут sandbox на JCEF |
| 9 | **Производительность при длинных сессиях**                       | Средняя     | Среднее            | DOM-очистка (>10000 узлов), сворачивание больших блоков, лимит узлов |
| 10 | **Braille-спиннер не анимируется через CSS**                     | Высокая     | Низкое             | JS-реализация через `setInterval` + `textContent` (как ORF)  |
| 11 | **Контраст WCAG AA** не соблюдается для некоторых пар           | Низкая      | Низкое             | Проверка контраста в Phase 5, корректировка значений         |

---

## Not in scope (merged)

Следующие возможности ORF plugin и styling spec намеренно исключены из данной дорожной карты:

### Из ORF Plugin (Source 1)
- Inline code completion (комплементация в редакторе)
- Refactoring diff dialog + inline edit
- Client-side session encryption (AES)
- Sound notifications (WAV)
- RAG context selectors (repository/doc)
- Multi-agent activity blocks
- Agent plan visualization

### Из Styling Spec (Source 2) — Won't Have
- Fallback на `JEditorPane` (JCEF обязателен)
- Markdown-редактор (WYSIWYG) — только просмотр
- Бандлинг highlight.js — только CDN
- Поддержка IDE < IC-2024.1

---

## Приоритеты

### Must Have (Обязательно)
- [ ] CSS-переменные для обеих тем (тёмная/светлая) — все 32 значения из TUI `dark.json`/`light.json`
- [ ] Переключение тем по IntelliJ LaF
- [ ] Рендеринг сообщений (user/assistant/system/error) — bubble-раскладка
- [ ] Tool call-блоки (pending/success/error) — сворачиваемые с иконками
- [ ] Thinking-блоки — сворачиваемые со спиннером
- [ ] Блоки кода с языковой меткой и кнопкой копирования
- [ ] Футер (2 строки: CWD+branch, stats+model+context)
- [ ] JS API `__fan_*` — все функции для управления DOM из Kotlin
- [ ] Kotlin-интеграция (JcefFanChatView + FanHtmlDocumentManager + bridge)
- [ ] XSS-санитизация (JSoup)
- [ ] Двухуровневый service layer + MessageBus

### Should Have (Желательно)
- [ ] Markdown-рендеринг (FanMarkdownParser + FanMarkdownRenderer)
- [ ] highlight.js интеграция (ленивая загрузка CDN)
- [ ] Курсор стриминга (блинк-анимация)
- [ ] Блоки уточнений (clarification) с кнопками
- [ ] Inline-код с стилизацией
- [ ] Diff-рендеринг (цветные +added/-removed строки)
- [ ] Session navigator (state machine)
- [ ] Input panel upgrade (auto-height, Enter to send, history)
- [ ] Status bar widget (connection indicator)

### Could Have (Возможно)
- [ ] Блоки кода >500 строк сворачиваются по умолчанию
- [ ] Настройка размера шрифта через Settings
- [ ] Стилизация скроллбаров
- [ ] WCAG AA контраст для всех пар
- [ ] Slash commands popup
- [ ] Context toggle (файл)

---

## Зависимости (build.gradle.kts)

| Зависимость | Версия | Назначение | Фаза |
|-------------|--------|-----------|------|
| `org.jetbrains.cef` (JCEF) | Bundled with IDE | Chromium rendering | 1 |
| `org.jsoup` (JSoup) | Latest stable | HTML-санитизация | 1 |
| `highlight.js` | 11.9.0 (CDN) | Подсветка синтаксиса | 1 |

### Интеграция с существующими компонентами

| Компонент | Связь |
|-----------|-------|
| `FanWsClient` | Поставляет события чата → `FanAgentEventHandler` → `FanHtmlDocumentManager` |
| `FanMessageService` | Парсит события WS → вызывает методы `FanHtmlDocumentManager` |
| `FanConnectionService` | Поставляет состояние подключения → `FanStatusManager` |
| `FanSettings` | Поставляет размер шрифта, настройки темы |
| `JcefFanChatView` | Обёртка `JBCefBrowser`, bridge Kotlin↔JS |
| `FanHtmlResources` | Загружает и инжектирует CSS/JS в HTML-шаблон |
| `JBCefJSQuery` | Обработка коллбэков из JS в Kotlin (clarification clicks) |
| `EditorColorsManager` | Детекция тёмной/светлой темы IDE |
| `MessageBus` | Событийная шина для ConnectionListener, SessionListener, MessageListener |

---

*Создано: 2026-04-24 — Documentation Specialist (merged roadmap)*  
*Исходники:* `roadmap-idea-plugin-v2-from-orf-ed2.md` + `spec_idea-plugin-tui-styling_2026-04-24.md`  
*Связанные документы:* `spec_idea-plugin-integration_2026-04-24.md`, `spec_runtime-agent_2026-04-10.md`, `api-reference.md`
