# FAN Orchestrator v7.10.0

> Multi-agent task decomposition and coordination for FAN.
> **v7.10.0** — Named model-config presets: сохранение/переключение/удаление именованных конфигураций моделей (`presets`, `activePreset`) + multi-provider списки моделей в `/orchestrator models` (модели выбранного провайдера сверху, все остальные провайдеры ниже).
> Pipeline Mode: `/pipeline` command, auto-update hooks, state recovery, conventional-commits policy.

Портирован из fan-orchestrator с сохранением стабильной архитектуры воркеров. Расширение для FAN, добавляющее режим координатора, доску задач, 8 специализированных воркеров, систему разрешений и Pipeline Mode для многофазных проектов.

## Highlights

- **8 специализированных воркеров** — explore, plan, implement, verify, bug-fix, code-research, tests-impl, docs-impl
- **Pi-style RPC protocol** — JSONL over stdin/stdout, единый `stallTimer`, без жёсткого лимита выполнения
- **Slot pool concurrency** — read-only агенты параллельно (до `parallelWorkers`, каждый в своём пуле), write-агенты эксклюзивно (параллельные write-воркеры блокируются слотом)
- **🆕 `/orchestrator models`** — умное назначение моделей воркерам (scoring-профили `WORKER_PROFILES`: reasoning/context/cost/maxTokens), интерактивный wizard, multi-provider списки (выбранный провайдер сверху, все остальные ниже)
- **🆕 Named presets** — сохранение/переключение/удаление именованных конфигураций моделей; `activePreset` отображается в `/orchestrator status` и `/orchestrator config`
- **Interactive permission approval** — Allow/Block prompt на опасные команды + поддержка `FAN_DANGEROUSLY_SKIP_PERMISSIONS` env / `--dangerously-skip-permissions`
- **Task management** — `TaskCreate`/`TaskUpdate`/`TaskClear`/`cancel_task` со статусным виджетом (`Alt+T`)
- **Permission system** — heredoc, pipes, interpreters, fork-bomb detection, audit log (`~/.fan/agent/audit/orchestrator.log`)
- **🆕 Pipeline Mode v3.1.0** — 3 рабочих артефакта (`development-plan.md`, `development-log.md`, `phase-status.json`), `/pipeline` command, авто-обновление через хуки на `TaskCreate`/`TaskUpdate`, state recovery после обрыва сессии
- **🆕 Commit policy** — conventional-commits per-phase / per-function / manual

## Architecture

### Worker lifecycle (fan-style)
- **`stallTimer`** — единственный таймер зависания, сбрасывается на любой stdout
- **Recursive poll** — `setTimeout(2000)` рекурсивно, без ограничений по итерациям
- **RPC JSONL protocol** — stdin/stdout взаимодействие с subprocess: `prompt`, `get_state`, `get_last_assistant_text`
- **Direct id-matching** — ответы сопоставляются по id (PROMPT_ID, STATE_ID, TEXT_ID), без Promise-based resolvers
- **Worker pool** — read-only агенты параллельно (до `config.parallelWorkers`), write-агенты последовательно

### Slot pool
- **Read-only воркеры** (explore, plan, verify, code-research): до `config.parallelWorkers` (default 3) одновременно
- **Write воркеры** (implement, bug-fix, tests-impl, docs-impl): строго 1 (эксклюзивный слот)
- **FIFO-очередь** при переполнении

### Модули расширения

| Файл | Назначение |
|------|-----------|
| `orchestrator-extension.js` | Главный модуль: регистрация команд, хуков, инициализация Pipeline Mode |
| `orchestrator-tools.js` | LLM-инструменты (delegate_task, TaskCreate, TaskUpdate, assess_task, stop_worker и др.) |
| `pipeline-state.js` | Pipeline State: 10 instance методов + 1 static, 3 рабочих артефакта, атомарные записи |
| `agents.js` | Реестр агентов: 8 воркеров, координаторский промпт, discovery |
| `config.js` | Загрузка/сохранение конфигурации (`~/.fan/agent/extensions/fan-orchestrator/config.json`) |
| `permissions.js` | Проверка опасных команд (делегирует в core `@seaagents/fan-coding-agent`) |
| `broker-handler.js` | MCP tool broker: подписка на EventBus (`mcp:catalog`), обработка `remote_tool_request` от воркеров, per-worker profile filtering (`all` / `read-only`) |
| `config.example.json` | Шаблон конфигурации — авто-копируется в `config.json` при первом запуске (сам `config.json` исключён из пакета) |
| `audit.js` | JSONL-аудит в `~/.fan/agent/audit/orchestrator.log` |
| `subagent-runner.js` | Запуск воркеров, fan-style RPC, stall timer |
| `task-manager.js` | Управление задачами: создание, обновление, статусы, виджет |
| `workers.js` | Реестр активных воркеров: ID, статус, метрики |
| `task-complexity.js` | L1/L2/L3 оценка сложности задач |

## Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `delegate_task` | Single, chain, or parallel worker dispatch |
| `TaskCreate` | Create tracked task with optional `blocks[]` |
| `TaskUpdate` | Update task status (`pending` → `in_progress` → `completed`/`failed`) |
| `TaskClear` | Clear completed/failed tasks |
| `list_tasks` | List tasks with optional status filter |
| `cancel_task` | Cancel running or pending task by ID |
| `classify_task` | Classify description to suggest best agent |
| `assess_task` | Multi-level complexity assessment (L1/L2/L3) |
| `stop_worker` | Stop running worker by ID |

## Agent Types

| Agent | Access | Use case |
|-------|--------|----------|
| 🔍 explore | Read-only | Fast codebase recon: file search, structure analysis |
| 📋 plan | Read-only | Architectural planning: design, strategy, approach |
| 🛡️ verify | Read-only | Adversarial verification: build, tests, lint, edge cases |
| 🔬 code-research | Read-only | Deep READ-ONLY research with structured reports |
| 🔧 implement | Write | General code changes, new features |
| 🐛 bug-fix | Write | Bug fixing pipeline: reproduce → root cause → fix → verify |
| 🧪 tests-impl | Write | Test writing for new/modified code |
| 📝 docs-impl | Write | Documentation: README, CHANGELOG, MANIFEST |

## Slash Commands

### Orchestrator control

| Command | Description |
|---------|-------------|
| `/orchestrator on` | Enable coordinator mode |
| `/orchestrator off` | Disable coordinator mode |
| `/orchestrator status` | Show provider, workers, tasks, agents |
| `/orchestrator config` | Show current configuration |
| `/orchestrator init` | Interactive configuration wizard |
| `/orchestrator models` | Interactive model assignment: smart suggestions per worker, multi-provider lists, named presets (save/switch/delete) |
| `/orchestrator mode <auto\|cloud\|local>` | Switch provider mode |
| `/orchestrator retry` | Retry last failed task |
| `/orchestrator stop` | Stop all active workers |

### Planning & task board

| Command | Description |
|---------|-------------|
| `/plan <task>` | Research → Plan (документация на русском) |
| `/tasks [status]` | Task board |
| `/agents [scope]` | List available agents |
| `/delegate <agent> <task>` | Quick single worker dispatch |

### 🆕 Pipeline Mode (v7.4.0)

| Command | Description |
|---------|-------------|
| `/pipeline init` | Initialize pipeline: create 3 working artifacts |
| `/pipeline status` | Show pipeline progress (widget, 10s) |
| `/pipeline log [N]` | Show last N log entries (default 10) |
| `/pipeline finish` | Mark complete + Keep/Delete artifacts |
| `/pipeline cancel` | Deactivate in-memory, artifacts preserved |

**Shortcuts:** `Alt+O` (toggle coordinator), `Alt+T` (toggle task widget)

## Pipeline Mode (v3.1.0) — подробно

### Что это

Pipeline Mode — режим для многофазных работ по большой спеке (например, реализация 16-фазного проекта, как в архитектуре FAN). Координатор создаёт 3 рабочих артефакта на диске, и каждый `TaskCreate`/`TaskUpdate` **автоматически** обновляет их без явного вызова координатором.

Реализация: модуль `pipeline-state.js` (класс `PipelineState`, 757 строк).

### 3 рабочих артефакта

| Файл | Назначение | Когда обновляется |
|------|-----------|-------------------|
| `docs/development-plan.md` | Roadmap: фазы, фичи, критерии приёмки, риски, commit policy | При `/pipeline init` |
| `docs/development-log.md` | Append-only журнал: что сделано / тесты / commit / следующий шаг | Каждый `recordLogEntry()` и через хук на `TaskUpdate` |
| `.fan/tracking/phase-status.json` | JSON state machine для автообновления и восстановления | Каждый `recordPhaseChange()` и `recordStatusChange()` через хук |

