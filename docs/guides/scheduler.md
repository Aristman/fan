# FAN Scheduler Guide

FAN Scheduler (`tools/fan-scheduler/`) — автономный cron-based runner задач (фаза 4 — Автономность): читает `config.yaml`, по расписанию ставит задачи в однопоточную очередь и выполняет их через FAN API Gateway.

## Обзор архитектуры

```
config.yaml ──► CronScheduler ──► TaskQueue (FIFO, 1 задача за раз) ──► Executor ──► FAN API Gateway
                    │                    │                                 │
                    │                    ├─► persistent queue              ├─► createSession(cwd)
                    │                    │   (scheduler-pending.json)      ├─► setProjectBudget
                    │                    │                                 ├─► sendMessage
                    │                    ├─► UserActivityMonitor           ├─► poll completion
                    │                    │   (chat > autonomous)           └─► poll budget (per-task delta)
                    │                    └─► Control server
                    │                        (pause/resume/state/health)
                    └─► hot-reload (mtime watcher)
```

- **Отдельный процесс** от api-gateway; общение только через read/write HTTP API gateway (env `FAN_API_URL`, `FAN_API_TOKEN`). Gateway не модифицировался, кроме прокси `GET /api/scheduler/health` (F-4.14).
- **Однопоточная очередь** (F-4.3): задачи выполняются строго по одной, FIFO; одновременные cron-триггеры сериализуются.
- **В production** scheduler работает как compose-сервис `fan-scheduler` — тот же образ, что `fan`, другая команда (`bun tools/fan-scheduler/dist/scheduler.js /data/scheduler/config.yaml`). Dockerfile собирает и поставляет `tools/fan-scheduler/dist`.
- **Структура пакета:** `scheduler.ts` (entry point), `lib/config-loader.ts`, `lib/client.ts`, `lib/queue.ts`, `lib/executor.ts`, `lib/cron-scheduler.ts`, `lib/retry.ts`, `lib/logger.ts`, `lib/persistent-storage.ts`, `lib/activity-monitor.ts`, `lib/control-server.ts`, `lib/github-identity.ts`, `lib/branch-policy.ts`, `lib/gh-client.ts`. Тесты рядом с исходниками (`lib/*.test.ts`, vitest) — 202 теста.

## Установка и запуск

### Локально (Bun)

```bash
cd tools/fan-scheduler
bun install
bun run build     # tsc → dist/
bun run start     # bun dist/scheduler.js (config.yaml рядом с package root)
bun run test      # vitest
```

Кастомный путь к конфигу — первый CLI-аргумент: `bun dist/scheduler.js /path/to/config.yaml`.

### Docker Compose (production)

Сервис `fan-scheduler` в `docker-compose.yml` (та же сборка, `depends_on: fan (service_healthy)`):

```bash
docker compose up -d --build   # поднимает fan + fan-scheduler
docker compose logs -f fan-scheduler
```

Разовая настройка оператора:

1. **`FAN_SCHEDULER_TOKEN`** — provision ClientToken для scheduler (так же, как для любого API-клиента, см. «Token bootstrap» в deployment.md §7.2) и положить в `.env`. Без токена scheduler стартует (health/control server работают), но выполнение задач падает с `"FAN API token is not configured"`.
2. **`FAN_SCHEDULER_CONFIG`** — опционально, путь к своему `config.yaml` (default `./deploy/scheduler/config.yaml`, монтируется read-only в `/data/scheduler/config.yaml`).
3. **`GITHUB_TOKEN`** — опционально, PAT бот-аккаунта для git/PR-действий (см. раздел Bot Identity).

Внутренние env compose-сервиса: `FAN_API_URL=http://fan:3456` (compose DNS), `FAN_CODING_AGENT_DIR=/data/.fan/agent` (persistent queue живёт в volume `fan-data`), `FAN_SCHEDULER_CONTROL_HOST=0.0.0.0` (control server доступен gateway для health-прокси; порт 3457 **не публикуется** на хост). Config **hot-reload**: mtime watcher перечитывает файл при изменении — правьте на хосте, restart не нужен.

## config.yaml — справочник TaskConfig

