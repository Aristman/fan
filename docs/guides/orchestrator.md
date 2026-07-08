# Orchestrator Guide

Multi-agent task decomposition and coordination for FAN.

## Overview

The orchestrator is a FAN extension that turns a single LLM session into a team of specialized workers. Instead of one agent trying to explore, plan, implement, and verify all at once, the coordinator decomposes your request into tasks and delegates each to the right worker type.

**Why multi-agent?**

- **Focused context.** Each worker gets a fresh context window with only what it needs — no conversation bloat.
- **Parallelism.** Exploration and verification can run simultaneously while an implement worker handles changes.
- **Safety.** Read-only workers can't accidentally modify files. Dangerous commands require explicit approval.
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

## Coordinator Mode

Coordinator mode changes the LLM's role from "doer" to "manager." When active, the agent does **not** use code tools directly — it only delegates via `Agent` and tracks progress with `TaskCreate`/`TaskUpdate`.

### Enabling Coordinator Mode

- **Alt+O** — Toggle coordinator mode on/off in the TUI.
- **`/orchestrator on`** — Enable via slash command.
- **`/orchestrator off`** — Disable via slash command.

### What Changes

| Aspect | Normal Mode | Coordinator Mode |
|--------|------------|-----------------|
| Agent role | Direct executor | Delegation manager |
| Tool usage | Agent reads/writes/runs | Agent only calls `Agent`, `TaskCreate`, etc. |
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
| **explore** | read, grep, find, ls, bash | Read-only | Fast codebase exploration, file search, structure mapping |
| **plan** | read, grep, find, ls | Read-only | Deep architectural analysis, implementation planning |
| **implement** | read, write, edit, bash, grep, find, ls | Full | Making code changes, running tests, building |
| **verify** | read, grep, find, ls, bash | Read-only | Build checks, test runs, lint, adversarial code review |
| **bug-fix** | read, write, edit, bash, grep, find, ls | Full | Targeted bug fixes with minimal changes |
| **code-research** | read, grep, find, ls, bash | Read-only | Deep code analysis, dependency tracing, pattern mining |
| **tests-impl** | read, write, edit, bash, grep, find, ls | Full | Writing unit/integration tests for existing code |
| **docs-impl** | read, write, edit, bash, grep, find, ls | Full | Writing and updating documentation |

### Concurrency Rules

- **Implement workers:** maximum 1 at a time (exclusive write slot).
- **Explore/plan/verify workers:** up to `parallelWorkers` concurrently (default: 3).
- Workers queue automatically when the pool is full.

## Orchestrator Tools

The orchestrator provides 6 tools for the coordinator:

### `Agent`

Spawns a worker to execute a task. Called by the coordinator to delegate work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentType` | string | Yes | One of: `explore`, `plan`, `implement`, `verify`, `bug-fix`, `code-research`, `tests-impl`, `docs-impl` |
| `task` | string | Yes | Self-contained task description with all context |
| `context` | string | No | Additional context (e.g., explore output, plan text) |

### `SendMessage`

Sends a message from the coordinator to a running worker (interactive follow-up).

### `StopAgent`

Stops a running worker by agent ID.

### `TaskCreate`

Creates a new task with subject, description, and optional dependencies.

### `TaskUpdate`

Updates task status, owner, or other fields.

### `TaskList`

Lists tasks with optional status filter.

### Worker Isolation

Workers run as separate `fan --mode rpc` processes communicating via JSON-over-stdio. They cannot see:

- The main conversation history
- Other workers' outputs (unless passed via `context`)
- The coordinator's reasoning

This means **worker prompts must be self-contained.** Include file paths, line numbers, exact change descriptions, and any relevant code snippets.

## Slash Commands

### `/orchestrator [on|off|stop|config|status]`

Master control for the orchestrator.

- `/orchestrator on` — Enable coordinator mode.
- `/orchestrator off` — Disable coordinator mode (agent returns to direct execution).
- `/orchestrator stop` — Cancel all running workers.
- `/orchestrator config` — Show current configuration.
- `/orchestrator status` — Show workers and tasks overview.

### `/plan [task description]`

Strategic planning workflow. Runs explore → plan and presents the plan to you before any implementation.

```
/plan Add pagination to the sessions API endpoint
```

This spawns an explore worker to gather context, then a plan worker to produce a structured implementation plan. You review the plan before deciding whether to proceed.

### `TaskList`

Use the `TaskList` tool to view tracked tasks. Optionally filter by status.

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

Хук реализован в `fan.on("tool_result", ...)` и не требует явного вызова от координатора.

**Восстановление phaseId:** координатор должен называть задачи так, чтобы можно было извлечь фазу:
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

В `packages/orchestrator/src/config.json`:
```json
{
  "pipeline": {
    "autoSuggest": true,
    "defaultStrategy": "per-phase",
    "suggestThreshold": 8
  }
}
```

Default values: `autoSuggest=true`, `defaultStrategy="per-phase"`, `suggestThreshold=8`.

### Решение проблем

| Проблема | Решение |
|----------|---------|
| Pipeline не восстанавливается после restart | Проверь что `.fan/tracking/phase-status.json` существует и валидный JSON |
| Артефакты не обновляются | Проверь что `pipelineState` активен (`/pipeline status` покажет ERROR если нет) |
| Коммиты не делаются | Проверь commitStrategy (не `manual`) и что git в PATH |
| Конфликт при повторном init | Существующие артефакты сохраняются (`onConflict='append'` default) — pipeline работает с ними |
| phaseId не инферится | Используй паттерн `F-N.M [...]` или `[Phase N]` в subject TaskCreate |

## Task Management

Tasks are the coordinator's way of tracking progress. They're created with `TaskCreate`, updated with `TaskUpdate`, and viewed with `TaskList`.

### Task Lifecycle

```
pending → in_progress → completed
                     → failed
                     → blocked → in_progress
                              → failed
