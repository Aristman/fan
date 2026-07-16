# Руководство по MCP интеграции

> Подключение внешних MCP-серверов к FAN.  
> Подключает агентов FAN к внешним серверам Model Context Protocol через stdio или Streamable HTTP транспорты.

---

## Что такое MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — это открытый стандарт для подключения LLM-агентов к внешним инструментам, источникам данных и API. MCP-серверы предоставляют:

- **Инструменты (Tools)** — вызываемые функции (чтение/запись файловой системы, запросы к БД, GitHub API и т.д.)
- **Ресурсы (Resources)** — статические или динамические данные (файлы, записи БД)
- **Промпты (Prompts)** — переиспользуемые шаблоны промптов

FAN реализует **MCP-клиент** — он подключается к одному или нескольким MCP-серверам и предоставляет их инструменты как нативные AgentTool. Это значит, что ваш агент может использовать `mcp__0__read_file` так же, как любой встроенный инструмент.

### Когда использовать MCP

| Сценарий | Пример MCP-сервера |
|----------|--------------------|
| Файловые операции | `@modelcontextprotocol/server-filesystem` |
| Запросы к базам данных | Сервер, предоставляющий SQL через инструменты |
| GitHub API | `@modelcontextprotocol/server-github` |
| Кастомные API | Любой JSON-RPC эндпоинт |

---

## Быстрый старт

### 1. Установите расширение

```bash
fan store install fan-mcp
```

### 2. Настройте MCP-сервер

Создайте `~/.fan/agent/mcp.json`:

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedTools": ["*"],
      "timeout": 30000
    }
  ]
}
```

### 3. Запустите FAN

```bash
fan
```

При старте сессии расширение подключается ко всем настроенным серверам. Успешное подключение логируется:

```
mcp: server 0 (npx) connected (5 tools)
```

Доступные инструменты регистрируются как:

```
mcp__0__read_file
mcp__0__write_file
mcp__0__read_directory
mcp__0__search_files
mcp__0__get_file_info
```

### 4. Проверьте статус

```
/mcp status
```

Пример вывода:

```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
```

---

## Конфигурация

### Расположение файлов

| Путь | Область | Поведение |
|------|---------|-----------|
| `~/.fan/agent/mcp.json` | **Глобально** — все проекты | Базовые определения серверов |
| `$CWD/.fan/mcp.json` | **Локально для проекта** | Переопределяет глобальный на том же индексе, лишние добавляются |

Оба файла используют форму массива `servers: []`. ID сервера соответствует индексу в массиве (0, 1, 2, …).

### Пример глобальной + проектной конфигурации

**`~/.fan/agent/mcp.json`:**
```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    {
      "transport": "streamable-http",
      "url": "https://api.github.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  ]
}
```

**`$CWD/.fan/mcp.json`:**
```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./project-data"],
      "allowedTools": ["read_file", "read_directory"]
    }
  ]
}
```

Результат: сервер 0 — проектный (переопределяет глобальный), сервер 1 остаётся глобальным.

### Полная таблица параметров

| Поле | Тип | По умолч. | Описание |
|------|-----|-----------|----------|
| `transport` | `"stdio"` \| `"streamable-http"` | — | Транспортный протокол |
| `command` | string | — | (stdio) имя исполняемого файла или абсолютный путь |
| `args` | string[] | — | (stdio) аргументы командной строки |
| `env` | object | безопасный список | (stdio) переменные окружения (поддерживает `${VAR}`) |
| `url` | string | — | (http) URL MCP-эндпоинта |
| `headers` | object | — | (http) HTTP-заголовки (поддерживает `${VAR}`) |
| `allowedTools` | string[] | `["*"]` | Glob-шаблоны — инструмент должен совпасть хотя бы с одним |
| `deniedTools` | string[] | `[]` | Glob-шаблоны — приоритет выше `allowedTools` |
| `timeout` | number | `60000` | Таймаут вызова в мс (1000–300000) |
| `autoRestart` | boolean | `false` | Авто-перезапуск при падении stdio с экспоненциальной задержкой |
| `allowLocal` | boolean | `false` | Разрешить loopback-адреса в streamable-http |
| `allowPrivate` | boolean | `false` | Разрешить адреса частных сетей (RFC 1918, CGNAT, link-local) |
| `oauth` | object | — | OAuth 2.0 PKCE конфигурация (см. раздел OAuth) |

### Переменные окружения в конфиге

Ссылки `${VAR}` извлекаются из `process.env`:

```json
{
  "env": {
    "DB_CONNECTION": "${DATABASE_URL}"
  },
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}"
  }
}
```

Если указанная переменная не определена, при загрузке конфигурации выбрасывается `MissingEnvVarError`.

---

## Транспорты

### stdio

Запускает подпроцесс, который общается через stdin/stdout по JSON-RPC.

**Когда использовать:**
- Локальные MCP-серверы (npm-пакеты, локальные скрипты)
- Серверы без HTTP-эндпоинта
- Разработка и тестирование

**Безопасность:**
- `shell: false` — нет shell-инъекций через `args`
- Безопасный список окружения, когда не задан кастомный `env`: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USERPROFILE`
- Ссылки `${VAR}` извлекаются из `process.env`

