# Roadmap: Фаза 4 — Автономность (Scheduler / Git/PR / Budget caps)

> **Дата создания:** 2026-07-25
> **Источник:** [spec_fan-network-agent_phase4-autonomy_2026-07-25.md](../../specs/spec_fan-network-agent_phase4-autonomy_2026-07-25.md) · [родительская spec](../../specs/spec_fan-network-agent_2026-07-25.md)
> **Фич:** 16 | **Этапов:** 6 | **E2E-сценариев:** 1

> ⚠️ **Предупреждение:** число фич (16) превышает мягкий лимит скилла (15) — допущено осознанно после аудита: добавлена карточка F-4.15 (бэкап fan.db) по требованию спеки §2.2. Разбиение не требуется — фичи обособлены.

---

## Сводная таблица по приоритетам

| Приоритет | Кол-во фич | Описание |
|-----------|-----------|----------|
| P0 (Must) | 10 | Scheduler-сервис, YAML config, API client, очередь, cron loop, bot-identity, ветки, gh CLI PR, budget caps, E2E |
| P1 (Should) | 6 | Persistent queue, retry/backoff, structured logging, chat interruption, health endpoint, DB backup |
| P2 (Could) | 0 | Отложено (workspace clone — вне roadmap) |
| P3 | 0 | Нет |

Зависимости от предыдущих фаз: фаза 4 зависит от фаз 0–2 (Docker/deploy, workspace-aware API, Service Registry). Файлы `tools/fan-scheduler/` — **новые**, не существуют в текущем репозитории.

---

## Легенда

| Маркер | Значение |
|--------|---------|
| ☐ | Не начато |
| ✅ | Готово |
| ⏳ | В работе |
| ❌ | Отклонено |

| Приоритет | MoSCoW | Оценка |
|-----------|--------|--------|
| P0 | Must Have | Критично для автономного режима |
| P1 | Should Have | Желательно до production scheduler |
| P2 | Could Have | Можно отложить |
| P3 | Won't Have | Отклонено для текущей фазы |

### Слои реализации

| Слой | Описание |
|------|----------|
| [API] | Изменения HTTP/WebSocket API (gateway, WS handler) |
| [DATA] | Очереди, файловое хранение, JSONL формат |
| [INTEG] | Интеграции: FAN API client, GitHub CLI (`gh`) |
| [BIZ] | Бизнес-логика: bot identity, budget caps, приоритеты задач |
| [CLI] | Команды CLI и формат конфигурации (YAML) |
| [INFRA] | Логирование, health endpoint, backup, структура пакетов |
| [E2E] | Комплексные сквозные сценарии |

---

## Этап 4.0 — Базовая инфраструктура scheduler'а

**Цель SMART:** До конца этапа пакет `tools/fan-scheduler/` существует со структурой из 6 файлов (`scheduler.ts`, `config.yaml`, `package.json`, `lib/queue.ts`, `lib/client.ts`, `lib/logger.ts`), парсит YAML-конфиг, формирует `TaskConfig` объекты, подключается к FAN API (GET /api/health) и запускается через `bun run`. Сборка без ошибок, интеграция с родительским monorepo проверена.

### Фичи

#### ✅ F-4.1: Создание пакета `tools/fan-scheduler/` + парсинг YAML config

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Инициализация нового пакета в `tools/fan-scheduler/` (отдельный Bun package) и реализация парсинга YAML-конфига. Структура: `scheduler.ts` (главный цикл), `lib/queue.ts` (очередь), `lib/client.ts` (FAN API client), `lib/logger.ts` (логирование), `package.json` (Bun), `config.yaml` (cron-конфигурация). Загрузчик `config.yaml` читает секцию `tasks[]`, каждую запись конвертирует в `TaskConfig { name, schedule, workspace, message, budget_limit?, timeout? }`. Валидация cron-строки. Дефолты: `budget_limit = null`, `timeout = 3600`.
- **Зависимости:** (none) — но зависит от готовности API gateway (фаза 0).
- **TDD-тесты:**
  - [ ] **TC-F-4.1-1:** Пакет собирается и YAML-конфиг загружается
    - *Условие:* `tools/fan-scheduler/package.json` существует, содержит `"main": "dist/scheduler.js"`, `"scripts": {"build": "tsc", "start": "bun dist/scheduler.js"}`; `config.yaml` с одним task
    - *Шаги:* `cd tools/fan-scheduler && bun install && bun run build`; `bun run start`; проверить парсинг в конструкторе Scheduler
    - *Ожидаемый результат:* Exit code 0; в логе сообщение «Scheduler started» или аналогичное; `tasks.length === 1`; поля `name`, `schedule`, `workspace`, `message` распарсены
  - [ ] **TC-F-4.1-2:** Корректный YAML → TaskConfig[] с дефолтами
    - *Условие:* `config.yaml` содержит 2 таска: один с full fields, другой без `budget_limit` и `timeout`
    - *Шаги:* `loadTasks('config.yaml')`; проверить поля обоих
    - *Ожидаемый результат:* Array of length 2; у первого `budget_limit` и `timeout` применены из конфига; у второго дефолты `budget_limit === null`, `timeout === 3600`
  - [ ] **TC-F-4.1-3:** Невалидный YAML выбрасывает ошибку
    - *Условие:* Некорректный YAML
    - *Шаги:* Вызвать загрузчик
    - *Ожидаемый результат:* Выброшена ошибка с описательным сообщением, содержащим номер строки
