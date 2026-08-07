# Changelog

## [2.4.1] — 2026-08-07

### Исправлено

**Доработки по итогам боевого прогона 2.4.0:**

- **Модель воркера в running-рендере** (`fan-orchestrator` 7.10.6) — модель
  теперь передаётся на верхний уровень `details` в onUpdate
  (`subagent-runner.js`) и видна во время выполнения во всех режимах
  (single/chain/parallel), а не только в parallel; ранее single/chain
  показывали `initializing...` всё время работы
- **Окно воркера при принудительном прерывании** (`fan-orchestrator` 7.10.6) —
  исправлена потеря `details`: `onUpdate` в catch-блоке `runSingleAgent`
  обёрнут в try/catch (исключение из onUpdate не отменяет возврат
  errorResult), во все три режима `delegate_task` добавлен `catch` с синтезом
  полного результата. Теперь при ESC окно воркера показывает статус
  `aborted`, модель, таймер и `─── Partial work (N tools) ───` вместо
  пустой строки с текстом ошибки
- **Таймер в футере — активное время агента** (`@seaagents/fan-coding-agent`
  2.3.6) — таймер больше не идёт непрерывно от старта сессии: отсчёт
  работает во время хода агента (`agent_start` → `agent_end`), при
  завершении или принудительном прерывании останавливается, при новом ходе
  продолжает с накопленного значения. Compaction, auto-retry и `!`-bash
  в счёт не идут. Финальная сводка при shutdown показывает накопленное
  активное время. Новый метод `FooterComponent.setElapsedProvider()`
  (опциональный, `setSessionStartTime()` сохранён как fallback)

### Прочее

- Release-скрипты (`release-binaries.sh` / `release-binaries.ps1`) копируют
  корневой CHANGELOG.md в dist-репозиторий (для ссылки из уведомления
  об обновлении)
- Тесты: footer 9/9 (2 новых кейса на `setElapsedProvider`), оркестратор
  158/158

---

## [2.4.0] — 2026-08-07

### Новое

**Таймер сессии в футере TUI** (`@seaagents/fan-coding-agent` 2.3.5):

- В строке футера с токенами и моделью в конце добавлен живой таймер общего
  времени запуска (формат `MM:SS`, после часа — `H:MM:SS`), обновление раз в
  секунду через батчированный `requestRender()`
- Таймер сбрасывается при new/resume/fork/import/clear сессии и сохраняется
  при reload; extension-футеры без `setSessionStartTime()` работают как раньше
  (таймер опционален, публичный API `FooterComponent` не изменён)
- При завершении сессии (`shutdown`) в терминал выводится финальная сводка:
  `Session ended — duration: 12:34 • tokens: 45.2k • cost: $0.123`

**Модель в хедере воркеров** (`fan-orchestrator` 7.10.5):

- Модель воркера показывается перед таймером во всех местах рендера:
  single running (`🤖 model | ⏱ elapsed | 💬 | 🔧`), parallel running,
  chain/parallel expanded/collapsed хедеры, plan-воркер, task widget

### Исправлено

**Проброс ошибок из воркеров в оркестратор** (`fan-orchestrator` 7.10.5):

- `runSingleAgent` проставляет `stopReason: "error" | "aborted"` на всех путях
  падения (exit code, stall-таймер, abort) — ранее ошибка терялась и
  оркестратор видел нормальное завершение
- `onWorkerStop` получает полный `result` и сохраняет `error`/`stopReason`
  в registry (новый хелпер `finalizeWorker()`)
- `isError: true` теперь возвращается во всех режимах `delegate_task`,
  включая parallel (раньше parallel глотал ошибки воркеров)
- Иконки и `failCount` в renderResult учитывают `stopReason`, а не только
  exit code; исправлен race с pre-aborted signal (`wasAborted` выставляется
  до подписки на событие)

**Прерывание воркеров без потери результатов** (`fan-orchestrator` 7.10.5):

- `stop_worker` реально останавливает subprocess: per-worker
  `AbortController`, `child.kill(SIGTERM)` через существующий обработчик
- Статус `aborted` больше не перезаписывается естественным завершением
  subprocess (guard в `finalizeWorker`)
- Registry не очищается при stop/shutdown (`resetSlots()` вместо
  `_resetRegistry()`): виджет показывает прерванных/упавших воркеров 5 минут
  со статусом и фрагментом ошибки, inline collapsed-рендер выводит
  `─── Partial work (N tools) ───`
- `pruneOldWorkers()` (TTL 10 минут) предотвращает утечку registry
  в длинных сессиях

### Прочее

- `@seaagents/fan-tui` 1.1.0 — biome lint-фиксы (character class в regex
  стража редактора, отступы в `terminal.ts`)
- 14 новых тестов `worker-lifecycle` (оркестратор, 158/158 зелёные),
  тесты таймера футера (7/7)

---

## [2.3.11] — 2026-08-03

### Исправлено

**TUI: утечки escape-последовательностей в редактор на Windows ConPTY** (`@seaagents/fan-tui` 1.0.3):