**Пример:**
```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "env": {
    "PATH": "${PATH}",
    "HOME": "${HOME}"
  }
}
```

### Streamable HTTP

Подключается через HTTP SSE (Server-Sent Events) с использованием `StreamableHTTPClientTransport`.

**Когда использовать:**
- Удалённые MCP-серверы
- Production-развёртывания
- Сервисы, уже имеющие HTTP API

**Безопасность:**
- Разрешён только протокол `https:`
- Loopback-адреса требуют `allowLocal: true`
- Адреса частных сетей требуют `allowPrivate: true` или `allowLocal: true`

**Пример:**
```json
{
  "transport": "streamable-http",
  "url": "https://api.example.com/mcp",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

---

## Система разрешений

### allowedTools / deniedTools

Каждый сервер может ограничить, какие MCP-инструменты доступны агенту:

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "allowedTools": ["read_*", "list_*"],
  "deniedTools": ["delete_file", "write_*"]
}
```

**Правила:**
1. `deniedTools` проверяется первым — если инструмент совпал с любым запрещённым шаблоном, он блокируется.
2. Если `allowedTools` не установлен, по умолчанию `["*"]` (все разрешены, кроме запрещённых).
3. Glob-шаблоны — простые wildcard-паттерны (один `*` совпадает с любой последовательностью).
4. Имена инструментов используются **сырые MCP-имена** (без префикса `mcp__<server>__`).

### Безопасность glob-шаблонов

- Максимальная длина шаблона: 256 символов
- Максимальное количество wildcard'ов: 10
- При превышении лимитов используется безопасный поиск подстроки (без regex)

### Профильная фильтрация per-worker

В режиме оркестратора worker-агенты получают MCP-инструменты, отфильтрованные по их профилю доступа:

| Тип worker'а | Профиль | Доступ к MCP |
|-------------|---------|--------------|
| `explore`, `plan`, `verify`, `code-research` | **только чтение** | Только инструменты с `annotations.readOnly === true` |
| `implement`, `bug-fix`, `tests-impl` | **все** | Все инструменты (с учётом серверных `allowedTools`/`deniedTools`) |

Worker'ы без профиля по умолчанию имеют доступ ко **всем** инструментам.

---

## Worker Proxy

### Обзор

Worker-агенты (подпроцессы, запущенные оркестратором) **не** загружают расширение `fan-mcp`. Вместо этого они получают MCP-инструменты через механизм прокси:

