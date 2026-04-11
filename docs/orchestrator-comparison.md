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
| `OrchestratorConfig` | cloud/local/auto, models, timeouts, dangerousCommands | **нет** | ❌ отсутствует |
| `WorkerHandle` | registry handle | нет (results inline в `SingleResult`) | ⚠️ другое |
| `WorkerResult` | `text, messageCount` | нет (есть `SingleResult.messages`) | ⚠️ другое |
| `WorkerProgress` | `status, messageCount, toolCalls[]` | нет | ❌ отсутствует |
| `AgentDefinition` | `label, prompt, tools, readOnly` | `AgentConfig` — `name, description, tools?, model?, systemPrompt, source, filePath` | ⚠️ разное |
| `Waiter` | FIFO queue entry | нет (нет slot pool) | ❌ отсутствует |
| `ToolCallInfo` | `name, preview` | нет | ❌ отсутствует |
| `ExecutionMode` | нет (всегда single spawn) | `single\|parallel\|chain` | 🆕 только в FAN |
| `UsageStats` | нет | `input, output, cacheRead, cacheWrite, cost, contextTokens, turns` | 🆕 только в FAN |
| `AgentConfig` | нет | discoverable agents с frontmatter | 🆕 только в FAN |

### 2.2 config.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| config.json загрузка | ✅ `loadConfig()` | ❌ | **Отсутствует** |
| Cloud config (model, provider) | ✅ | ❌ | **Отсутствует** |
| Local config (model, provider) | ✅ | ❌ | **Отсутствует** |
| `providerMode: cloud/local/auto` | ✅ | ❌ | **Отсутствует** |
| `parallelWorkers` / `maxWorkers` | ✅ (slot pool) | `MAX_CONCURRENCY = 4` (hardcoded) | ⚠️ hardcoded |
| `workerTimeout` | ✅ (300s default) | ❌ (no timeout) | **Отсутствует** |
| `planTimeout` | ✅ (300s) | ❌ | **Отсутствует** |
| `agentTimeouts` (per-type) | ✅ | ❌ | **Отсутствует** |
| `maxRetries` | ✅ (2) | ❌ (0 retries) | **Отсутствует** |
| `dangerousCommands` | ✅ (regex patterns) | ❌ | **Отсутствует** |
| `resolveModel()` | ✅ (agent + mode → model) | ❌ (agent.model from .md) | ⚠️ иначе |
| `getCloudHealth()` | ✅ (5-min cache) | ❌ | **Отсутствует** |
| `getCloudStatus()` | ✅ | ❌ | **Отсутствует** |

### 2.3 tasks.ts / task-manager.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| CRUD операции | ✅ (функциональный стиль) | ✅ (класс `TaskManager`) | ✅ оба |
| Dependency management (`blocks`/`blockedBy`) | ✅ (bidirectional linking) | ⚠️ (только `blocks[]` → unblock on complete) | ⚠️ FAN проще |
| Status transitions | нет валидации | ✅ `VALID_TRANSITIONS` | 🆕 только в FAN |
| `parseVerdict()` | ✅ | ❌ | **Отсутствует** |
| `formatTaskList()` | ✅ | ❌ (inline в command handler) | ⚠️ иначе |
| Owner tracking | ✅ | ❌ | **Отсутствует** |
| `taskCount()` | ✅ | ✅ (`size` getter) | ✅ |
| `clearCompleted()` | ❌ | ✅ | 🆕 только в FAN |
| `serialize()` | ❌ | ✅ | 🆕 только в FAN |
| `parentTaskId` | ❌ | ✅ | 🆕 только в FAN |

### 2.4 workers.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| Worker Registry (Map) | ✅ | ❌ (results only in SingleResult) | **Отсутствует** |
| `genWorkerId()` | ✅ | ❌ (UUID в TaskManager) | ⚠️ иначе |
| `registerWorker/getWorker/listWorkers` | ✅ | ❌ | **Отсутствует** |
| `activeWorkers()` | ✅ | ❌ | **Отсутствует** |
| `hasActiveWriteWorker()` | ✅ | ❌ | **Отсутствует** |
| Slot pool (acquire/release) | ✅ (Promise-based FIFO) | ❌ (hardcoded concurrency) | **Отсутствует** |
| Write slot (1 implement max) | ✅ | ❌ | **Отсутствует** |
| `getQueueLength()` | ✅ | ❌ | **Отсутствует** |
| `statusIcon/statusColor` | ✅ | ❌ (inline) | ⚠️ иначе |

### 2.5 permissions.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| `isDangerousCommand()` | ✅ (8 regex patterns) | ❌ | **Полностью отсутствует** |
| `tool_call` event handler | ✅ (block/allow UI) | ❌ | **Полностью отсутствует** |

