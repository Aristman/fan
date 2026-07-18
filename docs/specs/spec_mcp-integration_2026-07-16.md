# Спецификация: Интеграция MCP (Model Context Protocol) в FAN

## Метаданные
- **Дата**: 2026-07-16
- **Автор**: Specification Generator (research-spec-generator skill)
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Интеграция
- **Исходный запрос**: "Внедрить MCP протокол для подключения сторонних MCP серверов с сохранением атомарности ядра и архитектуры лёгких воркеров"

---

## 1. Обзор

### 1.1 Цель

Добавить в FAN клиентскую поддержку Model Context Protocol (MCP) — открытого протокола для подключения сторонних инструментов (tools), ресурсов (resources) и промптов (prompts) от внешних MCP-серверов. Интеграция должна быть прозрачной для ядра FAN: `packages/agent` и core не получают зависимостей от MCP SDK, а архитектура лёгких worker agents сохраняется неизменной.

### 1.2 Контекст

MCP — это стандарт взаимодействия LLM-агентов с внешними инструментами через JSON-RPC 2.0. Спецификация: DRAFT-2026-v1. Официальный TypeScript SDK: `@modelcontextprotocol/sdk` v1.29.0 (2026-03-30).

FAN — локальный AI runtime-agent с модульной архитектурой (npm workspaces, Bun, TypeScript). Имеет систему расширений (Extension API), FAN Store для распространения пакетов, и orchestrator с coordinator/worker моделью.

Текущая проблема: FAN не умеет подключаться к сторонним MCP-серверам. Все инструменты — встроенные (read, write, bash, edit, grep, find, ls) либо зарегистрированные локальными расширениями.

### 1.3 Описание решения

Создать standalone FAN Store extension **`fan-mcp`**, который:
- Владеет MCP SDK и всей логикой подключения/жизненного цикла
- Читает конфигурацию из `mcp.json` (глобальный + проектный)
- Поддерживает stdio и Streamable HTTP транспорты
- Регистрирует MCP tools как нативные FAN `AgentTool` через существующий `ExtensionAPI.registerTool()`
- Использует `tool_call` event hook для permission gate
- Минимальные core изменения (~40 строк): `unregisterTool`/`updateTool` на ExtensionAPI для поддержки `tools/list_changed`

Worker agents (подпроцессы `fan --mode rpc --no-extensions`) **не получают** MCP доступ в этом scope. Это документируется как Should Have (Phase 2).

---

## 2. Функциональные требования

### 2.1 Основные функции

- **FR-01**: Подключение к MCP-серверам через stdio transport (spawn локального процесса, stdin/stdout JSON-RPC)
- **FR-02**: Подключение к MCP-серверам через Streamable HTTP transport (состоятельные сессии, fetch/streams)
- **FR-03**: Автоматическое обнаружение tools через `tools/list` при инициализации
- **FR-04**: Выполнение MCP tool через `tools/call` и преобразование результата в формат FAN `AgentToolResult`
- **FR-05**: Поддержка `notifications/tools/list_changed` — динамическое обновление каталога инструментов
- **FR-06**: Конфигурация через `mcp.json` (глобальный `~/.fan/agent/mcp.json` + проектный `.fan/mcp.json`, merge по server ID)
- **FR-07**: Фильтрация инструментов: `allowedTools`/`deniedTools` per server (glob patterns)
- **FR-08**: Permission gate через `tool_call` event hook — блокировка вызовов по политике
- **FR-09**: Отмена вызовов: FAN `AbortSignal` → MCP request cancellation
- **FR-10**: Таймауты: per-call (default 60s) и per-server (настраиваемый)
- **FR-11**: Разрешение секретов через `${ENV_VAR}` references в `mcp.json`
- **FR-12**: Установка через `fan store install fan-mcp`

### 2.2 Пользовательские сценарии

#### Сценарий 1: Подключение локального MCP-сервера (stdio)

