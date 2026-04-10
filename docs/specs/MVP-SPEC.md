> ⚠️ **SUPERSEDED** — This specification has been replaced by [spec_runtime-agent_2026-04-10.md](./spec_runtime-agent_2026-04-10.md).
> The project has pivoted from a web SaaS platform to a local runtime-agent architecture.
> Archived for reference only.

---

# Filin Agent Next — MVP Specification

**Дата:** 2026-04-10
**Статус:** Planning
**База:** Форк itone/fan-mono → Aristman/fan-mono

---

## Vision

AI Agent Platform для разработчиков. Web-интерфейс для чата с AI-агентами, управления моделями, extensions и skills. Multi-user, persistent sessions, billing-ready.

## MVP Scope (v0.1)

### Что включаем

| Фича | Описание | Приоритет |
|------|----------|-----------|
| **Auth** | Регистрация/логин через email+password, JWT | P0 |
| **Chat** | Web-интерфейс: чат с AI-агентом, streaming ответы | P0 |
| **Sessions** | Persistent сессии, история, resume | P0 |
| **Model Hub** | Выбор модели/провайдера для чата (из pi-ai registry) | P0 |
| **API Keys** | Управление API-ключами LLM-провайдеров в UI | P0 |
| **Agent Tools** | bash, read, edit, write, grep, find (из fan-coding-agent) | P0 |
| **WebSocket** | Real-time streaming ответов, progress, tool execution | P0 |

### Что НЕ включаем в MVP

| Фича | Почему | Когда |
|------|--------|-------|
| Multi-tenant billing | Сложно, не нужно для личного использования | v0.2 |
| Extension marketplace | Нужна критическая масса extensions | v0.2 |
| Agent orchestration | Уже есть как extension, переносим позже | v0.2 |
| Team/organization | Multi-user достаточно для MVP | v0.3 |
| Mobile app | Web-first | v0.3+ |
| CI/CD integration | Webhook endpoints | v0.3 |

---

## Architecture

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

## Packages

### packages/api (Hono)

API server. REST endpoints + WebSocket for streaming.

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

**Endpoints:**

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

### packages/db (Prisma)

Database schema + client.

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

**Schema (Core tables):**

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

### packages/dashboard (Lit)

Web UI. На базе pi-web-ui components.

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
| **Monorepo** | npm workspaces (existing) | Same tooling as fan-mono |
| **Build** | tsup (consistent with fan-mono) | Fast, esm/cjs, dts |

---

## Implementation Order

### Phase 1: Foundation (Day 1-2)
- [ ] Create packages/api, packages/db, packages/dashboard
- [ ] Prisma schema + SQLite setup
- [ ] Hono server with /auth (register/login)
- [ ] JWT middleware

### Phase 2: Agent Integration (Day 3-4)
- [ ] pi-agent-core integration in packages/api
- [ ] pi-ai provider setup with user's API keys
- [ ] POST /chat/:sessionId/messages (non-streaming first)
- [ ] Save messages to DB

### Phase 3: WebSocket Streaming (Day 5-6)
- [ ] WebSocket endpoint /ws/chat/:sessionId
- [ ] Stream agent responses in real-time
- [ ] Tool execution events streaming

### Phase 4: Dashboard (Day 7-9)
- [ ] Lit shell (sidebar + main layout)
- [ ] Session list component
- [ ] Chat panel with message rendering
- [ ] Login page
- [ ] Settings page (API keys, model selection)

### Phase 5: Polish (Day 10)
- [ ] Error handling everywhere
- [ ] Loading states
- [ ] Mobile responsiveness
- [ ] Basic rate limiting

---

## Migration from fan-mono

### Remove (not needed for SaaS)
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

## Risks

| Risk | Mitigation |
|------|-----------|
| pi-agent-core not designed for multi-user | Each user gets isolated Agent instance per session |
| pi-ai API keys in memory | Load from encrypted DB, never log |
| WebSocket reconnection | Client auto-reconnect with last message ID |
| Large sessions (context overflow) | Leverage pi compaction algorithm |
| fan-mono breaking changes | Pin to specific version, cherry-pick updates |
