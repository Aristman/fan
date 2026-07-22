# Roadmap: Интеграция lavish-axi в FAN

> **Дата генерации:** 2026-07-22
> **Источник:** `docs/specs/spec_lavish-axi-integration_2026-07-22.md`
> **Исследование:** `docs/research/idea-lab/lavish-axi-integration/Интеграция lavish-axi в FAN — исследование.md`
> **Функций / Этапов:** 13 / 3 (лимит: 15 / 8)

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 13 |
| Этапов | 3 |
| P0 (критические) | 7 |
| P1 (высокие) | 5 |
| P2 (средние) | 1 |
| P3 (низкие) | 0 |

## Легенда

- ✅ — Реализовано
- ☐ — Запланировано
- ⏳ — В работе
- ❌ — Заблокировано

### Приоритеты

- **P0** — Критично (без этого интеграция не работает)
- **P1** — Высокий (расширяет функциональность, улучшает DX)
- **P2** — Средний (дистрибуция, polish)
- **P3** — Низкий (future enhancement)

### Слои архитектуры

- **[API]** — Extension tool: registration, subprocess execution, output handling
- **[INTEG]** — Интеграция с внешним CLI (lavish-axi): detection, lifecycle, platform compat
- **[DATA]** — Конфигурация: config.json, env var passing
- **[CLI]** — Skill, документация, упаковка: SKILL.md, README, FAN Store bundle

---

## Этап 1: Foundation (MVP)

**Цель:** Реализовать работающий Extension с tool `lavish` (subcommands: open, poll, end, playbook, info), lifecycle hooks и SKILL.md. Подтвердить end-to-end workflow: агент генерирует HTML → открывает Lavish Editor → получает фидбек → итерирует → завершает сессию.
**Приоритет функций:** P0
**Оценка этапа:** ~3-4 дня

---

#### ✅ F-1.1: CLI auto-detect lavish-axi

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Extension определяет расположение lavish-axi CLI по цепочке: `where`/`which` lavish-axi → `npm root -g` + `existsSync` → `npx -y lavish-axi` fallback. Результат кешируется в модульной переменной на время сессии. Cross-platform: Windows (`where`) и Unix (`which`).
- **Пользовательская история:** «Как разработчик FAN, я хочу чтобы Extension автоматически находил lavish-axi CLI без ручной настройки, чтобы я мог просто установить пакет и начать работу»
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-1.1-1:** CLI найден в PATH
    - *Условие:* `lavish-axi` доступен в PATH (spawnSync `where`/`which` возвращает exit code 0 и непустой stdout)
    - *Шаги:* Вызвать `detectCli()` при старте сессии
    - *Ожидаемый результат:* Возвращает `{ bin: "lavish-axi", args: [], source: "path" }`, последующие вызовы возвращают кешированный результат без повторного spawn
  - [ ] **TC-1.1-2:** CLI найден в global npm (не в PATH)
    - *Условие:* `where lavish-axi` возвращает error, `npm root -g` возвращает путь, `existsSync(join(globalDir, "lavish-axi"))` = true
    - *Шаги:* Вызвать `detectCli()`
    - *Ожидаемый результат:* Возвращает `{ bin: "lavish-axi", args: [], source: "global" }`
  - [ ] **TC-1.1-3:** CLI не установлен — npx fallback
    - *Условие:* `where lavish-axi` = error, `npm root -g` → `existsSync` = false
    - *Шаги:* Вызвать `detectCli()`
    - *Ожидаемый результат:* Возвращает `{ bin: "npx", args: ["-y", "lavish-axi"], source: "npx" }`
- **Критерии приёмки:**
  1. `detectCli()` завершается за ≤ 2 секунды при любом из трёх сценариев (PATH, global, npx)
  2. Результат кешируется: второй и последующие вызовы в рамках одной сессии не выполняют spawn
  3. На Windows используется `where`, на Unix — `which` (определяется через `process.platform`)
- **Ожидаемый результат:** Функция `detectCli()` в `index.ts`, возвращающая `CliInfo { bin, args, source }` с кешированием
- **Оценка объёма:** S (2-3 часа)

---

