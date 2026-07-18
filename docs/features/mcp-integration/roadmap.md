# Roadmap: Интеграция MCP (Model Context Protocol) в FAN

> **Дата генерации:** 2026-07-16
> **Источник:** `docs/specs/spec_mcp-integration_2026-07-16.md`
> **Версия SKILL:** 1.1.0
> **Функций / Этапов:** 32 / 3 (лимит: 15 / 8)

> ⚠️ **Предупреждения**:
> - **Превышен лимит функций (>15):** обнаружено 32 функции (лимит 15 на roadmap). Продолжено с явного согласия пользователя (`all 3 фазы с предупреждением`). Рассмотреть разбиение на 3 дочерние roadmap при следующей итерации.

---

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 32 |
| Этапов | 3 (Phase 1, 2, 3) |
| P0 (Must Have) | 18 |
| P1 (Should Have) | 7 |
| P2 (Could Have) | 7 |

## Легенда

- ✅ — Реализовано
- ☐ — Запланировано
- ⏳ — В работе
- ❌ — Заблокировано

### Приоритеты
- **P0** — Критично (без этого фича не имеет смысла)
- **P1** — Высокий (важно для большинства пользователей)
- **P2** — Средний (полезно, но не срочно)
- **P3** — Низкий (future enhancement)

### Слои архитектуры
- **[API]** — Core seam / RPC / middleware
- **[CLI]** — Команда / packaging / установка
- **[INTEG]** — Интеграция с внешним сервисом (MCP protocol)
- **[DATA]** — Модель / схема / конфиг
- **[BIZ]** — Бизнес-правило / процесс

---

# Phase 1: Координатор-only MVP (Coordinator-only MCP)

**Цель:** Доставить MCP-расширение для основного агента (coordinator). Пользователь подключает внешние MCP-серверы через `mcp.json` и вызывает их инструменты как обычные FAN-инструменты. Worker agents — без MCP. Core получает generic `unregisterTool`/`updateTool`. **Критерий завершения:** все 20 TDD-интеграционных тестов зелёные на Windows/Linux/macOS с Bun, `fan store install fan-mcp` работает.

**Приоритет функций:** P0 (Must Have)

---

## Core seam

#### ✅ F-1.1 [API]: Core: unregisterTool на ExtensionAPI
- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Добавить метод `unregisterTool(name: string): void` в интерфейс `ExtensionAPI` (`packages/coding-agent/src/core/extensions/types.ts`). При вызове: удаляет tool из `extension.tools` Map + дёргает `runtime.refreshTools()` для атомарной перестройки `_toolRegistry` в `AgentSession`. Требуется для удаления MCP tools при `list_changed` / crash / graceful shutdown.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F1.1-1:** `unregisterTool` удаляет tool из `_toolRegistry`
    - *Условие:* extension зарегистрировало два tool через `registerTool`; `AgentSession._toolRegistry` имеет обе записи
    - *Шаги:* вызвать `fan.unregisterTool("firstTool")`
    - *Ожидаемый результат:* `getToolDefinition("firstTool")` возвращает `undefined`; `getToolDefinition("secondTool")` возвращает дефиницию
- **Критерии приёмки:**
  1. В `extensions/types.ts` интерфейс `ExtensionAPI` содержит метод `unregisterTool(name: string): void`
  2. `extensions/loader.ts` реализует: `extension.tools.delete(name)`, `if (runtime?.refreshTools) runtime.refreshTools()`
  3. Unit-тест проходит: `unregisterTool` уменьшает размер `extension.tools` и удаляет из `_toolRegistry`
- **Ожидаемый результат:** +15 строк в `extensions/types.ts`, +15 строк в `extensions/loader.ts`, новый unit-тест
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-1.2 [API]: Core: updateTool на ExtensionAPI
- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Добавить метод `updateTool(name: string, tool: ToolDefinition): void` в `ExtensionAPI`. Аналогично `registerTool`, но перезаписывает существующую запись в `extension.tools` Map + вызывает `runtime.refreshTools()`. Используется при `list_changed` для обновления схемы/описания существующих MCP tools.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F1.2-1:** `updateTool` заменяет дефиницию существующего tool
    - *Условие:* tool `read_file` зарегистрирован с `description = "old"`; новая дефиниция имеет `description = "new"`
    - *Шаги:* вызвать `fan.updateTool("read_file", newDef)`
    - *Ожидаемый результат:* `getToolDefinition("read_file").description === "new"`
  - [ ] **TC-F1.2-2:** `updateTool` создаёт tool, если его не было
    - *Условие:* tool `read_file` не зарегистрирован
    - *Шаги:* вызвать `fan.updateTool("read_file", newDef)`
    - *Ожидаемый результат:* tool зарегистрирован, как при `registerTool`
- **Критерии приёмки:**
  1. Метод `updateTool(name: string, tool: ToolDefinition): void` добавлен в `ExtensionAPI`
  2. Реализация в `loader.ts`: `extension.tools.set(name, { definition: tool, sourceInfo })` + `runtime.refreshTools()`
  3. Unit-тесты: обновление существующего tool и создание нового через `updateTool`
- **Ожидаемый результат:** +10 строк в `extensions/types.ts`, +10 строк в `extensions/loader.ts`
- **Оценка объёма:** S (≤ 4ч)

---

## Packaging & lifecycle

#### ✅ F-1.3 [CLI]: FAN Store extension packaging
- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** Создать пакет `packages/mcp-extension/` (или external repo) с манифестом `package.json`, где `"fan":{"extensions":["dist/index.js"]}`. Extension factory экспортируется как default — `createMcpExtension(fan: ExtensionAPI)`. Обеспечить компилируемость через tsgo в Bun-compatible bundle. Подготовить tar.gz для FAN Store.
- **Зависимости:** F-1.1, F-1.2 (использует refresh через эти методы)
- **TDD-тесты:**
  - [ ] **TC-F1.3-1:** Extension loading: framework загружает `fan-mcp` через jiti
    - *Условие:* extension развёрнут в `~/.fan/agent/extensions/fan-mcp/` с манифестом
    - *Шаги:* запустить FAN, framework загружает extension
    - *Ожидаемый результат:* `fan.on("session_start", ...)` зарегистрирован; инструменты появляются после подключения к серверам
- **Критерии приёмки:**
  1. `packages/mcp-extension/package.json` имеет валидный `fan` манифест
  2. Extension компилируется через `tsgo` без ошибок
  3. `fan store install fan-mcp` разворачивает пакет в `~/.fan/agent/extensions/fan-mcp/`
  4. Extension автоматически загружается при старте FAN (виден через `fan store list`)
