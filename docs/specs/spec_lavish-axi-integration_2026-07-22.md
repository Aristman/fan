# Спецификация: Интеграция lavish-axi в FAN

## Метаданные
- **Дата**: 2026-07-22
- **Автор**: Specification Generator (на основе idea-lab исследования)
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Интеграция
- **Исходный документ**: `docs/research/idea-lab/lavish-axi-integration/Интеграция lavish-axi в FAN — исследование.md`

## 1. Обзор

### 1.1 Цель

Интегрировать lavish-axi (AXI-CLI для визуального ревью HTML-артефактов) в экосистему FAN. Создать bundle-пакет для FAN Store, содержащий Extension (tools + lifecycle hooks) и Skill (SKILL.md с narrative guidance), позволяющий агентам FAN генерировать HTML-артефакты и получать структурированный фидбек от пользователя через браузер.

### 1.2 Контекст

Когда агент FAN генерирует сложный визуальный контент (план, диаграмму, сравнительную таблицу), пользователь получает HTML-файл и вынужден давать обратную связь текстом — «поменяй цвет в третьем столбце», «стрелка от блока A к блоку B должна быть пунктирной». Это медленно, неточно и теряет интерактивность HTML.

lavish-axi решает эту проблему: открывает HTML в локальном браузере, позволяет аннотировать элементы, редактировать Mermaid-диаграммы как whiteboard, и отправляет структурированный фидбек через `lavish-axi poll` (long-poll). CLI-инструмент с 2.1k ⭐, MIT-лицензия, npm-пакет, AXI-принципы (token-efficient output, content-first, contextual disclosure).

FAN — локальный AI-агент с Extension API (registerTool, lifecycle hooks), Skill-системой (SKILL.md), оркестратором (воркеры, задачи) и FAN Store (дистрибуция пакетов). Интеграция lavish-axi даст FAN уникальный DX: первый агент с native HTML artifact review.

### 1.3 Описание решения

Bundle-пакет `fan-lavish` для FAN Store, содержащий:

- **Extension** (`index.ts`) — регистрирует единый tool `lavish` с параметром `command`, lifecycle hooks для ambient context и cleanup, auto-detect CLI стратегии (installed → npx fallback)
- **Skill** (`SKILL.md`) — narrative guidance для агентов: когда использовать lavish, workflow (create → open → poll → fix → end), playbook router, visual guidance
- **Конфигурация** (`config.json`) — минимальная: `port` (default 4387), `noOpen` (default false)

Пакет авто-детектится FAN Store как `bundle` (присутствуют и `SKILL.md`, и `index.ts`).

## 2. Функциональные требования

### 2.1 Основные функции

#### F1: Единый tool `lavish`

Extension регистрирует один tool с параметром `command` (enum):

| Subcommand | Параметры | Описание |
|-----------|-----------|----------|
| `open` | `file: string`, `reopen?: boolean`, `noGate?: boolean` | Открыть/возобновить сессию Lavish Editor для HTML-файла |
| `poll` | `file: string`, `agentReply?: string` | Long-poll: блокирует до действия пользователя. Возвращает prompts, layout_warnings, session status |
| `end` | `file: string` | Завершить сессию как агент (agent-initiated end) |
| `playbook` | `id?: string` | Без id — список playbook-ов. С id — guidance конкретного playbook (diagram, plan, comparison) |
| `design` | — | Agent-facing design guidance (CDN snippets, Mermaid init, design rules) |
| `export` | `file: string`, `out?: string` | Экспорт standalone HTML с инлайнированными локальными ассетами |
| `info` | — | Текущие сессии + usage guidance (эквивалент `lavish-axi` без аргументов) |

**Входные параметры tool (TypeBox schema):**

```typescript
const LavishParams = Type.Object({
  command: Type.Union([
    Type.Literal("open"),
    Type.Literal("poll"),
    Type.Literal("end"),
    Type.Literal("playbook"),
    Type.Literal("design"),
    Type.Literal("export"),
    Type.Literal("info"),
  ], { description: "Subcommand to execute" }),
  file: Type.Optional(Type.String({ description: "Path to HTML artifact file" })),
  playbook_id: Type.Optional(Type.String({ description: "Playbook ID: diagram, plan, comparison, table, code, input, slides" })),
  agent_reply: Type.Optional(Type.String({ description: "Agent's reply to show in browser chat (poll only)" })),
  reopen: Type.Optional(Type.Boolean({ description: "Reopen a user-ended session (open only)", default: false })),
  no_gate: Type.Optional(Type.Boolean({ description: "Skip open-time layout curtain (open only)", default: false })),
  out: Type.Optional(Type.String({ description: "Output path for export (export only)" })),
});
```

**promptSnippet для system prompt:**
```
lavish: Open HTML artifacts in Lavish Editor for visual review with human feedback loop.
Commands: open, poll, end, playbook, design, export, info.
Use playbook before writing HTML. Always poll after open.
```

