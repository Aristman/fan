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

## Coordinator Mode

Coordinator mode changes the LLM's role from "doer" to "manager." When active, the agent does **not** use code tools directly — it only delegates via `delegate_task` and tracks progress with `TaskCreate`/`TaskUpdate`.

### Enabling Coordinator Mode

- **Alt+O** — Toggle coordinator mode on/off in the TUI.
- **`/orchestrator on`** — Enable via slash command.
- **`/orchestrator off`** — Disable via slash command.

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
| **explore** | read, grep, find, ls, bash | Read-only | Fast codebase exploration, file search, structure mapping |
| **plan** | read, grep, find, ls | Read-only | Deep architectural analysis, implementation planning |
| **implement** | read, write, edit, bash, grep, find, ls | Full | Making code changes, running tests, building |
| **verify** | read, grep, find, ls, bash | Read-only | Build checks, test runs, lint, adversarial code review |

### Concurrency Rules

- **Implement workers:** maximum 1 at a time (exclusive write slot).
- **Explore/plan/verify workers:** up to `parallelWorkers` concurrently (default: 3).
- Workers queue automatically when the pool is full.

## The `delegate_task` Tool

The core mechanism for spawning workers. Called by the coordinator (or manually via `/delegate`).

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentType` | string | Yes | One of: `explore`, `plan`, `implement`, `verify` |
| `task` | string | Yes | Self-contained task description with all context |
| `context` | string | No | Additional context (e.g., explore output, plan text) |

### Execution Modes

| Mode | Flag | Description |
|------|------|-------------|
| **single** | default | One worker, one task |
| **parallel** | `parallel: true` | Up to 8 tasks, 4 concurrent |
| **chain** | `chain: [...]` | Sequential tasks with `{previous}` placeholder |

### Chain Example

When using the `/plan` workflow, the coordinator chains workers together:

```
explore → plan → (present to user)
```

Each step receives the previous step's output via the `{previous}` placeholder in the task prompt.

### Worker Isolation

Workers run in separate `fna` subprocesses. They cannot see:

- The main conversation history
- Other workers' outputs (unless passed via `context` or `{previous}`)
- The coordinator's reasoning

This means **worker prompts must be self-contained.** Include file paths, line numbers, exact change descriptions, and any relevant code snippets.

## Slash Commands

### `/orchestrator [on|off|stop|config|mode|status]`

Master control for the orchestrator.

- `/orchestrator on` — Enable coordinator mode.
- `/orchestrator off` — Disable coordinator mode (agent returns to direct execution).
- `/orchestrator stop` — Cancel all running workers.
- `/orchestrator config` — Show current configuration.
- `/orchestrator mode` — Display current execution mode.
- `/orchestrator status` — Show workers and tasks overview.

### `/plan [task description]`

Strategic planning workflow. Runs explore → plan and presents the plan to you before any implementation.

```
/plan Add pagination to the sessions API endpoint
```

This spawns an explore worker to gather context, then a plan worker to produce a structured implementation plan. You review the plan before deciding whether to proceed.

### `/tasks [status]`

View tracked tasks. Optionally filter by status.

```
/tasks              # Show all tasks
/tasks in_progress  # Show only in-progress tasks
/tasks completed    # Show only completed tasks
```

### `/agents [scope]`

List available worker agents.

```
/agents      # All agents (user + project)
/agents user # User-defined agents only
/agents project # Project agents only
```

Agents are discovered from three sources (highest priority wins):

1. **Built-in:** `packages/orchestrator/src/agents/*.md`
2. **User:** `~/.fan/agent/agents/*.md`
3. **Project:** `.fan/agents/*.md` (walked up to git root)

### `/delegate <agentType> <task>`

Quick delegate a task to a specific worker without full coordinator mode.

```
/delegate explore "Find all files that import from packages/orchestrator"
/delegate verify "Run tests and check for regressions in the API gateway"
```

## Task Management

Tasks are the coordinator's way of tracking progress. They're created with `TaskCreate`, updated with `TaskUpdate`, and viewed with `list_tasks`.

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
User: /delegate verify "Run the full test suite and check for regressions"
```

Execution:

1. **Implement** worker applies any pending fixes (if chained).
2. **Verify** worker runs tests, linters, and reviews code.
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
    "maxRetries": 2,
    "planTimeout": 300000,
    "agentTimeouts": {
        "explore": 120000,
        "plan": 180000,
        "implement": 300000,
        "verify": 180000
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
| `workerTimeout` | `300000` (5 min) | Default timeout for worker subprocesses |
| `maxRetries` | `2` | Retry count on worker failure |
| `planTimeout` | `300000` (5 min) | Timeout for plan-only workflows |
| `agentTimeouts.explore` | `120000` (2 min) | Timeout for explore workers |
| `agentTimeouts.plan` | `180000` (3 min) | Timeout for plan workers |
| `agentTimeouts.implement` | `300000` (5 min) | Timeout for implement workers |
| `agentTimeouts.verify` | `180000` (3 min) | Timeout for verify workers |

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
delegate_task(agentType=explore, task="Investigate the API gateway auth middleware")
delegate_task(agentType=explore, task="Investigate the WebSocket handler")
delegate_task(agentType=explore, task="Investigate the database schema")
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

The coordinator does this automatically, but if you're using `/delegate` directly, remember to follow up with a verify worker:

```
/delegate implement "Add rate limiting middleware"
/delegate verify "Check the new middleware: run tests, review code, verify API still works"
```

Look for `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL` in the verify output.
