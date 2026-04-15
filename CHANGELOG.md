# Changelog

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