### 2.6 agents.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| 4 agent definitions (hardcoded) | ✅ (explore, plan, implement, verify) | ❌ (.md files instead) | ⚠️ иначе |
| `COORDINATOR_PROMPT` | ✅ (подробный system prompt) | ❌ | **Отсутствует** |
| `PLANNING_PROMPT` | ✅ | ❌ | **Отсутствует** |
| `formatTaskNotification()` | ✅ (XML format) | ❌ | **Отсутствует** |
| Agent discovery (.md) | ❌ | ✅ (builtin/user/project) | 🆕 только в FAN |
| Agent override by scope | ❌ | ✅ | 🆕 только в FAN |

### 2.7 rpc.ts / subagent-runner.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| Protocol | `--mode rpc` (interactive JSONL) | `--mode json -p` (pipe) | ⚠️ разное |
| `runWorker()` | ✅ (JSONL poll loop) | ✅ (`runSingleAgent`, JSON pipe) | ✅ оба |
| Retry logic | ✅ `runWorkerWithRetry()` | ❌ | **Отсутствует** |
| Cloud→local fallback | ✅ `runWorkerWithFallback()` | ❌ | **Отсутствует** |
| Progress callback | ✅ (`WorkerProgress`) | ✅ (via `emitUpdate`) | ⚠️ иначе |
| Tool call preview | ✅ (`formatToolPreview`) | ✅ (`formatToolCall`) | ✅ оба |
| Concurrency limit | ❌ (slot pool handles it) | ✅ `mapWithConcurrencyLimit()` | 🆕 только в FAN |
| Parallel execution | ❌ (1 spawn per Agent call) | ✅ (parallel mode) | 🆕 только в FAN |
| Chain execution | ❌ | ✅ (sequential with `{previous}`) | 🆕 только в FAN |
| Abort support | ✅ (AbortSignal) | ✅ (AbortSignal) | ✅ оба |
| Usage tracking | ❌ (messageCount only) | ✅ (full UsageStats) | 🆕 только в FAN |

### 2.8 index.ts / orchestrator-extension.ts + orchestrator-tools.ts

| Элемент | Pi | FAN | Статус |
|---------|----|----|--------|
| Coordinator mode toggle | ✅ (`coordinatorActive` flag) | ❌ (always active) | **Отсутствует** |
| Coordinator system prompt injection | ✅ (`before_agent_start` event) | ❌ | **Отсутствует** |
| `/plan` command | ✅ (explore → approve/revise → implement) | ❌ | **Полностью отсутствует** |
| `/orchestrator` command | ✅ (on/off/status/stop/config/mode/retry) | ⚠️ (on/off/status only) | **Сильно урезан** |
| `/tasks` command | ❌ (через TaskList tool) | ✅ | 🆕 только в FAN |
| `/agents` command | ❌ | ✅ | 🆕 только в FAN |
| `/delegate` command | ❌ | ✅ | 🆕 только в FAN |
| `TaskCreate` tool | ✅ | ❌ (есть `createTask` в TaskManager, но не как tool) | **Отсутствует как tool** |
| `TaskUpdate` tool | ✅ | ❌ | **Отсутствует как tool** |
| `TaskList` tool | ✅ | ✅ (`list_tasks`) | ✅ есть |
| `Agent` tool | ✅ (single spawn, coordinator-only) | ✅ (`delegate_task` single/parallel/chain) | ⚠️ иначе |
| `SendMessage` tool | ✅ | ❌ | **Отсутствует** |
| `StopAgent` tool | ✅ | ❌ (`cancel_task` аналог) | ⚠️ частично |
| `classify_task` tool | ❌ | ✅ | 🆕 только в FAN |
| `renderCall/renderResult` | ✅ (Agent tool) | ✅ (delegate_task) | ✅ оба |
| Task widget (`Alt+T`) | ✅ (collapsible checklist) | ❌ | **Отсутствует** |
| Shortcut `Alt+O` | ✅ (toggle coordinator) | ❌ | **Отсутствует** |
| `turn_end` event (widget update) | ✅ | ❌ | **Отсутствует** |
| `session_start/status` bar | ✅ | ⚠️ (только console.log) | ⚠️ урезан |
| `session_shutdown` cleanup | ✅ (abort workers, clear widgets) | ⚠️ (console.log) | ⚠️ урезан |
| Permission system (tool_call event) | ✅ | ❌ | **Полностью отсутствует** |

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

### Фаза 1: Конфигурация и инфраструктура (приоритет: 🔴 высокий)

