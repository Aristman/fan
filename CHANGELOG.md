# Changelog

## [2.2.3] - 2026-07-15

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
