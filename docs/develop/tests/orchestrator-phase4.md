# Phase 4 — Orchestrator: Инструкция по проверке

> Пакет: `packages/orchestrator/` · Ветка: `develop`

## Автоматически проверено ✅

Все нижеперечисленные кейсы проверены 2026-04-11 в CI-подобной среде (bash/Node.js).

### 1. Сборка ✅

```powershell
cd C:/Users/User/projects/filin-next-agent
npm run build
```

**Результат:** 10 пакетов, 0 errors. Сборка включает `copy-assets` для orchestrator (копирует `.md` agent/prompts файлы в `dist/`).

### 2. Unit-тесты ✅

| Пакет | Тесты | Файлы | Результат |
|-------|-------|-------|-----------|
| `@fan/orchestrator` | 29 | task-manager (17), subagent-runner (11), agents (1) | ✅ 29 passed |
| `@fan/model-manager` | 42 | db, router, fallback, budget | ✅ 42 passed |
| `@fan/api-gateway` | 39 | auth (12), http-server (24), ws-handler (3) | ✅ 39 passed |
| `@itone/fan-agent` | 36 | agent core | ✅ 36 passed |
| `@itone/fan-tui` | 511 | terminal UI | ✅ 511 pass, 8 skip (Windows ANSI) |

Не запускать: `packages/ai` (таймауты на Node 24/Windows, upstream).

```powershell
cd packages/orchestrator && npx vitest run
cd ../model-manager && npx vitest run
cd ../api-gateway && npx vitest run
cd ../agent && npx vitest run
cd ../tui && npm run test
```

### 3. RPC mode — Session lifecycle ✅

```powershell
cd C:/Users/User/projects/filin-next-agent
node -e "require('fs').writeFileSync('tmp.json', JSON.stringify({type:'get_state'}))" ; node packages/coding-agent/dist/cli.js --mode rpc < tmp.json ; rm tmp.json
```

**Результат:**
```
[FAN Orchestrator] Session started
[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task
[FAN Orchestrator] Session shut down. Tasks: {"pending":0,"in_progress":0,"completed":0,"blocked":0,"failed":0}
{"type":"response","command":"get_state","success":true,...}
```

### 5.0. Subprocess spawning ✅

JSON mode subprocess (то что использует `runSingleAgent`) корректно работает — получает task, вызывает LLM, возвращает `message_end` с текстом и usage stats:

```
role: assistant | stopReason: stop | text: hello
usage: {"input":1987,"output":5,"cacheRead":320,"totalTokens":2312}
```

### 6. Server mode + API ✅

```powershell
npx kill-port 3456 2>/dev/null
$env:FAN_NO_AUTH = "1"
node packages/coding-agent/dist/cli.js --mode server --port 3456
```

```powershell
# В другом терминале:
node -e "require('http').get('http://localhost:3456/api/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(d)) })"
```

**Результат:** `{"status":"ok","version":"0.1.0","uptime":3}` — 200 OK.
Sessions: 1 session с `zai/glm-5`.

### 7.1. Builtin agent discovery ✅

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/agents.js').then(m => {
  const r = m.discoverAgents('C:/Users/User/projects/filin-next-agent', 'user');
  console.log('Agents:', r.agents.length);
  r.agents.forEach(a => console.log(' -', a.name, '(' + a.source + ')'));
});"
```

**Результат:** 4 builtin агента (explore, plan, implement, verify).

### 7.2. Custom agent discovery ✅

Создаётся `.fan/agents/my-agent.md`, вызывается `discoverAgents(..., 'both')`, агент обнаруживается как `my-agent (project)`. После проверки файл удаляется.

### 8. Regression ✅

TUI: 511 pass, 0 fail, 8 skip (стабильно). Полная сборка: 10 пакетов, 0 errors.

---

## Ручная проверка (требует TUI) 🔧

Следующие кейсы требуют интерактивного терминала с TUI. Запусти:

```powershell
cd C:/Users/User/projects/filin-next-agent
node packages/coding-agent/dist/cli.js
```

### 4.1. Slash: /orchestrator

Набрать: `/orchestrator`

**Ожидание:** Статус orchestrator с количеством задач и списком 4+ агентов.

### 4.2. Slash: /agents

Набрать: `/agents`

**Ожидание:**
```
Available agents (4):
  explore (builtin): Fast codebase exploration...
  plan (builtin): Creates implementation plans...
  implement (builtin): General-purpose subagent...
  verify (builtin): Code review specialist...
```

### 4.3. Slash: /tasks

Набрать: `/tasks`

**Ожидание:** `No tasks found. Counts: pending=0, in_progress=0, completed=0, failed=0, blocked=0`

### 4.4. Slash: /delegate

Набрать: `/delegate`

**Ожидание:** `Usage: /delegate <agent> <task description...>`

Набрать: `/delegate unknown test`

**Ожидание:** `Unknown agent: "unknown". Available: explore, plan, implement, verify`

### 5.1. delegate_task — Single mode

В TUI попросить агента:
> Use delegate_task to run the "explore" agent with task "Find the main entry point of the coding-agent package"

**Ожидание:**
- TUI показывает renderCall: `delegate_task explore [user]`
- Subprocess запускается (видно прогресс)
- renderResult показывает результат (файлы, архитектура)
- Usage stats: токены, cost

### 5.2. delegate_task — Chain mode

> Use delegate_task in chain mode: first "explore" to find router implementation, then "plan" to create a plan for adding a new route, using {previous} placeholder

**Ожидание:**
- renderCall: `delegate_task chain (2 steps)`
- Два шага последовательно
- Результат второго шага содержит план

### 5.3. delegate_task — Parallel mode

> Use delegate_task in parallel mode with tasks: [explore agent listing all .ts files in packages/db/src, explore agent listing all .ts files in packages/ai/src]

**Ожидание:**
- renderCall: `delegate_task parallel (2 tasks)`
- Оба агента запускаются (конкурентно)
- Оба результата отображаются

---

## Критерии готовности

### Автоматические ✅
- [x] `npm run build` — 10 пакетов, 0 errors
- [x] `packages/orchestrator` — 29 тестов, 0 failures
- [x] `packages/model-manager` — 42 теста, 0 failures
- [x] `packages/api-gateway` — 39 тестов, 0 failures
- [x] `packages/tui` — 511 pass, 8 skip (Windows ANSI)
- [x] RPC mode — `[FAN Orchestrator] Session started` + tools listed
- [x] Subprocess JSON streaming — `message_end` с текстом и usage
- [x] Server mode — health endpoint 200, sessions endpoint 200
- [x] Builtin agent discovery — 4 агента (explore, plan, implement, verify)
- [x] Custom agent discovery — `.fan/agents/*.md` обнаруживается как (project)
- [x] Regression — TUI 511 pass, 0 fail

### Ручные (TUI) 🔧
- [ ] TUI `/orchestrator` — показывает статус
- [ ] TUI `/agents` — показывает 4+ builtin агента
- [ ] TUI `/tasks` — показывает "No tasks found"
- [ ] TUI `/delegate unknown test` — "Unknown agent"
- [ ] `delegate_task` single mode — explore агент выполняет задачу
- [ ] `delegate_task` chain mode — 2+ шага последовательно
- [ ] `delegate_task` parallel mode — 2+ агента конкурентно
