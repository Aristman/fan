# F-5.1 `process.cwd()` Audit — Phase 5

> Scope: `packages/*`, `tools/*`, `skills/*`
> Excluded: `node_modules/`, `dist/`, test files (`*.test.ts`, `*.spec.ts`, `*/test/*`, `*/__tests__/*`)
> Command: `grep -rn "process\.cwd()" packages/ tools/ skills/ --include="*.ts" --include="*.js" --include="*.mjs"`

## Summary

| Metric | Count |
|--------|-------|
| Total non-test matches | 82 |
| Direct consumers | 37 |
| Indirect via module | 23 |
| Safe skip | 22 |
| Test matches | 29 |
| Files affected (non-test) | 32 |

Coverage:
- `packages/api-gateway`, `packages/model-manager`, `packages/agent`, `packages/ai`, `packages/db`, `packages/dashboard`, `packages/orchestrator`: **no non-test source matches**.
- `tools/`, `skills/`: **no matches**.

## Categories

- **Direct** — reads `process.cwd()` for business logic (path resolution, tool execution, session switching). Must be replaced with explicit `cwd` parameter.
- **Indirect** — passes `process.cwd()` into a function/constructor. Requires signature changes and propagating the cwd from the caller.
- **Safe skip** — logging, diagnostics, TUI-only, JSDoc comments, or dev-only fallbacks. No runtime behavior change needed.

## Main results (non-test)

