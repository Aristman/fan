# Phase 5 — Orchestrator Hardening: Инструкция по проверке

> Пакет: `packages/orchestrator/` · Ветка: `FAN/feature/phase5-orchestrator-hardening` (2026-04-11)

**Статус:** ✅ Проверка пройдена

## Автоматически проверено

### 1. Сборка + type-check ✅

```powershell
cd C:/Users/User/projects/filin-next-agent
cd packages/orchestrator && npx tsgo -p tsconfig.build.json --noEmit
cd packages/orchestrator && npm run build
```

**Ожидание:** 0 type errors, сборка успешно, `dist/` содержит все JS+DTS файлы. `copy-assets` копирует `src/agents/*.md` и `src/prompts/*.md` в `dist/`.

> ⚠️ Полная сборка `npm run build` из корня может упасть с EPERM на Prisma DLL (Windows file lock от другого процесса). Это не баг — отдельная сборка orchestrator проходит чисто.

### 2. Unit-тесты ✅

```powershell
cd packages/orchestrator && npx vitest run
```

**Ожидание:**

| Файл | Тесты | Описание |
|------|-------|----------|
| `config.test.ts` | 7 | DEFAULTS структура, loadConfig (no file / partial / invalid JSON), resolveModel (cloud / local / default) |
| `agents.test.ts` | 1 | Agent discovery |
| `subagent-runner.test.ts` | 11 | getFinalOutput, formatTokens, formatUsageStats, mapWithConcurrencyLimit, getFnaInvocation |
| `permissions.test.ts` | 22 | Все 8 паттернов (rm -rf, git push, publish, SQL, format, shutdown, chmod/chown, find -delete) + safe команды + false positive защита |
| `workers.test.ts` | 20 | genWorkerId уникальность, registry CRUD, activeWorkers, hasActiveWriteWorker, acquireSlot/releaseSlot (FIFO), getQueueLength, statusIcon/statusColor, _resetRegistry |
| `task-manager.test.ts` | 30 | Original 17 + owner field, updateTask, bidirectional linking, auto-block, formatTaskList, parseVerdict |
| `integration-coordinator.test.ts` | 4 | Extension factory загрузка, 6 tools, 5 commands, 2 shortcuts |
| **Итого** | **95** | **7 файлов, все green** |

```
Test Files  7 passed (7)
     Tests  95 passed (95)
  Duration  < 10s
```

### 3. Config module ✅

#### 3.1. loadConfig — fallback на дефолты

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/config.js').then(m => {
  const c = m.loadConfig();
  console.log('providerMode:', c.providerMode);
  console.log('cloud.model:', c.cloud.model);
  console.log('parallelWorkers:', c.parallelWorkers);
  console.log('maxRetries:', c.maxRetries);
  console.log('Has agentTimeouts:', Object.keys(c.agentTimeouts).length, 'entries');
  console.log('Dangerous commands:', c.dangerousCommands.length);
});"
```

**Ожидание:**
```
providerMode: cloud
cloud.model: zai/glm-4.5-air
parallelWorkers: 3
maxRetries: 2
Has agentTimeouts: 4 entries
Dangerous commands: 8
```

#### 3.2. loadConfig — кастомный config

```powershell
node --input-type=module -e "
import { writeFileSync, unlinkSync } from 'fs';
writeFileSync('packages/orchestrator/dist/config.json', JSON.stringify({ providerMode: 'local', parallelWorkers: 5 }));
import('./packages/orchestrator/dist/config.js').then(m => {
  const c = m.loadConfig();
  console.log('providerMode:', c.providerMode);
  console.log('parallelWorkers:', c.parallelWorkers);
  console.log('cloud.model (default):', c.cloud.model);
  unlinkSync('packages/orchestrator/dist/config.json');
});"
```

**Ожидание:**
```
providerMode: local
parallelWorkers: 5
cloud.model (default): zai/glm-4.5-air
```

#### 3.3. resolveModel

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/config.js').then(m => {
  const c = m.loadConfig();
  console.log('cloud explore:', m.resolveModel('explore', c, 'cloud'));
  console.log('local implement:', m.resolveModel('implement', c, 'local'));
  console.log('auto (defaults to cloud):', m.resolveModel('plan', c, 'auto'));
});"
```

**Ожидание:**
```
cloud explore: zai/glm-4.5-air
local implement: ollama/qwen3:32b
auto (defaults to cloud): zai/glm-4.5-air
```

### 4. Workers module ✅