- **Ожидаемый результат:** структура директорий `packages/mcp-extension/`, tar.gz в `release/`
- **Оценка объёма:** M (≤ 1 день)

---

## Transports

#### ☐ F-1.4 [INTEG]: StdioClientTransport integration
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Реализовать `transport.ts` — фабрика, создающая `StdioClientTransport` из `McpServerConfig` (с полями `command`, `args`, `env`, `inheritEnv`). Использовать официальный SDK `@modelcontextprotocol/sdk`. Применить `shell: false`, минимальный env whitelist, `windowsHide: true`. Обработка process lifecycle (PID tracking, stderr capture).
- **Зависимости:** F-1.3
- **TDD-тесты:**
  - [ ] **TC-F1.4-1:** Stdio transport: spawn фиктивного MCP-сервера через `node mcp-fixture.js`
    - *Условие:* local fixture (echo server) в `test/fixtures/`
    - *Шаги:* создать транспорт через фабрику; `await transport.start()`
    - *Ожидаемый результат:* транспорт имеет `pid != null`, stdin/stdout writable/readable, ready для JSON-RPC
- **Критерии приёмки:**
  1. `createTransport(config): Transport` создаёт `StdioClientTransport` с `shell: false`
  2. `command` разрешается через PATH или абсолютный путь; `args` массивом передаётся напрямую
  3. Минимальный env whitelist: `PATH`, `HOME`, `LANG`, `LC_ALL` (без функций)
  4. CI: интеграционный тест на Windows/Linux/macOS проходит за < 5s setup
- **Ожидаемый результат:** `packages/mcp-extension/src/transport.ts` — функция `createStdioTransport(config)` + 3 unit-теста
- **Оценка объёма:** M (≤ 1 день)

#### ☐ F-1.5 [INTEG]: StreamableHTTPClientTransport integration
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Реализовать фабрику `createHttpTransport(config)` — создаёт `StreamableHTTPClientTransport` из `McpServerConfig` (поля `url`, `headers`). Резолвить `${ENV}` в `headers`. Валидация URL (только `https://`, `allowLocal: true` требуется для loopback). Не возвращать транспорт для невалидной конфигурации.
- **Зависимости:** F-1.3, F-1.11 (для `${ENV}` resolution)
- **TDD-тесты:**
  - [ ] **TC-F1.5-1:** HTTP transport: POST initialize к локальному mock-серверу
    - *Условие:* мок-сервер поднимается через `http.createServer` на `127.0.0.1` (с `allowLocal: true`)
    - *Шаги:* создать транспорт; `await transport.start()`
    - *Ожидаемый результат:* POST `/mcp` отправлен с `initialize` JSON-RPC; `Mcp-Session-Id` header получен
  - [ ] **TC-F1.5-2:** Валидация URL: `http://` запрещён без `allowLocal`
    - *Шаги:* создать конфиг с `url: "http://example.com/mcp"`, `allowLocal: false`
    - *Ожидаемый результат:* `createHttpTransport` бросает `ValidationError`
- **Критерии приёмки:**
  1. `createHttpTransport(config)` создаёт `StreamableHTTPClientTransport` с переданными `headers`
  2. URL валидируется: scheme `https://` обязателен (или `allowLocal: true`); throw `ValidationError` для невалидного
  3. `${VAR}` в `headers` резолвятся через env на момент `start()`
  4. CI: интеграционный тест на Bun + macOS/Linux (Windows: пропуск)
- **Ожидаемый результат:** `transport.ts` — функция `createHttpTransport(config)` + 3 unit-теста + 1 integration
- **Оценка объёма:** M (≤ 1 день)

---

## Tools API

#### ✅ F-1.6 [INTEG]: tools/list discovery и ToolDefinition mapping
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** В `adapter.ts` реализовать `mcpToolToDefinition(serverId, mcpTool, client): ToolDefinition`. Преобразует JSON Schema `inputSchema` → TypeBox через `jsonSchemaToTypeBox()` (с graceful fallback на `Type.Any()` для неподдерживаемых конструкций). Имя `mcpTool.name` нормализуется как `mcp__<serverId>__<mcpTool.name>`. Description — через `mcpTool.description`. `execute()` вызывает `client.callTool({name, arguments: parsedArgs}, undefined, {signal})` с AbortSignal. Результат маппится в `AgentToolResult`.
- **Зависимости:** F-1.4, F-1.5, F-1.11
- **TDD-тесты:**
  - [ ] **TC-F1.6-1:** `tools/list` → `registerTool`: 3 tools с разными схемами
    - *Условие:* mock MCP-сервер возвращает 3 tool: `read_file` (object props), `search` (string enum), `query` (nested object)
    - *Шаги:* открыть клиент → `listTools()` → для каждого вызвать `mcpToolToDefinition("fs", tool, client)` → `fan.registerTool(def)`
    - *Ожидаемый результат:* 3 tool в `_toolRegistry` с именами `mcp__fs__read_file` и т.д.; TypeBox schema валидна (параметры парсятся по схеме)
  - [ ] **TC-F1.6-2:** Неподдерживаемая JSON Schema ($ref) → `Type.Any()` + warning
    - *Условие:* tool с `inputSchema: {$ref: "..."}` (без поддержки в конвертере)
    - *Шаги:* `mcpToolToDefinition(...)` 
    - *Ожидаемый результат:* параметры = `Type.Any()`; warning в лог `"Unsupported schema construct: $ref"`
- **Критерии приёмки:**
  1. 7 основных JSON Schema типов корректно мапятся в TypeBox: object, string, number, boolean, array, enum, nested
  2. Неподдерживаемые ($ref, oneOf, anyOf) → `Type.Any()` с warning в console.warn
  3. Имя всегда `mcp__<serverId>__<toolName>` (regex валидация)
  4. CI: 10 unit-тестов + 1 integration проходят за < 2s
- **Ожидаемый результат:** `adapter.ts` — `mcpToolToDefinition()` + `jsonSchemaToTypeBox()`; ≥ 10 unit-тестов
- **Оценка объёма:** L (≤ 2 дня)

