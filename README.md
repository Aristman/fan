# Filin Agent Next (FAN)

> Local AI runtime-agent for developers. Fork of [fan-mono](https://github.com/itone-team/fan-mono) with orchestrator, model management, and client API.

## What It Does

FAN runs locally on your machine and provides an external API for multiple UI clients:
- **TUI** — Interactive terminal interface (built-in)
- **Server mode** — HTTP REST + WebSocket for web/mobile/IDE clients
- **RPC mode** — JSON-over-stdio for IDE plugins
- **SDK** — Programmatic use as a library

Built on [fan-coding-agent](https://github.com/itone-team/fan-mono) with:
- **Orchestrator** — Multi-agent task delegation (explore, plan, implement, verify workers)
- **Model Manager** — Per-task routing, fallback chains, budget tracking
- **API Gateway** — Hono REST + WebSocket with token auth

## Quick Start

```powershell
# Install dependencies
npm install

# Build all packages (10 packages)
npm run build

# Run in interactive mode
node packages/coding-agent/dist/cli.js

# Run as API server
node packages/coding-agent/dist/cli.js --mode server --port 3456

# Single prompt
node packages/coding-agent/dist/cli.js -p "Hello, world!"
```

## Configuration

### Provider Setup

Set API key as environment variable:

```powershell
# System-wide (PowerShell)
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "your-key", "User")

# Or in project .env file (not committed)
echo "ANTHROPIC_API_KEY=your-key" > .env
```

Supported providers: Anthropic, OpenAI, Google, Ollama, vLLM, LM Studio, Z.AI, and 15+ more.

### Project Settings

Create `.fan/settings.json` in project root:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "anthropic/claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "transport": "sse"
}
```

## Packages

| Package | Scope | Description |
|---------|-------|-------------|
| [ai](packages/ai/) | `@itone/fan-ai` | LLM abstraction: streaming, 20+ providers |
| [agent](packages/agent/) | `@itone/fan-agent-core` | Agent runtime: loop, tools, steering |
| [tui](packages/tui/) | `@itone/fan-tui` | Terminal UI: markdown, editor, autocomplete |
| [coding-agent](packages/coding-agent/) | `@itone/fan-coding-agent` | Core agent with tools, sessions, extensions |
| [web-ui](packages/web-ui/) | `@itone/fan-web-ui` | Lit web components for chat UI |
| [orchestrator](packages/orchestrator/) | `@fan/orchestrator` | Multi-agent coordination and delegation |
| [model-manager](packages/model-manager/) | `@fan/model-manager` | Model routing, fallback, budget tracking |
| [api-gateway](packages/api-gateway/) | `@fan/api-gateway` | HTTP REST + WebSocket server mode |
| [db](packages/db/) | `@fan/db` | Prisma + SQLite schema and migrations |
| [dashboard](packages/dashboard/) | `@fan/dashboard` | Lit-based web dashboard client |

## Orchestrator

FAN includes a multi-agent orchestrator that can delegate tasks to specialized workers:

```text
delegate_task tool supports 3 modes:
  Single:   { agent: "explore", task: "Find all API endpoints" }
  Parallel: { tasks: [{ agent: "explore", ... }, { agent: "explore", ... }] }
  Chain:    { chain: [{ agent: "explore", task: "..." }, { agent: "plan", task: "... {previous}" }] }
```

**Built-in workers:**
| Worker | Role | Tools |
|--------|------|-------|
| explore | Fast codebase recon | read, grep, find, ls, bash |
| plan | Implementation plans | read, grep, find, ls |
| implement | General-purpose coding | all defaults |
| verify | Code review & testing | read, grep, find, ls, bash |

**Slash commands:** `/orchestrator`, `/tasks`, `/agents`, `/delegate`

## API Gateway

Server mode exposes REST API + WebSocket:

```powershell
# Start server
node packages/coding-agent/dist/cli.js --mode server --port 3456

# Without auth (dev mode)
FAN_NO_AUTH=1 node packages/coding-agent/dist/cli.js --mode server
```

Key endpoints: `GET /api/health`, `POST /api/sessions/:id/messages`,
`GET /api/models`, `GET /api/budget`, `WS /api/ws/:sessionId`

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full API documentation.

## Testing

```powershell
# All orchestrator tests (29 tests)
cd packages/orchestrator && npx vitest run

# All model-manager tests (42 tests)
cd packages/model-manager && npx vitest run

# All api-gateway tests (39 tests)
cd packages/api-gateway && npx vitest run

# Full build (10 packages)
npm run build
```

See [docs/develop/tests/orchestrator-phase4.md](./docs/develop/tests/orchestrator-phase4.md) for detailed verification instructions.

## Development

### Git Workflow

```
master (prod) → develop (integration) → FAN/<type>/<name> (feature branches)
```

Branch types: `feature`, `fix`, `hotfix`. Commits: conventional commits.

### Build

Uses [tsgo](https://github.com/nicholasgasior/ts-go) (native TypeScript Go compiler).
All packages build to `dist/` with ESM output.

### Environment

- **Runtime:** Node.js 24+ / Bun
- **Language:** TypeScript strict
- **Package manager:** npm workspaces
- **Database:** SQLite via Prisma
- **OS:** Windows (primary), Linux, macOS

## Documentation

| File | Description |
|------|-------------|
| [CLAUDE.md](./CLAUDE.md) | Quick context for LLM sessions |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Full architecture reference |
| [docs/specs/](./docs/specs/) | Feature specifications |
| [docs/develop/tests/](./docs/develop/tests/) | Test instructions |

## License

Fork of fan-mono. See upstream for license details.
