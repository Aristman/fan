# MCP (Model Context Protocol) в FAN

> **Исходный код:** `packages/mcp/` (встроенное расширение `@fan/mcp`, версия `0.1.0`)
> **Тесты:** 241+ (19 файлов тестов в `packages/mcp/test/`)

Подключите FAN к внешним серверам Model Context Protocol (MCP) и предоставьте их
инструменты как нативные AgentTool в FAN. Инструменты MCP становятся доступны как
`mcp__<serverId>__<toolName>` и работают точно так же, как встроенные инструменты —
LLM может вызывать их напрямую через цикл агента.

---

## Содержание

1. [Что такое MCP в FAN](#1-что-такое-mcp-в-fan)
2. [Быстрый старт](#2-быстрый-старт)
3. [Справочник по конфигурации](#3-справочник-по-конфигурации)
4. [Использование виджета (TUI)](#4-использование-виджета-tui)
5. [Slash-команды](#5-slash-команды)
6. [Фильтрация инструментов](#6-фильтрация-инструментов)
7. [Примеры конфигурации](#7-примеры-конфигурации)
8. [Решение проблем](#8-решение-проблем)
9. [Архитектура](#9-архитектура)
10. [Заметки по безопасности](#10-заметки-по-безопасности)

---

## 1. Что такое MCP в FAN

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — это открытый
стандарт для подключения LLM-агентов к внешним инструментам, источникам данных
и API. MCP-сервер предоставляет **инструменты** (вызываемые функции), **ресурсы**
(статические/динамические данные) и **промпты** (переиспользуемые шаблоны промптов)
через JSON-RPC транспорт.

FAN реализует **клиентскую** сторону MCP. При запуске сессии FAN:

1. Читает `mcp.json` с диска (глобальная и/или проектная конфигурация).
2. Подключается к каждому настроенному MCP-серверу через `stdio` или
   `streamable-http`.
3. Вызывает `tools/list` на каждом сервере для обнаружения доступных инструментов.
4. Регистрирует каждый инструмент как нативный AgentTool FAN с именем
   `mcp__<serverId>__<toolName>`.
5. Обрабатывает вызовы `tools/call`, перенаправляя их соответствующему серверу.

**Что получает пользователь:** любой MCP-совместимый сервер мгновенно предоставляет
свои инструменты агенту FAN, появляясь рядом со встроенными инструментами в реестре
агента. Код интеграции не требуется.

---

## 2. Быстрый старт

### 2.1 Предварительные требования

- FAN установлен и работает (команда `fan` доступна)
- (Для stdio-серверов) Исполняемый файл MCP-сервера или Node-пакет доступен,
  например `npx @modelcontextprotocol/server-filesystem`

### 2.2 Создание конфигурации

Создайте `~/.fan/agent/mcp.json` с простейшей настройкой — файловый сервер:

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

### 2.3 Запуск FAN

```bash
fan
```

При запуске сессии расширение подключается ко всем настроенным серверам.
Вы должны увидеть зарегистрированные инструменты:

```
mcp__0__read_file
mcp__0__write_file
mcp__0__read_directory
mcp__0__search_files
mcp__0__get_file_info
```

### 2.4 Проверка подключения

Используйте slash-команду:

```
/mcp status
```

Ожидаемый вывод:

```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
```

Или откройте интерактивный виджет с помощью **`Alt+M`** или **`F4`**.

### 2.5 Использование инструментов

Инструменты теперь доступны агенту. Например, агент может вызвать
`mcp__0__read_file` для чтения файла, `mcp__0__search_files` для поиска и т.д.

---

## 3. Справочник по конфигурации

### 3.1 Расположение конфигурационных файлов

| Путь | Область | Поведение |
|------|---------|-----------|
| `~/.fan/agent/mcp.json` | **Глобальная** — все проекты | Базовые определения |
| `$CWD/.fan/mcp.json` | **Проектная** | Переопределяет глобальную по тому же индексу; новые серверы добавляются |

Оба файла используют форму массива `servers: []`. ID сервера — это индекс массива
(0, 1, 2, …). Конфигурации объединяются по индексу: `project[i]` заменяет `global[i]`.

### 3.2 Поля McpServerConfig

Полная схема из `packages/mcp/src/config.ts`:

| Поле | Тип | По умолчанию | Транспорт | Описание |
|------|-----|-------------|-----------|----------|
| `transport` | `"stdio"` \| `"streamable-http"` | **обязательно** | оба | Протокол транспорта |
| `name` | `string` | команда/url/`"Server #<n>"` | оба | Отображаемое имя в TUI-виджете |
| `command` | `string` | — | stdio | Имя исполняемого файла или абсолютный путь |
| `args` | `string[]` | `[]` | stdio | Аргументы командной строки |
| `env` | `Record<string, string>` | безопасные значения по умолчанию | stdio | Переменные окружения (поддерживается `${VAR}`) |
| `url` | `string` | — | http | URL конечной точки MCP |
| `headers` | `Record<string, string>` | — | http | HTTP-заголовки (поддерживается `${VAR}`) |
| `allowedTools` | `string[]` | `["*"]` | оба | Glob-шаблоны — инструмент должен совпадать хотя бы с одним |
| `deniedTools` | `string[]` | `[]` | оба | Glob-шаблоны — блокирует совпадающие инструменты (высший приоритет) |
| `timeout` | `number` | `60000` | оба | Таймаут вызова инструмента (мс), диапазон 1000–300000 |
| `autoRestart` | `boolean` | `false` | оба | Автоматический перезапуск при падении с экспоненциальной задержкой |
| `silentStderr` | `boolean` | `true` | stdio | Подавляет stderr MCP-сервера в TUI |
| `allowLocal` | `boolean` | `false` | http | Разрешить адреса loopback (127.0.0.0/8, ::1) |
| `allowPrivate` | `boolean` | `false` | http | Разрешить адреса частных сетей (RFC 1918, CGNAT, link-local) |
| `oauth` | `object` | — | http | Конфигурация OAuth 2.0 PKCE (см. §3.3) |

**Валидация:** Конфигурация проверяется по схеме TypeBox (`McpServerConfigSchema`
в `config.ts`). Некорректные конфигурации выводят предупреждение и безопасно
пропускаются.

### 3.3 OAuth-конфигурация

```typescript
interface OAuthConfig {
  clientId: string;
  clientSecret?: string;     // Для конфиденциальных клиентов
  authorizationUrl: string;  // URL для запроса кода авторизации
  tokenUrl: string;          // URL для обмена/обновления токена
  scopes?: string[];         // OAuth-области (scopes)
}
```

### 3.4 Подстановка переменных окружения

Значения, содержащие `${VAR}`, разрешаются из `process.env` при загрузке
конфигурации:

```json
{
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}"
  },
  "env": {
    "DATABASE_URL": "${DB_CONNECTION_STRING}"
  }
}
```

Если указанная переменная окружения не определена, выбрасывается
`MissingEnvVarError`, и конфигурация этого сервера не загружается.

### 3.5 Безопасные значения env по умолчанию (stdio)

Если для stdio-сервера не указан собственный `env`, наследуются только следующие
переменные из `process.env` (определены в `SAFE_ENV_VARS` в `transport.ts`):

- `PATH`
- `HOME`
- `LANG`
- `LC_ALL`
- `TMPDIR`
- `USERPROFILE`

Это предотвращает случайную утечку секретов, таких как `TOKEN`, `API_KEY`,
`DATABASE_URL`.

---

## 4. Использование виджета (TUI)

Виджет MCP — это полноэкранный браузер для управления MCP-серверами,
открывается с помощью **`Alt+M`** или **`F4`** (зарегистрированы как глобальные
горячие клавиши в `index.ts`).

### 4.1 Открытие виджета

| Горячая клавиша | Действие |
|-----------------|----------|
| `Alt+M` | Открыть/закрыть MCP-виджет (переключение) |
| `F4` | Открыть/закрыть MCP-виджет (переключение) |

Виджет представляет собой полноэкранное наложение в стиле Store. Он открывается
поверх текущего вида сессии и возвращает вас на ту же позицию при закрытии.

### 4.2 Просмотр серверов (Уровень 1)

При открытии виджет показывает список всех настроенных MCP-серверов:

```
╭─ MCP Servers ─────────────────────────────────────────╮
│ ✓ npx                                 5 tools         │  ← зелёный фон
│ ✗ github-mcp-server                   ! 0 tools       │  ← тусклый красный фон
│ ⟳ server-3                           0 tools         │  ← жёлтый текст, нет фона
│ ...                                                     │
├────────────────────────────────────────────────────────┤
│ ↑↓ навигация · Enter инструменты · Space переключить · Esc закрыть   │
╰────────────────────────────────────────────────────────╯
```

**Визуальные индикаторы статуса (цвета фона):**

| Статус | Иконка | Фон | Цвет текста |
|--------|--------|-----|-------------|
| `connected` (подключён) | ✓ (зелёный) | Тёмно-зелёный (ANSI 22) | `theme.fg("success")` |
| `connecting` (подключение) | ⟳ (жёлтый) | Нет | `theme.fg("warning")` |
| `unavailable` (недоступен) | ! (красный) | Ярко-красный (ANSI 124) | `theme.fg("error")` |
| `disabled` (отключён) | ✗ (тусклый) | Тёмно-красный (ANSI 52) | `theme.fg("dim", fg("error"))` |

**Реализация цветов** (`widget.ts`):

| Статус | ANSI-escape |
|--------|-------------|
| connected | `\x1b[48;5;22m` (зелёный фон) + `theme.fg("success")` |
| unavailable | `\x1b[48;5;124m` (ярко-красный фон) + `theme.fg("error")` |
| disabled | `\x1b[48;5;52m` (тёмно-красный фон) + `theme.fg("dim", fg("error"))` |
| connecting | Нет фона + `theme.fg("warning")` |

**Навигация:**

| Клавиша | Действие |
|---------|----------|
| `↑` / `k` | Выбрать предыдущий сервер |
| `↓` / `j` | Выбрать следующий сервер |
| `Enter` | Открыть список инструментов для выбранного сервера |
| `Space` | Переключить подключение/отключение сервера (inline, задержка 300 мс) |
| `Esc` / `q` | Закрыть виджет |

### 4.3 Просмотр инструментов (Уровень 2)

После нажатия `Enter` на сервере виджет показывает его инструменты:

```
╭─ Tools: npx ───────────────────────────────────────────╮
│ ✓ read_file                                            │
│ ✓ write_file                                           │
│ ✓ read_directory                                       │
│ ✗ search_files                                         │  ← отключён по Space
│ ✓ get_file_info                                        │
│ ...                                                     │
├────────────────────────────────────────────────────────┤
│ ↑↓ навигация · Space переключить · Esc назад            │
╰────────────────────────────────────────────────────────╯
```

| Клавиша | Действие |
|---------|----------|
| `↑` / `k` | Выбрать предыдущий инструмент |
| `↓` / `j` | Выбрать следующий инструмент |
| `Space` | Включить/отключить выбранный инструмент (inline, задержка 300 мс) |
| `Esc` / `q` | Вернуться к списку серверов |

Переключение инструментов происходит **inline** — виджет остаётся открытым,
без пересоздания и мерцания. Отключённый инструмент добавляется в `deniedTools`
в конфигурации сервера и немедленно удаляется из реестра инструментов агента
через `setToolEnabled()` → `refreshServerTools()`.

### 4.4 Защита от дребезга (debounce)

Как переключение серверов, так и переключение инструментов защищены от дребезга
с задержкой 300 мс (проверка `lastToggleAt`) для предотвращения мерцания и
шквала промисов при быстром нажатии `Space`.

---

## 5. Slash-команды

Команда `/mcp` (зарегистрирована в `index.ts` через `fan.registerCommand("mcp", ...)`)
предоставляет управление в стиле CLI:

| Команда | Описание |
|---------|----------|
| `/mcp status` | ASCII-таблица всех серверов со статусом, транспортом, количеством инструментов |
| `/mcp list` | Упрощённая сводка — одна строка на сервер |
| `/mcp reload` | Закрыть все соединения, перечитать конфигурацию с диска, переподключиться |
| `/mcp <name> connect` | Подключить конкретный сервер по имени или индексу |
| `/mcp <name> disconnect` | Отключить конкретный сервер по имени или индексу |

### 5.1 Пример вывода `/mcp status`

```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
 1 | unavailable  | streamable-http  | 0 tools (connect timeout 5000ms)
```

Статусы: `connected` (подключён), `connecting` (подключение), `unavailable`
(падение) или `disabled` (отключён вручную).

### 5.2 Пример вывода `/mcp list`

```
MCP Servers:
✓ [#0] npx — connected — 5 tools
✗ [#1] github-api — unavailable — 0 tools (connect timeout 5000ms)
```

### 5.3 `/mcp <name> connect/disconnect`

Поиск сервера:
1. Сначала по числовому индексу (например, `/mcp 0 connect`)
2. По имени (без учёта регистра, например `/mcp npx disconnect`)

---

## 6. Фильтрация инструментов

### 6.1 allowedTools / deniedTools

Каждый сервер может ограничить, какие инструменты доступны агенту:

```json
{
  "allowedTools": ["read_*", "list_*"],
  "deniedTools": ["delete_file", "write_*"]
}
```

**Правила приоритета** (реализованы в `permissions.ts`, `filterToolsByConfig()`):

1. `deniedTools` проверяется **в первую очередь** — если инструмент совпадает
   с любым запрещающим шаблоном, он блокируется.
2. Если `allowedTools` не задан, по умолчанию используется `["*"]`
   (все инструменты разрешены, кроме запрещённых).
3. Если `allowedTools` задан, инструмент должен совпадать **хотя бы с одним**
   разрешающим шаблоном.
4. `deniedTools` имеет приоритет над `allowedTools` — инструмент из обоих
   списков запрещён.

**AllowedTools/deniedTools используют ИСХОДНЫЕ имена MCP-инструментов**
(без префикса `mcp__<server>__`). Для инструмента с именем `mcp__0__read_file`
фильтр применяется к `read_file`, а не к `mcp__0__read_file`.

Если имя инструмента содержит `__` и не начинается с `mcp__`, модуль фильтрации
выводит предупреждение:
> `filterToolsByConfig: tool name "foo__bar" contains "__" — did you mean just "bar"?`

### 6.2 Детали glob-шаблонов

Шаблоны — это простые wildcard-глоббинги (один `*` совпадает с любой
последовательностью):

| Шаблон | Совпадает | Не совпадает |
|--------|-----------|--------------|
| `read_*` | `read_file`, `read_directory` | `write_file` |
| `*` | Всё | — |
| `mcp__*` | Все MCP-инструменты с этим префиксом | Встроенные инструменты |

**Ограничения безопасности** (из `matchGlob()` в `permissions.ts`):

- Максимальная длина шаблона: **256 символов**
- Максимальное количество звёздочек: **10**
- При превышении лимитов: безопасное сравнение подстрок (без regex) для
  предотвращения ReDoS

### 6.3 Оперативное переключение через виджет (уровень инструментов)

Нажатие `Space` на инструменте в виджете переключает его состояние
(включён/отключён). При этом вызывается `setToolEnabled()` в менеджере,
который:

1. Добавляет/удаляет имя инструмента из `deniedTools`.
2. Вызывает `permissions.updateConfig()` для обновления шлюза разрешений.
3. Перерегистрирует инструменты сервера через `refreshServerTools()`
   (на основе разницы).

Изменения применяются немедленно — без обновления файла конфигурации
и без перезапуска сервера.

### 6.4 Оперативное переключение через виджет (уровень сервера)

Нажатие `Space` на записи сервера переключает подключение/отключение без
пересоздания виджета:

- Если подключён → вызывает `disconnectOne()` → помечает как отключённый,
  удаляет все инструменты из реестра.
- Если отключён → вызывает `connectOne()` → подключается, перерегистрирует
  инструменты.

---

## 7. Примеры конфигурации

### 7.1 GitHub MCP-сервер

`github-mcp-server` требует GitHub PAT (Personal Access Token). На Windows
передача переменных окружения Docker может быть нетривиальной — обходной
путь через `-e` в аргументах:

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "allowedTools": ["search_*", "get_*"],
      "deniedTools": ["create_*", "update_*", "delete_*"],
      "timeout": 30000
    }
  ]
}
```

Это делает сервер **доступным только для чтения** для агента (только `search_*`
и `get_*` инструменты).

### 7.2 Файловый MCP-сервер

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "allowedTools": ["read_file", "read_directory", "search_files", "get_file_info"],
      "deniedTools": ["write_file", "delete_file"],
      "timeout": 15000,
      "autoRestart": true
    }
  ]
}
```

Файловая система только для чтения, автоматический перезапуск при падении.

### 7.3 Streamable HTTP-сервер (удалённый)

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/api",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}",
        "X-Request-Id": "fan-mcp"
      },
      "allowedTools": ["*"],
      "timeout": 60000,
      "autoRestart": true
    }
  ]
}
```

### 7.4 Несколько серверов

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "name": "Filesystem Server"
    },
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "name": "GitHub"
    },
    {
      "transport": "streamable-http",
      "url": "https://mcp.mycompany.com",
      "name": "My Company API"
    }
  ]
}
```

Индексы серверов: 0 = Filesystem, 1 = GitHub, 2 = My Company.
Инструменты регистрируются как `mcp__0__read_file`, `mcp__1__search_repos`,
`mcp__2__...`.

### 7.5 Streamable HTTP с OAuth

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "url": "https://api.secure-service.com/mcp",
      "oauth": {
        "clientId": "fan-client",
        "clientSecret": "${OAUTH_CLIENT_SECRET}",
        "authorizationUrl": "https://auth.secure-service.com/authorize",
        "tokenUrl": "https://auth.secure-service.com/token",
        "scopes": ["openid", "profile", "tools:read"]
      }
    }
  ]
}
```

### 7.6 Проектное переопределение

**`~/.fan/agent/mcp.json`** (глобальный):
```json
{
  "servers": [
    { "transport": "stdio", "command": "bun", "args": ["server-a.js"] },
    { "transport": "stdio", "command": "bun", "args": ["server-b.js"] }
  ]
}
```

**`$CWD/.fan/mcp.json`** (проектное переопределение):
```json
{
  "servers": [
    { "transport": "stdio", "command": "bun", "args": ["server-a-local.js"], "allowedTools": ["read_*"] }
  ]
}
```

Результат: сервер 0 → проектная конфигурация (переопределяет глобальную),
сервер 1 → глобальная конфигурация.

---

## 8. Решение проблем

### 8.1 Сервер показывает статус "unavailable"

**Возможные причины:**

| Причина | Проверка | Исправление |
|---------|----------|-------------|
| Команда не найдена | Запустите команду вне FAN | Установите необходимые зависимости, проверьте `PATH` |
| MCP-сервер упал | Проверьте `~/.fan/agent/logs/mcp-*.log` | Исправьте ошибки сервера, включите `autoRestart` |
| Таймаут подключения (5 с) | Сервер медленно запускается? | Увеличьте поле `timeout` |
| Docker недоступен | Используется Docker-сервер | Убедитесь, что Docker установлен и запущен |
| Отказано в доступе (Windows) | FAN не запущен от администратора | Запустите FAN от имени администратора |
| Синтаксическая ошибка в конфиге | Следите за предупреждениями валидации в консоли | Проверьте синтаксис `mcp.json` |

### 8.2 Инструменты не отображаются

| Причина | Проверка | Исправление |
|---------|----------|-------------|
| Сервер не подключён | `/mcp status` показывает `unavailable` | См. §8.1 |
| Отфильтровано `allowedTools` | Попробуйте `"allowedTools": ["*"]` | Расширьте фильтры инструментов |
| Отфильтровано `deniedTools` | Проверьте шаблоны `deniedTools` | Удалите или скорректируйте шаблоны |
| Сервер возвращает пустой tools/list | Протестируйте с `mcp-cli` или SDK | Убедитесь, что сервер имеет инструменты |

### 8.3 OAuth-процесс не завершается

| Проблема | Проверка | Исправление |
|----------|----------|-------------|
| URL авторизации не виден | Ищите `OAuth: open the following URL` в stderr | Запустите FAN в видимом терминале, а не в фоне |
| Сервер обратного вызова недоступен | Docker-контейнер не может достичь `127.0.0.1` | Используйте host-сеть или настройте порт обратного вызова |
| Ошибки конечной точки токена | Проверьте формат ответа | Убедитесь, что сервер возвращает стандартный OAuth JSON |
| Файл токенов не доступен для записи | `~/.fan/agent/mcp-tokens.json` | Проверьте права доступа к файловой системе |

### 8.4 OAuth-цикл device code (Docker)

При запуске FAN внутри Docker с MCP-серверами, которые ожидают OAuth:

1. Сервер обратного вызова слушает `127.0.0.1` внутри контейнера, недоступного
   из браузера на хосте.
2. URL авторизации выводится в stderr, но открытие его в браузере не позволит
   достичь сервера обратного вызова.

**Обходной путь:** Настройте достижимый порт обратного вызова с помощью
`--network host` или проброса порта. Полноценное решение требует настраиваемого
`redirectUri` (ещё не реализовано).

### 8.5 Изменения не применяются

- Конфигурация MCP читается **один раз** при `session_start`.
- После редактирования `mcp.json` используйте **`/mcp reload`** для
  повторного чтения и переподключения.
- Переключение инструментов через виджет применяется немедленно и не требует
  перезагрузки.

### 8.6 Воркер не может использовать MCP-инструменты (режим Orchestrator)

| Проблема | Проверка | Исправление |
|----------|----------|-------------|
| `fan-mcp` не загружен | `fan store list` показывает `fan-mcp`? | Установите недостающее расширение |
| Брокер не инициализирован | Логи Orchestrator показывают "catalog received"? | Проверьте расширение оркестратора |
| Профиль воркера слишком строгий | Воркеры readonly заблокированы от write-инструментов | Используйте профиль `implement`/`bug-fix` |

### 8.7 Ошибка валидации конфигурации

Типичный формат ошибки:

```
mcp.json: Invalid mcp config: [{"path":"/servers/0","message":"Required property 'transport'"}]
```

Проверьте, что все обязательные поля присутствуют и имеют правильный тип.
Схема конфигурации имеет `additionalProperties: false` — неизвестные поля
отклоняются.

---

## 9. Архитектура

### 9.1 Структура пакета

```
packages/mcp/
├── src/
│   ├── index.ts          — Фабрика расширения, хуки жизненного цикла, горячие клавиши, команда /mcp
│   ├── config.ts         — Загрузчик конфигурации, валидация по схеме TypeBox, подстановка env-переменных
│   ├── transport.ts      — Фабрики StdioClientTransport и StreamableHTTPClientTransport
│   ├── manager.ts        — McpClientManager: жизненный цикл, обработка падений, авто-перезапуск
│   ├── adapter.ts        — Конвертер MCP-инструмента в AgentTool (JSON Schema → TypeBox)
│   ├── executor.ts       — Выполнение инструмента с таймаутом, привязкой abort-сигнала, прогрессом
│   ├── permissions.ts    — Шлюз разрешений (allowedTools/deniedTools, glob-сопоставление)
│   ├── logger.ts         — Структурированный JSON-lines логгер с санитизацией секретов
│   ├── oauth.ts          — OAuth 2.0 PKCE flow (code verifier, challenge, обмен токенов)
│   └── widget.ts         — TUI-компонент McpWidget (2-уровневый конечный автомат)
└── test/                 — 19 файлов тестов (241+ тестов)
```

### 9.2 Основные модули

#### config.ts (`createMcpConfigLoader`, `loadMcpConfig`)

- Читает `~/.fan/agent/mcp.json` (глобальный) и `$CWD/.fan/mcp.json` (проектный).
- Валидирует по схеме TypeBox с `additionalProperties: false`.
- Объединяет по индексу массива: `project[i]` переопределяет `global[i]`,
  новые добавляются в конец.
- Разрешает ссылки `${ENV_VAR}` в `env` и `headers` через `resolveEnvVars()`.
- Отсутствующие файлы молча пропускаются; некорректный JSON/схема выводят
  предупреждение.

#### manager.ts (`createMcpClientManager`)

Центральный конечный автомат для всех подключений к MCP-серверам.

**Переходы состояний:**

```
┌────────────┐   connect    ┌─────────────┐   success    ┌─────────────┐
│  disabled  │ ───────────→ │  connecting  │ ───────────→ │  connected  │
└────────────┘              └─────────────┘              └─────────────┘
      ↑                           │                            │
      │         connect            │ fail/error                 │ crash
      │         (reconnect)        │                            │
      │                           ↓                            ↓
      │                     ┌──────────────┐            ┌──────────────┐
      │                     │ unavailable  │  ←──────── │  (crash)     │
      └─────────────────────┤ auto-restart │            └──────────────┘
                            └──────────────┘