#### 1.1 Config module
- [ ] Создать `src/config.ts` по аналогии с Pi `config.ts`
- [ ] Реализовать `OrchestratorConfig` интерфейс (cloud/local/auto, models, timeouts, retries)
- [ ] `loadConfig()` — загрузка из `config.json` с fallback на defaults
- [ ] `resolveModel()` — выбор модели по agentType + providerMode
- [ ] `getCloudHealth()` / `getCloudStatus()` — health check с кэшем
- [ ] Defaults: `parallelWorkers=3`, `workerTimeout=300s`, `planTimeout=300s`, `maxRetries=2`

#### 1.2 Worker Registry + Slot Pool
- [ ] Создать `src/workers.ts` по аналогии с Pi `workers.ts`
- [ ] Worker Registry: `genWorkerId`, `registerWorker`, `getWorker`, `listWorkers`, `activeWorkers`
- [ ] Slot pool: `acquireSlot()` (Promise-based), `releaseSlot()` (FIFO queue)
- [ ] Write slot: максимум 1 implement worker одновременно
- [ ] `statusIcon()`, `statusColor()` helpers
- [ ] Интегрировать `workers.ts` в `orchestrator-tools.ts`

#### 1.3 Permission System
- [ ] Создать `src/permissions.ts` по аналогии с Pi `permissions.ts`
- [ ] `isDangerousCommand()` — 8 regex patterns (rm -rf, git push --force, etc.)
- [ ] Handler для `tool_call` event → `ctx.ui.select("Block", "Allow")`
- [ ] Зарегистрировать в `orchestrator-extension.ts`

### Фаза 2: Coordinator Mode (приоритет: 🔴 высокий)

#### 2.1 Coordinator toggle
- [ ] Добавить `coordinatorActive` flag в extension
- [ ] Shortcut `Alt+O` — toggle coordinator
- [ ] Status bar update (`ctx.ui.setStatus`) при toggle

#### 2.2 Coordinator system prompt
- [ ] Добавить `COORDINATOR_PROMPT` в `agents.ts` (адаптированный под FAN tool names)
- [ ] Handler для `before_agent_start` event — inject prompt when coordinator active
- [ ] Инструкции: делегируй через `delegate_task`, не делай сам

#### 2.3 Task tools (LLM-callable)
- [ ] `TaskCreate` tool — register через `pi.registerTool()`, делегирует в `TaskManager`
- [ ] `TaskUpdate` tool — с `blocks[]` для dependencies, auto-unblock
- [ ] Обновить `TaskManager` для работы с `owner` полем

### Фаза 3: /plan Command (приоритет: 🟡 средний)

#### 3.1 Planning workflow
- [ ] Добавить `PLANNING_PROMPT` в `agents.ts`
- [ ] Регистрация `/plan <task>` command
- [ ] Spawn explore worker → generate plan
- [ ] `approveOrRevise()` — UI select (Approve / Revise / Reject)
- [ ] On approve: auto-enable coordinator, inject plan into conversation
- [ ] On revise: re-run with feedback

### Фаза 4: Retry & Fallback (приоритет: 🟡 средний)

#### 4.1 Retry logic
- [ ] `runWorkerWithRetry()` в `subagent-runner.ts`
- [ ] Retry up to `config.maxRetries` times
- [ ] Don't retry on abort (AbortSignal)

#### 4.2 Cloud→local fallback
- [ ] `runWorkerWithFallback()` — try cloud, fallback to local
- [ ] Check `getCloudStatus()` before attempting cloud
- [ ] Интегрировать с `delegate_task` tool

### Фаза 5: Task Widget & UI Enhancements (приоритет: 🟢 низкий)

#### 5.1 Task checklist widget
- [ ] `updateTaskWidget()` — collapsible checklist above editor
- [ ] Auto-hide when no active tasks
- [ ] Shortcut `Alt+T` — toggle collapse
- [ ] Update on `turn_end` event

#### 5.2 Enhanced /orchestrator command
- [ ] `/orchestrator stop` — abort all active workers
- [ ] `/orchestrator config` — show current config
- [ ] `/orchestrator mode` — switch cloud/local/auto
- [ ] `/orchestrator retry` — retry last failed task

#### 5.3 Session lifecycle
- [ ] `session_start`: restore status bar + widget
- [ ] `session_shutdown`: abort all workers, clear widgets, clear status

### Фаза 6: Notifications & Verification (приоритет: 🟢 низкий)

#### 6.1 Task notification format
- [ ] `formatTaskNotification()` — XML format (адаптировать под FAN)
- [ ] Использовать в `delegate_task` result для coordinator parsing

#### 6.2 Verification verdict
- [ ] `parseVerdict()` — извлечь `VERDICT: PASS/FAIL/PARTIAL`
- [ ] Показать verdict в delegate_task result для verify агентов

#### 6.3 SendMessage tool
- [ ] `SendMessage` tool — отправить steer message running worker
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