Пользователь наблюдал обрывки escape-кодов в строке ввода: `[1G` (фрагмент
позиционирования курсора, который TUI пишет в stdout) и `A[` при нажатии
Alt+Up (фрагмент `\x1b[1;3A`). Цепочка причин: ConPTY эхо возвращал
escape-коды в stdin → буфер ввода по таймауту выпускал недособранную
последовательность как ложный Escape → хвост вставлялся в редактор как текст.

- `terminal.ts` — сброс `ENABLE_ECHO_INPUT` при включении VT-режима;
  `ENABLE_PROCESSED_INPUT` намеренно НЕ устанавливается (иначе Ctrl+C
  уходит в SIGINT и ломает перехват кейбиндингов TUI)
- `stdin-buffer.ts` — sequence-aware flush: недособранная
  escape-последовательность ждёт до 3 дополнительных циклов, затем тихо
  выбрасывается; одинокий настоящий Escape работает как раньше
- `editor.ts` — fallback вставки отбрасывает многосимвольные CSI-обрывки
  (`[1G`, `[1;3A`); одиночные печатные символы вставляются как прежде
- `keys.ts` — `alt+up`/`alt+down` распознаются и в CSI-формате
  `\x1b[1;3A`/`\x1b[1;3B` (ранее только legacy `\x1bp`/`\x1bn`); полная карта
  модификаторов в `parseKey`
- 8 новых тестов на фрагментацию, модификаторы и страж редактора;
  508/508 тестов пакета зелёные

---

## [2.3.10] — 2026-08-02

### Расширение fan-session-analytics — полная реализация (v1.4.0)

Новое standalone-расширение FAN для анализа истории сессий: читает JSONL-сессии
(read-only), оценивает использование скилов и расширений, скорость, полноту и
правильность флоу работы. Цель — самоулучшение агента через измеримую
обратную связь. Спецификация: `docs/specs/spec_session-analytics_2026-08-02.md`,
план использования: `docs/backlogs/session-analytics-usage-plan.md`.

**Этап A — детерминированный анализ (0 токенов):**
- Парсер JSONL через `parseSessionEntries()` + нормализатор траекторий
  (main branch, multi-toolCall сообщения)
- 13 детекторов: ошибки инструментов (D1), петли (D2), длительность шагов
  только по агентскому времени (D3, user-idle исключён), эффективность пути
  (D4), флоу оркестратора (D5), использование скилов (D6) и расширений (D7),
  уплотнения (D8), токены/стоимость (D9), брошенные вызовы (D10),
  пропорциональность флоу — тяжёлый пайплайн на мелкой задаче (D11),
  маршрутизация воркеров (D12), пустые ретраи после FAIL (D13)
- Markdown-отчёты с баллом 0–100, инструмент `session_analyze` и команда
  `/session-analytics`
- Интерактивный мастер `/session-analytics init` (мультиселект тяжёлых
  скилов из установленных, двухшаговый выбор модели судьи из registry)

**Этап B — LLM-судья:**
- Прямой вызов `complete()` из `@seaagents/fan-ai` (без сабпроцессов),
  цепочка выбора модели: configured → cheapest → current → unavailable
- 6 рубрик 0–3 с явными критериями (уместность скилла, полнота, декомпозиция,
  экономность, регламент, качество оркестрации), батчинг сжатой траектории,
  валидация ответов с retry, combined score = det×0.6 + судья×0.4

**Этап C — автоматизация и интеграции:**
- F9: авто-анализ на `session_shutdown`, однострочный итог при следующем старте
- F10: еженедельный пакетный анализ с трендом против прошлого периода
- F11: вкладка «Аналитика» в дашборде + endpoints `GET /api/analytics/reports[/:name]`
- F12: золотые траектории (`mark-golden`) — сравнение с эталоном через судью
- F13: майнинг паттернов (цепочки воркеров, n-граммы инструментов, шаблоны
  промптов) → рекомендации по синтезу новых скилов/воркеров

**v1.4.0:** единый глобальный архив отчётов `~/.fan/reports/session-analytics/`
(вместо размазывания по проектам, дашборд читает оба места); инкрементальный
анализ — проанализированные сессии помечаются и пропускаются при повторах
(`--force` для полного перепрогона), weekly — только сравнительный.

**Тесты:** 267 (расширение) + 51 (api-gateway) + 23 (dashboard).

### Добавлено

- **`ExtensionUIDialogOptions.initialValue`** (coding-agent 2.3.4) — начальная
  позиция курсора в `ctx.ui.select()` для расширений; используется
  мультиселектом fan-session-analytics
- **Дашборд**: вкладка «Аналитика» — список отчётов с polling 30 с,
  просмотр markdown (dashboard 1.0.3)

### Исправлено

- `store`: проверка обновлений по всем репозиториям отдельно (per-repo)
- `orchestrator`: баги редактирования пресетов, видимость локального
  репозитория store, разрешение неоднозначных ID моделей с префиксом
  провайдера
- Провайдер `qwen`: работа с оркестратором
- CI: циклическая зависимость сборки coding-agent ↔ @fan/mcp; @fan/mcp
  добавлен в цепочку сборки