```

**Ключевые возможности:**
- `connectAll(config)`: Подключает все серверы параллельно. Сбои изолированы
  (F-1.16).
- `connectOne(index)`: Подключает один сервер с таймаутом подключения 5 с.
- `disconnectOne(index)`: Помечает как отключённый, удаляет инструменты,
  закрывает транспорт.
- `setToolEnabled(serverIdx, toolName, enabled)`: Переключает состояние
  инструмента через `refreshServerTools()`.
- `reloadConfig(configLoader)`: Удаляет всё, перечитывает конфигурацию,
  переподключается.

**Обработка падений** (F-1.17):
- Транспорт `onclose` → `handleCrash()` → удаляет все инструменты,
  помечает как недоступный.
- Если `autoRestart: true` → экспоненциальная задержка (1 с, 2 с, 4 с, 8 с,
  16 с, макс. 5 попыток в окне 60 с).

**list_changed** (F-1.15):
- SDK-конфиг: `autoRefresh: false`, `debounceMs: 500`.
- Пользовательский `onChanged` → `refreshServerEntries()` →
  перерегистрация инструментов на основе разницы.

#### transport.ts (`createStdioTransport`, `createHttpTransport`)

**Stdio:** Использует `StdioClientTransport` из `@modelcontextprotocol/sdk`.
- `shell:
**Stdio:** Использует `StdioClientTransport` из `@modelcontextprotocol/sdk`.
- `shell: false` — принудительно задаётся SDK.
- `silentStderr: true` (по умолчанию) → stderr направляется в `/dev/null`/`nul`.
- Безопасные переменные окружения, если не задан собственный `env`.

