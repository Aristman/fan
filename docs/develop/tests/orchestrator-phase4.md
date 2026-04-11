# Phase 4 — Orchestrator: Инструкция по проверке

> Пакет: `packages/orchestrator/` · Ветка: `develop` (commit `bff676d9`)

## 1. Сборка

```powershell
cd C:/Users/User/projects/filin-next-agent

# Orchestrator package
cd packages/orchestrator && npm run build

# Полная сборка monorepo (10 пакетов)
cd ../.. && npm run build
```

**Ожидание:** 0 ошибок во всех пакетах.

---

## 2. Unit-тесты

```powershell
# Orchestrator (29 тестов)
cd packages/orchestrator && npx vitest run

# Model Manager (42 теста)
cd ../model-manager && npx vitest run

# API Gateway (39 тестов)
cd ../api-gateway && npx vitest run

# Agent Core (36 тестов)
cd ../agent && npx vitest run
```

**Ожидание:** 0 failures. Таблица:

| Пакет | Тесты | Файлы |
|-------|-------|-------|
| `@fan/orchestrator` | 29 | task-manager (17), subagent-runner (11), agents (1) |
| `@fan/model-manager` | 42 | db, router, fallback, budget |
| `@fan/api-gateway` | 39 | auth (12), http-server (24), ws-handler (3) |
| `@itone/fan-agent` | 36 | agent core |

Не запускать: `packages/ai` (таймауты на Node 24/Windows, upstream), `packages/tui` (7 skip на Windows ANSI).

---

## 3. Проверка в RPC mode (без TUI)

### 3.1. Session start / shutdown

```powershell
cd C:/Users/User/projects/filin-next-agent
node -e "require('fs').writeFileSync('tmp.json', JSON.stringify({type:'get_state'}))" ; node packages/coding-agent/dist/cli.js --mode rpc < tmp.json ; rm tmp.json
```

**Ожидание:** В логах видно:
```
[FAN Orchestrator] Session started
[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task
```

### 3.2. Slash commands

RPC mode не поддерживает slash commands напрямую. Для их проверки нужен интерактивный mode или server mode.

---

## 4. Проверка в интерактивном mode (TUI)

```powershell
cd C:/Users/User/projects/filin-next-agent
node packages/coding-agent/dist/cli.js
```

### 4.1. Slash: /orchestrator

Набрать в TUI: `/orchestrator`

**Ожидание:** Вывод статуса:
- Текущее количество задач
- Список доступных агентов (4 builtin: explore, plan, implement, verify)

### 4.2. Slash: /agents

Набрать: `/agents`

**Ожидание:** Список агентов с источником:
```
Available agents (4):
  explore (builtin): Fast codebase exploration...
  plan (builtin): Creates implementation plans...
  implement (builtin): General-purpose subagent...
  verify (builtin): Code review specialist...
```

### 4.3. Slash: /tasks

Набрать: `/tasks`

**Ожидание:** `No tasks found. Counts: pending=0, ...`

### 4.4. Slash: /delegate

Набрать: `/delegate`

**Ожидание:** Usage message: `Usage: /delegate <agent> <task description...>`

Набрать: `/delegate unknown test`

**Ожидание:** `Unknown agent: "unknown". Available: explore, plan, implement, verify`

---

## 5. Проверка delegate_task tool (основная функциональность)

Tool вызывается LLM автоматически. Для ручной проверки:

### 5.1. Single mode

В TUI попросить агента:
> Use delegate_task to run the "explore" agent with task "Find the main entry point of the coding-agent package"

**Ожидание:**
- TUI показывает renderCall: `delegate_task explore [user]`
- Subprocess запускается (видно в логах/терминале)
- renderResult показывает результат (файлы, архитектура)
- Usage stats: токены, cost

### 5.2. Chain mode

В TUI попросить:
> Use delegate_task in chain mode: first "explore" to find router implementation, then "plan" to create a plan for adding a new route, using {previous} placeholder

**Ожидание:**
- renderCall: `delegate_task chain (2 steps)`
- Два шага последовательно
- Результат второго шага содержит план

### 5.3. Parallel mode

В TUI попросить:
> Use delegate_task in parallel mode with tasks: [explore agent listing all .ts files in packages/db/src, explore agent listing all .ts files in packages/ai/src]

**Ожидание:**
- renderCall: `delegate_task parallel (2 tasks)`
- Оба агента запускаются (конкурентно)
- Оба результата отображаются

---

## 6. Server mode + API

```powershell
# Останови предыдущие серверы
npx kill-port 3456 2>/dev/null

# Запуск с отключённой авторизацией
$env:FAN_NO_AUTH = "1"
node packages/coding-agent/dist/cli.js --mode server --port 3456
```

В другом терминале:

```powershell
# Health
node -e "require('http').get('http://localhost:3456/api/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(d)) })"

# Sessions
node -e "require('http').get('http://localhost:3456/api/sessions', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(JSON.parse(d).sessions.length+' sessions')) })"
```

**Ожидание:** 200 OK, orchestrator extension загружен (видно в логах сервера при запуске).

---

## 7. Проверка agent discovery

### 7.1. Builtin agents (всегда доступны)

```powershell
node -e "
import('./packages/orchestrator/dist/agents.js').then(m => {
  const result = m.discoverAgents('C:/Users/User/projects/filin-next-agent', 'user');
  console.log('Agents:', result.agents.length);
  result.agents.forEach(a => console.log(' -', a.name, '(' + a.source + ')', a.description));
});
" --input-type=module
```

**Ожидание:** 4+ агента (minimum 4 builtin).

### 7.2. Custom agents

Создать файл `.fan/agents/my-agent.md`:

```markdown
---
name: my-agent
description: Test agent for verification
tools: read, ls
---

You are a test agent. Reply with "test ok".
```

Запустить `/agents` в TUI — должен появиться `my-agent (project)`.

Удалить после проверки: `Remove-Item .fan/agents/my-agent.md`

---

## 8. Regression — остальные пакеты

```powershell
# TUI тесты (511 pass, 7-8 skip на Windows)
cd packages/tui && npm run test

# Полная сборка
cd ../.. && npm run build
```

**Ожидание:** Сборка без ошибок, TUI тесты не regress.

---

## Критерии готовности

- [ ] `npm run build` — 10 пакетов, 0 errors
- [ ] `packages/orchestrator` — 29 тестов, 0 failures
- [ ] `packages/model-manager` — 42 теста, 0 failures
- [ ] `packages/api-gateway` — 39 тестов, 0 failures
- [ ] RPC mode — `[FAN Orchestrator] Session started` в логах
- [ ] TUI `/orchestrator` — показывает статус
- [ ] TUI `/agents` — показывает 4+ builtin агента
- [ ] TUI `/tasks` — показывает "No tasks found"
- [ ] TUI `/delegate unknown test` — "Unknown agent"
- [ ] `delegate_task` single mode — explore агент выполняет задачу
- [ ] `delegate_task` chain mode — 2+ шага последовательно
- [ ] `delegate_task` parallel mode — 2+ агента конкурентно
- [ ] Server mode — запускается, health endpoint 200
- [ ] Custom agent discovery — `.fan/agents/*.md` обнаруживается