---

## [2.3.1] — 2026-07-16

### MCP Интеграция — Полный цикл (Phase 1 + 2 + 3)

Пакет `@fan/mcp` (внутреннее имя `fan-mcp`) — встроенное расширение FAN для
подключения к внешним MCP-серверам (Model Context Protocol). Реализован полный
набор roadmap функций (31/32, 96.9%), включая координаторный MCP, прокси
для воркеров, OAuth, авто-восстановление и observability.

Расширение внедрено в ядро FAN так же, как `@fan/store` — через статический
импорт в `loader.ts` + `VIRTUAL_MODULES` + `tsconfig.json paths` + зависимость
в `coding-agent/package.json`. При компиляции FAN бинарника код mcp-расширения
включается статически и доступен сразу после установки без дополнительных шагов.

**Состояние:** 31/32 roadmap-функций реализованы (96.9%). 1 функция (Dashboard
Lit-компонент) отложена на Phase 4 как UX-улучшение.

**Тесты:**
- `packages/mcp`: 283 теста (20 test files)
- `packages/coding-agent`: 1 029 тестов (без регрессий)
- `packages/tui`: 500 тестов
- `packages/api-gateway`: 45 тестов
- Total: ~1 857 тестов

#### Добавлено

**Новый пакет `@fan/mcp`** (ранее `packages/mcp-extension`, переименован в
`packages/mcp`):

- **Координаторный MCP (Phase 1)** — основной агент подключается к
  MCP-серверам напрямую:
  - Транспорты: `stdio` (спавн дочернего процесса) и `Streamable HTTP`
  - Обнаружение инструментов через `tools/list`, динамическое обновление
    каталога через `notifications/tools/list_changed`
  - Конвертер JSON Schema → TypeBox для параметров инструментов
  - Маппинг `CallToolResult` → `AgentToolResult` (текст, изображения,
    fallback для неподдерживаемых типов контента)
  - Сохранение `structuredContent` в `result.details`
  - Загрузчик `mcp.json` с объединением глобального/проектного конфига
  - Фильтрация инструментов: `allowedTools`/`deniedTools` (glob-шаблоны)
  - Permission gate через хук `tool_call` (блокировка до выполнения)
  - Отмена вызовов через `AbortSignal` → MCP cancel
  - Таймауты per-call (по умолчанию 60 с)
  - Разрешение `${ENV_VAR}` в `mcp.json`
  - Graceful shutdown (закрытие клиентов, kill stdio-процессов)
  - Атомарное обновление реестра при `list_changed`
  - Обработка ошибок: недоступный сервер, краш stdio-процесса,
    невалидный `mcp.json` (graceful skip с warning)

- **Worker Proxy (Phase 2)** — воркеры получают MCP-инструменты через
  protocol-neutral прокси без прямой загрузки расширения и без открытия
  собственных MCP-соединений:
  - Типы `RpcRemoteToolRequest` / `Response` / `Cancel` / `Catalog`
    в `rpc-types.ts` (protocol-neutral, без привязки к MCP SDK)
  - Карта корреляции `remoteToolPendingRegistry` в `rpc-mode.ts`
  - CLI-флаг `--remote-tools=<list>` для режима воркера
  - `RemoteProxyTool` — локальный прокси, отправляющий `remote_tool_request`
    на stdout и ожидающий `remote_tool_response` от родителя
  - `broker-handler` в расширении оркестратора — подписывается на
    EventBus `mcp:catalog`, хранит каталог, маршрутизирует вызовы
  - Профильная фильтрация per-worker:
    - `explore` / `plan` / `verify` / `code-research` → только чтение
    - `implement` / `bug-fix` / `tests-impl` → полный доступ
  - Кеш `lastEvent` на `EventBus` (replay-on-subscribe) для опоздавших
    подписчиков

- **Polish & Hardening (Phase 3)**:
  - **OAuth 2.0 + PKCE** — генерация code_verifier/challenge (S256),
    локальный callback-сервер, обмен code→token, refresh-логика,
    файловое хранилище токенов (`~/.fan/agent/mcp-tokens.json`, mode 0o600)
  - **Авто-перезапуск** упавших stdio-серверов с экспоненциальной
    задержкой (1 с → 2 с → 4 с → 8 с → 16 с, макс. 5 попыток за 60 с)
  - **Slash-команды** `/mcp status` и `/mcp reload`
  - **Логгер** — структурированные JSON-lines в
    `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`
  - **Progress forwarding** — MCP progress → FAN `onUpdate` с
    throttle 50 мс (батчинг высокочастотных событий)
  - **API Gateway** — эндпоинт `GET /api/mcp/servers` (заглушка,
    полный runtime-мост в Phase 4)
  - **Seed starter mcp.json** — при первом запуске FAN автоматически
    создаётся `~/.fan/agent/mcp.json` с пустым списком серверов
    (idempotent, не перезаписывает существующий)

#### Изменения в core

