# ARCHITECTURE.md — Filin Next Agent (FNA)

> Comprehensive architecture reference. For quick context → [CLAUDE.md](./CLAUDE.md)

---

## Project Overview

- **Name:** Filin Next Agent (FNA)
- **Type:** Local AI runtime-agent for developers
- **Description:** Runs locally on user's machine, provides external API for multiple UI clients (TUI, WebView, IDEA plugin, etc.). Built on pi-coding-agent with custom orchestrator extension, model management, and all current extensions/skills.
- **Base:** Fork of badlogic/pi-mono (pi-coding-agent core)
- **Spec:** docs/specs/spec_runtime-agent_2026-04-10.md

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun | Fast JS runtime |
| Core | pi-ai + pi-agent-core + pi-coding-agent | Agent loop, tools, sessions, extensions |
| TUI | pi-tui | Terminal UI (markdown, editor, autocomplete) |
| Monorepo | npm workspaces | Consistent with pi-mono |
| API (local) | JSON-over-stdio RPC | For TUI, IDE plugins |
| API (remote) | Hono (REST + WebSocket) | For WebView, mobile, web clients |
| Database | Prisma + SQLite | Sessions metadata, model settings, budgets |
| Dashboard | Lit + Vite + pi-web-ui | Web UI client (connects via FNA API) |
| Build | tsup | ESM/CJS, declaration files |
| Language | TypeScript (strict) | — |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     UI Клиенты                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ TUI      │  │ WebView  │  │ IDEA     │  │ Dashboard│   │
│  │ (pi-tui) │  │ (Embed)  │  │ Plugin   │  │ (Lit)    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
└───────┼──────────────┼──────────────┼──────────────┼────────┘
        │ stdio        │ HTTP        │ stdio        │ HTTP
        │ RPC          │ REST+WS     │ RPC          │ REST+WS
┌───────┴──────────────┴──────────────┴──────────────┴────────┐
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              FNA Runtime Layer                          │  │
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
│  │              pi-coding-agent Core                       │  │
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
│  │  pi-ai           │  │  packages/db (Prisma + SQLite)   │  │
│  │  LLM Streaming   │  │  sessions, messages,              │  │
│  │  20+ Providers   │  │  model_settings, budgets          │  │
│  │  Local + Cloud   │  │  client_tokens                   │  │
│  └──────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Packages

### packages/ai (pi-ai) — Unchanged
LLM abstraction layer. Streaming, completions, 20+ providers, OpenAI-compatible endpoints (Ollama, vLLM, LM Studio).

### packages/agent (pi-agent-core) — Unchanged
Agent runtime. Agent class, agentLoop(), tool calling, TypeBox schemas, steer/followUp.

### packages/tui (pi-tui) — Unchanged
Terminal UI library. Markdown rendering, multi-line editor with autocomplete, loading spinners, differential rendering.

### packages/coding-agent (pi-coding-agent) — Modified
Core agent with built-in tools (read, write, edit, bash, grep, find, ls), session persistence (JSONL), extension system, skills.

**Modifications:**
- Integrate FNA orchestrator extension
- Integrate model manager (routing, fallback, budgets)
- Add FNA-specific settings

### packages/web-ui (pi-web-ui) — Modified
Lit web components (ChatPanel with streaming, file attachments, artifact rendering). Used as component library for dashboard client.

### packages/orchestrator — NEW
Coordinator extension for pi-coding-agent:
- Task decomposition and delegation
- Subagent spawning (explore, plan, implement, verify workers)
- Task tracking and status management
- Integration with session tree branching
- Uses pi extension API (lifecycle hooks: context, tool_call, session_start)

### packages/model-manager — NEW
Model management layer:
- **Provider Router:** Per-task routing (coding → Claude, quick → local, analysis → GPT-4)
- **Fallback Chains:** Configurable primary → fallback1 → fallback2, auto-retry, rate limit backoff
- **Budget Tracker:** Daily/monthly token/cost limits, alerts, auto-switch on exceed
- **Per-model Settings:** Temperature, thinking level, max tokens per provider/model
- Integration with pi ModelRegistry and AuthStorage

### packages/api-gateway — NEW
Client API layer:
- **stdio RPC:** JSON-over-stdio (extends pi --mode rpc with FNA commands)
- **HTTP REST:** Hono server (sessions, models, budgets endpoints)
- **WebSocket:** Real-time streaming (agent events + FNA-specific events)
- **API Key:** Token generation for client connections

### packages/db (Prisma + SQLite) — Modified
Database schema for metadata (sessions, model settings, budgets). See Database Schema section below.

### packages/dashboard — NEW (was modified, now new)
Lit-based web UI client connecting to FNA API:
- Chat panel with streaming
- Session list and management
- Model settings UI
- Budget visualization
- Built on pi-web-ui components

---

## Deployment Modes

| Mode | Invocation | Description |
|------|-----------|-------------|
| TUI (default) | `fna` | Interactive terminal with pi-tui |
| Print | `fna -p "..."` | Single-shot, then exit |
| RPC | `fna --mode rpc` | JSON-over-stdio for IDE plugins |
| Server | `fna --mode server` | HTTP REST + WebSocket on configurable port |
| SDK | `import { createFnaSession }` | Programmatic use as library |
| Desktop | Electron/Tauri wrapper | Windowed app with embedded runtime |

---

## Client API

### stdio RPC Protocol
JSON-over-stdio, extends pi --mode rpc:
- Standard pi commands: prompt, steer, followUp, subscribe events
- FNA additions: list sessions, model routing rules, budget status

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
Standard pi agent events (agent_start, message_update, tool_execution_start/end, agent_end) + FNA-specific events (budget alerts, model switches).

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
  → Agent calls pi-ai stream()
  → On failure → fallback chain activates
  → pi-tui renders markdown in real-time
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
| **Core** | pi-coding-agent (not custom) | Proven agent loop, tools, sessions, extensions ecosystem |
| **Orchestrator** | Pi extension (not custom runtime) | Hot-reload, pi ecosystem compat, less code |
| **API** | Hybrid stdio + HTTP | stdio for local (zero latency), HTTP for remote clients |
| **Auth** | API key only (no user auth) | Local runtime = single user |
| **DB** | SQLite via Prisma | Zero-config, file-based, sessions in JSONL + metadata in SQLite |
| **Model routing** | Rule-based presets + custom | Simple to start, extensible for power users |
| **Monorepo** | npm workspaces | Consistent with pi-mono |
| **Build** | tsup | Fast, ESM/CJS, dts |

---

## Migration from pi-mono

### Keep Unchanged
- `packages/ai/` — LLM abstraction
- `packages/agent/` — Agent runtime
- `packages/tui/` — TUI library

### Modify
- `packages/coding-agent/` — integrate FNA orchestrator + model manager
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
| pi-coding-agent API changes | Medium | High | Pin to specific version, cherry-pick updates |
| Model routing complexity | Medium | Medium | Start with simple presets, iterate |
| HTTP API backward compat | Low | Medium | Versioned API (/api/v1/), deprecation policy |
| Budget tracking accuracy | Low | Low | Cross-check with provider usage APIs |
| stdio/HTTP protocol drift | Low | Medium | Shared types package, auto-generated clients |
