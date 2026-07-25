# Спецификация: Фаза 5 — Конкурентность (опционально)

## Метаданные
- **Дата**: 2026-07-25
- **Автор**: research-spec-generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича · Фаза 5 из пакета «FAN Network Agent»
- **Связь**: [Родительская спецификация](./spec_fan-network-agent_2026-07-25.md)
- **Статус старта**: ⚠️ Опционально, отдельное решение о старте

---

## 1. Обзор

### 1.1 Цель

Устранить последние архитектурные барьеры к полной конкурентности: удалить `process.chdir()` (глобальное состояние процесса), перенести очередь сообщений из in-memory в персистентное хранилище, добавить per-project tokens для безопасности multi-user future. Эта фаза превращает FAN из «один движок с очередью» в «настоящий мультипроектный runtime».

### 1.2 Контекст

В текущем состоянии (после фазы 4):
- Одна активная сессия на процесс; переключение = teardown + recreate сервисов + `process.chdir()`
- In-memory очередь сообщений теряется при рестарте (фаза 2)
- Все токены дают полный доступ (без ролей, без привязки к проекту)
- Extensions/MCP-серверы могут читать `process.cwd()` напрямую

**Точки изменений этой фазы:**

| # | Изменение | Сложность | Описание |
|---|-----------|:---:|----------|
| 13 | Удаление `process.chdir()` из runtime | L | Per-session cwd вместо глобального process cwd |
| 14 | Персистентная очередь сообщений | M | SQLite или JSONL-based queue survives restart |
| — | Per-project tokens | M | Tokens scoped to specific workspace path |

Фаза помечена как **ОПЦИОНАЛЬНАЯ**. Решение о её запуске принимается отдельно после оценки ценности vs стоимости.

---

## 2. Функциональные требования

### 2.1 Точка №13 (ПОЛНОЕ): Удаление `process.chdir()`

**Файл:** `packages/coding-agent/src/core/agent-session-runtime.ts`

**Текущее поведение (line 119–148 аудита):**

```typescript
// Текущий switchSession делает:
async switchSession(targetPath: string): Promise<void> {
    // Полный teardown текущего runtime
    await this.teardown();
    
    // ГЛОБАЛЬНОЕ изменение cwd процесса
    process.chdir(targetPath);  // ← проблема
    
    // recreate сервисов
    this.createAllTools(targetPath);
}
```

Проблема: `process.chdir()` мутирует глобальное состояние Node.js процесса. Extensions, MCP-серверы, библиотеки, читающие `process.cwd()`, видят неконсистентный результат при параллельной работе нескольких проектов.

**Изменение для фазы 5:**

```typescript
class AgentSessionRuntime {
    private currentSessions: Map<string, SessionContext>; // per-session state
    
    async switchSession(sessionId: string, cwd: string): Promise<void> {
        const ctx = new SessionContext({
            cwd,
            sessionId,
            settings: await loadProjectSettings(cwd),
            tools: createAllToolDefinitions(cwd), // cwd замыканием, не process.cwd()
            // NO process.chdir()!
        });
        
        this.currentSessions.set(sessionId, ctx);
    }
    
    // Все инструменты получают cwd из замыкания, а не из process.cwd()
    private createToolDefinition(toolName: string, toolFn: ToolFn, cwd: string) {
        return {
            name: toolName,
            fn: async (args) => {
                // resolve paths relative to session cwd, not process cwd
                const resolvedPath = resolveToCwd(cwd, args.path);
                return toolFn(resolvedPath, ...);
            },
            cwd: cwd, // metadata for context
        };
    }
}
```

**Комментарий к реализации:** это требует аудита всех потребителей `process.cwd()` и `process.chdir()` в:
- Ядре FAN (`packages/coding-agent/src/`)
- Extensions (packages/extensions/)
- Skills (`skills/*/SKILL.md` system prompts)
- MCP-серверах (если читают cwd)
- ResourceLoader (должен принимать cwd явно)

