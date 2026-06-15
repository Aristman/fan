# Migrating from fan/pi to FAN

> FAN is a fork of [fan-mono](https://github.com/nicepkg/fan) (also known as fan-coding-agent or pi-coding-agent). This guide covers what changed and how to migrate.

## What Changed

### Renamed CLI Command

| Item          | Upstream (fan/pi) | FAN  |
|---------------|--------------------|------|
| Binary        | `fan` / `pi`       | `fan` |
| Config dir    | `~/.fan/agent/`    | `~/.fan/agent/` (unchanged) |
| Project config| `.fan/`            | `.fan/` (unchanged) |
| Env vars      | `FAN_*`            | `FAN_*` (unchanged) |
| Session format| JSONL              | JSONL (unchanged) |

### New Features in FAN

- **Multi-agent orchestrator** — coordinator mode, worker delegation, `/plan` command
- **Model management** — routing rules, fallback chains, budget tracking per model
- **API gateway** — REST + WebSocket server mode for external UI clients
- **Web dashboard** — Lit-based UI with model settings, budget visualization
- **SQLite database** — Prisma-backed session metadata and model settings
- **`fan doctor`** — diagnostics command to check system health
- **`fan init`** — setup wizard for first-time configuration

### Removed from Upstream
- `mom` package
- `pods` package

## Breaking Changes

**None.** Your existing configuration is fully compatible. FAN reads the same config files, env vars, and session formats as upstream.

## Migration Steps

### 1. Install FAN

Download the binary or build from source — see [INSTALL.md](./INSTALL.md) for instructions.

```bash
# Verify installation
fan --version
```

### 2. Verify Config Compatibility

Your existing config files work as-is:

- `~/.fan/agent/settings.json` ✓
- `~/.fan/agent/models.json` ✓
- `.fan/settings.json` (project-level) ✓
- All `FAN_*` environment variables ✓
- Existing JSONL session files ✓

No changes needed. FAN uses the same paths and formats.

### 3. Update Shell Aliases

If you had an alias for `fan` or `pi`, update it:

```bash
# Before
alias fan='fan'

# After
alias fan='fan'
```

### 4. Run Diagnostics

```bash
fan doctor
```

This checks runtime dependencies, config validity, and database status.

### 5. Try New Features

```bash
# Start API server (REST + WebSocket)
fan server

# Re-run setup wizard (optional)
fan init

# Check system health
fan doctor
```

### 6. Explore New Configuration

See [docs/guides/configuration.md](./docs/guides/configuration.md) for new settings related to model routing, budgets, and the API gateway.

## New Configuration Options

FAN adds new settings on top of the existing `settings.json` format:

| Setting            | Location      | Description                                  |
|--------------------|---------------|----------------------------------------------|
| `budget`           | models.json   | Per-model spending limits and tracking       |
| `routingRules`     | models.json   | Rules for directing tasks to specific models |
| `modelSettings`    | Prisma DB     | Temperature, maxTokens, thinking (via WebUI) |
| `server.port`      | settings.json | API gateway port (default: 3456)            |

## What Stayed the Same

- Config directory (`~/.fan/agent/`), project config (`.fan/`), settings format
- Extension system (lifecycle hooks, tools, commands)
- Skill system (SKILL.md format), TUI interface (fan-tui)
- All `FAN_*` environment variables

## Version Info

| Component       | Version |
|-----------------|---------|
| Core packages   | 1.0.0   |
| FAN extensions  | 0.8.2 (store) / 5.3.0 (orchestrator) |

## Getting Help

- `fan --help` — CLI usage and available commands
- `fan doctor` — system diagnostics
- [docs/guides/](./docs/guides/) — configuration guides
- [ARCHITECTURE.md](./ARCHITECTURE.md) — system architecture overview