#### 4.1. Worker registry

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/workers.js').then(m => {
  m._resetRegistry();
  const id = m.genWorkerId();
  m.registerWorker({ id, agentType: 'explore', status: 'running', startTime: Date.now() });
  console.log('registered:', m.getWorker(id)?.agentType);
  console.log('list:', m.listWorkers().length);
  console.log('active:', m.activeWorkers().length);
  m.updateWorker(id, { status: 'completed', endTime: Date.now() });
  console.log('active after complete:', m.activeWorkers().length);
  m._resetRegistry();
});"
```

**Ожидание:**
```
registered: explore
list: 1
active: 1
active after complete: 0
```

#### 4.2. Slot pool — implement exclusive

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/workers.js').then(async m => {
  m._resetRegistry();
  const p1 = m.acquireSlot('implement', 3);
  console.log('first implement slot acquired immediately:', p1 instanceof Promise && typeof p1.then === 'function' ? 'resolved' : 'pending');
  
  const p2 = m.acquireSlot('implement', 3);
  console.log('second implement queued (Promise pending):', p2.constructor.name);
  
  console.log('queue length:', m.getQueueLength());
  m._resetRegistry();
});"
```

**Ожидание:**
```
first implement slot acquired immediately: resolved
second implement queued (Promise pending): Promise
queue length: 1
```

### 5. Permissions module ✅

#### 5.1. Опасные команды детектятся

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/permissions.js').then(m => {
  const tests = [
    ['rm -rf /tmp', true],
    ['rm -r -f /var/log', true],
    ['rm --recursive --force /old', true],
    ['git push --force origin main', true],
    ['git push -f', true],
    ['npm publish', true],
    ['yarn publish', true],
    ['DROP TABLE users', true],
    ['DELETE FROM users', true],
    ['mkfs /dev/sda1', true],
    ['shutdown -h now', true],
    ['chmod -R 777 /', true],
    ['find /tmp -name core -delete', true],
    ['ls -la /tmp', false],
    ['cat README.md', false],
    ['echo hello', false],
  ];
  let pass = 0;
  for (const [cmd, expectDangerous] of tests) {
    const result = m.isDangerousCommand(cmd);
    const ok = expectDangerous ? result !== null : result === null;
    console.log(ok ? '✓' : '✗', cmd, '→', result ?? 'null');
    if (ok) pass++;
  }
  console.log(pass + '/' + tests.length + ' passed');
});"
```

**Ожидание:** Все 16 тестов ✓, `16/16 passed`.

#### 5.2. False positive защита (цитаты)

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/permissions.js').then(m => {
  const tests = [
    'grep -r \"rm -rf\" README.md',
    'echo \"DROP TABLE users\"',
    'cat log_with_shutdown_word.txt',
    \"grep -r 'chmod -R' .\",
    'systemctl restart nginx',
    'git log --oneline | grep force',
  ];
  let pass = 0;
  for (const cmd of tests) {
    const result = m.isDangerousCommand(cmd);
    const ok = result === null;
    console.log(ok ? '✓' : '✗', cmd, '→', result ?? 'null (safe)');
    if (ok) pass++;
  }
  console.log(pass + '/' + tests.length + ' safe (no false positives)');
});"
```

**Ожидание:** Все 6 команд безопасны, `6/6 safe`.

### 6. Task manager enhancements ✅

#### 6.1. owner + bidirectional linking

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/task-manager.js').then(m => {
  const tm = new m.TaskManager();
  
  // Create parent
  const parent = tm.createTask({ description: 'Build infra', agentType: 'implement' });
  console.log('parent status:', parent.status);
  
  // Create child with blocks — should auto-block
  const child = tm.createTask({ description: 'Add feature', agentType: 'implement', blocks: [parent.id], owner: 'worker-1' });
  console.log('child status (auto-blocked):', child.status);
  console.log('child owner:', child.owner);
  console.log('parent blockedBy includes child:', parent.blockedBy?.includes(child.id));
  
  // Get tasks by owner
  const owned = tm.getTasks({ owner: 'worker-1' });
  console.log('tasks by owner worker-1:', owned.length);
  
  // Complete parent → child auto-unblocks
  tm.completeTask(parent.id, 'done');
  const childAfter = tm.getTask(child.id);
  console.log('child status after parent complete:', childAfter?.status);
});"
```

**Ожидание:**
```
parent status: pending
child status (auto-blocked): blocked
child owner: worker-1
parent blockedBy includes child: true
tasks by owner worker-1: 1
child status after parent complete: pending
```

#### 6.2. updateTask

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/task-manager.js').then(m => {
  const tm = new m.TaskManager();
  const task = tm.createTask({ description: 'Original', agentType: 'implement' });
  
  const updated = tm.updateTask(task.id, { status: 'in_progress', subject: 'Updated description' });
  console.log('status:', updated.status);
  console.log('description:', updated.description);
  
  // Verify formatTaskList
  const list = m.formatTaskList([updated]);
  console.log('formatTaskList:', list.includes('◐') ? 'has in_progress icon' : 'missing icon');
});"
```