**promptGuidelines:**
```
- MUST run `lavish({ command: "playbook", playbook_id: "<id>" })` for each matching playbook BEFORE writing HTML
- MUST call `lavish({ command: "poll", file: "<path>" })` after every `open` to receive user feedback
- Fix layout_warnings (proven severe failures) before asking user to review
- On poll status: "ended" → stop polling, deliver final updates in chat
- HTML artifacts must use relative paths for local assets (images, CSS, fonts)
- Mermaid diagrams in `.mermaid` containers become editable Excalidraw whiteboards
```

#### F2: CLI Auto-Detect

Extension определяет расположение lavish-axi CLI при первом сессии:

```
1. where lavish-axi        → found in PATH? Use it.
2. npm root -g → existsSync(join(globalDir, "lavish-axi"))  → global install? Use it.
3. npx -y lavish-axi       → fallback: on-demand download
```

Результат кешируется на сессию. При ошибке — informative error с инструкцией по установке.

**Cross-platform:**
- Windows: `where lavish-axi` (cmd) или `Get-Command lavish-axi` (PowerShell)
- Unix: `which lavish-axi`
- Fallback: `spawnSync("lavish-axi", ["--version"])` — если exit code 0, значит установлен

#### F3: Session Lifecycle Hooks

**`session_start`:**
- Запустить `lavish-axi` (без аргументов) через auto-detected CLI
- Если есть открытые сессии → inject ambient context message:
  ```
  ## Lavish Editor — Open Sessions
  [session list in TOON format]
  Use `lavish({ command: "poll", file: "<path>" })` to resume feedback collection.
  ```
- Если нет открытых сессий → ничего не инжектить (skill guidance достаточно)

**`session_shutdown`:**
- Вызвать `lavish-axi stop` для graceful shutdown фонового сервера
- Если сервер не запущен — no-op (не ошибка)

#### F4: Skill (SKILL.md)

Narrative guidance для агентов, загружается при вызове `/lavish` или автоматически:

```markdown
---
name: lavish
description: >
  Turn complex or visual agent responses into rich, reviewable HTML artifacts
  the user can annotate and send feedback on, using the lavish tool.
  Use when about to give a plan, comparison, diagram, table, code diff, report,
  or anything easier to grasp visually than as prose.
argument-hint: <what the artifact should show>
---

# Lavish Editor

## Когда использовать
- Пользователь просит визуальный план, диаграмму, сравнение, отчёт
- Результат легче понять визуально, чем текстом
- Нужен human-in-the-loop фидбек на артефакт

## Workflow
1. Вызови `lavish({ command: "playbook", playbook_id: "<matching>" })` для КАЖДОГО релевантного playbook
2. Напиши HTML-артефакт (файл `.html`), используя playbook guidance
3. Вызови `lavish({ command: "open", file: "<path>" })` для открытия в браузере
4. Вызови `lavish({ command: "poll", file: "<path>" })` для ожидания фидбека
5. Если есть layout_warnings → исправь, повтори poll
6. Если есть prompts → примени изменения к HTML, повтори poll с agent_reply
7. Если status: "ended" → заверши, доставь финальные изменения в чат

## Playbook Router
MUST вызвать playbook для каждого совпадения:
- **diagram** — relationships, flows, state, architecture → Mermaid
- **plan** — product/technical plans → goal → approach → risks
- **comparison** — options, tradeoffs → before/after, option cards

## Visual Guidance
- Use semantic HTML (tables, lists, headings) over div-soup
- High contrast, sufficient whitespace, clear hierarchy
- Interactive elements (inputs, selects, buttons) are auto-interactive in Lavish
- Local assets: copy next to HTML, reference with relative paths
- Mermaid: use `.mermaid` container for editable whiteboard diagrams
```

#### F5: Поддерживаемые Playbook-ы

Три playbook-а (из запроса пользователя):

| ID | Trigger (use_when) | Guidance summary |
|----|-------------------|------------------|
| `diagram` | Map relationships, flows, state, architecture | Mermaid > CSS grid; flowchart, sequence, class, ER, state diagrams convert to editable Excalidraw |
| `plan` | Explain a product/technical plan | Goal → approach → risks → comparison; combine with diagram + table playbooks |
| `comparison` | Show options, tradeoffs, current vs target | Before/after, option cards, scorecard; semantic `<table>` for data |

### 2.2 Пользовательские сценарии

#### Сценарий 1: Генерация плана в TUI

