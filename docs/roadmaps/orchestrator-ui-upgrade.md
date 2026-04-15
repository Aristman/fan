# Orchestrator UI Upgrade — Roadmap

> Перенятие UI-решений и архитектурных паттернов из upstream `~/.pi/agent/extensions/orchestrator/` во встроенный FAN-оркестратор.

**Создано:** 2026-04-15  
**Статус:** Planned  
**Бранч:** `FAN/orchestrator-ui-upgrade`  
**Источник:** Сравнение upstream (2 634 строки, 12 файлов) vs FAN (`packages/orchestrator/`)

---

## Контекст

### Проблема
1. **Сломанный тасклист** — виджет не показывает обновления статуса при работе оркестратора. Widget обновляется через `updateTaskWidget()` на `turn_end` и `tool_result`, но LLM-координатор (я) не вызывает `TaskCreate`/`TaskUpdate` при делегировании — поэтому widget пустой.
2. **Raw ANSI в widget** — вместо `theme.fg()` используются сырые escape-коды `\x1b[92m`.
3. **Notify вместо Widget** — `/orchestrator status` и `/orchestrator config` показывают через `ctx.ui.notify()` (стенки текста), вместо компактного виджета.
4. **Нет auto-clear тасок** — widget остаётся висеть после завершения всех задач.
5. **Нет slot pool** — воркеры запускаются без ограничений на параллелизм и без write-lock для implement.
6. **Нет verdict-парсинга** — verify-результат не парсится на `VERDICT: PASS/FAIL/PARTIAL`.

### Upstream reference
```
~/.pi/agent/extensions/orchestrator/
├── index.ts            (841 строк)  — entry point, widgets, renderCall/renderResult
├── agents.ts           (317 строк)  — 4 agent definitions, COORDINATOR_PROMPT, XML notifications
├── rpc.ts              (374 строк)  — worker spawn via JSONL, retry/fallback
├── workers.ts          (124 строк)  — worker registry, slot pool, write lock
├── tasks.ts            (186 строк)  — task registry, bidirectional dependency linking
├── config.ts           (141 строк)  — config loading, model resolution, cloud health
├── types.ts            (109 строк)  — all types
├── permissions.ts      (34 строки)  — regex dangerous command detection
├── config.json         (66 строк)   — user config
├── config.example.json (43 строки)  — example
├── config.schema.json  (130 строк)  — JSON Schema
└── README.md           (269 строк)  — documentation (ru)
```

### FAN reference
```
packages/orchestrator/src/
├── orchestrator-extension.ts  (510 строк)  — extension entry, widgets, commands
├── orchestrator-tools.ts      (1004 строки) — delegate_task, TaskCreate, TaskUpdate, etc.
├── subagent-runner.ts         (460 строк)  — worker subprocess, retry, fallback
├── agents.ts                  — agent discovery, COORDINATOR_PROMPT
├── task-manager.ts            (312 строк)  — TaskManager class
├── config.ts                  — config loading
├── types.ts                   — all types
├── workers.ts                 — worker registry
├── permissions.ts             — dangerous command detection
└── index.ts                   — package exports
```

---

## Приоритет 1 — UI (критично)

### 1.1 Эмодзи-иконки для типов агентов

**Источник:** `upstream/index.ts:73-78` — `AGENT_ICONS` mapping

**Что делать:** Добавить `AGENT_ICONS` в `orchestrator-tools.ts` и использовать в `renderCall`/`renderResult`.

```typescript
// upstream
const AGENT_ICONS: Record<string, string> = {
  explore: "🔍",
  plan: "📋",
  implement: "🔧",
  verify: "🛡️",
};
```

**Файлы:** `packages/orchestrator/src/orchestrator-tools.ts`

**Текущее:**
```
EXPLORE worker (claude-sonnet-4-20250514)
```

**Целевое:**
```
🔍 EXPLORE worker (claude-sonnet-4-20250514)
```

---

### 1.2 theme.fg() вместо raw ANSI в widget тасок

**Источник:** `upstream/index.ts:110-145` — `updateTaskWidget()` использует `theme.fg("warning", ...)`, `theme.fg("success", ...)`, `theme.fg("error", ...)`, `theme.strikethrough(...)`

