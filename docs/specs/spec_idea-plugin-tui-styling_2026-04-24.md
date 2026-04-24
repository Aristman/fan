# Спецификация: IDEA Plugin — TUI-Style JCEF Rendering Specification

## Метаданные
- **Дата**: 2026-04-24
- **Автор**: Documentation Specialist
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Интеграция (визуальная подсистема IDEA Plugin)
- **Связанные документы**: [spec_idea-plugin-integration_2026-04-24.md](./spec_idea-plugin-integration_2026-04-24.md), [spec_runtime-agent_2026-04-10.md](./spec_runtime-agent_2026-04-10.md), [api-reference.md](../guides/api-reference.md)

## 1. Обзор

### 1.1 Цель
Определить визуальную систему рендеринга чата FAN IDEA Plugin на основе JCEF (Chromium Embedded Framework), максимально приближённую к внешнему виду TUI (Terminal UI) из `packages/tui/`, с адаптацией к паттернам десктопного приложения.

### 1.2 Контекст
FAN имеет TUI, построенный на кастомном ANSI-рендерере (`packages/tui/`). IDEA Plugin (`idea-plugin/`) ранее использовал Swing `JLabel` для рендеринга сообщений. Выполняется миграция на JCEF (Chromium) для отображения чата. Визуальное оформление должно соответствовать TUI, при этом адаптируясь под IntelliJ LaF — чуть более яркие и мягкие цвета для десктопа, bubble-раскладка сообщений (как в ORF-плагине).

### 1.3 Источники истины

| Сущность | Файл/Расположение |
|----------|-------------------|
| TUI-тема (тёмная) | `packages/coding-agent/src/modes/interactive/theme/dark.json` |
| TUI-тема (светлая) | `packages/coding-agent/src/modes/interactive/theme/light.json` |
| ORF HTML-шаблон | `~/projects/ailab-orf-plugin/src/main/resources/html/chat-jcef.html` |
| ORF CSS | `~/projects/ailab-orf-plugin/src/main/resources/html/chat-styles-jcef.css` + `code-block-styles.css` |
| ORF JS | `~/projects/ailab-orf-plugin/src/main/resources/html/chat.js` |
| ORF Kotlin | `~/projects/ailab-orf-plugin/src/main/kotlin/orf/ui/chat/jcef/JcefChatView.kt` |
| ORF HTML-генерация | `~/projects/ailab-orf-plugin/src/main/kotlin/orf/ui/chat/HtmlDocumentManager.kt` |

### 1.4 Пользовательские решения

| Решение | Выбор |
|---------|-------|
| **Раскладка сообщений** | ORF-style bubble — пользовательские сообщения: 80% max-width, выровнены вправо, скруглённые углы |
| **Тема** | Адаптированные цвета TUI — основной акцент/сообщения/инструменты из `dark.json`/`light.json`, базовый bg/fg адаптирован к IntelliJ LaF (чуть ярче/мягче) |
| **Подсветка кода** | highlight.js (ленивая загрузка с CDN, как в ORF) |
| **Tool-блоки** | Сворачиваемые блоки (как в ORF) — имя инструмента + status badge, раскрываемое содержимое |
| **Футер** | Полный футер TUI внутри JCEF — CWD+branch, token stats, model name, context usage bar |

---

## 2. Система цветов

### 2.1 CSS-переменные (`--fan-*`)

Цветовая система основана на CSS custom properties (по аналогии с ORF `--orf-*`), но использует палитру TUI FAN.

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

### 2.2 Переключение тем

- **Определение IntelliJ LaF**: `UIUtil.isUnderDarcula()` или `EditorColorsManager.getInstance().isDarkEditor`
- **Установка темы**: через JS-функцию `__fan_updateTheme(isDark)` — устанавливает все CSS-переменные
- **Прослушивание изменений**: `EditorColorsManager.TOPIC` + `UiDefaultsEvent` (аналогично ORF)
- **Реактивность**: при смене темы IDE — мгновенное обновление без перезагрузки страницы

---

## 3. Рендеринг сообщений

### 3.1 Пользовательские сообщения (User Messages)

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

Markdown внутри пользовательских сообщений рендерится через `FanMarkdownRenderer` с TUI-токенами цветов.

### 3.2 Сообщения ассистента (Assistant Messages)

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

Без фона (transparent), на полную ширину, минимальные отступы — точно как TUI.

### 3.3 Системные сообщения

```css
.fan-system-message {
  color: var(--fan-system-color);
  font-style: italic;
  text-align: center;
  padding: 8px 0;
  font-size: 0.85em;
}
```

### 3.4 Сообщения об ошибках

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

### 3.5 Курсор стриминга

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

## 4. Thinking-блоки