#### ✅ F-1.2: Tool `lavish` registration с TypeBox schema

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Extension регистрирует tool `lavish` через `fan.registerTool()` с полной TypeBox schema: параметр `command` (enum: open/poll/end/playbook/design/export/info) + опциональные `file`, `playbook_id`, `agent_reply`, `reopen`, `no_gate`, `out`. Включает `promptSnippet` и `promptGuidelines` для system prompt агента.
- **Пользовательская история:** «Как агент FAN, я хочу видеть tool `lavish` в списке доступных инструментов с понятным описанием и подсказками, чтобы корректно его использовать для визуализации артефактов»
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-1.2-1:** Tool зарегистрирован с корректными метаданными
    - *Условие:* Extension загружен через FAN Extension API
    - *Шаги:* Проверить что `fan.registerTool` вызван с `name: "lavish"`, `label`, `description`, `promptSnippet`, `promptGuidelines` (6 пунктов), `parameters` (TypeBox Object с 7 полями)
    - *Ожидаемый результат:* Tool доступен в agent loop. `promptSnippet` содержит ключевые слова: open, poll, end, playbook, design, export, info
  - [ ] **TC-1.2-2:** Валидация обязательных параметров по subcommand
    - *Условие:* Tool `lavish` зарегистрирован
    - *Шаги:* Вызвать `execute()` с `{ command: "open" }` без `file`. Вызвать с `{ command: "poll" }` без `file`. Вызвать с `{ command: "end" }` без `file`
    - *Ожидаемый результат:* Каждый вызов возвращает error result: `"Error: 'file' parameter required for '<command>' command"`, exit code не 0
- **Критерии приёмки:**
  1. `fan.registerTool()` вызван ровно один раз с `name: "lavish"` и полной TypeBox schema
  2. `promptGuidelines` содержит ≥ 6 пунктов (playbook-first, poll after open, fix layout warnings, stop on ended, relative paths, Mermaid whiteboards)
  3. При вызове без обязательного `file` для open/poll/end/export — возвращается error result с понятным сообщением
- **Ожидаемый результат:** Функция `fanLavish(fan)` в `index.ts`, вызывающая `fan.registerTool()` с полной конфигурацией
- **Оценка объёма:** S (2-3 часа)

---

#### ✅ F-1.3: Core subcommands — open, poll, end

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Реализация трёх ключевых subcommands tool `lavish`: (1) `open` — запускает `lavish-axi <file>` с флагами `--reopen`/`--no-gate`, возвращает session URL и status. (2) `poll` — запускает `lavish-axi poll <file>` как long-poll subprocess без timeout, с AbortSignal handling (SIGTERM → 5s → SIGKILL) и heartbeat forwarding через `onUpdate`. (3) `end` — запускает `lavish-axi end <file>`, завершает сессию как агент.
- **Пользовательская история:** «Как агент FAN, я хочу открывать HTML-артефакты в Lavish Editor, ожидать фидбек от пользователя и завершать сессию, чтобы реализовать полный цикл визуального ревью»
- **Зависимости:** F-1.1 (CLI auto-detect), F-1.2 (tool registration)
- **TDD-тесты:**
  - [ ] **TC-1.3-1:** `open` запускает subprocess и возвращает session URL
    - *Условие:* CLI auto-detected, HTML файл существует по указанному пути
    - *Шаги:* Вызвать `execute({ command: "open", file: "/path/to/test.html" }, signal)`. Мок subprocess возвращает stdout с session JSON: `{ session: { file: "...", url: "http://127.0.0.1:4387/session/abc", status: "opened" }, next_step: "..." }`
    - *Ожидаемый результат:* Tool возвращает `{ content: [{ type: "text", text: "<stdout>" }] }`. Spawn вызван с аргументами `[file]` (или `[...cli.args, file]` для npx)
  - [ ] **TC-1.3-2:** `poll` блокирует до получения фидбека, heartbeat работает
    - *Условие:* Сессия открыта, subprocess `lavish-axi poll` запущен
    - *Шаги:* Вызвать `execute({ command: "poll", file: "/path/to/test.html" }, signal, onUpdate)`. Subprocess пишет heartbeat на stderr через 1s, затем возвращает JSON на stdout через 3s. Проверить что `onUpdate` вызван с heartbeat-текстом
    - *Ожидаемый результат:* `onUpdate` вызван ≥ 1 раза с текстом содержащим `[heartbeat]`. Final result содержит stdout с prompts/layout_warnings/status JSON
  - [ ] **TC-1.3-3:** `poll` с AbortSignal gracefully завершает subprocess
    - *Условие:* `poll` запущен, subprocess ещё не завершился
    - *Шаги:* Через 1s после старта вызвать `signal.abort()`. Проверить что subprocess получил SIGTERM. Подождать 6s, проверить что subprocess получил SIGKILL если не завершился
    - *Ожидаемый результат:* Tool возвращает результат (не зависает навечно). Subprocess terminated. Exit code отражает прерывание
