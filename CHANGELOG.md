# Changelog

## [2.8.0] — 2026-07-26

### Фаза 5 — Конкурентность (concurrency)

Полная изоляция параллельных сессий разных проектов: `process.chdir()`
удалён из runtime (0 production вызовов), инструменты привязаны к cwd
сессии; персистентная очередь сообщений (JSONL per sessionId, восстановление
при старте, WS-фрейм `queues_restored`); per-project токены с scope
enforcement и lockdown-политикой. Реализовано 8 фич + 2 fix
(9 коммитов `bb5c659..HEAD` = `2681eff..ad3cff8`).
Спецификация: `docs/specs/spec_fan-network-agent_phase5-concurrency_2026-07-25.md`,
аудит: `docs/research/process-cwd-audit-phase5.md`,
отчёт: `docs/features/phase5-concurrency/pipeline-report.md`.

#### Добавлено

- **Аудит process.cwd()/chdir (F-5.1/F-5.2)** — `docs/research/process-cwd-audit-phase5.md`:
  82 non-test совпадения cwd (37 direct / 23 indirect / 22 safe skip), 2
  production вызова `process.chdir()` (оба в `agent-session-runtime.ts`),
  скрытых chdir в extensions/mcp/store нет; migration plan с оценкой effort
- **Per-session cwd в tool definitions (F-5.3)** — `create*ToolDefinition(cwd)`
  для 7 инструментов (bash/read/write/edit/find/grep/ls), `BashExecutor` и
  `settings-manager` на explicit cwd; legacy default-экспорты помечены
  `@deprecated`; регрессионный тест `tool-cwd-isolation.test.ts`
- **Удаление `process.chdir()` из runtime (F-5.4)** — 0 production вызовов;
  regression guard `no-process-chdir.test.ts` (spy на chdir, параллельные
  сессии); инвариант `process.cwd()` подтверждён E2E (`/proc/1/cwd`)
- **PersistentMessageQueue (F-5.5)** — JSONL per sessionId
  (`<agentDir>/queues/<sessionId>.queue.jsonl`, append-only) + атомарный
  `queue-index.json` (tmp+rename, `repairIndex` при повреждении); dequeue =
  атомарная перезапись; drop-in для WS dispatcher, лимит 50 (F-2.15)
  сохранён; I/O retry ×3; доставка at-least-once (задокументировано)
- **Restore queues on startup (F-5.6)** — восстановление очередей из файлов
  до приёма соединений; WS-фрейм `queues_restored { restoredCount, sessions[] }`
  при подключении (только при restoredCount > 0); ошибки не фатальны;
  **server mode использует persistent queue по умолчанию**
  (`ServerOptions.persistentQueue: false` — legacy in-memory)
- **Per-project tokens (F-5.7)** — `ClientToken.projectScope` (Prisma,
  additive-миграция, `null` = full access); `authorizeProjectScope()` —
  exact match после нормализации пути; enforcement по query/body/WS
  (`session.cwd` при subscribe)/resource-level (`assertSessionInScope` в
  GET/POST/DELETE `/api/sessions/:id`); **scope lockdown**: GET `/api/tokens`
  фильтр по scope, DELETE только своего scope, глобальные мутации 403
  (model settings, provider budget, project registry), GET `/api/projects`
  фильтр, POST `/api/projects` только внутри scope; anti-escalation при
  выпуске токенов (scoped caller — только свой scope)
- **E2E параллельных сессий (F-5.8)** — секция 13 `deploy/scripts/e2e-local.sh`
  (107 проверок): изоляция JSONL сессий, инвариант `process.cwd()`, очередь
  переживает `compose restart` без потерь, scoped token smoke (own → 200,
  foreign → 403)

#### Исправлено

- **F1** — store installer использует session cwd: `ArchiveInstaller(cwd?)`
  explicit cwd, пересоздание на `session_start` (fix `a1121f9`)
- **HIGH — эскалация scoped token (финальная verify)** — scope lockdown на
  tokens/projects/budget/model settings эндпоинтах (fix `ad3cff8`)
- **F2 — MCP project config** — `mcpExtension` использует `ctx.cwd`
  (session_start + `/mcp reload`): project `.fan/mcp.json` снова грузится
  для сессий с cwd ≠ `process.cwd()` (fix `ad3cff8`)

#### Backlog

Deprecated tool API — путь удаления не определён; queue файлы 0644;
FIFO-перестановка при busy-окне (minor, pre-existing); `SessionManager.open()`
legacy fallback на `process.cwd()`; 52 старых ClientToken в dev-БД без scope.