| Файл | Строк | Описание |
|------|-------|----------|
| `extensions/types.ts` | +15 | `unregisterTool`, `updateTool` на ExtensionAPI |
| `extensions/loader.ts` | +2 | Импорт `@fan/mcp` + `VIRTUAL_MODULES` entry |
| `event-bus.ts` | +10 | Кеш `lastEvent` (replay-on-subscribe) |
| `rpc-types.ts` | +90 | Protocol-neutral `RpcRemoteTool*` types |
| `rpc-mode.ts` | +60 | Карта корреляции + хендлеры |
| `rpc/remote-proxy-tool.ts` | новый | `RemoteProxyTool` class |
| `cli/args.ts` | +5 | `--remote-tools` CLI-флаг |
| `agent-session.ts` | +10 | `registerCustomTools` метод |
| **Total core** | **~192 строк** | **Ноль импортов MCP SDK в core** |

#### Исправления безопасности (10 багов найдено при adversarial review)

| # | Severity | Баг |
|---|----------|-----|
| BUG-1 | **CRITICAL** | Permission gate создавался с пустым config — все MCP-вызовы блокировались в runtime |
| BUG-2 | HIGH | Server ID alias injection через `Number("0e0") === 0` |
| BUG-3 | HIGH | SSRF через диапазон 127.0.0.0/8 (loopback bypass) |
| BUG-4 | HIGH | Детерминированный баг в тесте TC-F1.7-9 (неправильная позиция аргумента) |
| BUG-5 | CRITICAL | `list_changed` двойной fetch (SDK `autoRefresh` + ручной вызов) |
| BUG-6 | HIGH | matchGlob ReDoS через неограниченные wildcard-шаблоны |
| BUG-7 | LOW | Мёртвый код `pendingRemoteToolRequests` Map |
| BUG-8 | MEDIUM | Несоответствие имён filterToolsByConfig (raw имена) и permission gate (полные имена) |
| BUG-9 | LOW | Утечка секретов в логгер (Bearer-токены, API-ключи) |
| BUG-10 | MEDIUM | 36 TypeScript-ошибок в тестовых файлах |

#### Изменения версий

- **fan** (root) — `2.3.0` → `2.3.1`
- **@fan/mcp** (новый пакет) — `1.0.0`
- Пакет `@fan/mcp-extension` переименован в `@fan/mcp`,
  директория `packages/mcp-extension/` → `packages/mcp/`

---

## [2.3.0] - 2026-07-14

### 📋 Вставка картинок из буфера (TUI)

- **`alt+v` вставляет `[image_N]` вместо полного пути к файлу** — картинка из
  буфера обмена кладётся в `os.tmpdir()` (по-прежнему доступна для `read`),
  а в редактор вставляется компактный маркер `[image_1]`, `[image_2]`, …,
  с монотонным счётчиком за сессию.
- **Картинки уходят агенту напрямую как vision content** — `ImageContent`
  очередь `pendingImages` пробрасывается в `session.prompt(text, { images })`
  во всех 5 submit-путях (compaction, streaming steer/followUp, main loop,
  Alt+Enter followUp). LLM получает base64 + mimeType — никаких лишних
  `read` tool calls.
- Поддерживаемые форматы: PNG / JPEG / WebP / GIF нативно, BMP / TIFF / и др.
  конвертируются в PNG через `@silvia-odwyer/photon-node` (WASM).
- Платформы: Windows / macOS / Linux (Wayland, X11) / WSL.
- `@mariozechner/clipboard` — N-API, optionalDependency (если не установлен —
  вставка молча игнорируется).

### 🎨 Стартовая информация (TUI)

- **Компактные списки Skills и Extensions** — вместо многострочного перечня
  полных путей в startup header теперь одна строка имён через запятую:
  ```
  [Skills]
    code-research, deep-dive, dev-docs-pack, feature-pipeline, feature-roadmap, idea-lab, repo-explorer, research-spec-generator
  ```
  Аналогично для `[Extensions]`.
- **Новый хоткей `alt+s` Store** в начале списка — жирным шрифтом,
  акцентным цветом. Активирует FAN Store (fan-store extension).

### 🔒 Безопасность (оркестратор)

- **Respect `FAN_DANGEROUSLY_SKIP_PERMISSIONS` в permission hook** — теперь
  переменная окружения проверяется первой и UI-аппрув полностью обходится.
  Поведение согласовано с core bash tool: обе стороны пропускают проверки
  опасных команд при установленном флаге.
  (`extensions/fan-orchestrator/orchestrator-extension.js`).

### 🧹 Прочее

- **Linter fixes** в `packages/coding-agent/test/security/permissions.test.ts` —
  убраны избыточные проверки и упрощена структура тестов.

### Изменения версий

- **fan** (root) — `2.2.2` → `2.2.3`.
- **@seaagents/fan-coding-agent** — `2.2.1` → `2.2.3`.

---

## [2.2.0] - 2026-07-08

### 🚀 Pipeline Mode (feature-pipeline v3.1.0)