**Митигация перед удалением (фаза 5 pre-check):**
1. Провести grep `process\.cwd\(\)` по всем packages/* — найти все места
2. Провести grep `process\.chdir\(` по всем packages/* — найти все места
3. Заменить каждый вызов на явную передачу cwd через контекст сессии
4. Добавить тест на параллельные switchSession (mock process.chdir → verify no call)

### 2.2 Персистентная очередь сообщений

**Файл:** `packages/api-gateway/src/message-queue.ts` (улучшение from phase 2)

**Проблема фазы 2:** in-memory очередь теряет задачи при рестарте сервера.

**Решение:** очередь в виде JSONL файла, сериализованного per-session:

```
~/.fan/agent/queues/
├── <session-id>.queue.jsonl   # одна очередь на сессию
└── queue-index.json           # индекc активных очередей
```

Формат entry:
```jsonl
{"sessionId":"clxxx","content":"message body","createdAt":"2026-07-25T10:00:00Z","priority":"normal"}
```

**API операции:**
```typescript
class PersistentMessageQueue {
    async enqueue(sessionId: string, content: string, priority?: 'normal' | 'high'): Promise<void>;
    async dequeue(sessionId: string): Promise<string | null>;
    async peekAll(sessionId: string): Array<{content: string, createdAt: Date}>;
    async clear(sessionId: string): Promise<void>;
    async getAllActive(): Promise<Map<string, ActiveQueue>>;
}
```

При старте сервера: восстановить очереди из файлов, уведомить клиентов через WS о восстановленных задачах.

### 2.3 Per-project Tokens (дополнительно)

**Файл:** `packages/api-gateway/src/auth.ts`, Prisma schema

**Текущая модель:** ClientToken — токен с полным доступом ко всему. Нет разделения по проектам.

**Новая модель:** токены могут иметь scope по проекту:

```prisma
model ClientToken {
    id        String   @id @default(cuid())
    name      String
    token     String   @unique
    createdAt DateTime @default(now())
    lastUsed  DateTime?
    
    // НОВОЕ: ограничение области действия
    projectScope String?  // null = full access; "/data/repos/proj" = scoped
    
    @@index([projectScope])
}
```

**Практическое применение:**
- Token A: full access (admin)
- Token B: limited to `/data/repos/my-project` (team member, CI/CD)
- Token C: limited to `/data/repos/lab-workspace` (researcher)

**Аутентификация middleware:**
```typescript
function validateToken(token: string, requestedProject?: string): AuthResult {
    const clientToken = findToken(token);
    
    if (!clientToken.projectScope) return { authorized: true }; // full access
    
    if (requestedProject && clientToken.projectScope !== requestedProject) {
        return { authorized: false, reason: 'token not scoped to this project' };
    }
    
    return { authorized: true };
}
```

---

## 3. Пользовательские сценарии

### Сценарий 1: Параллельная работа с тремя проектами

**Предусловия:** фаза 5 реализована (удалён chdir, persistent queue)
**Шаги:**
1. Пользователь отправляет задачу в проект A
2. Параллельно отправляет задачу в проект B
3. Обе задачи исполняются (разные сессии, разные cwd, no conflict)

**Ожидаемый результат:** обе задачи выполняются одновременно, результаты изолированы. Без фазы 5: задача B ставится в очередь.

### Сценарий 2: Восстановление задач после reboot

**Предусловия:** persistent queue включена
**Шаги:**
1. Сервер перезапускается во время выполнения задачи
2. При старте: восстанавливаются очереди из JSONL файлов
3. Клиенты видят: "Восстановлено 3 задачи из очереди"
4. Очередь продолжает работу с точки останова

**Ожидаемый результат:** ни одна задача не потеряна.

### Сценарий 3: Ограниченный токен для CI

**Предусловия:** per-project tokens реализованы
**Шаги:**
1. CI генерирует token scoped к `/data/repos/ci-workspace`
2. Цикл деплоя вызывает FAN API только с этим токеном
3. FAN API проверяет scope — доступ разрешён только к ci-workspace

**Ожидаемый результат:** CI имеет гарантированный ограниченный доступ.

---

## 4. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Удаление chdir сломает существующие extensions/MCP | Средняя | Критичное | Аудит потребителей перед стартом; chdir оставлен как fallback; регрессионные тесты |
| Persistent queue add I/O overhead | Низкая | Низкое | Асинхронная запись; batch commits |
| Per-project tokens усложняют auth model | Средняя | Среднее | backward compatible: null scope = full access (как сейчас) |
| Parallel sessions race on shared resources | Низкая | Среднее | Один writer на SQLite — нет конфликта метаданных; JSONL append-only |

---

## 5. Компромиссы

### 5.1 Принятые решения

- **Отложить до самостоятельного решения** — фаза 5 добавляет существенную сложность ради сценариев, которые не нужны личному инструменту. Один движок + очередь из фазы 2 закрывает «бросил три задачи и пошёл спать».
- **Персистентная очередь через файлы вместо полноценной БД** — JSONL прост, надёжен, совместим с JSONL форматом сессий. Для <10 активных очередей производительность достаточна.

### 5.2 Отклонённые альтернативы

- **Parallel execution via threads/processes** — избыточно для VPS с 1–2 GB RAM. Docker-compose could isolate, но один контейнер проще.

---

## 6. Приоритеты

### Must Have (если стартует)
- Аудит потребителей `process.cwd()` и `process.chdir()`
- Замена cwd на per-session context в tool definitions
- Удаление `process.chdir()` из runtime.switchSession()
- Persistent message queue (JSONL)

### Should Have
- Рекурсивный поиск зависимостей от cwd в extensions
- Test: parallel session isolation verification
- Graceful degradation: если какой-то consumer не обновлён — fallback to chdir с warning

### Could Have
- Per-project tokens
- Background service preloading (multiple projects warm simultaneously)
- Task stealing (idle workers take from other queues)

### Won't Have (для этого проекта)
- Multi-user with RBAC — one operator model
- Kubernetes orchestration — single VPS deployment

---

## 7. Критерии запуска фазы 5

Фаза 5 НЕ запускается автоматически после фазы 4. Требуется отдельная оценка:

1. **Пользовательский спрос:** есть ли пользователи, которым нужно >1 параллельная задача?
2. **Ресурсы VPS:** достаточно RAM/CPU для параллельных сессий?
3. **Стоимость рефакторинга:** сколько мест затронет замена cwd на per-session context?
4. **Альтернативы:** решает ли текущую проблему добавление scheduler'а с task queuing?

**Если все ответы «нет» → фаза 5 не нужна. Архитектура «один движок + очередь» стабильна.**

---

## 8. Следующие шаги

- [ ] Оценить необходимость фазы 5 на основе фидбека после фазы 4
- [ ] Провести аудит `process.cwd()` / `process.chdir()` consumers
- [ ] Подготовить миграционный план (список affected files)
- [ ] Если стартует: создать test для parallel session isolation

---

*Создано: research-spec-generator skill · дата 2026-07-25*
*Фаза 5 из пакета «FAN Network Agent»*
*Спецификация ссылается на родительскую: [FAN Network Agent](./spec_fan-network-agent_2026-07-25.md)*
*⚠️ СТАТУС СТАРТА: Опционально. Отдельное решение о запуске после оценки потребности.*