```
Оркестратор (родитель)              Worker (подпроцесс)
      │                                  │
      │  ┌── fan-mcp расширение ──┐      │
      │  │ подключается к MCP     │      │
      │  │ испускает mcp:catalog  │      │
      │  └────────┬──────────────┘      │
      │           │                      │
      │  ┌────────┴──────────────┐      │
      │  │ broker-handler.js     │      │
      │  │ подписывается на      │      │
      │  │ catalog, хранит карту │      │
      │  └────────┬──────────────┘      │
      │           │                      │
      │  ┌────────┴──────────────┐      │
      │  │ RPC mode              │      │
      │  │ pendingRemoteToolReqs │      │
      │  │ карта корреляции      │      │
      │  └────────┬──────────────┘      │
      │           │                      │
      │     remote_tool_request  ◄────  │  RemoteProxyTool
      │     remote_tool_response ────►  │  (флаг --remote-tools)
      │           │                      │
```

### Как включить

Оркестратор автоматически передаёт флаг `--remote-tools` worker-агентам. Ручная настройка не требуется.

Если вы запускаете в кастомном RPC-режиме:

```bash
fan --mode rpc --remote-tools "mcp__0__read_file,mcp__0__write_file"
```

### Жизненный цикл

1. **Старт сессии**: `fan-mcp` подключается ко всем MCP-серверам и регистрирует инструменты.
2. **Catalog broadcast**: Событие `mcp:catalog` испускается на EventBus.
3. **Оркестратор подписывается**: `broker-handler.js` получает каталог через replay-on-subscribe.
4. **Запуск worker'а**: Оркестратор запускает worker'а с флагом `--remote-tools=<list>`.
5. **Прокси worker'а**: `RemoteProxyTool` перенаправляет вызовы инструментов родительскому процессу через JSONRPC.
6. **Маршрутизация broker'ом**: RPC-режим родителя получает запрос, находит сервер/инструмент через `brokerHandler` и вызывает реальный MCP-клиент.
7. **Ответ**: Результат возвращается по той же цепочке.

---

## Наблюдаемость

### /mcp status

Показывает текущее состояние подключения для всех серверов:

```
/mcp status
```

Вывод:
```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
 1 | unavailable  | streamable-http  | 0 tools (connect timeout 5000ms)
```

Статусы: `connecting` → `connected` → `unavailable` (при падении или ошибке подключения).

### /mcp reload

Закрыть все соединения, перезагрузить конфигурацию с диска и переподключиться:

```
/mcp reload
```

### MCP-логи

Структурированные JSON-логи в `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`:

```json
{"timestamp":"2026-07-16T12:00:00.000Z","event":"tool_call_end","serverId":"0","toolName":"read_file","durationMs":142,"status":"success"}
```

**Что логируется:**
- `tool_call_start` — временная метка начала
- `tool_call_end` — длительность + статус успеха
- `tool_call_error` — длительность + санированное сообщение об ошибке

**Что НЕ логируется** (никогда): аргументы инструментов, содержимое ответов, PII, секреты. Сообщения об ошибках санируются (Bearer-токены, API-ключи, `sk-*` ключи редактируются).

### Авто-перезапуск

Когда `autoRestart: true` установлен в конфиге stdio-сервера, падения вызывают автоматическое переподключение с экспоненциальной задержкой:

| Попытка | Задержка |
|---------|----------|
| 1 | 1с |
| 2 | 2с |
| 3 | 4с |
| 4 | 8с |
| 5 | 16с |

После 5 неудачных попыток в течение 60-секундного окна авто-перезапуск навсегда отключается. Счётчик сбрасывается через 60с без падения.

---

## OAuth (Phase 4 — частично)

### Предварительные требования

MCP-сервер должен поддерживать OAuth 2.0 Authorization Code flow с PKCE (S256).

### Конфигурация

```json
{
  "transport": "streamable-http",
  "url": "https://mcp.secure-service.com",
  "oauth": {
    "clientId": "fan-client",
    "clientSecret": "optional-for-confidential-clients",
    "authorizationUrl": "https://auth.secure-service.com/authorize",
    "tokenUrl": "https://auth.secure-service.com/token",
    "scopes": ["openid", "profile", "tools:read"]
  }
}
```

### Процесс

