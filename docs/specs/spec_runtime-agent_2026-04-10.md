# Спецификация: Fast Agents Network (FAN) — Local Runtime Agent

## Метаданные
- **Дата**: 2026-04-10
- **Автор**: Specification Generator
- **Статус**: Phase 1-7 завершены ✅
- **Версия**: 1.0
- **Тип**: Модификация (pivot from web SaaS to local runtime-agent)

## 1. Обзор

### 1.1 Цель
Fast Agents Network (FAN) — локальный AI runtime-agent для разработчиков. Запускается на машине пользователя, предоставляет внешний API для подключения различных UI-клиентов (TUI, WebView, IDEA plugin и т.д.). Основан на fan-coding-agent в ядре, расширен кастомным оркестратором, extensions и skills.

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
├── ai/              # fan-ai (unchanged from fan)
├── agent/           # fan-agent-core (unchanged)
├── tui/             # fan-tui (kept from fan)
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
| TUI (default) | `fan` | Interactive terminal mode with fan-tui |
| Print | `fan -p "..."` | Single-shot, then exit |
| RPC | `fan --mode rpc` | JSON-over-stdio for IDE plugins |
| Server | `fan --mode server` | HTTP REST + WebSocket on configurable port |
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
- **Core:** fan-ai, fan-agent-core, fan-coding-agent, fan-tui (from fan)
- **Monorepo:** npm workspaces
- **API:** HTTP (Hono) + stdio RPC + WebSocket
- **Database:** Prisma + SQLite
- **Dashboard Client:** Lit + Vite (fan-web-ui components)
- **Build:** tsup
- **Language:** TypeScript (strict)

### 5.2 Существующие packages из fan (keep unchanged)
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
- [x] Fork fan, set up monorepo structure
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
- [x] stdio RPC mode (extend fan --mode rpc with FAN commands)
- [x] HTTP server mode (Hono REST + WebSocket)
- [x] API key generation for client connections
- [x] Event streaming (agent events + FAN-specific events)
- [x] Shared types package for API consumers

#### Phase 3 Results
- **Package:** `packages/api-gateway/` (5 source files, 3 test files)
- **HTTP Server:** Hono REST + WebSocket on configurable port (default: 3456)
- **Endpoints:** 14 REST routes (health, sessions CRUD, messages, models, budget, tokens)
- **WebSocket:** `/api/ws/:sessionId` with multi-client broadcast and token auth
- **Auth:** Bearer token via `Authorization` header or `?token=` query param, `FAN_NO_AUTH` for dev
- **RPC Extensions:** 6 new commands (get_routing_rules, get_budget_status, get_model_settings, generate_token, list_tokens, revoke_token)
- **CLI:** `--mode server`, `--port`, `--host` flags added
- **Tests:** 39 tests (auth: 12, http-server: 24, ws-handler: 3) — all passing
- **Dependencies:** hono, @hono/node-server, ws, @fan/db, @fan/model-manager
- **Verified:** Real LLM requests to z.ai (GLM-5-Turbo) via print mode and server mode
- **Fixed bugs:** ZAI_AFAN_KEY → ZAI_API_KEY, Node.js request body parsing via @hono/node-server

### Phase 4: Orchestrator (Day 9-11)
- [x] Coordinator extension (task decomposition, delegation)
- [x] Subagent spawning (explore, plan, implement, verify workers)
- [x] Task tracking and status management
- [x] Integration with session tree branching

#### Phase 4 Results
- **Package:** `packages/orchestrator/` (8 source files, 3 test files, 4 agent .md, 3 prompt .md)
- **Core components:** types.ts, agents.ts, subagent-runner.ts, task-manager.ts, orchestrator-tools.ts, orchestrator-extension.ts
- **Tools:** delegate_task (single/parallel/chain), list_tasks, cancel_task, classify_task
- **Built-in workers (4):** explore, plan, implement, verify
- **Workflow prompts (3):** implement, plan-only, verify chains
- **Slash commands:** /orchestrator, /tasks, /agents, /delegate
- **Agent discovery:** builtin → user → project with priority override
- **Tests:** 29 tests (task-manager: 17, subagent-runner: 11, agents: 1) — all passing
- **Verification:** All 18 criteria passed (11 automated + 7 manual TUI)
- **Fixed bugs:** agent discovery path (dist→src), chain/parallel details shape mismatch
- **Dependencies:** @seaagents/fan-ai, @seaagents/fan-agent-core, @seaagents/fan-coding-agent, @seaagents/fan-tui, @sinclair/typebox