## [2.7.0] — 2026-07-26

### Фаза 4 — Автономность (autonomy)

Автономный cron-based планировщик задач `fan-scheduler`: YAML-конфиг,
однопоточная очередь с персистентностью, retry/backoff, per-task budget
caps, приоритет чата над автономными задачами, control server
(pause/resume/state/health), GitHub bot identity + branch policy
`fan-auto/*` + PR через `gh`, DB backup daily cron. Реализовано 16 фич +
2 fix (18 коммитов `8b6ca9a..HEAD` = `f114f07..11f270b`).
Спецификация: `docs/specs/spec_fan-network-agent_phase4-autonomy_2026-07-25.md`,
отчёт: `docs/features/phase4-autonomy/pipeline-report.md`,
гайд: `docs/guides/scheduler.md`.

#### Добавлено

- **Пакет `tools/fan-scheduler` (F-4.1..F-4.5)** — автономный runner:
  YAML config-loader (`TaskConfig { name, schedule, workspace, message,
  budget_limit?, timeout? }`, синтаксическая валидация cron, дефолты
  `null`/`3600`), FAN API client (`FAN_API_URL`/`FAN_API_TOKEN`),
  однопоточная `TaskQueue` (FIFO, state machine idle/running/paused),
  execution pipeline (`createSession(cwd)` → `sendMessage` →
  poll completion, timeout), cron loop через Croner + hot-reload конфига
  (mtime watcher) + graceful shutdown (SIGINT/SIGTERM)
- **Git/PR политика (F-4.6..F-4.8)** — bot identity: валидация
  `GITHUB_TOKEN` при старте (кэш, маскирование в логах,
  `gitEnabled=false` при отсутствии/невалидности — scheduler не падает);
  branch policy `fan-auto/<id>-<YYYYMMDD-HHmmss>` (git-safe slug,
  защита `main`/`master`, system-prompt константа
  `AUTONOMOUS_BRANCH_POLICY`); PR через `gh pr create`
  (`lib/gh-client.ts`: push всегда до PR, детект base-ветки из
  `origin/HEAD`, `partial` при отсутствии gh/токена)
- **Budget cap per task (F-4.9)** — gateway: per-project budget
  `GET /api/budget?project=` (lifetime usage) + `PUT /api/budget
  { project, tokenLimit }` (персист в `~/.fan/agent/project-budgets.json`);
  scheduler: кап ставится **до** `sendMessage`, мониторинг каждые 30 с,
  enforcement по **per-task delta** (baseline на старте задачи), статус
  `budget_exceeded`
- **Retry with exponential backoff (F-4.10)** — `withRetry`: до 3 попыток,
  задержки 2s/4s/8s; retryable = network/5xx/429, прочие 4xx — fail fast
- **Structured JSON logging (F-4.11)** — JSONL: `{ timestamp, level,
  module, event, taskId?, message }`, `LOG_LEVEL` фильтр, stack только для
  error
- **Chat interruption (F-4.12)** — scheduler-side `UserActivityMonitor`
  (polling `GET /api/sessions`, исключение scheduler-owned сессий, окно
  60 с): живой чат паузит очередь, затухание — resume; приоритет
  `chat > autonomous`. Gateway не изменялся
- **Control server (F-4.12)** — localhost HTTP (default 127.0.0.1:3457):
  `POST /pause`, `POST /resume`, `GET /state`, `GET /health`
- **Persistent queue (F-4.13)** — `scheduler-pending.json` write-on-change,
  атомарная запись (tmp+rename), version-check, восстановление на старте;
  повреждённый файл → `degraded`
- **Health & metrics (F-4.14)** — `GET /health` на control server +
  прокси `GET /api/scheduler/health` на gateway (`FAN_SCHEDULER_URL`,
  503 `scheduler:"down"` при недоступности)
- **DB backup (F-4.15)** — `deploy/scripts/backup-db.sh`: sqlite3
  `.backup` (crash-safe для live-БД) с cp-fallback, ротация 7 копий,
  `chmod 600/700`, cron `0 3 * * *`
- **E2E (F-4.16)** — секция 12 в `deploy/scripts/e2e-local.sh` (всего 103
  проверки, PASS ×2 прогона): scheduler как compose-сервис `fan-scheduler`
  (тот же образ, config mount read-only, `FAN_SCHEDULER_TOKEN`),
  cron trigger, FIFO-сериализация двух задач, persistent queue на диске,
  pause/resume через control server, budget cap до `sendMessage`,
  retry на provider boundary (no-LLM), health proxy, budget API; git/PR/LLM
  шаги — manual checklist

