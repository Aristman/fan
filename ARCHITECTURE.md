# ARCHITECTURE.md — Filin Agent Next (FAN)

> Comprehensive architecture reference. For quick context → [CLAUDE.md](./CLAUDE.md)

---

## Project Overview

- **Name:** Filin Agent Next (FAN)
- **Type:** Local AI runtime-agent for developers
- **Description:** Runs locally on user's machine, provides external API for multiple UI clients (TUI, WebView, IDEA plugin, etc.). Built on fan-coding-agent with standalone orchestrator extension (FAN Store), model management, and all current extensions/skills.
- **Base:** Fork of itone/fan-mono (fan-coding-agent core)
- **Spec:** docs/specs/spec_runtime-agent_2026-04-10.md

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun | Fast JS runtime |
| Core | fan-ai + fan-agent-core + fan-coding-agent | Agent loop, tools, sessions, extensions |
| TUI | fan-tui | Terminal UI (markdown, editor, autocomplete) |
| Monorepo | npm workspaces | Consistent with fan-mono |
| API (local) | JSON-over-stdio RPC | For TUI, IDE plugins |
| API (remote) | Hono (REST + WebSocket) | For WebView, mobile, web clients |
| Database | Prisma + SQLite | Sessions metadata, model settings, budgets |
| Dashboard | Lit + Vite + fan-web-ui | Web UI client (connects via FAN API) |
| Build | tsgo (native TypeScript Go compiler) | ESM/CJS, declaration files |
| Language | TypeScript (strict) | — |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     UI Клиенты                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ TUI      │  │ WebView  │  │ IDEA     │  │ Dashboard│   │
│  │ (fan-tui) │  │ (Embed)  │  │ Plugin   │  │ (Lit)    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
└───────┼──────────────┼──────────────┼──────────────┼────────┘
        │ stdio        │ HTTP        │ stdio        │ HTTP
        │ RPC          │ REST+WS     │ RPC          │ REST+WS
┌───────┴──────────────┴──────────────┴──────────────┴────────┐
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              FAN Runtime Layer                          │  │
│  │  ┌────────────────┐  ┌─────────────────────────────┐  │  │
│  │  │ Orchestrator   │  │ Client API Gateway          │  │  │
│  │  │ (Extension)    │  │ ┌──────────┐ ┌───────────┐  │  │  │
│  │  │ • coordinator  │  │ │ stdio    │ │ HTTP      │  │  │  │
│  │  │ • subagents    │  │ │ RPC      │ │ REST+WS   │  │  │  │
│  │  │ • task mgmt    │  │ └──────────┘ └───────────┘  │  │  │
│  │  └────────────────┘  └─────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              fan-coding-agent Core                       │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │ AgentSession │  │ SessionMgr   │  │ Settings   │  │  │
│  │  │ Agent Loop   │  │ JSONL        │  │ Manager    │  │  │
│  │  │ Compaction   │  │ Tree Branch  │  │            │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │ ModelRegistry│  │ Extension    │  │ Tool       │  │  │
│  │  │ 2000+ models │  │ Runner       │  │ Manager    │  │  │
│  │  │ Custom defs  │  │ Hot-reload   │  │ r/w/bash   │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Model Management Layer                     │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │ Provider     │  │ Fallback     │  │ Budget     │  │  │
│  │  │ Router       │  │ Chain        │  │ Tracker    │  │  │
│  │  │ (per-task)   │  │ (local→cloud)│  │ (limits)   │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────────┐  │
│  │  fan-ai          │  │  packages/db (Prisma + SQLite)   │  │
│  │  LLM Streaming   │  │  sessions, messages,              │  │
│  │  20+ Providers   │  │  model_settings, budgets          │  │
│  │  Local + Cloud   │  │  client_tokens                   │  │
│  └──────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Packages

### packages/ai (fan-ai) — Unchanged
LLM abstraction layer. Streaming, completions, 20+ providers, OpenAI-compatible endpoints (Ollama, vLLM, LM Studio).