**Что делать:** Заменить сырые ANSI escape-коды на `ctx.ui.theme.fg()` в `updateTaskWidget()`.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`

**Текущее (строки ~70-100):**
```typescript
if (isDone(t)) {
  return `  \x1b[2m\x1b[9m${icon} ${desc}${deps}${owner}\x1b[0m`;
}
if (t.status === "in_progress") {
  return `  \x1b[92m${icon} ${desc}${deps}${owner}\x1b[0m`;
}
return `  ${icon} ${desc}${deps}${owner}`;
```

**Целевое:**
```typescript
const theme = ctx.ui.theme;
if (t.status === "in_progress") {
  lines.push(theme.fg("warning", theme.bold("◐ ")) + theme.fg("warning", theme.bold(desc)));
} else if (t.status === "blocked") {
  lines.push(theme.fg("muted", "⛔ ") + theme.fg("dim", desc));
} else if (t.status === "failed") {
  lines.push(theme.fg("error", "✗ ") + theme.fg("error", desc));
} else if (t.status === "completed") {
  lines.push(theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(desc)));
} else {
  lines.push(theme.fg("muted", "☐ ") + desc);
}
```

---

### 1.3 Auto-hide + auto-clear тасок

**Источник:** `upstream/index.ts:101-108` — при `activeOrPending.length === 0` вызывает `clearTasks()` и скрывает widget.

**Что делать:** В `updateTaskWidget()` проверять есть ли активные таски. Если все completed/failed — скрывать widget и очищать registry.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`

**Текущее:**
```typescript
if (tasks.length === 0) {
  ctx.ui.setWidget("orchestrator-tasks", undefined);
  return;
}
```

**Целевое:**
```typescript
const activeOrPending = tasks.filter(t => t.status !== "completed" && t.status !== "failed");
if (tasks.length === 0 || activeOrPending.length === 0) {
  taskManager.clearCompleted();
  ctx.ui.setWidget("orchestrator-tasks", undefined);
  return;
}
```

---

### 1.4 /orchestrator status через widget вместо notify

**Источник:** `upstream/index.ts:745-790` — показывает статус в `ctx.ui.setWidget("orchestrator", lines)` с таймаутом 10 секунд.

**Что делать:** Заменить `ctx.ui.notify()` на `ctx.ui.setWidget("orchestrator", statusLines)` с `setTimeout(() => setWidget(undefined), 10_000)`.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`, case `status`

**Текущее:**
```typescript
ctx.ui.notify(lines.join("\n"));
```

**Целевое:**
```typescript
ctx.ui.setWidget("orchestrator", statusLines);
setTimeout(() => { ctx.ui.setWidget("orchestrator", undefined); }, 10_000);
```

**Формат widget (из upstream):**
```
🎭 Orchestration: ON/OFF
📡 Provider: cloud
👷 Active: 2 / 3 | Queue: 1

── Workers ──
  🔄 worker-xxx  explore (model) — running [12s]
  ✅ worker-yyy  implement (model) — completed [45s]

── Tasks ──
  📊 2/5 done
  🔄 task-abc: Find config files
  ⏳ task-def: Plan refactor
```

---

### 1.5 /orchestrator config через widget

**Источник:** `upstream/index.ts:810-820` — компактный 3-строчный widget.

**Что делать:** Показывать конфигурацию в widget, не в notify.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`, case `config`

**Целевое (из upstream):**
```
📊 CLOUD | Parallel: 3 | Queue: 10 | Worker: 300s | Plan: 300s | Retries: 2
☁️ claude-sonnet-4-20250514 (explore=..., plan=..., implement=..., verify=...)
🏠 ollama/qwen3:32b (explore=ollama/qwen3:14b, ...)
🚫 Dangerous: 7 patterns
```

---

### 1.6 Status bar с provider mode

**Источник:** `upstream/index.ts:127-131,152-155` — показывает provider mode в статус-баре.

**Что делать:** Добавить provider mode в статус-бар.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`

**Текущее:**
```typescript
ctx.ui.setStatus("2-orchestrator", "🔄 Coordinator");
// off:
ctx.ui.setStatus("2-orchestrator", undefined);
```

**Целевое:**
```typescript
ctx.ui.setStatus("2-orchestrator", "🎭 Coordinator ON");
// off:
ctx.ui.setStatus("2-orchestrator", `🎭 Orchestrator (${config.providerMode})`);
```

---

### 1.7 Widget collapse формат

**Источник:** `upstream/index.ts:119-122` — `📋 N/M tasks  [Alt+T to expand]`

**Что делать:** Обновить формат collapsed widget.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`

**Текущее:**
```
Orchestrator Tasks (2 active, 1 done) — Alt+T to expand
```

**Целевое:**
```
📋 1/3 tasks  [Alt+T to expand]
```

---

### 1.8 Worker progress: добавить messageCount в footer

**Источник:** `upstream/index.ts:64-81` — `buildWorkerStatusText` показывает `N tool calls · N messages`

**Что делать:** В renderResult (single, running) добавить messageCount в статус-строку.

**Файл:** `packages/orchestrator/src/orchestrator-tools.ts`

**Текущее (single running):**
```
⏳ EXPLORE worker (model)
→ tool calls...
```

