# ARCHITECTURE.md — Filin Next Agent (FNA)

> Comprehensive architecture reference. For quick context → [CLAUDE.md](./CLAUDE.md)

---

## Project Overview

- **Name:** Filin Next Agent (FNA)
- **Type:** AI Agent web platform for developers
- **Description:** Web interface for chatting with AI agents, managing models, extensions, and skills. Multi-user, persistent sessions, billing-ready.
- **Base:** Fork of badlogic/pi-mono → Aristman/pi-mono
- **MVP Status:** Planning (v0.1)

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun | Fast JS runtime |
| Monorepo | npm workspaces | Consistent with pi-mono |
| API | Hono (REST + WebSocket) | Lightweight, fast |
| Database | Prisma + SQLite | Zero-config, upgradeable to Postgres |
| Auth | JWT (httpOnly cookie) + bcrypt | via `Bun.passwordHash` |
| Dashboard | Lit + Vite | Web components, fast HMR |
| Build | tsup | ESM/CJS, declaration files |
| Language | TypeScript (strict) | — |
| Streaming | SSE over WebSocket | Compatible with pi-ai EventStream |
| File serving | Vite in dev, Hono static in prod | — |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Lit)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Chat     │  │ Sessions │  │ Settings │              │
│  │ Panel    │  │ List     │  │ (Models, │              │
│  │          │  │          │  │  API Keys│              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
└───────┼──────────────┼──────────────┼────────────────────┘
        │ REST + WS    │              │
┌───────┼──────────────┼──────────────┼────────────────────┐
│       ▼              ▼              ▼                     │
│  ┌─────────────────────────────────────────────────┐    │
│  │           packages/api (Hono)                    │    │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │    │
│  │  │ /auth    │  │ /chat    │  │ /models       │  │    │
│  │  │ /sessions│  │ /ws      │  │ /api-keys     │  │    │
│  │  └──────────┘  └──────────┘  └───────────────┘  │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │                                 │
│  ┌────────────────────┼────────────────────────────┐    │
│  │           packages/db (Prisma + SQLite)          │    │
│  │  users, sessions, messages, api_keys, models     │    │
│  └──────────────────────────────────────────────────┘    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐    │
│  │           pi-ai (LLM abstraction)                │    │
│  │  stream(), complete(), 20+ providers              │    │
│  └──────────────────────────────────────────────────┘    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐    │
│  │           pi-agent-core (Agent loop)             │    │
│  │  Agent, agentLoop(), tools, streaming            │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

**Architecture summary:** Monorepo with `packages/` directory. The API server (Hono) serves the Dashboard (Lit) frontend. Agent logic is powered by pi-ai (LLM abstraction with 20+ providers) and pi-agent-core (agent loop). Data is persisted via Prisma + SQLite.

---

## Packages

### packages/api (Hono)

REST API server + WebSocket for streaming.

```
packages/api/
├── src/
│   ├── index.ts              # Hono app entry
│   ├── routes/
│   │   ├── auth.ts           # POST /auth/register, /auth/login
│   │   ├── sessions.ts       # GET/POST/DELETE /sessions
│   │   ├── chat.ts           # POST /chat/:sessionId/messages
│   │   ├── models.ts         # GET /models, /models/:id
│   │   └── api-keys.ts       # GET/POST/DELETE /api-keys
│   ├── ws/
│   │   └── chat.ts           # WebSocket handler for streaming
│   ├── middleware/
│   │   ├── auth.ts           # JWT validation
│   │   └── error.ts          # Error handler
│   ├── services/
│   │   ├── agent.ts          # Agent session management
│   │   ├── session.ts        # Session CRUD + persistence
│   │   └── model.ts          # Model resolution
│   └── utils/
│       └── jwt.ts            # JWT sign/verify
├── package.json
└── tsconfig.json
```

### packages/db (Prisma + SQLite)

Database schema and client.

```
packages/db/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── client.ts             # PrismaClient singleton
│   └── index.ts              # Re-exports
├── package.json
└── tsconfig.json
```

### packages/dashboard (Lit + Vite)

Web UI built on pi-web-ui components.

```
packages/dashboard/
├── src/
│   ├── index.ts              # Entry point, mount
│   ├── components/
│   │   ├── app.ts            # Root shell (sidebar + main)
│   │   ├── sidebar.ts        # Navigation, session list
│   │   ├── chat-panel.ts     # Chat messages + input
│   │   ├── message.ts        # Single message (user/assistant/tool)
│   │   ├── settings.ts       # Settings panel (models, API keys)
│   │   └── login.ts          # Auth form
│   ├── services/
│   │   ├── api.ts            # REST client
│   │   └── ws.ts             # WebSocket client
│   └── styles/
│       └── theme.ts          # CSS custom properties
├── index.html
├── vite.config.ts
├── package.json
└── tsconfig.json
```

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

---

## API Endpoints

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

---

## Database Schema

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  password  String   // bcrypt hash
  name      String?
  createdAt DateTime @default(now())
  sessions  Session[]
  apiKeys   ApiKey[]
}