- **Критерии приёмки:**
  1. `open` завершается за ≤ 5 секунд (включая server startup при первом вызове)
  2. `poll` не имеет встроенного timeout — блокируется до получения данных от subprocess или AbortSignal
  3. `poll` forwarding heartbeat через `onUpdate` — stderr subprocess пересылается как `{ content: [{ type: "text", text: "[heartbeat] ..." }] }`
  4. При `signal.abort()` — subprocess получает SIGTERM, через 5 секунд — SIGKILL. Tool возвращает результат без зависания
- **Ожидаемый результат:** Функции `executeLavish()` и `executeLavishPoll()` в `index.ts`, обработка case "open"/"poll"/"end" в switch
- **Оценка объёма:** M (1 день)

---

#### ✅ F-1.4: Subcommands playbook и info

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Реализация subcommands `playbook` и `info` для tool `lavish`: (1) `playbook` без `playbook_id` возвращает список всех playbook-ов с `use_when` триггерами. С `playbook_id` — возвращает полный guidance (choose[], structure[], design_rules[], pitfalls[]). (2) `info` — запускает `lavish-axi` без аргументов, возвращает текущие сессии и usage guidance.
- **Пользовательская история:** «Как агент FAN, я хочу получать playbook guidance перед написанием HTML и видеть текущие сессии Lavish Editor, чтобы выбирать правильный формат артефакта и возобновлять работу»
- **Зависимости:** F-1.1 (CLI auto-detect), F-1.2 (tool registration)
- **TDD-тесты:**
  - [ ] **TC-1.4-1:** `playbook` без id возвращает список playbook-ов
    - *Условие:* CLI auto-detected
    - *Шаги:* Вызвать `execute({ command: "playbook" }, signal)`. Мок subprocess возвращает JSON с `playbooks: [{ id: "diagram", use_when: "..." }, { id: "plan", use_when: "..." }, ...]`
    - *Ожидаемый результат:* Tool возвращает stdout содержащий playbook list. Spawn вызван с args `["playbook"]`
  - [ ] **TC-1.4-2:** `playbook` с id возвращает guidance конкретного playbook
    - *Условие:* CLI auto-detected
    - *Шаги:* Вызвать `execute({ command: "playbook", playbook_id: "diagram" }, signal)`. Проверить что spawn вызван с args `["playbook", "diagram"]`
    - *Ожидаемый результат:* Tool возвращает stdout с playbook guidance JSON (choose, structure, design_rules, pitfalls, lavish_notes)
- **Критерии приёмки:**
  1. `playbook` без `playbook_id` — spawn args: `["playbook"]`, возвращает список всех playbook-ов
  2. `playbook` с `playbook_id` — spawn args: `["playbook", "<id>"]`, возвращает guidance конкретного playbook
  3. `info` — spawn args: `[]` (без аргументов), возвращает home output с sessions и usage guidance
- **Ожидаемый результат:** Обработка case "playbook" и "info" в switch statement `execute()`
- **Оценка объёма:** S (1-2 часа)

---

#### ✅ F-1.5: Lifecycle hook `session_start` — ambient context

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Extension подписывается на `session_start` event. При старте сессии запускает `lavish-axi` (без аргументов) через auto-detected CLI с timeout 5 секунд. Если в выводе есть открытые сессии (`sessions[N]` где N > 0) — инжектит ambient context сообщение через `ctx.injectMessage()`. Если CLI не найден или нет открытых сессий — silent no-op.
- **Пользовательская история:** «Как пользователь FAN, я хочу чтобы при старте сессии агент знал о previously открытых Lavish Editor сессиях и мог предложить возобновить работу»
- **Зависимости:** F-1.1 (CLI auto-detect)
- **TDD-тесты:**
  - [ ] **TC-1.5-1:** Ambient context инжектируется при открытых сессиях
    - *Условие:* `session_start` event срабатывает. Мок `lavish-axi` возвращает stdout с `sessions[2]{...}` и `sessions[2]` содержит данные
    - *Шаги:* Extension обрабатывает `session_start`. Вызывает `executeLavish([], ctx.signal, 5_000)`. Проверяет наличие `sessions[` в output и что это не `sessions[0]`
    - *Ожидаемый результат:* `ctx.injectMessage()` вызван с `{ role: "system", content: "## Lavish Editor — Ambient Context\n\n<output>" }`
  - [ ] **TC-1.5-2:** Silent no-op при отсутствии CLI или открытых сессий
    - *Условие:* `session_start` event. Мок `lavish-axi` бросает error (CLI not found) ИЛИ возвращает `sessions[0]`
    - *Шаги:* Extension обрабатывает `session_start`
    - *Ожидаемый результат:* `ctx.injectMessage()` НЕ вызван. Нет ошибок в логах. Сессия стартует нормально