**Streamable HTTP:** Использует `StreamableHTTPClientTransport` из SDK.
- Валидация: только протокол `https:` (отклоняет `http:`).
- Проверка loopback: `127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0` → требуется `allowLocal: true`.
- Проверка частных сетей: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10` → требуется `allowPrivate: true`.
- Внедрение OAuth-токена в заголовок Authorization.

#### permissions.ts (`createPermissionGate`, `filterToolsByConfig`)

- `gate(event)`: Вызывается на каждое событие `tool_call`. Разбирает `mcp__<serverId>__<toolName>`, проверяет `deniedTools` → `allowedTools`, возвращает `block: true` или `{}`.
- `filterToolsByConfig(tools, config)`: Фильтрует список инструментов по шаблонам allowed/denied при регистрации.
- `isValidServerId(id)`: Отклоняет не-десятичные строки, такие как `"0e0"`, `"-0"`, `"+1"` (исправление BUG-2).
- Glob-сопоставление с защитой от ReDoS (лимиты 256 символов / 10 звёздочек).
- Предупреждение на именах инструментов с `__`, не начинающихся с `mcp__` (обнаружение неверной конфигурации).

#### executor.ts (`executeMcpTool`, `mapCallToolResult`)

- Оборачивает MCP `CallToolResult` → FAN `AgentToolResult`.
- Поддерживаемое сопоставление контента: `text` → `TextContent`, `image` → `ImageContent`.
- Неподдерживаемые типы контента (audio, resource) → текстовый fallback `[Unsupported content types: ...]`.
- Таймаут по умолчанию 60 с с `AbortController`.
- Привязка сигналов: объединяет сигнал прерывания вызывающей стороны с сигналом таймаута.
- Троттлинг прогресса: высокочастотные уведомления MCP о прогрессе группируются с интервалом 50 мс.

#### oauth.ts (PKCE flow)

Компоненты:
- `generateCodeVerifier()` / `generateCodeChallenge(verifier)`: S256 PKCE.
- `generateState()`: CSRF-параметр состояния.
- `parseWwwAuthenticate(header)`: Разбирает `WWW-Authenticate: Bearer realm="...", error="..."`.
- `createCallbackServer(expectedState, onCode)`: Локальный HTTP-сервер на `127.0.0.1:random`.
- `exchangeCodeForToken(...)`: POST на tokenUrl с PKCE code_verifier.
- `refreshAccessToken(...)`: POST с `grant_type=refresh_token`.
- `TokenStore`: JSON-файл `~/.fan/agent/mcp-tokens.json` (режим 0o600).
- `ensureValidToken(config, serverId, store)`: Высокоуровневая проверка: проверить хранилище → обновить → полный цикл.

#### logger.ts (Структурированное логирование)

- Записывает в `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`.
- События: `tool_call_start`, `tool_call_end`, `tool_call_error`.
- Никогда не логирует: аргументы, содержимое, PII, секреты.
- `sanitizeMessage()` редактирует: Bearer-токены, hex/base64 строки длиной 32+ символа, `api_key`, `token`, `sk-*`.
- `withLogging(serverId, toolName, execute)`: Оборачивает вызов инструмента логированием start/end/error.

#### adapter.ts (`mcpToolToDefinition`)

- `jsonSchemaToTypeBox(schema)`: Преобразует MCP JSON Schema в TypeBox `TSchema`.
  Поддерживает: object, string, number, integer, boolean, array, enum, вложенные объекты, опциональные поля.
  Откат к `Type.Any()` для `$ref`, `oneOf`, `anyOf`.
- `normalizeToolName(serverId, toolName)`: Генерирует `mcp__<serverId>__<toolName>`.
- `mcpToolToDefinition(serverId, mcpTool, client)`: Полная обёртка AgentTool с делегатом выполнения.

### 9.3 Жизненный цикл

```
session_start
    │
    ├── configLoader.load() → McpConfig
    │
    ├── permissions.updateConfig(servers)
    │
    ├── createMcpClientManager(fan, permissions)
    │
    ├── manager.connectAll(config)
    │       │
    │       ├── Для каждого сервера (параллельно):
    │       │   ├── buildTransport(cfg) → Transport
    │       │   ├── new Client(...) → Client
    │       │   ├── client.connect(transport) — таймаут 5 с
    │       │   ├── client.listTools() → tools
    │       │   ├── filterToolsByConfig(tools, cfg)
    │       │   ├── Для каждого инструмента:
    │       │   │   ├── mcpToolToDefinition(id, tool, client) → ToolDefinition
    │       │   │   └── fan.registerTool(def)
    │       │   └── status = "connected"
    │       │
    │       └── fan.events.emit("mcp:catalog", { servers })
    │
    └── (сервер работает)
            │
            ├── tool_call → permissions.gate(event) → заблокирован или перенаправлен
            │
            ├── transport.onclose → handleCrash → авто-перезапуск (если включён)
            │
            ├── list_changed уведомления → refreshServerTools() (на основе разницы)
            │
            └── команды /mcp status/reload/list/connect/disconnect