Сворачиваемые блоки рассуждений, соответствующие TUI-форматированию: курсив, серый текст.

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

## 5. Tool Call-блоки

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

**Форматирование результатов:**

| Инструмент | Формат вывода |
|-----------|---------------|
| `read` | Путь файла + диапазон строк в заголовке, блок кода с highlight.js |
| `write` | Целевой путь файла, подтверждение записи |
| `edit` | Diff-style с `+added` (зелёный) и `-removed` (красный) строками |
| `bash` | Команда + вывод в моноширинном блоке |
| Generic | JSON-форматирование аргументов + текстовый результат |

**Diff-рендеринг:**
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

---

## 6. Блоки кода

На основе структуры ORF с цветами TUI.

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
```

**Inline-код:**
```css
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

---

## 7. Рендеринг Markdown

### 7.1 Парсер: FanMarkdownParser

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

### 7.2 Рендерер: FanMarkdownRenderer

**Вход:** `List<ContentBlock>`
**Выход:** HTML-строка

**Маппинг цветов (TUI → CSS-классы):**

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

### 7.3 XSS-санитизация

- Использование JSoup `Whitelist.relaxed()` для HTML-санитизации
- Весь пользовательский контент санитизируется перед инъекцией в JCEF
- Атрибуты `onclick`, `onerror`, `javascript:` полностью удаляются

---

## 8. Футер (Status Bar)

Отображается внутри JCEF внизу чата, точно как TUI-футер (2 строки).

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

## 9. Блоки вопросов/уточнений (Clarification Blocks)

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

---

## 10. JavaScript API (`fan-chat.js`)

Функции адаптированы из ORF `chat.js` с префиксом `__fan_*`.

### 10.1 Базовые DOM-операции

| Функция | Описание |
|---------|----------|
| `__fan_appendHtml(html)` | Добавить дочерние узлы в `#fan-messages-container` |
| `__fan_setBody(html)` | Заменить всё содержимое чата (загрузка сессии) |
| `__fan_clear()` | Очистить все сообщения |
| `__fan_removeElement(id)` | Удалить элемент по ID |
| `__fan_setElementHtml(id, html)` | Заменить innerHTML элемента |
| `__fan_setElementText(id, text)` | Заменить textContent элемента |
| `__fan_scrollToBottom()` | Плавная прокрутка вниз |

### 10.2 Сообщения

| Функция | Описание |
|---------|----------|
| `__fan_addUserMessage(content)` | Создать div пользовательского сообщения |
| `__fan_addAssistantMessage(content)` | Создать div сообщения ассистента |
| `__fan_addSystemMessage(text)` | Создать div системного сообщения |
| `__fan_addErrorMessage(title, message)` | Создать div сообщения об ошибке |

### 10.3 Стриминг

| Функция | Описание |
|---------|----------|
| `__fan_startAssistantStream()` | Создать контейнер стриминга, вернуть ID элемента |
| `__fan_updateAssistantStream(id, content)` | Обновить содержимое стрима |
| `__fan_endAssistantStream(id)` | Финализировать стрим, удалить курсор |

### 10.4 Thinking-блоки

| Функция | Описание |
|---------|----------|
| `__fan_createReasoningBlock(id)` | Создать thinking-блок со спиннером |
| `__fan_updateReasoningContent(id, content)` | Обновить текст thinking |
| `__fan_completeReasoning(id)` | Остановить спиннер, показать ✓ |
| `__fan_toggleReasoning(id)` | Свернуть/развернуть |

### 10.5 Tool Call-блоки

| Функция | Описание |
|---------|----------|
| `__fan_addToolCallBlock(id, toolName, status, icon, summary)` | Создать tool-блок |
| `__fan_updateToolCallStatus(id, status)` | Изменить pending→success/error |
| `__fan_updateToolCallResult(id, resultHtml)` | Установить содержимое результата |
| `__fan_toggleToolCall(id)` | Свернуть/развернуть |

### 10.6 Код

| Функция | Описание |
|---------|----------|
| `__fan_copyCode(button)` | Скопировать содержимое блока кода, переключить иконку |
| `__fan_initHl()` | Ленивая загрузка highlight.js |
| `__fan_highlightAll()` | Подсветить все новые `<pre><code>` блоки |

### 10.7 Тема

| Функция | Описание |
|---------|----------|
| `__fan_updateTheme(isDark)` | Установить все CSS-переменные для темы |
| `__fan_setFontSize(px)` | Обновить `--fan-font-size` |

### 10.8 Футер

| Функция | Описание |
|---------|----------|
| `__fan_updateFooter(data)` | Обновить статистику футера |

### 10.9 Уточнения

| Функция | Описание |
|---------|----------|
| `__fan_addClarificationButtons(id, options)` | Отрендерить блок вопросов |
| `__fan_removeClarificationButtons(id)` | Удалить после ответа |