- **Критерии приёмки:**
  1. `session_start` hook вызывается при каждом старте сессии FAN
  2. Timeout 5 секунд — если CLI не отвечает за 5s, hook прерывает ожидание без ошибки
  3. `ctx.injectMessage()` вызывается ТОЛЬКО если есть ≥ 1 открытая сессия (output содержит `sessions[` и не содержит `sessions[0]`)
- **Ожидаемый результат:** `fan.on("session_start", async (event, ctx) => { ... })` в `index.ts`
- **Оценка объёма:** M (4-6 часов)

---

#### ✅ F-1.6: Lifecycle hook `session_shutdown` — cleanup

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Extension подписывается на `session_shutdown` event. При завершении сессии вызывает `lavish-axi stop` с timeout 5 секунд для graceful shutdown фонового сервера. Если сервер не запущен — silent no-op (не ошибка). Best-effort: ошибка shutdown не блокирует завершение сессии FAN.
- **Пользовательская история:** «Как пользователь FAN, я хочу чтобы при завершении сессии Lavish Editor сервер автоматически останавливался, не оставляя висящих процессов»
- **Зависимости:** F-1.1 (CLI auto-detect)
- **TDD-тесты:**
  - [ ] **TC-1.6-1:** Graceful shutdown при работающем сервере
    - *Условие:* `session_shutdown` event. Мок `lavish-axi stop` возвращает exit code 0
    - *Шаги:* Extension вызывает `executeLavish(["stop"], undefined, 5_000)`
    - *Ожидаемый результат:* Spawn вызван с `["stop"]`. Shutdown завершён без ошибок
  - [ ] **TC-1.6-2:** Silent no-op при отсутствии сервера
    - *Условие:* `session_shutdown` event. Мок `lavish-axi stop` возвращает exit code 1 (сервер не запущен) или бросает error
    - *Шаги:* Extension вызывает `executeLavish(["stop"], undefined, 5_000)` в try-catch
    - *Ожидаемый результат:* Нет проброшенных ошибок. Сессия FAN завершается нормально
- **Критерии приёмки:**
  1. `session_shutdown` hook вызывается при каждом завершении сессии FAN
  2. Timeout 5 секунд — не блокирует завершение сессии если CLI завис
  3. Ошибка shutdown (exit code ≠ 0 или spawn error) — перехватывается в try-catch, не пробрасывается
- **Ожидаемый результат:** `fan.on("session_shutdown", async () => { ... })` в `index.ts`
- **Оценка объёма:** S (1-2 часа)

---

#### ✅ F-1.7: SKILL.md — narrative guidance для агентов

- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** Написать `SKILL.md` в формате FAN Skill с frontmatter (`name: lavish`, `description`, `argument-hint`) и narrative body. Секции: «Когда использовать» (trigger conditions), «Workflow» (7 шагов: playbook → write HTML → open → poll → fix → iterate → end), «Playbook Router» (MUST вызвать playbook для каждого совпадения), «Visual Guidance» (5 правил), «Commands reference» (все subcommands tool `lavish`).
- **Пользовательская история:** «Как агент FAN, я хочу получить narrative guidance о том, когда и как использовать lavish tool, чтобы генерировать качественные HTML-артефакты и правильно обрабатывать фидбек»
- **Зависимости:** (none) — можно писать параллельно с Extension
- **TDD-тесты:**
  - [ ] **TC-1.7-1:** SKILL.md валиден по формату FAN Skill
    - *Условие:* Файл `SKILL.md` создан в пакете fan-lavish
    - *Шаги:* Проверить: (1) frontmatter содержит `name: lavish`, `description` (непустая, ≤ 1024 chars), `argument-hint`. (2) Body содержит секции: «Когда использовать», «Workflow», «Playbook Router», «Visual Guidance», «Commands reference». (3) Workflow содержит ≥ 7 шагов. (4) Playbook Router упоминает diagram, plan, comparison
    - *Ожидаемый результат:* Файл проходит валидацию FAN Skill loader (name kebab-case, description non-empty ≤ 1024 chars)