```yaml
tasks:
  - name: daily-code-review      # (required) уникальное имя задачи
    schedule: "0 9 * * *"        # (required) 5-field cron: minute hour day-of-month month day-of-week
    workspace: /data/repos/proj  # (required) workspace проекта (session cwd); в Docker — внутри контейнера, под fan-repos
    message: "Review commits"    # (required) промпт, отправляемый агенту
    budget_limit: 500            # (optional) токен-кап задачи, default: null (без капа)
    timeout: 3600                # (optional) таймаут выполнения, секунды, default: 3600
```

- **Cron:** 5 полей; поддерживаются `*`, числа, диапазоны (`1-5`), шаги (`*/2`), списки (`1,2,3`). Диапазоны: minute 0–59, hour 0–23, day-of-month 1–31, month 1–12, day-of-week 0–7. Валидация синтаксическая при загрузке (`isValidCron`, `lib/config-loader.ts`); фактическое планирование — через Croner (`lib/cron-scheduler.ts`).
- **Валидация:** все required-поля — непустые строки; `budget_limit` — неотрицательное число или null; `timeout` — положительное число. Невалидный YAML → ошибка с номером строки и колонки; невалидная задача → ошибка с именем задачи. Scheduler не стартует с битым конфигом.
- **Дефолты:** `budget_limit = null`, `timeout = 3600` (константы `DEFAULT_BUDGET_LIMIT`, `DEFAULT_TIMEOUT`).

## Execution pipeline (F-4.4)

`createTaskExecutor` (`lib/executor.ts`) на каждую задачу:

1. `createSession(task.workspace)` → `POST /api/sessions` (session создаётся с `cwd = workspace`).
2. Если задан `budget_limit` → `setProjectBudget(workspace, budget_limit)` **до** `sendMessage` (см. Budget).
3. `sendMessage(session.id, task.message)` → `POST /api/sessions/:id/messages`.
4. `waitForCompletion` — polling `GET /api/sessions/:id` каждые 5 с (`DEFAULT_POLL_INTERVAL_MS`); сумма токенов assistant-сообщений — usage отчёт.
5. Таймаут `task.timeout` — задача помечается `timeout`, очередь продолжается.
6. Результат логируется: `{ taskId, status, durationMs, tokensUsed }`; статусы: `completed` / `failed` / `timeout` / `budget_exceeded`.

> **Ограничение (documented):** у gateway нет interruption endpoint — при timeout/budget/pause ожидание scheduler'а обрывается, но агент продолжает работать server-side до своего завершения.

### Retry with exponential backoff (F-4.10)

`withRetry` (`lib/retry.ts`): до **3 попыток** (`DEFAULT_MAX_RETRIES`), задержки **2s, 4s, 8s** (`delay = baseDelayMs * 2^(attempt-1)`, `DEFAULT_BASE_DELAY_MS = 2000`). Retryable: сетевые ошибки, HTTP 5xx, HTTP 429. Non-retryable: прочие HTTP 4xx — fail immediately. После исчерпания попыток — `RetryExhaustedError`, задача `failed`, очередь переходит к следующей. Каждая попытка логируется.

## Budget — per-task delta семантика (F-4.9)

`GET /api/budget?project=` возвращает **lifetime** usage проекта (сумма токенов всех сессий). Поэтому `budget_limit` трактуется как **per-task allowance**, а не lifetime-кап:

- `baseline` = lifetime usage на старте задачи (читается до `sendMessage`).
- `delta` = lifetime следующего poll − `baseline`.
- Стоп при `delta >= budget_limit` → статус `budget_exceeded`, warning в логе.
- Если baseline прочитать не удалось — fallback на сравнение lifetime напрямую с капом (warning, событие `budget_baseline_unavailable`).

Поток: `PUT /api/budget { project, tokenLimit }` **до** `sendMessage` (best-effort: ошибки — warning, не fail; кап персистится gateway в `~/.fan/agent/project-budgets.json`) → во время выполнения poll `GET /api/budget?project=` каждые **30 с** (`DEFAULT_BUDGET_POLL_INTERVAL_MS`) → каждый poll логируется JSON `budget_monitor` `{ project, used, limit, percentage, lifetime }`, где `used` — per-task delta → по завершении финальный usage report `used <delta> / <limit> tokens (lifetime <lifetime>)`.

> **Enforcement — только scheduler-side.** Gateway хранит и отдаёт капы, но **не блокирует** `sendMessage` при исчерпании (интеграция с BudgetTracker/model-manager сознательно отложена — backlog). Также агент не прерывается server-side при `budget_exceeded` — обрывается только ожидание scheduler'а.

## Persistent queue (F-4.13)

