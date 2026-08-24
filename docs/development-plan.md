# Development Plan: Recursive Orchestrator Spawn

> **Дата:** 2026-08-22
> **Slug:** recursive-orchestrator-spawn
> **Source roadmap:** `docs/features/recursive-orchestrator-spawn/roadmap.md`
> **Source spec:** `docs/specs/spec_recursive-orchestrator-spawn_2026-08-22.md`
> **Branch:** FAN/feature/recursive-orchestrator-spawn
> **Commit strategy:** per-function
> **Progress reporting:** errors-only + final

## Pipeline State

| Phase | Phase | Functions | Status |
|-------|-------|-----------|--------|
| 1 | Role-aware process spawn | F-1 | ☐ |
| 2 | Role profile schema extension | F-2 | ☐ (depends F-1) |
| 3 | HTTP delegation endpoint | F-3 | ☐ (depends F-1) |
| 4 | Role-aware launchChild | F-4 | ☐ (depends F-3) |
| 5 | Spawned SO wiring | F-5 | ☐ (depends F-4) |
| 6 | Integration test (e2e) | F-6 | ☐ (depends F-5) |
| Final | Verify + Smoke + Docs | verify, smoke, docs | ☐ |

## Function Summaries

### F-1 [INTEG]: Role-aware spawn в process-manager
- 3 tests, M volume (~1 day)
- Extends process-manager.spawn() with role: "worker" | "super-orchestrator"
- New env vars: FAN_NODE_ROLE, FAN_NODE_ROLE_PROFILE, FAN_PARENT_NODE_URL, FAN_PARENT_NODE_TOKEN
- Backward-compat: default role=worker

### F-2 [DATA]: Role profile default_extensions + exclusions config
- 3 tests, M volume (~1 day)
- Extends RoleProfile interface with default_extensions field
- NEW role-config.yaml with exclusions (store_search, store_install) and required (delegate_task)
- getEffectiveExtensions(role, config) — final list with exclusions and required applied

### F-3 [API]: HTTP delegation endpoint POST /api/mission-delegate
- 4 tests, M volume (~1 day)
- Adds endpoint in api-gateway, auth via FAN_NODE_TOKEN
- Emits api.events "mission_delegate" with payload

### F-4 [INTEG]: Role-aware launchChild
- 3 tests, L volume (~2 days)
- Switch in depth2-integration: worker → process-manager.spawn; SO → HTTP POST
- Tree-journal via: spawn | http_delegate

### F-5 [INTEG]: Spawned SO init в session_start
- 5 tests, L volume (~2 days)
- Conditional recursive init based on FAN_NODE_ROLE env
- Circuit + delegate handler + role profile load + child-node-client init

### F-6 [TEST]: E2E depth-4 integration test
- 3 tests, L volume (~2 days)
- Real fan server subprocesses: Coord → SO → SO → worker chain
- Reuse mock-fan-server.mjs with FAN_NODE_ROLE support

## Acceptance

| Function | Acceptance Criteria |
|----------|---------------------|
| F-1 | Worker spawn без role сохраняет существующее env; SO spawn добавляет все 4 env vars; 716+ existing tests PASS |
| F-2 | RoleProfile.default_extensions парсится; exclusions удаляются; required для SO добавляются |
| F-3 | Endpoint принимает с валидным токеном (200), отклоняет без/с неверным (401), валидирует payload (400) |
| F-4 | Worker role → existing flow; SO role → HTTP delegation; tree-journal корректный |
| F-5 | Recursive init создаёт circuit для SO; worker path unchanged; abort propagation работает |
| F-6 | Depth-4 happy path с real subprocesses; walk-up при crash; graceful shutdown |

## Risks

| Risk | Mitigation |
|------|------------|
| Рекурсия → циклы | canSpawnBatch enforce depth=4 |
| Token leakage | Per-process random token, secure env |
| Spawned SO crash | Walk-up escalation через lineage |
| Memory exhaustion (100 nodes) | Global cap в port-registry |
| Backward compat | Default role=worker preserves existing flow |
| New dependency (TOML parser) | Use existing yaml loader или inline mini-parser |
| Tool manifest regression | Hardcoded inject delegate_task для role=super-orchestrator |