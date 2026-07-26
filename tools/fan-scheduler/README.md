# @fan/scheduler — FAN Scheduler

Autonomous cron-based task runner for FAN (Phase 4 — Autonomy). Loads tasks from a YAML config and (in later features) executes them through the FAN API Gateway on schedule.

## Status

- **F-4.1 (done):** package structure + YAML config parsing (`lib/config-loader.ts`), skeletons for scheduler loop, queue, API client, logger.
- **F-4.2 … F-4.8 (done):** FAN API client, TaskQueue + execution pipeline, cron loop, bot identity, branch policy, PR via `gh`.
- **F-4.9 (done):** per-project budget caps — the executor sets the cap before `sendMessage` and monitors usage during execution (see below).
- **F-4.12 (done):** chat interruption — live chat pauses autonomous tasks; `chat > autonomous` priority (see below).
- **F-4.13 (done):** persistent queue — pending tasks survive restarts via write-on-change durability (see below).

## Persistent queue (F-4.13)

The pending task list is serialized to `<agentDir>/scheduler-pending.json` on **every queue mutation** (enqueue/dequeue) via the TaskQueue `onPendingChange` hook, and restored on startup (`queue.restore(...)`, then `runNext()` resumes processing).

- **Format:** `{ "version": 1, "tasks": [TaskConfig, ...] }` — version-checked on load; a mismatch ignores the file with a warning (future-proof for migrations).
- **Atomic write:** payload goes to `<path>.tmp` and is renamed over the target — a crash mid-write never leaves truncated JSON. Atomic rename is used instead of an explicit file lock (single-writer process).
- **Failure modes:** missing file → empty queue (silent); corrupt JSON / wrong shape → empty queue + warning (no crash); malformed task entries are skipped with a warning.
- **Graceful shutdown (F-4.5):** needs no extra flush — the queue is already on disk thanks to write-on-change.
- **Best-effort saves:** I/O failures are logged as errors, never thrown into the queue.

### Environment variables (F-4.13)

| Variable | Default | Description |
|----------|---------|-------------|
| `FAN_CODING_AGENT_DIR` | `~/.fan/agent` | agent dir; the pending file lives at `<agentDir>/scheduler-pending.json` |
| `FAN_SCHEDULER_PENDING_FILE` | _(unset)_ | full path override for the pending file (tests, side-by-side instances) |

## Chat interruption (F-4.12)

**Priority model: `chat > autonomous tasks`.** While the user is chatting, the scheduler pauses its queue; when the chat goes quiet, the queue resumes.

**Chosen mechanism — scheduler-side polling (no gateway changes).** The scheduler is a separate process from the api-gateway, so the gateway cannot call the TaskQueue in-process. Alternatives considered: (a) scheduler as WS observer on the gateway — complex/fragile (auth, reconnects, no "user is typing" frame in the protocol); (b) gateway → scheduler HTTP push — requires gateway changes and a new bidirectional dependency; (c) **scheduler polls the read-only HTTP API** — simple, testable, zero gateway changes. Option (c) is implemented in `lib/activity-monitor.ts` (`UserActivityMonitor`):

1. Every `FAN_SCHEDULER_ACTIVITY_POLL_MS` (default **5 s**) the monitor fetches `GET /api/sessions`.
2. Sessions **created by the scheduler itself** are excluded — the executor registers each session via `onSessionCreated` right after `createSession` (task prompts are user-role messages and would otherwise look like chat).
3. For every other session that changed since the last poll, the monitor fetches its detail; if the latest user-role message is younger than `FAN_SCHEDULER_ACTIVITY_WINDOW_MS` (default **60 s**), chat counts as active → `queue.pauseCurrent()` and log `chat_interruption` ("Paused autonomous task for live chat").
4. When no recent user message remains → `queue.runNext()` and log `chat_interruption_end`.

**Resume behavior (spec: "опционально" — implemented):** auto-resume starts the **next pending task**; a task that was in flight when the pause hit is *not* aborted server-side (the gateway has no interruption endpoint — same documented limitation as F-4.4/F-4.9), it settles and the queue continues. The monitor only resumes pauses it made itself and logs transitions once (no flapping). Poll failures are best-effort warnings — a gateway hiccup never crashes the scheduler or flaps the queue.

**Control server (`lib/control-server.ts`)** — the external pause/resume signal channel (spec: "scheduler can receive pause signal … HTTP endpoint"). Localhost-only HTTP server, no auth (same trust model as the local runtime):