### 10.10 Автопрокрутка

После каждого `appendHtml`, `updateAssistantStream` — автопрокрутка через `requestAnimationFrame`.

---

## 11. HTML-шаблон (`fan-chat.html`)

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

CSS/JS инжектируются через подстановку placeholder'ов (как в ORF `ChatHtmlResources.kt`).

---

## 12. Kotlin-интеграция

### 12.1 JcefFanChatView

| Метод | Описание |
|-------|----------|
| `loadHtml(html: String)` | Загрузить начальный HTML-шаблон |
| `executeJs(script: String)` | Выполнить JavaScript |
| `isReady: Boolean` | Отслеживание состояния загрузки Cef |
| `pendingScripts: MutableList<String>` | Очередь скриптов до готовности |
| `flushPending()` | Выполнить отложенные скрипты при `onLoadingStateChanged(LoadingState.COMPLETE)` |

Оборачивает `JBCefBrowser` в `JPanel`.

### 12.2 FanHtmlDocumentManager

Управляет всем рендерингом через `JcefFanChatView`.

- Методы маппятся 1:1 к `__fan_*` JS-функциям
- **Kotlin → JS**: `view.executeJs("__fan_addUserMessage('$html')")`
- **JS → Kotlin**: `JBCefJSQuery` для коллбэков уточнений (clarification)

### 12.3 Безопасность моста Kotlin→JS

- Экранирование HTML во всех параметрах, передаваемых в JS-функции (XSS-предотвращение)
- Использование JSON-сериализации для комплексных объектов
- Все JS-вызовы обёрнуты в try-catch с логированием

---

## 13. Шрифты и типографика

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

- **Размер по умолчанию**: 14px (настраивается через Settings)
- **Приоритет шрифтов**: JetBrains Mono → Fira Code → Cascadia Code → monospace
- **Линейная высота**: 1.6 (для читаемости моноширинного шрифта)

---

## 14. Стилизация скроллбаров

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

---

## 15. Анимации и переходы

| Элемент | Анимация | Длительность | Easing |
|---------|----------|-------------|--------|
| Скролл | `scroll-behavior: smooth` | — | — |
| Сворачиваемые блоки | `max-height` + `opacity` | 300ms | ease |
| Курсор стриминга | `fan-blink` (step-end) | 1s loop | step-end |
| Braille-спиннер | `fan-braille-spin` (steps(10)) | 0.8s loop | steps |
| Смена статуса tool | background-color transition | 200ms | ease |

---

## 16. Нефункциональные требования

### 16.1 Производительность
- highlight.js загружается лениво (не бандлится), только инкрементальная подсветка новых блоков
- DOM-операции батчатся при стриминге (не на каждый токен)
- Большие код-блоки (>500 строк) сворачиваются по умолчанию

### 16.2 Безопасность
- JSoup-санитизация всего пользовательского контента
- JCEF работает в песочнице Chromium
- Все параметры в Kotlin→JS-вызовах экранируются
- `javascript:` URL и `on*` атрибуты удаляются при санитизации

### 16.3 Доступность
- Кнопки уточнений навигируемы с клавиатуры
- Минимальный контраст WCAG AA для всех цветовых пар
- Focus-visible стили для интерактивных элементов

### 16.4 Память
- Очистка DOM-узлов при переключении сессии
- Лимит DOM-узлов: при превышении порога (~10000) — удаление старых сообщений из DOM (но не из истории)

### 16.5 Совместимость
- JCEF обязателен (IC-2024.1+)
- Fallback на `JEditorPane` **не предусмотрен**

---

## 17. Структура файлов

Новые файлы внутри модуля IDEA Plugin:

```
idea-plugin/
└── src/main/
    ├── resources/
    │   └── html/
    │       ├── fan-chat.html              # HTML-шаблон чата
    │       ├── fan-chat-styles.css        # Основные стили (все секции 2-8, 13-14)
    │       └── code-block-styles.css      # Стили блоков кода + highlight.js override
    └── kotlin/
        └── fan/ui/chat/
            ├── jcef/
            │   ├── JcefFanChatView.kt     # JCEF browser wrapper
            │   └── FanChatHtmlResources.kt # CSS/JS injection, template loading
            ├── markdown/
            │   ├── FanMarkdownParser.kt   # Markdown → ContentBlock
            │   ├── FanMarkdownRenderer.kt # ContentBlock → HTML
            │   └── ContentBlock.kt        # Sealed interface блоков
            └── FanHtmlDocumentManager.kt  # High-level rendering manager
```

---

## 18. Зависимости и интеграция

### 18.1 Зависимости