Pending-задачи переживают рестарты: список сериализуется в `<agentDir>/scheduler-pending.json` при **каждом** изменении очереди (enqueue/dequeue, хук `onPendingChange`) и восстанавливается на старте (`queue.restore(...)` → `runNext()`).

- **Формат:** `{ "version": 1, "tasks": [TaskConfig, ...] }` — version-check при загрузке; mismatch → файл игнорируется с warning.
- **Атомарная запись:** payload → `<path>.tmp` → rename поверх целевого файла (crash mid-write не оставляет обрезанный JSON). Rename вместо file lock — single-writer процесс.
- **Failure modes:** нет файла → пустая очередь (silent); битый JSON/форма → пустая очередь + warning + статус `degraded` в health (события `pending_file_corrupt` / `pending_version_mismatch`); невалидные записи пропускаются с warning (в т.ч. валидация чисел `timeout`/`budget_limit`).
- **Graceful shutdown** не требует flush — очередь уже на диске (write-on-change).
- **Ограничение (backlog):** задачи, удалённые из `config.yaml`, остаются в pending-файле до исполнения — очистка вручную или через control server pause + удаление файла.

Env: `FAN_CODING_AGENT_DIR` (default `~/.fan/agent`), `FAN_SCHEDULER_PENDING_FILE` — полный override пути (тесты, side-by-side инстансы).

## Activity monitor — chat interruption (F-4.12)

**Приоритет: `chat > autonomous tasks`.** Пока пользователь чатится, очередь scheduler'а на паузе; чат затих — очередь возобновляется.