### packages/agent (fan-agent-core) — Unchanged
Agent runtime. Agent class, agentLoop(), tool calling, TypeBox schemas, steer/followUp.

### packages/tui (fan-tui) — Unchanged
Terminal UI library. Markdown rendering, multi-line editor with autocomplete, loading spinners, differential rendering.

### packages/coding-agent (fan-coding-agent) — Modified
Core agent with built-in tools (read, write, edit, bash, grep, find, ls), session persistence (JSONL), extension system, skills.

**Modifications:**
- Install FAN orchestrator extension (via FAN Store)
- Integrate model manager (routing, fallback, budgets)
- Add FAN-specific settings

### packages/web-ui (fan-web-ui) — Modified
Lit web components (ChatPanel with streaming, file attachments, artifact rendering). Used as component library for dashboard client.

### packages/orchestrator — NEW

> **Note:** The orchestrator is now a standalone FAN extension (not hardcoded into the core). It ships with FAN (bundled) and is auto-discovered by the extension loader. No static imports exist in the coding-agent core.

Coordinator extension for fan-coding-agent. Multi-agent task decomposition and
coordination via RPC-based subagent delegation (`fan --mode rpc`).

**Components:**
- **types.ts** — Core types (WorkerType, ExecutionMode, AgentConfig, UsageStats, SubagentTask)
- **config.ts** — Configuration loading from config.json with defaults, model resolution (resolveModel), cloud health check with caching
- **agents.ts** — Agent discovery from builtin/user/project dirs with priority override, coordinator/planning prompts
- **workers.ts** — Worker registry and slot pool (acquireSlot/releaseSlot FIFO queue, write slot limiting)
- **permissions.ts** — Dangerous command detection (8 regex patterns), tool_call event handler with block/allow UI
- **subagent-runner.ts** — Spawns fan subprocesses with JSON streaming, abort support, usage tracking, retry/fallback logic
- **task-manager.ts** — Task lifecycle (CRUD, status transitions, blocking, serialization)
- **orchestrator-tools.ts** — LLM-callable tools (Agent, SendMessage, StopAgent, TaskCreate, TaskUpdate, TaskList)
- **orchestrator-extension.ts** — Extension wiring with slash commands (/orchestrator, /plan), coordinator mode, task widget

**Built-in workers (8):** explore (fast recon), plan (implementation plans),
implement (general-purpose), verify (code review), bug-fix (targeted fixes),
code-research (deep code analysis), tests-impl (test writing), docs-impl (documentation).

**Worker spawning:** RPC mode (`fan --mode rpc`) — each worker runs as a
detached fan RPC process with JSON-over-stdio communication.

**Workflow prompts (2):** implement (explore→plan→implement), plan-only (explore→plan).

**Slash commands:** /orchestrator (on/off/stop/config/status), /plan

**Coordinator mode:** Alt+O toggle, system prompt injection, auto-delegation via Agent tool

**Task widget:** Collapsible checklist above editor (Alt+T toggle), auto-hide on no active tasks

**Dependencies:** @itone/fan-ai, @itone/fan-agent-core, @itone/fan-coding-agent,
@itone/fan-tui, @sinclair/typebox

### packages/model-manager — NEW
Model management layer:
- **Provider Router:** Per-task routing (coding → Claude, quick → local, analysis → GPT-4)
- **Fallback Chains:** Configurable primary → fallback1 → fallback2, auto-retry, rate limit backoff
- **Budget Tracker:** Daily/monthly token/cost limits, alerts, auto-switch on exceed
- **Per-model Settings:** Temperature, thinking level, max tokens per provider/model
- Integration with fan ModelRegistry and AuthStorage

### packages/api-gateway/
Client API Gateway — HTTP REST + WebSocket server mode for FAN.

- **auth.ts** — API token management (generate, validate, list, revoke) via ClientToken DB model. Hono middleware for Bearer token auth.
- **http-server.ts** — Hono-based REST server with all endpoints (sessions, messages, models, budget, tokens, health). `SessionAdapter` interface decouples from coding-agent.
- **ws-handler.ts** — WebSocket upgrade handler for `/api/ws/:sessionId`. Multi-client broadcast, session event forwarding, token auth.
- **types.ts** — Shared request/response types for REST + WebSocket events.

