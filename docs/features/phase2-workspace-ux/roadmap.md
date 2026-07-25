# Roadmap: Фаза 2 — Workspace UX (Service Registry / очередь / dashboard switcher)

> **Дата создания:** 2026-07-25
> **Источник:** [spec_fan-network-agent_phase2-workspace-ux_2026-07-25.md](../../specs/spec_fan-network-agent_phase2-workspace-ux_2026-07-25.md) · [родительская spec](../../specs/spec_fan-network-agent_2026-07-25.md)
> **Фич:** 14 | **Этапов:** 5 | **E2E-сценариев:** 1

---

## Сводная таблица по приоритетам

| Приоритет | Кол-во фич | Описание |
|-----------|-----------|----------|
| P0 (Must) | 9 | Service Registry LRU, queue + mutex, project switcher, session grouping, API client project params, settings reload, MCP reconnect, E2E #1 |
| P1 (Should) | 5 | Queue position UI, error handling, config auto-invalidation, MCP reconnect, settings reload |
| P2 (Could) | 0 | Нет |
| P3 (Won't Have) | 0 | Нет |

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
| P0 | Must Have | Критично для многопроектной работы |
| P1 | Should Have | Желательно до релиза фазы 2 |
| P2 | Could Have | Можно отложить |
| P3 | Won't Have | Отклонено для текущей фазы |

### Слои реализации

| Слой | Описание |
|------|----------|
| [API] | Изменения HTTP/WebSocket API (gateway, ws-handler, message-queue) |
| [UI] | Lit компоненты dashboard (switcher, tree view, индикаторы) |
| [INFRA] | Сервисный кеш и очереди (ServiceRegistry, MessageQueue, Mutex) |
| [INTEG] | Интеграция сервисов при переключении (settings, MCP, extensions) |
| [BIZ] | Бизнес-логика: обработка ошибок, статусы проектов |
| [E2E] | Комплексные сквозные сценарии |

---

## Этап 2.1 — Бэкенд: Service Registry + Mutex

**Цель SMART:** Реализовать `ServiceRegistry` (инфракрасный класс с LRU-кешем `Map<cwd, AgentSessionServices>`, лимит 5) и `InMemoryMutex` с методами `withLock()`. Кеш позволяет избежать полного teardown/recreate сервисов при каждом switch проекта. Время переключения <2 сек при активном кеше. Базируется на workspace API фазы 1 (`packages/coding-agent/src/core/session-manager.ts`).

### Фичи

#### ☐ F-2.1: ServiceRegistry — кеш сервисов по cwd

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Новый модуль `packages/coding-agent/src/workspace/service-registry.ts`. Класс `ServiceRegistry` с кешём `Map<cwd, {services: AgentSessionServices, lastAccess: number}>`, методы `get(cwd)`, `set(cwd, services)`, `invalidate(cwd)`, `clear()`. Размер кеша configurable (default 5). `get()` обновляет `lastAccess`. Конструктор принимает `maxItems`. Использует сервисы из `AgentSessionRuntime` после `switchSession()`.
- **Зависимости:** Phase 1 API (session cwd в Prisma Session, `packages/db/prisma/schema.prisma`)
- **TDD-тесты:**
  - [ ] **TC-F-2.1-1:** get/set/invalidation работают корректно
    - *Условие:* new ServiceRegistry(maxItems=3), cwd = '/a', '/b'
    - *Шаги:* set('/a', svcA) → get('/a') → invalidate('/a') → get('/a')
    - *Ожидаемый результат:* get('/a') возвращает svcA; invalidate → null
  - [ ] **TC-F-2.1-2:** clear() освобождает все сервисы
    - *Условие:* 3 сервиса в кеше
    - *Шаги:* clear(); проверить size
    - *Ожидаемый результат:* cache.size === 0; все сервисы завершены (cleanup вызван)
- **Критерии приёмки:**
  1. Методы get/set/invalidate/clear работают как specified в spec (раздел 2.1)
  2. `get()` обновляет `lastAccess` для LRU учёта
  3. `clear()` вызывает cleanup для каждого entry перед удалением
- **Ожидаемый результат:** `packages/coding-agent/src/workspace/service-registry.ts` + unit tests в `service-registry.test.ts`
- **Оценка объёма:** S

#### ☐ F-2.2: LRU eviction при достижении лимита

- **приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Метод `set()` проверяет `cache.size >= maxItems`. Если full — находит entry с минимальным `lastAccess` через итерацию Map, вызывает `evict(oldestKey)` (= delete + cleanup). Элемент не попадает в кеш пока старый не удалён. Гарантирует, что кеш никогда не превышает maxItems.
- **Зависимости:** F-2.1 (базовый ServiceRegistry)
- **TDD-тесты:**
  - [ ] **TC-F-2.2-1:** Oldest entry вытесняется автоматически
    - *Условие:* maxItems=2, добавлены /a (t=100) и /b (t=200), затем set('/c', svcC)
    - *Шаги:* set('/c', svcC); get('/a')
    - *Ожидаемый результат:* '/a' вытеснен (lastAccess=100 oldest); get('/a') → null; '/c' в кеше
  - [ ] **TC-F-2.2-2:** Последний доступ — самый свежий, а не последний добавленный
    - *Условие:* maxItems=2, set('/a'), get('/a'), set('/b'); get('/a') снова
    - *Шаги:* set('/c', svcC); get('/a'); get('/b')
    - *Ожидаемый результат:* '/b' вытеснен (последний access без обновления); '/a' остаётся в кеше
- **Критерии приёмки:**
  1. При `size >= maxItems` всегда evicts entry с наименьшим `lastAccess`
  2. Cleanup вызывается для вытесненного entry
  3. new entry добавляется после evict (atomic operation)
- **Ожидаемый результат:** Дополнение `service-registry.ts`: метод `set()` c eviction logic
- **Оценка объёма:** S

#### ⏳ F-2.3: InMemoryMutex базовый класс

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Минимальный асинхронный мьютекс: `class Mutex { private locked = false; private queue: PromiseResolver[] = []; async acquire() { ... } async release() { ... } withLock(fn) { ... } }`. `withLock()` — удобный wrapper для критических секций. Используется MessageQueue для защиты очередей per-session.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-2.3-1:** Sequential calls serialized
    - *Условие:* new Mutex(), две параллельные withLock()
    - *Шаги:* запустить concurrently; записать порядок вызова fn
    - *Ожидаемый результат:* Порядок строго последовательный; второй вызов ждёт освобождения
  - [ ] **TC-F-2.3-2:** withLock возвращает значение из функции
    - *Условие:* new Mutex(), withLock(() => 42)
    - *Шаги:* result = await withLock(() => 42)
    - *Ожидаемый результат:* result === 42
- **Критерии приёмки:**
  1. `acquire/release` управляют состоянием locked
  2. FIFO очередь ожидания (FIFO wait queue)
  3. `withLock(fn)` — синхронизирует + возвращает результат
- **Ожидаемый результат:** `packages/coding-agent/src/workspace/mutex.ts` (новый модуль)
- **Оценка объёма:** S

---

## Этап 2.2 — Бэкенд: FIFO-очередь сообщений

**Цель SMART:** Реализовать `InMemoryMessageQueue` с пер-сессией очередями и mutex-защитой. Методы: `enqueue(sessionId, message)`, `dequeue(sessionId)`, `peek(sessionId)`, `size(sessionId)`. Интегрировать в WebSocket handler `packages/api-gateway/src/ws-handler.ts` — проверка `runtime.isExecuting()` перед dispatch, enqueue при busy state. Очередь in-memory: данные теряются при рестарте сервера (допустимо для MVP).

### Фичи

#### ☐ F-2.4: InMemoryMessageQueue — базовая реализация

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Новый модуль `packages/api-gateway/src/message-queue.ts`. Интерфейс `MessageQueue`: `enqueue`, `dequeue`, `peek`, `size`. Реализация: `Map<string, Array<{message: any, timestamp: number}>>` + `Map<string, Mutex>`. Каждый sessionId имеет свою очередь и свой мьютекс. FIFO порядок элементов. Точки изменений spec: #13 (перенос из фазы 5).
- **Зависимости:** F-2.3 (Mutex)
- **TDD-тесты:**
  - [ ] **TC-F-2.4-1:** FIFO порядок сохраняется
    - *Условие:* enqueue A, B, C одного sessionId
    - *Шаги:* dequeue трижды
    - *Ожидаемый результат:* Последовательность A → B → C
  - [ ] **TC-F-2.4-2:** Независимые сессии не влияют друг на друга
    - *Условие:* enqueue в 'sess-1' и 'sess-2'
    - *Шаги:* dequeue('sess-1') три раза
    - *Ожидаемый результат:* sess-1: все свои; dequeue('sess-2') возвращает null если пусто
- **Критерии приёмки:**
  1. `enqueue` пушит элемент в конец массива под sessionId
  2. `dequeue` шифрует (shifts) первый элемент
  3. `size` возвращает длину массива (0 если нет очереди)
- **Ожидаемый результат:** `packages/api-gateway/src/message-queue.ts` + unit tests
- **Оценка объёма:** M

#### ☐ F-2.5: WebSocket handler integration — enqueue on busy

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Модификация `packages/api-gateway/src/ws-handler.ts`: при incoming `sendMessage` проверять `runtime.isExecuting()`. Если true и sessionId ≠ currentActiveSessionId — вызывать `messageQueue.enqueue()`, отправлять клиенту `{ type: 'queued', position: N }`. Иначе — dispatch напрямую через `runtime.sendMessage()`. По завершении задачи: `dequeue()` следующей. Проверка спецификации: раздел 2.6, псевдокод handleWsMessage.
- **Зависимости:** F-2.4 (MessageQueue), runtime API `isExecuting()`
- **TDD-тесты:**
  - [ ] **TC-F-2.5-1:** Сообщение ставится в очередь при занятом движке
    - *Условие:* runtime.busy=true, sendMessage для другого sessionId
    - *Шаги:* ws.send {type:'sendMessage', content:'test'}
    - *Ожидаемый результат:* Клиент получает {type:'queued', position:1}; сообщение в очереди
  - [ ] **TC-F-2.5-2:** Сообщение отправлено немедленно при свободном движке
    - *Условие:* runtime.busy=false
    - *Шаги:* ws.send {type:'sendMessage', content:'test'}
    - *Ожидаемый результат:* Сообщено в runtime прямо; очередь пуста
- **Критерии приёмки:**
  1. Проверяется `runtime.isExecuting()` перед dispatch
  2. При занятости — enqueue + notification `{ queued, position }`
  3. После завершения задачи — dequeue следующей (background processor)
- **Ожидаемый результат:** Обновлённый `ws-handler.ts`; background dequeue loop
- **Оценка объёма:** M

---

## Этап 2.3 — Frontend: Dashboard components

**Цель SMART:** Создать Lit компоненты `<fan-project-switcher>` и модифицировать `<fan-session-list>` для tree-grouping. Switcher показывает dropdown всех проектов из `GET /api/projects`, подсветка выбранного, кнопка «+» для нового проекта. Сессионный список группируется по `cwd` с раскрытием/сворачиванием и цветовой кодировкой статусов.

### Фичи

#### ☐ F-2.6: `<fan-project-switcher>` компонент

- **Приоритет:** P0
- **Слой:** [UI]
- **Описание:** Новый Lit компонент в `packages/dashboard/src/components/project-switcher.ts`. Props: `.projects`, `.currentProject`. Dropdown со всеми проектами из API. Выбранный проект подсвечен CSS-классом `.active`. Кнопка «+» открывает inline-form ввода path. Поиск по имени (filter input). Индикатор количества сессий рядом с названием. Event `@project-select` с `{ path }`. Анимация появления dropdown.
- **Зависимости:** Phase 1 endpoint `GET /api/projects` (`packages/dashboard/src/api/client.ts`)
- **TDD-тесты:**
  - [ ] **TC-F-2.6-1:** Dropdown рендерит все проекты
    - *Условие:* .projects=[{path:'/a',name:'Alpha'},{path:'/b',name:'Beta'}], .currentProject='/a'
    - *Шаги:* render component; проверить shadow DOM
    - *Ожидаемый результат:* Два пункта списка; Alpha подсвечен как active
  - [ ] **TC-F-2.6-2:** @project-select fires на клик
    - *Условие:* Component рендерен с проектами
    - *Шаги:* кликнуть на Beta; слушать event
    - *Ожидаемый результат:* Event fired с detail `{ path: '/b' }`; bubbles=true
- **Критерии приёмки:**
  1. Компонент зарегистрирован как custom element `<fan-project-switcher>`
  2. Dropdown рендерит проекты из props, currentProject подсвечен
  3. Event `@project-select` передаёт `{ path }`
- **Ожидаемый результат:** `packages/dashboard/src/components/project-switcher.ts` + CSS стили
- **Оценка объёма:** M

#### ☐ F-2.7: `<fan-session-list>` tree grouping по cwd

- **Приоритет:** P0
- **Слой:** [UI]
- **Описание:** Текущий плоский `<fan-session-list>` заменяется на древовидную структуру. Группировка по полю `cwd` (из `GET /api/sessions?project=`). Каждый уровень дерева: сворачивание/раскрытие (toggle icon ▼/▶). Счётчик сессий у проекта. Цветовая кодировка: 🟢 зелёный — active, 🔵 синий — completed, 🟡 жёлтый — draft/error. CSS классы: `.tree-group`, `.tree-item`, `.status-active`, `.status-completed`, `.status-error`.
- **Зависимости:** F-2.6 (project switcher), API `GET /api/sessions?project=`
- **TDD-тесты:**
  - [ ] **TC-F-2.7-1:** Сессии группируются по cwd
    - *Условие:* sessions=[{id:1,cwd:'/a'...},{id:2,cwd:'/a'...},{id:3,cwd:'/b'...}]
    - *Шаги:* render list
    - *Ожидаемый результат:* Две группы '/a' (2 сессии) и '/b' (1 сессия); вложенные элементы сессий внутри групп
  - [ ] **TC-F-2.7-2:** Toggle раскрывает/сворачивает группу
    - *Условие:* Рендеренная группа закрыта
    - *Шаги:* кликнуть toggle иконку
    - *Ожидаемый результат:* Сессии внутри появляются/скрываются; иконка меняется ▼↔▶
- **Критерии приёмки:**
  1. Группировка выполняется по unique cwd values
  2. Toggle работает для каждой группы независимо
  3. Статусы отображаются цветовыми индикаторами согласно spec
- **Ожидаемый результат:** Обновлённый `packages/dashboard/src/components/session-list.ts`
- **Оценка объёма:** M

#### ☐ F-2.8: Project-aware API client

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Обновление `packages/dashboard/src/api/client.ts`: все методы дополнены опциональным параметром `project?: string`. Например: `listSessions(options?)` с `params.set('project', options.project)` если задан. `listProjects()` без изменений (уже есть GET /api/projects). Интерфейс `ListSessionsOptions` с полем `project`. Query string формат: `/api/sessions?project=%2Fdata%2Frepos%2Fmy-project`.
- **Зависимости:** Phase 1 endpoints (query param `?project=` уже определён)
- **TDD-тесты:**
  - [ ] **TC-F-2.8-1:** listSessions с project параметром добавляет query string
    - *Условие:* client.listSessions({ project: '/a/b' })
    - *Шаги:* intercept fetch URL
    - *Ожидаемый результат:* URL содержит `?project=%2Fa%2Fb` (encoded path)
  - [ ] **TC-F-2.8-2:** Без project — запрос без параметров
    - *Условие:* client.listSessions()
    - *Шаги:* intercept fetch URL
    - *Ожидаемый результат:* URL = `/api/sessions` (без query params)
- **Критерии приёмки:**
  1. Все fetch-вызовы session endpoints поддерживают опциональный `project` parameter
  2. Параметр кодируется через `URLSearchParams`
  3. backward compatibility: отсутствие параметра = прежний запрос
- **Ожидаемый результат:** Обновлённый `packages/dashboard/src/api/client.ts`
- **Оценка объёма:** S

---

## Этап 2.4 — Интеграция: settings + MCP reload

**Цель SMART:** При переключении проекта (event от project-switcher) загружать per-project settings overlay, применять merged config, переподключать MCP-серверы если путь отличается. Settings: новый файл `packages/coding-agent/src/core/settings-manager.ts` (добавление методов loadProjectSettings, applyOverlay, resetToGlobal). MCP: `packages/coding-agent/src/mcp/mcp-connection-manager.ts` (switchMcpServers). ServiceRegistry предотвращает дублирование — reconnect только при первом access к новому cwd.

### Фичи

#### ⏳ F-2.9: Settings reload при смене проекта

- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** `packages/coding-agent/src/core/settings-manager.ts`: метод `loadProjectSettings(cwd)` читает `<cwd>/.fan/settings.json` (fs.readFileSync/parsе). Merge overlay: project-level > global-level. Метод `applyOverlay(settings)` передаёт merged config ресурсозависимым сервисам. Метод `resetToGlobal()` сбрасывает overlay обратно к глобальным настройкам. File path resolved from cwd: `path.join(cwd, '.fan', 'settings.json')`. Handle missing file gracefully (return default empty object).
- **Зависимости:** F-2.1 (ServiceRegistry для инвалидации кеша при changes settings)
- **TDD-тесты:**
  - [ ] **TC-F-2.9-1:** Load project settings from file
    - *Условие:* /a/.fan/settings.json существует с {"model":"gpt-4"}
    - *Шаги:* loadProjectSettings('/a')
    - *Ожидаемый результат:* Возвращает { model: 'gpt-4' }; без ошибок
  - [ ] **TC-F-2.9-2:** Missing file returns empty object
    - *Условие:* /missing/.fan/settings.json не существует
    - *Шаги:* loadProjectSettings('/missing')
    - *Ожидаемый результат:* Возвращает {}; не бросает исключение
- **Критерии приёмки:**
  1. `loadProjectSettings(cwd)` читает файл корректно
  2. `applyOverlay()` merge priority: project > global
  3. `resetToGlobal()` восстанавливает глобальные настройки
- **Ожидаемый результат:** Обновлённый `settings-manager.ts`
- **Оценка объёма:** M

#### ⏳ F-2.10: MCP reconnect при смене проекта

- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** `packages/coding-agent/src/mcp/mcp-connection-manager.ts`: `switchMcpServers(fromCwd, toCwd)` — если пути совпадают, return. Иначе: проверить наличие `<toCwd>/.fan/mcp.json`. Серверы остаются живыми в ServiceRegistry кеше. Reconnect происходит только при первом access к новому cwd (lazy init). Close old connections только если новый cwd не кэширован. Псевдокод из spec (раздел 2.5): сравнение paths, conditional init.
- **Зависимости:** F-2.1 (ServiceRegistry кеш), фазовые MCP server configs
- **TDD-тесты:**
  - [ ] **TC-F-2.10-1:** Same cwd — no reconnect
    - *Условие:* fromCwd === toCwd === '/a'
    - *Шаги:* switchMcpServers('/a', '/a')
    - *Ожидаемый результат:* Возврат немедленно; ни одно MCP-соединение не закрыто
  - [ ] **TC-F-2.10-2:** New cwd triggers lazy init if not cached
    - *Условие:* '/b' не в кеше ServiceRegistry
    - *Шаги:* switchMcpServers('/a', '/b')
    - *Ожидаемый результат:* Инициализация MCP серверов из /b/.fan/mcp.json; старые соединения сохраняются (не killed)
- **Критерии приёмки:**
  1. Если cwd совпадает — no-op
  2. Если новый cwd кэширован в ServiceRegistry — использовать cached MCP
  3. Если новый cwd не кэширован — lazy init из .fan/mcp.json
- **Ожидаемый результат:** Обновлённый `mcp-connection-manager.ts` (или новый модуль в packages/coding-agent/src/mcp/)
- **Оценка объёма:** M

#### ⏳ F-2.11: Auto-invalidation кеша по mtime settings

- **Приоритет:** P1
- **Слой:** [INFRA]
- **Описание:** В `ServiceRegistry` добавить `watchForConfigChanges(targetCwd)` — мониторинг mtime файла `<cwd>/.fan/settings.json`. Сравнить stat.mtime с последним известным. Если изменилось — вызвать `invalidate(cwd)`. Background watcher (fs.watch или polling с интервалом 5s). Предотвращает работу со старыми настройками. Оптимизация: watch запускается при first access к cwd, останавливается при LRU eviction.
- **Зависимости:** F-2.1 (ServiceRegistry), F-2.2 (LRU eviction)
- **TDD-тесты:**
  - [ ] **TC-F-2.11-1:** Cache invalidated when settings.json modified
    - *Условие:* Сервис кэширован для '/a'; mtime settings.json изменён (touch)
    - *Шаги:* Подождать poll interval; затем get('/a')
    - *Ожидаемый результат:* get('/a') возвращает null (invalidated)
- **Критерии приёмки:**
  1. Watcher отслеживает изменения mtime конфигурации
  2. Invalidate вызывается автоматически при обнаружении изменений
  3. Watcher останавливается при eviction (resource leak prevention)
- **Ожидаемый результат:** Дополнение `service-registry.ts` с fs.watch или polling
- **Оценка объёма:** M

---

## Этап 2.5 — Доп. функции и E2E

**Цель SMART:** Добавить queue position indicator в UI, обработку ошибок недоступного проекта, защиту от overflow (>50 сообщений). Затем выполнить два комплексных E2E сценария: multi-project sequential task execution и 3-project switching performance test.

### Фичи

#### ⏳ F-2.12: Индикатор позиции в очереди в UI

- **Приоритет:** P1
- **Слой:** [UI]
- **Описание:** В чат-компоненте dashboard показывать текст "В очереди, позиция N" при получении `{ type: 'queued', position: N }` от сервера. Стилизация: жёлтый блок над полем ввода. Автоматическое скрытие когда очередь пуста (server отправляет `{ type: 'dequeued' }` или сообщение доставлено). Component update: `chat-input.ts` в `packages/dashboard/src/components/`.
- **Зависимости:** F-2.5 (WS handler integration)
- **TDD-тесты:**
  - [ ] **TC-F-2.12-1:** Position indicator shown on queued message
    - *Условие:* Chat input компонент рендерен, получил message {type:'queued', position:2}
    - *Шаги:* Проверить отрендеренный текст
    - *Ожидаемый результат:* Текст "В очереди, позиция 2" отображён; style=yellow alert block
- **Критерии приёмки:**
  1. Indicator показывается при получении WS message с type='queued'
  2. Номер позиции соответствует значению из server response
  3. Indicator исчезает когда очередь обработана
- **Ожидаемый результат:** Обновлённый `chat-input.ts`
- **Оценка объёма:** S

#### ⏳ F-2.13: Error handling — недоступный проект на диске

- **Приоритет:** P1
- **Слой:** [BIZ]
- **Описание:** Обработка ситуации когда проект удалён с диска: при `GET /api/projects` или `GET /api/sessions?project=<path>` проверять существование directory. Если отсутствует — вернуть `{ error: 'PROJECT_NOT_FOUND', path }`. Dashboard: сообщение "Проект не найден на диске" + кнопка «Удалить из реестра». Уведомление пользователя о потере данных.
- **Зависимости:** Phase 1 (project registry в ~/.fan/agent/projects.json)
- **TDD-тесты:**
  - [ ] **TC-F-2.13-1:** API returns error for missing project
    - *Условие:* Directory '/deleted-proj' не существует, но записан в projects.json
    - *Шаги:* GET /api/projects
    - *Ожидаемый результат:* Entry имеет `error: 'PROJECT_NOT_FOUND'` или фильтр исключает такой проект
  - [ ] **TC-F-2.13-2:** Dashboard shows recovery option
    - *Условие:* Запрос к отсутствующему проекту
    - *Шаги:* Рендер UI
    - *Ожидаемый результат:* Text "Проект не найден на диске"; кнопка «Удалить из реестра»
- **Критерии приёмки:**
  1. Проверка существования директории при запросе проекта
  2. Возврат informative error через API
  3. Dashboard предлагает удаление из реестра
- **Ожидаемый результат:** Обновлённый `ws-handler.ts` + `session-list.ts`
- **Оценка объёма:** M

#### ☐ F-2.14-E2E: Многопроектная работа с очередью задач

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Сквозной сценарий работы с несколькими проектами одновременно. Проверяет весь стек: service registry кеш, очередь сообщений, правильную маршрутизацию ответов в сессии разных проектов. Выполняемость: ручная через Web UI или скриптовая через curl+wscat.
- **Зависимости:** F-2.1..F-2.5 (все core features)
- **TDD-тесты:**
  - [ ] **TC-F-2.14-E2E-1:** Multi-project sequential execution via web UI
    - *Условие:* Два проекта в registry: proj-A и proj-B. Оба имеют хотя бы одну completed сессию. WebSocket подключение активен с auth token.
    - *Шаги:*
      1. Через Web UI выбрать проект proj-A → открыть активную сессию
      2. Отправить сообщение в чат proj-A → задача выполняется
      3. Переключиться на проект proj-B → отправить сообщение в чат proj-B (engine busy)
      4. Дождаться выполнения задачи proj-A
      5. Проверить: сообщение proj-B взято из очереди и выполнено
      6. Проверить: ответ proj-B пришёл в сессию proj-B (не proj-A)
    - *Ожидаемый результат:* Proj-A задача выполнена первой → ответ в сессии A; Proj-B задача из очереди → выполнена → ответ в сессии B. Обе ответы в правильных сессиях
  - [ ] **TC-F-2.14-E2E-2:** Switch between 3 projects — performance and settings isolation
    - *Условие:* Три проекта: alpha (/proj/alpha), beta (/proj/beta), gamma (/proj/gamma). Каждый имеет уникальные settings.model. Service registry initialized.
    - *Шаги:*
      1. Открыть alpha → record switch time t1 (performance marker)
      2. Переключиться на beta → record t2 → check settings match beta's .fan/settings.json
      3. Переключиться на gamma → record t3 → check settings match gamma
      4. Переключиться обратно на alpha → record t4 → убедиться что настройки корректны (из кеша)
    - *Ожидаемый результат:* Среднее время переключения (t4-t1)/3 < 2 сек (с кешем); настройки каждого проекта применяются корректно; кеш alpha работает при повторном открытии
- **Критерии приёмки:**
  1. Задачи из разных проектов выполняются последовательно, каждая в своей сессии
  2. Ответы маршрутизируются в правильные сессии (никаких cross-contamination)
  3. Время переключения между кэшированными проектами < 2 секунды
- **Ожидаемый результат:** Ручной тест или automation script (curl+wscat); результаты фиксируются в PR
- **Оценка объёма:** M

---

## Граф зависимостей

```
┌─────────────── ЭТАП 2.1: SERVICE REGISTRY + MUTEX ──────────────┐
│                                                                 │
│   F-2.1 ServiceRegistry          F-2.3 Mutex                     │
│         │                          │                              │
│         ▼ (depends on)            │                              │
│      [core infra]                  ▼                              │
│                            F-2.2 LRU Eviction                    │
│                                    │                              │
└────────────────────────────────────┼──────────────────────────────┘
                                     │
┌─────────────── ЭТАП 2.2: MESSAGE QUEUE ─────────────────────────┐
│                                                                  │
│   F-2.4 MessageQueue          F-2.5 WS Handler Integration      │
│         ▲                         │                               │
│         │ (Mutex+)                │ (runtime.checkBusy)           │
│         └─────────────────────────┘                               │
│                                                                  │
└──────────────────────────────────┼───────────────────────────────┘
                                   │
┌─────────── ЭТАП 2.3: DASHBOARD COMPONENTS ──────────────────────┐
│                                                                  │
│   F-2.8 API Client              F-2.6 Project Switcher          │
│           │                            │                          │
│           └────→ F-2.7 Session List Tree View ←──────────────────┘
│                                                                  │
└──────────────────────────────────┼───────────────────────────────┘
                                   │
┌───────── ЭТАП 2.4: INTEGRATION (SETTINGS/MCP) ──────────────────┐
│                                                                  │
│   F-2.9 Settings Reload     F-2.10 MCP Reconnect                 │
│           │                            │                          │
│           └──── depends on ────────────┘                          │
│                   Service Registry                                │
└──────────────────────────────────┼───────────────────────────────┘
                                   │
┌───────── ЭТАП 2.5: E2E + POLISH ────────────────────────────────┐
│                                                                  │
│   F-2.12 Queue Indicator   F-2.13 Error Handling     F-2.14-E2E  │
│        │                       │                        │        │
│        └───────────────────────┴────────┬───────────────┘        │
│                                  (E2E scenarios validate       │
│                             ALL stages combined)                 │
└──────────────────────────────────────────────────────────────────┘
```

**Проверка циклов:** Циклов нет. Все зависимости направленные (DAG). E2E зависит от всех этапов.

---

## Полный чеклист по приоритетам

### P0 (Must Have) — 9 фич

- [ ] ☐ F-2.1 ServiceRegistry — кеш сервисов по cwd
- [ ] ☐ F-2.2 LRU eviction при достижении лимита
- [ ] ☐ F-2.3 InMemoryMutex базовый класс
- [ ] ☐ F-2.4 InMemoryMessageQueue — базовая реализация
- [ ] ☐ F-2.5 WebSocket handler integration — enqueue on busy
- [ ] ☐ F-2.6 `<fan-project-switcher>` компонент
- [ ] ☐ F-2.7 `<fan-session-list>` tree grouping по cwd
- [ ] ☐ F-2.8 Project-aware API client
- [ ] ☐ F-2.14-E2E Многопроектная работа с очередью задач

### P1 (Should Have) — 5 фич

- [ ] ⏳ F-2.9 Settings reload при смене проекта
- [ ] ⏳ F-2.10 MCP reconnect при смене проекта
- [ ] ⏳ F-2.11 Auto-invalidation кеша по mtime settings
- [ ] ⏳ F-2.12 Индикатор позиции в очереди в UI
- [ ] ⏳ F-2.13 Error handling — недоступный проект на диске

---

## Итоговая оценка

| Мера | Значение |
|------|---------|
| Всего фич | 14 (13 реализаций + 1 E2E) |
| P0 фич | 9 |
| P1 фич | 5 |
| P2 фич | 0 |
| Этапов | 5 (registry+mutex, queue, dashboard, integration, E2E+polish) |
| Оценка P0 | ~3 дня (infra: 4h + queue: 6h + dashboard: 8h + E2E: 4h) |
| Оценка полная | ~5–7 дней (с учётом P1/P2) |
| Путь к публикации | P0-complete → integrate → smoke E2E → publish |

*Зависимость от предыдущих фаз:* Phase 1 workspace API (Prisma cwd field, project endpoints, whitelist validation) должен быть завершён. ServiceRegistry использует `SessionManager.switchSession()` из phase 1.

---

*Сгенерировано: docs-impl agent · 2026-07-25*
*На основе: spec_fan-network-agent_phase2-workspace-ux_v1.0*