- **Критерии приёмки:**
  1. Директория `tools/fan-scheduler/` создана со всеми файлами; `bun run build` без ошибок
  2. YAML парсится; все обязательные поля валидируются
  3. Дефолты применяются корректно
- **Ожидаемый результат:** Новый пакет + `lib/config-loader.ts`; unit-тесты
- **Оценка объёма:** S

#### ✅ F-4.2: FAN API Client — базовый интерфейс

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** HTTP-клиент для интеграции с FAN API Gateway. Методы: `getSessionList(project?)`, `createSession(cwd)`, `sendMessage(sessionId, content)`, `getBudgetUsage(project)`, `setProjectBudget(project, limit)`, `updateBudget(project, data)`. Использует Token auth (Header: `Authorization: Bearer <token>`). Base URL читается из env `FAN_API_URL` (default `http://localhost:3456`).
- **Зависимости:** (none) — зависит от готовых endpoints API Gateway (фаза 0): `POST /api/sessions`, `PUT /api/budget`, `GET /api/budget`
- **TDD-тесты:**
  - [ ] **TC-F-4.2-1:** createSession возвращает session object
    - *Условие:* Mock FAN API отвечает `{ id: "clxxx", cwd: "/path" }` на POST /api/sessions
    - *Шаги:* `await client.createSession("/data/repos/my-project")`
    - *Ожидаемый результат:* Возвращён объект `{ id: "clxxx", cwd: "/path" }`; запрос отправлен с корректным Authorization header
  - [ ] **TC-F-4.2-2:** setProjectBudget устанавливает cap
    - *Условие:* Mock PUT /api/budget?project=/path&limit=500 → 200 OK
    - *Шаги:* `await client.setProjectBudget("/data/repos/my-project", 500)`
    - *Ожидаемый результат:* PUT запрос отправлен; тело содержит лимит токенов
- **Критерии приёмки:**
  1. Все 5 методов реализованы
  2. Auth token берётся из env var `FAN_API_TOKEN`
  3. Base URL из `FAN_API_URL`; fallback `http://localhost:3456`
- **Ожидаемый результат:** Файл `tools/fan-scheduler/lib/client.ts`
- **Оценка объёма:** S

---

## Этап 4.1 — Очередь задач и жизненный цикл

**Цель SMART:** TaskQueue выполняет ровно одну задачу одновременно, создаёт сессию через API Client, отправляет задачу, ждёт завершения через WS-подписку (timeout control), обновляет бюджет. Queue serializes приходящие задачи (single-consumer pattern). Тесты подтверждают отсутствие гонок (только один task.running = true).

### Фичи

#### ✅ F-4.3: TaskQueue — однопоточное выполнение

- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Класс `TaskQueue` с методами: `enqueue(task: TaskConfig)`, `runNext()`, `pauseCurrent()`, `isRunning: boolean`. Очередь pending-задач (array), но выполняется строго одна за раз. После завершения текущей задачи автоматически запускается следующая. State machine: `idle` ↔ `running` ↔ `paused`.
- **Зависимости:** F-4.1 (загрузка config → TaskConfig[])
- **TDD-тесты:**
  - [ ] **TC-F-4.3-1:** Одновременное выполнение запрещено
    - *Условие:* Два `enqueue` вызваны подряд
    - *Шаги:* Первый enqueue → check isRunning=true; затем второй enqueue → добавить в pending
    - *Ожидаемый результат:* isRunning=true; pending.length=1; после завершения первого — pending[0] взят
  - [ ] **TC-F-4.3-2:** Автозапуск следующей задачи после завершения
    - *Условие:* Pending queue содержит 2 задачи
    - *Шаги:* Запустить first → завершить → wait for auto-start
    - *Ожидаемый результат:* Second task starts automatically; isRunning stays consistent
  - [ ] **TC-F-4.3-3:** Пауза останавливает текущую, сохраняя очередь
    - *Условие:* Running task
    - *Шаги:* `pauseCurrent()`
    - *Ожидаемый результат:* isRunning=false; pending unchanged; task position preserved
- **Критерии приёмки:**
  1. Метод `enqueue()` добавляет в pending array без проверки running state
  2. `runNext()` проверяет `!this.isRunning && pending.length > 0`
  3. `finally` блок после execute вызывает `runNext()`
- **Ожидаемый результат:** Файл `tools/fan-scheduler/lib/queue.ts`
- **Оценка объёма:** S

#### ✅ F-4.4: Execution pipeline — session + message + budget

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Реализация `executeTask(task: TaskConfig)` внутри TaskQueue:
  1. `session = await fanClient.createSession({ cwd: task.workspace })`
  2. `await fanClient.sendMessage(session.id, task.message)`
  3. `await waitForCompletion(session.id, task.timeout)` — polling or WS subscription
  4. `await fanClient.updateBudget({ project: task.workspace, limit: task.budget_limit })`
  5. Логирование результата: `{ taskId, status, durationMs, tokensUsed }`
