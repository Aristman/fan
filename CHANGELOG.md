# Changelog

## [0.3.4] - 2026-04-17

### FAN Store — Package Manager Extension

#### New Package: `@fan/store`
- **Package manager extension** for installing extensions, skills, and themes from repositories and local archives
- **5 LLM tools**: `store_search`, `store_install`, `store_remove`, `store_update`, `store_list`
- **`/store` slash command** with subcommands: `list`, `search`, `install`, `remove`, `update`, `repos`
- **Repository management** — add/remove custom package repositories via `/store repos add|remove`
- **Multi-repo search** with relevance sorting (exact match → prefix → substring, case-insensitive)
- **Archive installation** from `.tar.gz`, `.tgz`, and `.zip` files with auto type detection
- **Bundle support** — packages containing multiple resources (extensions/, skills/, themes/)
- **Auto-update check** on session start (configurable interval, default 24h)
- **Status bar indicator** — shows installed package count and available updates
- **SHA-256 hash verification** for downloaded packages
- **Path traversal protection** during archive extraction
- **Backup & rollback** — existing installations backed up before overwrite, restored on failure
- **Offline mode** — respects `FAN_OFFLINE` env var, falls back to cached repo indices
- **`file://` URL support** — local file-system repositories for air-gapped setups
- **Index caching** — 5-minute TTL for repo index fetches

#### Configuration
- Config file: `~/.fan/agent/store.json` (auto-created with defaults)
- Database file: `~/.fan/agent/store-packages.json` (installed packages registry)
- Settings: `repositories`, `autoUpdateCheck`, `autoUpdateCheckIntervalHours`, `installScope`, `archiveTempDir`

#### CLI
- `--no-store` flag to disable FAN Store extension at startup

#### Build
- `@fan/store` added to monorepo build pipeline and bundled as virtual module in extension loader

---

## [0.3.3] - 2026-04-17

### Fixes
- Restored agents in the orchestrator

---

## [0.3.1] - 2026-04-16

### Fixes
- Load global `.env` into `process.env` on startup

---

## [0.3.0] - 2026-04-16

### New Package: `@fan/persistent-memory` v2.0.0
- **Persistent memory extension** for cross-session knowledge retention
- Memory stored locally, accessible across all sessions

### Refactoring
- Removed memory from core — extracted into standalone `@fan/persistent-memory` package

---

## [0.2.2] - 2026-04-15

### Fixes
- Fixed `.env` loading bug

### Documentation
- Added CHANGELOG and roadmap links to README
- Updated README for v0.2.1

---

## [0.2.1] - 2026-04-15

### Fixes
- **TLS skip for fd/rg downloads** — always skip TLS certificate verification (no env var needed)
- **Corporate proxy support** — allow fd/rg download behind proxies with self-signed certificates

---

## [0.2.0] - 2026-04-15

### Orchestrator — Worker UI & Architecture

#### Worker TUI Display
- **Live tool call display** during worker execution (max 9 tool calls, real-time updates)
- **Running state** shows spinner + last tool calls instead of static `(running...)`
- **Completed state (collapsed)** shows final output + footer `N tools · Xs`
- **Completed state (expanded)** shows full tool calls + output + usage stats
- **Agent emoji icons**: 🔍 explore, 📋 plan, 🔧 implement, 🛡️ verify
- **Mode labels**: 🔗 CHAIN, ⚡ PARALLEL for multi-worker tasks
- **Worker progress** includes message count: `Processing · N tools · M messages`
- **Wall-clock timing** tracked per worker (`startTime`/`endTime` on `SingleResult`)

#### Task List Widget
- **Remove auto-task creation from `delegate_task`** — tasks managed exclusively via `TaskCreate`/`TaskUpdate`/`TaskClear`
- **Auto-hide + auto-clear** widget when all tasks completed/failed
- **Replace raw ANSI** escape codes with `theme.fg()` for theme consistency
- **Compact collapse format**: `📋 N/M tasks [Alt+T to expand]`
- **Status via widget** for `/orchestrator status` and `/orchestrator config` (10s auto-dismiss)

#### Architecture
- **Slot pool** (`acquireSlot`/`releaseSlot`) integrated into `delegate_task` for concurrency control
- **`stop_worker` tool** for aborting misbehaving workers
- **Single mode `onUpdate` wrapper** — fixes `SubagentDetails` shape mismatch that caused TypeError in `renderResult`
- **`parseVerdict()`** utility for extracting PASS/FAIL/PARTIAL from worker output

#### Documentation
- Added `docs/roadmaps/orchestrator-ui-upgrade.md` — 3-priority roadmap (19 items)
- Updated coordinator system prompt with new tool docs and concurrency rules

### Other
- Updated generated models registry