### Авто-обновление

Когда pipeline активен, каждый `TaskCreate` и `TaskUpdate` **автоматически** (без явного вызова координатора) обновляет:

- `.fan/tracking/phase-status.json` — добавляется/обновляется запись `data.tasks[taskId]`
- `docs/development-log.md` — append записи с ISO датой, phaseId, статусом

Хук реализован в `fan.on("tool_result", ...)` (см. `orchestrator-extension.js`, строка 335):

```js
fan.on("tool_result", (event, ctx) => {
    if (pipelineState?.instance && (event.toolName === "TaskCreate" || event.toolName === "TaskUpdate")) {
        // авто-обновление phase-status.json и development-log.md
    }
});
```

Координатору **не нужно** думать про pipeline — он просто делает `TaskCreate`/`TaskUpdate`, а хук всё обновляет.

### Commit policy

| Стратегия | Когда коммитим | Conventional Commit Format |
|-----------|---------------|-----------------------------|
| `per-phase` | После `TaskUpdate completed` последней задачи в фазе | `feat(phase-N): <name> complete` |
| `per-function` | После каждого `TaskUpdate completed` | `feat(phase-N/F-X.Y): <summary>` |
| `manual` | Никогда автоматически | — |

Метод `PipelineState.shouldCommit(phaseId)` определяет, нужно ли коммитить. `formatCommitMessage()` генерирует conventional-commit сообщение.

### State Recovery

Если сессия оборвалась — при следующем `session_start`:

1. Читается `.fan/tracking/phase-status.json`
2. Если валиден и `featureName !== "_probe_"` → pipeline восстанавливается в памяти
3. Логируется: `[FAN Pipeline] Restored pipeline: <name> (<slug>)`
4. Координатор продолжает с `currentPhase` из JSON

Реализация: `orchestrator-extension.js`, строка 252 (в `session_start` хуке).

### Класс PipelineState

Модуль `pipeline-state.js` экспортирует класс `PipelineState` со следующими методами:

| Метод | Описание |
|-------|----------|
| `static detectProjectSlug(cwd)` | Определить slug проекта из package.json, Cargo.toml, pyproject.toml или basename |
| `constructor(cwd, options)` | Создать экземпляр с опциями: featureName, slug, phases, commitStrategy, source, description, onConflict, nonBlocking |
| `ensureArtifacts()` | Создать директории `.fan/tracking/` и `docs/` |
| `init()` | Инициализировать все 3 артефакта (с резолвом конфликтов) |
| `getStatus()` | Прочитать и распарсить `phase-status.json` |
| `getLog()` | Прочитать `development-log.md` |
| `getPlan()` | Прочитать `development-plan.md` |
| `recordPhaseChange({ phaseId, status, action, notes, commitSha })` | Записать смену статуса фазы |
| `recordLogEntry({ phaseId, action, content })` | Append запись в development-log.md |
| `recordStatusChange({ taskId, phaseId, status, description, result })` | Обновить запись задачи в phase-status.json + development-log.md |
| `getCurrentPhase()` | Вернуть текущую IN_PROGRESS фазу или null |
| `shouldCommit(phaseId)` | Определить, нужен ли git commit |
| `formatCommitMessage({ phaseId, action, summary, feature })` | Сгенерировать conventional-commit сообщение |

### Пример: реализация SPEC

```bash
# День 1
fan
> Реализуй docs/specs/foo/SPEC.md (16 фаз)
# координатор создаёт 16 TaskCreate с blocks[]

> /pipeline init
→ Feature name: foo port
→ Strategy: per-phase
→ Phases: (16 фаз multi-line)
✅ Pipeline initialized

# работа по фазам:
> delegate_task(agent="implement", task="Phase 0: workspace")
> delegate_task(agent="verify", task="Phase 0 verification")
> bash: git add ... && git commit -m "feat(phase-0): Foundation complete"
> TaskUpdate(taskId, completed)
# ХУК: append в development-log.md + обновление phase-status.json

# день 2 (после обрыва):
fan
> [FAN Pipeline] Restored pipeline: foo port, 16 phases, 5 complete
> /pipeline status
# Current Phase: 5, Overall: 5/16 complete
```

### inferPhaseId()

Функция `inferPhaseId(subject)` (замыкает `orchestrator-extension.js`, строка 1634) извлекает номер фазы из строки описания задачи. Матчит паттерны: `"Phase X:"`, `"phase-X"`, `"phase X"`, `"(phase X)"`, `"[Phase X]"`. Используется в авто-хуке для привязки taskId к фазе.