### Phase 5: Orchestrator Hardening (Day 12-16)

> Сравнительный анализ: `~/.pi/agent/extensions/orchestrator/` (Pi sample) vs `packages/orchestrator/` (FAN).
> Подробный документ: `docs/orchestrator-comparison.md`.
> Цель: довести FAN orchestrator до паритета с Pi sample, сохранив уникальные FAN-фичи (parallel, chain, agent discovery, usage tracking).

#### 5.1 Configuration & Infrastructure
- [x] Создать `src/config.ts` — загрузка из `config.json` с defaults
- [x] `OrchestratorConfig`: cloud/local/auto providerMode, model overrides, timeouts, maxRetries, dangerousCommands
- [x] `resolveModel()` — выбор модели по agentType + providerMode (интеграция с ModelManager из Phase 2)
- [x] `getCloudHealth()` / `getCloudStatus()` — health check с 5-минутным кэшем
- [x] Defaults: `parallelWorkers=3`, `workerTimeout=300s`, `planTimeout=300s`, `maxRetries=2`, `agentTimeouts` per type
- [x] Создать `src/workers.ts` — Worker Registry + Slot Pool
  - Registry: `genWorkerId`, `registerWorker`, `getWorker`, `listWorkers`, `activeWorkers`
  - Slot pool: `acquireSlot()` (Promise-based FIFO queue), `releaseSlot()`
  - Write slot: максимум 1 implement worker одновременно
  - `statusIcon()`, `statusColor()` helpers
- [x] Создать `src/permissions.ts` — `isDangerousCommand()` (8 regex patterns)
- [x] Handler для `tool_call` event → `ctx.ui.select("Block", "Allow")` для опасных команд

#### 5.2 Coordinator Mode
- [x] Флаг `coordinatorActive` в extension state
- [x] Shortcut `Alt+O` — toggle coordinator ON/OFF
- [x] Status bar update (`ctx.ui.setStatus`) при toggle и в `session_start`
- [x] Добавить `COORDINATOR_PROMPT` — system prompt для coordinator mode (адаптирован под FAN tool names: delegate_task вместо Agent)
- [x] Handler для `before_agent_start` event — inject COORDINATOR_PROMPT when coordinator active
- [x] Coordinator prompt запрещает прямое использование read/write/edit/bash и заставляет делегировать через `delegate_task`
- [x] Зарегистрировать LLM-callable `TaskCreate` tool (делегирует в TaskManager, параметры: subject, description, owner, blocks[])
- [x] Зарегистрировать LLM-callable `TaskUpdate` tool (status, subject, description, blocks[]; auto-unblock при complete)
- [x] Обновить `TaskManager` для поддержки поля `owner`

#### 5.3 /plan Command
- [x] Добавить `PLANNING_PROMPT` в agents.ts (адаптированный plan-agent prompt из Pi sample)
- [x] Регистрация `/plan <task description>` slash command
- [x] Spawn explore worker с PLANNING_PROMPT → генерация плана
- [x] `approveOrRevise()` — интерактивный UI select (✅ Approve / ✏️ Revise / ❌ Reject)
- [x] On Approve: auto-enable coordinator, inject approved plan в conversation через `pi.sendUserMessage`
- [x] On Revise: `ctx.ui.input()` для feedback → re-run с revision
- [x] Live progress widget во время планирования (статус, tool calls, elapsed time)
- [x] Timer в status bar пока worker работает

#### 5.4 Retry & Fallback
- [x] `runWorkerWithRetry()` — retry до `config.maxRetries` раз, не retry на AbortSignal
- [x] `runWorkerWithFallback()` — try cloud, fallback to local при providerMode="auto"
- [x] Проверка `getCloudStatus()` перед попыткой cloud
- [x] Интегрировать retry/fallback в `delegate_task` tool (single mode)

