# Спецификация: Filin Agent Next (FAN) — Local Runtime Agent

## Метаданные
- **Дата**: 2026-04-10
- **Автор**: Specification Generator
- **Статус**: В реализации (Phase 1-2 завершены)
- **Версия**: 1.0
- **Тип**: Модификация (pivot from web SaaS to local runtime-agent)

## 1. Обзор

### 1.1 Цель
Filin Agent Next (FAN) — локальный AI runtime-agent для разработчиков. Запускается на машине пользователя, предоставляет внешний API для подключения различных UI-клиентов (TUI, WebView, IDEA plugin и т.д.). Основан на fan-coding-agent в ядре, расширен кастомным оркестратором, extensions и skills.

### 1.2 Контекст
Текущая MVP-SPEC описывает web SaaS платформу. Данная спецификация пересматривает архитектуру в сторону local-first runtime-агента, который:
- Работает локально на машине пользователя
- Не требует серверной инфраструктуры
- Предоставляет API для множества UI клиентов
- Включает кастомный оркестратор как fan extension
- Имеет тонкие настройки моделей (локальные + облачные)
- Сохраняет все текущие extensions и skills

### 1.3 Ключевые отличия от текущей спеки

| Аспект | Было (MVP-SPEC) | Стало (Runtime Agent) |
|--------|------------------|-----------------------|
| Доступ | Multi-user web SaaS | Локальный runtime, single-user |
| API | Hono REST + WebSocket | Hybrid: stdio + HTTP REST + WebSocket |
| Auth | JWT + bcrypt | API key/token для клиентов |
| Dashboard | Единственный UI | Один из UI клиентов |
| Deployment | Web server | CLI бинарник + optional desktop wrapper |
| Orchestrator | Не было | fan extension (coordinator) |
| Models | Model Hub (UI выбор) | Fine-tuned: routing, fallback, budgets |
| DB | Prisma (users, sessions, messages, api_keys) | Prisma (sessions, messages, model_settings, budgets) |

## 2. Архитектура

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     UI Клиенты                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ TUI      │  │ WebView  │  │ IDEA     │  │ Dashboard│   │
│  │ (fan-tui) │  │ (Embed)  │  │ Plugin   │  │ (Lit)    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
└───────┼──────────────┼──────────────┼──────────────┼────────┘
        │ stdio        │ HTTP        │ stdio        │ HTTP
        │              │ REST+WS     │              │ REST+WS
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
│  │  │ Agent Loop   │  │ JSONL        │  │ Mgr        │  │  │
│  │  │ Compaction   │  │ Tree Branch  │  │            │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │ ModelReg.    │  │ Extension    │  │ Tool       │  │  │
│  │  │ 2000+ models │  │ Runner       │  │ Manager    │  │  │
│  │  │ Custom       │  │ Hot-reload   │  │ read/write │  │  │
│  │  └──────────────┘  └──────────────┘  │ bash/edit  │  │  │
│  │                                        └────────────┘  │  │
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

### 2.2 Пакеты

```
packages/
├── ai/              # fan-ai (unchanged from fan-mono)
├── agent/           # fan-agent-core (unchanged)
├── tui/             # fan-tui (kept from fan-mono)
├── web-ui/          # fan-web-ui components (kept, used by dashboard client)
├── coding-agent/    # fan-coding-agent (modified: add FAN extensions)
├── orchestrator/    # NEW: Coordinator extension + subagent management
├── model-manager/   # NEW: Provider routing, fallback chains, budget tracking
├── api-gateway/     # NEW: Client API — stdio RPC + HTTP REST + WebSocket
├── db/              # MODIFIED: Prisma schema (no auth, add model_settings, budgets)
└── dashboard/       # MODIFIED: Lit UI as client (connects via FAN API)
```

### 2.3 Deployment Modes