session_shutdown
    │
    └── manager.dispose()
            ├── Отмена таймеров авто-перезапуска
            ├── Для каждого сервера:
            │   ├── client.close()
            │   └── transport.close()
            └── (общий таймаут 5 с)
```

### 9.4 Прокси-воркер (режим Orchestrator)

Воркер-агенты (подпроцессы `fan --mode rpc`) **не** загружают расширение `fan-mcp`.
Вместо этого они получают MCP-инструменты через механизм удалённого прокси:

```
Session Start
    │
    ├── fan-mcp подключается к MCP-серверам
    ├── fan-mcp отправляет mcp:catalog через EventBus
    │
    ├── broker-handler.js оркестратора подписывается на mcp:catalog
    │   (EventBus воспроизводит последнее событие для опоздавших подписчиков)
    │
    ├── Оркестратор запускает воркер с --remote-tools="mcp__0__read_file,..."
    │
    ├── Воркер создаёт экземпляры RemoteProxyTool для каждого перечисленного инструмента
    │
    ├── Когда воркер вызывает прокси-инструмент:
    │   ├── remote_tool_request (JSONRPC) → родительский процесс
    │   ├── RPC-режим родителя направляет запрос в brokerHandler
    │   ├── broker handler вызывает реальный MCP-клиент через toolCallHandler
    │   └── remote_tool_response (JSONRPC) → воркер
    │
    └── Фильтрация по профилю:
        - explore/plan/verify/code-research → только инструменты чтения
        - implement/bug-fix/tests-impl → все инструменты