- **Рабочие артефакты pipeline** — три файла на диске, которые создаются 1 раз
  и обновляются автоматически на каждый `TaskCreate`/`TaskUpdate`:
  - `docs/development-plan.md` — машиночитаемый roadmap.
  - `docs/development-log.md` — append-only журнал выполнения.
  - `.fan/tracking/phase-status.json` — JSON state machine.

- **Команда `/pipeline`** (в `fan-orchestrator` v7.4.0):
  - `init` — интерактивная инициализация: feature-name, commit-strategy, фазы.
  - `status` — прогресс по фазам (widget, 10 сек).
  - `log [N]` — последние N записей из журнала.
  - `finish` — пометить завершённым + выбор: Keep / Delete артефакты.
  - `cancel` — деактивировать в памяти, артефакты сохраняются.

- **Авто-обновление артефактов** — `fan.on("tool_result", ...)` хук:
  на каждый `TaskCreate`/`TaskUpdate` синхронно обновляет `phase-status.json`
  и append в `development-log.md`. Координатор не делает это вручную.

- **State Recovery** — `session_start` автоматически читает
  `.fan/tracking/phase-status.json` и восстанавливает pipeline в памяти.
  После обрыва сессии работа продолжается с места остановки.

- **Commit policy** через conventional-commits:
  - `per-phase` — `feat(phase-N): <name> complete` после завершения фазы.
  - `per-function` — `feat(phase-N/F-X.Y): <summary>` после завершения функции.
  - `manual` — без автокоммитов.

- **Новый модуль `pipeline-state.js`** в `extensions/fan-orchestrator/`:
  атомарные операции (temp + rename), per-path lock Map, UTF-8, без external
  deps.

### Изменения версий

- **fan** (root) — `2.1.0` → `2.2.0`.
- **fan-orchestrator** — `7.3.0` → `7.4.0` (Pipeline Mode).
- **feature-pipeline** skill — `3.0.0` → `3.1.0` (рабочие артефакты, commit policy).

### Документация

- `docs/guides/orchestrator.md` — добавлена секция «Pipeline Mode (v3.1.0)»
  с 10 подразделами (149 строк).

---

## [2.1.0] - 2026-07-08

### 🔒 Безопасность (критическое обновление)

- **Dangerous command detection встроен в core bash tool** — теперь проверка
  опасных команд работает для ВСЕХ процессов FAN (координатор, воркеры, CLI,
  RPC), а не только для оркестратора:
  - `packages/coding-agent/src/core/security/permissions.js` — новый модуль
    с полным набором детекторов.
  - `packages/coding-agent/src/core/tools/bash.ts` — блокировка опасных команд
    непосредственно перед `ops.exec()` через `reject(new Error("Blocked: ..."))`.
  - Экспорт `isDangerousCommand` из `@seaagents/fan-coding-agent` public API.

- **Расширенный набор детекторов** (heredoc, pipes, interpreters, и др.):
  - **Heredoc** — `sh << EOF ... EOF`, `bash <<< "..."` — извлекается тело и
    проверяется.
  - **Pipe analysis** — `curl ... | sh`, `wget ... | bash`, `echo "rm" | bash`.
  - **Interpreter inline** — `node -e`, `python -c`, `perl -e`, `ruby -e` — код
    извлекается и рекурсивно проверяется.
  - **Subshell** — `bash -lc`, `env sh -c`, `xargs sh -c`, `time bash -c`,
    `nohup bash -c`, `sudo bash -c`.
  - **Fork bomb** — `:(){ :|:\& };:`.
  - **dd** — `dd ... of=/dev/sda|hd|nvme|vd|xvd`.
  - **mv** — `mv ... /(etc|boot|usr|var|sys|proc)`.
  - **chmod без -R** — `chmod 777 /etc` и другие критические пути.
  - **rm через переменные** — `rm -${FLAG}f /`.
  - **rm brace expansion** — `rm -r{f,} /`.
  - **chmod/chown -R** — расширено на `/etc`, `/usr`, `/var`, `/boot`, `/home`.
  - **Service whitelist** — `systemctl stop X` и `service X stop` не считаются
    опасными (ранее любое упоминание слова "service" отключало проверку).

- **Audit log** — `~/.fan/agent/audit/orchestrator.log` (JSONL):
  - `timestamp`, `command`, `reason`, `decision` (`allow` | `block` |
    `headless_block`), `agentType`, `workerId`.
  - Записывается при каждом решении (Allow / Block / Headless).

- **Orchestrator hook убран из пути блокировки** — теперь только audit-only:
  - Раньше: хук оркестратора проверял → показывал UI → core тоже проверял →
    двойная блокировка (пользователь Allow → core всё равно Block).
  - Теперь: единая точка блокировки в core bash tool, хук только логирует.

- **Init-wizard UI для dangerous commands** — в `/orchestrator init` добавлен
  шаг редактирования списка опасных паттернов: Keep / Edit / Remove / Add new.

### Пользовательский интерфейс для опасных команд