Механизм — **scheduler-side polling** (gateway не менялся): `UserActivityMonitor` (`lib/activity-monitor.ts`) каждые `FAN_SCHEDULER_ACTIVITY_POLL_MS` (default **5 с**) делает `GET /api/sessions`; для изменившихся сессий (исключая созданные самим scheduler'ом — executor регистрирует их через `onSessionCreated`) читает detail; если последнее user-сообщение младше `FAN_SCHEDULER_ACTIVITY_WINDOW_MS` (default **60 с**) — чат активен → `queue.pauseCurrent()` + лог `chat_interruption` («Paused autonomous task for live chat»). Активность затухла → `queue.runNext()` + `chat_interruption_end`.

- **Resume:** запускается **следующая pending-задача**; in-flight задача server-side не абортируется (нет interruption endpoint в gateway — то же ограничение, что у timeout/budget).
- Монитор возобновляет только свои паузы, логирует переходы один раз (no flapping); ошибки poll — best-effort warnings, очередь не дёргается.

Env: `FAN_SCHEDULER_PAUSE_ON_USER_ACTIVITY` (default `true`; `off`/`0`/`false`/`no` выключает), `FAN_SCHEDULER_ACTIVITY_POLL_MS` (5000), `FAN_SCHEDULER_ACTIVITY_WINDOW_MS` (60000).

## Control server и health (F-4.12 / F-4.14)

HTTP-сервер (`lib/control-server.ts`), default bind `127.0.0.1:3457`, без auth (та же trust-модель, что у локального runtime):

| Route | Эффект |
|-------|--------|
| `POST /pause`  | `queue.pauseCurrent()` — пауза автономных задач |
| `POST /resume` | `queue.runNext()` — возобновление auto-advance |
| `GET /state`   | `{ state, isRunning, pendingCount, currentTask, lastResult, pausedForChat }` |
| `GET /health`  | `{ status, running, pendingCount, lastTaskStatus, uptimeSeconds, queueVersion }` |

- `status = "degraded"` при повреждённом pending-файле на старте (F-4.13) — задачи потеряны, смотрите логи; иначе `"ok"`. Только операционные метрики: без секретов, без содержимого задач, без блокирующих операций.
- Gateway проксирует: `GET /api/scheduler/health` → `GET {FAN_SCHEDULER_URL}/health` (env `FAN_SCHEDULER_URL`, default `http://127.0.0.1:3457`, timeout 2 с); недоступный scheduler → `503 { status: "degraded", scheduler: "down" }`.
- Провал bind'а control-сервера — warning, не crash: scheduler продолжает без него.

Env: `FAN_SCHEDULER_CONTROL` (default `true`), `FAN_SCHEDULER_CONTROL_PORT` (3457), `FAN_SCHEDULER_CONTROL_HOST` (default `127.0.0.1`; в compose — `0.0.0.0`, порт не публикуется на хост).

## Structured JSON logging (F-4.11)

Каждая запись — одна JSON-строка (JSONL): `{ timestamp (ISO 8601 UTC), level, module, event, taskId?, message, stack? }`. Модули: `scheduler | queue | executor | gh | control`. Routing: info/debug → stdout, warn/error → stderr; stack trace — только для error-уровня. Фильтрация: `LOG_LEVEL` (`debug|info|warn|error`, default `info`). Совместимо с Docker logging drivers и log aggregation. GitHub-токен никогда не логируется в открытом виде (маскирование `первые 4` + `***`).

## Git/PR политика

### Bot Identity — GitHub PAT (F-4.6)

Автономные git/PR-действия (ветки `fan-auto/*`, push, создание PR) выполняются под **отдельным GitHub-аккаунтом бота**, а не под личным аккаунтом разработчика. Scheduler читает PAT из переменной окружения `GITHUB_TOKEN` при старте.

#### Поведение scheduler'а

- При старте токен валидируется **один раз** запросом `GET https://api.github.com/user`; результат кэшируется (повторные обращения не ходят в сеть).
- Токен **никогда не логируется** в открытом виде — в логах используется маскированная форма (первые 4 символа + `***`, например `ghp_***`).
- Если токен **отсутствует** — scheduler логирует warning и продолжает работу; git/PR-зависимые действия помечаются недоступными (`gitEnabled=false`).
- Если токен **невалиден** (HTTP 401/403) или GitHub API недоступен — то же самое: warning с описанием причины, `gitEnabled=false`, scheduler не падает.
- Если у токена нет минимального scope `repo` (проверяется по заголовку `x-oauth-scopes`) — логируется предупреждение, что push/PR-действия могут завершаться ошибкой.

Программный интерфейс — `tools/fan-scheduler/lib/github-identity.ts`:

| Функция | Назначение |
|---------|-----------|
| `validateToken(token?)` | Валидация PAT через GitHub API (кэшируется); читает `GITHUB_TOKEN` из env, если аргумент не передан |
| `validateGitHubIdentity()` | Startup-helper: валидация + лог результата; никогда не бросает исключение |
| `isGitEnabled()` | `true`, если валидная identity подтверждена — можно выполнять git/PR-действия |
| `maskedToken(token)` | Маскировка токена для логов (`первые 4` + `***`) |

#### Создание bot account

1. Зарегистрируйте отдельный GitHub-аккаунт (например, `fan-bot`) с отдельным email. Не используйте личный аккаунт — все автономные коммиты/PR будут подписаны этой identity.
2. Добавьте bot account как **collaborator** в целевые репозитории (или в организацию с ролью, дающей push).
3. (Рекомендуется) Включите **branch protection** на `main`/`master`: запрет direct push, обязательные PR — бот работает только через ветки `fan-auto/*` и PR.

#### Создание PAT

1. Войдите под bot account → **Settings → Developer settings → Personal access tokens**.
2. Вариант A (рекомендуется) — **Fine-grained token**:
   - **Repository access:** Only select repositories → выберите репозитории для автономных задач;
   - **Permissions:** `Contents: Read and write`, `Pull requests: Read and write`;
   - срок жизни — по политике безопасности (с rotation).
3. Вариант B — **Classic token**: минимальный scope — `repo` (полный контроль приватных репозиториев). Для публичных репозиториев достаточно `public_repo`.
4. Скопируйте токен сразу — GitHub показывает его один раз.

#### Настройка окружения

Токен передаётся только через env var — **никогда не коммитьте его в репозиторий**:

```bash
# .env / docker-compose environment / systemd unit
GITHUB_TOKEN=ghp_...
```

При деплое через Docker — секция `environment:` в `docker-compose.yml` (сам файл с секретами — вне VCS) или Docker secrets.

#### Проверка вручную

```bash
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
# HTTP 200 → { "login": "fan-bot", ... }
```

При старте scheduler логирует результат валидации, например:

```
[github] identity validated: login=fan-bot (token ghp_***)
[github] git/PR-dependent actions unavailable (gitEnabled=false): GITHUB_TOKEN not configured
```

### Feature Branch Policy — fan-auto/<id>-<timestamp> (F-4.7)

Каждая автономная задача работает в уникальной feature-ветке. Коммиты **только** в feature-ветки — **никогда** в `main`/`master`.

#### Naming convention

```
fan-auto/<task-id>-<YYYYMMDD-HHmmss>
# пример: fan-auto/review-1-20260725-090000
```

- Timestamp — UTC, формат `YYYYMMDD-HHmmss`.
- Имя всегда соответствует regex `/^fan-auto\/[\w-]+-\d{8}-\d{6}$/` (экспортируется как `AUTONOMOUS_BRANCH_NAME_REGEX`).
- Идентификатор задачи санитизируется в git-safe slug: unicode → ASCII (диакритика срезается через NFKD), lowercase, пробелы/слэши/спецсимволы схлопываются в одиночный `-`, края подрезаются, длина ограничена 50 символами (`MAX_SLUG_LENGTH`).
- Результат **никогда** не равен `main`/`master`: slug, в точности совпадающий с защищённой веткой, префиксуется `task-` (например `main` → `task-main`); кроме того, префикс `fan-auto/` и суффикс timestamp делают совпадение невозможным в принципе.

Программный интерфейс — `tools/fan-scheduler/lib/branch-policy.ts` (чистые функции, единственный I/O — часы, инъецируются параметром `now` для тестов):

| Экспорт | Назначение |
|---------|-----------|
| `generateBranchName(task, now?)` | Генерация имени ветки: `fan-auto/<slug>-<timestamp>`; принимает `{ id?, name? }` или строку |
| `sanitizeTaskId(raw)` | Санитизация идентификатора в git-safe slug |
| `formatBranchTimestamp(date)` | Форматирование даты как `YYYYMMDD-HHmmss` (UTC) |
| `isValidBranchName(name)` | Проверка имени по `AUTONOMOUS_BRANCH_NAME_REGEX` |
| `AUTONOMOUS_BRANCH_NAME_REGEX` | Regex валидации: `/^fan-auto\/[\w-]+-\d{8}-\d{6}$/` |
| `AUTONOMOUS_BRANCH_POLICY` | Текст-константа system prompt для autonomous mode (см. ниже) |
| `PROTECTED_BRANCHES` | `['main', 'master']` |

#### System prompt template

`AUTONOMOUS_BRANCH_POLICY` — текст правила branch policy для агента в autonomous mode: создавай ветку `fan-auto/*` до начала изменений (`git checkout -b`), никогда не коммить/push в `main`/`master`, по завершении — `git add -A && git commit`, `git push -u origin <branch>`, `gh pr create --base main --head <branch>`.

> **Enforcement — prompt-level (backlog).** Политика реализована как system-prompt-константа + валидация naming; hard-enforcement на уровне git — через **GitHub branch protection** на `main`/`master` (рекомендуется, см. Bot Identity §3). Ветка создаётся агентом через bash tool: `git checkout -b fan-auto/task-X-20260725-120000`.

### PR creation via gh CLI (F-4.8)

После успешного завершения задачи на feature-ветке открывается Pull Request:

1. `git push -u origin <branch>` — **всегда до** создания PR (порядок enforced).
2. `gh pr create --base <base> --head <branch> --title "auto: <taskName>" --body "..."` — ровно 4 флага.

Гарантии (`lib/gh-client.ts`):

- **Base-ветка детектируется** из remote: `git symbolic-ref --short refs/remotes/origin/HEAD` (например `origin/main` или `origin/master`); при неудаче — fallback `main`.
- При `isGitEnabled() === false` (нет/невалиден `GITHUB_TOKEN`) — **никаких внешних вызовов**, статус `partial` + warning; задача не фейлится.
- Если `gh` binary недоступен — статус `partial` с причиной `'gh CLI not found — ensure GitHub CLI installed and authenticated'` (проверяется `gh --version` до push — ничего не пушится при отсутствии CLI).
- Провал `git push` — hard error (throw): `gh pr create` для незапушенной ветки не выполняется.

> **Интеграция (backlog):** библиотека `gh-client.ts` реализована и протестирована (мок `ExecFn` — точные команды, порядок, cwd), но **не подключена в прод-путь executor'а**: PR создаёт сам агент через bash tool по правилам `AUTONOMOUS_BRANCH_POLICY`. Подключение — будущая итерация.

## DB Backup — daily cron (F-4.15)

Ежедневный бэкап живой SQLite-базы `filin.db` (реальное имя файла — upstream hardcode, см. `packages/db/src/client.ts`; в ранних roadmap ошибочно упоминалась как `fan.db`). Реализация — standalone-скрипт **`deploy/scripts/backup-db.sh`** + системный cron на VPS. Scheduler не изменялся: бэкап — отдельная cron-задача ОС, сбой бэкапа изолирован и не влияет на scheduler.

### Что делает скрипт

1. Копирует `$FAN_AGENT_DIR/filin.db` (default `~/.fan/agent/filin.db`) в `$FAN_AGENT_DIR/backups/filin-YYYYMMDD-HHmmss.db`.
2. Ротирует старые копии — хранит **последние 7** (настраивается `KEEP`).
3. Идемпотентен: повторный запуск в ту же секунду пропускает копирование; ротация всегда сходится к `KEEP` файлам.
4. Сбой логируется в stderr и завершает скрипт с exit code 1 — процесс scheduler'а не затрагивается (задача выполняется системным cron'ом, не scheduler'ом).

### Механизм копирования: sqlite3 `.backup` vs cp

`filin.db` — **живая** БД. Голый `cp` может скопировать файл в середине записи (в WAL-режиме некоммиченные страницы лежат в `-wal`-сайдкаре, который cp не захватит согласованно). Поэтому скрипт выбирает механизм автоматически:

| Условие | Механизм | Гарантии |
|---------|----------|----------|
| `sqlite3` CLI доступен (предпочтительно) | `sqlite3 "$DB" ".backup '<dest>'"` — SQLite Online Backup API | Crash-safe для живой БД (корректен при WAL и активных писателях); результат проверяется `PRAGMA integrity_check` |
| `sqlite3` отсутствует (fallback) | `cp` + WARN в лог | Допустимо только потому, что окно 03:00 не пересекается с запланированными задачами — БД почти наверняка idle. Установите sqlite3: `apt-get install -y sqlite3` |

**Выбор задокументирован:** primary path — `.backup` (единственный безопасный способ для live-БД без остановки сервиса); cp — явно помеченный fallback с оговоркой про WAL.

### Cron-запись на VPS

```cron
# FAN DB backup — daily at 03:00 (F-4.15)
0 3 * * * /opt/fan-agent/deploy/scripts/backup-db.sh >> /var/log/fan-backup.log 2>&1
```

Установка: `crontab -e` под root, либо `/etc/cron.d/fan-backup`.

### Docker / volumes

- В контейнере БД живёт в `/data/.fan/agent/filin.db` (volume **`fan-data`**, env `FAN_AGENT_DIR=/data/.fan/agent`).
- Бэкапы по умолчанию пишутся в `/data/.fan/agent/backups/` — **в тот же volume `fan-data`** (отдельный volume `fan-backups` не требуется; compose не изменялся).
- Скрипт запускается **на хосте** через `docker exec` — в slim-образе нет sqlite3, поэтому cron-команда на VPS:

```cron
0 3 * * * docker exec fan-agent sh -c 'cp /data/.fan/agent/filin.db /data/.fan/agent/backups/filin-$(date +\%Y\%m\%d-\%H\%M\%S).db' >> /var/log/fan-backup.log 2>&1
```

либо (рекомендуется) примонтировать директорию `backups` из volume наружу и запускать хостовый `backup-db.sh` с `DB_PATH`/`BACKUP_DIR`, где хостовый sqlite3 даст безопасный `.backup`. Локальный запуск вне Docker (без контейнера) — прямой вызов скрипта, как в первой cron-записи.

### Env vars скрипта

| Переменная | Default | Назначение |
|-----------|---------|-----------|
| `FAN_AGENT_DIR` | `~/.fan/agent` | Директория данных агента (в Docker: `/data/.fan/agent`) |
| `DB_PATH` | `$FAN_AGENT_DIR/filin.db` | Полный путь к БД |
| `BACKUP_DIR` | `$FAN_AGENT_DIR/backups` | Директория бэкапов |
| `KEEP` | `7` | Сколько последних копий хранить |

### Безопасность бэкапов

Бэкапы содержат **те же секреты, что и БД** — токены `ClientToken` (доступ к API), историю сессий. Скрипт выставляет `chmod 600` на каждую копию (owner-only) и `chmod 700` на директорию `backups/`. Дополнительно:
- директория `backups/` — права `0700`;
- не выносите бэкапы в публично доступные mount'ы;
- при бэкапе наружу (off-site) — шифруйте (`gpg -c`) или используйте приватное хранилище.

## Troubleshooting

| Симптом | Диагностика | Решение |
|---------|-------------|---------|
| Задачи не выполняются, `FAN API token is not configured` | `docker compose logs fan-scheduler` | Provision ClientToken, задать `FAN_SCHEDULER_TOKEN` в `.env`, `docker compose up -d` |
| `git/PR-dependent actions unavailable (gitEnabled=false)` | Warning при старте scheduler | Проверить `GITHUB_TOKEN`: `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user` |
| `GET /api/scheduler/health` → 503 `scheduler: "down"` | `docker compose ps` — контейнер `fan-scheduler` жив? | `docker compose logs fan-scheduler`; проверить `FAN_SCHEDULER_URL` на gateway |
| `status: "degraded"` в health | В логах `pending_file_corrupt` / `pending_version_mismatch` | Pending-файл повреждён, задачи потеряны: удалить `scheduler-pending.json`, перезапустить; восстановить задачи через config |
| Задача `budget_exceeded` сразу после старта | Лог `budget_monitor` — сравнить `used`/`lifetime` | Должна быть delta-семантика (baseline); если `budget_baseline_unavailable` — gateway не отдал usage, проверить `GET /api/budget?project=` |
| Очередь «застряла» после паузы | `GET /state` → `pausedForChat` / `state` | `POST /resume` на control server; проверить, что монитор активности не видит «фантомный» чат (`FAN_SCHEDULER_ACTIVITY_WINDOW_MS`) |
| Задача удалена из config, но выполнилась | Ожидаемое поведение (backlog) | Задачи из pending-файла не синхронизируются с config — остановить scheduler, удалить `scheduler-pending.json` |
| Cron не срабатывает | Лог `scheduler_started` — сколько задач scheduled; cron-синтаксис | Валидация `isValidCron` при загрузке; время cron — в таймзоне процесса (в контейнере UTC) |
| Backup не создаётся | `/var/log/fan-backup.log`, exit code | Проверить пути `DB_PATH`/`BACKUP_DIR`, права, наличие `sqlite3` для безопасного `.backup` |

## Production checklist

- [ ] `FAN_SCHEDULER_TOKEN` provisioned (ClientToken в БД) и задан в `.env` — без него задачи падают
- [ ] `deploy/scheduler/config.yaml` (или `FAN_SCHEDULER_CONFIG`) — реальные задачи, workspace-пути **внутри контейнера** (`/data/repos/...`)
- [ ] `GITHUB_TOKEN` бот-аккаунта задан; PAT с scope `repo` / fine-grained `Contents: RW` + `Pull requests: RW`; бот — collaborator целевых репозиториев
- [ ] **Branch protection** на `main`/`master` (no direct push, обязательные PR) — hard-enforcement branch policy
- [ ] `gh` CLI доступен агенту в runtime (для `gh pr create` через bash tool)
- [ ] `docker compose ps` — оба сервиса `(healthy)`; `curl http://127.0.0.1:3456/api/scheduler/health` → `"ok"`
- [ ] Backup cron установлен (`0 3 * * * backup-db.sh`), `KEEP=7`, права 600/700; `sqlite3` на хосте для `.backup`
- [ ] `budget_limit` задан для задач с реальным расходом — помнить: enforcement scheduler-side, per-task delta
- [ ] Логи: `docker compose logs -f fan-scheduler` (JSONL) — настроить сбор при необходимости
- [ ] E2E: `bash deploy/scripts/e2e-local.sh` — секция 12 (103 проверки); git/PR/LLM-шаги — manual checklist в шапке секции 12

## Известные ограничения (backlog)

1. **Budget enforcement на gateway отсутствует** — gateway хранит/отдаёт капы, но не блокирует `sendMessage`; enforcement только scheduler-side (polling).
2. **Pause/timeout/budget не абортируют in-flight задачу** — у gateway нет interruption endpoint; обрывается только ожидание scheduler'а, агент дорабатывает server-side.
3. **Branch policy — prompt-level** — hard-enforcement только через GitHub branch protection (рекомендуется).
4. **`gh-client.ts` не подключён в прод-путь** — PR создаёт агент через bash tool; библиотека готова и протестирована, интеграция — future.
5. **Задачи, удалённые из config.yaml, остаются в pending-файле** — очистка вручную (`scheduler-pending.json`).
6. **Message queue gateway in-memory** (фаза 2) — сообщения, поставленные scheduler'ом в busy-очередь сессии, теряются при рестарте контейнера.