## Модели воркеров и пресеты

### `/orchestrator models` — как это работает

Интерактивный wizard для назначения моделей воркерам (требует UI; в headless-режиме — редактируйте `config.json` вручную):

1. **Preset menu** (если есть сохранённые пресеты) — Edit current config / Switch active preset / Save current config as preset / Delete preset.
2. **Provider mode** — выбор, для какого режима настраивать модели: `☁️ cloud`, `🏠 local` или `⚙️ auto` (оба).
3. **Provider для suggestions** — выбор провайдера для умных предложений (активный провайдер сессии определяется автоматически и помечается `⭐ active`). Модели провайдера фильтруются по бренду (`BRAND_KEYWORDS`: например, провайдер `qwen` → только Qwen-модели; агрегаторы и local — без фильтра).
4. **Smart assignment** — scoring-профили `WORKER_PROFILES` (веса reasoning / context / cost / maxTokens на воркера): тяжёлые воркеры (implement, plan, bug-fix) получают флагманские reasoning-модели, лёгкие (verify, docs-impl) — дешёвые/быстрые. Назначение идёт в порядке приоритета (`ASSIGNMENT_ORDER`), уже занятые модели штрафуются для разнообразия.
5. **Accept / Customize / Reset** — принять предложение целиком, изменить отдельных воркеров или сбросить все override'ы на модель сессии.

В шаге **Customize** список показывает модели **всех провайдеров**: предложенная модель закреплена сверху (pre-selected), затем модели выбранного провайдера, затем остальные провайдеры по алфавиту (с суффиксом `· provider` в label).

Model IDs сохраняются в формате **`provider/id`** — это устраняет неоднозначное разрешение ID, когда одинаковый id модели встречается у нескольких провайдеров (fix из v7.9.0; читаются оба формата — `id` и `provider/id`).

### Named presets

Пресет — именованный снапшот модельной части конфигурации: `{cloud, local, providerMode}`.

- Хранятся в `config.json`: `presets` (`Record<name, {cloud, local, providerMode}>`) + `activePreset` (имя активного пресета или `null`).
- Меню пресетов показывается при старте `/orchestrator models` (если пресеты есть): **Edit** / **Switch** (активный помечен `✔`) / **Save-as** / **Delete** (с подтверждением).
- При сохранении изменений (Accept/Customize/Reset) активный пресет **автоматически ресинхронизируется** — снапшот обновляется вместе с конфигом.
- Если пресетов ещё нет, после сохранения предлагается создать первый.
- Активный пресет отображается в `/orchestrator status` (`⭐ Active preset: ...`) и `/orchestrator config` (`⭐ Preset: name (N saved)`).
- Зарезервированные имена (`__proto__`, `constructor`, `prototype`) отклоняются; невалидные пресеты вычищаются при загрузке конфига.

Хелперы экспортируются из `config.js`:

| Функция | Назначение |
|---------|-----------|
| `savePreset(config, name)` | Сохранить текущие `cloud`/`local`/`providerMode` как пресет и сделать его активным |
| `applyPreset(config, name)` | Применить пресет: скопировать снапшот в top-level поля и пометить активным |
| `deletePreset(config, name)` | Удалить пресет (сбрасывает `activePreset`, если удалён активный) |
| `listPresets(config)` | Список имён всех пресетов |

## Configuration

Config: `~/.fan/agent/extensions/fan-orchestrator/config.json` (рядом с модулем расширения).

`config.json` **исключён из пакета** — при первой загрузке конфигурации (`loadConfig()`) автоматически создаётся из `config.example.json` (merge с `DEFAULTS`). Альтернатива: `/orchestrator init` (интерактивный wizard) или `/orchestrator models` (только модельная часть).

**Без конфига** оркестратор неактивен (предупреждение при старте сессии).

