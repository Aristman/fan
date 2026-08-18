# Orchestrator Guide

Multi-agent task decomposition and coordination for FAN.

> Covers **fan-orchestrator v7.10.0** — `/orchestrator models` (smart model assignment, multi-provider lists), named model-config presets, interactive permission approval, parallel read-only slot pools, Pipeline Mode v3.1.0.

## Overview

The orchestrator is a FAN extension that turns a single LLM session into a team of specialized workers. Instead of one agent trying to explore, plan, implement, and verify all at once, the coordinator decomposes your request into tasks and delegates each to the right worker type.

**Why multi-agent?**

- **Focused context.** Each worker gets a fresh context window with only what it needs — no conversation bloat.
- **Parallelism.** Read-only workers (exploration, research, verification) run concurrently in their own slot pools while write workers execute changes one at a time.
- **Safety.** Read-only workers can't accidentally modify files. Dangerous commands trigger an interactive Allow/Block approval prompt.
- **Observability.** Tasks are tracked with statuses and dependencies so you always know what's happening.

At a high level: you describe what you want → the coordinator breaks it down → workers execute → results are verified → you get a summary.

## Installation

The orchestrator ships bundled with FAN and is auto-discovered by the extension loader. No manual installation is needed for standard FAN installations.

For manual installation or reinstallation:

```bash
# Install from FAN Store (if available)
fan store install fan-orchestrator

# Or copy the extension to the extensions directory
cp -r ~/.fan/packages/fan-orchestrator ~/.fan/agent/extensions/
```

To disable the orchestrator, remove or rename its folder in `~/.fan/agent/extensions/`.

> **Architecture note:** The orchestrator is a standalone extension — it is NOT hardcoded into the `@seaagents/fan-coding-agent` core. It's loaded at runtime through FAN's extension system.

### Configuration file

The config lives at `~/.fan/agent/extensions/fan-orchestrator/config.json` (next to the extension module). `config.json` is **excluded from the package** — on first load it is automatically created from the bundled `config.example.json` (merged with built-in defaults). If no config exists, a warning is shown at session start: run `/orchestrator init` (interactive wizard) or `/orchestrator models` (model settings only) to configure.

## Coordinator Mode

Coordinator mode changes the LLM's role from "doer" to "manager." When active, the agent does **not** use code tools directly — it only delegates via `delegate_task` and tracks progress with `TaskCreate`/`TaskUpdate`.

### Enabling Coordinator Mode

- **Alt+O** — Toggle coordinator mode on/off in the TUI.
- **`/orchestrator on`** — Enable via slash command.
- **`/orchestrator off`** — Disable via slash command.

By default the coordinator is **active at session start** (`coordinatorDefault: true` in config).

### What Changes

| Aspect | Normal Mode | Coordinator Mode |
|--------|------------|-----------------|
| Agent role | Direct executor | Delegation manager |
| Tool usage | Agent reads/writes/runs | Agent only calls `delegate_task`, `TaskCreate`, etc. |
| Task tracking | None | Automatic task creation and status updates |
| Verification | Manual | Automatic verify worker after implementation |

### The Coordinator's Role

The coordinator receives your request and:

1. Decomposes it into sub-tasks with `TaskCreate`.
2. Spawns explore workers to understand the codebase.
3. Synthesizes findings into an implementation spec.
4. Delegates implementation to an implement worker.
5. Runs a verify worker to check the result.
6. Reports back with a summary.

**Workers are sandboxed** — they cannot see the main conversation. All context must be included in the delegation prompt.

## Worker Types

| Type | Tools | Access | Use For |
|------|-------|--------|---------|
| **explore** | read, bash, grep, find, ls | Read-only | Fast codebase exploration, file search, structure mapping |
| **plan** | read, bash, grep, find, ls | Read-only | Deep architectural analysis, implementation planning |
| **implement** | read, write, edit, bash, grep, find, ls | Full | Making code changes, running tests, building |
| **verify** | read, bash, grep, find, ls | Read-only | Build checks, test runs, lint, adversarial code review |
| **bug-fix** | read, write, edit, bash, grep, find, ls | Full | Targeted bug fixes with minimal changes |
| **code-research** | read, bash, grep, find, ls | Read-only | Deep code analysis, dependency tracing, pattern mining |
| **tests-impl** | read, write, edit, bash, grep, find, ls | Full | Writing unit/integration tests for existing code |
| **docs-impl** | read, write, edit, bash, grep, find, ls | Full | Writing and updating documentation |