#### ✅ F-1.7 [INTEG]: tools/call execution и result mapping
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Реализовать `executeMcpCall(client, toolName, args, signal): Promise<AgentToolResult>` — вызывает `client.callTool()`, маппит `CallToolResult.content[]` в `AgentToolResult.content`. Поддержать text/image content. `CallToolResult.isError` → `AgentToolResult.isError`. `structuredContent` → `details.structuredContent`. Неподдерживаемые типы контента (audio, resource_link) → text fallback.
- **Зависимости:** F-1.6
- **TDD-тесты:**
  - [ ] **TC-F1.7-1:** Text content → `AgentToolResult.content = [{type:"text", text:"..."}]`
    - *Условие:* mock возвращает `CallToolResult { content: [{type:"text", text:"hello"}], isError: false }`
    - *Шаги:* `executeMcpCall(...)`
    - *Ожидаемый результат:* result.content содержит `{type:"text", text:"hello"}`; `isError` undefined
  - [ ] **TC-F1.7-2:** `isError:true` → `result.isError = true`, не exception
    - *Условие:* mock возвращает `{ content: [...], isError: true }`
    - *Шаги:* `executeMcpCall(...)`
    - *Ожидаемый результат:* функция НЕ throw'ит, возвращает result с `isError:true`
  - [ ] **TC-F1.7-3:** Image content (base64) → `{type:"image", mimeType, data}` 
    - *Шаги:* mock возвращает `image/png` base64 content
    - *Ожидаемый результат:* content содержит `{type:"image", mimeType:"image/png", data:"<base64>"}`
- **Критерии приёмки:**
  1. Text/Image content мапятся 1:1 в FAN `AgentToolResult.content`
  2. `isError:true` → `result.isError = true`, без throw
  3. `structuredContent` сохраняется в `result.details.structuredContent`
  4. Audio/resource_link → text fallback `"[Unsupported content type: <type>]"`
- **Ожидаемый результат:** `adapter.ts` — `executeMcpCall()` + 5 unit-тестов + 1 integration
- **Оценка объёма:** M (≤ 1 день)

---

## Configuration

#### ✅ F-1.8 (commit 2043d41) [DATA]: mcp.json loader и global/project merge
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Реализовать `loadMcpConfig(cwd: string): Promise<McpConfig>` — читает global `~/.fan/agent/mcp.json` и project `${cwd}/.fan/mcp.json`, мерджит по `serverId` (project выигрывает для primitive полей, deep merge для объектов). Валидация схемы через TypeBox-валидатор. Если оба файла отсутствуют — пустой конфиг. Если невалидный JSON — warning + пропуск файла.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F1.8-1:** Только global — возвращает его без изменений
    - *Условие:* `~/.fan/agent/mcp.json` с одним сервером; project файл отсутствует
    - *Шаги:* `loadMcpConfig(cwd)`
    * *Ожидаемый результат:* config содержит сервер из global
  - [ ] **TC-F1.8-2:** Project overrides global по serverId
    - *Условие:* global имеет `filesystem.transport="stdio"`, project — `filesystem.timeout=30000`
    - *Шаги:* `loadMcpConfig(cwd)`
    - *Ожидаемый результат:* `filesystem` сервер имеет оба поля: `transport: "stdio"` (от global), `timeout: 30000` (от project)
- **Критерии приёмки:**
  1. `loadMcpConfig` корректно мерджит два JSON файла (deep merge, project wins)
  2. Отсутствие одного из файлов → не ошибка, продолжает с тем, что есть
  3. Невалидный JSON → console.warn + использование второго файла
  4. TypeBox-валидатор отклоняет конфиг без `transport` или с невалидным URL
- **Ожидаемый результат:** `config.ts` — функция `loadMcpConfig()` + 4 unit-теста
- **Оценка объёма:** M (≤ 1 день)

#### ✅ F-1.9 [BIZ]: allowedTools/deniedTools filtering
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** В `permissions.ts` реализовать `filterTools(tools, config): FilteredTools` — применяет glob patterns `allowedTools`/`deniedTools` к нормализованным именам (`mcp__server__tool`). `["*"]` = все. `deniedTools` имеет приоритет над `allowedTools`. Используется при `tools/list` для фильтрации до `registerTool()`.
- **Зависимости:** F-1.8
- **TDD-тесты:**
  - [ ] **TC-F1.9-1:** `["*"]` → все tools проходят фильтр
  - [ ] **TC-F1.9-2:** `"read_*"` glob → только tools с префиксом `read_`
  - [ ] **TC-F1.9-3:** `deniedTools: ["write_file"]` → этот tool отфильтрован, остальные — нет
- **Критерии приёмки:**
  1. `filterTools` использует `micromatch` или эквивалент для glob matching
  2. `deniedTools` имеет приоритет над `allowedTools`
  3. Empty `allowedTools` (отсутствует поле) = все разрешены; empty `deniedTools` = ничего не запрещено
  4. Тесты покрывают: exact match, prefix glob, suffix glob, отрицание через deniedTools
- **Ожидаемый результат:** `permissions.ts` — `filterTools()` + 5 unit-тестов
- **Оценка объёма:** S (≤ 4ч)

---

## Permissions & cancel

#### ✅ F-1.10 (commit 666c5f4) [BIZ]: tool_call permission gate
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** В extension factory зарегистрировать `fan.on("tool_call", handler)`. Handler проверяет: если `toolName` соответствует `mcp__<serverId>__<tool>` и в runtime config `permissions.serverId.deny` есть этот tool — вернуть `{block: true, reason: "..."}`. Иначе — ничего. Использовать существующий паттерн из `permission-gate.ts`.
- **Зависимости:** F-1.9
- **TDD-тесты:**
  - [ ] **TC-F1.10-1:** Permission gate блокирует `mcp__fs__delete_file`
    - *Условие:* config `filesystem.deniedTools: ["delete_file"]`
    - *Шаги:* LLM вызывает `mcp__fs__delete_file`; handler срабатывает
    - *Ожидаемый результат:* handler возвращает `{block: true, reason: "Tool delete_file denied by server policy"}`; LLM получает ошибку
- **Критерии приёмки:**
  1. `fan.on("tool_call", ...)` handler зарегистрирован при init extension
  2. Handler проверяет `toolName.startsWith("mcp__")` и парсит serverId/toolName
  3. Block возвращает `{block: true, reason: string}`, инструмент НЕ выполняется
  4. Тест: `tc-F1.10-1` + 1 негативный тест (разрешённый tool проходит)
