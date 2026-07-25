# FAN — Fast Agents Network

> Local AI runtime-agent for developers. Multi-provider, multi-agent, with web dashboard.

## Features

- **Multi-provider AI** — OpenAI, Anthropic, Google, Groq, xAI, Mistral, Azure, Vertex AI, and 40+ more
- **Interactive TUI** — streaming, markdown rendering, thinking blocks, tool execution widgets
- **Multi-agent orchestrator** — coordinator mode, 8 worker types (explore, plan, implement, verify, bug-fix, code-research, docs-impl, tests-impl), single mode, live tool call display
- **Model management** — routing rules, fallback chains, budget tracking, per-session settings
- **REST API + WebSocket server** — 14 endpoints, token auth, background daemon mode
- **Web dashboard** — Lit-based, real-time streaming, model settings, budget visualization
- **Extension & skill system** — tools, commands, lifecycle hooks, prompt templates
- **Session persistence** — JSONL (single source of truth) + SQLite metadata
- **CLI tools** — `fan init` setup wizard, `fan doctor` diagnostics, `fan server` daemon management
- **Cross-platform** — Windows, Linux, macOS. Pre-built binaries via CI/CD
- **MCP Интеграция** — Подключение к внешним [Model Context Protocol](https://modelcontextprotocol.io/) серверам (filesystem, github, postgres и др.) через stdio или HTTP транспорты с per-server фильтрацией разрешений и поддержкой worker proxy. См. [docs/guides/mcp.md](./docs/guides/mcp.md).

## Quick Start

### Install

```bash
# Download pre-built binary (recommended)
# See INSTALL.md for all platforms and package managers

# Or build from source:
git clone <repo> && cd fan && npm install && npm run build
```

### Setup

```bash
fan init          # Interactive setup wizard (API keys, default model, preferences)
fan doctor        # Verify installation and dependencies
```

### Use

```bash
fan               # Interactive TUI mode (default)
fan -p "prompt"   # Single prompt (non-interactive)
fan --web         # Server + dashboard (auto-opens browser)
```

### Server Mode

```bash
fan server                # Server in foreground (full runtime)
fan server start          # Background daemon (for IDE plugins)
fan server start --port 3000  # Custom port
fan server status         # Check daemon status (--json for machine output)
fan server stop           # Stop background daemon
```

## Orchestrator

FAN includes a built-in multi-agent orchestrator with specialized workers:

| Worker | Role | Permissions |
|--------|------|-------------|
| 🔍 **explore** | Fast codebase recon, file search, structure analysis | Read-only |
| 📋 **plan** | Create implementation plans from gathered context | Read-only |
| 🔧 **implement** | Write code, make changes, run commands | Full |
| 🛡️ **verify** | Code review, quality checks, security audit | Read-only |
| 🐛 **bug-fix** | Targeted bug reproduction, diagnosis, and fix | Full |
| 🔬 **code-research** | Deep code analysis, dependency tracing | Read-only |
| 📝 **docs-impl** | Write and update documentation | Full |
| 🧪 **tests-impl** | Write unit/integration tests for existing code | Full |

### Coordination Mode

The orchestrator runs in **coordinator mode**: an AI agent decomposes your request into tasks and delegates each to the right worker type. All workers execute in **single mode** — one task per worker. The coordinator manages the task board, tracks progress, and resolves blocked or failed tasks.

```
# Single — one worker, one task
Agent(agentType="explore", task="Find authentication code")
Agent(agentType="implement", task="Fix the login bug")
```

Workers display live tool calls during execution, timing, and usage stats on completion. See [docs/guides/orchestrator.md](docs/guides/orchestrator.md) for details.

## Skills

FAN ships with 8 pre-installed skills — reusable prompt templates that extend agent capabilities. Skills are installed via FAN Store and invoked with `/skill:<name>`.

| Skill | Description |
|-------|-------------|
| `auto-tests` | Autonomous test generation (Kotlin, TS, Python, Rust, Go, C#) |
| `bug-fix` | Bug-fix agent: reproduce → find cause → fix → verify |
| `code-research` | Read-only code analysis with tracing & Mermaid diagrams |
| `deep-dive` | Deep-dive module analysis from repo-explorer reports |
| `fan-forge` | Extension & skill factory (7-phase pipeline) |
| `idea-lab` | Idea research (technical/business/creative) with SWOT & brainstorm |
| `repo-explorer` | Git repo analysis (GitHub + local), C4 architecture |
| `research-spec-generator` | Cyclic research + spec generation |

```bash
fan store install <name>   # Install from FAN Store
```

Source files: [`skills/`](skills/)

## Documentation

| Document | Description |
|----------|-------------|
| [INSTALL.md](INSTALL.md) | Installation guide (Windows/Linux/macOS) |
| [SETUP.md](SETUP.md) | Development setup & configuration |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guide |
| [MIGRATION.md](MIGRATION.md) | Migration from upstream fan/pi |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture, packages, data flow |
| [docs/guides/configuration.md](docs/guides/configuration.md) | Settings reference |
| [docs/guides/orchestrator.md](docs/guides/orchestrator.md) | Orchestrator guide |
| [docs/guides/dashboard.md](docs/guides/dashboard.md) | Dashboard guide |
| [docs/guides/api-reference.md](docs/guides/api-reference.md) | API reference |
| [CHANGELOG.md](CHANGELOG.md) | Release changelog |
| [docs/roadmaps/orchestrator-ui-upgrade.md](docs/roadmaps/orchestrator-ui-upgrade.md) | Orchestrator UI upgrade roadmap |

## Architecture

FAN is a monorepo (npm workspaces, TypeScript strict, Bun-compatible).

```
Client (TUI / Dashboard / IDE / SDK)
         │
    ┌────┴────┐
    │  API    │  Hono REST + WebSocket
    │ Gateway │  Token auth via ClientToken (DB)
    └────┬────┘
         │
    ┌────┴────────────┐
    │  Coding Agent   │  Session management, tools, extensions
    └────┬────────────┘
         │
    ┌────┼────────────┐
    │    │            │
Model   │       Orchestrator
Manager │       (coordinator mode,
(routing,│       8 worker types,
fallback,│       single mode)
budget)  │
    │    │
    ┌────┴────┐
    │  Fan AI  │  Provider abstraction (20+ providers)
    └─────────┘
         │
    ┌────┴────┐
    │   DB     │  Prisma + SQLite (metadata, tokens, settings)
    └─────────┘
```

### Packages

| Package | Description |
|---------|-------------|
| `coding-agent` | Main CLI — TUI, tools, extensions, skills |
| `orchestrator` | Multi-agent coordination (96 tests) |
| `ai` | AI/LLM provider abstraction (586 models) |
| `agent` | Agent core & session management |
| `model-manager` | Model routing, fallback chains, budget |
| `api-gateway` | Hono REST + WebSocket API server |
| `dashboard` | Lit web UI dashboard |
| `db` | Prisma + SQLite schema & migrations |
| `tui` | Terminal UI components |
| `web-ui` | Standalone web UI components |

### Key Concepts

- **Runtime = execution engine.** One active session at a time. Disk (JSONL) is the single source of truth.
- **Dashboard is a thin frontend.** No in-memory session stores — all data from disk via API.
- **Orchestrator** delegates tasks to specialized workers with coordinator mode, live TUI updates, and task tracking.
- **Model Manager** handles per-task routing, fallback chains, and budget tracking across providers.
- **Version** is defined once in root `package.json`. Sub-packages read it at runtime.

### Configuration

- **Global:** `~/.fan/agent/` (models, settings, tokens)
- **Project:** `.fan/` (project-specific settings)
- **Environment:** `.env` (API keys, never committed)
- **Custom models:** `~/.fan/agent/models.json`

### Server Mode

Server mode exposes the full runtime via REST + WebSocket:

```bash
fan --web                  # Server + dashboard (auto-opens browser)
fan server                 # Server in foreground
fan server start           # Background daemon (ideal for IDE plugins)
```

Key endpoints: `GET /api/health`, `POST /api/sessions/:id/messages`,
`GET /api/models`, `GET /api/budget`, `WS /api/ws/:sessionId`

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/guides/api-reference.md](docs/guides/api-reference.md) for details.

### Docker / VPS Deployment

FAN ships with a production Docker setup — multi-stage `Dockerfile`, `docker-compose.yml`, and an nginx reverse-proxy config with TLS (`deploy/nginx/`):

```bash
docker compose up -d --build   # build & start the fan-agent container
docker compose logs -f fan     # follow logs
```

Key env vars: `PORT`, `HOST`, `FAN_PUBLIC=1` (mandatory token auth), `ALLOWED_ORIGINS`, `LOG_DIR`/`LOG_LEVEL`. The gateway binds to loopback inside the container; nginx terminates TLS and proxies HTTP + WebSocket. Full walkthrough: [docs/guides/deployment.md](docs/guides/deployment.md).

## Development

### Git Workflow

```
master (prod) → develop (integration) → FAN/<type>/<name> (feature branches)
```

Branch types: `feature`, `fix`, `hotfix`. Commits: conventional commits.

### Build & Test

```bash
npm run build                                    # Build all packages
cd packages/orchestrator && npx vitest run       # 96 tests
cd packages/model-manager && npx vitest run      # 42 tests
cd packages/api-gateway && npx vitest run        # 39 tests
cd packages/dashboard && npx vitest run          # 23 tests
```

### Environment

- **Runtime:** Node.js 20+ / Bun
- **Language:** TypeScript strict
- **Package manager:** npm workspaces
- **Database:** SQLite via Prisma
- **Build:** tsgo (native TypeScript Go compiler)
- **OS:** Windows, Linux, macOS

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

Fast Agents Network