- **CLI флаг `--dangerously-skip-permissions`** — глобальное отключение проверки
  опасных команд для всей сессии:
  - `packages/coding-agent/src/cli/args.ts` — парсинг флага в
    `result.dangerouslySkipPermissions = true`.
  - `packages/coding-agent/src/main.ts` (строка 841) — установка
    `process.env.FAN_DANGEROUSLY_SKIP_PERMISSIONS = "true"` при старте;
    переменная окружения прозрачно передаётся всем дочерним процессам.
  - Предназначен для доверенных окружений (локальная dev-машина,
    CI/CD с фиксированными скриптами).

- **Интерактивное UI подтверждение** (Allow / Block) при срабатывании детектора
  опасных команд:
  - `extensions/fan-orchestrator/orchestrator-extension.js` (hook `tool_call`,
    строка 270) — перехват вызова `bash`-инструмента, проверка через
    `isDangerousCommand()` с учётом пользовательских паттернов.
  - При наличии `ctx.ui.select` показывается диалог:
    - **Allow** — устанавливает `event.input._fanDangerouslyApproved = true`,
      что передаётся в core bash tool и снимает блокировку для этой конкретной
      команды.
    - **Block** — возвращает `{ block: true, reason }`, команда не исполняется.
  - Механизм `_fanDangerouslyApproved`:
    - `packages/coding-agent/src/core/tools/bash.ts` (строка 339) — guard:
      `if (_fanDangerouslyApproved !== true && ...)` — если флаг установлен,
      вызов `isDangerousCommand()` пропускается.
    - Флаг живёт только на время одного вызова `bash`-инструмента, не сохраняется
      между вызовами — каждое выполнение требует отдельного подтверждения.
    - Если пользовательские паттерны настроены, они проверяются до UI;
      Allow снимает блокировку и для пользовательских паттернов.

- **Headless mode** — при отсутствии `ctx.ui` (нет TUI/интерактивного ввода):
  - Команда автоматически блокируется с решением `headless_block`.
  - Единственное исключение — флаг `--dangerously-skip-permissions`,
    установленный до старта сессии.
  - Все решения записываются в audit log
    (`~/.fan/agent/audit/orchestrator.log`, JSONL) с полем `decision`:
    `allow` | `block` | `headless_block`.

### Тестирование

- **50 тестов** в `extensions/fan-orchestrator/test/permissions.test.mjs`.
- **26 тестов** в `packages/coding-agent/test/security/permissions.test.ts`.
- Все тесты проходят. Build — 0 ошибок.

### Изменения версий

- **@seaagents/fan-coding-agent** — `2.0.2` → `2.1.0` (core security module).
- **fan-orchestrator** — `7.2.0` → `7.3.0` (permission hardening, audit log,
  init-wizard UI).

---

## [1.0.3] - 2026-06-25

### Новое

- **Конфигурация LLM через `models.json`** — теперь новые провайдеры и модели можно
  добавлять без изменений в коде:
  - Поддержка произвольных имён провайдеров с указанием `api` (например,
    `openai-completions`, `anthropic-messages`).
  - Добавлено поле `envVar` в конфигурации провайдера для явной привязки
    переменной окружения с API-ключом.
  - Поле `apiKey` больше не является обязательным в `models.json` — FAN
    разрешает ключ через `--api-key`, `auth.json`, OAuth, переменные окружения
    или `models.json`.
  - `AuthStorage` теперь получает динамические `envVar`-маппинги из
    `models.json`, включая после `refresh()`.
  - Для существующих встроенных провайдеров новые модели можно добавлять
    только по `id` — `baseUrl` и `api` наследуются от built-in моделей
    провайдера.

### Изменения

- **@seaagents/fan-coding-agent** — версия пакета поднята с `1.0.2` до `1.0.3`.

### Исправления

- **model-registry** — метод `refresh()` теперь синхронизирует обновлённые
  `envVar`-маппинги с `AuthStorage`, чтобы изменения `models.json` применялись
  без перезапуска процесса.

### Документация

- `packages/coding-agent/docs/models.md` — добавлены разделы: добавление
  кастомных провайдеров без изменений кода, наследование `baseUrl`/`api` от
  встроенных моделей, поле `envVar`, порядок разрешения API-ключей, когда
  `apiKey` обязателен, ограничения.

## [1.0.2] - 2026-06-25

### Изменения

- **Документация** — `packages/coding-agent/docs/models.md` — добавлены разделы: добавление
  кастомных провайдеров без изменений кода, поле `envVar`, порядок разрешения API-ключей,
  когда `apiKey` обязателен, ограничения.

## [1.0.1] - 2026-06-15

### Исправления

- **Сборка** — удалён `scripts/sync-version.mjs` и корневой `prebuild` хук.
  `npm run build` больше не синхронизирует версии всех пакетов с корневой.
  Версии пакетов теперь обновляются вручную (независимое версионирование).
- **Ребрендинг** — массовая замена оставшихся упоминаний `pi` на `fan` в
  коде, логах, скриптах и примерах расширений.
- **FAN Store** — параметры `pi` переименованы в `fan` в командах и
  инструментах store.
- **TUI** — пути лог-файлов отладки изменены с `pi-debug.log` / `pi-crash.log`
  на `fan-debug.log` / `fan-crash.log`.
