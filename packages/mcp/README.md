# @fan/mcp-extension

MCP (Model Context Protocol) клиент-расширение для [FAN](https://fan.sea-agents.ru/).

Подключает FAN к внешним MCP-серверам и предоставляет их инструменты как нативные AgentTool.

**Статус**: Coordinator-only MCP готов; Worker Proxy + авто-перезапуск + `/mcp` команды + структурированный контент + логирование реализованы.  
**Тесты**: 241 проход (19 тестовых файлов).  
**Версия**: 0.1.0 (`@fan/mcp-extension`).

---

## Установка

```bash
FAN включает `@fan/mcp-extension` из коробки — установка не требуется. Убедиться что extension обнаружен: `fan store list` должен показать `fan-mcp`. Если нет — `fan store install fan-mcp`.
```

## Быстрый старт

Создайте `~/.fan/agent/mcp.json`:

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  ]
}
```

Запустите FAN — инструменты будут автоматически обнаружены и зарегистрированы как `mcp__0__<toolName>`.

> **Примечание**: этот пакет использует форму массива `servers: []`. В старой документации может встречаться `servers: {}` (объект с ключём serverId) — это устаревшая форма.

---

## Конфигурация

### Расположение mcp.json

| Путь | Область | Приоритет |
|------|---------|-----------|
| `~/.fan/agent/mcp.json` | Глобально (все проекты) | Базовая конфигурация |
| `$CWD/.fan/mcp.json` | Локально для проекта | Переопределяет глобальную по индексу сервера |

Оба файла объединяются по индексу массива: проектная конфигурация на индексе *i* заменяет глобальную на индексе *i*. Лишние проектные серверы добавляются в конец.

### Параметры per-server

| Поле | Тип | По умолч. | Описание |
|------|-----|-----------|----------|
| `transport` | `"stdio"` \| `"streamable-http"` | — | Транспортный протокол |
| `command` | string | — | (stdio) имя исполняемого файла или абсолютный путь |
| `args` | string[] | — | (stdio) аргументы командной строки |
| `env` | object | безопасный список | (stdio) переменные окружения (поддерживает `${VAR}`) |
| `url` | string | — | (http) URL MCP-эндпоинта |
| `headers` | object | — | (http) HTTP-заголовки (поддерживает `${VAR}`) |
| `allowedTools` | string[] | `["*"]` | Glob-шаблоны — инструмент должен совпасть хотя бы с одним |
| `deniedTools` | string[] | `[]` | Glob-шаблоны — блокирует совпадающие инструменты; приоритет выше |
| `timeout` | number | `60000` | Таймаут вызова в мс (1000–300000) |
| `autoRestart` | boolean | `false` | Авто-перезапуск при падении stdio с экспоненциальной задержкой |
| `allowLocal` | boolean | `false` | Разрешить loopback-адреса в streamable-http (127.0.0.0/8, ::1) |
| `allowPrivate` | boolean | `false` | Разрешить адреса частных сетей (10.0.0.0/8, 192.168.0.0/16 и др.) |
| `oauth` | object | — | OAuth 2.0 PKCE конфигурация (см. ниже) |

### Именование инструментов

MCP-инструменты доступны как `mcp__<serverId>__<toolName>`. `serverId` — это индекс сервера в массиве `servers[]`.

### Порядок разрешения конфигурации

1. `allowedTools`/`deniedTools` используют **сырые имена MCP-инструментов** (без префикса `mcp__<server>__`).  
   Пример: `{ deniedTools: ["delete_file"] }` блокирует `mcp__0__delete_file`.
2. `deniedTools` проверяется первым — любой совпавший инструмент блокируется независимо от `allowedTools`.
3. Если `allowedTools` не указан, по умолчанию `["*"]` (все инструменты разрешены, кроме запрещённых).
4. Инструменты не из MCP (без префикса `mcp__`) проходят без изменений.

---

## Транспорты

### stdio

Запускает подпроцесс через `StdioClientTransport` ([SDK docs](https://github.com/modelcontextprotocol/typescript-sdk)). Процесс общается через stdin/stdout по JSON-RPC.

- `shell: false` — принудительно для безопасности.
- Переменные окружения: если `env` не задан, используется безопасный список (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USERPROFILE`).
- Ссылки `${VAR}` в значениях `env` извлекаются из `process.env`.

### Streamable HTTP

Подключается через HTTP SSE с `StreamableHTTPClientTransport`.