- **Критерии приёмки:**
  1. Frontmatter: `name: lavish`, `description` содержит trigger words (plan, comparison, diagram, table, report, visual), `argument-hint: <what the artifact should show>`
  2. Workflow секция: ≥ 7 шагов, начинающихся с playbook вызова и заканчивающихся на `status: "ended"`
  3. Playbook Router: MUST-инструкция вызывать playbook для каждого совпадения `use_when`
- **Ожидаемый результат:** Файл `SKILL.md` в корне пакета fan-lavish
- **Оценка объёма:** S (2-3 часа)

---

#### ✅ F-1.8: Playbook support — diagram, plan, comparison

- **Приоритет:** P1
- **Слой:** [CLI]
- **Описание:** Поддержка трёх playbook-ов через subcommand `playbook` tool `lavish`: (1) `diagram` — Mermaid > CSS grid, flowchart/sequence/class/ER/state diagrams → Excalidraw whiteboard. (2) `plan` — goal → approach → risks → comparison, комбинируется с diagram + table. (3) `comparison` — before/after, option cards, scorecard, semantic `<table>`. Каждый playbook возвращает structured guidance (choose[], structure[], design_rules[], pitfalls[]) через `lavish-axi playbook <id>`.
- **Пользовательская история:** «Как агент FAN, я хочу получать специфичные правила для каждого типа артефакта (диаграмма, план, сравнение), чтобы генерировать HTML, совместимый с Lavish Editor»
- **Зависимости:** F-1.4 (playbook subcommand)
- **TDD-тесты:**
  - [ ] **TC-1.8-1:** Playbook `diagram` возвращает Mermaid guidance
    - *Условие:* CLI auto-detected
    - *Шаги:* Вызвать `execute({ command: "playbook", playbook_id: "diagram" })`. Проверить stdout на наличие ключевых слов: «Mermaid», «Excalidraw», «flowchart»
    - *Ожидаемый результат:* Stdout содержит playbook guidance с design_rules упоминающими Mermaid и Excalidraw whiteboard
  - [ ] **TC-1.8-2:** Playbook `plan` возвращает structure guidance
    - *Условие:* CLI auto-detected
    - *Шаги:* Вызвать `execute({ command: "playbook", playbook_id: "plan" })`. Проверить stdout на наличие: «goal», «approach», «risks»
    - *Ожидаемый результат:* Stdout содержит playbook guidance с structure[] содержащим goal → approach → risks паттерн
- **Критерии приёмки:**
  1. Все три playbook-а (diagram, plan, comparison) возвращают непустой guidance через `lavish-axi playbook <id>`
  2. Playbook `diagram` guidance содержит правила Mermaid (не CSS grid) и Excalidraw whiteboard
  3. Playbook `comparison` guidance рекомендует semantic `<table>` для табличных данных
- **Ожидаемый результат:** Playbook-ы работают через upstream lavish-axi CLI, Extension передаёт guidance как-is
- **Оценка объёма:** S (1-2 часа — проверка что все 3 playbook-а возвращают валидный output)

---

## Этап 2: Expansion (Расширение)

**Цель:** Добавить оставшиеся subcommands (design, export), конфигурацию, README, верифицировать Windows-совместимость и работу с оркестратором.
**Приоритет функций:** P1
**Оценка этапа:** ~2-3 дня

---

#### ✅ F-2.1: Subcommands design и export

- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Реализация двух дополнительных subcommands: (1) `design` — запускает `lavish-axi design`, возвращает agent-facing design guidance (DESIGN_PRIORITY_RULE, CDN snippets для @pierre/diffs и Mermaid, CSS best practices). (2) `export` — запускает `lavish-axi export <file> [--out <path>]`, создаёт standalone HTML с инлайнированными локальными ассетами (cap: 10 MB/asset, 25 MB total).
- **Пользовательская история:** «Как агент FAN, я хочу получать design guidance для написания красивых артефактов и экспортировать финальный HTML как standalone файл для шеринга»
- **Зависимости:** F-1.2 (tool registration), F-1.1 (CLI auto-detect)
- **TDD-тесты:**
  - [ ] **TC-2.1-1:** `design` возвращает design guidance
    - *Условие:* CLI auto-detected
    - *Шаги:* Вызвать `execute({ command: "design" })`. Проверить spawn args: `["design"]`
    - *Ожидаемый результат:* Tool возвращает stdout содержащий design rules и CDN snippets
  - [ ] **TC-2.1-2:** `export` создаёт standalone HTML
    - *Условие:* HTML файл существует, содержит локальные ассеты (img, css)
    - *Шаги:* Вызвать `execute({ command: "export", file: "/path/artifact.html" })`. Проверить spawn args: `["export", "/path/artifact.html"]`
    - *Ожидаемый результат:* Tool возвращает stdout с путём к созданному файлу `artifact.export.html`. При `out` параметре: args включают `["--out", "<path>"]`