Read-only vs. write access is derived from each agent's `readOnly` flag (set from its declared tools), not from a hardcoded list — custom agents with read-only tools automatically get read-only treatment.

### Concurrency Rules (Slot Pools)

- **Read-only workers** (explore, plan, verify, code-research, and any custom agent with `readOnly: true`): each agent type gets its **own parallel slot pool**, up to `parallelWorkers` concurrently (default: 3).
- **Write workers** (implement, bug-fix, tests-impl, docs-impl): **exclusive write slot** — parallel write workers are blocked until the slot is free.
- Workers queue automatically (FIFO) when a pool is full.

## Orchestrator Tools

The orchestrator provides 9 tools for the coordinator (registered in `orchestrator-tools.js`):

| Tool | Description |
|------|-------------|
| `delegate_task` | Spawn worker(s): single (`agent` + `task`), parallel (`tasks` array), or chain (sequential steps with `{previous}` placeholder) |
| `TaskCreate` | Create a tracked task with subject, description, and optional `blocks[]` dependencies |
| `TaskUpdate` | Update task status (`pending` → `in_progress` → `completed`/`failed`) |
| `TaskClear` | Clear completed/failed tasks from the board |
| `list_tasks` | List tasks with an optional status filter |
| `cancel_task` | Cancel a running or pending task by ID |
| `classify_task` | Classify a description to suggest the best agent type |
| `assess_task` | Multi-level task complexity assessment (L1/L2/L3) |
| `stop_worker` | Stop a running worker by ID |

### Worker Isolation

Workers run as separate `fan --mode rpc` processes communicating via JSONL-over-stdio (Pi-style protocol: `prompt`, `get_state`, `get_last_assistant_text`, with a single `stallTimer` reset on any stdout). They are spawned with `--no-extensions --no-skills --no-prompt-templates` and cannot see:

- The main conversation history
- Other workers' outputs (unless passed via the task description or `{previous}` in chains)
- The coordinator's reasoning

This means **worker prompts must be self-contained.** Include file paths, line numbers, exact change descriptions, and any relevant code snippets.

### MCP Tool Broker

When the fan-mcp extension is active, workers can use remote MCP tools through the broker (`broker-handler.js`): it subscribes to the EventBus channel `mcp:catalog`, answers `remote_tool_request` messages from workers, and applies **per-worker profile filtering** (`all` for write workers, `read-only` — only tools with `annotations.readOnly: true` — for read-only workers).

## Slash Commands

### Orchestrator Control

| Command | Description |
|---------|-------------|
| `/orchestrator on` | Enable coordinator mode |
| `/orchestrator off` | Disable coordinator mode (agent returns to direct execution) |
| `/orchestrator status` | Show provider, active preset, workers, tasks, agents overview |
| `/orchestrator config` | Show current configuration (including active preset) |
| `/orchestrator init` | Interactive configuration wizard (incl. dangerous-command list) |
| `/orchestrator models` | Interactive model assignment wizard + named presets (see below) |
| `/orchestrator mode <auto\|cloud\|local>` | Switch provider mode |
| `/orchestrator retry` | Retry the last failed task |
| `/orchestrator stop` | Stop all active workers |

### Planning & Task Board

| Command | Description |
|---------|-------------|
| `/plan <task>` | Planning workflow with Approve/Revise/Reject review (docs in Russian) |
| `/tasks [status]` | Task board (optional status filter) |
| `/agents [scope]` | List available agents (`project`, `user`, or both) |
| `/delegate <agent> <task>` | Quick single worker dispatch |

### Pipeline Mode