| File | Line(s) | Category | Effort | Note |
|------|---------|----------|--------|------|
| `packages/coding-agent/src/core/agent-session-runtime.ts` | 123, 320 | Direct | L | Core runtime cross-cwd session replacement; `process.chdir()` checks. TC-F-5.1-1 target. |
| `packages/coding-agent/src/core/bash-executor.ts` | 60 | Direct | M | `executeBash()` uses `process.cwd()` for command execution; needs explicit cwd parameter. |
| `packages/coding-agent/src/cli/file-processor.ts` | 31 | Direct | M | `@file` argument resolution uses `process.cwd()`; needs cwd from CLI entry point. |
| `packages/coding-agent/src/core/sdk.ts` | 176 | Direct | M | `createAgentSession()` defaults `cwd` to `process.cwd()`; already accepts `options.cwd`. |
| `packages/coding-agent/src/core/resource-loader.ts` | 79, 205 | Direct | M | `loadProjectContextFiles()` and `DefaultResourceLoader` constructor default to `process.cwd()`. |
| `packages/coding-agent/src/core/session-manager.ts` | 1279, 1300 | Direct | M | `SessionManager.open()` fallback and `inMemory()` default to `process.cwd()`. |
| `packages/coding-agent/src/core/settings-manager.ts` | 173, 286 | Direct | S | Constructor and `create()` default to `process.cwd()`; already parameterized. |
| `packages/coding-agent/src/core/prompt-templates.ts` | 206 | Direct | S | `loadPromptTemplates()` defaults cwd to `process.cwd()`. |
| `packages/coding-agent/src/core/skills.ts` | 405 | Direct | S | `loadSkills()` defaults cwd to `process.cwd()`. |
| `packages/coding-agent/src/core/system-prompt.ts` | 39 | Direct | S | `buildSystemPrompt()` defaults cwd to `process.cwd()`. |
| `packages/coding-agent/src/core/tools/bash.ts` | 455, 456 | Direct | S | Backward-compat default `bashTool`/`bashToolDefinition` exports. |
| `packages/coding-agent/src/core/tools/edit.ts` | 306, 307 | Direct | S | Backward-compat default `editTool`/`editToolDefinition` exports. |
| `packages/coding-agent/src/core/tools/find.ts` | 313, 314 | Direct | S | Backward-compat default `findTool`/`findToolDefinition` exports. |
| `packages/coding-agent/src/core/tools/grep.ts` | 374, 375 | Direct | S | Backward-compat default `grepTool`/`grepToolDefinition` exports. |
| `packages/coding-agent/src/core/tools/ls.ts` | 232, 233 | Direct | S | Backward-compat default `lsTool`/`lsToolDefinition` exports. |
| `packages/coding-agent/src/core/tools/read.ts` | 268, 269 | Direct | S | Backward-compat default `readTool`/`readToolDefinition` exports. |
| `packages/coding-agent/src/core/tools/write.ts` | 284, 285 | Direct | S | Backward-compat default `writeTool`/`writeToolDefinition` exports. |
| `packages/coding-agent/src/core/footer-data-provider.ts` | 104 | Direct | M | Git branch watcher defaults to `process.cwd()`; affects TUI footer. |
| `packages/coding-agent/src/main.ts` | 1018, 1035 | Direct | L | Startup `runMigrations(process.cwd())` and initial cwd selection. |
| `packages/coding-agent/src/main.ts` | 1288 | Safe skip | S | Dev-mode dashboard dist resolution (`packages/dashboard/dist`); fallback only. |
| `packages/coding-agent/src/migrations.ts` | 304 | Direct | S | `runMigrations()` default parameter; already accepts cwd. |
| `packages/coding-agent/src/package-manager-cli.ts` | 146, 189 | Direct | M | `handleConfigCommand`/`handlePackageCommand` read `process.cwd()` for package manager. |
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` | 47 | Indirect | S | `ToolExecutionComponent` constructor default cwd (TUI rendering). |
| `packages/coding-agent/src/utils/photon.ts` | 50 | Safe skip | S | WASM fallback lookup in `process.cwd()`; safe as last-resort path. |
| `packages/mcp/src/config.ts` | 194, 209 | Direct | S | `createMcpConfigLoader()`/`loadMcpConfig()` default cwd. |
| `packages/store/src/installer.ts` | 41 | Direct | M | `ArchiveInstaller.getTargetDirectory()` uses `process.cwd()` for project-scope extension install. |
| `packages/tui/src/autocomplete.ts` | 270 | Indirect | S | `CombinedAutocompleteProvider` default `basePath` (TUI autocomplete). |
| `packages/coding-agent/examples/` | multiple | Indirect | S | 23 matches in examples — update after core API stabilizes. |
| JSDoc/comment-only matches | multiple | Safe skip | S | ~25 matches — comments only, no runtime effect. |

## Critical files

1. `packages/coding-agent/src/core/agent-session-runtime.ts` — runtime `process.chdir` is the canonical F-5.1 target.
2. `packages/coding-agent/src/main.ts` — orchestrates initial cwd, migrations, and session creation.
3. `packages/coding-agent/src/core/sdk.ts` — public `createAgentSession()` default.
4. `packages/coding-agent/src/core/tools/*.ts` — 7 backward-compat default tool exports.
5. `packages/coding-agent/src/core/resource-loader.ts` — project-local discovery.
6. `packages/coding-agent/src/core/session-manager.ts` — session cwd fallback.
7. `packages/coding-agent/src/core/bash-executor.ts` — direct command execution cwd.
8. `packages/coding-agent/src/cli/file-processor.ts` — CLI `@file` resolution.
9. `packages/coding-agent/src/package-manager-cli.ts` — package/config commands.
10. `packages/store/src/installer.ts` — project-scope extension install path.

## Key observations

1. **TC-F-5.1-1 confirmed.** `agent-session-runtime.ts` lines 123 and 320: runtime checks `process.cwd()` and calls `process.chdir(result.services.cwd)` during session replacement.
2. **100% coverage** of packages/coding-agent, api-gateway, model-manager. Only coding-agent has non-test matches.
3. **Legacy default tool exports are a major source** — 7 tool files each export default `*Tool`/`*ToolDefinition` bound to `process.cwd()` ("for backwards compatibility") — deprecate/remove in favor of `create*Tool(cwd)`.
4. **Tests assert current chdir behavior** (`per-session-cwd.test.ts`, `agent-session-runtime.test.ts`) — need coordinated updates when chdir is removed.

## Recommendations

1. Prioritize: `agent-session-runtime.ts`, `main.ts`, `sdk.ts`, `tools/*.ts` (deprecate default exports).
2. Medium: `resource-loader.ts`, `session-manager.ts`, `bash-executor.ts`, `file-processor.ts`, `package-manager-cli.ts`, `footer-data-provider.ts`, `store/src/installer.ts`.
3. Low-effort: `settings-manager.ts`, `prompt-templates.ts`, `skills.ts`, `system-prompt.ts`, `migrations.ts`, `mcp/src/config.ts` — already parameterized, just remove defaults.
4. Update tests asserting `process.cwd()` changes in the same pass.
5. Examples — last, after API stabilizes.

---

# F-5.2 `process.chdir()` Audit — Phase 5 (дополнение)

> Scope: `packages/*`, `tools/*`, `skills/*` · Excluded: node_modules, dist, binaries

## Summary

| Metric | Count |
|--------|-------|
| Production `process.chdir()` calls | **2** (оба в agent-session-runtime.ts) |
| Test calls (обновить в F-5.4) | 15 (7 файлов) |
| Hidden calls (mcp/store/api-gateway/tools/skills) | 0 |

## Production calls (Critical)

| File | Lines | Function | Replacement strategy |
|------|-------|----------|----------------------|
| `agent-session-runtime.ts` | 119–124 | `apply()` | Удалить `if (...) process.chdir(...)`. Сервисы уже пересоздаются под целевой cwd; потребители читают `runtime.services.cwd`. |
| `agent-session-runtime.ts` | 320–321 | `createAgentSessionRuntime()` | Удалить мутацию. `options.cwd`/`services.cwd` пробрасывается явно через AgentSession и tool factories. |

## Ключевые наблюдения

1. **Инфраструктура уже готова:** `AgentSession._cwd`, `createAllToolDefinitions(cwd)`, `createCodingTools(cwd)`, `SessionManager.getCwd()` — chdir избыточен.
2. **TC-F-5.2-1 ✅** — agent-session-runtime.ts = Critical (2 вызова).
3. **TC-F-5.2-2 ✅** — mcp/store/api-gateway/tools/skills/orchestrator: скрытых chdir нет.
4. `SessionManager.open()` fallback на `process.cwd()` (session-manager.ts:1279) — не chdir, но цепочка вызовов должна передавать cwd явно.
5. Тесты assert'ят chdir-поведение (`per-session-cwd.test.ts:95`, `agent-session-runtime.test.ts`) — переписываются в F-5.4 на `runtime.services.cwd` / `sessionManager.getCwd()`.

## Test calls (для F-5.4)

footer-data-provider.test.ts (8), package-command-paths.test.ts (2), agent-session-branching.test.ts (1), agent-session-runtime-events.test.ts (1), suite/agent-session-runtime.test.ts (1), suite/per-session-cwd.test.ts (1 + 2 refs), suite/workspace-root.test.ts (1).