- **Зависимости:** F-4.2 (API Client), F-4.3 (TaskQueue skeleton)
- **TDD-тесты:**
  - [ ] **TC-F-4.4-1:** Полный пайплайн выполняется по порядку
    - *Условие:* Mock API: createSession → sendMessage → getBudgetUsage returns usage < limit
    - *Шаги:* `await executeTask(sampleTask)`
    - *Ожидаемый результат:* Все 4 шага выполнены последовательно; длительность = время выполнения каждого шага в сумме; лог содержит статус 'completed'
  - [ ] **TC-F-4.4-2:** Таймаут прерывает выполнение
    - *Условие:* `task.timeout = 2`; mock sendMessage blocks for 5 seconds
    - *Шаги:* `executeTask(sampleTask)`
    - *Ожидаемый результат:* Error thrown after 2s; status = 'timeout'; pending queue continues
- **Критерии приёмки:**
  1. Session создаётся с `cwd = task.workspace`
  2. Сообщение отправляется с полными текстом из config
  3. Таймаут сбрасывает running state и логирует ошибку
- **Ожидаемый результат:** Дополнение `tools/fan-scheduler/lib/queue.ts` — метод `executeTask`
- **Оценка объёма:** M

#### ✅ F-4.5: Cron scheduling loop

- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** Главный цикл `scheduler.ts`: загружает `config.yaml`, парсит tasks, планирует каждую задачу через cron-lib. При наступлении времени запуска — добавляет задачу в TaskQueue. Обработчики SIGINT/SIGTERM для graceful shutdown. Periodic scan config file для hot-reload изменений расписания.
- **Зависимости:** F-4.1 (config loading), F-4.3 (TaskQueue)
- **TDD-тесты:**
  - [ ] **TC-F-4.5-1:** Cron-триггер ставит задачу в очередь
    - *Условие:* Config с task schedule `"* * * * *"`; таймер запущен
    - *Шаги:* Ждать следующего минутного boundary
    - *Ожидаемый результат:* Task добавлен в queue.pending; scheduler.log содержит `[scheduled] task-name`
  - [ ] **TC-F-4.5-2:** Корректное завершение освобождает ресурсы
    - *Условие:* Scheduler running with active task
    - *Шаги:* Send SIGTERM
    - *Ожидаемый результат:* Process exits cleanly; running task marked as paused (not lost)
- **Критерии приёмки:**
  1. Каждая задача планируется независимо через cron library
  2. Multiple concurrent schedules handled by single TaskQueue
  3. SIGTERM/SIGINT обработаны с записью состояния в persistent storage
- **Ожидаемый результат:** Обновлённый `tools/fan-scheduler/scheduler.ts`
- **Оценка объёма:** M

---

## Этап 4.2 — Git/PR политика (bot identity + branches + PR)

**Цель SMART:** Agent работает под отдельной GitHub identity (bot PAT configured via env). При autonomous tasks agent создаёт ветку `fan-auto/<task-id>-<timestamp>`, коммитит в неё (never main/master), пушит и создаёт PR через `gh` CLI. Policy enforced в SKILL.md system prompt для autonomous agents. Integration tested via bash tool simulation.

### Фичи