| Command | Description |
|---------|-------------|
| `/pipeline init [name]` | Initialize pipeline: create 3 working artifacts |
| `/pipeline status` | Show pipeline progress (widget, 10s) |
| `/pipeline log [N]` | Show last N log entries (default 10) |
| `/pipeline finish` | Mark complete + Keep/Delete artifacts |
| `/pipeline cancel` | Deactivate in-memory, artifacts preserved |

**Shortcuts:** `Alt+O` (toggle coordinator), `Alt+T` (toggle task widget)

## Model Assignment & Presets

### `/orchestrator models`

Interactive wizard for assigning models to workers (requires UI; in headless mode edit `config.json` manually). Flow:

1. **Preset menu** (shown first if any presets exist) — Edit current config / Switch active preset / Save current config as preset / Delete preset.
2. **Provider mode** — choose which mode to configure: `☁️ cloud`, `🏠 local`, or `⚙️ auto` (both).
3. **Provider for suggestions** — pick the provider used for smart suggestions; the session's active provider is auto-detected and marked `⭐ active`. Models are filtered by brand (`BRAND_KEYWORDS`: e.g. provider `qwen` → only Qwen-branded models; aggregators like openrouter/ollama and local providers are unfiltered).
4. **Smart assignment** — scoring profiles (`WORKER_PROFILES`) weight reasoning / context / cost / maxTokens per worker: heavy workers (implement, plan, bug-fix) get flagship reasoning models, light workers (verify, docs-impl) get cheap/fast ones. Assignment runs in priority order (`ASSIGNMENT_ORDER`), and models already assigned to another worker are heavily penalized for diversity.
5. **Accept / Customize / Reset** — accept the suggested assignment, change individual workers, or clear all overrides (fall back to the session model).

In the **Customize** step each picker lists models from **all providers**: the suggested model is pinned first (pre-selected), then the chosen provider's (brand-filtered) models, then all other providers alphabetically with a `· provider` suffix in the label.

Selected models are stored in **`provider/id` format**, which removes ambiguity when the same model ID exists under multiple providers (both `id` and `provider/id` formats are read back correctly).

### Named Presets

A preset is a named snapshot of the model-related config: `{cloud, local, providerMode}`.

- Stored in `config.json` as `presets` (`Record<name, {cloud, local, providerMode}>`) plus `activePreset` (name of the active preset, or `null`).
- The preset menu appears at the start of `/orchestrator models` (when presets exist): **Edit** / **Switch** (active marked `✔`) / **Save-as** / **Delete** (with confirmation).
- When changes are saved (Accept/Customize/Reset), the **active preset auto-resyncs** — its snapshot is updated together with the config.
- If no presets exist yet, you're offered to create the first one after saving.
- The active preset is displayed in `/orchestrator status` (`⭐ Active preset: ...`) and `/orchestrator config` (`⭐ Preset: name (N saved)`).
- Reserved names (`__proto__`, `constructor`, `prototype`) are rejected; invalid presets are pruned when the config is loaded.

Preset helpers are exported from `config.js`: `savePreset(config, name)`, `applyPreset(config, name)`, `deletePreset(config, name)`, `listPresets(config)`.

### Model Resolution Chain

```
config.{provider}.models[agentName]
  → config.{provider}.model
    → current session model
```

## Pipeline Mode (v3.1.0)

Pipeline Mode — это режим оркестратора для **многофазных работ по большой спеке** (например, реализация 16-фазного проекта из SPEC.md). Координатор создаёт 3 рабочих артефакта на диске и автоматически поддерживает их актуальность на каждом `TaskCreate`/`TaskUpdate`.

### Когда использовать

| ✅ Подходит | ❌ Не подходит |
|-------------|--------------|
| Реализация большой спеки (≥5 фаз) | Правка одного файла |
| Миграция (Rust port, framework swap) | Bug-fix одной строки |
| Сложная фича с roadmap из 10+ функций | Разовое делегирование |
| Когда нужны осмысленные коммиты по фазам | Когда коммиты не нужны |
| Когда работа может прерываться (state recovery) | Одноразовая быстрая задача |

### Артефакты