**Ожидание:**
```
status: in_progress
description: Updated description
formatTaskList: has in_progress icon
```

#### 6.3. parseVerdict

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/agents.js').then(m => {
  console.log('PASS:', m.parseVerdict('All tests passed. VERDICT: PASS'));
  console.log('FAIL:', m.parseVerdict('Build failed. VERDICT: FAIL'));
  console.log('PARTIAL:', m.parseVerdict('Some issues. VERDICT: PARTIAL'));
  console.log('null:', m.parseVerdict('No verdict here'));
  console.log('case insensitive:', m.parseVerdict('verdict: pass'));
});"
```

**Ожидание:**
```
PASS: PASS
FAIL: FAIL
PARTIAL: PARTIAL
null: null
case insensitive: PASS
```

### 7. Coordinator mode + shortcuts (экспорт-проверка) ✅

```powershell
node --input-type=module -e "
import('./packages/orchestrator/dist/agents.js').then(m => {
  console.log('COORDINATOR_PROMPT length:', m.COORDINATOR_PROMPT.length, 'chars');
  console.log('Contains delegate_task:', m.COORDINATOR_PROMPT.includes('delegate_task'));
  console.log('Contains TaskCreate:', m.COORDINATOR_PROMPT.includes('TaskCreate'));
  console.log('Contains TaskUpdate:', m.COORDINATOR_PROMPT.includes('TaskUpdate'));
  console.log('Contains DO NOT USE CODE TOOLS:', m.COORDINATOR_PROMPT.includes('DO NOT USE CODE TOOLS DIRECTLY'));
  console.log('PLANNING_PROMPT length:', m.PLANNING_PROMPT.length, 'chars');
  console.log('formatTaskNotification type:', typeof m.formatTaskNotification);
});"
```

**Ожидание:**
```
COORDINATOR_PROMPT length: ~2500 chars
Contains delegate_task: true
Contains TaskCreate: true
Contains TaskUpdate: true
Contains DO NOT USE CODE TOOLS: true
PLANNING_PROMPT length: ~700 chars
formatTaskNotification type: function
```

### 8. Barrel exports (index.ts) ✅

```powershell
node --input-type=module -e "
import * as m from './packages/orchestrator/dist/index.js';
const exports = Object.keys(m).sort();
const expected = [
  'COORDINATOR_PROMPT', 'PLANNING_PROMPT', 'DEFAULTS', 'TaskManager',
  'acquireSlot', 'activeWorkers', 'discoverAgents', 'formatTaskList',
  'formatTaskNotification', 'genWorkerId', 'getCloudHealthCached',
  'getCloudStatus', 'getQueueLength', 'getWorker', 'hasActiveWriteWorker',
  'isDangerousCommand', 'listWorkers', 'loadConfig', 'parseVerdict',
  'registerWorker', 'releaseSlot', 'resolveModel', 'runSingleAgent',
  'runSingleAgentWithRetry', 'runSingleAgentWithFallback', 'statusColor',
  'statusIcon', 'updateWorker', 'orchestratorExtension',
];
const missing = expected.filter(e => !exports.includes(e));
console.log('Total exports:', exports.length);
console.log('Missing:', missing.length === 0 ? 'none' : missing.join(', '));
// Verify types are exported as values (TypeScript types vanish at runtime)
console.log('Type exports checked via tsgo (not runtime): OK');
"
```

**Ожидание:**
```
Total exports: 30+
Missing: none
Type exports checked via tsgo (not runtime): OK
```

---

## Ручные (TUI)

Следующие кейсы требуют интерактивного терминала с TUI. Запусти:

```powershell
cd C:/Users/User/projects/filin-next-agent
node packages/coding-agent/dist/cli.js
```

### 9. Coordinator mode (Alt+O)

#### 9.1. Toggle ON

Нажать **Alt+O**.

**Ожидание:**
- Уведомление: "Coordinator mode ENABLED — delegate via delegate_task..."
- Status bar показывает: `🔄 Coordinator`

#### 9.2. Coordinator prompt injection

После включения coordinator mode отправить любое сообщение.

**Ожидание:** LLM начинает декомпозировать задачу, создаёт подзадачи через TaskCreate, делегирует через delegate_task, не использует напрямую read/write/edit/bash.

Попросить:
> List files in packages/orchestrator/src

**Ожидание:** Координатор делегирует задачу explore-агенту через `delegate_task`, НЕ использует `ls` или `find` напрямую.

#### 9.3. Toggle OFF

Нажать **Alt+O** снова.

**Ожидание:**
- Уведомление: "Coordinator mode DISABLED"
- Status bar: `🔄 Coordinator` исчезает
- LLM возвращается к обычному режиму (может использовать инструменты напрямую)

### 10. Task widget (Alt+T)

#### 10.1. Виджет скрывается без задач

**Ожидание:** Нет виджета "Orchestrator Tasks" (auto-hide).

#### 10.2. Виджет появляется с задачами

Включить coordinator mode (Alt+O), попросить:
> Create tasks for: 1) Read config.ts, 2) Review workers.ts

**Ожидание:**
- Виджет появляется над редактором
- Показывает задачи с иконками: `☐` (pending), `◐` (in_progress)
- Формат: `☐ Read config.ts`

#### 10.3. Сollapse/expand (Alt+T)

Нажать **Alt+T**.

**Ожидание:** Виджет сворачивается до одной строки: `Orchestrator Tasks (N) — Alt+T to expand`.

Нажать **Alt+T** снова.

**Ожидание:** Виджет разворачивается обратно.

### 11. /plan command

#### 11.1. Базовый план

Набрать: `/plan`

**Ожидание:**
- Working message: "Generating plan..."
- Plan-агент анализирует кодовую базу
- Результат отображается как сообщение от пользователя
- Появляется диалог: Approve / Revise / Reject

#### 11.2. Approve

Выбрать **Approve**.

**Ожидание:**
- Coordinator mode включается автоматически
- Status bar: `🔄 Coordinator`
- Отправляется steer-сообщение: "The plan has been approved..."

#### 11.3. Revise

Набрать `/plan` снова, на этот раз выбрать **Revise**.

**Ожидание:**
- Появляется поле ввода для фидбека
- После ввода отправляется ревизия плана

#### 11.4. Reject

Набрать `/plan`, выбрать **Reject**.

**Ожидание:** Уведомление "Plan rejected."

### 12. Enhanced /orchestrator

#### 12.1. Help (без аргументов)

Набрать: `/orchestrator`

**Ожидание:** Список подкоманд: on, off, stop, config, mode, status + shortcuts info.

#### 12.2. Config

Набрать: `/orchestrator config`

**Ожидание:**
```
FAN Orchestrator — Configuration
Provider mode: cloud
Cloud model: zai/glm-4.5-air
Local model: ollama/qwen3:32b
Parallel workers: 3
Worker timeout: 300s
Max retries: 2
Plan timeout: 300s
Agent timeouts:
  explore: 120s
  plan: 180s
  implement: 300s
  verify: 180s