#### Исправлено

- **Безопасность бэкапов** (`36b8c75`, верификация F-4.15) — `chmod 600`
  на каждую копию бэкапа (содержит ClientToken); секция «Безопасность
  бэкапов» в scheduler.md
- **5 находок верификации** (`11f270b`) — **P1:** budget cap = per-task
  delta (baseline на старте; fallback на lifetime с warning); P2:
  `chmod 700` на `BACKUP_DIR`; валидация чисел `timeout`/`budget_limit` в
  persistent-storage; `tools/fan-scheduler` в biome includes (+29 файлов);
  `clearTimeout` в `raceWithDeadline`

#### Известные ограничения (backlog)

- Budget enforcement на gateway отсутствует (scheduler-side only)
- Pause/timeout/budget не абортируют in-flight задачу (нет interruption
  endpoint в gateway)
- Branch policy — prompt-level (hard = GitHub branch protection)
- `gh-client.ts` не подключён в прод-путь (PR делает агент через bash)
- Задачи, удалённые из config, остаются в pending-файле

## [2.6.0] — 2026-07-26

### Фаза 3 — Universal Tasks (universal-tasks)

Типы workspaces (code/research/automation/unknown), автодетекция по
структуре директории, шаблоны проектов и создание через API и dashboard,
системные промпты по типу с override через `.fan/prompts/system.md`.
Реализовано 12 фич + 1 fix (12 коммитов `f29eb35..a1bbbd4`).
Спецификация: `docs/specs/spec_fan-network-agent_phase3-universal-tasks_2026-07-25.md`,
отчёт: `docs/features/phase3-universal-tasks/pipeline-report.md`.

#### Добавлено

- **Типы workspaces в projects.json (F-3.1)** — поле `type` со значениями
  `"code" | "research" | "automation" | "unknown"` в реестре
  `~/.fan/agent/projects.json`; `normalizeEntry()` даёт fallback
  `"unknown"` для legacy-записей без типа
- **Автодетекция типа (F-3.2)** — `detectWorkspaceType(cwd)` в
  `packages/coding-agent/src/workspace/detector.ts`; приоритет
  `code > research > automation > unknown`: code = `.git` (dir или
  gitfile) + (`src/` или `package.json`); research = `docs/research/` или
  `.fan/prompts/`; automation = скрипты (`*.sh`/`*.py` в корне или
  `scripts/`) + конфиг (`config/` или корневые `*.yaml`/`*.yml`/`*.toml`/
  `*.ini`/`*.cfg`; `*.json` намеренно исключён). Никогда не бросает
  исключений — любые fs-ошибки → `"unknown"`
- **Шаблоны проектов (F-3.3, F-3.4)** — реестр шаблонов +
  `applyTemplate()` + `createProject()` в
  `packages/coding-agent/src/workspace/templates/`: Code Project
  (`.fan/settings.json`, `src/`, `tests/`, `docs/`, `package.json`),
  Research Lab (`.fan/prompts/`, `docs/research/`, `data/`, `reports/`),
  Automation Hub (`scripts/`, `config/`, `output/`, `logs/`,
  `scripts/example.sh`). Существующие файлы не перезаписываются; `.git` в
  code-шаблоне не создаётся — при `unknown` детекции типом становится имя
  шаблона (documented fallback)