| Файл | Создаётся | Обновляется | Назначение |
|------|-----------|-------------|------------|
| `docs/development-plan.md` | `/pipeline init` | Один раз | Roadmap: фазы, фичи, критерии приёмки, риски, commit policy |
| `docs/development-log.md` | `/pipeline init` | Каждый TaskUpdate | Append-only журнал: что сделано / тесты / commit / следующий шаг |
| `.fan/tracking/phase-status.json` | `/pipeline init` | Каждый TaskUpdate | JSON state machine для автообновления и восстановления |

### Команда /pipeline

```bash
/pipeline init [feature-name]
  # Создаёт 3 артефакта. Интерактивно спрашивает:
  # - Feature name
  # - Commit strategy: per-phase | per-function | manual
  # - Phases (multi-line: phase N: name + goal + features + criteria)
  # - Slug (auto-detected из package.json/Cargo.toml)

/pipeline status
  # Показывает widget (10 сек) с прогрессом: P/C фазы, текущая фаза, последние записи

/pipeline log [N]
  # Показывает последние N записей из development-log.md (default 10)

/pipeline finish
  # Помечает pipeline как завершённый. Спрашивает: удалить артефакты или оставить?

/pipeline cancel
  # Деактивирует pipeline в памяти. Артефакты остаются на диске для истории.
```

### Commit Policy

После `/pipeline init` выбирается стратегия коммитов:

| Стратегия | Когда делаем commit | Conventional Commit Format |
|-----------|--------------------|-----------------------------|
| `per-phase` | Когда TaskUpdate → completed **последней задачи в фазе** | `feat(phase-N): <name> complete` |
| `per-function` | Когда TaskUpdate → completed | `feat(phase-N/F-X.Y): <summary>` |
| `manual` | Никогда автоматически | (вы сами коммитите) |

**Формат commit message:**
```
feat(phase-3): Session Management complete

- fan-rust-session crate: JSONL persistence + compaction
- 47 unit tests passed
- E2E: scripts/e2e/phase-3.sh → PASS
```

После commit — `pipeline.recordPhaseChange({ phaseId, status: 'COMPLETED', commitSha: '<sha>' })` сохранит SHA в `phase-status.json`.

### Авто-обновление артефактов

Когда pipeline активен, **каждый** `TaskCreate` и `TaskUpdate` автоматически (без явного вызова) обновляет:

- `.fan/tracking/phase-status.json` — добавляется/обновляется запись `data.tasks[taskId]` со статусом, описанием, временем
- `docs/development-log.md` — append записи `### <ISO date> — [Phase N] — <action>` с деталями

Хук реализован в `fan.on("tool_result", ...)` (в `orchestrator-extension.js`) и не требует явного вызова от координатора.

**Восстановление phaseId:** координатор должен называть задачи так, чтобы можно было извлечь фазу (функция `inferPhaseId(subject)`):
- ✅ `"F-3.1 [session]: fan-rust-session crate"` → инферится `phaseId = 3`
- ✅ `"[Phase 3] Create session crate"` → инферится `phaseId = 3`
- ❌ `"Create session crate"` → невозможно, phaseId = 0 (fallback)

### State Recovery

Если сессия оборвалась — при следующем `session_start` оркестратор:
1. Читает `.fan/tracking/phase-status.json`
2. Если валиден → восстанавливает pipeline в памяти
3. Логирует: `Restored pipeline: <featureName> (<slug>), <N> phases, <M> completed`
4. Координатор продолжает с текущей фазы (видимой из `currentPhase` в JSON)

### Полный пример: реализация SPEC