- **Ожидаемый результат:** handler в `index.ts` + 2 unit/integration-теста
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-1.11 [DATA]: ${ENV_VAR} resolution в mcp.json
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Реализовать `resolveEnvVars(value: string, env: NodeJS.ProcessEnv): string` — заменяет `${VAR}` на значение из `env`. Если `VAR` не существует — throw `MissingEnvVarError(name)`. Возвращает строку с разрешёнными переменными. Использовать regex `/\$\{([A-Z_][A-Z0-9_]*)\}/g`.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F1.11-1:** Один secret — резолвится
    - *Шаги:* `resolveEnvVars("Bearer ${GITHUB_TOKEN}", {GITHUB_TOKEN: "abc"})`
    - *Ожидаемый результат:* `"Bearer abc"`
  - [ ] **TC-F1.11-2:** Отсутствующий env → `MissingEnvVarError("GITHUB_TOKEN")`
  - [ ] **TC-F1.11-3:** Вложенные конструкции — `${A}_${B}` → `"foo_bar"`
- **Критерии приёмки:**
  1. Переменные вида `${NAME}` (uppercase, underscore) корректно резолвятся
  2. Missing variable → exception `MissingEnvVarError` с именем переменной
  3. Использовать `NodeJS.ProcessEnv` (с возможностью передать мок для тестов)
  4. Тесты покрывают: single, multiple, missing, no-placeholder
- **Ожидаемый результат:** `config.ts` — `resolveEnvVars()` + 4 unit-теста
- **Оценка объёма:** S (≤ 4ч)

---

## Reliability

#### ✅ F-1.12 (commit d4a233b) [INTEG]: AbortSignal → MCP cancel propagation
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** В `execute()` MCP ToolDefinition: при получении FAN `signal` — прерывать in-flight `client.callTool({...}, undefined, { signal })`. MCP SDK прокидывает cancellation в сервер. Если tool вызван с уже aborted signal → бросить `AbortError` немедленно.
- **Зависимости:** F-1.7
- **TDD-тесты:**
  - [ ] **TC-F1.12-1:** Отмена in-flight call при `abortController.abort()`
    - *Условие:* mock MCP-сервер делает sleep 5s на tool call
    - *Шаги:* запустить call; через 1s вызвать `abortController.abort()`
    - *Ожидаемый результат:* `execute()` бросает `AbortError` за < 2s; сервер получает `notifications/cancelled`
- **Критерии приёмки:**
  1. `execute()` принимает `signal: AbortSignal` (5-й параметр)
  2. MCP `callTool` вызывается с `{ signal }` в RequestOptions
  3. AbortController.abort() → `execute()` бросает `AbortError` в течение 1s
  4. Integration тест: реальный MCP mock + AbortController
- **Ожидаемый результат:** обёртка `execute()` + 1 integration тест
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-1.13 (commit abb5959) [BIZ]: Per-call и per-server timeouts
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Реализовать обёртку `withTimeout(promise, ms, signal): Promise<T>` — race между promise, setTimeout-reject и signal. Применить к `client.callTool()` с `config.timeout ?? 60000`. Возвращать tool error, не throw exception.
- **Зависимости:** F-1.7, F-1.12
- **TDD-тесты:**
  - [ ] **TC-F1.13-1:** Таймаут 100ms на 5-секундный tool → `result.isError = true`
    - *Условие:* mock MCP отвечает через 5s; `config.timeout = 100`
    - *Шаги:* `executeMcpCall(...)`
    - *Ожидаемый результат:* возврат через 100-200ms с `isError:true, details.message:"timeout"`
- **Критерии приёмки:**
  1. `withTimeout` оборачивает `client.callTool()` с настраиваемым таймаутом
  2. Default: 60s (если `config.timeout` не указан)
  3. Таймаут возвращает `result.isError = true`, не exception
  4. Тесты: timeout, успех до таймаута, отмена через signal при таймауте
- **Ожидаемый результат:** утилита `withTimeout()` в `adapter.ts` + 3 unit-теста
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-1.14 (commit 2f464db) [BIZ]: Graceful shutdown с cleanup stdio процессов
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** В `fan.on("session_shutdown")` handler: для каждого stdio MCP-сервера — закрыть `client`, дёрнуть `transport.close()`. StdioClientTransport делает graceful shutdown (stdin.end → SIGTERM через 2s → SIGKILL через 2s). Дождаться завершения всех cleanup-тасков в течение 5s (не больше).
- **Зависимости:** F-1.4, F-1.5
- **TDD-тесты:**
  - [ ] **TC-F1.14-1:** Stdio процесс корректно завершается на shutdown
    - *Условие:* stdio MCP процесс запущен; есть активный tool call
    - *Шаги:* вызвать `fan.emit("session_shutdown")`; дождаться завершения cleanup
    - *Ожидаемый результат:* child process PID больше не в `ps`; client.close() вернул true; весь cleanup за < 5s
- **Критерии приёмки:**
  1. `fan.on("session_shutdown")` handler делает `client.close()` для всех серверов
  2. Stdio процесс получает SIGTERM (через 2s — SIGKILL)
  3. Cleanup не превышает 5s total (иначе warning в лог)
  4. Активные pending tool calls получают ошибку до завершения cleanup
- **Ожидаемый результат:** handler в `index.ts` + 1 integration тест
- **Оценка объёма:** M (≤ 1 день)

---

## Dynamic updates

#### ✅ F-1.15 (commit 3a1811c) [INTEG]: list_changed atomic catalog refresh
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Подписаться на `notifications/tools/list_changed` в MCP `Client`. При получении: debounce 500ms (множественные уведомления от сервера склеиваются), затем `client.listTools()` заново, diff со старым, для каждого изменения — `registerTool/unregisterTool/updateTool` через API из F-1.1/F-1.2. Атомарность: `_refreshToolRegistry` перестраивает registry за один проход.
- **Зависимости:** F-1.1, F-1.2, F-1.6
- **TDD-тесты:**
  - [ ] **TC-F1.15-1:** Добавление нового tool → `mcp__fs__new_tool` появляется в registry
    - *Условие:* mock MCP отправляет `tools/list_changed`; повторный listTools возвращает +1 tool
    - *Шаги:* подождать debounce 500ms; запустить LLM сценарий, использующий новый tool
    - *Ожидаемый результат:* новый tool доступен без перезапуска сессии
  - [ ] **TC-F1.15-2:** Удаление tool → `unregisterTool` отрабатывает
  - [ ] **TC-F1.15-3:** Параллельные notifications → debounce склеивает в один refresh
- **Критерии приёмки:**
  1. Подписка на `notifications/tools/list_changed` зарегистрирована при `client.connect()`
  2. Debounce 500ms перед повторным `listTools`
  3. Diff вычисляется по `serverId + toolName`
  4. Активные in-flight tool calls НЕ прерываются (используют старую дефиницию)