**Предусловия:** FAN запущен в TUI-режиме, fan-lavish установлен.
**Шаги:**
1. Пользователь пишет: «Сделай план реализации REST API для пользователей»
2. Агент загружает skill lavish (автоматически или через `/lavish`)
3. Агент вызывает `lavish({ command: "playbook", playbook_id: "plan" })`
4. Агент получает playbook guidance (structure, design_rules, choose[])
5. Агент создаёт файл `plan.html` с визуальным планом
6. Агент вызывает `lavish({ command: "open", file: "plan.html" })`
7. Открывается браузер с Lavish Editor
8. Агент вызывает `lavish({ command: "poll", file: "plan.html" })`
9. Пользователь аннотирует элемент: «Добавь этап валидации перед бизнес-логикой»
10. Poll возвращает `prompts: [{ text: "Добавь этап валидации...", selector: ".step-3" }]`
11. Агент редактирует `plan.html`, вызывает poll с `agent_reply`
12. Пользователь кликает «End session»
13. Poll возвращает `status: "ended"`
14. Агент пишет финальное резюме в чат

**Ожидаемый результат:** Пользователь получил визуальный план, аннотировал изменения, агент внёс правки. HTML-файл сохранён локально.

#### Сценарий 2: Сравнение технологий через оркестратор

**Предусловия:** FAN запущен с оркестратором, fan-lavish установлен.
**Шаги:**
1. Пользователь: «Сравни PostgreSQL vs MySQL для нашего проекта»
2. Координатор создаёт задачу, порождает воркер `implement`
3. Воркер загружает skill lavish, вызывает `lavish({ command: "playbook", playbook_id: "comparison" })`
4. Воркер создаёт `comparison.html` с таблицей сравнения
5. Воркер вызывает `lavish({ command: "open", file: "comparison.html" })`
6. Воркер вызывает `lavish({ command: "poll", file: "comparison.html" })` — блокируется
7. Пользователь отправляет фидбек: «Добавь колонку с ценами»
8. Воркер получает prompts, редактирует HTML, повторяет poll
9. Пользователь завершает сессию
10. Воркер возвращает результат координатору

**Ожидаемый результат:** Воркер создал визуальное сравнение, получил фидбек от пользователя через браузер, итеративно улучшил артефакт.

#### Сценарий 3: Диаграмма архитектуры с Mermaid

**Предусловия:** FAN запущен, fan-lavish установлен.
**Шаги:**
1. Пользователь: «Нарисуй архитектуру нашего микросервиса»
2. Агент вызывает `lavish({ command: "playbook", playbook_id: "diagram" })`
3. Playbook guidance: «Mermaid > CSS grid; flowchart/sequence/state supported»
4. Агент создаёт `architecture.html` с Mermaid flowchart:
   ```html
   <div class="mermaid">
   flowchart TD
     Gateway --> AuthService
     Gateway --> UserService
     UserService --> Database
   </div>
   ```
5. Агент открывает, polls
6. Пользователь кликает на Mermaid-диаграмму → Excalidraw whiteboard
7. Пользователь добавляет блоки, меняет связи, Queue feedback
8. Poll возвращает `prompts: [{ tag: "whiteboard", target: { type: "excalidraw-scene", scenePath: "...", sourceHash: "..." } }]`
9. Агент обновляет Mermaid source в HTML на основе edit summary
10. Повторяет poll

**Ожидаемый результат:** Mermaid-диаграмма стала редактируемым whiteboard. Изменения синхронизированы обратно в HTML.

### 2.3 Бизнес-правила

- **Playbook-first:** Агент ОБЯЗАН вызвать playbook для каждого совпадения ПЕРЕД написанием HTML. Один артефакт часто комбинирует несколько playbook-ов (plan + diagram + comparison).
- **Poll after open:** После каждого `open` агент ОБЯЗАН вызвать `poll` для получения фидбека. Не возвращать результат пользователю до завершения сессии.
- **Fix layout warnings first:** Если poll возвращает `layout_warnings` (proven severe failures) — исправить ДО запроса ревью от пользователя.
- **Stop on ended:** Если poll возвращает `status: "ended"` — прекратить polling. Если ended by user — не переоткрывать без `--reopen`.
- **Agent reply:** При повторном poll после исправлений — передавать `agent_reply` с кратким описанием изменений. Это показывает reply в browser chat и re-enables human sends.
- **Relative paths:** Локальные ассеты (изображения, CSS, шрифты) — копировать рядом с HTML, ссылаться относительными путями. Абсолютные `file://` пути не работают через Lavish server.
- **No silent reopen:** Если пользователь завершил сессию из браузера (ended_by: "user") — `open` без `reopen: true` возвращает guidance, а не переоткрывает.

## 3. UI/UX требования

### 3.1 Взаимодействие с TUI

- Tool `lavish` работает как обычный FAN tool — вызов виден в TUI как tool call
- При `open` — TUI показывает URL сессии (кликабельный): `http://127.0.0.1:4387/session/<id>`
- При `poll` — tool блокируется, TUI показывает spinner с heartbeat-индикатором
- При возврате фидбека — TUI показывает краткое summary (количество prompts, наличие layout_warnings)

### 3.2 Взаимодействие с браузером (Lavish Editor)