1. **Старт сессии**: Расширение проверяет `~/.fan/agent/mcp-tokens.json` на наличие валидного токена.
2. **Токен валиден** (>60с до истечения): используется напрямую.
3. **Токен истёк, есть refresh token**: автоматическое обновление через `grant_type=refresh_token`.
4. **Нет валидного токена**: запускается PKCE-процесс:
   - Локальный callback-сервер запускается на `127.0.0.1` (случайный порт).
   - URL авторизации выводится в stderr.
   - Пользователь открывает URL в браузере и авторизуется.
   - Callback-сервер получает код, обменивает его на токен.
   - Токен сохраняется в `~/.fan/agent/mcp-tokens.json` (режим `0o600`).

### Текущие ограничения

- **Нет автоматического открытия браузера** — URL выводится в stderr; пользователь должен скопировать его вручную.
- **Хранение токенов** — JSON-файл. В production может быть заменён на OS keychain (`libsecret`, macOS Keychain, Windows Credential Manager).
- **Полный браузерный процесс** требует ручного вмешательства; headless/CI-среды не могут завершить OAuth без дополнительных инструментов.

---

## Безопасность

### Модель угроз

| Угроза | Меры защиты |
|--------|-------------|
| Вредоносный MCP-сервер | Glob-фильтрация `allowedTools`/`deniedTools` для каждого сервера |
| SSRF через HTTP-транспорт | Только `https:`, loopback/частные сети по умолчанию заблокированы |
| Shell-инъекция через stdio | Принудительно `shell: false` |
| Подделка server ID | `isValidServerId()` отклоняет недесятичные псевдонимы (`0e0`, `-0`, `+1`) |
| Утечка секретов в логах | `sanitizeMessage()` редактирует токены, ключи, `sk-*` шаблоны |
| Утечка переменных окружения | Безопасный список окружения (по умолчанию наследуется только 6 безопасных переменных) |
| ReDoS через glob-шаблоны | Ограничение длины/количества wildcard'ов (256 символов, 10 `*`) |
| Ненадёжные конфиги | JSON Schema валидация при загрузке, корректная обработка ошибок |

### Лучшие практики

1. **Предпочитайте stdio** для локальных MCP-серверов — нет сетевой экспозиции.
2. **Используйте `deniedTools`** для блокировки деструктивных операций (`delete_file`, `write_*`, `rm_*`).
3. **Установите `allowLocal: false`** (по умолчанию) для предотвращения SSRF-атак на локальные сервисы.
4. **Используйте переменные окружения** для секретов (`${GITHUB_TOKEN}`) — никогда не хардкодьте токены в `mcp.json`.
5. **Просматривайте MCP-логи** в `~/.fan/agent/logs/mcp-*.log`.
6. **Ограничивайте `allowedTools`** для каждого сервера — гранулярный доступ уменьшает радиус взрыва.

### Исправления ошибок

Критические исправления безопасности в коммитах `01d6eb1` и `1058927`:

| Ошибка | Описание |
|--------|----------|
| BUG-1 | Gate разрешений создавался без конфигурации — пустой gate, все вызовы заблокированы |
| BUG-2 | Инъекция псевдонима server ID через приведение `Number("0e0")` |
| BUG-3 | SSRF обход loopback — неполное покрытие IP-диапазонов |
| BUG-4 | Несоответствие аргументов, вызывающее зависание по таймауту |
| BUG-5 | `list_changed` двойная загрузка, тратящая пропускную способность |
| BUG-6 | Утечка секретов в сообщениях логов ошибок |
| BUG-7 | Удаление мёртвого кода |

---

## Устранение неполадок

### Сервер показывает "unavailable"

**Проверьте:**
1. Работает ли команда вне FAN? `npx -y @modelcontextprotocol/server-filesystem .`
2. Корректен ли путь? Используйте абсолютные пути для кастомных скриптов.
3. Доступна ли сеть? `curl https://api.example.com/mcp`
4. Проверьте `~/.fan/agent/logs/mcp-*.log` для деталей.

### Инструменты не отображаются

**Проверьте:**
1. `/mcp status` — сервер в статусе `connected`?
2. Действительно ли сервер предоставляет инструменты? `tools/list` должен вернуть непустой список.
3. Не слишком ли строги `allowedTools`? Попробуйте `"allowedTools": ["*"]`.
4. Не блокирует ли устаревший `deniedTools` всё подряд?