- **Ожидаемый результат:** handler в `manager.ts` + 3 unit/integration-теста
- **Оценка объёма:** M (≤ 1 день)

---

## Error handling

#### ✅ F-1.16 (commit 2f464db) [BIZ]: Graceful unavailable server (spawn fail / timeout на initialize)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Если `client.connect()` бросает (spawn fail, timeout 5s на initialize) — сервер помечается как `unavailable` с `connectError`. Остальные серверы продолжают подключаться. Флаг `unavailable` → tools не регистрируются; `/mcp status` показывает статус.
- **Зависимости:** F-1.4, F-1.5
- **TDD-тесты:**
  - [ ] **TC-F1.16-1:** Spawn fail (бинарник не найден) → server `unavailable`, другие продолжают
    - *Условие:* конфиг с `command: "nonexistent-binary"`
    - *Шаги:* `loadMcpConfig` + connect all servers
    - *Ожидаемый результат:* server помечен `unavailable`; второй сервер в конфиге подключён нормально
- **Критерии приёмки:**
  1. `unavailable` servers не регистрируют tools (как будто их нет в config)
  2. Other servers работают; FAN не падает
  3. `connectError` сохраняется для отображения в `/mcp status`
  4. Retry: при следующем `session_start` будет попытка переподключения
- **Ожидаемый результат:** error handling в `manager.ts` + 2 unit/integration-теста
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-1.17 (commit 2f464db) [BIZ]: stdio server crash → tools removed
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** При обнаружении `client.transport.onclose` или `stderr` указывающего на crash — пометить сервер `unavailable`, дёрнуть `unregisterTool` для всех его tools (через F-1.1). Pending in-flight calls получают `isError:true` через signal abort.
- **Зависимости:** F-1.1, F-1.16
- **TDD-тесты:**
  - [ ] **TC-F1.17-1:** Crash stdio процесса → все tools этого сервера удалены из registry
    - *Условие:* mock stdio процесс; `kill -9 $pid` после connect
    - *Шаги:* дождаться `transport.onclose`
    - *Ожидаемый результат:* `getToolDefinition("mcp__fs__read_file")` возвращает `undefined` через 1s
- **Критерии приёмки:**
  1. `client.transport.onclose` handler вызывает `unregisterTool` для всех tools сервера
  2. Pending calls завершаются с `isError:true` через `abortController.abort()`
  3. Server state → `unavailable`
  4. Если `autoRestart: true` — попытка перезапуска через 1s
- **Ожидаемый результат:** crash handler в `manager.ts` + 1 integration тест
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-1.18 (commit d4a233b) [DATA]: Invalid mcp.json graceful skip + warning
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Если файл mcp.json содержит невалидный JSON или не проходит TypeBox-валидацию — `console.warn("Invalid mcp.json at <path>: <error>")`, файл пропускается (как будто отсутствует). Другой файл (global/project) используется, если валиден.
- **Зависимости:** F-1.8
- **TDD-тесты:**
  - [ ] **TC-F1.18-1:** Невалидный JSON → warning, продолжение с пустым конфигом
    - *Условие:* mcp.json содержит `{` (broken)
    - *Шаги:* `loadMcpConfig(cwd)`
    - *Ожидаемый результат:* console.warn вызван; config = `{ servers: {} }`; FAN продолжает работу
- **Критерии приёмки:**
  1. Невалидный JSON (parse error) → warning + использовать второй файл
  2. Невалидная схема (TypeBox validation) → warning + пустой конфиг
  3. FAN не падает, пользователь получает warning в логах
  4. Тесты: 3 кейса невалидности (broken JSON, missing transport, invalid URL)
- **Ожидаемый результат:** try/catch в `loadMcpConfig` + 3 unit-теста
- **Оценка объёма:** S (≤ 4ч)

---

# Phase 2: Worker Proxy (Should Have)

**Цель:** Дать worker agents доступ к MCP через protocol-neutral proxy через RPC JSONL channel. Coordinator по-прежнему использует fan-mcp напрямую; worker получает "--remote-tools" флаг и проксирует tool calls в coordinator. **Критерий завершения:** worker запускается с `--remote-tools=t1,t2`, tool вызов прозрачно проксируется; stress test с 8 одновременными workers.

**Приоритет функций:** P1 (Should Have)

---

## Core RPC extensions

#### ✅ F-2.1 (commit f139369) [API]: Generic remote_tool_request/response types в rpc-types.ts
- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Добавить в discriminated union `RpcCommand`/`RpcResponse` типы: `RpcRemoteToolRequest`, `RpcRemoteToolResponse`, `RpcRemoteToolCancel`, `RpcRemoteToolCatalog`. Эти типы — protocol-neutral, не содержат MCP-специфики. Используются для bidirectional tool proxy между worker и parent.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F2.1-1:** TypeScript валидация дискриминантов
    - *Условие:* type-guard в rpc-types.ts
    - *Шаги:* попытка сериализации/десериализации
    - *Ожидаемый результат:* все 4 типа правильно discriminated unions
- **Критерии приёмки:**
  1. 4 новых типа добавлены в `RpcCommand`/`RpcResponse` discriminated unions
  2. Никакого импорта из MCP SDK в `rpc-types.ts`
  3. Все типы — immutable interfaces с discriminator `type: "remote_tool_*"`
- **Ожидаемый результат:** +20 строк в `rpc-types.ts`
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-2.2 (commit baff7d7) [API]: Generic correlation map в rpc-mode.ts
- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Добавить `pendingRemoteToolRequests: Map<string, DeferredPromise>` в `rpc-mode.ts` (по образцу `pendingExtensionRequests`). Хендлер `remote_tool_response` на входе: lookup в map по id → `resolve(result)`. Cleanup: reject promise при timeout 60s.
- **Зависимости:** F-2.1
- **TDD-тесты:**
  - [ ] **TC-F2.2-1:** `remote_tool_response` резолвит ожидающий promise
    - *Условие:* worker вызвал `remote_tool_request({id:"inv_001"})`; в `pendingRemoteToolRequests` есть id
    - *Шаги:* parent шлёт `remote_tool_response({id:"inv_001", content:[...]})` на worker stdin
    - *Ожидаемый результат:* deferred promise резолвится; worker tool call возвращает content
- **Критерии приёмки:**
  1. `remote_tool_response` обрабатывается ДО основной `handleCommand` (как `extension_ui_response`)
  2. Lookup по id; отсутствующий id → warning + ignore
  3. Promise rejection при timeout 60s
  4. Тесты: happy path, timeout, missing id