```json
{
  "cloud": {
    "model": "",
    "models": {
      "explore": "",
      "plan": "",
      "implement": "",
      "verify": "",
      "bug-fix": "",
      "code-research": "",
      "tests-impl": "",
      "docs-impl": ""
    }
  },
  "local": {
    "model": "",
    "models": {
      "explore": "",
      "plan": "",
      "implement": "",
      "verify": "",
      "bug-fix": "",
      "code-research": "",
      "tests-impl": "",
      "docs-impl": ""
    }
  },
  "providerMode": "auto",
  "presets": {},
  "activePreset": null,
  "coordinatorDefault": true,
  "parallelWorkers": 3,
  "workerTimeout": 600,
  "stallTimeout": 600,
  "planTimeout": 600,
  "maxRetries": 2,
  "agentTimeouts": {
    "explore": 600,
    "plan": 600,
    "implement": 600,
    "verify": 600
  },
  "temperature": 0.1,
  "agentTemperature": {
    "explore": 0.3,
    "plan": 0.1,
    "implement": 0.1,
    "verify": 0.3,
    "bug-fix": 0.1,
    "code-research": 0.2,
    "tests-impl": 0.1,
    "docs-impl": 0.3
  },
  "dangerousCommands": [
    "rm -rf",
    "git push --force",
    "npm publish",
    "DROP TABLE",
    "TRUNCATE",
    "DELETE FROM",
    "mkfs",
    "shutdown"
  ]
}
```

### Параметры

| Параметр | Тип | Default | Описание |
|----------|-----|---------|----------|
| `providerMode` | `auto\|cloud\|local` | `cloud` | Режим выбора провайдера. `auto` = cloud с fallback на local |
| `coordinatorDefault` | `boolean` | `true` | Координатор активен при старте сессии |
| `parallelWorkers` | `number` | `3` | Максимум параллельных read-only воркеров |
| `workerTimeout` | `number` | `600` | Максимальное время воркера в секундах (резервный лимит) |
| `stallTimeout` | `number` | `600` | Таймер зависания (нет stdout → kill) |
| `planTimeout` | `number` | `600` | Таймаут `/plan` в секундах |
| `maxRetries` | `number` | `2` | Количество повторных попыток при ошибке воркера |
| `agentTimeouts` | `object` | `{explore, plan, implement, verify: 600}` | Перекрытие `stallTimeout` для конкретных агентов (в секундах) |
| `agentTemperature` | `object` | per-agent map | Температура по воркерам (0.0–1.0, значения клампятся; см. `DEFAULTS` в `config.js`) |
| `temperature` | `number` | `0.1` | Температура по умолчанию |
| `presets` | `object` | `{}` | Именованные снапшоты модельной конфигурации `{cloud, local, providerMode}` |
| `activePreset` | `string\|null` | `null` | Имя активного пресета |
| `dangerousCommands` | `string[]` | `[...]` | Паттерны команд, требующие блокировки |
| `cloud.model` | `string` | `""` | Модель по умолчанию для cloud (пустая = модель сессии) |
| `cloud.models` | `object` | `{}` | Per-agent модели для cloud (пустая = `cloud.model` → модель сессии) |
| `local.model` | `string` | `""` | Модель по умолчанию для local |
| `local.models` | `object` | `{}` | Per-agent модели для local |

### Цепочка разрешения модели

```
config.{provider}.models[agentName]
  → config.{provider}.model
    → модель текущей сессии
```

## Режим координатора

Переключается: `/orchestrator on/off` или `Alt+O`.

Когда активен, координатор делегирует всю работу воркерам вместо прямого использования инструментов. Промпт координатора динамически генерируется из реестра агентов (метод `buildCoordinatorPrompt()` из `agents.js`).

### Типичный рабочий процесс

1. Получить задачу → декомпозировать на подзадачи
2. Запустить explore/plan воркеры для исследования
3. Запустить implement/bug-fix воркер по спецификации
4. Запустить verify воркер для проверки результата
5. Итоговый отчёт: задачи, верификация, найденные проблемы

## Worker rendering

При работе воркер показывает:

- **Шапка**: иконка агента + тип + модель
- **Статусная строка**: `Thinking · 5 tools · 3 msgs · 02:35` (обновляется в реальном времени)
- **Список тулов**: последние вызванные инструменты с превью
- **Результат**: полный markdown-текст после завершения

## Система задач

- Задачи создаются автоматически для write-воркеров
- Доска задач отображается в виджете `📋 N/M tasks` (авто-скрытие при пустом списке)
- Любые переходы статусов разрешены (pending → completed, failed → in_progress и т.д.)
- Виджет обновляется на каждом `tool_result` для TaskCreate/TaskUpdate/TaskClear/cancel_task
- Свернуть/развернуть: `Alt+T`

## Security (v7.3+)

