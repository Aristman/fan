# CLAUDE.md — Filin Agent Next (FAN)

> Quick context for LLM sessions. For architecture details → [ARCHITECTURE.md](./ARCHITECTURE.md)

## Project
- **Name:** Filin Agent Next (FAN)
- **Type:** Local AI runtime-agent for developers
- **Base:** Fork of fan-mono (fan-coding-agent core)
- **Repo:** Monorepo (npm workspaces, Bun, TypeScript)
- **Stage:** Phase 7 — Polish & release ✅

## What It Is
Runs locally on user's machine. Provides external API for multiple UI clients (TUI, WebView, IDEA plugin, etc.). Built on fan-coding-agent with standalone orchestrator extension (FAN Store), model management, and all current extensions/skills.

## Tech Stack
Runtime: Bun · Monorepo: npm workspaces · Core: fan-ai + fan-agent-core + fan-coding-agent + fan-tui · API: stdio RPC + Hono HTTP/WS · DB: Prisma+SQLite · Dashboard: Lit+Vite · Build: tsgo
- **API Gateway:** Hono REST + WebSocket, token auth via ClientToken (DB)
- **Dashboard:** Lit (no shadow DOM for Tailwind) + Vite dev server + custom FAN theme (oklch hue 260°)

## Git Rules
- **Prefix:** all branches start with `FAN/`
- **Branches:** `master` (prod) → `develop` (integration) → `FAN/<type>/<name>`
- **Types:** feature, fix, hotfix
- **Commits:** conventional commits style

## Orchestrator Rules (Coordinator Mode)
- **1 task = 1 worker.** Tasks are created from plan decomposition, workers are launched based on tasks. Never launch one worker to cover multiple tasks.
- **Flow:** Plan → `TaskCreate` (all tasks) → `delegate_task` per task → `TaskUpdate` after worker completes → next task.
- **Task transitions:** `pending` → `in_progress` → `completed` (direct `pending` → `completed` is not allowed).

## Code Conventions
- TypeScript strict mode
- Packages in packages/ directory
- Each package has own package.json, tsconfig.json
- Extensions use fan extension API (lifecycle hooks, tools, commands)
- Skills follow fan skill format (SKILL.md)
- Session persistence: JSONL (fan format) + Prisma metadata
- No auth (local runtime, single-user, API key for client connections)
- Environment vars in .env (never committed)

## Key Files
- `docs/specs/spec_runtime-agent_2026-04-10.md` — current specification (runtime-agent)
- `docs/specs/MVP-SPEC.md` — superseded (web SaaS concept, archived)
- `ARCHITECTURE.md` — architecture, packages, data flow
- `docs/develop/tests/dashboard-phase6.md` — dashboard test report (26/30 passed)
- `INSTALL.md` — installation guide (Windows/Linux/macOS)
- `CONTRIBUTING.md` — contribution guide
- `MIGRATION.md` — migration from upstream fan/pi
- `.env.example` — environment variable template
- `docs/guides/configuration.md` — settings reference
- `docs/guides/orchestrator.md` — orchestrator guide
- `docs/guides/dashboard.md` — dashboard guide
- `docs/guides/api-reference.md` — API documentation
- `packages/coding-agent/src/cli/init-wizard.ts` — `fan init` setup wizard
- `packages/coding-agent/src/cli/diagnostics.ts` — `fan doctor` diagnostics module
- `packages/coding-agent/src/cli/server-command.ts` — `fan server` lifecycle management (start/stop/status)

## Phase Progress
- [x] Phase 1 — Project fork & setup (monorepo, renamed @fan/*, build pipeline)
- [x] Phase 2 — Model Management (ProviderRouter, FallbackChain, BudgetTracker, ModelManager)
- [x] Phase 3 — Client API Gateway (Hono REST+WS, auth, 14 endpoints, server mode)
- [x] Phase 4 — Orchestrator standalone extension (delegate_task tool, 4 workers, 3 workflows, slash commands, 29 tests)
- [x] Phase 5 — Orchestrator Hardening as extension (coordinator mode, task widget, /plan, config, workers, permissions, retry/fallback)
- [x] Phase 6 — Dashboard Client (Lit web UI, model settings, budget viz)
- [x] Phase 7 — Polish & release (CLI packaging, init wizard, doctor, server command, --web flag, CI/CD delivery, docs)
- [x] Phase 7.1 — Orchestrator extraction (removed hardcoded integration from core, standalone FAN Store extension, auto-discovery)

## Phase 6 Dashboard — Architecture Notes
- **WebUI is a thin frontend.** Disk (JSONL) = single source of truth. No in-memory session stores.
- **Runtime = execution engine only.** One active session at a time. `sendMessage(id)` → `runtime.switchSession(path)` if needed.
- **WS subscription forwarding:** adapter-level map sessionId → handlers. Resubscribes after `switchSession()`.
- **Server startup:** `SessionManager.continueRecent()` — opens last session from disk, creates new only if empty.
- **No shadow DOM:** `createRenderRoot() { return this; }` for Tailwind compatibility.
- **Custom FAN theme:** oklch colors at hue 260° (blue accent), light/dark variants in `app.css`.
- **Custom elements `display:flex/block`:** Set in `app.css` — native custom elements default to `display:inline`.
- **Icons:** `icon(name, classStr)` helper → Lucide SVG via `.innerHTML` (not Lit bindings).
- **`models.json`** is global-only: `~/.fan/agent/models.json` (hardcoded path). Project `.fan/models.json` is unread.
- **Model Settings** (temperature, maxTokens, thinking): stored in Prisma DB, not in models.json. Created via WebUI.

## CLI Commands
- `fan` — Interactive TUI mode (default)
- `fan init` — First-time setup wizard
- `fan doctor` — Environment and dependency checks
- `fan server` — Start server in foreground (full runtime)
- `fan server start` — Start background daemon (for IDE plugins)
- `fan server stop` — Stop background daemon
- `fan server status` — Check server status (--json for machine output)
- `fan --web` — Server + dashboard, auto-opens browser
- `--mode server` — Server without browser auto-open

## Test Instructions
- Dashboard: `docs/develop/tests/dashboard-phase6.md`
- Orchestrator: `docs/develop/tests/orchestrator-phase4.md`
- Quick build: `npm run build` (10 packages, 0 errors)
- Quick test: `cd packages/orchestrator && npx vitest run` (95 tests)
- Dashboard dev: `cd packages/dashboard && npm run dev` → http://localhost:5174
- CLI: `fan` — interactive TUI mode
- Setup wizard: `fan init` — first-time configuration
- Diagnostics: `fan doctor` — environment and dependency checks
- Server mode: `fan server` — full runtime server
- Background daemon: `fan server start` / `fan server stop` / `fan server status`
- Web dashboard: `fan --web` — server + auto-open browser