**Целевое:**
```
⏳ EXPLORE worker (model)
Processing · 5 tool calls · 12 messages
→ tool calls...
```

Для этого нужно добавить `messageCount` в `WorkerProgress` (или считать из `messages`).

---

### 1.9 Auto-create tasks для delegate_task воркеров

**Источник:** `upstream/index.ts:320-325` — `Agent` tool автоматически создаёт `TaskCreate` перед запуском воркера и `TaskUpdate(task.id, { status: "in_progress" })`.

**Что делать:** В `execute` delegate_task автоматически создавать таску для воркера. Это решает основную проблему «сломанного тасклиста» — widget будет обновляться при каждом delegate_task.

**Файл:** `packages/orchestrator/src/orchestrator-tools.ts`

```typescript
// В execute delegate_task (single mode):
const taskSubject = task.slice(0, 80);
const createdTask = taskManager.createTask({ subject: taskSubject, description: task.slice(0, 500) });
taskManager.updateTask(createdTask.id, { status: "in_progress", owner: agentName });

// На успех:
taskManager.updateTask(createdTask.id, { status: "completed" });

// На ошибку:
taskManager.updateTask(createdTask.id, { status: "failed", error: err.message });
```

Для chain/parallel — создавать таску на каждый шаг/воркер.

---

## Приоритет 2 — Архитектура

### 2.1 Slot pool + write lock

**Источник:** `upstream/workers.ts:47-92` — `acquireSlot()`, `releaseSlot()`, FIFO queue, `activeWriteSlots` (max 1 implement).

**Что делать:** Реализовать в FAN `packages/orchestrator/src/workers.ts`.

**Текущее:** Нет пула — все воркеры запускаются параллельно без ограничений.

**Целевое:**
- `parallelWorkers` (config, default 3) — макс. одновременно запущенных воркеров
- `activeWriteSlots` — только 1 implement-воркер за раз
- FIFO queue — если слоты заняты, воркер ждёт (`await acquireSlot()`)
- `releaseSlot()` — освобождает слот и запускает следующего из очереди

**Файл:** `packages/orchestrator/src/workers.ts` (добавить), `packages/orchestrator/src/orchestrator-tools.ts` (использовать)

**Конфиг** (уже есть в FAN):
```typescript
config.parallelWorkers  // default 3
```

---

### 2.2 parseVerdict — извлечение VERDICT из verify

**Источник:** `upstream/tasks.ts:176-180` — `parseVerdict()` regex

```typescript
export function parseVerdict(text: string): "PASS" | "FAIL" | "PARTIAL" | null {
  const match = text.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
  return (match?.[1]?.toUpperCase() as "PASS" | "FAIL" | "PARTIAL") ?? null;
}
```

**Что делать:** Добавить `parseVerdict` в `task-manager.ts` или `orchestrator-tools.ts`. Использовать в COORDINATOR_PROMPT и в delegate_task при verify.

**Файл:** `packages/orchestrator/src/task-manager.ts`

---

### 2.3 TaskList tool (read-only с фильтром)

**Источник:** `upstream/index.ts:268-292` — `TaskList` tool с фильтром по status/owner.

**Что делать:** FAN уже имеет `list_tasks` в orchestrator-tools.ts. Проверить API-совместимость. Если нужно — добавить фильтр по `owner`.

**Файл:** `packages/orchestrator/src/orchestrator-tools.ts`

---

### 2.4 StopAgent tool

**Источник:** `upstream/index.ts:417-440` — `StopAgent` tool для остановки воркера по ID.

**Что делать:** Добавить `stop_worker` tool. Ищет воркер в registry, проверяет статус, устанавливает `aborted`.

**Файл:** `packages/orchestrator/src/orchestrator-tools.ts`

```typescript
pi.registerTool({
  name: "stop_worker",
  label: "Stop Worker",
  description: "Stop a running worker by ID.",
  parameters: Type.Object({
    workerId: Type.String(),
    reason: Type.Optional(Type.String()),
  }),
  async execute(_id, params) { ... },
});
```

---

## Приоритет 3 — Полезные мелочи

### 3.1 XML notification format для coordinator

**Источник:** `upstream/agents.ts:265-290` — `formatTaskNotification()` — XML формат для результатов воркера.

**Что делать:** Рассмотреть переход от прямого `SingleResult` к XML-уведомлениям. XML чище для coordinator-парсинга (status, message_count, duration_ms, result).

**Проблема:** FAN использует `SubagentDetails` с `SingleResult[]` — это уже структурированный формат. XML был бы дублированием.

**Решение:** Оставить как есть. `SingleResult` с `renderResult` уже provides enough info.

---