- **Критерии приёмки:**
  1. `design` возвращает непустой stdout с design guidance за ≤ 3 секунды
  2. `export` без `out` параметра создаёт `<name>.export.html` рядом с исходным файлом
  3. `export` с `out` параметром создаёт файл по указанному пути
- **Ожидаемый результат:** Обработка case "design" и "export" в switch statement `execute()`
- **Оценка объёма:** S (2-3 часа)

---

#### ✅ F-2.2: Конфигурация — config.json (port, noOpen)

- **Приоритет:** P1
- **Слой:** [DATA]
- **Описание:** Extension загружает опциональный `config.json` из директории пакета (или из FAN extension config). Параметры: `port` (number, default 4387) — передаётся через env var `LAVISH_AXI_PORT` при каждом spawn. `noOpen` (boolean, default false) — передаётся через env var `LAVISH_AXI_NO_OPEN=1`. Если config.json отсутствует — используются дефолты.
- **Пользовательская история:** «Как пользователь FAN, я хочу настроить порт Lavish Editor сервера и отключить автооткрытие браузера, чтобы адаптировать интеграцию под мою среду разработки»
- **Зависимости:** F-1.1 (CLI auto-detect — config влияет на spawn env vars)
- **TDD-тесты:**
  - [ ] **TC-2.2-1:** Дефолтные значения при отсутствии config.json
    - *Условие:* Файл `config.json` не существует в директории пакета
    - *Шаги:* Вызвать `loadConfig()`
    - *Ожидаемый результат:* Возвращает `{ port: 4387, noOpen: false }`. Spawn env не содержит `LAVISH_AXI_NO_OPEN`
  - [ ] **TC-2.2-2:** Кастомные значения из config.json
    - *Условие:* `config.json` содержит `{ "port": 5000, "noOpen": true }`
    - *Шаги:* Вызвать `loadConfig()`, затем `execute({ command: "open", file: "test.html" })`
    - *Ожидаемый результат:* Config загружен: `{ port: 5000, noOpen: true }`. Spawn env содержит `LAVISH_AXI_PORT: "5000"` и `LAVISH_AXI_NO_OPEN: "1"`
- **Критерии приёмки:**
  1. `loadConfig()` читает `config.json` из директории пакета, возвращает дефолты при отсутствии файла
  2. Все spawn вызовы (open, poll, end, playbook, design, export, info) передают `LAVISH_AXI_PORT` и `LAVISH_AXI_NO_OPEN` через env vars
  3. `config.example.json` включён в пакет с документированными параметрами
- **Ожидаемый результат:** Функция `loadConfig()` в `index.ts`, env vars в `executeLavish()` и `executeLavishPoll()`, файл `config.example.json`
- **Оценка объёма:** S (2-3 часа)

---

#### ✅ F-2.3: Windows-совместимость

- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** Верификация и фикс cross-platform поведения lavish-axi на Windows: (1) `where lavish-axi` вместо `which` для CLI detection. (2) `spawnSync` с `shell: false` и `windowsHide: true` для subprocess. (3) Обработка Windows-путей (backslash vs forward slash) при передаче file path в lavish-axi. (4) `taskkill /F /T /PID` как fallback для SIGKILL при abort.
- **Пользовательская история:** «Как пользователь FAN на Windows 11, я хочу чтобы lavish-axi работал без дополнительных настроек и обходных путей»
- **Зависимости:** F-1.1 (CLI detect уже использует where/which), F-1.3 (subprocess spawn)
- **TDD-тесты:**
  - [ ] **TC-2.3-1:** CLI detection на Windows использует `where`
    - *Условие:* `process.platform === "win32"`
    - *Шаги:* Вызвать `detectCli()`. Проверить что `spawnSync` вызван с `"where"` первым аргументом
    - *Ожидаемый результат:* На Windows используется `where`, на Unix — `which`. Функция возвращает корректный `CliInfo`
  - [ ] **TC-2.3-2:** File paths нормализованы для Windows
    - *Условие:* Путь к HTML содержит backslashes: `C:\Users\test\artifact.html`
    - *Шаги:* Вызвать `execute({ command: "open", file: "C:\\Users\\test\\artifact.html" })`. Проверить аргументы spawn
    - *Ожидаемый результат:* File path передан в spawn без модификации (lavish-axi сам нормализует). Spawn работает без error
