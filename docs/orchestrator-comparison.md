# Orchestrator Comparison: Pi Sample vs FAN Copy

**Дата:** 2026-04-11  
**Образец:** `~\.pi\agent\extensions\orchestrator\` (7 модулей)  
**Копия:** `packages/orchestrator/src/` (6 модулей)  

---

## 1. Архитектурные различия

| Аспект | Pi (образец) | FAN (копия) |
|--------|-------------|-------------|
| **SDK** | `@mariozechner/pi-coding-agent` | `@itone/fan-coding-agent` |
| **TUI** | `@mariozechner/pi-tui` | `@itone/fan-tui` |
| **AI utils** | свой `StringEnum` helper (inline) | `StringEnum` из `@itone/fan-ai` |
| **Воркер-протокол** | `--mode rpc` (JSONL interactive) | `--mode json -p` (JSON pipe, single-shot) |
| **Конфигурация** | `config.json` + `config.ts` с defaults | конфиг вшит в код / отсутствует |
| **Agent definitions** | Hardcoded в `agents.ts` (TypeScript) | `.md` файлы с frontmatter (discoverable) |
| **Дизайн** | Coordinator mode (on/off), system prompt injection | Always-on, tool-based delegation |

---

## 2. Модуль-к-модулю

### 2.1 types.ts

| Тип / концепция | Pi | FAN | Статус |
|----------------|----|----|--------|
| `AgentType` | `"explore"\|"plan"\|"implement"\|"verify"` | `WorkerType` — то же самое | ✅ есть |
| `WorkerState` | `spawning\|running\|completed\|failed\|aborted` | нет (у `SingleResult` есть `exitCode`, `stopReason`) | ⚠️ другое |
| `TaskStatus` | `pending\|in_progress\|completed\|blocked\|failed` | то же самое | ✅ есть |
| `Task` (интерфейс) | `id, subject, description, status, owner, blocks, blockedBy, createdAt, updatedAt` | `SubagentTask` — `id, type, status, description, agentType, parentTaskId, blocks, result, error, usage, createdAt, updatedAt` | ⚠️ другое |
| `OrchestratorConfig` | cloud/local/auto, models, timeouts, dangerousCommands | **есть** | ✅ |
| `WorkerHandle` | registry handle | есть (Worker Registry) | ✅ |
| `WorkerResult` | `text, messageCount` | есть (Worker Registry) | ✅ |
| `WorkerProgress` | `status, messageCount, toolCalls[]` | есть | ✅ |
| `AgentDefinition` | `label, prompt, tools, readOnly` | `AgentConfig` — `name, description, tools?, model?, systemPrompt, source, filePath` | ⚠️ разное |
| `Waiter` | FIFO queue entry | есть (Slot Pool) | ✅ |
| `ToolCallInfo` | `name, preview` | есть | ✅ |
| `ExecutionMode` | нет (всегда single spawn) | `single\|parallel\|chain` | 🆕 только в FAN |
| `UsageStats` | нет | `input, output, cacheRead, cacheWrite, cost, contextTokens, turns` | 🆕 только в FAN |
| `AgentConfig` | нет | discoverable agents с frontmatter | 🆕 только в FAN |

### 2.2 config.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| config.json загрузка | ✅ `loadConfig()` | ✅ | ✅ |
| Cloud config (model, provider) | ✅ | ✅ | ✅ |
| Local config (model, provider) | ✅ | ✅ | ✅ |
| `providerMode: cloud/local/auto` | ✅ | ✅ | ✅ |
| `parallelWorkers` / `maxWorkers` | ✅ (slot pool) | ✅ (slot pool, configurable) | ✅ |
| `workerTimeout` | ✅ (300s default) | ✅ | ✅ |
| `planTimeout` | ✅ (300s) | ✅ | ✅ |
| `agentTimeouts` (per-type) | ✅ | ✅ | ✅ |
| `maxRetries` | ✅ (2) | ✅ (2) | ✅ |
| `dangerousCommands` | ✅ (regex patterns) | ✅ (8 patterns) | ✅ |
| `resolveModel()` | ✅ (agent + mode → model) | ✅ | ✅ |
| `getCloudHealth()` | ✅ (5-min cache) | ✅ | ✅ |
| `getCloudStatus()` | ✅ | ✅ | ✅ |

### 2.3 tasks.ts / task-manager.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| CRUD операции | ✅ (функциональный стиль) | ✅ (класс `TaskManager`) | ✅ оба |
| Dependency management (`blocks`/`blockedBy`) | ✅ (bidirectional linking) | ⚠️ (только `blocks[]` → unblock on complete) | ⚠️ FAN проще |
| Status transitions | нет валидации | ✅ `VALID_TRANSITIONS` | 🆕 только в FAN |
| `parseVerdict()` | ✅ | ✅ | ✅ |
| `formatTaskList()` | ✅ | ❌ (inline в command handler) | ⚠️ иначе |
| Owner tracking | ✅ | ✅ | ✅ |
| `taskCount()` | ✅ | ✅ (`size` getter) | ✅ |
| `clearCompleted()` | ❌ | ✅ | 🆕 только в FAN |
| `serialize()` | ❌ | ✅ | 🆕 только в FAN |
| `parentTaskId` | ❌ | ✅ | 🆕 только в FAN |

### 2.4 workers.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| Worker Registry (Map) | ✅ | ✅ | ✅ |
| `genWorkerId()` | ✅ | ✅ | ✅ |
| `registerWorker/getWorker/listWorkers` | ✅ | ✅ | ✅ |
| `activeWorkers()` | ✅ | ✅ | ✅ |
| `hasActiveWriteWorker()` | ✅ | ✅ | ✅ |
| Slot pool (acquire/release) | ✅ (Promise-based FIFO) | ✅ (Promise-based FIFO) | ✅ |
| Write slot (1 implement max) | ✅ | ✅ | ✅ |
| `getQueueLength()` | ✅ | ✅ | ✅ |
| `statusIcon/statusColor` | ✅ | ✅ | ✅ |

### 2.5 permissions.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| `isDangerousCommand()` | ✅ (8 regex patterns) | ✅ (8 patterns) | ✅ |
| `tool_call` event handler | ✅ (block/allow UI) | ✅ (block/allow UI) | ✅ |

### 2.6 agents.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| 4 agent definitions (hardcoded) | ✅ (explore, plan, implement, verify) | ❌ (.md files instead) | ⚠️ иначе |
| `COORDINATOR_PROMPT` | ✅ (подробный system prompt) | ✅ (adapted for FAN tools) | ✅ |
| `PLANNING_PROMPT` | ✅ | ✅ | ✅ |
| `formatTaskNotification()` | ✅ (XML format) | ✅ (XML format) | ✅ |
| Agent discovery (.md) | ❌ | ✅ (builtin/user/project) | 🆕 только в FAN |
| Agent override by scope | ❌ | ✅ | 🆕 только в FAN |

### 2.7 rpc.ts / subagent-runner.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| Protocol | `--mode rpc` (interactive JSONL) | `--mode json -p` (pipe) | ⚠️ разное |
| `runWorker()` | ✅ (JSONL poll loop) | ✅ (`runSingleAgent`, JSON pipe) | ✅ оба |
| Retry logic | ✅ `runWorkerWithRetry()` | ✅ `runWorkerWithRetry()` | ✅ |
| Cloud→local fallback | ✅ `runWorkerWithFallback()` | ✅ `runWorkerWithFallback()` | ✅ |
| Progress callback | ✅ (`WorkerProgress`) | ✅ (via `emitUpdate`) | ✅ |
| Tool call preview | ✅ (`formatToolPreview`) | ✅ (`formatToolCall`) | ✅ оба |
| Concurrency limit | ❌ (slot pool handles it) | ✅ `mapWithConcurrencyLimit()` | 🆕 только в FAN |
| Parallel execution | ❌ (1 spawn per Agent call) | ✅ (parallel mode) | 🆕 только в FAN |
| Chain execution | ❌ | ✅ (sequential with `{previous}`) | 🆕 только в FAN |
| Abort support | ✅ (AbortSignal) | ✅ (AbortSignal) | ✅ оба |
| Usage tracking | ❌ (messageCount only) | ✅ (full UsageStats) | 🆕 только в FAN |

### 2.8 index.ts / orchestrator-extension.ts + orchestrator-tools.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| Coordinator mode toggle | ✅ (`coordinatorActive` flag) | ✅ (`coordinatorActive` flag, Alt+O) | ✅ |
| Coordinator system prompt injection | ✅ (`before_agent_start` event) | ✅ (`before_agent_start` event) | ✅ |
| `/plan` command | ✅ (explore → approve/revise → implement) | ✅ (explore → approve/revise/reject) | ✅ |
| `/orchestrator` command | ✅ (on/off/status/stop/config/mode/retry) | ✅ (on/off/stop/config/mode/retry/status) | ✅ |
| `/tasks` command | ❌ (через TaskList tool) | ✅ | 🆕 только в FAN |
| `/agents` command | ❌ | ✅ | 🆕 только в FAN |
| `/delegate` command | ❌ | ✅ | 🆕 только в FAN |
| `TaskCreate` tool | ✅ | ✅ | ✅ |
| `TaskUpdate` tool | ✅ | ✅ | ✅ |
| `TaskList` tool | ✅ | ✅ (`list_tasks`) | ✅ есть |
| `Agent` tool | ✅ (single spawn, coordinator-only) | ✅ (`delegate_task` single/parallel/chain) | ✅ |
| `SendMessage` tool | ✅ | ✅ | ✅ |
| `StopAgent` tool | ✅ | ✅ (`cancel_task`) | ✅ |
| `classify_task` tool | ❌ | ✅ | 🆕 только в FAN |
| `renderCall/renderResult` | ✅ (Agent tool) | ✅ (delegate_task) | ✅ оба |
| Task widget (`Alt+T`) | ✅ (collapsible checklist) | ✅ (collapsible checklist) | ✅ |
| Shortcut `Alt+O` | ✅ (toggle coordinator) | ✅ (toggle coordinator) | ✅ |
| `turn_end` event (widget update) | ✅ | ✅ | ✅ |
| `session_start/status` bar | ✅ | ✅ | ✅ |
| `session_shutdown` cleanup | ✅ (abort workers, clear widgets) | ✅ (abort workers, clear widgets) | ✅ |
| Permission system (tool_call event) | ✅ | ✅ (isDangerousCommand + block/allow UI) | ✅ |

---

## 3. Уникальные возможности FAN (отсутствующие в Pi)

| Элемент | Описание |
|---------|----------|
| **Parallel mode** | `tasks[]` — одновременный запуск нескольких агентов |
| **Chain mode** | `chain[]` — последовательный запуск с `{previous}` placeholder |
| **Agent discovery** | `.md` файлы из builtin/user/project директорий |
| **Project agent confirmation** | UI prompt перед запуском project-local агентов |
| **Status transition validation** | `VALID_TRANSITIONS` в TaskManager |
| **Full usage tracking** | `UsageStats` с tokens, cost, cache |
| **`/delegate` command** | Quick delegate из CLI |
| **`/agents` command** | List available agents |
| **Task serialization** | `serialize()` для persistence |
| **`parentTaskId`** | Иерархия задач |

---

## 4. План реализации недостающих элементов из Pi

### Фаза 1: Конфигурация и инфраструктура (приоритет: 🔴 высокий) ✅ ЗАВЕРШЕНА

#### 1.1 Config module
- [x] Создать `src/config.ts` по аналогии с Pi `config.ts`
- [x] Реализовать `OrchestratorConfig` интерфейс (cloud/local/auto, models, timeouts, retries)
- [x] `loadConfig()` — загрузка из `config.json` с fallback на defaults
- [x] `resolveModel()` — выбор модели по agentType + providerMode
- [x] `getCloudHealth()` / `getCloudStatus()` — health check с кэшем
- [x] Defaults: `parallelWorkers=3`, `workerTimeout=300s`, `planTimeout=300s`, `maxRetries=2`

#### 1.2 Worker Registry + Slot Pool
- [x] Создать `src/workers.ts` по аналогии с Pi `workers.ts`
- [x] Worker Registry: `genWorkerId`, `registerWorker`, `getWorker`, `listWorkers`, `activeWorkers`
- [x] Slot pool: `acquireSlot()` (Promise-based), `releaseSlot()` (FIFO queue)
- [x] Write slot: максимум 1 implement worker одновременно
- [x] `statusIcon()`, `statusColor()` helpers
- [x] Интегрировать `workers.ts` в `orchestrator-tools.ts`

#### 1.3 Permission System
- [x] Создать `src/permissions.ts` по аналогии с Pi `permissions.ts`
- [x] `isDangerousCommand()` — 8 regex patterns (rm -rf, git push --force, etc.)
- [x] Handler для `tool_call` event → `ctx.ui.select("Block", "Allow")`
- [x] Зарегистрировать в `orchestrator-extension.ts`

### Фаза 2: Coordinator Mode (приоритет: 🔴 высокий) ✅ ЗАВЕРШЕНА

#### 2.1 Coordinator toggle
- [x] Добавить `coordinatorActive` flag в extension
- [x] Shortcut `Alt+O` — toggle coordinator
- [x] Status bar update (`ctx.ui.setStatus`) при toggle

#### 2.2 Coordinator system prompt
- [x] Добавить `COORDINATOR_PROMPT` в `agents.ts` (адаптированный под FAN tool names)
- [x] Handler для `before_agent_start` event — inject prompt when coordinator active
- [x] Инструкции: делегируй через `delegate_task`, не делай сам

#### 2.3 Task tools (LLM-callable)
- [x] `TaskCreate` tool — register через `pi.registerTool()`, делегирует в `TaskManager`
- [x] `TaskUpdate` tool — с `blocks[]` для dependencies, auto-unblock
- [x] Обновить `TaskManager` для работы с `owner` полем

### Фаза 3: /plan Command (приоритет: 🟡 средний) ✅ ЗАВЕРШЕНА

#### 3.1 Planning workflow
- [x] Добавить `PLANNING_PROMPT` в `agents.ts`
- [x] Регистрация `/plan <task>` command
- [x] Spawn explore worker → generate plan
- [x] `approveOrRevise()` — UI select (Approve / Revise / Reject)
- [x] On approve: auto-enable coordinator, inject plan into conversation
- [x] On revise: re-run with feedback

### Фаза 4: Retry & Fallback (приоритет: 🟡 средний) ✅ ЗАВЕРШЕНА

#### 4.1 Retry logic
- [x] `runWorkerWithRetry()` в `subagent-runner.ts`
- [x] Retry up to `config.maxRetries` times
- [x] Don't retry on abort (AbortSignal)

#### 4.2 Cloud→local fallback
- [x] `runWorkerWithFallback()` — try cloud, fallback to local
- [x] Check `getCloudStatus()` before attempting cloud
- [x] Интегрировать с `delegate_task` tool

### Фаза 5: Task Widget & UI Enhancements (приоритет: 🟢 низкий) ✅ ЗАВЕРШЕНА

#### 5.1 Task checklist widget
- [x] `updateTaskWidget()` — collapsible checklist above editor
- [x] Auto-hide when no active tasks
- [x] Shortcut `Alt+T` — toggle collapse
- [x] Update on `turn_end` event

#### 5.2 Enhanced /orchestrator command
- [x] `/orchestrator stop` — abort all active workers
- [x] `/orchestrator config` — show current config
- [x] `/orchestrator mode` — switch cloud/local/auto
- [x] `/orchestrator retry` — retry last failed task

#### 5.3 Session lifecycle
- [x] `session_start`: restore status bar + widget
- [x] `session_shutdown`: abort all workers, clear widgets, clear status

### Фаза 6: Notifications & Verification (приоритет: 🟢 низкий) ✅ ЗАВЕРШЕНА

#### 6.1 Task notification format
- [x] `formatTaskNotification()` — XML format (адаптировать под FAN)
- [x] Использовать в `delegate_task` result для coordinator parsing

#### 6.2 Verification verdict
- [x] `parseVerdict()` — извлечь `VERDICT: PASS/FAIL/PARTIAL`
- [x] Показать verdict в delegate_task result для verify агентов

#### 6.3 SendMessage tool
- [x] `SendMessage` tool — отправить steer message running worker
- [ ] Требует поддержки steer в `--mode json` (или переключение на rpc)

---

## 5. Зависимости между фазами

```
Фаза 1.1 (Config) ─────────────────────┐
Фаза 1.2 (Workers + Slot Pool) ────────┤
                                         ├─→ Фаза 2 (Coordinator) ─→ Фаза 3 (/plan)
Фаза 1.3 (Permissions) ────────────────┘
                                                               │
                                         Фаза 4 (Retry) ──────┤
                                                               │
                                         Фаза 5 (UI) ─────────┤
                                                               │
                                         Фаза 6 (Notifications)┘
```

## 6. Оценка объёма

| Фаза | Новые файлы | Изменения | ~ LOC |
|------|------------|-----------|-------|
| Фаза 1 | `config.ts`, `workers.ts`, `permissions.ts` | `types.ts`, `orchestrator-extension.ts` | ~400 |
| Фаза 2 | — | `agents.ts`, `orchestrator-tools.ts`, `orchestrator-extension.ts` | ~200 |
| Фаза 3 | — | `agents.ts`, `orchestrator-extension.ts` | ~150 |
| Фаза 4 | — | `subagent-runner.ts` | ~80 |
| Фаза 5 | — | `orchestrator-extension.ts` | ~200 |
| Фаза 6 | — | `agents.ts`, `orchestrator-tools.ts` | ~80 |
| **Итого** | **3 файла** | **5 файлов** | **~1100** |