```

**Ключевые файлы вне пакета MCP:**

| Файл | Роль |
|------|------|
| `packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts` | Реализация RemoteProxyTool |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | Типы remote_tool_request/response |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Карта соответствия `pendingRemoteToolRequests` |
| `packages/coding-agent/src/core/event-bus.ts` | EventBus с воспроизведением последнего события |
| `extensions/fan-orchestrator/broker-handler.js` | Подписчик каталога + маршрутизация инструментов |

### 9.5 Event API

События, отправляемые через `fan.events`:

| Событие | Полезная нагрузка | Когда |
|---------|-------------------|-------|
| `mcp:ready` | `{ servers: number }` | После завершения первоначального `connectAll()` |
| `mcp:catalog` | `{ servers: ServerEntry[] }` | После изменений подключения (connect, disconnect, toggle, reload) |

### 9.6 Ключевые проектные решения

**Почему `autoRefresh: false` для list_changed?**
Установка `autoRefresh: true` в SDK привела бы к двойной загрузке инструментов —
внутренний обработчик SDK плюс собственный `refreshServerTools()` FAN. Отключая
автообновление и используя только пользовательский колбэк `onChanged`, FAN
избегает избыточных вызовов `listTools()` и применяет собственную фильтрацию
разрешений при обновлении.

**Почему изоляция по серверам?**
Каждый MCP-сервер подключается независимо через `Promise.allSettled()`. Падение
одного сервера (F-1.17) не влияет на остальные. Это критично, когда один сервер
нестабилен — остальные интеграции продолжают работать.

**Почему имена инструментов включают индекс сервера?**
Пространство имён `mcp__<serverId>__<toolName>` предотвращает коллизии между
серверами, которые предоставляют инструменты с одинаковыми именами (например,
два сервера, оба предоставляющие `read_file`). ID сервера — это индекс массива
конфигурации, а не имя, потому что имена могут пересекаться, а индексы являются
стаби

**Stdio:** Использует `StdioClientTransport` из `@modelcontextprotocol/sdk`.
- `shell: false` — принудительно задаётся SDK.
- `silentStderr: true` (по умолчанию) → stderr направляется в `/dev/null`/`nul`.
- Безопасные переменные окружения, если не задан собственный `env`.

**Streamable HTTP:** Использует `StreamableHTTPClientTransport` из SDK.
- Валидация: только протокол `https:` (отклоняет `http:`).
- Проверка loopback: `127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0` → требуется `allowLocal: true`.
- Проверка частных сетей: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10` → требуется `allowPrivate: true`.
- Внедрение OAuth-токена в заголовок Authorization.