```

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
- Auto-hides when no active tasks remain.

## Workflows

### Plan Workflow

Best for: understanding what needs to be done before writing code.

```
User: /plan Refactor the database layer to use connection pooling
```

Execution:

1. **Explore** worker gathers context (current DB code, connection patterns, imports).
2. **Plan** worker produces a structured implementation plan.
3. Plan is presented to the user for review.
4. No code changes are made.

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
6. If verification fails, implement retries (up to 3 attempts).
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

Configuration lives in `packages/orchestrator/src/config.json`.

```json
{
    "cloud": { "model": "zai/glm-4.5-air" },
    "local": { "model": "ollama/qwen3:32b" },
    "providerMode": "cloud",
    "parallelWorkers": 3,
    "workerTimeout": 300000,
    "stallTimeout": 60000,
    "maxRetries": 2,
    "planTimeout": 300000,
    "agentTimeouts": {
        "explore": 120000,
        "plan": 180000,
        "implement": 300000,
        "verify": 180000,
        "bug-fix": 300000,
        "code-research": 180000,
        "tests-impl": 300000,
        "docs-impl": 240000
    },
    "agentModels": {
        "explore": { "provider": "local", "model": "ollama/qwen3:32b" },
        "verify": { "provider": "cloud", "model": "zai/glm-4.5-air" }
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
| `providerMode` | `"cloud"` | `cloud` or `local` — which model config to use |
| `parallelWorkers` | `3` | Max concurrent non-implement workers |
| `workerTimeout` | `300000` (5 min) | Default timeout for worker RPC processes |
| `stallTimeout` | `60000` (1 min) | Timeout for stalled workers (no output) |
| `maxRetries` | `2` | Retry count on worker failure |
| `planTimeout` | `300000` (5 min) | Timeout for plan-only workflows |
| `agentTimeouts.<type>` | varies | Per-agent-type timeout override |
| `agentModels.<type>` | — | Per-agent-type model override (provider + model) |

## Permissions

### Tool Access by Worker Type

Workers are restricted by their declared tools. The orchestrator enforces this at spawn time:

- **explore:** `read`, `grep`, `find`, `ls`, `bash` (read-only)
- **plan:** `read`, `grep`, `find`, `ls` (no bash)
- **implement:** full access (all tools)
- **verify:** `read`, `grep`, `find`, `ls`, `bash` (read-only; tests only)

### Dangerous Commands

The following commands are blocked and require explicit approval when detected in any worker's bash calls:

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

### 1. One Implement Worker at a Time

The orchestrator enforces this (exclusive write slot), but it's good to plan for it. Structure your task decomposition so implementation steps are sequential, while exploration and verification can be parallel.

### 2. Parallel Explore/Verify Workers

Don't wait for one explore worker to finish before starting another. If you need to investigate three independent subsystems, spawn three explore workers at once:

```
Agent(agentType=explore, task="Investigate the API gateway auth middleware")
Agent(agentType=explore, task="Investigate the WebSocket handler")
Agent(agentType=explore, task="Investigate the database schema")
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

For anything involving multiple files or architectural changes, run `/plan` first. The explore → plan workflow gives you a structured plan to review before any code is touched.

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