#### ✅ F-4.6: Bot Identity — GitHub PAT configuration

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Настройка separate GitHub account (или GitHub App) для autonomous actions. Env var `GITHUB_TOKEN` содержит PAT с minimum scope `repo` (scoped к конкретным репозиториям через repo selection на GitHub). Документация по созданию bot account и PAT. PAT stored in docker-compose env vars (не hardcoded). Branch protection rule on main: no direct push required.
- **Зависимости:** (none) — external GitHub setup prerequisite
- **TDD-тесты:**
  - [ ] **TC-F-4.6-1:** PAT валидируется через GitHub API
    - *Условие:* Valid GITHUB_TOKEN with repo scope
    - *Шаги:* `fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` } })`
    - *Ожидаемый результат:* HTTP 200; response.user.login === 'fan-bot' (или configured username); permissions.repo === true
  - [ ] **TC-F-4.6-2:** Отсутствие токена обрабатывается корректно
    - *Условие:* No GITHUB_TOKEN env var
    - *Шаги:* Initiate any git+PR action
    - *Ожидаемый результат:* Error thrown: 'GITHUB_TOKEN not configured'; scheduler logs warning; task not scheduled
- **Критерии приёмки:**
  1. `GITHUB_TOKEN` env var read at scheduler startup
  2. Validation fetch executed once on init; cache result
  3. Token never logged (masked in log output)
- **Ожидаемый результат:** Обновлённый `tools/fan-scheduler/lib/client.ts` (+github methods); docs/guides/scheduler.md section
- **Оценка объёма:** S

#### ✅ F-4.7: Feature branch policy — fan-auto/<id>-<timestamp>

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Policy enforcement: каждая автономная задача создаёт уникальную feature-ветку. Naming convention: `fan-auto/<task-id>-<YYYYMMDD-HHmmss>`. Commits ONLY to feature branches. NEVER to main/master. System prompt template для agent в autonomous mode включает правило branch policy. Branch created via `git checkout -b fan-auto/task-X-20260725-120000` executed through bash tool.
- **Зависимости:** F-4.6 (bot identity available)
- **TDD-тесты:**
  - [ ] **TC-F-4.7-1:** Имя ветки соответствует соглашению
    - *Условие:* task.id='review-1', timestamp='20260725-090000'
    - *Шаги:* GenerateBranchName(task)
    - *Ожидаемый результат:* String 'fan-auto/review-1-20260725-090000'; regex match /^fan-auto\/[\w-]+-\d{8}-\d{6}$/
  - [ ] **TC-F-4.7-2:** Никогда не целится в main/master
    - *Условие:* task.name contains 'merge' or 'fix-master'
    - *Шаги:* GenerateBranchName(task)
    - *Ожидаемый результат:* Branch name DOES NOT equal 'main' or 'master'; sanitized if needed
- **Критерии приёмки:**
  1. Branch naming function isolated, testable, no I/O
  2. Regex validation prevents accidental targetting of protected branches
  3. Template added to autonomous agent system prompt
- **Ожидаемый результат:** Файл `tools/fan-scheduler/lib/branch-policy.ts`; документация в `docs/guides/scheduler.md`
- **Оценка объёма:** S

#### ✅ F-4.8: PR creation via gh CLI

- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Автоматическое создание Pull Request после успешного завершения задачи. Агент использует `gh pr create` через bash tool: base=main, head=fan-auto/<branch>, title="auto: <task summary>", body="Automated fix generated by FAN agent. Closes #<issue>". Post-commit flow: `git add .` → `git commit -m "auto: ..."` → `git push origin fan-auto/<branch>` → `gh pr create --base main --head fan-auto/<branch> --title "auto: ..." --body "..."`.
- **Зависимости:** F-4.7 (feature branch policy), F-4.6 (GitHub PAT)
- **TDD-тесты:**
  - [ ] **TC-F-4.8-1:** PR создаётся с корректными параметрами
    - *Условие:* Mock gh CLI returns `{ url: "https://github.com/.../pull/42" }`
    - *Шаги:* `createPR({ repo: 'my-project', branch: 'fan-auto/test-1', taskName: 'code-review' })`
    - *Ожидаемый результат:* Command `gh pr create --base main --head fan-auto/test-1 --title "auto: code-review" --body "Automated fix..."` executed; PR URL returned
  - [ ] **TC-F-4.8-2:** gh CLI недоступен → корректная ошибка
    - *Условие:* `gh` binary not found
    - *Шаги:* Attempt PR creation
    - *Ожидаемый результат:* Error: 'gh CLI not found — ensure GitHub CLI installed and authenticated'; task completes without PR (status flag = 'partial')
- **Критерии приёмки:**
  1. `gh pr create` executed with exactly 4 flags (--base, --head, --title, --body)
  2. Branch pushed before PR creation (order enforced)
  3. Failure modes documented and recoverable
- **Ожидаемый результат:** Функция `createPullRequest()` в `tools/fan-scheduler/lib/gh-client.ts`; новые файлы
- **Оценка объёма:** M

---

## Этап 4.3 — Контроль бюджета и надёжность

**Цель SMART:** Каждая задача запускается с установленным budget cap (`PUT /api/budget`). При достижении лимита — graceful shutdown задачи с логированием `TASK_STOPPED: budget exceeded (N/M tokens)`. Retry logic: до 3 попыток с экспоненциальным backoff (2s, 4s, 8s). Monitoring через GET /api/health. Всё покрыто unit-тестами.

### Фичи

#### ✅ F-4.9: Budget cap per task — enforce и monitor

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Before each task execution: call `fanClient.setProjectBudget(workspace, budgetLimit)`. During execution: poll `fanClient.getBudgetUsage(workspace)` every N seconds. Upon reaching limit: stop current agent execution, log alert, mark task as `budget_exceeded`. After task completion: optional reset or increase of general limit. Log format: `{ event: 'budget_monitor', project, used, limit, percentage }`.
- **Зависимости:** F-4.4 (execution pipeline), F-4.2 (API Client budget methods)
- **TDD-тесты:**
  - [ ] **TC-F-4.9-1:** Budget cap установлен до запуска задачи
    - *Условие:* task.budget_limit = 500; task.workspace = '/proj'
    - *Шаги:* Start task execution
    - *Ожидаемый результат:* PUT /api/budget?project=/proj&limit=500 called before sendMessage; log entry recorded
  - [ ] **TC-F-4.9-2:** Задача остановлена при превышении бюджета
    - *Условие:* Mock getBudgetUsage returns { used: 500, limit: 500 }
    - *Шаги:* Execute task with budget monitoring enabled
    - *Ожидаемый результат:* Task status = 'budget_exceeded'; logger outputs warning; no further tokens spent
  - [ ] **TC-F-4.9-3:** Бюджет ниже лимита — нормальное завершение
    - *Условие:* getBudgetUsage returns { used: 200, limit: 500 }
    - *Шаги:* Execute task to completion
    - *Ожидаемый результат:* Task status = 'completed'; log shows usage report: 'used 200 / 500 tokens'
- **Критерии приёмки:**
  1. Budget set перед sendMessage, monitored во время выполнения
  2. Graceful shutdown при превышении бюджета, в логе warning, exit code 0
  3. Мониторинг интервал configurable (default каждые 30 секунд)
- **Ожидаемый результат:** Enhanced `executeTaskWithBudget()` method в `tools/fan-scheduler/lib/queue.ts`
- **Оценка объёма:** M

#### ✅ F-4.10: Retry with exponential backoff

- **Приоритет:** P1
- **Слой:** [INFRA]
- **Описание:** При ошибках выполнения задачи (network failure, gh CLI unavailable, API timeout) — повторная попытка до 3 раз с exponential backoff: 2s, 4s, 8s. After all retries exhausted — mark task as failed, log error, continue to next pending task. Backoff config: `maxRetries: 3, baseDelayMs: 2000`.
- **Зависимости:** F-4.3 (TaskQueue)
- **TDD-тесты:**
  - [ ] **TC-F-4.10-1:** Повторная попытка успешна со второго раза
    - *Условие:* API returns error first time, success second time
    - *Шаги:* Execute task; track retry count
    - *Ожидаемый результат:* Total attempts = 2; second attempt succeeds; backoff delay ~2s between attempts
  - [ ] **TC-F-4.10-2:** Попытки исчерпаны → задача провалена
    - *Условие:* API always returns 500
    - *Шаги:* Execute task
    - *Ожидаемый результат:* 3 retries attempted; delays = 2s, 4s, 8s; final status = 'failed'; pending queue advances
- **Критерии приёмки:**
  1. Exponential backoff formula: `delay = baseDelayMs * 2^(attempt-1)`
  2. Only retryable errors retried (network, timeout, 5xx); non-retryable (4xx except 429) fail immediately
  3. Retry count logged per task execution
- **Ожидаемый результат:** Function `withRetry<T>(fn, options)` utility + integration в `executeTask` wrapper
- **Оценка объёма:** S

#### ✅ F-4.11: Structured JSON logging

- **Приоритет:** P1
- **Слой:** [INFRA]
- **Описание:** All scheduler log entries formatted as JSON lines (one JSON object per line). Fields: `timestamp` (ISO 8601), `level` (info/warn/error/debug), `module` (scheduler/queue/client/gh), `event` (action description), `taskId` (optional), `message` (human readable). Output to stdout/stderr. Compatible with Docker logging drivers and log aggregation tools.
- **Зависимости:** F-4.1 (scheduler package structure)
- **TDD-тесты:**
  - [ ] **TC-F-4.11-1:** Строка лога — валидный JSON
    - *Условие:* Logger.info('test event') called
    - *Шаги:* Capture stdout; parse as JSON
    - *Ожидаемый результат:* Parseable JSON object with keys: timestamp, level, module, event, message; levels = ['info', 'warn', 'error', 'debug']
  - [ ] **TC-F-4.11-2:** Фильтр уровня логирования работает
    - *Условие:* LOG_LEVEL=warn; logger.debug('skip this')
    - *Шаги:* Call logger methods
    - *Ожидаемый результат:* debug output NOT printed; warn/error output IS printed
- **Критерии приёмки:**
  1. All existing logger calls replaced with JSON formatter
  2. LOG_LEVEL env var controls verbosity (default info)
  3. Stack traces included for error level only
- **Ожидаемый результат:** Rewritten `tools/fan-scheduler/lib/logger.ts`; updated everywhere
- **Оценка объёма:** S

#### ✅ F-4.12: Chat interruption — pause autonomous tasks

- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** В `ws-handler.ts` API Gateway: incoming `sendMessage` от пользователя (chat) прерывает running autonomous task. Implementation: API Gateway sends signal to scheduler (HTTP POST `/api/scheduler/pause`) OR scheduler polls for chat messages via WS. Pause saves task state, resumes after user's message processed. Priority model: `chat > autonomous tasks`.
- **Реализация (отклонение от первоначального плана, обосновано):** gateway НЕ изменён — механизм полностью scheduler-side: `UserActivityMonitor` (`tools/fan-scheduler/lib/activity-monitor.ts`) поллит `GET /api/sessions`, исключает scheduler-owned сессии (регистрируются executor'ом через `onSessionCreated`), и при user-сообщении младше `FAN_SCHEDULER_ACTIVITY_WINDOW_MS` (default 60s) вызывает `queue.pauseCurrent()`; при затухании активности — `runNext()` (resume). Плюс localhost control server (`lib/control-server.ts`, порт `FAN_SCHEDULER_CONTROL_PORT`=3457): `POST /pause`, `POST /resume`, `GET /state` — внешний канал pause-сигнала. Обоснование: scheduler — отдельный процесс; WS-observer сложен и хрупок, gateway→scheduler push требует двусторонней связи; polling read-only API — просто, тестируемо, ноль изменений gateway (его 183 теста не тронуты). Resume behavior: автоматический запуск следующей pending-задачи; in-flight задача не абортируется server-side (нет interruption endpoint в gateway — то же ограничение, что F-4.4/F-4.9).
- **Зависимости:** F-4.3 (TaskQueue.pauseCurrent), F-4.2 (client methods available)
- **TDD-тесты:**
  - [x] **TC-F-4.12-1:** Чат прерывает запущенную задачу
    - *Условие:* Autonomous task running (isRunning=true)
    - *Шаги:* WS client sends `{ type: 'sendMessage', priority: 'chat', sessionId, content }`
    - *Ожидаемый результат:* scheduler.pauseCurrent() called; isRunning=false; user message processed; scheduler.log: 'Paused autonomous task for live chat'
  - [x] **TC-F-4.12-2:** Задача возобновляется после чата
    - *Условие:* User's message completed
    - *Шаги:* Проверить состояние scheduler'а
    - *Ожидаемый результат:* Next pending task starts (auto-runNext); or original task resumes (if implemented)
- **Критерии приёмки:**
  1. Chat priority check implemented in ws-message handler — **заменено scheduler-side polling** (см. «Реализация»): монитор активности чата паузит/возобновляет очередь
  2. Scheduler can receive pause signal (WebSocket bidirectional или HTTP endpoint) — ✅ HTTP control server: `POST /pause`, `POST /resume`, `GET /state` на 127.0.0.1:3457
  3. Resume behavior documented (current spec says "опционально") — ✅ задокументировано в README и выше
- **Ожидаемый результат:** `tools/fan-scheduler/lib/activity-monitor.ts` + `lib/control-server.ts` (gateway не патчился — решение задокументировано)
- **Оценка объёма:** M

---

## Этап 4.4 — Мониторинг и восстановление

**Цель SMART:** Health endpoint `GET /api/scheduler/health` возвращает `{ running: bool, pendingCount: number, lastStatus: string }`. Persistent queue сериализует все pending задачи в JSON файл при старте и восстанавливает при рестарте. Backup скрипт копирует `~/.fan/agent/fan.db` daily. Всё протестировано через smoke-тесты.

### Фичи

#### ✅ F-4.13: Persistent queue — file-based durability

- **Приоритет:** P1
- **Слой:** [DATA]
- **Описание:** In-memory `pendingTasks[]` сериализуется в `~/.fan/agent/scheduler-pending.json` при каждом изменении очереди. При старте scheduler'а — восстанавливает очередь из файла. Формат: `{ version: 1, tasks: [{ name, schedule, workspace, message, budget_limit, timeout }] }`. File lock предотвращает race conditions при записи.
- **Зависимости:** F-4.3 (TaskQueue)
- **TDD-тесты:**
  - [ ] **TC-F-4.13-1:** Очередь сохраняется при перезапуске scheduler'а
    - *Условие:* Queue has 2 pending tasks; write to disk
    - *Шаги:* Убить scheduler; перезапустить; прочитать очередь
    - *Ожидаемый результат:* 2 задачи восстановлены; pending.length === 2; order preserved
  - [ ] **TC-F-4.13-2:** Пустая очередь очищает файл
    - *Условие:* Queue empty; file exists with old data
    - *Шаги:* Start scheduler
    - *Ожидаемый результат:* Old file cleaned up или содержит пустой массив tasks; no stale tasks
- **Критерии приёмки:**
  1. Write on every enqueue/dequeue operation
  2. Read-on-startup with version check (future-proof)
  3. Atomic write (write temp file + rename) prevents corruption
- **Ожидаемый результат:** Enhanced `tools/fan-scheduler/lib/queue.ts` + `persistent-storage.ts` utility
- **Оценка объёма:** M

#### ✅ F-4.14: Health & metrics endpoint

- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Scheduler exposes internal health endpoint (accessible via API Gateway proxy or directly). Response: `{ status: "ok" | "degraded", running: boolean, pendingCount: number, lastTaskStatus: "completed" | "failed" | "budget_exceeded" | null, uptimeSeconds: number, queueVersion: 1 }`. Used by Docker healthcheck, monitoring systems, and dashboard widgets (phase 4 could-have).
- **Зависимости:** (none) — self-contained
- **TDD-тесты:**
  - [x] **TC-F-4.14-1:** Возвращает актуальное состояние scheduler'а
    - *Условие:* Scheduler with 1 running task, 2 pending
    - *Шаги:* GET /api/scheduler/health (via local port)
    - *Ожидаемый результат:* `{ running: true, pendingCount: 2, uptimeSeconds: N > 0, queueVersion: 1 }`; status = 'ok'
  - [x] **TC-F-4.14-2:** Статус degraded при повреждённой очереди
    - *Условие:* Pending file exists but unparseable
    - *Шаги:* Start scheduler; GET health
    - *Ожидаемый результат:* status = 'degraded'; error noted in logs
- **Критерии приёмки:**
  1. Endpoint accessible at `/api/scheduler/health` (proxied through api-gateway router)
  2. Response schema matches interface; no secret/token leaks
  3. No blocking operations (reads only in-memory state)
- **Ожидаемый результат:** Route added to `packages/api-gateway/src/http-server.ts`; scheduler state provider
- **Оценка объёма:** S

#### ✅ F-4.15: DB backup fan.db — daily cron

- **Приоритет:** P1
- **Слой:** [INFRA]
- **Описание:** Backup `~/.fan/agent/fan.db` по расписанию (daily cron) согласно спецификации phase4 (§2.2). Скрипт копирует SQLite БД в директорию бэкапов с timestamp-именем (`fan-YYYYMMDD.db`), ротация старых копий (хранить последние 7). Реализация: cron-запись на VPS или задача в scheduler config.
- **Зависимости:** F-4.5 (cron scheduling loop) или системный cron VPS
- **TDD-тесты:**
  - [ ] **TC-F-4.15-1:** Backup создаётся по расписанию
    - *Условие:* `~/.fan/agent/fan.db` существует; cron-задача настроена
    - *Шаги:* Триггер cron (или ручной запуск скрипта); проверить директорию бэкапов
    - *Ожидаемый результат:* Файл `fan-YYYYMMDD.db` создан; копия побайтово совпадает с оригиналом
  - [ ] **TC-F-4.15-2:** Ротация хранит последние 7 копий
    - *Условие:* В директории бэкапов уже 7 файлов
    - *Шаги:* Запустить backup ещё раз
    - *Ожидаемый результат:* Создана новая копия; самая старая удалена; всего файлов = 7
- **Критерии приёмки:**
  1. Backup `fan.db` выполняется ежедневно автоматически
  2. Ротация ограничивает число копий (default 7)
  3. Сбой backup логируется и не влияет на работу scheduler'а
- **Ожидаемый результат:** Backup-скрипт + cron-конфигурация; документация в `docs/guides/scheduler.md`
- **Оценка объёма:** S

<!-- Workspace clone перенесена в блок «Вне roadmap (future)» — см. внизу документа -->

---

## E2E-сценарии фазы 4

#### ✅ F-4.16-E2E: E2E — Cron-задача из YAML: полный цикл + budget alarm

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Сквозной сценарий: cron-задача из config.yaml срабатывает → scheduler обновляет существующий клон репозитория (git fetch/pull; первичное клонирование — предусловие, вне roadmap) → создаёт сессию через FAN API → агент делает ветку, коммит, push → открыт PR через gh → при превышении бюджета задача остановлена с алертом. Проверяет весь chain: scheduler → API → agent → git → PR → budget.
- **Зависимости:** F-4.1..F-4.9
- **TDD-тесты:**
  - [x] **TC-F-4.16-E2E-1:** Полный автономный цикл — успешный путь
    - *Условие:* Config с daily-code-review task; FAN API запущен; GITHUB_TOKEN настроен; workspace существует
    - *Шаги:*
      1. Подождать cron trigger (или simulate trigger)
      2. Убедиться: scheduler loads config → creates task in queue
      3. Убедиться: queue picks up task → calls createSession(cwd)
      4. Убедиться: sendMessage(sessionId, task.message) sent
      5. Wait for session completion (poll getSession)
      6. Убедиться: agent created branch `fan-auto/*-YYYYMMDD-*` in workspace
      7. Убедиться: files modified, committed in feature branch
      8. Убедиться: git push executed to feature branch
      9. Убедиться: PR created via `gh pr create` (проверить API или GH UI)
    - *Ожидаемый результат:* Task status = 'completed'; PR URL в логах; budget used ≤ budget_limit; no errors
  - [x] **TC-F-4.16-E2E-2:** Превышение бюджета → корректная остановка
    - *Условие:* Task с budget_limit=100 (минимальный для тестирования); agent расходует токены быстро
    - *Шаги:*
      1. Запустить задачу
      2. Monitor budget_usage via GET /api/budget
      3. Когда used ≥ limit, проверить поведение scheduler
    - *Ожидаемый результат:* Task status = 'budget_exceeded'; log: `Task daily-code-review stopped: budget exceeded (100 tokens)`; no tokens wasted beyond limit; pending queue unaffected
  - [x] **TC-F-4.16-E2E-3:** Две cron-задачи одновременно — сериализация
    - *Условие:* Config с двумя задачами, обе расписаны на одно время
    - *Шаги:*
      1. Оба trigger события происходят одновременно
      2. Обе enqueue в TaskQueue
      3. Запустить scheduler
    - *Ожидаемый результат:* Первая задача выполняется (first-in-first-out); вторая ожидает в pending; после первой — вторая стартует автоматически; ни одна задача не потеряна
- **Критерии приёмки:**
  1. Полный цикл от cron до PR создаётся автоматически без ручных действий
  2. Budget cap работает как защитный механизм — задача останавливается точно на лимите
  3. Конфликт одновременных задач разрешён через FIFO очередь
- **Ожидаемый результат:** Автоматизированный E2E тест (скрипт на Bun) или ручной checklist с screenshot результатов
- **Оценка объёма:** L
- **Реализация (2026-07-26):** секция 12 в `deploy/scripts/e2e-local.sh` (27 проверок, 2× прогон 103/103 PASS).
  Scheduler запускается как compose-сервис `fan-scheduler` (тот же образ, `bun tools/fan-scheduler/dist/scheduler.js`;
  Dockerfile собирает и поставляет tools/fan-scheduler, .dockerignore разрешает его). Автоматизировано: загрузка
  config.yaml → cron trigger → FIFO-сериализация двух задач (TC-3) → persistent queue на диске (F-4.13) →
  pause/resume через control server (F-4.12) → createSession 201 → budget_cap_set до sendMessage (F-4.9) →
  provider boundary (нет LLM — ожидаемый status=failed после 3 попыток retry, F-4.10) → /api/scheduler/health
  proxy (F-4.14) → budget API PUT/GET/400 + файл в fan-data volume. Git/PR/LLM-шаги TC-1 и реальный
  budget_exceeded TC-2 (нужен расход токенов) — manual checklist в шапке секции 12; budget_exceeded покрыт
  unit-тестом executor (TC-F-4.9-2).

---

## Граф зависимостей

```
Фаза 4 — Autonomous Tasks
├── Этап 4.0: Базовая инфраструктура
│   ├── F-4.1: Create scheduler package + YAML (INFRA) ─────┐
│   └── F-4.2: FAN API Client (INTEG) ──────────────────────┤
│                                                           │
├── Этап 4.1: Очередь задач и жизненный цикл                │
│   ├── F-4.3: TaskQueue (DATA) ←───────────────────────────┼──►
│   ├── F-4.4: Execution pipeline (INTEG) ←── F-4.1,F-4.2   │
│   └── F-4.5: Cron scheduling loop (CLI) ←── F-4.1,F-4.3   │
│                                                           │
├── Этап 4.2: Git/PR политика                               │
│   ├── F-4.6: Bot identity (BIZ)                           │
│   ├── F-4.7: Feature branch policy (INTEG) ←── F-4.6      │
│   └── F-4.8: PR creation via gh (INTEG) ←── F-4.6,F-4.7   │
│                                                           │
├── Этап 4.3: Контроль бюджета и надёжность                 │
│   ├── F-4.9: Budget cap (BIZ) ←── F-4.4,F-4.2            │
│   ├── F-4.10: Retry/backoff (INFRA) ←── F-4.3             │
│   ├── F-4.11: Structured logging (INFRA) ←── F-4.1        │
│   └── F-4.12: Chat interruption (API) ←── F-4.3           │
│                                                           │
├── Этап 4.4: Мониторинг и восстановление                    │
│   ├── F-4.13: Persistent queue (DATA) ←── F-4.3           │
│   ├── F-4.14: Health endpoint (API)                       │
│   └── F-4.15: DB backup fan.db (INFRA) ←── F-4.5          │
│                                                           │
└── E2E                                                     │
    └── F-4.16-E2E: Full cycle + budget alarm ←── ALL above     │

Проверка циклов: Циклов нет. DAG ✓
```

---

## Полный чеклист по приоритетам

### P0 (Must Have) — 10 фич

- [ ] ✅ F-4.1 Создание пакета `tools/fan-scheduler/` + парсинг YAML
- [ ] ✅ F-4.2 FAN API Client — базовый интерфейс
- [ ] ✅ F-4.3 TaskQueue — однопоточное выполнение
- [ ] ✅ F-4.4 Execution pipeline — session + message + budget
- [ ] ✅ F-4.5 Cron scheduling loop
- [ ] ✅ F-4.6 Bot Identity — GitHub PAT configuration
- [ ] ✅ F-4.7 Feature branch policy
- [ ] ✅ F-4.8 PR creation via gh CLI
- [ ] ✅ F-4.9 Budget cap per task
- [ ] ✅ F-4.16-E2E E2E: cron-задача полный цикл + budget alarm

### P1 (Should Have) — 6 фич

- [ ] ✅ F-4.10 Retry with exponential backoff
- [ ] ✅ F-4.11 Structured JSON logging
- [ ] ✅ F-4.12 Chat interruption — pause tasks
- [ ] ✅ F-4.13 Persistent queue
- [ ] ✅ F-4.14 Health & metrics endpoint
- [ ] ✅ F-4.15 DB backup fan.db — daily cron

### P2 (Could Have) — 0 фич

_Нет фич._

---

## Вне roadmap (future)

- **Workspace clone before task execution** (P2) — перенесена из основного плана. Будет реализована после стабилизации scheduler'а.

---

## Итоговая оценка

| Мера | Значение |
|------|---------|
| Всего фич | 16 (10 реализаций + 1 E2E + 6 P1) |
| P0 фич | 10 (9 реализаций + 1 E2E) |
| P1 фич | 6 |
| P2 фич | 0 (workspace clone — вне roadmap) |
| Этапов | 6 (инфраструктура, очередь, git/PR, бюджет/надёжность, мониторинг, E2E) |
| Оценка P0 | ~3 дня (infra: 4h + queue: 8h + git/PR: 8h + budget: 6h + E2E: 4h) |
| Оценка полная | ~5–8 дней (с учётом P1 и P2) |
| Путь к production | P0-complete → scheduler test на staging VPS → enable cron → monitor → rollout |

**Зависимости от предыдущих фаз:**
- Фаза 0: Docker/deploy + nginx/TLS для запуска scheduler'а на VPS
- Фаза 1: Workspace-aware API (cwd параметры, project endpoints) для scheduler клиента
- Фаза 2: Service Registry + queue UX для обработки очередей

---

*Сгенерировано: docs-impl agent · 2026-07-25*
*На основе: spec_fan-network-agent_phase4-autonomy_v1.0*
*Новые файлы (не существуют): `tools/fan-scheduler/` — вся директория*