model Session {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  title     String    @default("New Chat")
  model     String    // model identifier
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
  toolCalls Json?    // tool call metadata
  createdAt DateTime @default(now())
}

model ApiKey {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  provider  String   // "openai", "anthropic", etc.
  key       String   // encrypted at rest
  label     String?
  createdAt DateTime @default(now())
}
```

**Relationships:**
- User → has many Sessions and ApiKeys
- Session → belongs to User, has many Messages
- Message → belongs to Session

---

## Data Flow

### Chat Message Flow

```
User types message in browser
  → POST /chat/:sessionId/messages  (or WS message)
  → API validates JWT, loads session
  → API creates Message(role: "user") in DB
  → API sends message to pi-agent-core Agent
  → Agent calls pi-ai stream()
  → API streams chunks via WebSocket
  → Dashboard renders markdown in real-time
  → On completion: save Message(role: "assistant") in DB
  → If tool calls: stream tool execution events via WS
```

### Session Lifecycle

```
User opens dashboard
  → GET /sessions → list
  → Click session → GET /sessions/:id → load messages
  → Type message → chat flow (above)
  → New session → POST /sessions → redirect
```

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Auth** | JWT (httpOnly cookie) | Simple, stateless, works with Hono |
| **Password** | bcrypt via Bun.passwordHash | Built-in to Bun, fast |
| **DB** | SQLite via Prisma | Zero-config, file-based, upgradeable to Postgres |
| **WS** | Hono + @hono/websocket | Native, no extra deps |
| **Streaming** | SSE over WebSocket | Simpler than raw WS, pi-ai EventStream compatible |
| **File serving** | Vite dev → Hono static in prod | Dev DX + production ready |
| **Monorepo** | npm workspaces (existing) | Same tooling as pi-mono |
| **Build** | tsup (consistent with pi-mono) | Fast, esm/cjs, dts |

---

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

| Feature | Target Version |
|---------|---------------|
| Multi-tenant billing | v0.2 |
| Extension marketplace | v0.2 |
| Agent orchestration | v0.2 |
| Team/organization | v0.3 |
| Mobile app | v0.3+ |
| CI/CD integration | v0.3 |

---

## Implementation Phases

| Phase | Days | Focus | Tasks |
|-------|------|-------|-------|
| 1. Foundation | 1–2 | Core packages + auth | Create api/db/dashboard packages, Prisma schema, Hono + /auth, JWT middleware |
| 2. Agent Integration | 3–4 | Agent + chat endpoint | pi-agent-core integration, pi-ai provider setup, chat endpoint, save messages |
| 3. WebSocket Streaming | 5–6 | Real-time streaming | WS endpoint, real-time agent streaming, tool execution events |
| 4. Dashboard | 7–9 | Web UI | Lit shell, session list, chat panel, login, settings |
| 5. Polish | 10 | Quality | Error handling, loading states, mobile responsiveness, rate limiting |

---

## Migration from pi-mono

### Remove
- `packages/mom/` — Slack bot (not relevant)
- `packages/pods/` — vLLM management (not relevant)

### Keep (core libraries)
- `packages/ai/` — LLM abstraction (unchanged)
- `packages/agent/` — Agent runtime (unchanged)
- `packages/tui/` — TUI library (keep for CLI mode)

### Modify
- `packages/coding-agent/` — extract reusable parts, adapt for multi-user
- `packages/web-ui/` — use as component library for dashboard

### Add
- `packages/api/` — Hono API server
- `packages/db/` — Prisma + SQLite
- `packages/dashboard/` — Filin web UI

---

## Conventions

| Area | Convention |
|------|-----------|
| **Monorepo tooling** | npm workspaces (consistent with pi-mono) |
| **Build system** | tsup — fast, ESM/CJS, declaration files |
| **Auth approach** | Stateless JWT in httpOnly cookies; passwords hashed with `Bun.passwordHash` |
| **DB approach** | SQLite for zero-config; Prisma schema upgradeable to Postgres later |
| **Agent isolation** | Each user gets an isolated Agent instance per session (multi-user safety) |
| **API key security** | Keys encrypted at rest in DB, loaded into memory on demand, never logged |
| **WebSocket resilience** | Client auto-reconnects with last message ID on disconnect |
| **Context management** | Use pi compaction algorithm to handle large sessions and avoid context overflow |
| **Dependency management** | Pin to specific pi-mono version; cherry-pick updates to avoid breaking changes |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| pi-agent-core not designed for multi-user | Each user gets isolated Agent instance per session |
| pi-ai API keys in memory | Load from encrypted DB, never log |
| WebSocket reconnection | Client auto-reconnect with last message ID |
| Large sessions (context overflow) | Leverage pi compaction algorithm |
| pi-mono breaking changes | Pin to specific version, cherry-pick updates |