| Mode | Invocation | Description |
|------|-----------|-------------|
| TUI (default) | `fna` | Interactive terminal mode with fan-tui |
| Print | `fna -p "..."` | Single-shot, then exit |
| RPC | `fna --mode rpc` | JSON-over-stdio for IDE plugins |
| Server | `fna --mode server` | HTTP REST + WebSocket on configurable port |
| SDK | `import { createFnaSession }` | Programmatic use as library |
| Desktop | Electron/Tauri wrapper | Windowed app with embedded runtime |

## 3. Функциональные требования

### 3.1 Основные функции

- **Agent Runtime**: Полноценный AI-агент на базе fan-coding-agent с tools (read, write, edit, bash, grep, find, ls)
- **Orchestrator Extension**: Координация subagents, task management, coordinator mode (как у fan, но расширенный)
- **Multi-Client API**: Стdio RPC для локальных клиентов, HTTP REST+WS для удалённых
- **Model Management**: 
  - Per-task provider routing (быстрая задача → локальная модель, сложная → Claude/GPT)
  - Fallback chains (локальная → облачная при неуспехе)
  - Budget tracking (лимиты по токенам/стоимости, ежедневные/месячные бюджеты)
  - Per-model настройки (temperature, thinking level, max tokens, etc.)
- **Session Persistence**: JSONL сессии fan (tree branching) + Prisma metadata
- **Extensions & Skills**: Все текущие extensions/skills из ~/.fan/agent/, поддержка fan packages
- **Dashboard Client**: Lit-based web UI как один из клиентов (подключается через FAN API)
- **No Auth**: Локальный runtime, single-user. API key/token для клиентских подключений.

### 3.2 Model Management Detail

#### Provider Router
- Правила маршрутизации: task type → model/provider
- Presets: "coding" (Claude), "quick" (local), "analysis" (GPT-4), "chat" (Gemini)
- Custom rules через settings.json

#### Fallback Chains
- Конфигурируемая цепочка: primary → fallback1 → fallback2 → ...
- Автоматический retry при ошибках провайдера
- Rate limit handling с backoff

#### Budget Tracker
- Daily/monthly token limits per provider
- Cost tracking (actual vs budget)
- Alerts при приближении к лимиту
- Auto-switch на более дешёвую модель при превышении

### 3.3 Client API

#### stdio RPC Protocol
JSON-over-stdio, совместимый с pi --mode rpc:
- prompt, steer, followUp, subscribe events
- Дополнительные команды: list sessions, model routing rules, budget status

#### HTTP REST Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/sessions | Create session |
| GET | /api/sessions | List sessions |
| GET | /api/sessions/:id | Get session with messages |
| DELETE | /api/sessions/:id | Delete session |
| POST | /api/sessions/:id/messages | Send message |
| WS | /api/ws/:sessionId | WebSocket streaming |
| GET | /api/models | Available models + routing rules |
| GET | /api/models/settings | Model settings (temperature, thinking, etc.) |
| PUT | /api/models/settings | Update model settings |
| GET | /api/budget | Budget status (usage, limits) |
| PUT | /api/budget | Update budget limits |
| GET | /api/health | Health check |

#### WebSocket Events
- Streaming text deltas, tool execution start/end, agent start/end
- Compatible with fan agent event types + FAN-specific (budget alerts, model switches)

## 4. Database Schema (Adapted Prisma)

### 4.1 Изменения относительно текущей спеки
- ❌ Удалено: User model, auth-related fields
- ✅ Сохранено: Session, Message (адаптировано)
- ➕ Добавлено: ModelSetting, Budget, ClientToken