- Открывается в системном браузере пользователя (не в WebView)
- Artifact в iframe + annotation SDK (chrome)
- Composer: Enter — отправить, Shift+Enter — новая строка, Ctrl+Enter — queue + send
- Ctrl+I / Cmd+I — переключение annotate/explore mode
- Native controls (inputs, selects, buttons) — автоматически интерактивны
- Mermaid whiteboard: клик по `.mermaid` → Excalidraw редактор

### 3.3 Обработка ошибок

| Ошибка | Поведение tool | Сообщение пользователю |
|--------|---------------|----------------------|
| lavish-axi не найден (не установлен, нет Node.js) | Возвращает error result | «lavish-axi не найден. Установите: `npm install -g lavish-axi` или убедитесь что Node.js ≥ 18 в PATH» |
| HTML файл не существует | Возвращает error result | «Файл не найден: <path>» |
| Порт 4387 занят | lavish-axi автоматически пробует следующий порт | «Lavish Editor запущен на порту <actual_port>» |
| Poll прерван (Ctrl+C / signal abort) | Graceful abort, возвращает partial result | «Ожидание фидбека прервано. Очередь фидбека сохранена — перезапустите poll» |
| Сервер не отвечает (crash) | Retry 1 раз, затем error | «Lavish Editor сервер не отвечает. Попробуйте `lavish-axi stop && lavish-axi <file>`» |
| Invalid command | Возвращает structured error | «Неизвестная команда: <cmd>. Доступные: open, poll, end, playbook, design, export, info» |

## 4. Нефункциональные требования

### 4.1 Производительность

- **CLI detect:** ≤ 2 секунды (where/which + npm root). Кешируется на сессию.
- **open:** ≤ 3 секунды до открытия браузера (server startup при первом вызове ~1-2s)
- **poll:** Блокирующий, без timeout. Heartbeat на stderr каждые 30 секунд.
- **playbook/design:** ≤ 1 секунды (локальный CLI, stdout output)
- **Memory overhead:** lavish-axi server — ~30-50 MB (Node.js + Express + in-memory state)

### 4.2 Безопасность

- **Loopback only:** lavish-axi server bind to `127.0.0.1` by default. Не доступен из сети без explicit `LAVISH_AXI_HOST`.
- **DNS rebinding protection:** Host header validation (127.0.0.1, ::1, localhost + bind host).
- **No auth:** Локальный single-user runtime, аутентификация не нужна.
- **File access:** Lavish server может читать и сервить произвольные локальные файлы. Binding beyond loopback — только на trusted network.
- **Export/share:** `export` инлайнит только локальные ассеты (cap: 10 MB per asset, 25 MB total). `share` — explicit opt-in, публикует на ht-ml.app (third-party).

### 4.3 Надёжность

- **Idle timeout:** Сервер автоматически останавливается через 30 минут без активности (LAVISH_AXI_IDLE_TIMEOUT_MS).
- **Session persistence:** State в `~/.lavish-axi/state.json` — переживает перезапуск сервера.
- **Feedback preservation:** Queued feedback не теряется при poll interruption — следующий poll получает всю очередь.
- **Graceful shutdown:** `session_shutdown` hook вызывает `lavish-axi stop`. При crash — daemonized descendants очищаются через `waitForChildProcess()`.

### 4.4 Масштабируемость

- **1 пользователь, 1 сессия** — локальный runtime, масштабирование не требуется.
- **Несколько артефактов:** Каждая сессия keyed by canonical file path. Несколько артефактов = несколько параллельных сессий.
- **Оркестратор:** До 8 параллельных воркеров, каждый может генерировать артефакты. Сервер один (shared).

## 5. Технические требования

### 5.1 Стек технологий

| Компонент | Технология | Обоснование |
|-----------|-----------|-------------|
| Extension runtime | TypeScript (jiti loader) | Стандарт для FAN extensions, auto-compile on load |
| CLI wrapper | Node.js `child_process.spawn()` | lavish-axi — внешний Node.js процесс, не библиотека |
| Skill | Markdown (SKILL.md) | FAN skill format: frontmatter + narrative body |
| Bundle | .tar.gz (FAN Store) | Авто-детекция: наличие SKILL.md + index.ts = bundle |
| CLI | lavish-axi (npm, MIT) | Upstream AXI tool, 2.1k ⭐, active maintenance |
| Output format | JSON (stdout от lavish-axi) | Structured, parseable. TOON тоже читается LLM, но JSON надёжнее для tool result |