```bash
# День 1
fan
> Реализуй полностью docs/specs/fan-rust/SPEC-v2.md
> (координатор думает, создаёт TaskCreate на каждую из 16 фаз, блокирует зависимостями)
> Затем: /pipeline init  ← вводит команду
> Slug: fan-rust-port
> Strategy: per-phase
> Phases: (вставляет multi-line текст с 16 фазами)
> ✅ Pipeline initialized: docs/development-plan.md, docs/development-log.md, .fan/tracking/phase-status.json

# Оркестратор начинает Phase 0:
> delegate_task(agent="implement", task="Phase 0: cargo workspace + 16 stub crates")
> delegate_task(agent="verify", task="Phase 0 verification")
> (verify PASS)
> bash: git add crates/ Cargo.toml rust-toolchain.toml ...
> bash: git commit -m "feat(phase-0): Foundation complete"
> TaskUpdate(taskId, completed)
> (хук автоматически: append в development-log.md + обновление JSON + commitSha в JSON)

# День 1 обрыв: phase 1 не закончен

# День 2
fan
> [FAN Pipeline] Restored pipeline: fan-rust port (fan-rust-port), 16 phases, 1 complete
> (координатор продолжает с phase 1)
> /pipeline status  ← увидеть прогресс
> 1/16 complete, currentPhase: 1
```

### Связь с feature-pipeline skill v3.1.0

Skill `feature-pipeline` v3.1.0 использует тот же pipeline mode:
- `/skill:feature-pipeline` эквивалентно "Use Pipeline Mode по roadmap.md"
- Skill автоматически делает `/pipeline init` если обнаружен FAN Orchestrator
- Рабочие артефакты те же: plan.md, log.md, phase-status.json
- После каждой фазы/функции skill требует commit через commit policy

### Конфигурация

У Pipeline Mode нет отдельной секции в `config.json` — стратегия коммитов и фазы задаются интерактивно при `/pipeline init` и хранятся в `.fan/tracking/phase-status.json`.

### Решение проблем

| Проблема | Решение |
|----------|---------|
| Pipeline не восстанавливается после restart | Проверь что `.fan/tracking/phase-status.json` существует и валидный JSON |
| Артефакты не обновляются | Проверь что `pipelineState` активен (`/pipeline status` покажет ERROR если нет) |
| Коммиты не делаются | Проверь commitStrategy (не `manual`) и что git в PATH |
| Конфликт при повторном init | Существующие артефакты сохраняются (`onConflict='append'` default) — pipeline работает с ними |
| phaseId не инферится | Используй паттерн `F-N.M [...]` или `[Phase N]` в subject TaskCreate |

## Task Management

Tasks are the coordinator's way of tracking progress. They're created with `TaskCreate`, updated with `TaskUpdate`, cleared with `TaskClear`, cancelled with `cancel_task`, and viewed with `list_tasks` or the `/tasks` command.

### Task Lifecycle

```
pending → in_progress → completed
                     → failed
                     → blocked → in_progress
                              → failed
```

Status transitions are not strictly enforced — the coordinator can move tasks between any statuses (e.g. `failed` → `pending` for a retry).

### Task Fields

| Field | Description |
|-------|-------------|
| `id` | Auto-generated UUID |
| `subject` | Short task title |
| `description` | Detailed description |
| `status` | pending, in_progress, completed, blocked, failed |
| `owner` | Worker ID or agent name responsible |
| `blocks` | List of task IDs that this task depends on |

### Dependencies

Use the `blocks[]` field to create ordering. A task with `blocks: ["task-1", "task-2"]` will wait until both tasks complete before starting.

### Task Widget (Alt+T)

A collapsible checklist displayed above the editor in the TUI.

- **Alt+T** — Toggle the task widget visibility.
- Status icons: ☐ pending, ◐ in_progress, ☑ completed, ⛔ blocked, ✗ failed.
- Refreshes on every `tool_result` for `TaskCreate`/`TaskUpdate`/`TaskClear`/`cancel_task`.
- Auto-hides when no active tasks remain.

## Workflows

### Plan Workflow

Best for: understanding what needs to be done before writing code.

```
User: /plan Refactor the database layer to use connection pooling
```

Execution:

1. A **plan** worker investigates the codebase and produces a structured implementation plan (documentation in Russian; file names and technical terms in English).
2. The plan is shown for review: **✅ Approve** / **✏️ Revise** (with feedback, re-runs the plan worker) / **❌ Reject**.
3. On approval, coordinator mode is enabled and the plan is handed to the coordinator for step-by-step implementation via `TaskCreate` + `delegate_task`.
4. Timeout: `planTimeout` seconds (default 600); ESC aborts.

