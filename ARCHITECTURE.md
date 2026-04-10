# ARCHITECTURE.md — Filin Agent Next (FAN)

> Comprehensive architecture reference. For quick context → [CLAUDE.md](./CLAUDE.md)

---

## Project Overview

- **Name:** Filin Agent Next (FAN)
- **Type:** Local AI runtime-agent for developers
- **Description:** Runs locally on user's machine, provides external API for multiple UI clients (TUI, WebView, IDEA plugin, etc.). Built on fan-coding-agent with custom orchestrator extension, model management, and all current extensions/skills.
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
| Build | tsup | ESM/CJS, declaration files |
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
- Integrate FAN orchestrator extension
- Integrate model manager (routing, fallback, budgets)
- Add FAN-specific settings

### packages/web-ui (fan-web-ui) — Modified
Lit web components (ChatPanel with streaming, file attachments, artifact rendering). Used as component library for dashboard client.

### packages/orchestrator — NEW
Coordinator extension for fan-coding-agent:
- Task decomposition and delegation
- Subagent spawning (explore, plan, implement, verify workers)
- Task tracking and status management
- Integration with session tree branching
- Uses fan extension API (lifecycle hooks: context, tool_call, session_start)

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

## Deployment Modes

| Mode | Invocation | Description |
|------|-----------|-------------|
| TUI (default) | `fna` | Interactive terminal with fan-tui |
| Print | `fna -p "..."` | Single-shot, then exit |
| RPC | `fna --mode rpc` | JSON-over-stdio for IDE plugins |
| Server | `fna --mode server` | HTTP REST + WebSocket on configurable port |
| SDK | `import { createFnaSession }` | Programmatic use as library |
| Desktop | Electron/Tauri wrapper | Windowed app with embedded runtime |

---

## HTTP API (Server Mode)

When started with `--mode server`, FAN exposes a REST API + WebSocket on a configurable port (default: 3456).

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
- `packages/coding-agent/` — integrate FAN orchestrator + model manager
- `packages/web-ui/` — adapt as component library for dashboard

### Remove
- `packages/mom/` — Slack bot (not relevant)
- `packages/pods/` — vLLM management (not relevant)

### Add
- `packages/orchestrator/` — coordinator extension
- `packages/model-manager/` — routing, fallback, budgets
- `packages/api-gateway/` — client API (stdio + HTTP)
- `packages/dashboard/` — Lit UI client

---

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| fan-coding-agent API changes | Medium | High | Pin to specific version, cherry-pick updates |
| Model routing complexity | Medium | Medium | Start with simple presets, iterate |
| HTTP API backward compat | Low | Medium | Versioned API (/api/v1/), deprecation policy |
| Budget tracking accuracy | Low | Low | Cross-check with provider usage APIs |
| stdio/HTTP protocol drift | Low | Medium | Shared types package, auto-generated clients |