| Зависимость | Версия | Назначение |
|-------------|--------|-----------|
| `org.jetbrains.cef` (JCEF) | Bundled with IDE | Chromium rendering |
| `org.jsoup` (JSoup) | Latest stable | HTML-санитизация |
| `highlight.js` | 11.9.0 (CDN) | Подсветка синтаксиса |

### 18.2 Интеграция с существующими компонентами

| Компонент | Связь |
|-----------|-------|
| `FanWsClient` | Поставляет события чата → `FanHtmlDocumentManager` |
| `FanMessageService` | Парсит события WS → вызывает методы `FanHtmlDocumentManager` |
| `FanSettings` | Поставляет размер шрифта, настройки темы |
| `JcefFanChatView` | Обёртка `JBCefBrowser`, bridge Kotlin↔JS |
| `FanChatHtmlResources` | Загружает и инжектирует CSS/JS в HTML-шаблон |
| `JBCefJSQuery` | Обработка коллбэков из JS в Kotlin (clarification clicks) |
| `EditorColorsManager` | Детекция тёмной/светлой темы IDE |

---

## 19. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| JCEF не загружен в старых IDE | Средняя | Критичное | Требование IC-2024.1+, проверка при старте плагина |
| highlight.js CDN недоступен | Низкая | Среднее | Fallback: code-блоки без подсветки, попытка повторной загрузки |
| Несоответствие цветов при смене темы IDE | Средняя | Низкое | Прослушивание `EditorColorsManager.TOPIC`, мгновенное обновление |
| XSS через markdown | Низкая | Критичное | JSoup sanitization + атрибут sandbox на JCEF |
| Производительность при длинных сессиях | Средняя | Среднее | DOM-очистка, сворачивание больших блоков, лимит узлов |
| Braille-спиннер не анимируется через CSS | Высокая | Низкое | JS-реализация через `setInterval` + `textContent` (как ORF) |

---

## 20. Приоритеты

### Must Have (Обязательно)
- [ ] CSS-переменные для обеих тем (тёмная/светлая) — все значения из TUI `dark.json`/`light.json`
- [ ] Переключение тем по IntelliJ LaF
- [ ] Рендеринг сообщений (user/assistant/system/error) — bubble-раскладка
- [ ] Tool call-блоки (pending/success/error) — сворачиваемые
- [ ] Thinking-блоки — сворачиваемые со спиннером
- [ ] Блоки кода с языковой меткой и кнопкой копирования
- [ ] Футер (2 строки: CWD+branch, stats+model+context)
- [ ] JS API `__fan_*` — все функции для управления DOM из Kotlin
- [ ] Kotlin-интеграция (JcefFanChatView + FanHtmlDocumentManager)
- [ ] XSS-санитизация

### Should Have (Желательно)
- [ ] Markdown-рендеринг (FanMarkdownParser + FanMarkdownRenderer)
- [ ] highlight.js интеграция (ленивая загрузка CDN)
- [ ] Курсор стриминга (блинк-анимация)
- [ ] Блоки уточнений (clarification) с кнопками
- [ ] Inline-код с стилизацией
- [ ] Diff-рендеринг (цветные +added/-removed строки)

### Could Have (Возможно)
- [ ] Блоки кода >500 строк сворачиваются по умолчанию
- [ ] Настройка размера шрифта через Settings
- [ ] Стилизация скроллбаров
- [ ] WCAG AA контраст для всех пар

### Won't Have (Не входит)
- [ ] Fallback на `JEditorPane` (JCEF обязателен)
- [ ] Markdown-редактор (WYSIWYG) — только просмотр
- [ ] Бандлинг highlight.js — только CDN
- [ ] Поддержка IDE < IC-2024.1

---

## 21. Следующие шаги

- [ ] Создать HTML-шаблон `fan-chat.html` и CSS-файлы
- [ ] Реализовать `JcefFanChatView.kt` — обёртку JCEF с bridge Kotlin↔JS
- [ ] Реализовать `FanHtmlDocumentManager.kt` — менеджер рендеринга
- [ ] Реализовать `FanMarkdownParser.kt` + `FanMarkdownRenderer.kt`
- [ ] Интегрировать переключение тем (`__fan_updateTheme`)
- [ ] Реализовать футер с обновлением через WS-события
- [ ] Добавить JSoup-санитизацию для всех входящих данных
- [ ] Тестирование: тёмная/светлая тема, стриминг, tool-блоки, clarification
- [ ] Тестирование: длинные сессии (производительность DOM)
- [ ] Тестирование: XSS-векторы через markdown

---

*Создано: Documentation Specialist*
*Связанные спецификации: [spec_idea-plugin-integration_2026-04-24.md](./spec_idea-plugin-integration_2026-04-24.md), [spec_runtime-agent_2026-04-10.md](./spec_runtime-agent_2026-04-10.md)*