**Предусловия:** Пользователь установил `fan-mcp` через FAN Store. В `~/.fan/agent/mcp.json` добавлен сервер:
```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

**Шаги:**
1. Пользователь запускает FAN (`fan`)
2. При `session_start` fan-mcp extension читает `mcp.json`
3. Для сервера `filesystem`: spawn `npx -y @modelcontextprotocol/server-filesystem .`
4. `Client.connect(stdioTransport)` → initialize handshake
5. `client.listTools()` → получает список tools (read_file, write_file, list_directory, ...)
6. Для каждого tool: `pi.registerTool(adapter.createToolDefinition(mcpTool))`
7. Инструменты появляются в агенте с именами `mcp__filesystem__read_file` и т.д.

**Ожидаемый результат:** Пользователь (или coordinator) может вызвать `mcp__filesystem__read_file` — вызов прозрачно проксируется в MCP сервер. Результат возвращается как обычный FAN tool result.

#### Сценарий 2: Подключение удалённого MCP-сервера (Streamable HTTP)

**Предусловия:** В `mcp.json` добавлен сервер:
```json
{
  "servers": {
    "github": {
      "transport": "streamable-http",
      "url": "https://api.github.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```
Переменная `GITHUB_TOKEN` установлена в окружении.

**Шаги:**
1. fan-mcp читает конфиг, разрешает `${GITHUB_TOKEN}` из env
2. Создаёт `StreamableHTTPClientTransport(url)`
3. `client.connect()` → POST initialize, GET SSE stream для server→client уведомлений
4. `client.listTools()` → получает tools
5. Регистрирует через `pi.registerTool()`

**Ожидаемый результат:** Инструменты GitHub API доступны в FAN агенте.

#### Сценарий 3: Динамическое обновление инструментов (list_changed)

**Предусловия:** MCP-сервер `filesystem` запущен и зарегистрировал 3 tools.

**Шаги:**
1. Администратор MCP-сервера добавляет новый tool `search_files`
2. Сервер отправляет `notifications/tools/list_changed`
3. fan-mcp получает уведомление, debounce 500ms
4. `client.listTools()` → получает обновлённый список (4 tools)
5. Diff: `search_files` — новый → `pi.registerTool(...)`
6. `_refreshToolRegistry()` перестраивает реестр атомарно

**Ожидаемый результат:** Новый tool `mcp__filesystem__search_files` доступен в агенте без перезапуска сессии. Старые tools продолжают работать.

#### Сценарий 4: Permission gate — блокировка опасного tool

**Предусловия:** MCP-сервер `filesystem` зарегистрировал `write_file`. Конфиг: `"deniedTools": ["*write*"]`.

**Шаги:**
1. LLM запрашивает вызов `mcp__filesystem__write_file`
2. `tool_call` event handler в fan-mcp проверяет: tool name совпадает с `deniedTools` glob
3. Handler возвращает `{ block: true, reason: "Tool write_file denied by server policy" }`
4. Agent получает ошибку блокировки вместо вызова

**Ожидаемый результат:** Опасный вызов заблокирован. Сообщение о причине передано модели.

### 2.3 Бизнес-правила

- **BR-01**: MCP tools должны иметь префикс `mcp__<server>__<tool>` для избежания коллизий с built-in tools
- **BR-02**: Если MCP-сервер не отвечает при инициализации, он помечается как `unavailable`, но остальные серверы загружаются
- **BR-03**: Если `allowedTools` пуст или `["*"]` — разрешены все tools сервера
- **BR-04**: Если `deniedTools` содержит glob, совпадающий с tool — tool не регистрируется
- **BR-05**: При падении stdio MCP-сервера все его tools становятся недоступны; авто-перезапуск — опциональный (конфиг `autoRestart: true`)
- **BR-06**: MCP `isError: true` в `CallToolResult` транслируется в `AgentToolResult.isError: true`
- **BR-07**: `structuredContent` из MCP-ответа сохраняется в `AgentToolResult.details.structuredContent`

---

## 3. UI/UX требования

### 3.1 Команды

- **`/mcp status`** — показать статус всех MCP-серверов: connected/unavailable, количество tools, версия, транспорт
- **`/mcp reload`** — перезагрузить конфиг и переподключиться ко всем серверам

### 3.2 Dashboard (Phase 3 — Could Have)

- Карточка статуса MCP-серверов в разделе настроек
- Просмотр списка зарегистрированных MCP tools
- Индикатор подключения (зелёный/красный/жёлтый)

### 3.3 Обработка ошибок

| Ситуация | Поведение |
|----------|-----------|
| MCP сервер не запускается (stdio spawn fail) | Сервер помечается `unavailable`; другие серверы работают. Сообщение в лог. |
| MCP сервер не отвечает на `tools/list` (timeout) | Сервер помечается `unavailable`; retry при следующем `session_start` |
| MCP tool возвращает `isError: true` | Ошибка передаётся как tool result с `isError: true`. Не exception. |
| MCP tool call timeout | `AbortError` → tool result с сообщением о таймауте |
| `mcp.json` содержит невалидный JSON | Файл игнорируется, выводится предупреждение. MCP extension не загружает серверы. |
| Секрет `${ENV_VAR}` не разрешён | Сервер пропускается с предупреждением "Missing env var: ..." |
| MCP сервер крашится во время работы | Все pending вызовы завершаются с ошибкой. Tools удаляются из реестра. |

---

## 4. Нефункциональные требования

### 4.1 Производительность

- **NFR-01**: Инициализация одного MCP-сервера (connect + tools/list) — не более 5 секунд
- **NFR-02**: Время ответа на `tools/call` для локального stdio сервера — не более 100ms оверхед относительно прямого вызова
- **NFR-03**: `tools/list_changed` → обновление реестра — не более 1 секунды после получения уведомления
- **NFR-04**: Поддержка до 10 одновременных MCP-серверов в одном сеансе
- **NFR-05**: Потребление памяти на одного MCP-сервера (без учёта дочернего процесса) — не более 5 MB

### 4.2 Безопасность

- **NFR-06**: MCP-серверы запускаются с `shell: false` — никакой интерпретации shell
- **NFR-07**: Наследование окружения — только безопасные переменные (`PATH`, `HOME`; без функций)
- **NFR-08**: Исполняемые файлы stdio серверов — только из конфига, никогда не из вывода LLM
- **NFR-09**: Секреты — только через `${ENV_VAR}`, не в plaintext в `mcp.json` (предупреждение при коммите)
- **NFR-10**: Валидация URL Streamable HTTP серверов: разрешены только `https://`, запрещены loopback/link-local без явного `allowLocal: true`
- **NFR-11**: MCP tools с `annotations.destructiveHint: true` требуют явного подтверждения через permission gate
- **NFR-12**: `openWorldHint: false` tools от ненадёжных серверов блокируются по умолчанию
- **NFR-13**: Размер ответа MCP tool — максимум 10 MB; превышение обрезается с предупреждением
- **NFR-14**: Логи не содержат секретов — автозамена `${VAR}` на `***`

### 4.3 Надёжность

- **NFR-15**: Падение одного MCP-сервера не влияет на другие серверы и на работу FAN
- **NFR-16**: При падении MCP-сервера все pending tool calls завершаются с `isError: true` в течение 5 секунд
- **NFR-17**: `list_changed` атомарно обновляет реестр — нет состояния «наполовину обновлён»
- **NFR-18**: Graceful shutdown: при `session_shutdown` все stdio процессы получают SIGTERM (2s) → SIGKILL (2s)

### 4.4 Совместимость

- **NFR-19**: Bun (runtime) + Windows/Linux/macOS
- **NFR-20**: Node.js dev mode (jiti extension loader)
- **NFR-21**: MCP SDK `@modelcontextprotocol/sdk` v1.29.0+ (Streamable HTTP + stdio transports)
- **NFR-22**: Совместимость с `--no-extensions` режимом workers — MCP extension не должен ломать worker spawn

---

## 5. Технические требования

### 5.1 Стек технологий

- **Runtime**: Bun (primary), Node.js (dev mode)
- **Язык**: TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.29.0+ (npm, внешняя зависимость extension)
- **Схемы**: TypeBox (`@sinclair/typebox`) — FAN стандарт; JSON Schema — MCP стандарт
- **Транспорты**: `StdioClientTransport`, `StreamableHTTPClientTransport`
- **Распространение**: FAN Store (tar.gz архив) + npm package
- **Core зависимости**: **ноль** — `packages/agent` и `packages/coding-agent` core не импортируют MCP SDK

### 5.2 Архитектура

```
fan-mcp extension (FAN Store package)
├── index.ts              — Extension factory, registerTool(), lifecycle hooks
├── config.ts             — mcp.json loader, global/project merge, env resolution
├── manager.ts            — MCPClientManager: client pool, connect/reconnect
├── adapter.ts            — MCPToolAdapter: JSON Schema→TypeBox, CallToolResult→AgentToolResult
├── transport.ts          — Transport factory (stdio, streamable-http)
├── registry.ts           — Normalized name map (mcp__server__tool), collision detection
├── permissions.ts        — Config allowlist, annotation checks, tool_call gate
└── package.json          — { "fan": { "extensions": ["dist/index.js"] }, "dependencies": { "@modelcontextprotocol/sdk": "^1.29.0" } }

Core changes (packages/coding-agent/src/core/extensions/)
├── types.ts  (+15 lines) — ExtensionAPI.unregisterTool(name), updateTool(name, def)
├── loader.ts (+25 lines) — реализация unregister/update с refreshTools()
└── runner.ts              — без изменений (getAllRegisteredTools уже поддерживает)

Config files
├── ~/.fan/agent/mcp.json  — глобальная конфигурация MCP серверов
└── .fan/mcp.json          — проектная конфигурация (merge, проект выигрывает)
```

### 5.3 Интеграции

#### 5.3.1 Extension API (существующий seam — без изменений)

| Seam | Файл | Использование |
|------|------|---------------|
| `pi.registerTool(ToolDefinition)` | `extensions/types.ts:783` | Регистрация каждого MCP tool как AgentTool |
| `pi.unregisterTool(name)` | `extensions/types.ts` (NEW) | Удаление tool при `list_changed` |
| `pi.updateTool(name, def)` | `extensions/types.ts` (NEW) | Обновление tool при `list_changed` |
| `pi.on("session_start")` | `extensions/types.ts:738` | Подключение к MCP серверам |
| `pi.on("session_shutdown")` | `extensions/types.ts:738` | Отключение, kill stdio процессов |
| `pi.on("tool_call", handler)` | `extensions/types.ts:863` | Permission gate |
| `pi.events` (EventBus) | `extensions/types.ts:859` | Broadcast catalog для orchestrator (Phase 2) |

#### 5.3.2 MCP Protocol Mapping

| MCP | FAN |
|-----|-----|
| `Tool.name` | `mcp__<server>__<tool.name>` (нормализованное) |
| `Tool.description` | `ToolDefinition.description` |
| `Tool.inputSchema` (JSON Schema) | `ToolDefinition.parameters` (TypeBox) — через `jsonSchemaToTypeBox()` |
| `Tool.outputSchema` | `AgentToolResult.details.structuredContent` |
| `tools/call` → `CallToolResult` | `ToolDefinition.execute()` → `AgentToolResult` |
| `CallToolResult.content[]` | `AgentToolResult.content` (TextContent \| ImageContent) |
| `CallToolResult.isError` | `AgentToolResult.isError` |
| `CallToolResult.structuredContent` | `AgentToolResult.details.structuredContent` |
| `notifications/tools/list_changed` | `pi.registerTool/unregisterTool/updateTool` → `_refreshToolRegistry()` |
| `AbortSignal` (FAN) | `RequestOptions.signal` (MCP SDK) |
| `onUpdate` (FAN progress) | `RequestOptions.onprogress` (MCP SDK) |

#### 5.3.3 JSON Schema → TypeBox конвертер

MCP tools используют JSON Schema для `inputSchema`. FAN использует TypeBox. Нужен двунаправленный конвертер:

```typescript
// packages/mcp-extension/src/adapter.ts (концепт)
function jsonSchemaToTypeBox(schema: JsonSchema): TSchema {
  // type: "object" → Type.Object()
  // type: "string" → Type.String()
  // type: "number" → Type.Number()
  // type: "boolean" → Type.Boolean()
  // type: "array" → Type.Array()
  // properties → Type.Object({...})
  // required → пропускается (TypeBox optional по умолчанию)
  // enum → Type.Union([Type.Literal(...)...])
}
```

### 5.4 Модель состояний MCP-сервера

```
[uninitialized] → (connect) → [connecting] → (initialize ok) → [connected]
                                                  ↓ (error)
                                              [unavailable]

[connected] → (list_changed) → [connected] (обновлённый catalog)
[connected] → (crash/timeout) → [unavailable]
[unavailable] → (session_start) → [connecting] → ...
```

---

## 6. Данные

### 6.1 Сущности

#### McpServerConfig
```typescript
interface McpServerConfig {
  transport: "stdio" | "streamable-http";
  // stdio
  command?: string;          // исполняемый файл
  args?: string[];           // аргументы
  env?: Record<string, string>; // переменные окружения (с ${VAR} references)
  // streamable-http
  url?: string;              // URL MCP endpoint
  headers?: Record<string, string>; // HTTP заголовки
  // общие
  allowedTools?: string[];   // glob patterns, ["*"] = все
  deniedTools?: string[];    // glob patterns
  timeout?: number;          // per-call timeout ms (default: 60000)
  autoRestart?: boolean;     // перезапускать при падении (default: false)
  allowLocal?: boolean;      // разрешить loopback/link-local URL (default: false)
}
```

#### McpConfig
```typescript
interface McpConfig {
  servers: Record<string, McpServerConfig>;
}
```

#### McpServerState (runtime)
```typescript
interface McpServerState {
  serverId: string;
  status: "connecting" | "connected" | "unavailable";
  transport: "stdio" | "streamable-http";
  tools: Map<string, NormalizedToolDescriptor>;
  client: Client;                  // MCP SDK Client instance
  transportInstance: Transport;    // StdioClientTransport | StreamableHTTPClientTransport
  connectError?: string;           // последняя ошибка подключения
}
```

### 6.2 Валидация

| Поле | Правило |
|------|---------|
| `transport` | Обязательно. `"stdio"` или `"streamable-http"` |
| `command` | Обязательно для stdio. Абсолютный путь или имя в PATH |
| `args` | Массив строк. Не может содержать `;`, `|`, `&&` |
| `url` | Обязательно для streamable-http. Валидный HTTPS URL (RFC 3986) |
| `allowedTools` | Массив glob patterns. `*` = все |
| `deniedTools` | Массив glob patterns. Пустой = ничего не запрещено |
| `timeout` | Число, 1000–300000 ms |
| `autoRestart` | Булево |
| `allowLocal` | Булево. Если `false` и URL loopback/link-local → ошибка валидации |
| `env` | Ключи — валидные имена переменных. Значения — строки с опциональными `${VAR}` |

---

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| MCP SDK несовместим с Bun (stdio transport) | Средняя | Среднее | Предпочитать Streamable HTTP. CI тесты на Windows/Linux/macOS с Bun. |
| JSON Schema → TypeBox конвертер не покрывает краевые случаи | Средняя | Среднее | Батарея тестов на все типы JSON Schema (oneOf, anyOf, $ref, format). Деградация до `Type.Any()` для неподдерживаемых конструкций с предупреждением. |
| MCP-сервер возвращает tool с именем, конфликтующим с built-in tools | Низкая | Высокое | Префикс `mcp__<server>__` гарантирует изоляцию. Валидация при регистрации: если коллизия — предупреждение, tool пропускается. |
| stdio MCP-сервер зависает при завершении | Средняя | Низкое | SIGTERM → 2s таймаут → SIGKILL. Процесс-группа для рекурсивного kill. |
| `list_changed` прилетает во время активного tool call | Низкая | Низкое | Активный вызов завершается со старым определением. Новый catalog применяется атомарно после завершения. |
| Расширение `fan-mcp` не может быть загружено в Bun binary (MCP SDK не в VIRTUAL_MODULES) | Средняя | Высокое | Поставлять `fan-mcp` как self-contained bundle (esbuild). Документировать ограничение: Bun binary требует предварительной сборки extension. |
| MCP tool возвращает контент неподдерживаемого типа (audio, resource_link) | Низкая | Низкое | Конвертировать в TextContent с `[Unsupported content type: ...]`. Не ронять вызов. |

---

## 8. Компромиссы (Tradeoffs)

### 8.1 Принятые решения

- **Решение**: Extension-owned MCP manager (standalone `fan-mcp` Store package)
- **Альтернатива**: Core-integrated MCP client
- **Обоснование**: Сохраняет атомарность ядра. `packages/agent` — ноль MCP. Core получает только generic `unregisterTool`/`updateTool` (~40 строк). MCP SDK — внешняя зависимость extension. FAN Store распространение.

---

- **Решение**: Coordinator-only MCP в Phase 1. Workers — Should Have (Phase 2)
- **Альтернатива**: Сразу workers с proxy
- **Обоснование**: Phase 1 не требует RPC изменений и даёт 80% ценности (coordinator — основной интерфейс). Worker proxy требует дополнительной проработки RPC channel и тестирования.

---

- **Решение**: `mcp.json` (отдельный файл) вместо `settings.json.mcpServers`
- **Альтернатива**: Расширение `settings.json`
- **Обоснование**: Не загрязняет core Settings тип MCP-специфичными полями. `mcp.json` полностью belongs to extension. Семантика merge — простая: project wins по serverId.

---

- **Решение**: Нормализованные имена tools: `mcp__<server>__<tool>`
- **Альтернатива**: `mcp:<server>:<tool>` (двоеточия)
- **Обоснование**: Двоеточие не принимается некоторыми LLM-провайдерами в именах tools. Двойное подчёркивание — безопасный разделитель.

---

- **Решение**: Оба транспорта (stdio + Streamable HTTP) в Phase 1
- **Альтернатива**: Только Streamable HTTP
- **Обоснование**: Большинство официальных MCP-серверов используют stdio (filesystem, git, postgres, etc.). Streamable HTTP — для удалённых серверов и лучшей Bun-совместимости.

---

- **Решение**: `tool_call` event hook для permission gate
- **Альтернатива**: Обёртка `execute()` с проверками внутри
- **Обоснование**: `tool_call` hook — существующий паттерн в FAN (пример: `permission-gate.ts`). Позволяет централизованно блокировать до вызова, видеть причину блокировки.

---

- **Решение**: Только tools в MVP (не resources/prompts/sampling)
- **Альтернатива**: Полный MCP capabilities с resources и prompts
- **Обоснование**: Tools — 90% ценности MCP. Resources/prompts семантически отличаются от tools и требуют отдельных adapter'ов. Sampling требует trust model и budget integration. Всё это — Phase 3+.

---

## 9. Приоритеты

### Must Have (Обязательно — Phase 1)

- **M-01**: `fan-mcp` extension с регистрацией через FAN Store
- **M-02**: Поддержка stdio transport (StdioClientTransport)
- **M-03**: Поддержка Streamable HTTP transport (StreamableHTTPClientTransport)
- **M-04**: Автоматическое обнаружение tools через `tools/list`
- **M-05**: Выполнение MCP tool с преобразованием результата
- **M-06**: `mcp.json` конфигурация (глобальная + проектная, merge)
- **M-07**: Фильтрация tools: `allowedTools`/`deniedTools`
- **M-08**: Permission gate через `tool_call` event hook
- **M-09**: Отмена вызовов (AbortSignal → MCP cancel)
- **M-10**: Таймауты (per-call и per-server)
- **M-11**: Разрешение секретов через `${ENV_VAR}`
- **M-12**: Graceful shutdown (закрытие соединений, kill stdio процессов)
- **M-13**: `list_changed` с атомарным обновлением реестра
- **M-14**: Core: `unregisterTool`/`updateTool` на ExtensionAPI
- **M-15**: Обработка ошибок: unavailable сервер, timeout, crash, невалидный конфиг

### Should Have (Желательно — Phase 2)

- **S-01**: Worker proxy — доступ workers к MCP tools через protocol-neutral RPC
- **S-02**: Core: generic `remote_tool_request`/`response`/`cancel`/`catalog` в RPC types
- **S-03**: Core: generic correlation map в `rpc-mode.ts`
- **S-04**: Core: `lastEvent` cache в EventBus для replay-on-subscribe
- **S-05**: Orchestrator: remote_tool_request handler в subagent-runner
- **S-06**: Per-worker profile filtering (explore — read-only, implement — all)
- **S-07**: Команда `/mcp status` и `/mcp reload`

### Could Have (Возможно — Phase 3)

- **C-01**: Progress forwarding (MCP progress → `onUpdate`)
- **C-02**: `structuredContent` в `AgentToolResult.details`
- **C-03**: OAuth support для Streamable HTTP серверов
- **C-04**: Resource/prompt adapters (отдельно от tools)
- **C-05**: Авто-перезапуск упавших stdio серверов
- **C-06**: Dashboard: карточка статуса MCP-серверов
- **C-07**: Логирование/метрики вызовов MCP tools

### Won't Have (Не входит)

- **W-01**: Sampling (MCP-сервер запрашивает LLM вызов) — требует trust model, default-deny
- **W-02**: Roots (MCP-сервер запрашивает файловые корни) — ограничивается project root
- **W-03**: Elicitation (form/URL от MCP-сервера) — требует UI integration
- **W-04**: MCP server mode (FAN как MCP сервер) — отдельная фича
- **W-05**: WebSocket транспорт (не входит в MCP спецификацию)
- **W-06**: Легаси SSE транспорт (deprecated в MCP spec)

---

## 10. Следующие шаги

### Phase 1 — Coordinator-only MCP (2-3 недели)

- [ ] **1.1** Core: добавить `unregisterTool`/`updateTool` в `extensions/types.ts` и `loader.ts`
- [ ] **1.2** Core: написать тесты на `unregisterTool`/`updateTool` + `refreshTools`
- [ ] **1.3** Создать пакет `packages/mcp-extension/` (или отдельный репо для FAN Store)
- [ ] **1.4** `config.ts` — загрузчик `mcp.json`, merge, валидация, `${ENV}` resolution
- [ ] **1.5** `manager.ts` — MCPClientManager: пул клиентов, connect/disconnect, reconnect
- [ ] **1.6** `transport.ts` — фабрика транспортов (StdioClientTransport, StreamableHTTPClientTransport)
- [ ] **1.7** `adapter.ts` — JSON Schema → TypeBox конвертер, CallToolResult → AgentToolResult
- [ ] **1.8** `registry.ts` — нормализация имён (`mcp__server__tool`), карта server+tool
- [ ] **1.9** `permissions.ts` — `allowedTools`/`deniedTools` glob matching, `tool_call` hook
- [ ] **1.10** `index.ts` — extension factory: lifecycle hooks, registerTool, list_changed
- [ ] **1.11** Интеграционные тесты: stdio connect, streamable-http connect, tool call round-trip
- [ ] **1.12** Интеграционные тесты: list_changed atomic update, permission gate
- [ ] **1.13** Интеграционные тесты: error handling (spawn fail, timeout, crash, invalid config)
- [ ] **1.14** CI: Bun + Windows/Linux/macOS
- [ ] **1.15** `SKILL.md` для FAN Store
- [ ] **1.16** Сборка и публикация в FAN Store: `fan store install fan-mcp`
- [ ] **1.17** Документация: README с примерами конфигурации

### Phase 2 — Worker Proxy (2-3 недели, Should Have)

- [ ] **2.1** Core: `remote_tool_request`/`response`/`cancel`/`catalog` в `rpc-types.ts`
- [ ] **2.2** Core: generic correlation map в `rpc-mode.ts` (по образцу `pendingExtensionRequests`)
- [ ] **2.3** Core: `lastEvent` cache в `event-bus.ts`
- [ ] **2.4** Orchestrator: `remote_tool_request` handler в `subagent-runner.js`
- [ ] **2.5** Orchestrator: broker-handler с EventBus подпиской на `"mcp:catalog"`
- [ ] **2.6** Orchestrator: per-worker profile filtering + `--remote-tools` флаг
- [ ] **2.7** Core: `RemoteProxyTool` регистрация в worker rpc-mode из каталога
- [ ] **2.8** Интеграционные тесты: worker → proxy → MCP round-trip
- [ ] **2.9** Интеграционные тесты: cancel, concurrent workers, reconnection

### Phase 3 — Polish (1-2 недели, Could Have)

- [ ] **3.1** Progress forwarding
- [ ] **3.2** `structuredContent` preservation
- [ ] **3.3** OAuth support
- [ ] **3.4** Auto-restart упавших серверов
- [ ] **3.5** `/mcp status` и `/mcp reload` команды
- [ ] **3.6** Dashboard: MCP server status card

---

## Приложение A: TDD/Verification Matrix (Phase 1)

| # | Тест | Тип | Платформа | Критерий |
|---|------|-----|-----------|----------|
| T1 | StdioClientTransport: spawn → connect → initialize | Integration | All | Client state = "connected", serverInfo получен |
| T2 | StreamableHTTPClientTransport: POST initialize → sessionId | Integration | All | sessionId в заголовках, serverInfo валиден |
| T3 | tools/list → registerTool → AgentTool в реестре | Integration | All | tools зарегистрированы с именами mcp__server__tool |
| T4 | tools/call → AgentTool.execute → AgentToolResult | Integration | All | content маппится корректно (text, image) |
| T5 | MCP isError:true → AgentToolResult.isError:true | Unit | All | ошибка не exception, а результат |
| T6 | list_changed → unregisterTool/updateTool → refreshTools | Integration | All | старые tools удалены, новые добавлены |
| T7 | JSON Schema → TypeBox: object, string, number, boolean, array, enum | Unit | All | все типы конвертируются без потерь |
| T8 | JSON Schema → TypeBox: $ref, oneOf, anyOf → Type.Any() fallback | Unit | All | неподдерживаемые → Type.Any() + warning |
| T9 | mcp.json global/project merge | Unit | All | project переопределяет глобальный по serverId |
| T10 | ${ENV_VAR} resolution | Unit | All | переменные разрешены, missing → warning |
| T11 | allowedTools glob matching | Unit | All | "*" = все, "read_*" = префикс, "write_file" = точное |
| T12 | deniedTools glob blocking | Unit | All | совпадающие tools не регистрируются |
| T13 | tool_call hook: block destructive tool | Integration | All | вызов заблокирован, причина возвращена |
| T14 | AbortSignal → MCP cancel | Integration | All | вызов отменён, AbortError |
| T15 | timeout → tool error | Integration | All | превышение таймаута → isError:true |
| T16 | stdio spawn fail → server unavailable | Integration | All | сервер помечен unavailable, другие работают |
| T17 | stdio crash mid-session → tools removed | Integration | All | pending calls завершены с ошибкой |
| T18 | session_shutdown → graceful close + kill | Integration | All | все клиенты закрыты, процессы убиты |
| T19 | невалидный mcp.json → graceful skip + warning | Unit | All | extension загружен, серверы пропущены |
| T20 | 10 одновременных MCP серверов | Stress | All | все подключаются, tools регистрируются |

---

## Приложение B: Core changes — точные файлы и строки

| # | Файл | Строки | Изменение |
|---|------|--------|-----------|
| 1 | `packages/coding-agent/src/core/extensions/types.ts` | ~1060 | `unregisterTool(name: string): void`, `updateTool(name: string, tool: ToolDefinition): void` в интерфейс `ExtensionAPI` |
| 2 | `packages/coding-agent/src/core/extensions/loader.ts` | ~137 | Реализация: `extension.tools.delete(name)` + `runtime.refreshTools()` для unregister; `extension.tools.set(name, ...)` + `runtime.refreshTools()` для update |
| 3 | `packages/coding-agent/src/core/extensions/runner.ts` | ~375 | Без изменений. `getAllRegisteredTools()` уже итерирует extension.tools Map — updateTool перезаписывает значение в Map, автоматически подхватывается. |

**Всего: ~40 строк. Zero MCP SDK imports.**

---

## Приложение C: Конфигурация mcp.json — полный пример

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "allowedTools": ["read_file", "list_directory", "search_files"],
      "deniedTools": ["write_file", "delete_file"],
      "timeout": 60000
    },
    "github": {
      "transport": "streamable-http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}",
        "User-Agent": "fan-mcp/1.0"
      },
      "allowedTools": ["*"],
      "timeout": 30000,
      "allowLocal": false
    },
    "postgres": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"],
      "allowedTools": ["query"],
      "deniedTools": [],
      "autoRestart": true,
      "timeout": 120000
    }
  }
}
```

---

*Создано: research-spec-generator skill*
*Исходный запрос: "Внедрить MCP протокол для подключения сторонних MCP серверов с сохранением атомарности ядра и архитектуры лёгких воркеров"*
*Источники: `.fan/reports/code-research-mcp-sdk.md`, `code-research-fan-runtime-mcp.md`, `code-research-fan-extension-mcp.md`, `explore-duplex-rpc.md`, `architecture-mcp-integration.md`*