- **Критерии приёмки:**
  1. `npx -y lavish-axi` успешно устанавливается и запускается на Windows 11
  2. `where lavish-axi` корректно определяет наличие CLI (exit code 0 = найден)
  3. AbortSignal корректно завершает subprocess на Windows (SIGTERM/SIGKILL или `taskkill`)
- **Ожидаемый результат:** Отчёт о Windows-тестировании, фиксы в `index.ts` если обнаружены проблемы
- **Оценка объёма:** M (4-6 часов — тестирование + фиксы)

---

#### ✅ F-2.4: README.md — документация

- **Приоритет:** P1
- **Слой:** [CLI]
- **Описание:** Написать `README.md` для пакета fan-lavish. Секции: (1) Описание — что делает пакет, скриншот/GIF Lavish Editor. (2) Требования — Node.js ≥ 18, FAN ≥ текущей версии. (3) Установка — `fan store install fan-lavish` или ручная (копирование в extensions/ + skills/). (4) Быстрый старт — `/lavish plan for my project`. (5) Конфигурация — config.json параметры. (6) Команды — таблица всех subcommands tool `lavish`. (7) Troubleshooting — частые проблемы и решения.
- **Пользовательская история:** «Как пользователь FAN, я хочу прочитать README и за 2 минуты понять, что делает пакет, как установить и как начать использовать»
- **Зависимости:** F-1.2 (tool registration — описание команд), F-2.2 (config — описание параметров)
- **TDD-тесты:**
  - [ ] **TC-2.4-1:** README содержит все обязательные секции
    - *Условие:* Файл `README.md` создан
    - *Шаги:* Проверить наличие секций: описание, требования, установка, быстрый старт, конфигурация, команды, troubleshooting
    - *Ожидаемый результат:* Все 7 секций присутствуют. README содержит ≥ 1 пример команды (`fan store install fan-lavish`, `/lavish`)
- **Критерии приёмки:**
  1. README содержит секции: описание, требования, установка, быстрый старт, конфигурация, команды, troubleshooting
  2. Секция «Установка» содержит ≥ 2 способа (FAN Store + ручная)
  3. Секция «Troubleshooting» содержит ≥ 3 проблемы с решениями (CLI not found, port conflict, poll timeout)
- **Ожидаемый результат:** Файл `README.md` в корне пакета fan-lavish
- **Оценка объёма:** S (2-3 часа)

---

## Этап 3: Polish & Release

**Цель:** Упаковать bundle для FAN Store, проверить auto-discovery и end-to-end установку, подготовить к публикации.
**Приоритет функций:** P2
**Оценка этапа:** ~1-2 дня

---

#### ✅ F-3.1: FAN Store packaging и smoke-test

- **Приоритет:** P2
- **Слой:** [CLI]
- **Описание:** Упаковка fan-lavish как bundle-пакет для FAN Store: (1) Создать `package.json` с `fan.extensions` и `fan.skills` полями. (2) Упаковать в `fan-lavish-1.0.0.tar.gz`. (3) Создать запись в `index.json` FAN Store. (4) Smoke-test: `fan store install fan-lavish` → verify auto-discovery (extension loaded, skill visible) → test `/lavish plan for test` → verify end-to-end workflow.
- **Пользовательская история:** «Как пользователь FAN, я хочу установить fan-lavish одной командой из FAN Store и сразу начать использовать без ручной настройки»
- **Зависимости:** F-1.2, F-1.3, F-1.4, F-1.5, F-1.6, F-1.7, F-1.8, F-2.1, F-2.2, F-2.3, F-2.4
- **TDD-тесты:**
  - [ ] **TC-3.1-1:** Bundle корректно упакован и авто-детектится
    - *Условие:* Пакет fan-lavish содержит SKILL.md + index.ts + package.json
    - *Шаги:* (1) `tar czf fan-lavish-1.0.0.tar.gz fan-lavish/`. (2) `fan store install /path/to/fan-lavish-1.0.0.tar.gz`. (3) Перезапустить FAN. (4) Проверить что extension loaded (tool `lavish` visible). (5) Проверить что skill visible (`/lavish` доступен)
    - *Ожидаемый результат:* FAN Store авто-детектит тип `bundle` (SKILL.md + index.ts). Extension загружается без ошибок. Tool `lavish` доступен. Skill `/lavish` вызывается
  - [ ] **TC-3.1-2:** End-to-end workflow после установки из Store
    - *Условие:* fan-lavish установлен через `fan store install`, Node.js ≥ 18 в PATH
    - *Шаги:* (1) `/lavish plan for REST API` → (2) агент вызывает playbook → (3) пишет HTML → (4) open → (5) poll → (6) фидбек → (7) iterate → (8) end
    - *Ожидаемый результат:* Полный цикл визуального ревью работает. Браузер открывается. Фидбек принимается. Сессия завершается корректно