- **export-html** — meta-теги в шаблоне экспорта переименованы в
  `fan-url-params` / `fan-share-base-url`.

### Новое

- **Лэндинг FAN** — добавлена директория `lending/` с одностраничным сайтом
  в стиле терминала Fallout 3 / PipBoy. Содержит описание проекта, ключевые
  возможности, команды установки и ссылки на документацию.

### Документация

- `docs/RELEASE.md` — актуализировано описание процесса релиза с учётом
  удаления `sync-version.mjs`.

---

## [1.0.0] - 2026-06-14

### 🚀 FAN 1.0.0 — Первый стабильный релиз

Этот релиз знаменует собой стабилизацию API и архитектуры FAN. Все компоненты
достигли production-ready состояния. Основные направления разработки в этом цикле:
интеграция с IntelliJ IDEA, улучшение FAN Store, новый набор навыков, провайдеры LLM.

**Ключевые пакеты:**
- `@seaagents/fan-coding-agent` — CLI-интерфейс, runtime, набор инструментов
- `@seaagents/fan-ai` — унифицированное LLM API (10+ провайдеров)
- `@seaagents/fan-agent-core` — абстракция агента с транспортами и состоянием
- `@seaagents/fan-tui` — TUI-библиотека с дифференциальным рендерингом (отдельный npm-пакет)
- `@seaagents/fan-web-ui` — компоненты веб-интерфейса (отдельный npm-пакет)
- `@fan/api-gateway` — HTTP/WebSocket сервер для клиентских подключений
- `@fan/db` — слой базы данных (Prisma + SQLite)
- `@fan/model-manager` — маршрутизация провайдеров, fallback-цепочки, бюджет
- `@fan/dashboard` — веб-панель управления (Lit + Tailwind)
- `@fan/store` — менеджер пакетов (расширения, навыки, темы)

**Поставляемые навыки (8шт):**
`auto-tests`, `bug-fix`, `code-research`, `deep-dive`, `fan-forge`, `idea-lab`, `repo-explorer`, `research-spec-generator`

---

### Новое

- **IntelliJ IDEA Plugin** — полноценная интеграция FAN в IntelliJ Platform
  - JCEF-движок рендеринга чата (TUI-стиль визуализации)
  - Панели: Welcome, SessionList, Chat, Input, Renderer, StatusBar
  - Автостарт локального FAN-сервера, авто-провижинг без токенов
  - Уведомления, Actions (DeleteSession, OpenSettings, AskFan)
  - Поддержка IC-2024.2.2+, JCEF на Ubuntu 24.04
- **Расширение `fan-soul`** — управление идентичностью агента (SOUL.md / USER.md)
- **Расширение `fan-loop`** — цикл самостоятельного выполнения задач
- **Расширение `fan-confluence`** — интеграция с Confluence Data Center
- **Инструмент `confluence`** — чтение/запись/поиск страниц Confluence
- **Провайдеры LLM:**
  - MiniMax-M3, MiniMax-M1
  - MiMo (Mistral + Moonshot)
  - DeepSeek (встроенный провайдер)
  - Filin-LightLLM (лёгкий инференс)
  - Kimi
- **dev-docs-pack skill v1.1.0** — генератор полного пакета документации разработки
- **feature-pipeline + feature-roadmap skills** — TDD-пайплайн разработки фич

### Улучшения

- **FAN Store** — полная адаптация pi-store v1.7.1
  - `/store browse` — интерактивный браузер пакетов
  - Анимация операций install/remove/update
  - 11 предустановленных навыков (FAN Store)
  - SHA-256 верификация, path traversal защита, backup & rollback
  - Репозиторий по умолчанию: `https://fan.sea-agents.ru/fan-store/`
- **Оркестратор v5** — PI-style воркеры, новый протокол взаимодействия
- **Менеджер моделей** — обновление моделей перед `getAvailable`
- **TLS skip** — всегда пропускать верификацию TLS для fd/rg download
- **Корпоративные прокси** — поддержка прокси с самоподписанными сертификатами
- **Windows** — скрытие окна терминала при self-update
- **Версия инлайнится** в api-gateway dist на этапе сборки (bun compile)

### Исправления

- **build** — использование `bun install` вместо `npm`, работа с bun isolated linker
- **build** — cross-platform native bindings через `--ignore-scripts`
- **build** — исправление относительных require('./package.json') для bun compile
- **server** — режим foreground для корректного project CWD
- **server** — `resolveAppMode()` проверяет `--mode` флаг перед `FAN_FORCE_SERVER_MODE`
- **store** — переписана установка (bun CLI, staging, очистка workspace deps)
- **store** — показ локально установленных пакетов не из удалённого индекса
- **idea-plugin** — 40+ исправлений компиляции, рантайм-конфликты, JCEF краши
- **idea-plugin** — отключение корутин в UI-слое, замена на IntelliJ native threading
- **idea-plugin** — отображение статуса подключения, блокировка Send до коннекта
- **extensions** — `session_start` событие для серверного режима
- **fan-repo** — `rsync` без `--delete`, чтобы не терять пакеты
- **Загрузка системных CA-сертификатов** для HTTPS-соединений
- **Очистка зависимостей** — удалены неиспользуемые зависимости и сборки

