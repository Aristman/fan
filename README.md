# FAN — Filin Agent Next

> Local AI runtime-agent for developers. Multi-provider, multi-agent, with web dashboard.

## Features

- Multi-provider AI (OpenAI, Anthropic, Google, Groq, xAI, Mistral, and more)
- Interactive TUI with streaming, markdown, thinking blocks
- Multi-agent orchestrator (coordinator mode, worker delegation)
- Model management (routing rules, fallback chains, budget tracking)
- REST API + WebSocket server mode (14 endpoints)
- Web dashboard (Lit-based, real-time streaming)
- Extension system & skill system
- Session persistence (JSONL + SQLite metadata)
- `fan init` setup wizard
- `fan doctor` diagnostics
- `fan server` command with start/stop/status subcommands (background daemon management)
- Pre-built binary delivery (GitHub Releases, CI/CD)

## Quick Start

### Install

```bash
# Download pre-built binary (see INSTALL.md for all platforms)
# Or build from source:
git clone <repo> && cd fan && npm install && npm run build
```

### Setup

```bash
fan init          # Interactive setup wizard
fan doctor        # Verify installation
```

### Use

```bash
fan               # Interactive TUI mode
fan -p "prompt"   # Single prompt
fan --web         # Server + dashboard (auto-opens browser)
fan server        # Server in foreground (full runtime)
fan server start  # Background daemon (for IDE plugins)
fan server status # Check if server is running
fan server stop   # Stop background server
```

## Documentation

| Document | Description |
|----------|-------------|
| [INSTALL.md](INSTALL.md) | Installation guide (Windows/Linux/macOS) |
| [SETUP.md](SETUP.md) | Development setup & configuration |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guide |
| [MIGRATION.md](MIGRATION.md) | Migration from upstream fan/pi |
| [docs/guides/configuration.md](docs/guides/configuration.md) | Settings reference |
| [docs/guides/orchestrator.md](docs/guides/orchestrator.md) | Orchestrator guide |
| [docs/guides/dashboard.md](docs/guides/dashboard.md) | Dashboard guide |
| [docs/guides/api-reference.md](docs/guides/api-reference.md) | API reference |

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| @itone/fan-ai | 0.66.1 | AI provider abstraction |
| @itone/fan-agent | 0.66.1 | Agent core & session management |
| @itone/fan-tui | 0.66.1 | Terminal UI components |
| @itone/fan-web-ui | 0.66.1 | Web UI components |
| @itone/fan-coding-agent | 0.66.1 | Main CLI package |
| @fan/orchestrator | 1.0.0 | Multi-agent coordination |
| @fan/model-manager | 1.0.0 | Model routing & budget |
| @fan/api-gateway | 1.0.0 | REST/WS API server |
| @fan/dashboard | 1.0.0 | Web dashboard |
| @fan/db | 1.0.0 | Prisma/SQLite database |

## Architecture

FAN is a monorepo built with TypeScript, Bun, and npm workspaces.

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
Manager │       (delegate_task,
(routing,│       4 workers,
fallback,│       3 workflows)
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

### Key Concepts

- **Runtime = execution engine.** One active session at a time. Disk (JSONL) is the single source of truth.
- **Dashboard is a thin frontend.** No in-memory session stores — all data from disk via API.
- **Orchestrator** delegates tasks to specialized workers (explore, plan, implement, verify) with coordinator mode.
- **Model Manager** handles per-task routing, fallback chains, and budget tracking across providers.
- **Extensions & Skills** add tools, commands, and lifecycle hooks to the agent.

### Configuration

- **Global config:** `~/.fan/agent/` (models, settings, tokens)
- **Project config:** `.fan/` (project-specific settings)
- **Environment vars:** `.env` (API keys, never committed)
- **Custom models:** `~/.fan/agent/models.json` (global only)

### Server Mode

Server mode exposes 14 REST endpoints + WebSocket streaming:

```bash
fan --web                  # Server + dashboard (auto-opens browser)
fan server                 # Server in foreground
fan server start           # Background daemon
fan server start --port 3000  # Custom port
fan --mode server          # API server only (no browser auto-open)
```

`fan server` runs the **full runtime** (sessions, extensions, models, orchestrator) — all connected clients (dashboard, IDE plugins, API consumers) get the complete agent capabilities. Use `fan server start` for background daemon mode — ideal for IDE plugin integration. The daemon writes PID and metadata to `~/.fan/agent/server.json`.

Key endpoints: `GET /api/health`, `POST /api/sessions/:id/messages`,
`GET /api/models`, `GET /api/budget`, `WS /api/ws/:sessionId`

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full details.

### Delivery

Pre-built binaries for all platforms (Windows, Linux, macOS) are available from
[GitHub Releases](https://github.com/user/fan/releases), created automatically
by CI/CD on every release. See [INSTALL.md](INSTALL.md) for download links.

For IDE plugin integration, use `fan server start` to run the agent as a background daemon — it registers its PID and WebSocket endpoint so plugins can auto-connect.

## Development

### Git Workflow

```
master (prod) → develop (integration) → FAN/<type>/<name> (feature branches)
```

Branch types: `feature`, `fix`, `hotfix`. Commits: conventional commits.

### Build & Test

```bash
npm run build                                    # Build all packages (10 packages, 0 errors)
cd packages/orchestrator && npx vitest run       # Orchestrator tests (95 tests)
cd packages/model-manager && npx vitest run      # Model Manager tests (42 tests)
cd packages/api-gateway && npx vitest run        # API Gateway tests (39 tests)
cd packages/dashboard && npx vitest run          # Dashboard tests (23 tests)
```

### Environment

- **Runtime:** Node.js 24+ / Bun
- **Language:** TypeScript strict
- **Package manager:** npm workspaces
- **Database:** SQLite via Prisma
- **Build:** tsgo (native TypeScript Go compiler)
- **OS:** Windows, Linux, macOS

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

Fork of fan-mono. See upstream for license details.
