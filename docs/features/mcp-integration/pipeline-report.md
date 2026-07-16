# Pipeline Report: Интеграция MCP (Model Context Protocol) в FAN

> **Дата:** 2026-07-16 (обновлено)
> **Ветка:** `FAN/MCP-001`
> **Slug:** mcp-integration
> **Сессия 1:** 5/32 — остановлен из-за worker bash issue
> **Сессия 2 (текущая):** +18 Phase 1 +5 Phase 2, итого **23/32 (71.9%)**

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 32 (Phase 1: 18, Phase 2: 7, Phase 3: 7) |
| Реализовано (✅) | **23** |
| Пропущено (❌) | **9** (F-2.6, F-2.7, F-3.1..F-3.7) |
| Коммитов функциональных | **22** |
| Коммитов chore/docs | **2** |

## Коммиты (от master, в хронологическом порядке)

| SHA | Сообщение |
|-----|-----------|
| `23f69b2` | fix(orchestrator): quote process.execPath on Windows with spaces in path |
| `063f8b6` | (вне pipeline) docs: создана спека и роадмапа |
| `428539d` | feat(core): F-1.1 F-1.2 add unregisterTool/updateTool to ExtensionAPI |
| `3fa4083` | feat(extension): F-1.3 add @fan/mcp-extension package skeleton |
| `4f58166` | feat(extension): F-1.11 resolveEnvVars with tests |
| `4704aaa` | feat(extension): F-1.9 filterToolsByConfig with tests |
| `7c686ea` | (сессия 1, заморожен) docs(pipeline): F-1.1-F-1.18 final pipeline report |
| `cf20629` | feat(extension): F-1.4 StdioClientTransport integration |
| `6ce6125` | feat(extension): F-1.5 StreamableHTTPClientTransport integration |
| `da7957e` | feat(extension): F-1.6 mcpToolToDefinition + JSON Schema→TypeBox |
| `0c4d3e2` | feat(extension): F-1.7 CallToolResult→AgentToolResult mapping |
| `8e87a26` | chore(roadmap): sync after F-1.4..F-1.7 |
| `2043d41` | feat(extension): F-1.8 mcp.json loader with global/project merge |
| `12e0336` | feat(extension): F-1.8 + executor type fix |
| `666c5f4` | feat(extension): F-1.10 tool_call permission gate |
| `abb5959` | feat(extension): F-1.13 withTimeout utility + tests |
| `2f464db` | feat(extension): F-1.14 F-1.16 F-1.17 Manager lifecycle |
| `3a1811c` | feat(extension): F-1.15 list_changed atomic catalog refresh |
| `d4a233b` | feat(extension): F-1.12 F-1.18 signal cancel + invalid config tests |
| `f139369` | feat(rpc): F-2.1 generic remote_tool types in rpc-types.ts |
| `baff7d7` | feat(rpc): F-2.2 pendingRemoteToolRequests correlation map |
| `1b9f9f1` | feat(core): F-2.3 EventBus lastEvent cache (replay-on-subscribe) |
| `e57a805` | feat(orchestrator): F-2.4 stub remote_tool_request handler |
| `7eaecc4` | feat(orchestrator): F-2.5 broker-handler with EventBus subscription |
| `a15a025` | chore(roadmap): mark F-2.1..F-2.5 complete |

## Функции

### Phase 1: Координатор-only MVP — **18/18 ✅**

| Функция | Статус | Коммит |
|---------|--------|--------|
| F-1.1 unregisterTool | ✅ | 428539d |
| F-1.2 updateTool | ✅ | 428539d |
| F-1.3 FAN Store packaging | ✅ | 3fa4083 |
| F-1.4 StdioClientTransport | ✅ | cf20629 |
| F-1.5 StreamableHTTPClientTransport | ✅ | 6ce6125 |
| F-1.6 tools/list + JSON Schema→TypeBox | ✅ | da7957e |
| F-1.7 tools/call execution | ✅ | 0c4d3e2 |
| F-1.8 mcp.json loader | ✅ | 2043d41 |
| F-1.9 allowedTools/deniedTools | ✅ | 4704aaa |
| F-1.10 permission gate | ✅ | 666c5f4 |
| F-1.11 ${ENV_VAR} | ✅ | 4f58166 |
| F-1.12 AbortSignal cancel | ✅ | d4a233b |
| F-1.13 withTimeout | ✅ | abb5959 |
| F-1.14 Graceful shutdown | ✅ | 2f464db |
| F-1.15 list_changed refresh | ✅ | 3a1811c |
| F-1.16 Unavailable server | ✅ | 2f464db |
| F-1.17 Crash → tools removed | ✅ | 2f464db |
| F-1.18 Invalid mcp.json | ✅ | d4a233b |

### Phase 2: Worker Proxy — **5/7 (3 done, 2 deferred)**

| Функция | Статус | Коммит |
|---------|--------|--------|
| F-2.1 Generic RPC types | ✅ | f139369 |
| F-2.2 Correlation map | ✅ | baff7d7 |
| F-2.3 lastEvent cache | ✅ | 1b9f9f1 |
| F-2.4 subagent-runner handler (stub) | ✅ | e57a805 |
| F-2.5 broker-handler (EventBus subscriber) | ✅ | 7eaecc4 |
| F-2.6 --remote-tools flag + proxy registration | ❌ deferred | — |
| F-2.7 per-worker profile filtering | ❌ deferred | — |