#### permissions.ts (`createPermissionGate`, `filterToolsByConfig`)

- `gate(event)`: Вызывается на каждое событие `tool_call`. Разбирает `mcp__<serverId>__<toolName>`, проверяет `deniedTools` → `allowedTools`, возвращает `block: true` или `{}`.
- `filterToolsByConfig(tools, config)`: Фильтрует список инструментов по шаблонам allowed/denied при регистрации.
- `isValidServerId(id)`: Отклоняет не-десятичные строки, такие как `"0e0"`, `"-0"`, `"+1"` (исправление BUG-2).
- Glob-сопоставление с защитой от ReDoS (лимиты 256 символов / 10 звёздочек).
- Предупреждение на именах инструментов с `__`, не начинающихся с `mcp__` (обнаружение неверной конфигурации).

#### executor.ts (`executeMcpTool`, `mapCallToolResult`)

- Оборачивает MCP `CallToolResult` → FAN `AgentToolResult`.
- Поддерживаемое сопоставление контента: `text` → `TextContent`, `image` → `ImageContent`.
- Неподдерживаемые типы контента (audio, resource) → текстовый fallback `[Unsupported content types: ...]`.
- Таймаут по умолчанию 60 с с `AbortController`.
- Привязка сигналов: объединяет сигнал прерывания вызывающей стороны с сигналом таймаута.
- Троттлинг прогресса: высокочастотные уведомления MCP о прогрессе группируются с интервалом 50 мс.

#### oauth.ts (PKCE flow)