- Разрешён только протокол `https:` (не `http:`).
- Loopback-адреса (`127.0.0.0/8`, `::1`, `0.0.0.0`) требуют `allowLocal: true`.
- Адреса частных сетей (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`) требуют `allowPrivate: true` или `allowLocal: true`.
- Ссылки `${VAR}` в `headers` извлекаются из `process.env`.

---

## OAuth (Phase 4 — частично)

MCP-серверы, использующие Streamable HTTP, могут требовать OAuth 2.0 Authorization Code flow с PKCE (S256).

### Конфигурация

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "url": "https://mcp.example.com",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "authorizationUrl": "https://auth.example.com/authorize",
        "tokenUrl": "https://auth.example.com/token",
        "scopes": ["read", "write"]
      }
    }
  ]
}
```

### Как это работает

1. При старте сессии расширение проверяет `~/.fan/agent/mcp-tokens.json` на наличие существующих токенов.
2. Если токен существует и до его истечения >60с — он переиспользуется.
3. Если истёк, но есть refresh token — выполняется автоматическое обновление.
4. Иначе запускается полный PKCE-процесс:
   - Локальный callback-сервер запускается на `127.0.0.1` (случайный порт).
   - URL авторизации выводится в stderr (требуется ручное открытие в браузере).
   - После авторизации сервер получает код и обменивает его на токен.

### Ограничения

- Полный PKCE-процесс выводит URL в stderr — автоматическое открытие браузера не реализовано (требуется интеграция `open` / `xdg-open`).
- Хранение токенов — JSON-файл `~/.fan/agent/mcp-tokens.json` с режимом `0o600`. В production-развёртываниях может быть заменён на интеграцию с OS keychain.

---

## Worker Proxy (Phase 2 — завершено)

Worker-агенты (подпроцессы `fan --mode rpc --no-extensions`) получают MCP-инструменты через механизм Worker Proxy.

### Как это работает

1. **Catalog broadcast**: При старте сессии `fan-mcp` испускает событие `mcp:catalog` на шине событий (`EventBus`). `EventBus` кеширует последнее событие (replay-on-subscribe), так что поздние подписчики всё равно получают каталог.

2. **Broker handler** (`extensions/fan-orchestrator/broker-handler.js`):
   - Подписывается на `mcp:catalog` и хранит in-memory `Map<string, MCPToolDescriptor>`.
   - Предоставляет `getTool()`, `listTools()`, `invokeTool()` и `handleRemoteToolInvocation()`.

3. **RemoteProxyTool** (`packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts`):
   - Worker-агенты запускаются с флагом `--remote-tools=<list>`.
   - Для каждого MCP-инструмента из списка локально создаётся `RemoteProxyTool`.
   - Когда worker вызывает проксированный инструмент, он отправляет `remote_tool_request` (JSONRPC-сообщение) родительскому процессу.
   - RPC-режим родительского оркестратора сопоставляет запрос со своей картой `pendingRemoteToolRequests` и направляет его через broker handler.
   - Broker вызывает реальный MCP-клиент через `toolCallHandler` callback.
   - Результат возвращается как `remote_tool_response` (JSONRPC-сообщение).

4. **Профильная фильтрация** (F-2.7):
   - Уровни доступа worker'ов: `explore`/`plan`/`verify`/`code-research` → **только чтение** (только инструменты с `annotations.readOnly === true`).
   - `implement`/`bug-fix`/`tests-impl` → **все** инструменты.

### CLI-флаг

```
fan --mode rpc --remote-tools "mcp__0__read_file,mcp__0__write_file"
```

Список предоставляется оркестратором, который знает, какие MCP-инструменты доступны из broker catalog.

---

## /mcp Команды

Доступны две slash-команды (когда `enableSlashCommands` включён):

| Команда | Описание |
|---------|----------|
| `/mcp status` | Показать таблицу статуса подключения (индекс, статус, транспорт, кол-во инструментов) |
| `/mcp reload` | Закрыть все соединения, перезагрузить конфигурацию, переподключиться |

---

## Безопасность

### Исправления ошибок (коммиты `01d6eb1`, `1058927`)

| Ошибка | ID | Описание | Исправление |
|--------|-----|----------|-------------|
| BUG-1 | CRITICAL | Gate разрешений создавался без конфигурации — пустая карта `byIndex`, все вызовы заблокированы | Добавлен метод `updateConfig()`, вызывается при `session_start` после загрузки конфига |
| BUG-2 | HIGH | Инъекция псевдонима server ID — `Number("0e0") === 0` позволял подделать индекс `0` | Добавлена проверка `isValidServerId()` с regex `^\d+$` в gate разрешений |
| BUG-3 | HIGH | SSRF обход loopback — проверялись только `localhost/127.0.0.1/::1` | Полное покрытие `127.0.0.0/8`, `0.0.0.0`, диапазоны частных сетей, новый флаг `allowPrivate` |
| BUG-4 | MEDIUM | `TC-F1.7-9` несоответствие аргументов — вызов `executeMcpTool` без `undefined` для `onUpdate` | Исправлена сигнатура вызова |
| BUG-5 | MEDIUM | `list_changed` двойная загрузка — авто-загрузка SDK + наш refresh = 2x `listTools()` | Установлен `autoRefresh: false` в конфиге SDK |
| BUG-6 | HIGH | Утечка секретов в логгере — сообщения об ошибках могли содержать Bearer-токены, API-ключи | Добавлена `sanitizeMessage()` с regex-шаблонами для токенов, ключей, `sk-*` ключей |
| BUG-7 | LOW | Мёртвый код — неиспользуемое объявление `pendingRemoteToolRequests` в `rpc-mode.ts` | Удалено |

### Практики безопасности

- **Stdio spawn**: `shell: false` (нет shell-инъекций через `args`).
- **Безопасный список env**: только `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USERPROFILE` наследуются, если не задан кастомный `env`.
- **Защита loopback**: Streamable HTTP требует явного `allowLocal: true` для локальных адресов.
- **Защита частных сетей**: диапазоны частных IP требуют `allowPrivate: true`.
- **ReDoS защита**: `matchGlob()` ограничивает шаблоны 256 символами и 10 звёздочками.
- **Редактирование логгера**: сообщения об ошибках в логах санируются (Bearer-токены, `sk-*` ключи, любые шаблоны длины 32+ hex/base64).
- **Валидация транспорта**: схема URL, hostname и переменные окружения проверяются при загрузке конфига.

---

## Наблюдаемость

### MCP-логи

Структурированные JSON-lines логи записываются в `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`.

Каждая запись содержит:
- `timestamp` — ISO 8601
- `event` — `tool_call_start` | `tool_call_end` | `tool_call_error`
- `serverId`, `toolName` — идентификация
- `durationMs` — затраченное время
- `status` — `success` | `error`
- `errorMessage` — санированное сообщение (без PII/секретов)

Логи пишутся асинхронно; ошибки записи никогда не прерывают выполнение инструмента.

### Авто-перезапуск

Когда `autoRestart: true` установлен в конфиге stdio-сервера, упавшие серверы автоматически перезапускаются с экспоненциальной задержкой:

| Попытка | Задержка |
|---------|----------|
| 1       | 1с       |
| 2       | 2с       |
| 3       | 4с       |
| 4       | 8с       |
| 5       | 16с      |

После 5 неудачных попыток в течение 60-секундного окна авто-перезапуск навсегда отключается для этого сервера. Счётчик попыток сбрасывается через 60с без падения.

---

## Структура пакета

```
src/
  adapter.ts         — MCP tool → AgentTool конвертер (JSON Schema → TypeBox)
  config.ts          — Загрузчик mcp.json (глобальный + проектный merge, TypeBox валидация)
  executor.ts        — Обёртка выполнения инструмента с таймаутом и логированием
  index.ts           — Фабрика расширения (lifecycle hooks, /mcp команды)
  logger.ts          — Структурированный JSON-lines логгер (санированный, ежедневные файлы)
  manager.ts         — Менеджер клиентов (подключение/отключение, обработка падений, авто-перезапуск)
  oauth.ts           — OAuth 2.0 PKCE поток (code verifier, challenge, обмен токенами)
  permissions.ts     — Gate разрешений (allowedTools/deniedTools, glob-сопоставление)
  timeout.ts         — Утилита таймаута через AbortController
  transport.ts       — Фабрики StdioClientTransport + StreamableHTTPClientTransport
```

### Обзор фаз

| Фаза | Статус | Возможности |
|------|--------|-------------|
| Phase 1 | ✅ Завершено | Ядро MCP-клиента: транспорты, обнаружение инструментов, конфиг, разрешения, жизненный цикл |
| Phase 2 | ✅ Завершено | Worker Proxy: RemoteProxyTool, broker-handler, catalog broadcast, профильная фильтрация |
| Phase 3 | ✅ Завершено | Авто-перезапуск, `/mcp` команды, логирование/метрики, структурированный контент, `GET /api/mcp/servers` заглушка |
| Phase 4 | 🔶 Частично | OAuth (PKCE заглушка), MCP-карточка дашборда (отложено) |

---

## Лицензия

MIT