#### 5.5 Interactive Task Widget
- [x] `updateTaskWidget()` — collapsible checklist widget above editor (`ctx.ui.setWidget("orchestrator-tasks", ...)`)
- [x] Авто-скрытие виджета когда нет активных задач (все completed/failed)
- [x] Expanded state — иконки по статусу:
  - ◐ in_progress (warning, bold)
  - ⛔ blocked (dim)
  - ☐ pending (muted)
  - ✗ failed (error)
  - ☑ completed (success, strikethrough)
- [x] Сортировка: активные сверху → failed → completed внизу
- [x] Truncate длинных subject до 55 символов с ellipsis
- [x] Collapsed state — summary line: `📋 3/5 tasks [Alt+T to expand]`
- [x] Shortcut `Alt+T` — toggle collapse/expand
- [x] Update on `turn_end` event
- [x] Update на `TaskCreate`/`TaskUpdate` tool calls (queueMicrotask)

#### 5.6 Enhanced /orchestrator Command
- [x] `/orchestrator stop` — abort all active workers через registry
- [x] `/orchestrator config` — показать текущий конфиг (provider, models, timeouts, dangerous patterns count)
- [x] `/orchestrator mode cloud|local|auto` — переключить providerMode
- [x] `/orchestrator retry` — retry последнего failed worker
- [x] `/orchestrator status` — расширенный вывод: workers + tasks + queue + health

#### 5.7 Notifications & Verification
- [x] `formatTaskNotification()` — XML format (task-id, status, agent-type, model, summary, result, message_count, duration_ms)
- [x] Использовать notification в `delegate_task` result для coordinator parsing
- [x] `parseVerdict()` — извлечь `VERDICT: PASS|FAIL|PARTIAL` из verify worker output
- [x] Показать verdict в delegate_task result когда agentType="verify"
- [x] `SendMessage` tool — отправить follow-up message running worker (требует поддержки steer в subprocess)

#### 5.8 Session Lifecycle
- [x] `session_start`: восстановить status bar + task widget
- [x] `session_shutdown`: abort all active workers, clear widgets (orchestrator, orchestrator-tasks), clear status bar, reset coordinator flag
- [x] Хранить `lastCtx` reference для cleanup на shutdown

#### Phase 5 Критерии готовности
- [x] `config.json` загружается с fallback на defaults
- [x] `resolveModel()` корректно резолвит модель по agentType + mode
- [x] Worker registry корректно регистрирует/обновляет/списывает воркеров
- [x] Slot pool ограничивает параллельность, write slot = 1 implement max
- [x] Опасные команды блокируются с UI prompt
- [x] Alt+O включает/выключает coordinator mode, status bar обновляется
- [x] Coordinator prompt инжектится при `before_agent_start`, LLM делегирует через delegate_task
- [x] TaskCreate/TaskUpdate tools доступны LLM, корректно работают с TaskManager
- [x] `/plan` spawns explore worker, генерирует план, show approve/revise/reject UI
- [x] На approve coordinator auto-enabled, план инжектится в conversation
- [x] `runWorkerWithRetry` делает до N retries, не retry на abort
- [x] `runWorkerWithFallback` tries cloud → fallback local
- [x] Task widget отображается выше editor, автоскрытие без активных задач
- [x] Alt+T toggles collapse/expand
- [x] Widget обновляется на turn_end и на TaskCreate/TaskUpdate
- [x] `/orchestrator stop/config/mode/retry/status` работают корректно
- [x] `parseVerdict()` извлекает PASS/FAIL/PARTIAL, показывается в result
- [x] `session_shutdown` корректно чистит всё (workers, widgets, status)

### Phase 6: Dashboard Client (Day 17-19)
- [x] Lit-based dashboard (chat, sessions, settings)
- [x] Connection to FAN API (HTTP)
- [x] Model settings UI
- [x] Budget visualization
- [x] Session management UI

