# Claude.md — Filin Next Agent

## Project Overview
- **Name:** Filin Next Agent (FNA)
- **Type:** AI Agent web platform for developers
- **Description:** Web interface for chatting with AI agents, managing models, extensions, and skills. Multi-user, persistent sessions, billing-ready.
- **Base:** Fork of badlogic/pi-mono → Aristman/pi-mono
- **MVP Status:** Planning (v0.1)

## Tech Stack
- **Runtime:** Bun
- **Monorepo:** npm workspaces
- **API:** Hono (REST + WebSocket)
- **Database:** Prisma + SQLite
- **Auth:** JWT (httpOnly cookie) + bcrypt (via Bun.passwordHash)
- **Dashboard:** Lit + Vite
- **Build:** tsup
- **Language:** TypeScript
- **Streaming:** SSE over WebSocket (compatible with pi-ai EventStream)
- **File serving:** Vite in dev, Hono static in production

## Architecture

Monorepo with `packages/` directory. The API server (Hono) serves the Dashboard (Lit) frontend. Agent logic is powered by pi-ai (LLM abstraction with 20+ providers) and pi-agent-core (agent loop). Data is persisted via Prisma + SQLite.

### Data Flow (Chat)

```
User types message in browser
  → POST /chat/:sessionId/messages (or WS message)
  → API validates JWT, loads session
  → API creates Message(role: "user") in DB
  → API sends message to pi-agent-core Agent
  → Agent calls pi-ai stream()
  → API streams chunks via WebSocket
  → Dashboard renders markdown in real-time
  → On completion: save Message(role: "assistant") in DB
  → If tool calls: stream tool execution events via WS
```

## MVP Scope (v0.1)

### Included
| Feature | Priority |
|---------|----------|
| Auth (register/login via email+password, JWT) | P0 |
| Chat (web UI, streaming responses) | P0 |
| Sessions (persistent, history, resume) | P0 |
| Model Hub (model/provider selection from pi-ai registry) | P0 |
| API Keys (manage LLM provider keys in UI) | P0 |
| Agent Tools (bash, read, edit, write, grep, find) | P0 |
| WebSocket (real-time streaming, progress, tool execution) | P0 |

### Not Included (future versions)
- Multi-tenant billing → v0.2
- Extension marketplace → v0.2
- Agent orchestration → v0.2
- Team/organization → v0.3
- Mobile app → v0.3+
- CI/CD integration → v0.3

## Key Packages

### packages/api (Hono)
REST API server + WebSocket for streaming.

| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/register | Register user |
| POST | /auth/login | Login, return JWT |
| GET | /sessions | List user sessions |
| POST | /sessions | Create session |
| GET | /sessions/:id | Get session with messages |
| DELETE | /sessions/:id | Delete session |
| WS | /ws/chat/:sessionId | WebSocket for streaming |
| GET | /models | Available models |
| GET | /api-keys | User's API keys (masked) |
| POST | /api-keys | Add API key |
| DELETE | /api-keys/:id | Remove API key |

### packages/db (Prisma + SQLite)
Database schema and client. Core tables: `User`, `Session`, `Message`, `ApiKey`.

- **User:** id, email, password (bcrypt), name, createdAt → has many sessions and API keys
- **Session:** id, userId, title, model, createdAt, updatedAt → has many messages
- **Message:** id, sessionId, role (user/assistant/tool), content, toolCalls (Json?), createdAt
- **ApiKey:** id, userId, provider (openai/anthropic/…), key (encrypted at rest), label, createdAt

### packages/dashboard (Lit + Vite)
Web UI built on pi-web-ui components. Key components:
- `app.ts` — Root shell (sidebar + main)
- `sidebar.ts` — Navigation, session list
- `chat-panel.ts` — Chat messages + input
- `message.ts` — Single message (user/assistant/tool)
- `settings.ts` — Settings panel (models, API keys)
- `login.ts` — Auth form

### packages/ai (pi-ai)
LLM abstraction layer — unchanged from pi-mono. Provides `stream()`, `complete()`, 20+ providers.

### packages/agent (pi-agent-core)
Agent runtime — unchanged from pi-mono. Provides Agent, `agentLoop()`, tools, streaming.

### packages/tui (kept from pi-mono)
TUI library — kept for CLI mode.

### packages/web-ui (from pi-mono, modified)
Used as component library for the dashboard.

### packages/coding-agent (from pi-mono, modified)
Extract reusable parts, adapt for multi-user.

## Migration from pi-mono

### Remove
- `packages/mom/` — Slack bot (not relevant)
- `packages/pods/` — vLLM management (not relevant)

### Keep (core libraries)
- `packages/ai/`, `packages/agent/`, `packages/tui/`

### Modify
- `packages/coding-agent/`, `packages/web-ui/`

### Add
- `packages/api/`, `packages/db/`, `packages/dashboard/`

## Implementation Phases

| Phase | Days | Focus |
|-------|------|-------|
| 1. Foundation | 1–2 | Create api/db/dashboard packages, Prisma schema, Hono + /auth, JWT middleware |
| 2. Agent Integration | 3–4 | pi-agent-core integration, pi-ai provider setup, chat endpoint, save messages |
| 3. WebSocket Streaming | 5–6 | WS endpoint, real-time agent streaming, tool execution events |
| 4. Dashboard | 7–9 | Lit shell, session list, chat panel, login, settings |
| 5. Polish | 10 | Error handling, loading states, mobile responsiveness, rate limiting |

## Git Workflow
- **Main branches:** master (production), develop (integration)
- **Branch prefix:** FNA/
- **Feature branches:** FNA/<feature-name>
- **Bugfix branches:** FNA/fix/<description>
- **Hotfix branches:** FNA/hotfix/<description>

## Conventions
- **Monorepo tooling:** npm workspaces (consistent with pi-mono)
- **Build system:** tsup — fast, ESM/CJS, declaration files
- **Auth approach:** Stateless JWT in httpOnly cookies; passwords hashed with `Bun.passwordHash`
- **DB approach:** SQLite for zero-config; Prisma schema upgradeable to Postgres later
- **Agent isolation:** Each user gets an isolated Agent instance per session (multi-user safety)
- **API key security:** Keys encrypted at rest in DB, loaded into memory on demand, never logged
- **WebSocket resilience:** Client auto-reconnects with last message ID on disconnect
- **Context management:** Use pi compaction algorithm to handle large sessions and avoid context overflow
- **Dependency management:** Pin to specific pi-mono version; cherry-pick updates to avoid breaking changes