- **Interactive permission approval (v7.6.0)** — хук на `tool_call` для `bash`: при обнаружении опасной команды показывается UI prompt **Allow/Block**. `Allow` помечает input как `_fanDangerouslyApproved` (core bash tool пропускает проверку); `Block` или dismiss → команда блокируется. В headless-режиме (нет UI) опасные команды блокируются автоматически. Решения пишутся в audit log.
- **`FAN_DANGEROUSLY_SKIP_PERMISSIONS=true`** — env-переменная полностью обходит проверки в хуке. CLI-флаг **`--dangerously-skip-permissions`** (core, `packages/coding-agent`) выставляет эту переменную и прокидывает её в subprocess'ы воркеров.
- **Dangerous command detection** в core bash tool (`@seaagents/fan-coding-agent`, блокировка для **всех** FAN-процессов, а не только оркестратора):
  - heredoc: `<< EOF ... EOF`
  - pipes: `curl | sh`, `echo "rm" | bash`
  - interpreters: `node -e`, `python -c`, `perl -e`, `ruby -e`
  - subshell: `bash -lc`, `env sh -c`
  - fork-bomb: `:(){ :|:\& };:`
  - dd to disk devices
  - chmod/chown -R критических путей
- **Audit log** — JSONL в `~/.fan/agent/audit/orchestrator.log` (модуль `audit.js`)
- **Sanitize** — API keys/passwords/tokens не попадают в память
- **Изолированные воркеры** — `--no-extensions --no-skills --no-prompt-templates`
- **Init-wizard** — `/orchestrator init` позволяет редактировать список `dangerousCommands`

## Установка

```bash
fan store install fan-orchestrator
```

Затем настроить:

```bash
/orchestrator init
```

## Changelog (v5 → v7.10.0)

| Версия | Что нового |
|--------|-----------|
| **v7.10.0** | `/orchestrator models`: multi-provider списки моделей в Customize (все провайдеры, выбранный сверху); именованные пресеты модельных конфигураций с быстрым переключением (`presets`, `activePreset`); preset helpers в `config.js` (`savePreset`/`applyPreset`/`deletePreset`/`listPresets`); активный пресет в выводе `/orchestrator status` и `/orchestrator config`; авто-ресинхронизация активного пресета при правках. |
| **v7.9.0** | Provider-prefix model IDs (`provider/id`) — fix неоднозначного разрешения ID моделей между провайдерами. |
| **v7.8.0** | `/orchestrator models`: smart assignment (scoring-профили `WORKER_PROFILES`), brand filtering, pre-selected suggested model в Customize; блокировка параллельных write-воркеров; `config.json` исключён из пакета + авто-init из `config.example.json`; дефолты `stallTimeout`/`planTimeout` → 600. |
| **v7.7.x** | Qwen models support, clear OFF status display; Windows execPath quoting fix. |
| **v7.6.0** | Interactive permission approval (Allow/Block prompt), `--dangerously-skip-permissions` / `FAN_DANGEROUSLY_SKIP_PERMISSIONS`; broker-handler (EventBus `mcp:catalog`, `remote_tool_request`, per-worker profile filtering). |
| **v7.5.0** | Parallel read-only agents: `toWorkerType` использует флаг `agent.readOnly` вместо hardcoded whitelist. Все readOnly агенты получают независимые параллельные slot pools; write-агенты остаются эксклюзивными. |
| **v7.4.0** | **Pipeline Mode v3.1.0**: 3 working artifacts (`development-plan.md`, `development-log.md`, `phase-status.json`), `/pipeline` command (init/status/log/finish/cancel), auto-update hooks on TaskCreate/TaskUpdate, state recovery, conventional-commits policy (per-phase/per-function/manual). Новый модуль `pipeline-state.js` (класс PipelineState, 10 instance методов + static detectProjectSlug). |
| **v7.3.0** | Permission hardening: heredoc, pipes, interpreters, fork-bomb detection, audit log (`audit.js`), init-wizard с редактированием dangerous commands. Core bash tool блокирует опасные команды для ВСЕХ FAN-процессов. |
| **v7.2.0** | Improved slot pool, FIFO очередь |
| **v7.1.0** | TaskCreate/TaskUpdate/TaskClear/cancel_task, list_tasks, classify_task, assess_task, stop_worker |
| **v7.0.0** | 8 workers: добавлены bug-fix, code-research, tests-impl, docs-impl |
| **v5.x** | Initial multi-agent architecture: explore, plan, implement, verify |

## Author

FAN Team