### OAuth-процесс не завершается

**Проверьте:**
1. Выводится ли URL авторизации в stderr? Ищите `OAuth: open the following URL`.
2. Доступен ли redirect URI? Callback-сервер слушает на `127.0.0.1` на случайном порту.
3. Возвращает ли token endpoint валидный JSON? Проверьте формат ответа.
4. Доступен ли `~/.fan/agent/mcp-tokens.json` для записи?

### Worker не может использовать MCP-инструменты

**Проверьте:**
1. Установлено ли расширение `fan-mcp` и загружено ли оно?
2. Показывает ли оркестратор "catalog received" в логах?
3. Инициализирован ли broker handler? `/mcp status` показывает подключённые серверы.
4. Не слишком ли строга профильная фильтрация worker'а? Worker'ы с read-only доступом не могут вызывать write-инструменты.

### Изменения конфигурации не применяются

Используйте `/mcp reload` для перезагрузки конфигурации и переподключения. Расширение читает конфиг один раз при `session_start`.

---

## Архитектура пакета

```
fan-mcp расширение
  ├── src/config.ts          — Загрузчик конфига, TypeBox валидация, разрешение env-переменных
  ├── src/transport.ts       — Фабрики Stdio + Streamable HTTP транспортов
  ├── src/manager.ts         — Жизненный цикл клиентских соединений, обработка падений, авто-перезапуск
  ├── src/adapter.ts         — MCP tool → AgentTool конвертер (JSON Schema → TypeBox)
  ├── src/executor.ts        — Выполнение инструмента с таймаутом + обёртка логирования
  ├── src/permissions.ts     — Gate разрешений (allowed/denied tools, glob-сопоставление)
  ├── src/logger.ts          — Структурированный JSON-lines логгер с санитацией секретов
  ├── src/oauth.ts           — OAuth 2.0 PKCE поток (verifier, challenge, обмен токенами)
  ├── src/timeout.ts         — Утилита AbortController для отмены вызовов
  └── src/index.ts           — Фабрика расширения (lifecycle hooks, /mcp команды)

core (вне расширения)
  ├── packages/coding-agent/src/core/event-bus.ts                    — LastEvent кеш (replay-on-subscribe)
  ├── packages/coding-agent/src/modes/rpc/rpc-types.ts               — Типы удалённых инструментов (request/response/cancel/catalog)
  ├── packages/coding-agent/src/modes/rpc/rpc-mode.ts                — Карта корреляции pendingRemoteToolRequests
  ├── packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts       — RemoteProxyTool для пересылки worker→parent
  ├── packages/coding-agent/src/core/agent-session.ts               — Метод registerCustomTools
  └── packages/coding-agent/src/cli/args.ts                          --remote-tools CLI-флаг

orchestrator расширение
  ├── extensions/fan-orchestrator/broker-handler.js                  — Подписчик каталога, маршрутизация прокси-инструментов
  └── extensions/fan-orchestrator/orchestrator-extension.js          — Инициализация broker handler при старте сессии
```

### Статус фаз

| Фаза | Возможности | Статус |
|------|-------------|--------|
| **1** | Ядро MCP-клиента: транспорты, обнаружение инструментов, конфиг, разрешения, жизненный цикл | ✅ Завершено |
| **2** | Worker Proxy: RemoteProxyTool, broker-handler, catalog broadcast, профильная фильтрация | ✅ Завершено |
| **3** | Авто-перезапуск, `/mcp` команды, логирование/метрики, структурированный контент, заглушка API gateway | ✅ Завершено |
| **4** | OAuth (PKCE), полный мост API gateway, MCP-карточка дашборда | 🔶 Частично |

---

## См. также

- [Спецификация Model Context Protocol](https://modelcontextprotocol.io/)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [Документация API расширений FAN](../docs/extensions.md)
- [Руководство по оркестратору](./orchestrator.md)
- [Справочник API](./api-reference.md)