- **Ожидаемый результат:** +30 строк в `rpc-mode.ts` + 3 unit-теста
- **Оценка объёма:** M (≤ 1 день)

#### ✅ F-2.3 (commit 1b9f9f1) [API]: lastEvent cache в EventBus (replay-on-subscribe)
- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Расширить `EventBus` (`event-bus.ts`) полем `lastEvents: Map<string, unknown>`. При `emit(channel, data)` — сохранить `data` в `lastEvents.set(channel, data)`. При `on(channel, handler)` — если `lastEvents.has(channel)` → сразу вызвать `handler(lastEvents.get(channel))` перед подпиской. Generic ~10 строк, не MCP-специфично.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F2.3-1:** Emit до subscribe → subscriber получает cached value
    - *Условие:* `bus.emit("foo", {a:1})` затем `bus.on("foo", handler)`
    - *Шаги:* создать handler с инкрементирующим счётчиком
    - *Ожидаемый результат:* handler вызван 1 раз с `{a:1}` сразу после subscribe; потом при `emit` — повторно
- **Критерии приёмки:**
  1. `EventBus` имеет поле `lastEvents`
  2. `on()` сначала replay'ит last event, потом подписывается
  3. Backward-compatible: существующие users (Store, orchestrator) не сломаны
  4. Тесты: replay, then live, no-cache-for-undefined
- **Ожидаемый результат:** +10 строк в `event-bus.ts` + 2 unit-теста
- **Оценка объёма:** S (≤ 4ч)

---

## Orchestrator extension (WorkerProxy)

#### ✅ F-2.4 (commit e57a805) [API]: orchestrator: remote_tool_request handler в subagent-runner
- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** В `subagent-runner.js` добавить ветку в `handleMessage(data)`: `case "remote_tool_request"` → lookup broker для {id, toolId, args}, выполнить через MCP extension (call `mcpManager.callTool(...)`), записать в `child.stdin` JSON-строку `{type: "remote_tool_response", id, content, isError}`.
- **Зависимости:** F-2.1, F-2.2, F-2.5
- **TDD-тесты:**
  - [ ] **TC-F2.4-1:** Worker → orchestrator → MCP → orchestrator → worker round-trip
    - *Условие:* worker запущен с `--remote-tools=read_file`; MCP server `filesystem` подключён
    - *Шаги:* worker LLM вызывает `mcp__filesystem__read_file`; remote_tool_request приходит в orchestrator
    - *Ожидаемый результат:* через 100-500ms remote_tool_response приходит в worker; tool result доступен
- **Критерии приёмки:**
  1. `handleMessage` обрабатывает `remote_tool_request` не молча (без default branch ранее)
  2. `child.stdin.write(JSON.stringify({...}) + "\n")` используется для ответа
  3. Orchestrator не блокирует основной event loop
  4. Integration тест: реальный worker subprocess + mock MCP
- **Ожидаемый результат:** +25 строк в `subagent-runner.js` + 1 integration тест
- **Оценка объёма:** M (≤ 1 день)

#### ✅ F-2.5 (commit 7eaecc4) [BIZ]: orchestrator: broker-handler с EventBus подпиской
- **Приоритет:** P1
- **Слой:** [BIZ]
- **Описание:** Создать модуль `broker-handler.js` в orchestrator extension. На `session_start` подписаться на `fan.events.on("mcp:catalog", ...)`. Сохранять нормализованный catalog для routing tool calls. Поддерживать фильтрацию по worker profile (`allowedTools` для worker type).
- **Зависимости:** F-2.3
- **TDD-тесты:**
  - [ ] **TC-F2.5-1:** Подписка на `"mcp:catalog"` получает каталог от fan-mcp
    - *Условие:* оба extensions загружены в одном процессе
    - *Шаги:* fan-mcp emit `"mcp:catalog"`; orchestrator подписан
    - *Ожидаемый результат:* broker-handler catalog содержит все MCP tools
- **Критерии приёмки:**
  1. `fan.events.on("mcp:catalog", handler)` зарегистрирован в session_start
  2. Catalog filter применяется по worker type (explore → read-only)
  3. При `mcp:catalog` re-emit от fan-mcp — broker sync с актуальным состоянием
- **Ожидаемый результат:** `broker-handler.js` + 2 unit-теста
- **Оценка объёма:** M (≤ 1 день)

#### ✅ F-2.6 (commit 9f7617e) [API]: core: --remote-tools flag и proxy registration в worker
- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Добавить CLI флаг `--remote-tools=t1,t2,...`. В worker `rpc-mode.ts` при connect: прочитать catalog (через `remote_tool_catalog` message от orchestrator), создать `RemoteProxyTool` instances и добавить в `_toolRegistry`. Каждый proxy tool при `execute()` шлёт `remote_tool_request` на stdout и await'ит response.
- **Зависимости:** F-2.1, F-2.2, F-2.4, F-2.5
- **TDD-тесты:**
  - [ ] **TC-F2.6-1:** Worker с --remote-tools получает catalog и регистрирует proxy tools
    - *Условие:* orchestrator предоставляет catalog с 3 tools; worker запущен с --remote-tools
    - *Шаги:* worker inspect `_toolRegistry`
    - *Ожидаемый результат:* 3 RemoteProxyTool instances зарегистрированы с правильными именами
- **Критерии приёмки:**
  1. CLI parser понимает `--remote-tools=t1,t2`
  2. Worker создаёт RemoteProxyTool instances в `_toolRegistry`
  3. RemoteProxyTool.execute() → `remote_tool_request` на stdout, await `remote_tool_response`
- **Ожидаемый результат:** +40 строк в `rpc-mode.ts` + CLI parser + 2 integration теста
- **Оценка объёма:** L (≤ 2 дня)

#### ✅ F-2.7 [BIZ]: orchestrator: per-worker profile filtering
- **Приоритет:** P1
- **Слой:** [BIZ]
- **Описание:** В `subagent-runner.js` при генерации `--remote-tools` для worker применить profile-based фильтрацию: explore/plan/verify — только `readOnly` tools из MCP catalog; implement/bug-fix/tests-impl — все tools; code-research — annotated. Использовать существующую концепцию `agents.js` для определения worker type.
- **Зависимости:** F-2.5
- **TDD-тесты:**
  - [ ] **TC-F2.7-1:** Worker типа `explore` получает только read-only tools
    - *Условие:* catalog с 5 tools (2 read-only, 2 write, 1 admin)
    - *Шаги:* launch worker с `agentType: "explore"`
    - *Ожидаемый результат:* worker `--remote-tools` содержит только 2 read-only tools
