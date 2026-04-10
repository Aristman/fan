# CLAUDE.md — Filin Agent Next (FAN)

> Quick context for LLM sessions. For architecture details → [ARCHITECTURE.md](./ARCHITECTURE.md)

## Project
- **Name:** Filin Agent Next (FAN)
- **Type:** Local AI runtime-agent for developers
- **Base:** Fork of fan-mono (fan-coding-agent core)
- **Repo:** Monorepo (npm workspaces, Bun, TypeScript)
- **Stage:** Phase 1 — Foundation

## What It Is
Runs locally on user's machine. Provides external API for multiple UI clients (TUI, WebView, IDEA plugin, etc.). Built on fan-coding-agent with custom orchestrator extension, model management, and all current extensions/skills.

## Tech Stack
Runtime: Bun · Monorepo: npm workspaces · Core: fan-ai + fan-agent-core + fan-coding-agent + fan-tui · API: stdio RPC + Hono HTTP/WS · DB: Prisma+SQLite · Dashboard: Lit+Vite · Build: tsup

## Git Rules
- **Prefix:** all branches start with `FAN/`
- **Branches:** `master` (prod) → `develop` (integration) → `FAN/<type>/<name>`
- **Types:** feature, fix, hotfix
- **Commits:** conventional commits style

## Code Conventions
- TypeScript strict mode
- Packages in packages/ directory
- Each package has own package.json, tsconfig.json
- Extensions use fan extension API (lifecycle hooks, tools, commands)
- Skills follow fan skill format (SKILL.md)
- Session persistence: JSONL (fan format) + Prisma metadata
- No auth (local runtime, single-user, API key for client connections)
- Environment vars in .env (never committed)

## Key Files
- `docs/specs/spec_runtime-agent_2026-04-10.md` — current specification (runtime-agent)
- `docs/specs/MVP-SPEC.md` — superseded (web SaaS concept, archived)
- `ARCHITECTURE.md` — architecture, packages, data flow