### 3.2 Upstream agent prompts

**Источник:** `upstream/agents.ts:16-160` — детальные промпты для explore/plan/implement/verify.

**Что делать:** Сравнить с FAN agent definitions в `.fan/agents/`. Upstream prompts качественные:

- **explore**: "READ-ONLY MODE", "NEVER create, modify, or delete files", "Reference exact file paths and line numbers"
- **plan**: "STRICT READ-ONLY MODE", structured output with Steps/Risk/Dependencies/Success Criteria
- **implement**: "Follow the specification exactly", "Make minimal, focused changes", "Run relevant tests"
- **verify**: "ADVERSARY", "Find PROBLEMS not confirm everything works", "VERDICT: PASS/FAIL/PARTIAL", comprehensive checklist (Build, Type Check, Tests, Edge Cases, Security, Concurrency)

**Файл:** `.fan/agents/*.md` (или соответствующие определения агентов)

---

### 3.3 COORDINATOR_PROMPT обновление

**Источник:** `upstream/agents.ts:163-230` — coordinator prompt.

**Ключевые отличия upstream от FAN:**
- Upstream: таблица `Agent | Access | Use for` для 4 типов
- Upstream: "Max 3 implementation attempts per task" — явный лимит
- Upstream: "One implement worker at a time" — write lock
- Upstream: explicit workflow (receive → decompose → explore → synthesize → implement → verify → report)
- FAN: похожий, но менее структурированный

**Что делать:** Обновить COORDINATOR_PROMPT с учётом новых возможностей (slot pool, stop_worker, verdict parsing).

**Файл:** `packages/orchestrator/src/agents.ts`

---

### 3.4 /orchestrator retry subcommand

**Источник:** `upstream/index.ts:823-834` — `/orchestrator retry` — повтор последнего упавшего воркера.

**Что делать:** Добавить в handler `orchestrator` command.

**Файл:** `packages/orchestrator/src/orchestrator-extension.ts`

---

### 3.5 Config JSON Schema validation

**Источник:** `upstream/config.schema.json` — JSON Schema draft-07 для валидации config.json.

**Что делать:** Добавить `config.schema.json` рядом с `config.ts`. Валидировать при загрузке.

**Файл:** `packages/orchestrator/src/config.schema.json` (новый)

---

### 3.6 Cloud health check для auto mode

**Источник:** `upstream/config.ts:100-140` — `getCloudStatus()` с 5-мин кэшем.

**Что делать:** Проверить, делает ли FAN model-manager аналогичную проверку. Если нет — перенять. Вероятно FAN это уже делает через ProviderRouter.

**Файл:** `packages/model-manager/` — проверить

---

## Чеклист реализации

### Phase 1 — Hotfix: Task list widget (1.9 + 1.2 + 1.3)

- [ ] Auto-create tasks в delegate_task (1.9)
- [ ] theme.fg() вместо raw ANSI (1.2)
- [ ] Auto-hide + auto-clear (1.3)

### Phase 2 — UI Polish (1.1 + 1.4 + 1.5 + 1.6 + 1.7 + 1.8)

- [ ] AGENT_ICONS эмодзи (1.1)
- [ ] /orchestrator status через widget (1.4)
- [ ] /orchestrator config через widget (1.5)
- [ ] Status bar с provider mode (1.6)
- [ ] Widget collapse формат (1.7)
- [ ] messageCount в worker progress (1.8)

### Phase 3 — Architecture (2.1 + 2.2 + 2.4)

- [ ] Slot pool + write lock (2.1)
- [ ] parseVerdict (2.2)
- [ ] stop_worker tool (2.4)

### Phase 4 — Enhancements (2.3 + 3.3 + 3.4 + 3.5)

- [ ] TaskList owner filter (2.3)
- [ ] COORDINATOR_PROMPT обновление (3.3)
- [ ] /orchestrator retry (3.4)
- [ ] Config schema validation (3.5)

---

## Что НЕ перенять

| Паттерн | Причина |
|---------|---------|
| `Agent` tool name → FAN `delegate_task` | FAN поддерживает chain/parallel modes, upstream — single only |
| `pi --mode rpc` JSONL polling | FAN использует `--mode json --no-session` с event-based JSONL |
| `SendMessage` tool | FAN воркеры синхронные (blocking), no steer support |
| XML notification format | FAN использует `SubagentDetails` + `SingleResult` — уже структурированно |
| Cloud health check | FAN model-manager делает это через ProviderRouter |
| Provider fallback (cloud→local) | FAN имеет FallbackChain в model-manager |
| Upstream config with cloud/local sections | FAN model-manager управляет провайдерами централизованно |
| Inline `StringEnum` helper | FAN SDK уже имеет это |