- **Критерии приёмки:**
  1. `tar.gz` архив содержит все файлы пакета (SKILL.md, index.ts, package.json, config.example.json, README.md)
  2. `fan store install fan-lavish` устанавливает пакет без ошибок
  3. После установки и перезапуска FAN: tool `lavish` виден в списке tools, skill `/lavish` вызывается, `lavish-axi` CLI auto-detected
- **Ожидаемый результат:** Архив `fan-lavish-1.0.0.tar.gz`, запись в `index.json` FAN Store, пройденный smoke-test
- **Оценка объёма:** M (4-6 часов — упаковка + тестирование + загрузка в Store)

---

## Полный чеклист по приоритетам

### P0 — Критические

- [x] F-1.1 [INTEG]: CLI auto-detect lavish-axi (PATH → global npm → npx -y fallback)
- [x] F-1.2 [API]: Tool `lavish` registration с TypeBox schema (7 subcommands, promptGuidelines)
- [x] F-1.3 [API]: Core subcommands open/poll/end (subprocess, long-poll, AbortSignal)
- [x] F-1.4 [API]: Subcommands playbook и info (playbook list/guidance, sessions overview)
- [x] F-1.5 [INTEG]: Lifecycle hook `session_start` (ambient context injection)
- [x] F-1.6 [INTEG]: Lifecycle hook `session_shutdown` (graceful server stop)
- [x] F-1.7 [CLI]: SKILL.md (narrative guidance, workflow, playbook router, visual guidance)

### P1 — Высокие

- [x] F-1.8 [CLI]: Playbook support — diagram, plan, comparison (3 playbook-а через upstream CLI)
- [x] F-2.1 [API]: Subcommands design и export (design guidance, standalone HTML export)
- [x] F-2.2 [DATA]: Конфигурация config.json (port, noOpen → env vars)
- [x] F-2.3 [INTEG]: Windows-совместимость (where, paths, spawn, abort)
- [x] F-2.4 [CLI]: README.md (установка, конфигурация, troubleshooting)

### P2 — Средние

- [x] F-3.1 [CLI]: FAN Store packaging и smoke-test (bundle .tar.gz, auto-discovery, e2e)

---

## Граф зависимостей

```
F-1.1 (CLI detect) ─────┬──→ F-1.2 (tool registration)
                         │        │
                         │        ├──→ F-1.3 (open/poll/end)
                         │        ├──→ F-1.4 (playbook/info)
                         │        └──→ F-2.1 (design/export)
                         │
                         ├──→ F-1.5 (session_start hook)
                         ├──→ F-1.6 (session_shutdown hook)
                         └──→ F-2.2 (config.json)

F-1.4 (playbook subcommand) ──→ F-1.8 (playbook support)

F-1.2 (tool registration) ──→ F-2.4 (README.md)

ALL ──→ F-3.1 (FAN Store packaging)
```

**Проверка на циклы:** ✅ Циклических зависимостей нет. Граф — DAG (directed acyclic graph).

**Критический путь:** F-1.1 → F-1.2 → F-1.3 → F-3.1 (Foundation → Core → Packaging)

---

## Вне скоупа (Could Have / Won't Have)

Следующие элементы из спецификации §9 (Could Have / Won't Have) **не включены** в roadmap:

| Элемент | Причина |
|---------|---------|
| Dashboard integration (iframe + WS) | Требует значительных изменений Dashboard, выходит за скоуп интеграции |
| `lavish-axi share` support | Third-party dependency (ht-ml.app), opt-in feature |
| TOON output parsing | JSON pass-through достаточен для MVP, TOON — оптимизация |
| Все 7 playbook-ов (table, code, input, slides) | MVP: 3 playbook-а (diagram, plan, comparison), остальные — в v2 |
| `lavish-axi update` self-updater | Можно добавить после стабилизации основной интеграции |
| MCP-сервер | Отклонено: token overhead 2.3x, нет lifecycle hooks |
| Собственный HTML-рендерер | Отклонено: upstream lavish-axi решает задачу |
| Async poll с background process | Отклонено: слишком сложно для MVP |

---

*Создано: feature-roadmap skill*
*Источник: docs/specs/spec_lavish-axi-integration_2026-07-22.md*