**Dependencies:** `hono`, `@hono/node-server`, `ws`, `@fan/db`, `@fan/model-manager`

**Note:** Uses @hono/node-server (not manual createServer) for proper request body parsing on Node.js.

### packages/db (Prisma + SQLite) — Modified
Database schema for metadata (sessions, model settings, budgets). See Database Schema section below.

### packages/dashboard — NEW (was modified, now new)
Lit-based web UI client connecting to FAN API:
- Chat panel with streaming
- Session list and management
- Model settings UI
- Budget visualization
- Built on fan-web-ui components

---

## Skills (`skills/`)

FAN includes 11 pre-installed skills in the `skills/` directory. Each skill follows the fan skill format (`SKILL.md` with frontmatter). Skills are also published to FAN Store and can be installed/updated via `fan store`.

| Skill | Files | Description |
|-------|-------|-------------|
| `ask-answer` | 3 | Interactive TUI dialog (question, questionnaire tools) |
| `auto-tests` | 8 | Autonomous test generation, 8 languages (Kotlin, Java, TS, Python, Rust, Go, C#, C++) |
| `bug-fix` | 2 | Autonomous bug-fix agent (reproduce → root cause → fix → verify) |
| `code-research` | 2 | READ-ONLY deep codebase analysis (no file modifications) |
| `deep-dive` | 3 | Deep-dive investigation from repo-explorer reports |
| `fan-forge` | 19 | Extension & skill factory (7-phase pipeline, adapted from pi-forge) |
| `idea-lab` | 8 | Idea research and analysis (technical / business / creative) |
| `repo-explorer` | 9 | Git repository analysis (GitHub & local), structured reports |
| `research-spec-generator` | 5 | Research + specification generation with iterative interviewing |
| `skill-improver` | 4 | AutoResearch optimization loop for existing skills |
| `smoke-tester` | 10 | E2E UI testing via Playwright MCP, screenshot reports |

**Total:** 11 skills, 73 files. All at v1.0.0.

**FAN Store:** `http://185.219.41.46/fan/` — install via `fan store install <name>`.

---

## Deployment Modes

| Mode | Invocation | Description |
|------|-----------|-------------|
| TUI (default) | `fan` | Interactive terminal with fan-tui |
| Print | `fan -p "..."` | Single-shot, then exit |
| Init Wizard | `fan init` | First-time setup wizard |
| Diagnostics | `fan doctor` | Environment and dependency health checks |
| RPC | `fan --mode rpc` | JSON-over-stdio for IDE plugins |
| **Server** | **`fan server`** | **Full runtime as HTTP server (sessions, extensions, models, orchestrator)** |
| **Server (daemon)** | **`fan server start`** | **Background daemon for IDE/plugin integration** |
| **Web** | **`fan --web`** | **Server + dashboard, auto-opens browser** |

---

## HTTP API (Server Mode)

When started with `fan server` (or `--mode server` / `--web`), FAN exposes a REST API + WebSocket on a configurable port (default: 3456).

### Authentication
- API token via `Authorization: Bearer <token>` header or `?token=` query param
- Disabled in dev mode with `FAN_NO_AUTH=1`

### Key Endpoints
- `GET /api/health` — Health check (no auth)
- `POST/GET/DELETE /api/sessions[/:id]` — Session CRUD
- `POST /api/sessions/:id/messages` — Send message (events via WS)
- `GET /api/models` — Available models + routing rules
- `GET/PUT /api/models/settings` — Per-model settings
- `GET/PUT /api/budget` — Budget status and configuration
- `POST/GET/DELETE /api/tokens` — API token management
- `WS /api/ws/:sessionId` — Real-time event streaming

### RPC Extensions
The stdio RPC mode (`--mode rpc`) has been extended with FAN-specific commands:
- `get_routing_rules`, `get_budget_status`, `get_model_settings`
- `generate_token`, `list_tokens`, `revoke_token`

---

## Server Lifecycle

`fan server` provides full runtime lifecycle management for external client integration (IDE plugins, custom UIs).

### Background Daemon Mode

```bash
fan server start           # Start background daemon
fan server start --port 8080  # Custom port
fan server status          # Check status (exit code 0 = running, 1 = not running)
fan server status --json   # Machine-readable output for IDE plugins
fan server stop            # Graceful stop (SIGTERM → SIGKILL after 5s)
```

### State Files
- `~/.fan/agent/server.json` — Server metadata (PID, port, host, startTime)
- `~/.fan/agent/server.pid` — PID file
- `~/.fan/agent/server.log` — Daemon output log

### IDE Plugin Integration Flow
1. Plugin calls `fan server status --json` → parses exit code and JSON
2. If not running → `fan server start`
3. Connect to `http://localhost:3456` with token from API
4. Use REST + WebSocket for full agent interaction

### Full Runtime Guarantee
`fan server` runs the complete runtime pipeline:
- Settings merge (global + project)
- Session management (continue recent or create new)
- Extensions & skills loading
- Model registry with routing and fallback
- Orchestrator with multi-agent delegation
- All tools available to connected clients

---

## Client API

### stdio RPC Protocol
JSON-over-stdio, extends pi --mode rpc:
- Standard pi commands: prompt, steer, followUp, subscribe events
- FAN additions: list sessions, model routing rules, budget status

### HTTP REST Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/sessions | Create session |
| GET | /api/sessions | List sessions |
| GET | /api/sessions/:id | Get session with messages |
| DELETE | /api/sessions/:id | Delete session |
| POST | /api/sessions/:id/messages | Send message |
| WS | /api/ws/:sessionId | WebSocket streaming |
| GET | /api/models | Available models + routing rules |
| GET | /api/models/settings | Model settings |
| PUT | /api/models/settings | Update model settings |
| GET | /api/budget | Budget status |
| PUT | /api/budget | Update budget limits |
| GET | /api/health | Health check |

### WebSocket Events
Standard pi agent events (agent_start, message_update, tool_execution_start/end, agent_end) + FAN-specific events (budget alerts, model switches).

---

## Database Schema

```prisma
model Session {
  id        String    @id @default(cuid())
  title     String    @default("New Session")
  model     String?
  provider  String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  messages  Message[]
}

model Message {
  id        String   @id @default(cuid())
  sessionId String
  session   Session  @relation(fields: [sessionId], references: [id])
  role      String   // "user" | "assistant" | "tool"
  content   String
  toolCalls Json?
  model     String?
  tokens    Int?
  cost      Float?
  createdAt DateTime @default(now())
}

model ModelSetting {
  id          String   @id @default(cuid())
  provider    String
  model       String
  temperature Float?   @default(0.7)
  maxTokens   Int?
  thinking    String?
  isDefault   Boolean  @default(false)
  priority    Int?     @default(0)
  updatedAt   DateTime @updatedAt
}

model RoutingRule {
  id        String  @id @default(cuid())
  name      String
  provider  String
  model     String
  fallback  String?
  enabled   Boolean @default(true)
}

model Budget {
  id         String   @id @default(cuid())
  provider   String?
  period     String   // "daily" | "monthly"
  tokenLimit Int?
  costLimit  Float?
  tokensUsed Int      @default(0)
  costUsed   Float    @default(0)
  resetAt    DateTime
  createdAt  DateTime @default(now())
}

model ClientToken {
  id        String   @id @default(cuid())
  name      String
  token     String   @unique
  createdAt DateTime @default(now())
  lastUsed  DateTime?
}
```

---

## Data Flow

### Chat Message Flow (TUI)
```
User types in TUI
  → AgentSession.prompt()
  → Orchestrator extension evaluates task type
  → Model Manager selects provider/model via routing rules
  → Agent calls fan-ai stream()
  → On failure → fallback chain activates
  → fan-tui renders markdown in real-time
  → Message saved to JSONL session + Prisma metadata
  → Budget tracker updates token/cost counters
```

### Chat Message Flow (External Client via HTTP)
```
Client sends POST /api/sessions/:id/messages
  → API Gateway validates client token
  → AgentSession.prompt() (same flow as TUI)
  → Events streamed via WebSocket /api/ws/:sessionId
  → Client receives text_delta, tool_execution events
```

### Model Routing Flow
```
Task received
  → Orchestrator classifies task type (coding, quick, analysis, chat)
  → RoutingRule matched by task type
  → Primary model selected from ModelSetting
  → If model fails → fallback chain: try next model
  → Budget check: if limit exceeded → alert + auto-switch to cheaper model
```

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Runtime** | Local (not web SaaS) | Simpler deployment, user owns data, no server infra |
| **Core** | fan-coding-agent (not custom) | Proven agent loop, tools, sessions, extensions ecosystem |
| **Orchestrator** | fan extension (not custom runtime) | Hot-reload, fan ecosystem compat, less code |
| **API** | Hybrid stdio + HTTP | stdio for local (zero latency), HTTP for remote clients |
| **Auth** | API key only (no user auth) | Local runtime = single user |
| **DB** | SQLite via Prisma | Zero-config, file-based, sessions in JSONL + metadata in SQLite |
| **Model routing** | Rule-based presets + custom | Simple to start, extensible for power users |
| **Monorepo** | npm workspaces | Consistent with fan-mono |
| **Build** | tsup | Fast, ESM/CJS, dts |

---

## Migration from fan-mono

### Keep Unchanged
- `packages/ai/` — LLM abstraction
- `packages/agent/` — Agent runtime
- `packages/tui/` — TUI library

### Modify
- `packages/coding-agent/` — install FAN orchestrator extension + model manager
- `packages/web-ui/` — adapt as component library for dashboard

### Remove
- `packages/mom/` — Slack bot (not relevant)
- `packages/pods/` — vLLM management (not relevant)

### Add
- `packages/orchestrator/` — standalone coordinator extension (FAN Store)
- `packages/model-manager/` — routing, fallback, budgets
- `packages/api-gateway/` — client API (stdio + HTTP)
- `packages/dashboard/` — Lit UI client

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `fan` | Interactive TUI mode (default) |
| `fan init` | Setup wizard |
| `fan doctor` | Diagnostics |
| `fan server` | Start API server in foreground (full runtime) |
| `fan server start` | Start background daemon |
| `fan server stop` | Stop background daemon |
| `fan server status` | Check daemon status (`--json` for machine output) |
| `fan --web` | Server + dashboard, auto-opens browser |
| `fan -p "..."` | Single-shot print mode |
| `fan --mode rpc` | JSON-over-stdio for IDE/plugins |

---

## Documentation

| File | Description |
|------|-------------|
| [CLAUDE.md](./CLAUDE.md) | Quick context for LLM sessions |
| [INSTALL.md](./INSTALL.md) | Installation guide (Windows, Linux, macOS) |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contribution guide |
| [MIGRATION.md](./MIGRATION.md) | Migration from upstream fan/pi |
| [.env.example](./.env.example) | Environment variable template |
| [docs/guides/configuration.md](./docs/guides/configuration.md) | Settings reference |
| [docs/guides/orchestrator.md](./docs/guides/orchestrator.md) | Orchestrator guide |
| [docs/guides/dashboard.md](./docs/guides/dashboard.md) | Dashboard guide |
| [docs/guides/api-reference.md](./docs/guides/api-reference.md) | API documentation |
| [skills/](./skills/) | 11 pre-installed skills (SKILL.md, FAN Store) |

---

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| fan-coding-agent API changes | Medium | High | Pin to specific version, cherry-pick updates |
| Model routing complexity | Medium | Medium | Start with simple presets, iterate |
| HTTP API backward compat | Low | Medium | Versioned API (/api/v1/), deprecation policy |
| Budget tracking accuracy | Low | Low | Cross-check with provider usage APIs |
| stdio/HTTP protocol drift | Low | Medium | Shared types package, auto-generated clients |