### 5.2 Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                     FAN Runtime                          │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │            fan-lavish Extension (index.ts)        │   │
│  │                                                   │   │
│  │  Lifecycle:                                       │   │
│  │    session_start  → detect CLI → ambient context  │   │
│  │    session_shutdown → lavish-axi stop             │   │
│  │                                                   │   │
│  │  Tool "lavish":                                   │   │
│  │    { command: "open" }   → spawn lavish-axi <f>   │   │
│  │    { command: "poll" }   → spawn lavish-axi poll  │   │
│  │    { command: "end" }    → spawn lavish-axi end   │   │
│  │    { command: "playbook"} → spawn lavish-axi pb   │   │
│  │    { command: "design" } → spawn lavish-axi dsgn  │   │
│  │    { command: "export" } → spawn lavish-axi exprt │   │
│  │    { command: "info" }   → spawn lavish-axi       │   │
│  │                                                   │   │
│  │  Config: { port: 4387, noOpen: false }            │   │
│  └───────────────────┬──────────────────────────────┘   │
│                      │ spawn + stdout capture            │
│                      ▼                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │            lavish-axi (Node.js process)           │   │
│  │                                                   │   │
│  │  Server (Express, port 4387, loopback)            │   │
│  │    ├── Serves HTML artifact in iframe             │   │
│  │    ├── Injects annotation SDK                     │   │
│  │    ├── Layout audit (severe failures only)        │   │
│  │    ├── Long-poll endpoint (/poll/:sessionKey)     │   │
│  │    └── File watcher (live reload)                 │   │
│  │                                                   │   │
│  │  State: ~/.lavish-axi/state.json                  │   │
│  │  Idle timeout: 30 min (configurable)              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │            fan-lavish Skill (SKILL.md)             │   │
│  │                                                   │   │
│  │  When to use → Workflow → Playbook Router →       │   │
│  │  Visual guidance → Commands reference             │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**Extension entry point (`index.ts`):**