```prisma
model Session {
  id        String    @id @default(cuid())
  title     String    @default("New Session")
  model     String?   // model identifier used
  provider  String?   // provider used
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
  model     String?  // actual model used (may differ from session)
  tokens    Int?     // tokens consumed
  cost      Float?   // cost in USD
  createdAt DateTime @default(now())
}

model ModelSetting {
  id          String   @id @default(cuid())
  provider    String   // "anthropic", "openai", "ollama", etc.
  model       String   // model identifier
  temperature Float?   @default(0.7)
  maxTokens   Int?
  thinking    String?  // "off" | "minimal" | "low" | "medium" | "high"
  isDefault   Boolean  @default(false)
  priority    Int?     @default(0) // for routing priority
  updatedAt   DateTime @updatedAt
}

model RoutingRule {
  id        String   @id @default(cuid())
  name      String   // "coding", "quick", "analysis", etc.
  provider  String
  model     String
  fallback  String?  // fallback model id
  enabled   Boolean  @default(true)
}

model Budget {
  id           String   @id @default(cuid())
  provider     String?
  period       String   // "daily" | "monthly"
  tokenLimit   Int?
  costLimit    Float?
  tokensUsed   Int      @default(0)
  costUsed     Float    @default(0)
  resetAt      DateTime
  createdAt    DateTime @default(now())
}

model ClientToken {
  id        String   @id @default(cuid())
  name      String   // "IDEA Plugin", "WebView", etc.
  token     String   @unique
  createdAt DateTime @default(now())
  lastUsed  DateTime?
}
```

## 5. Технические требования

### 5.1 Стек технологий
- **Runtime:** Bun
- **Core:** fan-ai, fan-agent-core, fan-coding-agent, fan-tui (from fan-mono)
- **Monorepo:** npm workspaces
- **API:** HTTP (Hono) + stdio RPC + WebSocket
- **Database:** Prisma + SQLite
- **Dashboard Client:** Lit + Vite (fan-web-ui components)
- **Build:** tsup
- **Language:** TypeScript (strict)

### 5.2 Существующие packages из fan-mono (keep unchanged)
- `packages/ai/` — LLM abstraction
- `packages/agent/` — Agent runtime
- `packages/tui/` — Terminal UI

### 5.3 Существующие packages (modify)
- `packages/coding-agent/` — integrate FAN orchestrator extension, model manager
- `packages/web-ui/` — adapt as client component library for dashboard
- `packages/db/` — new Prisma schema (see §4)

### 5.4 Новые packages
- `packages/orchestrator/` — coordinator extension, subagent spawning, task management
- `packages/model-manager/` — provider routing, fallback chains, budget tracking
- `packages/api-gateway/` — client API: stdio RPC + HTTP REST + WebSocket
- `packages/dashboard/` — Lit-based UI client (connects via FAN API)

## 6. Сравнительный анализ: fan modes vs FAN

| Аспект | fan --mode interactive | fan --mode rpc | FAN TUI | FAN Server |
|--------|-----------------------|---------------|---------|------------|
| UI | fan-tui (built-in) | None (external) | fan-tui + extensions | Any HTTP client |
| API | None | stdio RPC | stdio RPC + HTTP | HTTP REST+WS |
| Model routing | Manual in settings | Manual | Automatic (rules) | Automatic (rules) |
| Budget | None | None | Tracked + alerts | Tracked + alerts |
| Fallback | None | None | Configurable chains | Configurable chains |
| Orchestrator | Manual | Manual | Built-in extension | Built-in extension |
| Multi-client | No | 1 client | Multiple | Multiple |

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| fan-coding-agent API changes | Средняя | Высокое | Pin to specific version, cherry-pick updates |
| Model routing complexity | Средняя | Среднее | Start with simple presets, iterate |
| HTTP API backward compatibility | Низкая | Среднее | Versioned API (/api/v1/), deprecation policy |
| Budget tracking accuracy | Низкая | Низкое | Cross-check with provider usage APIs |
| stdio/HTTP protocol drift | Низкая | Среднее | Shared types package, auto-generated clients |
| Desktop wrapper (Electron/Tauri) overhead | Средняя | Низкое | Desktop wrapper is optional, not MVP |

## 8. Компромиссы (Tradeoffs)

### 8.1 Принятые решения
- **Решение**: Local runtime вместо web SaaS
- **Альтернатива**: Web SaaS с multi-user (текущая спека)
- **Обоснование**: Локальный runtime проще в деплое, не требует серверной инфраструктуры, пользователь владеет данными. Мульти-клиент API даёт тот же UX через разные UI.