### Phase 3: Polish — **0/7 ❌ (deferred)**

Все 7 функций отложены до следующей сессии:
- F-3.1 Progress forwarding
- F-3.2 structuredContent preservation
- F-3.3 OAuth support
- F-3.4 Auto-restart
- F-3.5 /mcp status command
- F-3.6 Dashboard card
- F-3.7 Logging/metrics

## Verification — все checkpoints прошли

| Проверка | Результат |
|----------|-----------|
| `npx vitest run` (coding-agent) | **1022 passed** + 47 skipped (было 1003 → +19 от Phase 2) |
| `npx vitest run` (mcp-extension) | **128 passed** (было 15 → +113 за Phase 1) |
| `tsc --noEmit` (оба пакета) | OK |
| Все реализованные функции соответствуют TDD-тестам | ✅ |
| Conventional commits | ✅ |

## Прогресс по сессиям

### Сессия 1 (2026-07-16, начало)
- Реализовано F-1.1, F-1.2, F-1.3, F-1.9, F-1.11
- Остановка: worker bash issue на Windows (shell с пробелами в PATH ломал cd)
- 5/32 (15.6%)

### Сессия 2 (2026-07-16, возобновление после `23f69b2` fix)
- Полная Phase 1 (F-1.4 ... F-1.18) — **18 функций**
- Начало Phase 2 (F-2.1 ... F-2.5) — **5 функций** (включая stub handler и broker-handler)
- Остановка на F-2.6 — требует серьёзных изменений CLI args + worker rpc-mode (не в scope одной сессии)
- **23/32 (71.9%)**

## Что осталось (сессия 3+)

### F-2.6 (--remote-tools flag + proxy registration)
**Объём:** L (≤ 2 дней)
- Добавить `--remote-tools=t1,t2,...` CLI flag в `packages/coding-agent/src/cli/args.ts`
- Прокинуть flag в Worker rpc-mode
- Worker регистрирует RemoteProxyTool instances через `_refreshToolRegistry`
- Каждый RemoteProxyTool.execute() отправляет `remote_tool_request` на stdout через `output()`
- Await pendingRemoteToolRequests[invokeId] (F-2.2)
- ~150 строк кода + 5 unit-тестов

### F-2.7 (per-worker profile filtering)
**Объём:** M (≤ 1 день)
- В `extensions/fan-orchestrator/` — маппинг agentType → permissionLevel
- При вызове `runSingleAgent()` — фильтрация catalog tools по profile
- Передача через `--remote-tools` flag в worker subprocess
- ~80 строк + 4 теста

### Phase 3 (7 функций, polish)
- F-3.1 progress forwarding — M
- F-3.2 structuredContent — S
- F-3.3 OAuth — L
- F-3.4 auto-restart — M
- F-3.5 /mcp status command — S
- F-3.6 Dashboard card — L
- F-3.7 logging/metrics — S
- **Общий объём**: ~3-4 дня

## Изменённые файлы (статистика)

```
packages/coding-agent/src/core/extensions/types.ts       +15 lines (F-1.1, F-1.2)
packages/coding-agent/src/core/extensions/loader.ts      +25 lines
packages/coding-agent/src/core/event-bus.ts              +8 lines (F-2.3)
packages/coding-agent/src/modes/rpc/rpc-mode.ts          +30 lines (F-2.2)
packages/coding-agent/src/modes/rpc/rpc-types.ts         +90 lines (F-2.1)
packages/coding-agent/test/*                             +400 lines (tests)
extensions/fan-orchestrator/subagent-runner.js          +30 lines (F-2.4 stub)
extensions/fan-orchestrator/broker-handler.js            +40 lines (F-2.5)
extensions/fan-orchestrator/orchestrator-extension.js    +2 lines (F-2.5 wire-up)
extensions/fan-orchestrator/test/*                      +85 lines (tests)
packages/mcp-extension/ (new package)                   ~2000 lines (Phase 1)
  ├─ src/index.ts                                       ~50 lines
  ├─ src/config.ts                                      ~150 lines (F-1.8, F-1.11)
  ├─ src/transport.ts                                   ~80 lines (F-1.4, F-1.5)
  ├─ src/adapter.ts                                     ~160 lines (F-1.6, F-1.7)
  ├─ src/executor.ts                                    ~95 lines (F-1.7)
  ├─ src/timeout.ts                                     ~50 lines (F-1.13)
  ├─ src/permissions.ts                                 ~110 lines (F-1.9, F-1.10)
  ├─ src/manager.ts                                     ~200 lines (F-1.14..F-1.17)
  ├─ test/*.test.ts                                     ~1700 lines
  ├─ test/fixtures/*                                    ~80 lines
  └─ README.md, package.json, tsconfig                  ~250 lines
docs/features/mcp-integration/roadmap.md                synced
```

---

*Pipeline возобновлён успешно после фикса orchestrator (commit 23f69b2). Phase 1 P0 полностью завершён, Phase 2 на 71%.*
*F-2.4 сделана как stub (placeholder response); F-2.6 и F-2.7 требуют модификации CLI args + worker rpc-mode и рекомендуются для следующей сессии.*