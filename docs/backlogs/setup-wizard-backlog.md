# Backlog: Project Setup Wizard (`fan init`)

## Status: Proposed
## Priority: Medium
## Target Phase: Phase 7 (Polish & Release)

## Problem

New users face a friction-heavy setup:
1. Clone repo → `npm install` → build errors (missing native bindings, permission issues)
2. No `.env.example` — must read source code to discover env var names
3. `~/.fan/agent/models.json` schema undocumented — trial and error for custom providers
4. `.fan/settings.json` must be created manually
5. Platform-specific issues (Linux permissions, Windows CRLF, macOS ARM) have no guided resolution

## Proposed Solution

Create an interactive `fan init` command that guides users through first-time setup.

### Features

1. **Platform detection** — Detect OS, architecture, Node.js version, check prerequisites
2. **Dependency check** — Verify all prerequisites installed, suggest install commands
3. **Native bindings** — Auto-install `@typescript/native-preview-<platform>` for current OS
4. **Permission fix** — Auto-fix `chmod +x node_modules/.bin/*` on Linux/macOS
5. **`.env` generation** — Interactive provider selection → generate `.env` with correct var names
6. **`.fan/settings.json` generation** — Select default provider/model from available options
7. **`~/.fan/agent/models.json` generation** — Interactive wizard for adding custom providers:
   - Provider ID, base URL, API protocol
   - API key (masked input or env var reference)
   - Add models (ID, name, reasoning, context window)
   - Compatibility flags (thinking format, developer role)
8. **Build verification** — Run `npm run build`, report errors with fixes
9. **Smoke test** — Send test prompt to verify the setup works end-to-end
10. **`.env.example` creation** — Generate with all provider vars (masked) + runtime flags

### Implementation Notes

- Add as a new command in `packages/coding-agent/src/cli/` — `--mode init` or standalone script
- Could be a standalone `scripts/setup-wizard.ts` runnable via `npx tsx scripts/setup-wizard.ts`
- Should work before first build (pure Node.js, no compiled deps needed)
- Interactive prompts via Node.js `readline` or `inquirer`
- Must handle: Windows (PowerShell), Linux (bash), macOS (zsh)

### Acceptance Criteria

- [ ] `fan init` (or `node scripts/setup-wizard.ts`) runs on fresh clone
- [ ] Detects and installs correct native TypeScript binding
- [ ] Generates valid `.env`, `.fan/settings.json`, `~/.fan/agent/models.json`
- [ ] `models.json` written to `~/.fan/agent/` (NOT project `.fan/` — project-level not supported)
- [ ] Generated config passes `npm run build` without errors
- [ ] Smoke test sends a prompt and receives a response
- [ ] Works on Windows, Ubuntu, macOS

### Effort Estimate

~2-3 days (including cross-platform testing)

## Related

- `docs/backlogs/package-fork-backlog.md` — dependency migration backlog
- `SETUP.md` — Manual setup guide (interim solution)
- `packages/ai/src/env-api-keys.ts` — Provider env var mapping
