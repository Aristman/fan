# @fan/scheduler — FAN Scheduler

Autonomous cron-based task runner for FAN (Phase 4 — Autonomy). Loads tasks from a YAML config and (in later features) executes them through the FAN API Gateway on schedule.

## Status

- **F-4.1 (done):** package structure + YAML config parsing (`lib/config-loader.ts`), skeletons for scheduler loop, queue, API client, logger.
- **F-4.2 … F-4.8 (done):** FAN API client, TaskQueue + execution pipeline, cron loop, bot identity, branch policy, PR via `gh`.
- **F-4.9 (done):** per-project budget caps — the executor sets the cap before `sendMessage` and monitors usage during execution (see below).

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