Компоненты:
- `generateCodeVerifier()` / `generateCodeChallenge(verifier)`: S256 PKCE.
- `generateState()`: CSRF-параметр состояния.
- `parseWwwAuthenticate(header)`: Разбирает `WWW-Authenticate: Bearer realm="...", error="..."`.
- `createCallbackServer(expectedState, onCode)`: Локальный HTTP-сервер на `127.0.0.1:random`.
- `exchangeCodeForToken(...)`: POST на tokenUrl с PKCE code_verifier.
- `refreshAccessToken(...)`: POST с `grant_type=refresh_token`.
- `TokenStore`: JSON-файл `~/.fan/agent/mcp-tokens.json` (режим 0o600).
- `ensureValidToken(config, serverId, store)`: Высокоуровневая проверка: проверить хранилище → обновить → полный цикл.

#### logger.ts (Структурированное логирование)

- Записывает в `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`.
- События: `tool_call_start`, `tool_call_end`, `tool_call_error`.
- Никогда не логирует: аргументы, содержимое, PII, секреты.
- `sanitizeMessage()` редактирует: Bearer-токены, hex/base64 строки длиной 32+ символа, `api_key`, `token`, `sk-*`.
- `withLogging(serverId, toolName, execute)`: Оборачивает вызов инструмента логированием start/end/error.

#### adapter.ts (`mcpToolToDefinition`)

- `jsonSchemaToTypeBox(schema)`: Преобразует MCP JSON Schema в TypeBox `TSchema`.
  Поддерживает: object, string, number, integer, boolean, array, enum, вложенные объекты, опциональные поля.
  Откат к `Type.Any()` для `$ref`, `oneOf`, `anyOf`.
- `normalizeToolName(serverId, toolName)`: Генерирует `mcp__<serverId>__<toolName>`.
- `mcpToolToDefinition(serverId, mcpTool, client)`: Полная обёртка AgentTool с делегатом выполнения.

### 9.3 Жизненный цикл

```
session_start
    │
    ├── configLoader.load() → McpConfig
    │
    ├── permissions.updateConfig(servers)
    │
    ├── createMcpClientManager(fan, permissions)
    │
    ├── manager.connectAll(config)
    │       │
    │       ├── Для каждого сервера (параллельно):
    │       │   ├── buildTransport(cfg) → Transport
    │       │   ├── new Client(...) → Client
    │       │   ├── client.connect(transport) — таймаут 5 с
    │       │   ├── client.listTools() → tools
    │       │   ├── filterToolsByConfig(tools, cfg)
    │       │   ├── Для каждого инструмента:
    │       │   │   ├── mcpToolToDefinition(id, tool, client) → ToolDefinition
    │       │   │   └── fan.registerTool(def)
    │       │   └── status = "connected"
    │       │
    │       └── fan.events.emit("mcp:catalog", { servers })
    │
    └── (сервер работает)
            │
            ├── tool_call → permissions.gate(event) → заблокирован или перенаправлен
            │
            ├── transport.onclose → handleCrash → авто-перезапуск (если включён)
            │
            ├── list_changed уведомления → refreshServerTools() (на основе разницы)
            │
            └── команды /mcp status/reload/list/connect/disconnect

session_shutdown
    │
    └── manager.dispose()
            ├── Отмена таймеров авто-перезапуска
            ├── Для каждого сервера:
            │   ├── client.close()
            │   └── transport.close()
            └── (общий таймаут 5 с)
```

### 9.4 Прокси-воркер (режим Orchestrator)

Воркер-агенты (подпроцессы `fan --mode rpc`) **не** загружают расширение `fan-mcp`.
Вместо этого они получают MCP-инструменты через механизм удалённого прокси:

```
Session Start
    │
    ├── fan-mcp подключается к MCP-серверам
    ├── fan-mcp отправляет mcp:catalog через EventBus
    │
    ├── broker-handler.js оркестратора подписывается на mcp:catalog
    │   (EventBus воспроизводит последнее событие для опоздавших подписчиков)
    │
    ├── Оркестратор запускает воркер с --remote-tools="mcp__0__read_file,..."
    │
    ├── Воркер создаёт экземпляры RemoteProxyTool для каждого перечисленного инструмента
    │
    ├── Когда воркер вызывает прокси-инструмент:
    │   ├── remote_tool_request (JSONRPC) → родительский процесс
    │   ├── RPC-режим родителя направляет запрос в brokerHandler
    │   ├── broker handler вызывает реальный MCP-клиент через toolCallHandler
    │   └── remote_tool_response (JSONRPC) → воркер
    │
    └── Фильтрация по профилю:
        - explore/plan/verify/code-research → только инструменты чтения
        - implement/bug-fix/tests-impl → все инструменты
```

**Ключевые файлы вне пакета MCP:**

| Файл | Роль |
|------|------|
| `packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts` | Реализация RemoteProxyTool |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | Типы remote_tool_request/response |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Карта соответствия `pendingRemoteToolRequests` |
| `packages/coding-agent/src/core/event-bus.ts` | EventBus с воспроизведением последнего события |
| `extensions/fan-orchestrator/broker-handler.js` | Подписчик каталога + маршрутизация инструментов |

### 9.5 Event API

События, отправляемые через `fan.events`:

| Событие | Полезная нагрузка | Когда |
|---------|-------------------|-------|
| `mcp:ready` | `{ servers: number }` | После завершения первоначального `connectAll()` |
| `mcp:catalog` | `{ servers: ServerEntry[] }` | После изменений подключения (connect, disconnect, toggle, reload) |

### 9.6 Ключевые проектные решения

**Почему `autoRefresh: false` для list_changed?**
Установка `autoRefresh: true` в SDK привела бы к двойной загрузке инструментов —
внутренний обработчик SDK плюс собственный `refreshServerTools()` FAN. Отключая
автообновление и используя только пользовательский колбэк `onChanged`, FAN
избегает избыточных вызовов `listTools()` и применяет собственную фильтрацию
разрешений при обновлении.

**Почему изоляция по серверам?**
Каждый MCP-сервер подключается независимо через `Promise.allSettled()`. Падение
одного сервера (F-1.17) не влияет на остальные. Это критично, когда один сервер
нестабилен — остальные интеграции продолжают работать.

**Почему имена инструментов включают индекс сервера?**
Пространство имён `mcp__<serverId>__<toolName>` предотвращает коллизии между
серверами, которые предоставляют инструменты с одинаковыми именами (например,
два сервера, оба предоставляющие `read_file`). ID сервера — это индекс массива
конфигурации, а не имя, потому что имена могут пересекаться, а индексы являются
стабильными идентификаторами.

### 9.7 Известные ограничения