```typescript
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { Type } from "@sinclair/typebox";

// --- CLI Auto-Detect ---

interface CliInfo {
  bin: string;
  args: string[];
  source: "path" | "global" | "npx";
}

let cachedCli: CliInfo | undefined;

function detectCli(): CliInfo {
  if (cachedCli) return cachedCli;

  // 1. Check PATH
  try {
    const where = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(where, ["lavish-axi"], { encoding: "utf8", stdio: "pipe" });
    if (result.status === 0 && result.stdout.trim()) {
      cachedCli = { bin: "lavish-axi", args: [], source: "path" };
      return cachedCli;
    }
  } catch { /* continue */ }

  // 2. Check global npm install
  try {
    const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: "pipe" });
    if (npmRoot.status === 0) {
      const globalDir = npmRoot.stdout.trim();
      if (existsSync(join(globalDir, "lavish-axi"))) {
        cachedCli = { bin: "lavish-axi", args: [], source: "global" };
        return cachedCli;
      }
    }
  } catch { /* continue */ }

  // 3. Fallback to npx
  cachedCli = { bin: "npx", args: ["-y", "lavish-axi"], source: "npx" };
  return cachedCli;
}

// --- Config ---

interface LavishConfig {
  port: number;
  noOpen: boolean;
}

function loadConfig(): LavishConfig {
  // Try loading from extension config or defaults
  return { port: 4387, noOpen: false };
}

// --- Subprocess Execution ---

function executeLavish(
  subArgs: string[],
  signal?: AbortSignal,
  timeoutMs: number = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cli = detectCli();
  const fullArgs = [...cli.args, ...subArgs];
  const config = loadConfig();

  // Inject config flags if non-default
  if (config.port !== 4387) {
    // lavish-axi reads LAVISH_AXI_PORT env var
    // Pass via env instead of CLI flags
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(cli.bin, fullArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LAVISH_AXI_PORT: String(config.port),
        ...(config.noOpen ? { LAVISH_AXI_NO_OPEN: "1" } : {}),
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    // AbortSignal handling
    if (signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    // Timeout for non-poll commands
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
          reject(new Error(`lavish-axi timed out after ${timeoutMs}ms`));
        }, 5000);
      }, timeoutMs);
    }

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Long-poll execution (no timeout) ---

function executeLavishPoll(
  subArgs: string[],
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cli = detectCli();
  const fullArgs = [...cli.args, ...subArgs];
  const config = loadConfig();

  return new Promise((resolve, reject) => {
    const proc = spawn(cli.bin, fullArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LAVISH_AXI_PORT: String(config.port),
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      // Heartbeat forwarding
      onUpdate?.(`[heartbeat] ${chunk.toString().trim()}`);
    });

    if (signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on("error", reject);
  });
}

// --- Extension Registration ---

export default function fanLavish(fan: ExtensionAPI) {
  // --- Lifecycle Hooks ---

  fan.on("session_start", async (_event, ctx) => {
    try {
      const result = await executeLavish([], ctx.signal, 5_000);
      if (result.code === 0 && result.stdout.trim()) {
        // Parse output for open sessions
        const output = result.stdout.trim();
        if (output.includes("sessions[") && !output.includes("sessions[0]")) {
          // Has open sessions → inject ambient context
          ctx.injectMessage?.({
            role: "system",
            content: `## Lavish Editor — Ambient Context\n\n${output}`,
          });
        }
      }
    } catch {
      // CLI not found — silent, skill will handle guidance
    }
  });

  fan.on("session_shutdown", async () => {
    try {
      await executeLavish(["stop"], undefined, 5_000);
    } catch {
      // Best-effort cleanup
    }
  });

  // --- Tool Registration ---

  fan.registerTool({
    name: "lavish",
    label: "Lavish Editor",
    description: "Open HTML artifacts in Lavish Editor for visual review with human feedback loop",
    promptSnippet: "lavish: Open HTML artifacts in Lavish Editor for visual review with human feedback loop. Commands: open, poll, end, playbook, design, export, info. Use playbook before writing HTML. Always poll after open.",
    promptGuidelines: [
      "MUST run lavish({ command: 'playbook', playbook_id: '<id>' }) for each matching playbook BEFORE writing HTML",
      "MUST call lavish({ command: 'poll', file: '<path>' }) after every open to receive user feedback",
      "Fix layout_warnings (proven severe failures) before asking user to review",
      "On poll status 'ended' → stop polling, deliver final updates in chat",
      "HTML artifacts must use relative paths for local assets",
      "Mermaid diagrams in .mermaid containers become editable Excalidraw whiteboards",
    ],
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("open"),
        Type.Literal("poll"),
        Type.Literal("end"),
        Type.Literal("playbook"),
        Type.Literal("design"),
        Type.Literal("export"),
        Type.Literal("info"),
      ], { description: "Subcommand to execute" }),
      file: Type.Optional(Type.String({ description: "Path to HTML artifact file (required for open, poll, end, export)" })),
      playbook_id: Type.Optional(Type.String({ description: "Playbook ID: diagram, plan, comparison, table, code, input, slides (for playbook command)" })),
      agent_reply: Type.Optional(Type.String({ description: "Agent's reply to show in browser chat (poll only)" })),
      reopen: Type.Optional(Type.Boolean({ description: "Reopen a user-ended session (open only)", default: false })),
      no_gate: Type.Optional(Type.Boolean({ description: "Skip open-time layout curtain (open only)", default: false })),
      out: Type.Optional(Type.String({ description: "Output path for export" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args: string[] = [];

      switch (params.command) {
        case "open": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'open' command" }] };
          }
          args.push(params.file);
          if (params.reopen) args.push("--reopen");
          if (params.no_gate) args.push("--no-gate");
          break;
        }

        case "poll": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'poll' command" }] };
          }
          args.push("poll", params.file);
          if (params.agent_reply) args.push("--agent-reply", params.agent_reply);
          // Long-poll: no timeout, blocking
          const pollResult = await executeLavishPoll(args, signal, (heartbeat) => {
            onUpdate?.({ content: [{ type: "text", text: heartbeat }] });
          });
          if (pollResult.code !== 0) {
            return { content: [{ type: "text", text: `lavish-axi poll error (exit ${pollResult.code}): ${pollResult.stderr || pollResult.stdout}` }] };
          }
          return { content: [{ type: "text", text: pollResult.stdout }] };
        }

        case "end": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'end' command" }] };
          }
          args.push("end", params.file);
          break;
        }

        case "playbook": {
          args.push("playbook");
          if (params.playbook_id) args.push(params.playbook_id);
          break;
        }

        case "design": {
          args.push("design");
          break;
        }

        case "export": {
          if (!params.file) {
            return { content: [{ type: "text", text: "Error: 'file' parameter required for 'export' command" }] };
          }
          args.push("export", params.file);
          if (params.out) args.push("--out", params.out);
          break;
        }

        case "info": {
          // No args — home output
          break;
        }

        default: {
          return { content: [{ type: "text", text: `Unknown command: ${params.command}. Available: open, poll, end, playbook, design, export, info` }] };
        }
      }

      const result = await executeLavish(args, signal, 15_000);
      if (result.code !== 0) {
        return { content: [{ type: "text", text: `lavish-axi error (exit ${result.code}): ${result.stderr || result.stdout}` }] };
      }
      return { content: [{ type: "text", text: result.stdout }] };
    },
  });
}
```

### 5.3 Интеграции

| Система | Интеграция | Описание |
|---------|-----------|----------|
| **lavish-axi CLI** | subprocess spawn | Внешний Node.js процесс. Auto-detect: PATH → global npm → npx -y |
| **FAN Extension API** | `fan.registerTool()`, `fan.on()` | Lifecycle hooks + tool registration |
| **FAN Skill system** | `SKILL.md` в пакете | Narrative guidance, auto-loaded or via `/lavish` |
| **FAN Store** | Bundle (.tar.gz) | Авто-детекция: SKILL.md + index.ts = bundle type |
| **Node.js** | ≥ 18 (for npx -y) | Runtime dependency для lavish-axi CLI |

### 5.4 Пакетная структура

```
fan-lavish/
├── SKILL.md                    # Skill: narrative guidance для агентов
├── index.ts                    # Extension: tool registration + lifecycle hooks
├── package.json                # Манифест пакета
│   {
│     "name": "fan-lavish",
│     "version": "1.0.0",
│     "description": "Lavish Editor integration for FAN — visual HTML artifact review with human feedback loop",
│     "fan": {
│       "extensions": ["./index.ts"],
│       "skills": true
│     },
│     "keywords": ["fan", "lavish", "html", "artifacts", "review", "visualization", "axi"],
│     "license": "MIT"
│   }
├── config.example.json         # Пример конфигурации
│   { "port": 4387, "noOpen": false }
└── README.md                   # Документация для пользователя
```

**FAN Store manifest (index.json entry):**

```json
{
  "name": "fan-lavish",
  "version": "1.0.0",
  "type": "bundle",
  "description": "Lavish Editor integration for FAN — visual HTML artifact review with human feedback loop",
  "downloadUrl": "https://fan.sea-agents.ru/fan-store/packages/fan-lavish-1.0.0.tar.gz",
  "hash": "sha256:<computed>",
  "requires": {
    "node": ">=18"
  }
}
```

## 6. Данные

### 6.1 Состояние сессий

lavish-axi хранит состояние в `~/.lavish-axi/state.json`:

```json
{
  "sessions": {
    "<sha256(filePath).slice(0,16)>": {
      "file": "/abs/path/to/artifact.html",
      "status": "open" | "ended",
      "endedBy": "user" | "agent" | null,
      "url": "http://127.0.0.1:4387/session/<key>",
      "pendingPrompts": [],
      "layoutWarnings": [],
      "openedAt": "ISO-8601",
      "lastActivity": "ISO-8601"
    }
  }
}
```

Extension не модифицирует state.json напрямую — только через CLI.

### 6.2 Конфигурация Extension

`config.json` (опциональный, в директории пакета):

```json
{
  "port": 4387,
  "noOpen": false
}
```

| Параметр | Тип | Default | Описание |
|----------|-----|---------|----------|
| `port` | number | 4387 | Порт Lavish Editor сервера. Передаётся через `LAVISH_AXI_PORT` env var |
| `noOpen` | boolean | false | Не открывать браузер при `open`. Передаётся через `LAVISH_AXI_NO_OPEN` env var |

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| lavish-axi не работает на Windows (path issues, file watching) | Средняя | Критичное | Протестировать перед релизом. Fallback: инструкция `npm install -g lavish-axi` вместо npx |
| Long-poll блокирует воркер оркестратора навсегда | Средняя | Среднее | AbortSignal от agent loop отменяет poll при Ctrl+C. Heartbeat каждые 30s показывает liveness. Feedback queue сохраняется при прерывании |
| Порт 4387 занят другим процессом | Низкая | Среднее | lavish-axi автоматически пробует следующий порт. Config позволяет задать кастомный порт |
| Модель генерирует невалидный HTML — layout gate блокирует показ | Средняя | Низкое | layout_warnings возвращаются в poll, агент исправляет итеративно. Пользователь может «Show anyway» |
| Breaking changes в lavish-axi CLI | Низкая | Среднее | Semantic versioning upstream. `lavish-axi update` через AXI SDK self-updater. Pin version в npx при необходимости |
| npx -y не работает в restricted sandboxes (CI, enterprise) | Низкая | Среднее | Auto-detect проверяет installed first. Fallback: `npm install -g lavish-axi` |
| Конфликт с другими FAN tools (bash timeout, signal) | Низкая | Низкое | lavish_poll использует отдельный spawn без timeout. Signal handling по стандартному паттерну FAN |
| Пользователь не открывает браузер — poll висит бесконечно | Средняя | Низкое | Heartbeat показывает liveness в TUI. Пользователь может Ctrl+C для прерывания. Idle timeout сервера 30 min |

## 8. Компромиссы (Tradeoffs)

### 8.1 Принятые решения

**Решение: Bundle (Skill + Extension), не Skill-only и не Extension-only**
- **Альтернатива:** Skill-only — проще, но нет управляемых tools, ambient context, lifecycle hooks
- **Альтернатива:** Extension-only — мощнее, но нет narrative guidance для агентов
- **Обоснование:** Skill даёт агентам «зачем и когда» (playbook router, visual guidance, workflow). Extension даёт «как» (tools с правильным subprocess handling, ambient context, cleanup). Вместе = полноценная интеграция.

**Решение: Один tool `lavish` с subcommand, не 5 отдельных tools**
- **Альтернатива:** `lavish_open`, `lavish_poll`, `lavish_end`, `lavish_playbook`, `lavish_design` — 5 отдельных tools
- **Обоснование:** Один tool = меньше schema overhead в system prompt (~1 tool definition vs 5). Модель легко выбирает subcommand из enum. Компромисс: чуть больше параметров (file, playbook_id, agent_reply — опциональные).

**Решение: Auto-detect CLI (PATH → global → npx)**
- **Альтернатива:** Всегда npx -y — zero-setup, но медленно и требует интернет
- **Альтернатива:** Обязательный `npm install -g` — быстро, но setup friction
- **Обоснование:** Auto-detect даёт лучший DX: мгновенный запуск если установлен, graceful fallback если нет. Кешируется на сессию.

**Решение: Блокирующий poll (не async)**
- **Альтернатива:** Async poll с notification injection — сложнее, но агент не блокируется
- **Обоснование:** Блокирующий poll проще, соответствует FAN tool execution model. Agent loop естественно ждёт результат tool. AbortSignal + heartbeat обеспечивают graceful handling. Async-подход потребовал бы background process manager и resubscription logic.

**Решение: Нет интеграции с Dashboard**
- **Альтернатива:** Iframe в Dashboard WebView — удобнее, не нужен отдельный браузер
- **Обоснование:** MVP-first. Dashboard-интеграция добавит значительную сложность (WS subscription, iframe lifecycle, CSP). Отдельный браузер работает из коробки. Можно добавить в v2.

### 8.2 Отклонённые подходы

**MCP-сервер для lavish-axi:**
- Token overhead 2.3x vs AXI CLI (185K vs 79K tokens per task)
- Нет lifecycle hooks (session_start, session_shutdown)
- Нет skill/guidance — только tool schemas
- Противоречит AXI-философии (CLI-first, token-efficient)

**Собственный HTML-рендерер:**
- Неоправданные трудозатраты (месяцы vs дни)
- lavish-axi уже решает проблему (annotation SDK, Mermaid whiteboard, layout audit)
- Upstream активно развивается (43 релиза, 2.1k ⭐)

## 9. Приоритеты (MoSCoW)

### Must Have (Обязательно)

- [ ] F1: Tool `lavish` с subcommands: `open`, `poll`, `end`, `playbook`, `info`
- [ ] F2: CLI auto-detect (PATH → global npm → npx -y fallback)
- [ ] F3: Lifecycle hook `session_start` — detect CLI, кеширование
- [ ] F3: Lifecycle hook `session_shutdown` — `lavish-axi stop` (best-effort)
- [ ] F4: SKILL.md — when to use, workflow, playbook router, visual guidance
- [ ] Базовое тестирование в TUI mode (open → poll → feedback → iterate → end)
- [ ] Упаковка bundle в .tar.gz для FAN Store

### Should Have (Желательно)

- [ ] F1: Subcommands `design` и `export`
- [ ] Конфигурация `config.json` (port, noOpen)
- [ ] Тестирование с оркестратором (воркер implement генерирует артефакт → lavish → poll)
- [ ] Windows compatibility verification (where, file paths, spawn behavior)
- [ ] README.md с инструкциями по установке и использованию

### Could Have (Возможно)

- [ ] Dashboard integration (iframe с артефактом в WebView, ссылка на сессию в UI)
- [ ] `lavish-axi share` support (публикация на ht-ml.app)
- [ ] TOON output parsing (если даст измеримую экономию токенов vs JSON pass-through)
- [ ] Поддержка всех 7 playbook-ов (добавить table, code, input, slides)
- [ ] `lavish-axi update` self-updater integration

### Won't Have (Не входит)

- [ ] MCP-сервер — token overhead неприемлем для polling-based инструмента
- [ ] Собственный HTML-рендерер — используем upstream lavish-axi
- [ ] Интеграция с `lavish-design` (внутренний brand-скилл upstream) — не нужен
- [ ] Async poll с background process — слишком сложно для MVP, блокирующий poll достаточен

## 10. Следующие шаги

- [ ] **Шаг 1:** Проверить lavish-axi на Windows (`npx -y lavish-axi` → open HTML → poll → end). Зафиксировать issues.
- [ ] **Шаг 2:** Создать директорию пакета `extensions/fan-lavish/` (или отдельный репозиторий)
- [ ] **Шаг 3:** Написать `index.ts` — CLI auto-detect, tool registration, lifecycle hooks (по архитектуре из §5.2)
- [ ] **Шаг 4:** Написать `SKILL.md` — narrative guidance (по §2.1 F4)
- [ ] **Шаг 5:** Создать `package.json` + `config.example.json` + `README.md`
- [ ] **Шаг 6:** Протестировать в TUI mode: `/lavish plan for REST API` → полный workflow
- [ ] **Шаг 7:** Протестировать с оркестратором: implement worker → lavish → poll → iterate
- [ ] **Шаг 8:** Упаковать в .tar.gz (`tar czf fan-lavish-1.0.0.tar.gz fan-lavish/`)
- [ ] **Шаг 9:** Обновить `index.json` FAN Store, загрузить архив
- [ ] **Шаг 10:** Smoke-test: `fan store install fan-lavish` → verify auto-discovery → test workflow

---

*Создано: research-spec-generator skill*
*Исходный запрос: «хочу добавить расширение или скилл для axi/lavish»*
*На основе: idea-lab исследование (`docs/research/idea-lab/lavish-axi-integration/`)*