Triggered by: `/plan <task>`

### Implementation Workflow

Best for: making code changes with verification.

```
User: [with coordinator mode on] Add rate limiting to the API gateway
```

Execution:

1. Coordinator decomposes into sub-tasks.
2. **Explore** worker investigates the codebase.
3. Coordinator synthesizes findings into a spec.
4. **Implement** worker makes the changes.
5. **Verify** worker checks build, tests, and code quality.
6. If verification fails, implement retries (up to 3 attempts per task).
7. Coordinator reports results.

Triggered by: describe the task with coordinator mode active (Alt+O).

### Verify Workflow

Best for: checking existing changes without modification.

```
User: [with coordinator mode on] Run the full test suite and check for regressions
```

Execution:

1. Coordinator delegates to a **verify** worker.
2. Verify worker runs tests, linters, and reviews code.
3. Reports `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.

## Configuration

Configuration lives in `~/.fan/agent/extensions/fan-orchestrator/config.json`. It is auto-created from `config.example.json` on first load (merged with defaults), or via `/orchestrator init`. All timeouts are in **seconds**.

```json
{
    "cloud": {
        "model": "",
        "models": {
            "explore": "", "plan": "", "implement": "", "verify": "",
            "bug-fix": "", "code-research": "", "tests-impl": "", "docs-impl": ""
        }
    },
    "local": {
        "model": "",
        "models": {
            "explore": "", "plan": "", "implement": "", "verify": "",
            "bug-fix": "", "code-research": "", "tests-impl": "", "docs-impl": ""
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
        "rm -rf", "git push --force", "npm publish",
        "DROP TABLE", "TRUNCATE", "DELETE FROM",
        "mkfs", "shutdown"
    ]
}
```

### Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `providerMode` | `"cloud"` (example: `"auto"`) | `auto`, `cloud`, or `local` — which model config to use; `auto` = cloud with fallback to local |
| `presets` | `{}` | Named snapshots of model config `{cloud, local, providerMode}` |
| `activePreset` | `null` | Name of the active preset |
| `coordinatorDefault` | `true` | Coordinator mode active at session start |
| `parallelWorkers` | `3` | Max concurrent read-only workers per slot pool |
| `workerTimeout` | `600` (s) | Max worker runtime in seconds (backstop limit) |
| `stallTimeout` | `600` (s) | Stall timer — no stdout → kill |
| `planTimeout` | `600` (s) | Timeout for the `/plan` workflow |
| `maxRetries` | `2` | Retry count on worker failure |
| `agentTimeouts.<type>` | `600` (s) | Per-agent-type stall timeout override |
| `temperature` | `0.1` | Default worker temperature |
| `agentTemperature.<type>` | per-agent map | Per-agent temperature (0.0–1.0, clamped) |
| `cloud.model` / `local.model` | `""` | Default model per provider (empty = session model) |
| `cloud.models` / `local.models` | `{}` | Per-agent model overrides (empty = provider default → session model) |
| `dangerousCommands` | `[...]` | Command patterns that trigger the approval prompt |

Legacy keys are migrated automatically on load (`cloud.defaultModel` → `cloud.model`, `cloud.defaultProvider` → `cloud.provider`, `stallTimeout` → `workerTimeout` when `workerTimeout` is absent).

## Permissions

### Tool Access by Worker Type

Workers are restricted by their declared tools, enforced at spawn time:

- **Read-only workers** (explore, plan, verify, code-research): `read`, `bash`, `grep`, `find`, `ls` — no write/edit.
- **Write workers** (implement, bug-fix, tests-impl, docs-impl): full access (all tools).

### Interactive Permission Approval

When a dangerous command is detected in any `bash` tool call (coordinator or worker), the orchestrator's `tool_call` hook shows an **Allow/Block** prompt:

- **Allow** — the input is marked `_fanDangerouslyApproved` and the core bash tool skips its security check.
- **Block** (or dismissing the prompt) — the command is blocked.
- **Headless mode** (no UI) — dangerous commands are blocked automatically.

All decisions are written to the audit log (JSONL at `~/.fan/agent/audit/orchestrator.log`).

**Bypass switch:** setting `FAN_DANGEROUSLY_SKIP_PERMISSIONS=true` disables all checks in the hook. The core CLI flag `--dangerously-skip-permissions` sets this variable and propagates it to worker subprocesses. Use only in trusted environments.

The core bash tool in `@seaagents/fan-coding-agent` also blocks dangerous patterns for **all** FAN processes (not just the orchestrator): heredocs, pipes into shells (`curl | sh`), interpreter one-liners (`node -e`, `python -c`), subshells, fork-bombs, `dd` to disk devices, and recursive chmod/chown of critical paths.

### Dangerous Commands

The following patterns (configurable via `dangerousCommands`, editable in `/orchestrator init`) trigger the approval flow:

| Category | Patterns |
|----------|----------|
| Recursive delete | `rm -rf`, `rm -fr`, any `rm` with `-r` and `-f` flags |
| Force push | `git push --force`, `git push -f` |
| Package publish | `npm publish`, `yarn publish`, `pnpm publish` |
| SQL destruction | `DROP TABLE`, `TRUNCATE`, `DELETE FROM` |
| Disk operations | `mkfs`, `fdisk`, `format` |
| System power | `shutdown`, `reboot`, `halt`, `poweroff` |
| Root permissions | `chmod -R /`, `chown -R /` |
| Find + delete | `find ... -delete` |

## Best Practices

### 1. One Write Worker at a Time

The orchestrator enforces this (exclusive write slot shared by implement, bug-fix, tests-impl, docs-impl), but it's good to plan for it. Structure your task decomposition so implementation steps are sequential, while exploration and verification can be parallel.

### 2. Parallel Read-Only Workers

Don't wait for one explore worker to finish before starting another. Read-only workers run in parallel slot pools, so if you need to investigate three independent subsystems, spawn three explore workers at once via `delegate_task` with a `tasks` array:

```
delegate_task(tasks=[
  {agent: "explore", task: "Investigate the API gateway auth middleware"},
  {agent: "explore", task: "Investigate the WebSocket handler"},
  {agent: "explore", task: "Investigate the database schema"}
])
```

### 3. Max 3 Implementation Attempts

If a verify worker fails, the coordinator will retry implementation with fix instructions. After 3 failed attempts, it reports to you with details. Don't override this limit — if something fails 3 times, it likely needs human judgment.

### 4. Self-Contained Worker Prompts

Workers can't see the conversation. When delegating, include:

- **File paths** — exact paths, not "that file we discussed"
- **Line numbers** — specific ranges for targeted changes
- **Code snippets** — relevant types, interfaces, or function signatures
- **Acceptance criteria** — what "done" looks like

### 5. Use `/plan` Before Complex Tasks

For anything involving multiple files or architectural changes, run `/plan` first. The plan-worker workflow with Approve/Revise/Reject gives you a structured plan to review before any code is touched.

### 6. Use Dependencies for Ordering

When creating tasks, use `blocks[]` to express ordering:

```
Task 1: "Create database migration" (no dependencies)
Task 2: "Update API endpoints" (blocks: [task-1-id])
Task 3: "Write integration tests" (blocks: [task-2-id])
```

Blocked tasks automatically wait for their dependencies to complete.

### 7. Always Verify After Implement

The coordinator does this automatically. Look for `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL` in the verify worker output.

---

## Режимы сессии миссии (session_mode)

> Добавлено в fan-mission 0.10.0 (ralph-loop). Дизайн: `docs/research/ralph-loop-mission-mode.md`.

### Проблема

Каждая итерация миссии посылается как `followUp` в одну и ту же `AgentSession`. `agent-loop` пересобирает `currentContext.messages = [...context.messages, ...prompts]` — каждая итерация несёт полную историю в LLM API. Инцидент: 334k токенов на 5-ю итерацию при лимите 700k. Auto-compaction суммаризирует, но не обнуляет и срабатывает только post-hoc.

### Решение: fresh session per iteration

Каждая итерация выполняется в **новой** сессии агента. Состояние миссии — полностью в файлах (MISSION/ROADMAP/STATE/BACKLOG/RECURRING/DECISIONS.md + `.mission-loop.json` + git). Контекст диалога между итерациями не переиспользуется.

### Два режима

| Режим | Описание | Когда использовать |
|-------|----------|--------------------|
| **fresh** | Каждая итерация = новая сессия. Токены ≈ const (5-7k вход + tool-выводы этой итерации). Чат очищается между итерациями. | Длинные миссии (5+ итераций), предсказуемая стоимость, tool-heavy задачи |
| **persistent** | Все итерации в одной сессии (как ≤ 0.9.0). Токены растут линейно до compaction. | Короткие миссии (2-3 итерации), когда контекст диалога важен |

### Стоимость

| | persistent | fresh |
|---|---|---|
| Итерация N, вход | base + Σ транскриптов 1..N−1 (линейный рост) | ≈ const: system + промпт ≤20KB (~5-7k tok) + tool-выводы только этой итерации |
| Предсказуемость | нет (до compaction-threshold) | да |
| Overhead | — | холодное чтение рабочих файлов (~2-10k tok/итерацию) |
| Точка безубыточности | — | fresh дешевле уже с N≈2-3 для типичных tool-heavy итераций |

### Как задать режим

Режим задаётся в frontmatter MISSION.md:

```yaml
# MISSION.md
session_mode: fresh        # fresh | persistent
```

- **При init:** шаблоны `default` и `refactor` уже содержат `session_mode: fresh` — новые миссии создаются в fresh-режиме автоматически.
- **Ручная правка:** до старта миссии отредактировать MISSION.md и добавить/изменить `session_mode`. После старта — не менять (режим фиксируется при первом тике).
- **Отсутствие поля** = `persistent` (обратная совместимость, 0.10.0 не ломает запущенные миссии).

### Что видит оператор

- **Чат очищается** между итерациями — это нормально, вся история в файлах миссии и git.
- **История сессий сохраняется:** каждая итерация = новая сессия с именем `mission/<slug>/iter-N` (через `fan.setSessionName`).
- **`/resume`** показывает дерево итерационных сессий (через `parentSession`).
- **Виджет F9** продолжает работать — пересоздаётся фабрикой на каждую сессию.
- **Токены итерации не растут линейно** — вход каждой итерации ≈ const.

### Ротация сессий

Ротация происходит **на границе тика**, после полного персистирования состояния:

1. `tick()` в сессии S_N — шаги 1-7, `writeLoopStateSync(lastStep=7)`
2. Если fresh && isSuccess && осталась работа → `resumeAfterRotation = true`
3. `deps.sessionRotator.rotate()` — ПОСЛЕ tick (lock освобождён)
4. `rotatingGuard = true` → `fan.newSession({parentSession})` → новая сессия S_{N+1}
5. `session_start` в S_{N+1} → attach → `resumeAfterRotation` → `setTimeout(tick, 0)`

### Graceful degradation

- **Rotator недоступен** (нет `sessionRotator` в deps) → warn, режим persistent на этот тик.
- **`session_before_switch` отменяет ротацию** → `{cancelled: true}` → warn + persistent-fallback.
- **SIGKILL mid-iteration** → recovery продолжает миссию (P0-1 recovery без изменений).
- **SIGKILL между ротацией и автопродолжением** → `resumeAfterRotation` на диске, `session_start(reason "startup")` подхватывает.

### Tradeoffs

| Риск | Митигейшн |
|------|------------|
| Потеря устного контекста → повтор ошибок | Guidance «записывай в STATE.md»; STATE/BACKLOG/git — единственный канал памяти |
| `abort()` при `session_shutdown` убивает миссию | `rotatingGuard` — лёгкая очистка без detach/abort |
| Засорение списка сессий | `parentSession` + `setSessionName`; v1.1 — prune по возрасту/количеству |
| DECIDE/steer mid-flight | Оба file-based — переживают ротацию без изменений |