| Route | Effect |
|-------|--------|
| `POST /pause`  | `queue.pauseCurrent()` — pause autonomous tasks |
| `POST /resume` | `queue.runNext()` — resume auto-advance |
| `GET /state`   | `{ state, isRunning, pendingCount, currentTask, lastResult, pausedForChat }` |
| `GET /health`  | `{ status, running, pendingCount, lastTaskStatus, uptimeSeconds, queueVersion }` (F-4.14) |

**Health & metrics (F-4.14):** `GET /health` returns operational metrics only — no secrets, no task contents, no blocking operations (in-memory queue state). `status` is `"degraded"` when the scheduler started with a corrupt pending-queue file (F-4.13: unreadable / invalid JSON / wrong shape / version mismatch — tasks were dropped, check the logs for `pending_file_corrupt` / `pending_version_mismatch` warnings); otherwise `"ok"`. The api-gateway proxies this endpoint at `GET /api/scheduler/health` (env `FAN_SCHEDULER_URL`, default `http://127.0.0.1:3457`) and answers `503 { status: "degraded", scheduler: "down" }` when the scheduler process is unreachable.

### Environment variables (F-4.12)

| Variable | Default | Description |
|----------|---------|-------------|
| `FAN_SCHEDULER_PAUSE_ON_USER_ACTIVITY` | `true` | `off`/`0`/`false`/`no` disables the activity monitor |
| `FAN_SCHEDULER_ACTIVITY_POLL_MS` | `5000` | interval between `GET /api/sessions` polls |
| `FAN_SCHEDULER_ACTIVITY_WINDOW_MS` | `60000` | how long a user message counts as live chat |
| `FAN_SCHEDULER_CONTROL` | `true` | `off`/`0`/`false`/`no` disables the control server |
| `FAN_SCHEDULER_CONTROL_PORT` | `3457` | control server port (bound to `127.0.0.1`) |

A failed control-server bind is a warning, not a crash — the scheduler keeps running without it.

## Budget monitoring (F-4.9)

When a task has `budget_limit` set:

1. **Before `sendMessage`:** `setProjectBudget(workspace, budget_limit)` → `PUT /api/budget { project, tokenLimit }` (gateway persists the cap in `~/.fan/agent/project-budgets.json`). Best-effort: failures are logged as warnings and ignored.
2. **During execution:** `getBudgetUsage(workspace)` → `GET /api/budget?project=…` is polled every `budgetPollIntervalMs` (default **30 s**, configurable via `TaskExecutorOptions`). Each poll is logged as JSON: `{ "event": "budget_monitor", "project", "used", "limit", "percentage" }`. Poll failures are best-effort (warning, monitoring continues).
3. **`used >= limit`:** the wait stops, the task is marked `budget_exceeded` with a warning. Note: the gateway has no interruption endpoint (documented in F-4.4), so the agent keeps running server-side — only the scheduler's wait is aborted.
4. **After completion:** a final usage report is logged (`usage report: used X / Y tokens`).

The gateway itself does **not** block messages on cap exhaustion — enforcement lives here, in the scheduler.

## Usage

```bash
cd tools/fan-scheduler
bun install
bun run build     # tsc → dist/
bun run start     # bun dist/scheduler.js (uses config.yaml next to package root)
bun run test      # vitest
```

A custom config path can be passed as the first CLI argument: `bun dist/scheduler.js /path/to/config.yaml`.

## Config format (`config.yaml`)

```yaml
tasks:
  - name: daily-code-review      # required, unique task name
    schedule: "0 9 * * *"        # required, 5-field cron expression
    workspace: /data/repos/proj  # required, used as session cwd
    message: "Review commits"    # required, prompt sent to the agent
    budget_limit: 500            # optional, default: null (no cap)
    timeout: 3600                # optional, seconds, default: 3600
```

Validation: required fields are checked, cron expressions are syntax-validated, malformed YAML produces an error with the line number.

## Monorepo integration decisions (F-4.1)

- **npm workspaces:** the package is included via `"tools/*"` in the root `package.json`. `tools/fan-store-server` has no `package.json`, so it is ignored by the workspaces glob. The root `npm run build` script is intentionally unchanged (it builds `packages/*` only); fan-scheduler builds itself with `tsc`.
- **YAML parser:** the `yaml` npm package (already used by `packages/coding-agent`, hoisted at the repo root) — no new dependency introduced.
- **Cron validation:** no cron library exists in the repo. F-4.1 only needs syntax validation, so a dependency-free 5-field cron validator (`isValidCron`) is implemented in `lib/config-loader.ts`. A real scheduling library (e.g. `croner`, Bun-compatible) will be added in F-4.5 when actual cron triggering is implemented.
- **Tests:** own `vitest.config.ts`; tests live next to sources in `lib/*.test.ts` and are excluded from the `tsc` build.