- **Критерии приёмки:**
  1. В `agents.js` mapping workerType → permissionLevel
  2. При spawn worker из `delegate_task`: profile применяется к `--remote-tools`
  3. Catalog tools с `annotations.readOnly === false` блокируются для read-only profiles
  4. Тесты: 3 profile profiles × 2 scenario = 6 тестов
- **Ожидаемый результат:** маппинг profiles + фильтр в `subagent-runner.js` + 2 unit теста
- **Оценка объёма:** M (≤ 1 день)

---

# Phase 3: Polish & Hardening (Could Have)

**Цель:** Улучшение UX и надёжности: progress, structured content, OAuth, restart, dashboard, logging. **Критерий завершения:** все Could Have features работают; quality metrics соответствуют NFR-01..NFR-05.

**Приоритет функций:** P2 (Could Have)

---

#### ✅ F-3.1 [INTEG]: Progress forwarding (MCP progress → onUpdate)
- **Приоритет:** P2
- **Слой:** [INTEG]
- **Описание:** При `client.callTool()` использовать `onprogress` callback в RequestOptions. Convert в `AgentToolResult.onUpdate` callback. Throttle 50ms (batch high-frequency updates).
- **Зависимости:** Phase 1
- **TDD-тесты:** 2 unit/integration теста на progress events
- **Критерии приёмки:**
  1. MCP `onprogress` подключён к `onUpdate` callback в ToolDefinition.execute
  2. Throttle 50ms (не отправлять каждый progress event модели)
  3. Progress events содержат `progressToken` correlation
- **Ожидаемый результат:** обёртка в `execute()` + 2 теста
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-3.2 [INTEG]: structuredContent preservation в result.details
- **Приоритет:** P2
- **Слой:** [INTEG]
- **Описание:** При получении `CallToolResult.structuredContent` — сохранить в `AgentToolResult.details.structuredContent`. Если есть `outputSchema` — валидировать структуру через Ajv.
- **Зависимости:** F-1.7
- **TDD-тесты:** 2 unit теста на сохранение и валидацию
- **Критерии приёмки:**
  1. `result.details.structuredContent` всегда = `CallToolResult.structuredContent` (даже если null)
  2. Валидация через Ajv при наличии `Tool.outputSchema` — warning в лог при mismatch
- **Ожидаемый результат:** обновление в `adapter.ts` + 2 теста
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-3.3 (commit 415e949) [INTEG]: OAuth support для Streamable HTTP
- **Приоритет:** P2
- **Слой:** [INTEG]
- **Описание:** Поддержать `OAuthClientProvider` для `StreamableHTTPClientTransport`. Хранение токенов в OS keychain (или fallback в encrypted file). Browser redirect flow для authorization code grant.
- **Зависимости:** F-1.5
- **TDD-тесты:** integration тест с mock OAuth provider
- **Критерии приёмки:**
  1. `transport.finishAuth(code)` вызывается из UI callback
  2. Tokens persists между sessions
  3. `getAccessToken()` обрабатывает refresh автоматически
- **Ожидаемый результат:** OAuth integration + 1 integration тест
- **Оценка объёма:** L (≤ 2 дня)

#### ✅ F-3.4 [BIZ]: Auto-restart упавших stdio серверов
- **Приоритет:** P2
- **Слой:** [BIZ]
- **Описание:** При crash stdio-сервера, если `config.autoRestart === true` — попытка перезапуска через 1s exponential backoff (max 5 попыток за 60s). После исчерпания — статус `unavailable` без autoRestart.
- **Зависимости:** F-1.17
- **TDD-тесты:** 2 unit/integration теста на backoff
- **Критерии приёмки:**
  1. Backoff: 1s → 2s → 4s → 8s → 16s, max 5 попыток
  2. После 5 неудач в 60s — server становится `unavailable`, autoRestart деактивирован
  3. После успешного restart — tools re-registered
- **Ожидаемый результат:** retry logic в `manager.ts` + 2 теста
- **Оценка объёма:** M (≤ 1 день)

#### ✅ F-3.5 [BIZ]: /mcp status и /mcp reload команды
- **Приоритет:** P2
- **Слой:** [BIZ]
- **Описание:** Зарегистрировать 2 команды через `fan.registerCommand()`: `/mcp status` — таблица серверов со статусом, количеством tools, версией, transport; `/mcp reload` — закрыть все клиенты, перезагрузить config, переподключиться.
- **Зависимости:** Phase 1
- **TDD-тесты:** integration test запуска каждой команды
- **Критерии приёмки:**
  1. `/mcp status` рендерит таблицу (status, tools count, version, transport) в TUI
  2. `/mcp reload` не падает при ошибках; показывает summary после reload
- **Ожидаемый результат:** 2 command handlers + 2 integration теста
- **Оценка объёма:** S (≤ 4ч)

#### ✅ F-3.6 [CLI]: Dashboard MCP server status card
- **Приоритет:** P2
- **Слой:** [CLI]
- **Описание:** В dashboard `packages/dashboard/` добавить карточку MCP servers: имя, транспорт, статус, количество tools, версия. Использовать существующие api-gateway endpoints (добавить `GET /api/mcp/servers`).
- **Зависимости:** F-3.5 (status command); api-gateway integration
- **TDD-тесты:** integration test dashboard rendering
- **Критерии приёмки:**
  1. Endpoint `GET /api/mcp/servers` возвращает список серверов с метаданными
  2. Dashboard рендерит карточку с зелёным/жёлтым/красным индикатором
  3. Card обновляется при emit `"mcp:catalog"` через WebSocket
- **Ожидаемый результат:** новый endpoint + dashboard компонент + 1 integration тест
- **Оценка объёма:** L (≤ 2 дня)

#### ✅ F-3.7 [BIZ]: Logging/metrics для вызовов MCP tools
- **Приоритет:** P2
- **Слой:** [BIZ]
- **Описание:** Логировать каждый tool call с serverId, toolName, duration, success/error. Метрики в `~/.fan/agent/logs/mcp-<date>.log` (JSON lines). Не логировать content (PII/secrets).
- **Зависимости:** Phase 1
- **TDD-тесты:** 2 unit теста на log format и sanitization
- **Критерии приёмки:**
  1. Каждый call логируется с timestamp, serverId, toolName, duration_ms, status
  2. Content/sanitized args НЕ логируются (только meta)
  3. Logs в `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`
