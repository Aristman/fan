# Roadmap: Фаза 5 — Конкурентность (⚠️ Опциональная фаза)

> **Дата создания:** 2026-07-25
> **Источник:** [spec_fan-network-agent_phase5-concurrency_2026-07-25.md](../../specs/spec_fan-network-agent_phase5-concurrency_2026-07-25.md) · [родительская spec](../../specs/spec_fan-network-agent_2026-07-25.md)
> **Фич:** 8 | **Этапов:** 5 | **E2E-сценариев:** 1
> **Статус старта:** ⚠️ **ОПЦИОНАЛЬНО** — решение о запуске принимается отдельно после оценки ценности vs стоимости (см. §7 spec)

---

## Стартует ли фаза 5?

См. критерии запуска из родительской спецификации (§7):

1. **Пользовательский спрос:** есть ли пользователи с потребностью >1 параллельная задача?
2. **Ресурсы VPS:** достаточно RAM/CPU для параллельных сессий?
3. **Стоимость рефакторинга:** сколько мест затронет замена cwd на per-session context?
4. **Альтернативы:** решает ли scheduler с task queuing текущую проблему?

**Если все ответы «нет» → фаза 5 не нужна.** Архитектура «один движок + очередь» стабильна.

Зависимости от предыдущих фаз: фаза 5 зависит от фаз 1–2 (workspace-aware API, Service Registry), так как `AgentSessionRuntime` и SessionManager изменены напрямую.

---

## Сводная таблица по приоритетам

| Приоритет | Кол-во фич | Описание |
|-----------|-----------|----------|
| P0 (Must) | 6 | Audit cwd/chdir consumers, replace cwd in tool defs, remove chdir, persistent queue, E2E |
| P1 (Should) | 1 | Server startup queue restore |
| P2 (Could) | 1 | Per-project tokens |
| P3 | 0 | Нет |

---

## Легенда

| Маркер | Значение |
|--------|---------|
| ☐ | Не начато |
| ✅ | Готово |
| ⏳ | В работе |
| ❌ | Отклонено |

| Приоритет | MoSCoW | Оценка |
|-----------|--------|--------|
| P0 | Must Have | Критично для мультипроектной конкурентности |
| P1 | Should Have | Желательно перед удалением chdir |
| P2 | Could Have | Можно отложить |
| P3 | Won't Have | Отклонено для текущей фазы |

### Слои реализации

| Слой | Описание |
|------|----------|
| [API] | Изменения API Gateway (auth middleware, per-project tokens) |
| [DATA] | Персистентная очередь сообщений (JSONL файлы) |
| [BIZ] | Бизнес-логика: scope токенов, session context management |
| [INFRA] | Аудит потребителей process.cwd()/chdir, регрессионные тесты |
| [E2E] | Комплексные сквозные сценарии конкурентности |

---

## Этап 5.0 — Аудит и план миграции

**Цель SMART:** Полностью завершён grep-аудит всех потребителей `process.cwd()` и `process.chdir()` в директориях `packages/*`, `tools/*`, `skills/*/`. Результат аудита оформлен в виде migration plan: список affected files, категория зависимости (direct consumer, indirect via module, safe skip), оценка сложности замены. План проходит review (минимум 1 разработчик), нет ложных positive/negative.

### Фичи

#### ☐ F-5.1: Аудит потребителей `process.cwd()`

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Сканирование кодовой базы (grep `process\.cwd\(\)`) по всем `packages/*`, `tools/*`, `skills/*/SKILL.md`. Результаты категоризированы:
  - **Direct consumer** — читает cwd напрямую; требует замены на explicit parameter
  - **Indirect via module** — передаёт результат функции/конструктору; требует изменения сигнатуры
  - **Safe skip** — используется для логирования / diagnostics (не влияет на поведение)
  Файл результатов: `docs/research/process-cwd-audit-phase5.md` с таблицей файлов, строк, типов зависимостей.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-5.1-1:** Известный потребитель найден и категоризирован
    - *Условие:* `packages/coding-agent/src/core/agent-session-runtime.ts` содержит `process.chdir()` line ~119–148 (известный по spec)
    - *Шаги:* Grep result check
    - *Ожидаемый результат:* Файл указан с type = 'Direct consumer'; номер строки совпадает (~119–148)
  - [ ] **TC-F-5.1-2:** Нет ложных пропусков для критических путей
    - *Условие:* Известные consumers в packages/coding-agent/, packages/api-gateway/, packages/model-manager/
    - *Шаги:* Compare grep output against known locations
    - *Ожидаемый результат:* Все известные потребители присутствуют в отчёте аудита; покрытие 100% целевых директорий
