# Changelog

## [2.4.1] - 2026-08-09

### Исправлено

- **`fan list-models` (subcommand) маршрутизируется в early-exit** — раньше
  падал в путь полного bootstrap (~17 с), теперь работает как флаг
  `--list-models` (~1 с).
- **Per-extension таймеры с именами пакетов** — `ext:fan-orchestrator/index.js`
  вместо `ext:index.ts` в выводе FAN_TIMING.

## [2.4.0] - 2026-08-09

### Новое

- **Гранулярные FAN_TIMING таймеры startup** — `resolvePackages`, `loadExtensions`,
  `ext:<name>`, `loadSkills`, `loadPromptTemplates`, `loadThemes`,
  `loadProjectContext`, `initDatabase`, `createAgentSessionRuntime`. Включаются
  переменной окружения `FAN_TIMING=1`. `timeWithDuration()` для корректного
  измерения parallel-веток (TOTAL без двойного учёта).
- **Ранние выходы CLI** — `--help`, `--version`, `--list-models` завершаются ДО
  bootstrap (без загрузки extensions/skills/models). `--help` ~4.2x быстрее,
  `--list-models` ~15x быстрее. Trade-off: `--help` не показывает
  extension-флаги.

### Изменено

- **jiti singleton + fsCache для загрузки extensions** — общий экземпляр jiti
  переиспользуется между расширениями, файловый кеш ускоряет повторные
  загрузки (−31% времени загрузки extensions). Bundled-модули (mcp, store,
  fan-ai, fan-tui) вынесены в `bundled-modules.ts`, грузятся только в Bun
  binary.
- **Lazy dynamic import** — `@fan/api-gateway`, `@fan/mcp`, `@fan/store`
  импортируются динамически только при реальном использовании, не на старте.
- **Async parallel resource discovery** — skills/prompts/themes/context
  загружаются через `Promise.all` с `fs/promises` вместо sync I/O.
- **Context-walk останавливается на git-root** — `loadProjectContextFiles`
  больше не поднимается выше корня репозитория. `FAN_CONTEXT_WALK=fsroot`
  восстанавливает старое поведение.
- **findMostRecentSession — stat-first + top-10 валидация** — 42x ускорение
  на 2000 файлах сессий (stat по дате → проверка заголовков только top-10).
- **fd/rg скачивание в фоне** — бинари скачиваются после `ui.start()`,
  атомарные загрузки (temp + rename), честный статус в UI.
- **Удалена мёртвая зависимость** `@seaagents/fan-web-ui` из package.json.

### Исправлено

- **getPackageDir() пропускает dist/package.json** — артефакт `build:binary`
  больше не вызывает crash server/TUI с ENOENT dark.json. Добавлен
  `resolveAssetDir` helper.
- **printTimings TOTAL** — исключён двойной учёт parallel-веток.
- **bindSessionExtensions** — fire-and-forget rebind, больше не падает с
  unhandled rejection.

### Breaking Changes

- **BREAKING: `loadSkills()` и `loadSkillsFromDir()` are now async (return `Promise`)**
  — ранее синхронные функции теперь возвращают `Promise<LoadSkillsResult>`.
  Все внутренние вызовы обновлены. Внешние SDK-потребители должны `await`
  эти вызовы. Затронутые экспорты в `index.ts`: `loadSkills`,
  `loadSkillsFromDir`. Связанные функции `loadPromptTemplates()` и
  `loadProjectContextFiles()` также стали async.

## [2.3.7] - 2026-08-07

### Новое

- **Таймер футера — по циклам разработки** — отсчёт только во время хода
  агента, сброс при завершении цикла; в конце цикла в чат выводится итог:
  `⏱ MM:SS · ↑ in ↓ out tokens · $cost (session)`. Shutdown-сводка
  показывает полное активное время сессии (несбрасываемый счётчик
  `totalActiveMs`). Корректная обработка auto-retry и compaction.
- `formatTokens` экспортирован из `components/footer.ts`.

### Исправлено

- `model-registry.test.ts` синхронизирован с регенерированным реестром
  моделей (`glm-4.5-air` → `glm-4.7`).

## [2.3.6] - 2026-08-07

### Изменено

- **Таймер в футере — активное время агента** — таймер больше не идёт
  непрерывно от старта сессии: отсчёт только во время хода агента
  (`agent_start` → `agent_end`), при завершении/прерывании останавливается,
  при новом ходе продолжает с накопленного значения. Compaction,
  auto-retry и `!`-bash в счёт не идут. Финальная сводка при shutdown
  показывает накопленное активное время.