#### Phase 6 Results
- **Package:** `packages/dashboard/` (22 source files, 2 test files)
- **Core components:** dashboard-app, session-sidebar, chat-view, budget-panel, budget-alert-toast, model-settings-panel, settings-dialog, connection-setup
- **API client:** `FanApiClient` — 14 REST methods, typed with `@fan/api-gateway` types
- **WS client:** `FanWsClient` — auto-reconnect, 6 event types (connected, pong, agent_event, budget_alert, model_switch, error)
- **Chat features:** streaming responses, markdown rendering (unsafeHTML), thinking blocks (collapsible), tool calls (collapsible), auto-scroll, shift+enter
- **Session management:** create, delete, search, message count, sort by recency
- **Budget:** per-provider cards with progress bars (green <60%, yellow 60-85%, red >85%), 30s auto-refresh
- **Model settings:** per-model overrides (temperature, maxTokens, thinking), routing rules, available models
- **Settings dialog:** connection config, API token CRUD (generate, copy, revoke)
- **Theme:** Custom FAN theme (oklch hue 260°, light/dark), no shadow DOM for Tailwind compatibility
- **Architecture:** Thin frontend — disk (JSONL) = single source of truth, runtime = execution engine only
- **Server startup:** `SessionManager.continueRecent()` — opens last session, creates new only if empty
- **WS subscription:** adapter-level forwarding, resubscribes after `runtime.switchSession()`
- **Build:** Vite (separate from tsgo monorepo build), 3.4MB bundle (gzip 964KB)
- **Tests:** 23 unit tests (api-client: 14, ws-client: 9) + 39 api-gateway + 42 model-manager = 104 total
- **Manual testing:** 26/30 passed (4 skipped: budget alerts, responsive, prod build, model settings data)
- **Bugs fixed during testing:** 18 (icons, theme, token sanitization, WS streaming, scroll, race conditions, session routing, sidebar events, tokens/cost display)

### Phase 7: Polish & Packaging (Day 20-22)
- [x] CLI binary packaging (`fan` command)
- [x] Settings management (global + project)
- [x] Error handling and resilience
- [x] Documentation
- [x] Optional: desktop wrapper prototype

#### Phase 7 Results
- **CLI binary:** `fan` command, binary packaging via `scripts/build-binaries.sh`
- **Setup wizard:** `fan init` — interactive first-time configuration (API keys, model defaults, preferences)
- **Diagnostics:** `fan doctor` — environment and dependency health checks
- **Server command:** `fan server` — foreground server (full runtime), `fan server start/stop/status` — background daemon management for IDE plugins
- **Environment template:** `.env.example` with all required/optional variables documented
- **Installation guide:** `INSTALL.md` — Windows, Linux, macOS instructions
- **Contributing guide:** `CONTRIBUTING.md` — development workflow, branch strategy, commit conventions
- **Migration guide:** `MIGRATION.md` — upstream fan/pi migration instructions
- **Configuration guide:** `docs/guides/configuration.md` — settings reference (global + project)
- **Orchestrator guide:** `docs/guides/orchestrator.md` — coordinator mode, workers, workflows, commands
- **Dashboard guide:** `docs/guides/dashboard.md` — WebUI features, settings, budget visualization
- **API reference:** `docs/guides/api-reference.md` — REST + WebSocket endpoints, auth, events
- **Updated core docs:** README.md, SETUP.md, CLAUDE.md, ARCHITECTURE.md — all reflect FAN branding and Phase 1-7 deliverables
- **Build scripts:** `scripts/build-binaries.sh` updated for FAN branding and `fan` binary name

## 11. Следующие шаги

- [x] Review and approve this specification
- [x] Update CLAUDE.md with new project type (local runtime-agent)
- [x] Update ARCHITECTURE.md with new architecture
- [x] Archive or update MVP-SPEC.md (mark as superseded)
- [x] Start Phase 1 implementation
- [x] Phase 4 completed — orchestrator baseline functional
- [x] Phase 5 — orchestrator hardening (parity with Pi sample)
- [x] Phase 6 — Dashboard Client (Lit web UI, model settings, budget viz)
- [x] Phase 7 — Polish & release (CLI packaging, init wizard, doctor, docs, migration)

---

*Создано: research-spec-generator skill*
*Исходный запрос: Локальный runtime-agent на базе fan с оркестратором, extensions/skills, мульти-клиент API и тонкими настройками моделей*