- **Ожидаемый результат:** logger module + 2 теста
- **Оценка объёма:** S (≤ 4ч)

---

# Phase 4: Won't Have (уже явно исключено)

| ID | Feature | Обоснование |
|----|---------|-------------|
| W-01 | Sampling (MCP-сервер запрашивает LLM вызов) | Требует trust model, budget integration; default-deny в MVP |
| W-02 | Roots (MCP-сервер запрашивает файловые корни) | Ограничивается project root, не требует расширения |
| W-03 | Elicitation (form/URL от MCP-сервера) | Требует UI integration; отложено |
| W-04 | MCP server mode (FAN как MCP сервер) | Отдельная большая фича, не интеграция |
| W-05 | WebSocket transport | Не входит в MCP спецификацию |
| W-06 | Legacy HTTP+SSE transport | Deprecated в MCP spec |

---

# Полный чеклист по приоритетам

## P0 — Критические (18)
- [x] F-1.1 [API]: Core: unregisterTool (commit 428539d) на ExtensionAPI
- [x] F-1.2 [API]: Core: updateTool (commit 428539d) на ExtensionAPI
- [x] F-1.3 [CLI]: FAN Store extension packaging (commit 3fa4083)
- [ ] F-1.4 [INTEG]: StdioClientTransport integration
- [x] F-1.5 [INTEG]: StreamableHTTPClientTransport (commit 6ce6125) integration
- [x] F-1.6 [INTEG]: tools/list (commit da7957e) discovery и ToolDefinition mapping
- [x] F-1.7 [INTEG]: tools/call (commit 0c4d3e2) execution и result mapping
- [x] F-1.8 [DATA]: mcp.json loader (commit 2043d41) и global/project merge
- [x] F-1.9 [BIZ]: allowedTools/deniedTools filtering (commit 4704aaa)
- [x] F-1.10 [BIZ]: tool_call permission gate (commit 666c5f4)
- [x] F-1.11 [DATA]: ${ENV_VAR} resolution (commit 4f58166) в mcp.json
- [x] F-1.12 [INTEG]: AbortSignal (commit d4a233b) → MCP cancel propagation
- [x] F-1.13 [BIZ]: Per-call (commit abb5959) и per-server timeouts
- [x] F-1.14 [BIZ]: Graceful shutdown (commit 2f464db) с cleanup stdio процессов
- [x] F-1.15 [INTEG]: list_changed (commit 3a1811c) atomic catalog refresh
- [x] F-1.16 [BIZ]: Graceful unavailable (commit 2f464db) server
- [x] F-1.17 [BIZ]: stdio server crash (commit 2f464db) → tools removed
- [x] F-1.18 [DATA]: Invalid mcp.json (commit d4a233b) graceful skip + warning

## P1 — Высокий (Should Have, 7)
- [x] F-2.1 [API]: Generic remote_tool (commit f139369)_request/response types в rpc-types.ts
- [x] F-2.2 [API]: Generic correlation map (commit baff7d7) в rpc-mode.ts
- [x] F-2.3 [API]: lastEvent cache (commit 1b9f9f1) в EventBus
- [x] F-2.4 [API]: orchestrator: remote_tool_request handler (commit e57a805) в subagent-runner
- [x] F-2.5 [BIZ]: orchestrator: broker-handler (commit 7eaecc4) с EventBus подпиской
- [x] F-2.6 [API]: core: --remote-tools flag (commit 9f7617e) и proxy registration в worker
- [x] F-2.7 [BIZ]: orchestrator: per-worker profile filtering

## P2 — Средний (Could Have, 7)
- [x] F-3.1 [INTEG]: Progress forwarding forwarding
- [x] F-3.2 [INTEG]: structuredContent preservation
- [x] F-3.3 [INTEG]: OAuth support (commit 415e949) для Streamable HTTP
- [x] F-3.4 [BIZ]: Auto-restart упавших stdio серверов
- [x] F-3.5 [BIZ]: /mcp status и /mcp reload команды
- [x] F-3.6 [CLI]: Dashboard MCP status card (endpoint stub) server status card
- [x] F-3.7 [BIZ]: Logging/metrics для вызовов MCP tools

---

# Граф зависимостей

```
Phase 1:
F-1.1, F-1.2 (no deps)
  → F-1.3 (Fan Store extension)
    → F-1.4 (stdio)
    → F-1.5 (http)
    → F-1.6 (tools/list)
      → F-1.7 (tools/call)
        → F-1.12 (cancel)
        → F-1.13 (timeouts)
    → F-1.11 (${ENV})
      → F-1.5
    → F-1.8 (config loader)
      → F-1.9 (filtering)
        → F-1.10 (permission gate)
    → F-1.14 (graceful shutdown)
    → F-1.15 (list_changed) ← F-1.1, F-1.2, F-1.6
    → F-1.16 (unavailable server) ← F-1.4, F-1.5
    → F-1.17 (crash → tools removed) ← F-1.1, F-1.16
    → F-1.18 (invalid config) ← F-1.8

Phase 2:
F-2.1 (no deps)
F-2.3 (no deps)
  → F-2.2 ← F-2.1
F-2.5 ← F-2.3
F-2.4 ← F-2.1, F-2.2, F-2.5
F-2.6 ← F-2.1, F-2.2, F-2.4, F-2.5
F-2.7 ← F-2.5

Phase 3: depends on Phase 1 (через F-1.*)
F-3.1 ← F-1.7
F-3.2 ← F-1.7
F-3.3 ← F-1.5
F-3.4 ← F-1.17
F-3.5 ← (Phase 1)
F-3.6 ← F-3.5
F-3.7 ← (Phase 1)

Циклов нет.
```

---

# Делегирование (применимо)

> ⚠️ **Roadmap превышает лимит 15 функций.** Рекомендуется при следующей итерации разбить на 3 дочерние roadmap-ы:
>
> 1. **`docs/features/mcp-integration-core/`** (Phase 1, 18 функций) — Core seam + Coordinator MCP, можно стартовать сейчас
> 2. **`docs/features/mcp-integration-workers/`** (Phase 2, 7 функций) — Worker proxy, после Phase 1
> 3. **`docs/features/mcp-integration-polish/`** (Phase 3, 7 функций) — Progress/OAuth/Dashboard, после Phase 2

---

*Создано: feature-roadmap skill v1.1.0*
*Исходный roadmap: `docs/specs/spec_mcp-integration_2026-07-16.md`*
*Slug сохранён: `mcp-integration`*