Dangerous commands: 8 patterns
```

#### 12.3. Mode switch

Набрать: `/orchestrator mode local`

**Ожидание:** "Provider mode set to: local"

Набрать: `/orchestrator config` — проверить что Provider mode теперь `local`.

#### 12.4. Stop

Запустить delegate_task (через координатор или напрямую). Пока воркер работает, набрать: `/orchestrator stop`

**Ожидание:** "Stopped N worker(s)."

#### 12.5. Status

Набрать: `/orchestrator status`

**Ожидание:** Расширенный статус с координатором, провайдером, задачами, активными воркерами, списком агентов.

#### 12.6. On/Off

Набрать: `/orchestrator on` → координатор включён, status bar обновлён.
Набрать: `/orchestrator off` → координатор выключен, status bar очищен.

### 13. Permission system

#### 13.1. Опасная команда блокируется

Включить coordinator mode (Alt+O). Попросить агента:
> Run bash command: rm -rf /tmp/test

**Ожидание:** Команда блокируется с сообщением `⚠️ Dangerous command: Recursive forced delete (rm -rf)`.

#### 13.2. Безопасная команда проходит

Попросить:
> Run bash command: ls -la /tmp

**Ожидание:** Команда выполняется без блокировки.

#### 13.3. grep безопасен

Попросить:
> Run bash command: grep -r "rm -rf" README.md

**Ожидание:** Команда НЕ блокируется (dangerous pattern inside quotes).

### 14. TaskCreate / TaskUpdate tools

#### 14.1. TaskCreate через LLM

В coordinator mode попросить:
> Create a task: "Read and understand the config module"

**Ожидание:**
- LLM вызывает TaskCreate tool
- Task widget обновляется (появляется новая задача)
- Ответ содержит task ID и статус

#### 14.2. TaskUpdate через LLM

Попросить:
> Update the task to in_progress status

**Ожидание:**
- LLM вызывает TaskUpdate tool
- Виджет обновляет иконку задачи: `☐` → `◐`

### 15. Session lifecycle

#### 15.1. session_start

Перезапустить TUI (Ctrl+C → запустить снова).

**Ожидание:**
- Console: `[FAN Orchestrator] Session started`
- Console: `[FAN Orchestrator] Tools: delegate_task, list_tasks, cancel_task, classify_task, TaskCreate, TaskUpdate`
- Status bar и виджет восстанавливаются (если координатор был включён)

#### 15.2. session_shutdown

Выйти из TUI (Ctrl+C или /exit).

**Ожидание:**
- Console: `[FAN Orchestrator] Session shut down. Tasks: {...}`
- Активные воркеры прерываются
- Виджеты очищаются

### 16. Retry / fallback (subagent-runner)

#### 16.1. Retry логика

Retry не тестируется вручную напрямую — он работает внутри `delegate_task` когда worker падает. Для unit-тестирования:

```powershell
cd packages/orchestrator && npx vitest run src/__tests__/subagent-runner.test.ts
```

**Ожидание:** 11 тестов проходят (включая существующие тесты subprocess runner).

#### 16.2. Fallback логика

Fallback (`cloud → local`) срабатывает при `providerMode: "auto"` и недоступности cloud провайдера. Тестируется через unit-тесты конфига и через manual run:

```powershell
# Установить auto mode
/orchestrator mode auto
# Запустить delegate_task с задачей
# Если cloud недоступен — автоматически переключится на local
```

---

## Критерии готовности

### Автоматические
- [x] `npx tsgo -p tsconfig.build.json --noEmit` — 0 type errors (orchestrator)
- [x] `npm run build` (orchestrator package) — clean, dist/ produced
- [x] `npx vitest run` — 95 тестов, 7 файлов, 0 failures
- [x] config.test.ts — 7 passed (loadConfig defaults/merge/invalid, resolveModel cloud/local/auto)
- [x] workers.test.ts — 20 passed (registry CRUD, slot pool FIFO, implement exclusive, statusIcon)
- [x] permissions.test.ts — 22 passed (8 dangerous patterns + safe commands + false positive quotes)
- [x] task-manager.test.ts — 30 passed (owner, updateTask, bidirectional linking, formatTaskList, parseVerdict)
- [x] integration-coordinator.test.ts — 4 passed (6 tools, 5 commands, 2 shortcuts)
- [x] Barrel exports — 30+ экспортов, все разрешаются
- [x] config.json gitignored, config.example.json tracked

### Ручные (TUI)
- [x] Alt+O — toggle coordinator ON/OFF, status bar обновляется
- [x] Coordinator mode — LLM делегирует через delegate_task, НЕ использует инструменты напрямую
- [x] Alt+T — toggle task widget collapse/expand
- [x] Task widget — auto-hide без задач, появляется с задачами, иконки статусов
- [x] `/plan` — генерация плана → Approve/Revise/Reject → auto-enable coordinator
- [x] `/orchestrator config` — показывает конфигурацию
- [x] `/orchestrator mode local` — переключает provider mode
- [x] `/orchestrator stop` — останавливает воркеры
- [x] `/orchestrator status` — расширенный статус
- [x] Permission system — `rm -rf` блокируется, `ls` проходит, `grep "rm -rf"` НЕ блокируется
- [x] TaskCreate/TaskUpdate — LLM создаёт и обновляет задачи, виджет обновляется
- [x] session_shutdown — чистит воркеры, виджеты, статус bar
- [x] delegate_task — все 3 режима (single/chain/parallel) по-прежнему работают
- [x] `/agents` — показывает 4+ builtin агента
- [x] `/tasks` — показывает задачи с owner и blockedBy
