# Contributing to FAN

Thank you for your interest in contributing to Filin Agent Next (FAN)! 🎉

FAN is a local AI runtime-agent for developers, built as a TypeScript monorepo with Bun. Contributions of all kinds are
welcome — bug fixes, features, docs, extensions, and more.

---

## Project Structure

FAN is an npm workspaces monorepo. Packages live in `packages/`:

| Package         | Name                      | Description                                                |
|-----------------|---------------------------|------------------------------------------------------------|
| `ai`            | `@itone/fan-ai`           | AI provider abstraction, unified LLM API, model interfaces |
| `agent`         | `@itone/fan-agent-core`   | Agent core — transport, state management, attachments      |
| `tui`           | `@itone/fan-tui`          | Terminal UI library with differential rendering            |
| `web-ui`        | `@itone/fan-web-ui`       | Reusable web UI components for AI chat interfaces          |
| `coding-agent`  | `@itone/fan-coding-agent` | Main CLI — agent loop, tools, sessions, extension runner   |
| `orchestrator`  | `@fan/orchestrator`       | Multi-agent task decomposition and coordination            |
| `model-manager` | `@fan/model-manager`      | Provider routing, fallback chains, budget tracking         |
| `api-gateway`   | `@fan/api-gateway`        | HTTP/WebSocket REST API server                             |
| `dashboard`     | `@fan/dashboard`          | Lit-based web dashboard (Vite)                             |
| `db`            | `@fan/db`                 | Database layer — Prisma + SQLite                           |

---

## Development Setup

### Prerequisites

- **Node.js** 20+ (or Bun latest)
- **npm** (or Bun as package manager)
- **C/C++ compiler** (for native dependencies like `better-sqlite3`)

### Steps

1. **Clone:** `git clone https://github.com/aristman/fan.git && cd fan`
2. **Install:** `npm install`
3. **Configure:** `cp .env.example .env` — add at least one AI provider API key
4. **Generate DB client:** `cd packages/db && npx prisma generate && cd ../..`
5. **Build:** `npm run build` — all 10 packages should build with 0 errors
6. **Test:** `npm run test`

> ⚠️ Never commit `.env` — it's listed in `.gitignore`.

### Quick Start

```bash
# TUI mode
cd packages/coding-agent && npm start

# Dashboard (http://localhost:5174)
npm run dev:dashboard
```

---

## Git Workflow

### Branch Naming

All branches use the `FAN/` prefix:

- **Feature:** `FAN/feature/<name>`
- **Fix:** `FAN/fix/<name>`
- **Hotfix:** `FAN/hotfix/<name>`

Branch hierarchy: `master` (prod) → `develop` (integration) → `FAN/*`

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`, `perf:`, `ci:`

```
feat: add budget visualization to dashboard
fix: resolve session switch crash on empty history
```

### Pull Requests

1. Create branch from `develop`
2. Make changes, then run `npm run build && npm run test && npm run check`
3. Create PR targeting `develop` with a description of changes

---

## Coding Standards

- **TypeScript strict mode** across all packages
- **Biome** for formatting/linting (tabs, width 3, line width 120)
- Run `npm run check` to auto-fix — config in `biome.json`
- **ESM** only — all packages use `"type": "module"`
- **JSDoc** on public APIs
- Dashboard components use `createRenderRoot() { return this; }` (no shadow DOM for Tailwind)

---

## Testing

**Vitest** for unit and integration tests.

```bash
# Full suite
npm run test

# Single package
cd packages/<name> && npx vitest run

# Watch mode
cd packages/<name> && npx vitest
```

- Test files: `*.test.ts` alongside source or in `test/`
- Mock external deps (AI providers, filesystem, network)

---

## Adding Extensions

Extensions add tools, commands, and lifecycle hooks. See `packages/coding-agent/examples/extensions/` for 50+ examples.

### Steps

1. Create a file (e.g., `my-extension.ts`):

```typescript
import type {ExtensionAPI} from "@itone/fan-coding-agent";
import {Type} from "@itone/fan-ai";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "my_tool",
        label: "My Tool",
        description: "What the tool does",
        parameters: Type.Object({
            input: Type.String({description: "Input"}),
        }),
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            return {content: [{type: "text", text: `Result: ${params.input}`}], details: {}};
        },
    });

    pi.registerCommand("hello", {
        description: "Say hello",
        handler: async (_args, ctx) => ctx.ui.notify("Hello!", "info"),
    });
}
```

2. Test locally: `cd packages/coding-agent && npm start -- --extension path/to/my-extension.ts`
3. For extensions with dependencies, create a subdirectory with its own `package.json` (see `with-deps/`).

Key API: `pi.registerTool()`, `pi.registerCommand()`, `pi.on("hook", handler)`, `ctx.ui.notify()`, `ctx.ui.confirm()`

---

## Adding Skills

Skills are `SKILL.md` instruction files loaded via the `resources_discover` hook.

1. Create a directory: `skills/my-skill/`
2. Add `SKILL.md` with description, instructions, and examples for the agent
3. Register a discovery handler in an extension to load the skill files

---

## Adding New Packages

1. Create `packages/my-package/` with `src/index.ts`
2. Add `package.json` (use existing packages as template — ESM, tsgo build)
3. Add `tsconfig.json` extending `../../tsconfig.base.json`
4. Add the package to the root `build` script in `package.json`
5. Run `npm install && npm run build`

---

## Useful Commands

| Command                                | Description                       |
|----------------------------------------|-----------------------------------|
| `npm run build`                        | Build all 10 packages             |
| `npm run test`                         | Run all tests                     |
| `npm run check`                        | Biome lint/format + type checking |
| `npm run dev`                          | Watch mode (multiple packages)    |
| `npm run dev:dashboard`                | Dashboard dev server (:5174)      |
| `npm run build:dashboard`              | Dashboard production build        |
| `npm run clean`                        | Clean all build artifacts         |
| `cd packages/<name> && npx vitest run` | Tests for one package             |

---

## Resources

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — architecture and data flow
- [`CLAUDE.md`](./CLAUDE.md) — project context and phase progress
- [`docs/specs/`](./docs/specs/) — specifications
- Extension examples — `packages/coding-agent/examples/extensions/`
