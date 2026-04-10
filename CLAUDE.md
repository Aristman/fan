# CLAUDE.md — Filin Next Agent (FNA)

> Quick context for LLM sessions. For architecture details → [ARCHITECTURE.md](./ARCHITECTURE.md)

## Project
- **Name:** Filin Next Agent (FNA)
- **Type:** AI Agent web platform for developers
- **Repo:** Monorepo (npm workspaces, Bun, TypeScript)
- **Stage:** Pre-implementation (spec phase)

## Tech Stack
Runtime: Bun · Monorepo: npm workspaces · API: Hono · DB: Prisma+SQLite · Auth: JWT+bcrypt · UI: Lit+Vite · Build: tsup

## Git Rules
- **Prefix:** all branches start with `FNA/`
- **Branches:** `master` (prod) → `develop` (integration) → `FNA/<type>/<name>`
- **Types:** feature, fix, hotfix
- **Commits:** conventional commits style

## Code Conventions
- TypeScript strict mode
- Packages in packages/ directory
- Each package has own package.json, tsconfig.json
- Shared types via packages/ai or dedicated shared package
- REST endpoints follow RESTful conventions
- WebSocket for real-time chat streaming
- Environment vars in .env (never committed)

## Key Files
- `docs/specs/MVP-SPEC.md` — full MVP specification
- `ARCHITECTURE.md` — architecture, packages, data flow
- `docs/roadmaps/` — implementation roadmaps (if exist)