| Ограничение | Описание | Планы |
|-------------|----------|-------|
| Нет конфигурации `redirectUri` | URL обратного вызова OAuth генерируется автоматически (`127.0.0.1:random`) | Добавить настраиваемый `redirectUri` |
| Нет автоматического открытия браузера | URL авторизации OAuth выводится в stderr, нужно открывать вручную | Интегрировать `open` / `xdg-open` |
| Хранилище токенов в JSON-файле | `~/.fan/agent/mcp-tokens.json` (режим 0o600) | Интеграция с OS keychain |
| Виджет устаревает после reload | Виджет ссылается на экземпляр менеджера до перезагрузки | Передавать AbortSignal в жизненный цикл виджета |
| Нет карточки на Dashboard | Статус MCP не виден на веб-панели | Отложено на Phase 4 |
| `silentStderr: true` по умолчанию | stderr от подпроцессов MCP-сервера скрыт | Установить `silentStderr: false` для отладки |

---

## 10. Заметки по безопасности

### 10.1 Разрешения вызова инструментов

Каждый вызов MCP-инструмента проходит через **шлюз разрешений** (`createPermissionGate`
в `permissions.ts`) через хук события `tool_call`. Шлюз:

1. Разбирает имя инструмента (`mcp__<id>__<name>`).
2. Валидирует формат ID сервера (предотвращает инъекцию алиасов, например `"0e0"`).
3. Находит конфигурацию сервера по индексу.
4. Проверяет glob-шаблоны `deniedTools` (блокирует при совпадении).
5. Проверяет glob-шаблоны `allowedTools` (блокирует при отсутствии совпадения,
   по умолчанию `["*"]`).
6. Имена инструментов, не являющихся MCP, проходят без изменений.

**Отключённые инструменты НИКОГДА не отправляются LLM.** Шлюз разрешений
работает на двух уровнях:
- **Уровень регистрации**: `filterToolsByConfig()` удаляет запрещённые
  инструменты из списка до их регистрации через `fan.registerTool()`.
- **Уровень вызова**: `gate()` блокирует вызовы, которые каким-либо образом
  достигают отключённого инструмента.

### 10.2 Безопасность транспорта

**Stdio-транспорт:**
- `shell: false` — никакой shell-инъекции через `args`.
- Безопасные переменные окружения по умолчанию — только 6 базовых переменных
  наследуются, если не задан собственный `env`.
- По умолчанию stderr молчалив — предотвращает шум логов MCP-сервера в TUI.

**Streamable HTTP-транспорт:**
- Разрешён только протокол `https:`.
- Loopback-адреса требуют явного `allowLocal: true`.
- Частные сети (RFC 1918, CGNAT, link-local) требуют `allowPrivate: true`.
- Проверка URL и имени хоста выполняется при загрузке конфигурации.

### 10.3 Безопасность OAuth-токенов

- OAuth-токены хранятся в `~/.fan/agent/mcp-tokens.json` с режимом файла
  `0o600` (чтение/запись только владельцем).
- Заголовок Authorization формируется при создании транспорта.
- Обновление токенов выполняется автоматически для истекающих токенов.
- Полный PKCE-цикл требует ручного взаимодействия с браузером (не поддерживается
  в headless CI).

### 10.4 Санитизация секретов в логах

Структурированный логгер (`logger.ts`) применяет regex-редактирование сообщений
об ошибках перед записью:

| Тип шаблона | Пример | Редактирование |
|-------------|--------|----------------|
| Bearer-токены | `Bearer eyJhbGciOi...` | `Bearer ***REDACTED***` |
| Длинные hex/base64 строки (32+ символа) | `dGhpcyBpcyBh...` | `***REDACTED***` |
| Шаблоны API-ключей | `api_key=sk-abc...` | `api_key=***REDACTED***` |
| Шаблоны токенов | `token=ghp_abc...` | `token=***REDACTED***` |
| Ключи в стиле OpenAI | `sk-proj-ABC...` | `sk-***REDACTED***` |

**Чего логи НИКОГДА не содержат:** аргументов инструментов, содержимого ответов, PII.

### 10.5 Защита glob-шаблонов

- Максимальная длина шаблона: 256 символов (предотвращает исчерпание памяти).
- Максимальное количество звёздочек: 10 (предотвращает катастрофический
  возврат / ReDoS).
- При превышении лимитов: безопасное сравнение подстрок (без regex).

### 10.6 Защита от SSRF

| Диапазон адресов | Риск | Требуемый флаг |
|------------------|------|----------------|
| `127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0` | Loopback SSRF | `allowLocal: true` |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | Внутренняя сеть | `allowPrivate: true` (или `allowLocal`) |
| `169.254.0.0/16` | Link-local | `allowPrivate: true` |
| `100.64.0.0/10` | CGNAT | `allowPrivate: true` |
| Все остальные (интернет) | — | Дополнительный флаг не требуется |

### 10.7 Защита от инъекций в конфигурацию

- Валидация JSON Schema (`additionalProperties: false`) отклоняет неизвестные
  ключи конфигурации.
- Ошибки слияния конфигураций перехватываются и безопасно пропускаются
  с предупреждением.
- Ошибки загрузки конфигурации никогда не приводят к падению сессии —
  неподдерживаемые серверы пропускаются.

### 10.8 Лучшие практики

1. **Используйте `deniedTools`** для блокировки опасных операций
   (`write_*`, `delete_*`, `exec_*`).
2. **Устанавливайте `allowedTools` минимальным набором** — выдавайте
   наименьшие привилегии.
3. **Используйте переменные окружения для секретов** (`${GITHUB_TOKEN}`) —
   никогда не хардкодьте в `mcp.json`.
4. **Держите `allowLocal`/`allowPrivate` в значении `false`**, если вы явно
   не нуждаетесь в локальных/частных HTTP-серверах.
5. **Предпочитайте stdio** для локальных MCP-серверов — устраняет сетевую
   экспозицию.
6. **Просматривайте логи** в `~/.fan/agent/logs/mcp-*.log` для выявления
   подозрительной активности.
7. **Запускайте `fan doctor`** для проверки окружения перед отладкой проблем MCP.

---

*Источник документации: `packages/mcp/src/` — 10 файлов исходного кода, 19 файлов тестов, 241+ тест.*
*Статус реализации: Phases 1–3 завершены, Phase 4 (OAuth/Dashboard) частично.*