- **`POST /api/projects` (F-3.5)** — создание проекта из шаблона:
  body `{ name, template?, rootPath? }`; валидация `name` (единственный
  сегмент пути: без `/`, `\`, `..`, `.`; не корень whitelist),
  whitelist-проверка пути до записи на диск (403), unknown template →
  400 до любой fs-записи; ответ 201 (создан) / 200 (уже в реестре —
  идемпотентный dedup по path) с `{ path, name, type, template? }`
- **System prompt loader (F-3.6)** —
  `packages/coding-agent/src/workspace/prompt-loader.ts`: базовые промпты
  для code/research/automation + generic fallback для unknown; override
  `<cwd>/.fan/prompts/system.md` заменяет шаблон целиком (пустой файл =
  нет override); переменные `{workspace_path}` и `{project_name}`.
  Standalone-модуль — интеграция в runtime
  (`AgentSession._rebuildSystemPrompt()` / `ResourceLoader`) запланирована
  будущей фазой
- **Иконки типов в dashboard (F-3.7)** — `lib/workspace-type.ts`:
  Lucide-иконки CodeXml/FlaskConical/Cog/CircleQuestionMark + CSS-классы
  `.type-*`; показываются в project switcher и на группах cwd в древе
  сессий
- **Диалог создания проекта (F-3.8)** — `<fan-create-project-dialog>`:
  имя (client-side проверка path-traversal), radio-группа шаблонов
  (Code/Research/Automation/Empty Folder), опциональный rootPath; success
  → `project-created` + re-fetch списка; ошибки 400/403 показываются
  inline
- **Slash command autocomplete (F-3.9)** — dropdown по `/` в чате
  (`lib/slash-commands.ts`): 8 предустановленных скиллов как
  `/skill:<name>` (единственный slash-синтаксис, работающий через
  server path); порядок команд зависит от типа активного проекта;
  навигация ↑/↓, Enter/Tab, Esc; фильтрация по вводу
- **Ручная смена типа (F-3.10)** — `PUT /api/projects?path= { type }`
  (200/400/404/501, registry-only) + inline-редактор типа в
  project switcher
- **E2E (F-3.11, F-3.12)** — секции 10–11 в
  `deploy/scripts/e2e-local.sh` (всего 76 проверок, PASS=76 FAIL=0 ×2
  прогона, идемпотентно): создание research-проекта через API, структуры
  шаблонов на диске в контейнере, типы в реестре, `loadSystemPrompt` из
  реального dist для 3 типов (default + override), round-trip смены типа,
  изоляция `?project=`, возврат к проекту. LLM-шаги (idea-lab /
  research-spec-generator) — manual чеклисты в шапках секций (в
  контейнере нет API-ключей)

#### Исправлено

- **3 находки верификации** (`a1bbbd4`) — восстановлен biome strict gate
  (`useImportType` + форматирование, 666 файлов); `POST /api/projects`
  отклоняет `name` `"."`/`".."` + защита `resolve(root, name) != root`;
  `shellQuote(projectName)` в automation-hub `example.sh` — нет
  shell-инъекции. Тесты: api-gateway 168 (+5), coding-agent 1274 (+1),
  dashboard 93, e2e 76/76

## [2.5.0] — 2026-07-26

### Фаза 2 — Workspace UX (workspace-ux)

UX многопроектной работы: кеш сервисов по cwd с LRU, FIFO-очередь
сообщений при занятом движке, переключатель проектов и древо сессий в
dashboard, settings overlay и MCP reconnect при смене проекта.
Реализовано 15 фич + 2 fix (17 коммитов `fba7f65..96bdbb0`).
Спецификация: `docs/specs/spec_fan-network-agent_phase2-workspace-ux_2026-07-25.md`,
отчёт: `docs/features/phase2-workspace-ux/pipeline-report.md`.

#### Добавлено

- **ServiceRegistry** — кеш `AgentSessionServices` по cwd с LRU-eviction
  (default `maxItems = 5`), cleanup-hook при invalidate/clear/eviction,
  валидация `maxItems` (`packages/coding-agent/src/workspace/service-registry.ts`).
  Standalone-модуль — интеграция в runtime запланирована следующей фазой
- **Auto-invalidation кеша по mtime settings** — polling
  `<cwd>/.fan/settings.json` (default 5 s, инъектируемый интервал); watcher
  стартует при first access, останавливается при invalidate/clear/eviction
- **InMemoryMutex** — асинхронный FIFO-мьютекс с `withLock()`
  (`packages/api-gateway/src/mutex.ts`)
- **InMemoryMessageQueue** — per-session FIFO-очередь сообщений под
  мьютексом; лимит 50 на сессию (overflow → отказ); `dequeueOldest()` —
  глобальный FIFO по timestamp между сессиями
  (`packages/api-gateway/src/message-queue.ts`). In-memory: очередь
  теряется при рестарте сервера (MVP)
- **WS enqueue on busy** — `WsMessageDispatcher` в `ws-handler.ts`: при
  занятом движке `sendMessage` для другой сессии ставится в очередь,
  клиент получает `{ type: "queued", position }`; при переполнении —
  `{ type: "queue_full", error: "QUEUE_OVERFLOW", limit }`; фоновый drain
  по `agent_end` и после завершения dispatch; guard `dispatchPending`
  против гонки switchSession+prompt
- **`<fan-project-switcher>`** — dropdown проектов в сайдбаре dashboard:
  поиск по имени/пути, счётчик сессий, inline-форма «+», индикатор
  недоступного проекта + кнопка удаления из реестра (события
  `project-select` / `project-add` / `project-remove`)
- **Древо сессий по cwd** — session sidebar группирует сессии по `cwd`
  (сворачиваемые группы со счётчиком, цветовой status-dot); legacy-сессии
  без cwd — группа «Без проекта»
- **Project-aware API client (dashboard)** — методы клиента принимают
  опциональный `project` (`?project=` query); добавлен `removeProject(path)`
- **Settings overlay API** — `SettingsManager.loadProjectSettings(cwd)`
  (чтение `<cwd>/.fan/settings.json`), `applyOverlay()`, `resetToGlobal()`
- **McpSwitcher** — reconnect MCP-серверов при смене проекта: lazy init из
  `<cwd>/.fan/mcp.json`, per-cwd in-flight Map против конкурентных
  подключений; старые соединения не разрываются
  (`packages/coding-agent/src/workspace/mcp-switcher.ts`). Standalone-модуль
- **`available` / `error` в `GET /api/projects`** — проекты с удалённой
  с диска директорией помечаются `available: false,
  error: "PROJECT_NOT_FOUND"` (не исключаются из списка — видны для
  удаления)
- **`DELETE /api/projects?path=`** — удаление проекта из реестра:
  204/400/404/501; сессии и файлы на диске не затрагиваются
- **Индикатор очереди в чате** — «В очереди, позиция N» при `queued`;
  предупреждение при `queue_full` (`chat-view.ts`)
- **E2E многопроектной работы** — секция 9 в `deploy/scripts/e2e-local.sh`
  (8 проверок; всего 29 в скрипте): timed switching A→B→C→A < 2 s
  (факт ~20 ms), WS sendMessage end-to-end, dispatch evidence в app.log;
  ветки очереди (queued/queue_full) покрыты vitest — без LLM движок не
  становится busy (обоснование в шапке секции 9)

#### Исправлено

- **tsgo-совместимость** `session-sidebar.test.ts` (`baa59e7`) —
  spread NodeListOf → `Array.from`, untyped querySelectorAll + cast
- **4 находки верификации** (`96bdbb0`) — race в диспетчере (guard
  `dispatchPending`, TOCTOU rapid sendMessage), race в McpSwitcher
  (per-cwd in-flight Map — конкурентный switch ждёт первого, один
  connect), восстановлен biome strict gate (unused import, мёртвые
  suppressions), валидация `maxItems` в ServiceRegistry (integer ≥ 1)

## [2.4.0] — 2026-07-25

### Фаза 1 — Workspace-aware API (workspace-api)

Мультипроектная работа через FAN API: per-session cwd, реестр проектов,
whitelist-валидация рабочих директорий, CLI-управление проектами.
Реализовано 14 фич + 1 fix (15 коммитов `5b0b944..ee49635`).
Спецификация: `docs/specs/spec_fan-network-agent_phase1-workspace-api_2026-07-25.md`,
отчёт: `docs/features/phase1-workspace-api/pipeline-report.md`.

#### Добавлено

- **Поле `cwd` в модели Session** — nullable `String` + `@@index([cwd])` в
  `packages/db/prisma/schema.prisma`; аддитивная миграция (старые сессии —
  `null`, обратная совместимость сохранена)
- **`GET /api/sessions?project=<path>`** — фильтр сессий по проекту
  (нормализованное сравнение путей); без параметра — все сессии (backward
  compatible). Поле `cwd` проброшено в ответы API (legacy-сессии — `cwd`
  omitted, никогда не `null`/пустая строка)
- **`POST /api/sessions` принимает `cwd`** — создание сессии в указанной
  директории; 400 при невалидном типе `cwd` (не непустая строка)
- **`DELETE /api/sessions/:id?project=<path>`** — верификация принадлежности
  сессии проекту: 204 при удалении, 403 при чужом проекте
  (`session does not belong to this project`)
- **`GET /api/projects`** — реестр проектов с подсчётом сессий:
  `{ projects: [{ path, name, type, sessionCount }] }`
- **Реестр проектов `projects.json`** — `~/.fan/agent/projects.json`,
  атомарная запись (tmp + rename), дедупликация по path, устойчивость к
  повреждённому файлу (`packages/coding-agent/src/core/project-registry.ts`)
- **Авто-регистрация проекта** — при создании сессии в непустой несистемной
  директории; тип: `.git` → `code`, `docs/` → `research`, иначе `unknown`
  (`packages/coding-agent/src/core/project-auto-register.ts`)
- **CLI `fan project register/list`** — ручное управление реестром
  (`fan project register <path> [--type code|research|automation|unknown]`,
  `fan project list` — таблица PATH | NAME | TYPE | ADDED AT)
- **Per-session cwd** — сервисы (ResourceLoader, SettingsManager)
  инициализируются из `session.cwd`, а не из process-wide cwd
  (`agent-session-runtime.ts`); `process.chdir()` при switchSession
  сохранён (удаление — фаза 5)
- **`FAN_WORKSPACE_ROOT`** — стартовый cwd сервера и дефолт для сессий без
  явного `cwd`; fallback-цепочка: явный `cwd` в запросе >
  `FAN_WORKSPACE_ROOT` > `~/projects`; docker-compose:
  `FAN_WORKSPACE_ROOT=/data/repos` (volume `fan-repos`)
- **Whitelist-валидация cwd (security P0)** — `validateCwd`:
  каноникализация пути (`path.resolve` + `realpath` на longest existing
  prefix), защита от symlink traversal и prefix-collision
  (`/data/repos2` ≠ `/data/repos`), HTTP 403 + структурированная запись в
  audit log (`[api-gateway][audit] cwd rejected`)
  (`packages/api-gateway/src/workspace-validation.ts`)
- **E2E мультипроектный workflow** — секция 8 в `deploy/scripts/e2e-local.sh`:
  создание проектов A/B → сессии в обоих → реестр + `?project=` фильтры →
  cross-project delete 403 → path traversal 403 → in-project delete 204
  (всего 21 проверка в скрипте)

#### Исправлено

- **4 находки верификации в валидации cwd** (`ee49635`) — уточнение
  граничных случаев whitelist-валидации

## [2.3.6] — 2026-07-25

### Фаза 0 — Сетевой контур (network-contour)

Продакшен-деплой FAN API gateway на VPS: Docker-контур, nginx с TLS,
публичный режим с обязательной аутентификацией, файловое логирование
с ротацией. Реализовано 11 фич + 1 fix (10 коммитов `684de18..006ef96`).
Спецификация: `docs/specs/spec_fan-network-agent_phase0-network-contour_2026-07-25.md`,
отчёт: `docs/features/phase0-network-contour/pipeline-report.md`.

#### Добавлено

- **Env-конфигурация сервера** — `PORT` (дефолт 3456) и `HOST` (дефолт
  `localhost`) читаются из окружения; приоритет `--port`/`--host` > env >
  дефолт (`packages/coding-agent/src/cli/server-config.ts`)
- **Публичный режим `FAN_PUBLIC`** — `1`/`true`/`yes`/`on`: токен-аутентификация
  обязательна, `FAN_NO_AUTH` игнорируется; нераспознанные значения трактуются
  как публичный режим (fail-closed, warning в stderr)
- **CORS whitelist** — `ALLOWED_ORIGINS` (comma-separated), дефолт `*`
  (`packages/api-gateway/src/cors-config.ts`)
- **Docker** — мультистейдж `Dockerfile` (slim runtime image), `.dockerignore`,
  `docker-compose.yml` (публикация порта только на loopback, volume `/data`)
- **nginx + TLS** — `deploy/nginx/agent.sea-agents.ru.conf` (TLS termination,
  WebSocket upgrade, proxy на `127.0.0.1:3456`), идемпотентный скрипт
  `deploy/scripts/setup-tls.sh` (certbot), руководство
  `docs/guides/deployment.md`
- **Health readiness** — `GET /api/health` возвращает поля `db` (up/down,
  probe `SELECT 1` с таймаутом 1.5 с) и `session` (active/id); HTTP 503 при
  недоступной БД для docker healthcheck
- **Файловое логирование с ротацией** — `LOG_DIR`, `LOG_LEVEL`,
  `LOG_MAX_SIZE` (10 MB, суффиксы k/m/g), `LOG_MAX_FILES` (5); tee
  `console.*` → `<LOG_DIR>/app.log` без влияния на stdout
  (`packages/coding-agent/src/utils/file-logger.ts`)
- **E2E-деплой** — `deploy/scripts/e2e-local.sh` (локальная проверка всей
  цепочки: build → health → auth → WS)

#### Исправлено

- **WebSocket в Bun-ветке** — bridge `createBunWebSocketBridge` для Bun.serve
- **Token scrubbing** — токен из query-параметра вырезается из access-логов
  до попадания в stdout / `docker logs` / `/data/logs/app.log`

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