- **Решение**: Orchestrator как fan extension, а не кастомный runtime
- **Альтернатива**: Полностью кастомный runtime поверх fan-agent-core
- **Обоснование**: Extensions = hot-reload, совместимость с fan ecosystem, меньше кода. fan extension API достаточно мощный для координации.

- **Решение**: Hybrid stdio + HTTP API
- **Альтернатива**: Только HTTP или только stdio
- **Обоснование**: stdio для локальных клиентов (нулевая latency, простота), HTTP для удалённых и cross-platform клиентов.

- **Решение**: Без auth
- **Альтернатива**: Полная auth система (JWT, multi-user)
- **Обоснование**: Локальный runtime = single-user. API key для клиентских подключений достаточно.

## 9. Приоритеты

### Must Have (P0)
- fan-coding-agent core integration
- TUI mode (interactive)
- Agent tools (read, write, edit, bash, grep, find, ls)
- Session persistence (JSONL)
- Orchestrator extension (coordinator mode, subagent spawning)
- All current extensions/skills loaded
- Model provider routing (presets + custom rules)

### Should Have (P1)
- HTTP REST + WebSocket server mode
- Dashboard client (Lit)
- Fallback chains
- Budget tracking
- API key for client connections

### Could Have (P2)
- Desktop wrapper (Electron/Tauri)
- IDEA plugin
- Mobile client
- Advanced budget analytics
- Model cost comparison dashboard

### Won't Have (MVP)
- Multi-user auth
- Web SaaS deployment
- Extension marketplace
- CI/CD integration

## 10. Implementation Phases

### Phase 1: Foundation (Day 1-3)
- [x] Fork fan-mono, set up monorepo structure
- [x] Remove packages/mom, packages/pods
- [x] Create packages/orchestrator skeleton
- [x] Create packages/model-manager skeleton
- [x] Integrate all current extensions/skills
- [x] Prisma schema (sessions, messages, model_settings, budgets)
- [x] TUI mode works with fan-coding-agent

### Phase 2: Model Management (Day 4-5)
- [x] Provider router implementation (presets + custom rules)
- [x] Fallback chain logic
- [x] Budget tracker (tracking + alerts)
- [x] Per-model settings UI (in TUI)
- [x] Integration with ModelRegistry and AuthStorage

### Phase 3: Client API (Day 6-8)
- [ ] stdio RPC mode (extend fan --mode rpc with FAN commands)
- [ ] HTTP server mode (Hono REST + WebSocket)
- [ ] API key generation for client connections
- [ ] Event streaming (agent events + FAN-specific events)
- [ ] Shared types package for API consumers

### Phase 4: Orchestrator (Day 9-11)
- [ ] Coordinator extension (task decomposition, delegation)
- [ ] Subagent spawning (explore, plan, implement, verify workers)
- [ ] Task tracking and status management
- [ ] Integration with session tree branching

### Phase 5: Dashboard Client (Day 12-14)
- [ ] Lit-based dashboard (chat, sessions, settings)
- [ ] Connection to FAN API (HTTP)
- [ ] Model settings UI
- [ ] Budget visualization
- [ ] Session management UI

### Phase 6: Polish & Packaging (Day 15-16)
- [ ] CLI binary packaging (`fna` command)
- [ ] Settings management (global + project)
- [ ] Error handling and resilience
- [ ] Documentation
- [ ] Optional: desktop wrapper prototype

## 11. Следующие шаги

- [x] Review and approve this specification
- [x] Update CLAUDE.md with new project type (local runtime-agent)
- [x] Update ARCHITECTURE.md with new architecture
- [x] Archive or update MVP-SPEC.md (mark as superseded)
- [x] Start Phase 1 implementation

---

*Создано: research-spec-generator skill*
*Исходный запрос: Локальный runtime-agent на базе fan с оркестратором, extensions/skills, мульти-клиент API и тонкими настройками моделей*