- Новый метод `FooterComponent.setElapsedProvider(() => number)` —
  опциональный провайдер elapsed-времени с приоритетом над
  `setSessionStartTime()` (который сохранён как fallback; extension-футеры
  не затронуты).
- Тесты: 9/9 в `test/footer-width.test.ts` (2 новых кейса на провайдер).

## [2.3.5] - 2026-08-07

### Новое

- **Таймер сессии в футере** — живой elapsed-таймер (`MM:SS` / `H:MM:SS`)
  в конце строки с токенами и моделью; обновление раз в секунду через
  `requestRender()`, сброс при new/resume/fork/import/clear, сохранение
  при reload. Новый метод `FooterComponent.setSessionStartTime()` —
  опциональный, extension-футеры без него работают как раньше.
- **Финальная сводка при shutdown** — в терминал выводится строка
  `Session ended — duration: ... • tokens: ... • cost: $...` после выхода
  из raw mode.
- Экспорт `formatElapsed(ms)` из `components/footer.ts` с защитой от
  NaN/отрицательных значений.
- Тесты: 7/7 в `test/footer-width.test.ts` (5 новых кейсов).

## [2.2.3] - 2026-07-15

### Новое

- **Paste clipboard image как `[image_N]` маркер** — `alt+v` в TUI вставляет
  компактный маркер `[image_1]`, `[image_2]`, ... в редактор, а саму картинку
  (base64 + mimeType) добавляет в очередь `pendingImages`. При следующем
  `session.prompt()` картинки передаются агенту как vision content через
  опцию `images:` — прокинуто во все 5 submit-путей (compaction,
  streaming steer/followUp, main loop, Alt+Enter followUp).
  (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`).
- **Компактные Skills / Extensions в startup header** — одно строка имён
  через запятую вместо многострочного перечня путей.
- **Новый хоткей `alt+s` Store** в startup info (жирным, акцентным цветом).

### Linter

- Упрощены тесты в `test/security/permissions.test.ts`.

---

## [1.0.1] - 2026-06-15

### Исправления

- **Сборка** — удалена зависимость от `scripts/sync-version.mjs`. Версия
  `@seaagents/fan-coding-agent` теперь управляется вручную в `package.json`.
- **Ребрендинг** — замена оставшихся `pi`-упоминаний на `fan` в
  `export-html/template.js`, `migrations.ts`, `theme-schema.json` и примерах
  расширений.

### Новое

- **Лэндинг FAN** — добавлена директория `lending/` с сайтом-визиткой в
  стиле PipBoy / Fallout 3 терминала.

---

## [1.0.0] - 2026-06-14

FAN 1.0.0 — стабилизация API и CLI-интерфейса. Все основные компоненты
`@seaagents/fan-coding-agent` достигли production-ready состояния.

### Новое

- **IntelliJ IDEA Plugin интеграция** — `fan` запускает FAN-сервер в проекте
  (JCEF-рендеринг в TUI-стиле, панели Welcome/SessionList/Chat/Input/Renderer/StatusBar)
- **Поддержка `--web` флага** — автооткрытие dashboard в браузере
- **`fan init` / `fan doctor` / `fan server`** — CLI-команды для онбординга и диагностики
- **`fan update`** — self-update механизм через GitHub Releases
- **Управление моделями через CLI** — `--provider`, `--model`, `--models` флаги
- **Scoped models + Ctrl+P цикл** — выбор между несколькими моделями в TUI
- **Thinking level override через CLI** — `--thinking <off|low|medium|high|xhigh>`
- **Resource loading** — extensions/skills/themes через `--extension`/`--skill`/`--theme` флаги
- **Custom theme support** — `--themes <path>` для подключения своих тем

### Улучшения

- **`resolveAppMode()`** — проверка `--mode` флага перед `FAN_FORCE_SERVER_MODE`
- **TUI subagent progress** — wall-clock timing, message count, tool count
- **FAN Store integration** — виртуальный модуль storeExtension, загружается автоматически
- **Orchestrator v5** — воркеры запускаются через `--mode json -p` (pipe), не через RPC
- **`session_start` event** — генерируется для extensions в server mode
- **Persistent config** — SettingsManager для глобальных и project-local настроек
- **Версия инлайнится** в api-gateway dist на этапе сборки (`bun build --compile`)
- **Self-update** — инсталляторы `install.sh` / `install.ps1`, GitHub Releases

### Исправления

- **server mode** — foreground режим для корректного project CWD
  (решает проблему с IDEA plugin)
- **stop per-project server** — автостоп сервера при закрытии проекта в IDEA
- **autostart server** — автостарт FAN-сервера, если не запущен
- **JCEF crash on Ubuntu 24.04** — upgrade IC-2024.1 → IC-2024.2.2
- **background server kill** — устранён баг с утечкой серверов
- **sendMessage timeout** — ликвидирована утечка editor'а в IDEA plugin
- **dispose race conditions** — coroutines заменены на IntelliJ native threading
- **build** — использование `bun install` вместо `npm`, работа с bun isolated linker
- **build** — cross-platform native bindings через `--ignore-scripts`
- **build** — исправление относительных `require('./package.json')` для bun compile
- **Windows** — скрытие окна терминала при self-update
- **Загрузка системных CA-сертификатов** для HTTPS-соединений

### Архитектура

- `@seaagents/fan-coding-agent` — единый CLI/runtime пакет
- **bin:** `fan` — точка входа для бинарника
- **entry point:** `dist/bun/cli.js` для `bun build --compile`
- **CLI-команды:** `fan`, `fan init`, `fan doctor`, `fan server`, `fan server start/stop/status`
- **Режимы:** интерактивный TUI (`fan`), серверный (`fan server`), web (`fan --web`)
- **Режим работы:** read-eval-print loop с детерминированным потоком
- **Инструменты:** read, write, edit, bash, grep, find, ls, store_search/install/remove/update/list

### Зависимости пакета

- `@seaagents/fan-ai` — унифицированное LLM API (10+ провайдеров)
- `@seaagents/fan-agent-core` — абстракция агента с транспортами и состоянием
- `@seaagents/fan-tui` — TUI-библиотека с дифференциальным рендерингом
- `@fan/api-gateway` — HTTP/WebSocket сервер для клиентских подключений
- `@fan/db` — слой базы данных (Prisma + SQLite)
- `@fan/model-manager` — маршрутизация провайдеров, fallback-цепочки, бюджет
- `@fan/store` — менеджер пакетов (расширения, навыки, темы)

---

## [0.13.2] - 2026-06-11

- Обновлена информация о провайдере Kimi
- Исправления конфигурации провайдеров

---

## [0.13.0] - 2026-06-10

- Добавлен провайдер Kimi
- Обновление роутов провайдеров

---

## [0.12.3] - 2026-06-08

- Исправление краша FAN Store
- Стабилизация установки пакетов

---

## [0.12.2] - 2026-06-06

- Добавлен провайдер MiniMax-3 (M3)
- Обновление моделей провайдера

---

## [0.12.1] - 2026-06-04

- Исправления в API Gateway
- Удалён `__dirname`-based `package.json` read для версионности

---

## [0.12.0] - 2026-06-03

- **Orchestrator v5** — PI-style workers, новый протокол взаимодействия
- Добавлен провайдер MiniMax-M1
- Улучшения FAN Store: стабильность и скорость установки
- `resolveAppMode()` — проверка `--mode` флага перед `FAN_FORCE_SERVER_MODE`

---

## [0.11.1] - 2026-06-01

- Добавлен провайдер MiMo (Mistral + Moonshot)
- Обновление моделей провайдера

---

## [0.10.1] - 2026-05-31

- Миграция FAN Store на новый сервер: `fan.sea-agents.ru/fan-store`
- Обновление URL репозитория по умолчанию

---

## [0.10.0] - 2026-06-02

- Исправление ошибок при обновлении (self-update)
- Bump версии до 0.10.0
- Внутренние улучшения сборки

---

## [0.9.0] - 2026-05-30

- Inline версии в api-gateway dist на этапе сборки (bun compile)
- Исправление `createRequire('../package.json')` → `readFileSync` в http-server
- Патч относительных `require('../package.json')` в зависимостях перед bun compile
- Отключение bun compile autoload для dotenv и package.json
- Refactor: извлечение orchestrator в FAN Store, исправление версионирования

---

## [0.8.4] - 2026-05-25

- Исправления сборки: отключение autoload для dotenv и package.json
- Поддержка system CA-сертификатов для HTTPS-соединений
- Добавлен DeepSeek как встроенный провайдер
- Исправление `_AFAN_KEY` → `_API_KEY`

---

## [0.7.8] - 2026-05-20

- Добавлен провайдер MiMo
- Исправление Windows: скрытие окна терминала при self-update
- Обновление Filin-LightLLM провайдера

---

## [0.7.5] - 2026-05-18

### IntelliJ IDEA Plugin (масштабная интеграция)

- **JCEF-движок рендеринга** — TUI-стиль визуализации чата в IDE
- **Панели:** Welcome, SessionList, Chat, Input, Renderer, StatusBar
- Работа с сессиями, навигация, отправка сообщений
- Автостарт/стоп FAN-сервера в проекте
- Состояние подключения, уведомления, Actions (DeleteSession, OpenSettings, AskFan)
- 40+ исправлений: компиляция, рантайм-конфликты, JCEF краши
- Отключение корутин в UI-слое, замена на IntelliJ native threading
- Отображение статуса подключения, блокировка Send до коннекта

### Прочее

- `session_start` событие для серверного режима
- Фильтрация сессий по project CWD
- Устранение утечки editor'а при sendMessage timeout

---

## [0.7.4] - 2026-05-10

- 11 предустановленных навыков FAN Store (auto-tests, bug-fix, code-research,
  deep-dive, fan-forge, idea-lab, repo-explorer, research-spec-generator)
- **Orchestrator v2** — мульти-агентная платформа (миграция)
- Переход на новый Worker-протокол

---

## [0.7.1] - 2026-05-08

- FAN Store v0.7.0 — полная адаптация pi-store v1.7.1
- `/store browse` — интерактивный браузер пакетов
- Анимация операций install/remove/update
- SHA-256 верификация, path traversal protection, backup & rollback
- Multi-repo support, file:// URL, offline mode
- Bundle support (extensions/, skills/, themes/)

---

## [0.7.0] - 2026-05-08

- Bump версии до 0.7.0
- Полная адаптация pi-store v1.7.1

---

## [0.6.0] - 2026-05-05

- Bump версии до 0.6.0
- `scripts/release-binaries.sh` — релизный билд-скрипт
- `scripts/install.sh` / `install.ps1` — установщики
- `fan update` — self-update через GitHub Releases
- Исправление сборки: build-binaries.sh переписан для bun isolated linker
- Авто-копирование артефактов сборки в `~/fan-repo/dist/`

---

## [0.5.1] - 2026-05-01

- Trim бинарной дистрибуции до runtime essentials
- Proper install layout — полная директория + symlink + realpath resolution
- Handle existing directory at install path
- 5 LLM-инструментов FAN Store: store_search, store_install, store_remove, store_update, store_list
- `/store` slash-команда с подкомандами

---

## [0.4.5] - 2026-04-28

- Добавлен fan-repo как репозиторий по умолчанию
- Переписан установщик FAN Store: bun CLI, staging, очистка workspace deps
- Поддержка .tar.gz, .tgz, .zip архивов

---

## [0.4.3] - 2026-04-25

- Исправления сборки: `--no-scripts` для cross-platform deps, skip native compilation
- Улучшение бинарной дистрибуции

---

## [0.4.1] - 2026-04-22

- Исправления build: `bun add` вместо `npm`, работа с isolated linker
- FAN Store: animation install/remove/update

---

## [0.4.0] - 2026-04-20

- **Оркестратор вынесен** в standalone FAN Store extension
- Удалена жёсткая интеграция из core, авто-обнаружение через Store
- Worker types расширены с 4 до 8 (explore, plan, implement, verify, bug-fix,
  code-research, docs-impl, tests-impl)

---

## [0.3.5] - 2026-04-18

- `/store browse` — интерактивный браузер пакетов FAN Store

---

## [0.3.4] - 2026-04-17

### FAN Store — Package Manager Extension

- **@fan/store v0.1.0** — добавлен FAN Store extension
- 5 LLM-инструментов: store_search, store_install, store_remove, store_update, store_list
- `/store` slash-команда с подкомандами
- Управление репозиториями, multi-repo поиск
- Установка из архивов (.tar.gz, .tgz, .zip)
- Bundle support (extensions/, skills/, themes/)
- SHA-256 верификация, path traversal protection, backup & rollback
- Оффлайн-режим, file:// URL поддержка

---

## [0.3.3] - 2026-04-17

- Восстановлены агенты в оркестраторе
- Исправление регрессии после вынесения оркестратора

---

## [0.3.1] - 2026-04-16

- Загрузка глобального `.env` в process.env на старте
- Поддержка корпоративных прокси с самоподписанными сертификатами

---

## [0.3.0] - 2026-04-16

### Новый пакет: @fan/persistent-memory v2.0.0

- Расширение для сохранения знаний между сессиями
- Память вынесена из core в отдельный пакет
- Улучшение архитектуры session persistence

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

### Оркестратор v1 — Worker TUI Display и архитектура

- 4 worker types (explore, plan, implement, verify)
- 3 workflows (single, chain, parallel)
- Живое отображение инструментов работников
- Состояния: running, completed collapsed/expanded
- Task List Widget с авто-скрытием
- Slot pool для контроля конкурентности
- stop_worker, parseVerdict()
- Mode labels, wall-clock timing
- Документация и обновление системного промпта координатора