- **Критерии приёмки:**
  1. Grep выполнен по всем `packages/**/*.{ts,js,mjs}` и `tools/**/*`
  2. Каждый match проанализирован вручную (не только автокатегоризация)
  3. Migration plan содержит estimated effort per file (S/M/L)
- **Ожидаемый результат:** Markdown-файл `docs/research/process-cwd-audit-phase5.md` с полной таблицей affected files
- **Оценка объёма:** S

#### ☐ F-5.2: Аудит потребителей `process.chdir()`

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Аналогичный grep-аудит для `process\.chdir\(`. Основная цель — найти ВСЕ места где вызывается global cwd mutation. Ключевой файл: `packages/coding-agent/src/core/agent-session-runtime.ts` (line 119–148), но также проверить extensions, MCP серверы, любые утилиты.
- **Зависимости:** F-5.1 (предварительный аудит cwd)
- **TDD-тесты:**
  - [ ] **TC-F-5.2-1:** agent-session-runtime.ts найден
    - *Условие:* File exists at expected path
    - *Шаги:* Grep for `process\.chdir\(`
    - *Ожидаемый результат:* Match found at approximately line 119–148; categorized as 'Critical — must replace'
  - [ ] **TC-F-5.2-2:** Extensions проверены на использование chdir
    - *Условие:* packages/extensions/* и tools/* проверены
    - *Шаги:* Убедиться в отсутствии неожиданных chdir-вызовов
    - *Ожидаемый результат:* Если найдены — задокументированы; если нет — подтверждено в отчёте
- **Критерии приёмки:**
  1. Точное количество найденных `process.chdir()` вызовов подсчитано
  2. Для каждого вызова определён replacement strategy (перечислены параметры для передачи)
  3. Zero unhandled calls remaining after manual review
- **Ожидаемый результат:** Дополнение к audit report; блок "chdir callers" с детальным планом удаления
- **Оценка объёма:** S

---

## Этап 5.1 — Удаление `process.chdir()` и per-session cwd

**Цель SMART:** Метод `switchSession()` в `AgentSessionRuntime` больше НЕ вызывает `process.chdir()`. Каждое tool definition получает `cwd` явно через замыкание при создании. Все инструменты resolved paths relative to session cwd вместо `process.cwd()`. Regression тест: mock `process.chdir` → assert zero calls during parallel sessions.

### Фичи

#### ☐ F-5.3: Replace cwd on tool definitions — per-session context

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Рефакторинг `AgentSessionRuntime.createAllToolDefinitions(cwd)` (file `packages/coding-agent/src/core/agent-session-runtime.ts`). Новый паттерн: каждый инструмент оборачивается в closure с captured `cwd`:

```typescript
// Before: uses global process.cwd()
fn: async (args) => { toolFn(process.cwd(), args.path) }

// After: receives explicit cwd
fn: async (args) => { toolFn(resolveToCwd(cwd, args.path), ...) }
```

Все потребители `process.cwd()` внутри tools replaced с явной передачей cwd. ResourceLoader принимает cwd параметром вместо чтения глобального. Проверка через grep: `process.cwd()` count в package reduced to zero (или осталось только для diagnostics/headers).
- **Зависимости:** F-5.1, F-5.2 (результаты аудита определяют цели замены)
- **TDD-тесты:**
  - [ ] **TC-F-5.3-1:** Инструмент резолвит путь относительно cwd сессии
    - *Условие:* Session created with cwd='/data/repos/proj-A'; tool calls function with relative path '../other-file'
    - *Шаги:* Инструмент выполняется; функция получает путь
    - *Ожидаемый результат:* Path resolved to '/data/repos/proj-A/../other-file' NOT `/current-working-dir/../other-file`
  - [ ] **TC-F-5.3-2:** process.cwd() не вызывается внутри инструментов
    - *Условие:* Spy/mock process.cwd installed
    - *Шаги:* Execute multiple tools across different sessions
    - *Ожидаемый результат:* process.cwd() call count === 0 (or only diagnostic logs explicitly allowed)
  - [ ] **TC-F-5.3-3:** Параллельные сессии имеют независимые контексты инструментов
    - *Условие:* Запущены две сессии с разными cwd; обе выполняют инструменты чтения/записи файлов
    - *Шаги:* Execute operations in both sessions simultaneously (mock concurrent execution)
    - *Ожидаемый результат:* Session A reads/writes within proj-A paths; Session B within proj-B; no cross-contamination
- **Критерии приёмки:**
  1. Каждая tool definition созданная в createAllToolDefinitions() получает cwd через замыкание
  2. resource-loader принимает cwd параметр в конструкторе
  3. All existing bash/tool calls verified to work with new cwd propagation
- **Ожидаемый результат:** Refactored `packages/coding-agent/src/core/agent-session-runtime.ts`; all affected tools updated
- **Оценка объёма:** L

#### ☐ F-5.4: Remove `process.chdir()` from runtime.switchSession()

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Удаление строки `process.chdir(targetPath)` из метода `switchSession()` в `AgentSessionRuntime`. Новая реализация: вместо глобальной мутации — создание нового `SessionContext` с cwd замыканием:

```typescript
async switchSession(sessionId: string, cwd: string): Promise<void> {
    const ctx = new SessionContext({
        cwd,
        sessionId,
        settings: await loadProjectSettings(cwd),
        tools: this.createAllToolDefinitionsForContext(cwd),
    });
    this.currentSessions.set(sessionId, ctx);
}
```

Полный teardown старого контекста происходит до создания нового. Но глобальный процесс cwd НЕ мутируется.
- **Зависимости:** F-5.3 (tools не зависят от process.cwd())
- **TDD-тесты:**
  - [ ] **TC-F-5.4-1:** switchSession без вызова process.chdir
    - *Условие:* Spy on process.chdir
    - *Шаги:* Call `switchSession('session-1', '/path/a')`
    - *Ожидаемый результат:* process.chdir() NOT called; session context created with cwd='/path/a'
  - [ ] **TC-F-5.4-2:** Несколько последовательных switchSession сохраняют изоляцию
    - *Условие:* Switch from /proj-A → /proj-B → /proj-A
    - *Шаги:* Three consecutive switchSession calls
    - *Ожидаемый результат:* Каждая сессия восстановлена с корректным cwd; последнее состояние соответствует последнему switch; остаточного глобального состояния нет
  - [ ] **TC-F-5.4-3:** Teardown старого контекста освобождает ресурсы
    - *Условие:* Old session had open file handles / timers
    - *Шаги:* Call switchSession
    - *Ожидаемый результат:* Old context cleaned up; no memory leaks; GC collects unused references
- **Критерии приёмки:**
  1. Строка `process.chdir(targetPath)` полностью удалена из `agent-session-runtime.ts`
  2. SessionContext включает полный set параметров (cwd, settings, tools) без использования globals
  3. Обратная совместимость: сигнатура вызова расширена до `switchSession(sessionId, cwd)`; все вызывающие места обновлены, старые вызовы `switchSession(path)` удалены
- **Ожидаемый результат:** Обновлённый метод `switchSession()` в `packages/coding-agent/src/core/agent-session-runtime.ts`
- **Оценка объёма:** M

---

## Этап 5.2 — Персистентная очередь сообщений

**Цель SMART:** В `packages/api-gateway/src/message-queue.ts` реализован класс `PersistentMessageQueue` с методами `enqueue`, `dequeue`, `peekAll`, `clear`, `getAllActive`. Хранение — JSONL файлы в `~/.fan/agent/queues/<sessionId>.queue.jsonl`. Индекс активных очередей в `~/.fan/agent/queues/queue-index.json`. При старте сервера очереди восстанавливаются из файлов; клиенты уведомляются через WS о восстановленных задачах.

### Фичи

#### ☐ F-5.5: Persistent message queue — core operations

- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Замена или дополнение существующей in-memory очереди (`packages/api-gateway/src/message-queue.ts`) на JSONL-based persistence. Format per entry:

```jsonl
{"sessionId":"clxxx","content":"message body","createdAt":"2026-07-25T10:00:00Z","priority":"normal"}
```

Индекс `queue-index.json` ведёт карту `{ <sessionId>: true/false }` для быстрого определения активных очередей. Операции: async write (append-only JSONL), atomic index updates (rename temp → actual), sequential dequeue (FIFO порядок сохранён по createdAt).
- **Зависимости:** (none) — standalone queue layer; replaces/enhances phase 2 queue
- **TDD-тесты:**
  - [ ] **TC-F-5.5-1:** Enqueue создаёт/дополняет JSONL-файл
    - *Условие:* Queue for session 'cl-test' doesn't exist yet
    - *Шаги:* `await queue.enqueue('cl-test', 'Hello world')`
    - *Ожидаемый результат:* File `~/.fan/agent/queues/cl-test.queue.jsonl` created with one JSON line; queue-index.json contains `'cl-test': true`
  - [ ] **TC-F-5.5-2:** Dequeue возвращает элементы в порядке FIFO
    - *Условие:* Queue has 3 entries (enqueued sequentially)
    - *Шаги:* 3x dequeue()
    - *Ожидаемый результат:* First call returns content='Hello world'; second = next entry; third = last; empty after third
  - [ ] **TC-F-5.5-3:** Файл переживает перезапуск сервера
    - *Условие:* Queue has pending messages; "restart" (new queue instance)
    - *Шаги:* Create new PersistentMessageQueue instance; peekAll for that sessionId
    - *Ожидаемый результат:* All pending messages recovered; total count matches pre-restart value
- **Критерии приёмки:**
  1. Все 5 публичных методов реализованы корректно (enqueue, dequeue, peekAll, clear, getAllActive)
  2. Concurrent enqueues handled safely (atomic append to JSONL file)
  3. I/O errors logged and retry attempted (max 3 times before failing enqueue)
- **Ожидаемый результат:** Обновлённый `packages/api-gateway/src/message-queue.ts` с новым классом + backup method
- **Оценка объёма:** M

#### ☐ F-5.6: Server startup — restore queues and notify clients

- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** При старте API Gateway (`main.ts`) после инициализации WebSocket connection manager: восстановить все активные очереди из JSONL файлов, для каждой активной очереди уведомить подключённых клиентов через WS event: `{ type: 'queues_restored', restoredCount: N, sessions: [...] }`. Это позволяет клиентам узнать о потерянных во время reboot задачах и продолжить ожидание.
- **Зависимости:** F-5.5 (инфраструктура очереди готова)
- **TDD-тесты:**
  - [ ] **TC-F-5.6-1:** Очереди восстановлены при старте сервера
    - *Условие:* JSONL files contain pending messages from previous run
    - *Шаги:* Start server; wait for ready; connect client WS
    - *Ожидаемый результат:* Client receives `queues_restored` event; restoredCount = N; sessions list matches files on disk
  - [ ] **TC-F-5.6-2:** Пустой сервер стартует чисто
    - *Условие:* No queue files exist (fresh start)
    - *Шаги:* Start server
    - *Ожидаемый результат:* No queues_restored event sent; or event with restoredCount = 0; no errors
- **Критерии приёмки:**
  1. `getAllActive()` called during server bootstrap phase
  2. WS broadcast executed AFTER all client connections registered
  3. Error during restoration logged and non-fatal (server starts anyway)
- **Ожидаемый результат:** Patch in server startup sequence (`main.ts` initialization section)
- **Оценка объёма:** S

---

## Этап 5.3 — Перспективные улучшения (per-project tokens)

**Цель SMART:** Prisma schema расширена полем `projectScope String?` на модели `ClientToken`. Auth middleware проверяет scope: null = full access (backward compatible); scoped token limited to exact project path. Token creation endpoint accepts optional scope. Регрессия тестов: существующие full-access токены продолжают работать без изменений.

### Фичи

#### ☐ F-5.7: Per-project tokens scope — schema + auth middleware

- **Приоритет:** P2
- **Слой:** [API]
- **Описание:** Расширение `ClientToken` модели в Prisma (файл `packages/db/prisma/schema.prisma`): добавлено поле `projectScope String?` с индексом `@@index([projectScope])`. Default null = full access (полная обратная совместимость). Middleware `validateToken(token, requestedProject?)` в `packages/api-gateway/src/auth.ts` проверяет scope при наличии запроса проекта. Создана миграция Prisma (backwards compatible: nullable field).
- **Зависимости:** (none) — но зависит от готовности auth middleware (фаза 0 уже сделала basic auth)
- **TDD-тесты:**
  - [ ] **TC-F-5.7-1:** Null scope = полный доступ (обратная совместимость)
    - *Условие:* Token с projectScope = null (старый токен); запрос к любому проекту
    - *Шаги:* `validateToken(token, '/any/project/path')`
    - *Ожидаемый результат:* `{ authorized: true }`; legacy behavior preserved
  - [ ] **TC-F-5.7-2:** Токен со scope ограничен проектом
    - *Условие:* Token с projectScope = '/data/repos/my-project'; request to '/data/repos/other'
    - *Шаги:* `validateToken(token, '/data/repos/other')`
    - *Ожидаемый результат:* `{ authorized: false, reason: 'token not scoped to this project' }`
  - [ ] **TC-F-5.7-3:** Точное совпадение пути проекта разрешено
    - *Условие:* Scoped token = '/data/repos/my-project'; request to same path
    - *Шаги:* `validateToken(token, '/data/repos/my-project')`
    - *Ожидаемый результат:* `{ authorized: true }`
- **Критерии приёмки:**
  1. Prisma migration generated and applied (`npx prisma migrate dev`)
  2. Nullable field ensures zero breaking changes for existing tokens
  3. Index on projectScope for efficient lookup
- **Ожидаемый результат:** Обновление `packages/db/prisma/schema.prisma` + migration file; обновлённый auth middleware
- **Оценка объёма:** M

---

## Этап 5.4 — E2E-сценарии фазы 5

**Цель SMART:** Проверить сквозным сценарием полную изоляцию параллельных сессий разных проектов: два клиента одновременно работают без гонок, `process.chdir()` не вызывается, JSONL сессий целостны, персистентная очередь переживает перезапуск.

### Фичи

#### ☐ F-5.8-E2E: E2E — Два клиента, параллельные сессии разных проектов, целостность JSONL

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Два клиента одновременно отправляют сообщения в сессии разных проектов (разные cwd). Оба выполняются без гонок на общий ресурс. JSONL сессии обоих проектов остаются целостными (без смешения записей между проектами). Проверяется что персистентная очередь + удаление chdir обеспечивают полную изоляцию.
- **Зависимости:** F-5.3..F-5.6 (все изменения cwd и очереди применены)
- **TDD-тесты:**
  - [ ] **TC-F-5.8-E2E-1:** Параллельные сессии изолированы — без гонок
    - *Условие:* Клиент A отправляет message в проект X (/data/repos/proj-X); Клиент B отправляет message в проект Y (/data/repos/proj-Y) ОДНОВРЕМЕННО
    - *Шаги:*
      1. Инициализировать два WebSocket подключения
      2. Одновременно отправить `{ type: 'sendMessage', sessionId: 'sess-x', content: '...' }` и `{ type: 'sendMessage', sessionId: 'sess-y', content: '...' }`
      3. Дождаться выполнения обеих задач
    - *Ожидаемый результат:* Обе задачи выполнены; каждая в своей сессии; никаких interleaved операций; обе JSONL сессии содержат ровно свои записи (zero cross-contamination)
  - [ ] **TC-F-5.8-E2E-2:** Инвариант process.cwd() сохраняется
    - *Условие:* Сервер запущен; две параллельные сессии выполняют команды (bash tool, file ops)
    - *Шаги:* Monitor `process.cwd()` value throughout execution; verify it never changes
    - *Ожидаемый результат:* `process.cwd()` остаётся равным значению при старте сервера в течение всего времени работы двух параллельных сессий; ноль вызовов `process.chdir()`
  - [ ] **TC-F-5.8-E2E-3:** Очередь сообщений переживает перезапуск во время выполнения
    - *Условие:* Клиент A отправил 3 сообщения в очередь проекта X; сервер перезапускается пока эти сообщения ожидают обработки
    - *Шаги:*
      1. Отправить 3 сообщения в queue для sess-x
      2. Остановить сервер (SIGTERM)
      3. Запустить сервер заново
      4. Подключиться WS клиентом к sess-x
    - *Ожидаемый результат:* Восстановлены все 3 сообщения; очередь продолжает работу с точки останова; ни одно сообщение не потеряно; client уведомлён через queues_restored event
- **Критерии приёмки:**
  1. Две параллельные сессии (mocked concurrent processing) показывают полную изоляцию cwd, ресурсов и результатов
  2. `process.chdir()` нигде не вызывается во время выполнения
  3. Персистентная очередь восстанавливает ВСЕ задачи после crash/restart
- **Ожидаемый результат:** E2E тест на Bun или скрипт интеграционного тестирования с двумя параллельными WebSocket клиентами
- **Оценка объёма:** L

---

## Граф зависимостей

```
Фаза 5 — Concurrency (ОПЦИОНАЛЬНО)
├── Этап 5.0: Аудит и план миграции
│   ├── F-5.1: Audit process.cwd() consumers ─────────────────►
│   └── F-5.2: Audit process.chdir() consumers ←── F-5.1       │
│                                                              │
├── Этап 5.1: Удаление chdir + per-session cwd                 │
│   ├── F-5.3: Replace cwd in tool defs ←── F-5.1,F-5.2       │
│   └── F-5.4: Remove chdir from switchSession ←── F-5.3       │
│                                                              │
├── Этап 5.2: Персистентная очередь                            │
│   ├── F-5.5: Persistent queue core (JSONL)                   │
│   └── F-5.6: Restore on startup + WS notify ←── F-5.5       │
│                                                              │
├── Этап 5.3: Перспективное                                    │
│   └── F-5.7: Per-project tokens (API)                        │
│                                                              │
└── Этап 5.4: E2E                                              │
    └── F-5.8-E2E: Параллельные сессии ← ALL above             │

Проверка циклов: Циклов нет. DAG ✓
```

---

## Полный чеклист по приоритетам

### P0 (Must Have) — 6 фич

- [ ] ☐ F-5.1 Аудит process.cwd() consumers
- [ ] ☐ F-5.2 Аудит process.chdir() consumers
- [ ] ☐ F-5.3 Replace cwd on tool definitions — per-session context
- [ ] ☐ F-5.4 Remove process.chdir() from runtime.switchSession()
- [ ] ☐ F-5.5 Persistent message queue — core operations
- [ ] ☐ F-5.8-E2E E2E: параллельные сессии + integrity

### P1 (Should Have) — 1 фич

- [ ] ⏳ F-5.6 Server startup — restore queues and notify clients

### P2 (Could Have) — 1 фич

- [ ] ☐ F-5.7 Per-project tokens scope — schema + auth middleware

> Примечание: Аудит (F-5.1/F-5.2) имеет приоритет P1 в spec, но является обязательным prerequisite для F-5.3+, поэтому помечен как P0 в этом roadmap.

---

## Итоговая оценка

| Мера | Значение |
|------|---------|
| Всего фич | 8 (6 реализаций + 1 E2E + 1 перспективная) |
| P0 фич | 6 |
| P1 фич | 1 |
| P2 фич | 1 |
| Этапов | 5 (аудит, удаление chdir, очередь, перспективные, E2E) |
| Оценка P0 | ~4 дня (audit: 4h + cwd refactor: 12h + persistent queue: 8h + E2E: 4h) |
| Оценка полная | ~6–8 дней |

**Важное предупреждение:** Фаза 5 вносит существенный рефакторинг архитектуры. Удаление `process.chdir()` затрагивает CORE компоненты (`agent-session-runtime.ts`, все tools, ResourceLoader, extensions, MCP-серверы). Рекомендуется провести аудит (этап 5.0) ДО принятия решения о старте фазы. Если аудит выявит >20 affected files — оценить стоимость дополнительно.

**Зависимости от предыдущих фаз:**
- Фаза 1: `AgentSessionRuntime` использует Session с cwd — фаза 5 удаляет chdir, заменяя на per-session context
- Фаза 2: Service Registry кэширует сервисы по cwd; фаза 5 меняет стратегию инвалидации (теперь cwd не глобален)

---

*Сгенерировано: docs-impl agent · 2026-07-25*
*На основе: spec_fan-network-agent_phase5-concurrency_v1.0*
*⚠️ СТАТУС СТАРТА: Опционально. См. критерии запуска в §7 родительской спецификации.*