### Технический долг / Архитектура

- Оркестратор вынесен в отдельное расширение FAN Store (v4 → v5)
- Удалён `--delete` из rsync при публикации в fan-repo
- Обновлён CLAUDE.md с правилами импорта
- Роадмапы фич и документация по плагину

---

## [0.10.0] - 2026-06-02

- Bump версии до 0.10.0
- Миграция FAN Store на новый сервер `fan.sea-agents.ru/fan-store`

---

## [0.9.0] - 2026-05-30

- Bump версии до 0.9.0
- Исправление inlining версии в api-gateway dist для bun compile
- Refactor: извлечение orchestrator в FAN Store, исправление версионирования

---

## [0.8.4] - 2026-05-25

- Исправления сборки: отключение autoload для dotenv и package.json
- Поддержка system CA-сертификатов
- Добавлен DeepSeek как встроенный провайдер

---

## [0.7.8] - 2026-05-20

- Провайдер MiMo
- Исправление Windows: скрытие окна терминала при self-update

---

## [0.7.5] - 2026-05-18

### IntelliJ IDEA Plugin (масштабная интеграция)

- JCEF-движок рендеринга (TUI-стиль визуализации)
- Панели: Welcome, SessionList, Chat, Input, Renderer, StatusBar
- Работа с сессиями, навигация, отправка сообщений
- Автостарт/стоп FAN-сервера в проекте
- Состояние подключения, уведомления, Actions
- 40+ исправлений: компиляция, рантайм-конфликты, JCEF краши

### Прочее

- `session_start` событие для серверного режима
- Фильтрация сессий по project CWD

---

## [0.7.4] - 2026-05-10

- 11 предустановленных навыков для FAN Store
- Оркестратор v2 — мульти-агентная платформа (миграция)

---

## [0.7.1] - 2026-05-08

- FAN Store v0.7.0 — полная адаптация pi-store v1.7.1
- `/store browse` — интерактивный браузер пакетов
- Анимация операций install/remove/update

---

## [0.6.0] - 2026-05-05

- Bump версии до 0.6.0
- Исправление сборки: build-binaries.sh переписан для bun isolated linker
- Self-update: `fan update` + install.sh / install.ps1
- Авто-копирование артефактов сборки в `~/fan-repo/dist/`

---

## [0.5.1] - 2026-05-01

- Исправление установки: полная директория + symlink + realpath resolution
- Trim бинарной дистрибуции до runtime-необходимого
- Хэндлинг существующей директории в install.sh

---

## [0.4.5] - 2026-04-28

- Добавлен fan-repo как репозиторий по умолчанию
- Переписан установщик FAN Store: bun CLI, staging, очистка workspace deps

---

## [0.4.3] - 2026-04-25

- Исправления сборки: --no-scripts для cross-platform deps, skip native compilation

---

## [0.4.1] - 2026-04-22

- Исправления build: bun add вместо npm, работа с isolated linker
- FAN Store: animation install/remove/update

---

## [0.4.0] - 2026-04-20

- **Оркестратор вынесен** в standalone расширение FAN Store (v0.4.0)
- Удалена жёсткая интеграция из core, авто-обнаружение через Store

---

## [0.3.5] - 2026-04-18

- `/store browse` — интерактивный браузер пакетов

---

## [0.3.4] - 2026-04-17

### FAN Store — Package Manager Extension

#### Новый пакет: `@fan/store`
- Менеджер пакетов для установки расширений, навыков и тем
- 5 LLM-инструментов: `store_search`, `store_install`, `store_remove`, `store_update`, `store_list`
- `/store` slash-команда с подкомандами
- Управление репозиториями, multi-repo поиск
- Установка из архивов (.tar.gz, .tgz, .zip)
- Bundle support (extensions/, skills/, themes/)
- SHA-256 верификация, path traversal protection, backup & rollback
- Оффлайн-режим, file:// URL поддержка

---

## [0.3.3] - 2026-04-17

- Исправление: восстановлены агенты в оркестраторе

---

## [0.3.1] - 2026-04-16

- Исправление: загрузка глобального `.env` в process.env при старте

---

## [0.3.0] - 2026-04-16

### Новый пакет: `@fan/persistent-memory` v2.0.0
- Расширение для сохранения знаний между сессиями
- Память вынесена из core в отдельный пакет

---

## [0.2.2] - 2026-04-15

- Исправление бага загрузки .env
- Обновление README, CHANGELOG и roadmap ссылок

---

## [0.2.1] - 2026-04-15

- TLS skip для fd/rg download
- Поддержка корпоративных прокси

---

## [0.2.0] - 2026-04-15

### Оркестратор — TUI работников и архитектура

- Живое отображение инструментов работников
- Состояния: running, completed collapsed/expanded
- Task List Widget с авто-скрытием
- Slot pool для контроля конкурентности
- stop_worker, parseVerdict()
- Документация и обновление системного промпта координатора
