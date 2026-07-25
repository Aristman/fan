# Спецификация: Фаза 2 — Workspace UX (Dashboard / кеш сервисов / очередь)

## Метаданные
- **Дата**: 2026-07-25
- **Автор**: research-spec-generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича · Фаза 2 из пакета «FAN Network Agent»
- **Связь**: [Родительская спецификация](./spec_fan-network-agent_2026-07-25.md)

---

## 1. Обзор

### 1.1 Цель

Дать пользователю полноценный интерфейс для работы с несколькими проектами из Web UI. Dashboard получает переключатель проектов, группировку сессий по project, перезагрузку per-project настроек при переключении. В runtime добавляется кеш сервисов (Service Registry) и FIFO-очередь сообщений в sendMessage (перенесена из фазы 5, решение 9.1 v2).

### 1.2 Контекст

Точки изменений фазы 2 (из решения 9.4 v2):

| # | Изменение | Сложность | Описание |
|---|-----------|:---:|----------|
| 8 | Кеш сервисов `Map<cwd, AgentSessionServices>` | L | Service Registry, LRU eviction |
| 9 | Dashboard: переключатель проектов + группировка сессий | L | Новые компоненты Lit |
| 10 | Dashboard API client: project-параметры | S | Обновление fetch-вызовов |
| 11 | Settings reload при смене проекта | M | Перезагрузка .fan/settings.json |
| 12 | MCP reconnect при смене проекта | M | Переподключение MCP-серверов |
| **13** | **Mutex на sendMessage** | **M** | **Перенесено из фазы 5 (решение 9.1/9.4)** |

Фаза 2 объединяет backend-cache (точки 8, 11, 12, 13) и frontend-UX (точки 9, 10).

---

## 2. Функциональные требования

### 2.1 Точка №8: Service Registry — кеш сервисов по cwd

**Файл:** новый модуль `packages/coding-agent/src/workspace/service-registry.ts`

**Проблема:** без кеша каждый switch проекта = полный teardown + recreate сервисов (settings, extensions, skills, MCP, context files). Медленно при частом переключении.

**Решение:** кеш в памяти типа `Map<cwd, AgentSessionServices>` с LRU eviction:

```typescript
class ServiceRegistry {
    private cache: Map<string, {services: AgentSessionServices, lastAccess: number}>;
    private readonly maxItems: number; // 5 по умолчанию

    constructor(maxItems = 5) {
        this.cache = new Map();
        this.maxItems = maxItems;
    }

    get(cwd: string): AgentSessionServices | null {
        const entry = this.cache.get(cwd);
        if (!entry) return null;
        entry.lastAccess = Date.now();
        return entry.services;
    }

    set(cwd: string, services: AgentSessionServices): void {
        // LRU eviction если cache full
        if (this.cache.size >= this.maxItems) {
            let oldestKey = '';
            let oldestTime = Infinity;
            for (const [key, entry] of this.cache) {
                if (entry.lastAccess < oldestTime) {
                    oldestKey = key;
                    oldestTime = entry.lastAccess;
                }
            }
            this.evict(oldestKey);
        }
        this.cache.set(cwd, { services, lastAccess: Date.now() });
    }

    invalidate(cwd: string): void {
        this.cache.delete(cwd);
    }

    clear(): void {
        for (const [, entry] of this.cache) {
            this.cleanup(entry.services);
        }
        this.cache.clear();
    }
}
```

**Инвалидация кеша (из решения 9.3):** при изменении mtime `.fan/settings.json` проекта — инвалидируем соответствующую запись в кеше.

```typescript
// Мониторинг изменений per-project конфига
async watchForConfigChanges(targetCwd: string): Promise<void> {
    const settingsPath = path.join(targetCwd, '.fan', 'settings.json');
    const stat = await fs.stat(settingsPath);
    
    // Сравнить mtime с последним известным
    // Если изменилось → invalidate кеш для этого cwd
}
```

### 2.2 Точка №9: Dashboard — переключатель проектов

**Файл:** `packages/dashboard/src/` (Lit компоненты)

#### Компонент: `<fan-project-switcher>`

Новый компонент навигации в dashboard sidebar:

```html
<fan-project-switcher 
    .projects=${[{path: '/data/repos/proj1', name: 'proj1'}, ...]}
    .currentProject=${'/data/repos/proj1'}
    @project-select=${handleProjectSelect}>
</fan-project-switcher>
```

**Поведение:**
- Dropdown/список всех проектов из `GET /api/projects`
- Выбранный проект подсвечен
- При выборе — загружается список сессий выбранного проекта
- Кнопка «+» для регистрации нового проекта (открывает форму ввода path)

#### Компонент: `<fan-session-list>` — группировка по проекту

Текущий плоский список сессий заменяется на древовидную структуру:

```
📁 my-project (3 сессии)
  ├─ Fix auth bug [completed]
  ├─ Add login page [active]
  └─ Research alternatives [draft]
📁 idea-lab-workspace (7 сессий)
  ├─ SWOT analysis Q3 [completed]
  └─ ...
```

Реализация: группировка по полю `cwd`, полученному из `GET /api/sessions?project=` (без параметра — все проекты).

### 2.3 Точка №10: Dashboard API client — project-параметры

**Файл:** `packages/dashboard/src/api/client.ts`

Все вызовы API дополняются параметром `project`:

```typescript
// Было
const sessions = await fetch(`${apiUrl}/sessions`).then(r => r.json());

// Стало — с опциональным project параметром
interface ListSessionsOptions {
    project?: string; // cwd проекта
}

async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (options.project) params.set('project', options.project);
    
    return fetch(`${apiUrl}/sessions?${params}`).then(r => r.json());
}
```

### 2.4 Точка №11: Settings reload при смене проекта

**Файл:** `packages/coding-agent/src/core/settings-manager.ts`

При переключении проекта (switchSession с новым cwd):

1. Загрузить `<cwd>/.fan/settings.json` (если существует) — overlay поверх глобальных настроек
2. Применить overlay: merged config с приоритетом project-level > global
3. Передать обновлённый конфиг в ресурсозависимые сервисы

**Интерфейс:**
```typescript
interface SettingsManager {
    loadProjectSettings(cwd: string): ProjectSettings;
    applyOverlay(settings: ProjectSettings): void;
    resetToGlobal(): void; // возврат к глобальным настройкам
}
```

### 2.5 Точка №12: MCP reconnect при смене проекта

**Файл:** `packages/coding-agent/src/mcp/mcp-connection-manager.ts` (предполагаемое имя)

При смене проекта:
1. Проверить наличие MCP-серверов в `<cwd>/.fan/mcp.json`
2. Если путь отличается от предыдущего — закрыть старые подключения
3. Инициализировать новые MCP-подключения из проектного конфига

**Кеш сервисов предотвращает дублирование:** подключённые MCP остаются живыми в кеше до вытеснения LRU. Reconnect происходит только при первом доступе к новому cwd.

```typescript
// Псевдокод reconnect logic
async switchMcpServers(fromCwd: string, toCwd: string): Promise<void> {
    if (fromCwd === toCwd) return;
    
    // Текущие серверы кэшированы в ServiceRegistry, не убиваем сразу
    // При следующем access к toCwd -> ServiceRegistry вернёт кэш или создаст новые
}
```

### 2.6 Точка №13 (ПЕРЕНОС ИЗ ФАЗЫ 5): FIFO-очередь + мьютекс на sendMessage

**Файл:** `packages/api-gateway/src/ws-handler.ts` или `packages/api-gateway/src/message-queue.ts` (новый модуль)

**Контекст (решение 9.1 v2):** конкурентность СОСТОЯНИЯ vs конкурентность ИСПОЛНЕНИЯ. JSONL-файл на диске бесплатен как хранилище состояния. Но движок исполнения один — `switchSession()` делает teardown + recreate, переключение дорогое. Без очереди задачи теряются.

**Упрощённое решение для фазы 2 (in-memory):**

```typescript
interface MessageQueue {
    // Буфер: одна очередь на сессию
    enqueue(sessionId: string, message: EnqueuedMessage): Promise<void>;
    dequeue(sessionId: string): Promise<EnqueuedMessage | null>;
    peek(sessionId: string): EnqueuedMessage[];
    size(sessionId: string): number;
}

class InMemoryMessageQueue implements MessageQueue {
    private queues: Map<string, Array<{message: any, timestamp: number}>>;
    private mutexes: Map<string, Mutex>;
    
    async enqueue(sessionId: string, message: EnqueuedMessage): Promise<void> {
        if (!this.mutexes.has(sessionId)) {
            this.mutexes.set(sessionId, new Mutex());
        }
        
        const lock = this.mutexes.get(sessionId)!;
        await lock.withLock(async () => {
            if (!this.queues.has(sessionId)) {
                this.queues.set(sessionId, []);
            }
            this.queues.get(sessionId)!.push({
                message,
                timestamp: Date.now()
            });
        });
    }
    
    async dequeue(sessionId: string): Promise<EnqueuedMessage | null> {
        const lock = this.mutexes.get(sessionId)!;
        return await lock.withLock(async () => {
            const queue = this.queues.get(sessionId);
            if (!queue || queue.length === 0) return null;
            return queue.shift()!.message;
        });
    }
}
```

**Поведение в WebSocket handler:**

```typescript
// При входящем ws-сообщении (sendMessage)
async handleWsMessage(ws: WebSocket, session: SessionInfo, data: WsMessage) {
    if (data.type === 'sendMessage') {
        const isEngineBusy = runtime.isExecuting(); // проверка: выполняет ли текущую задачу
        
        if (isEngineBusy && data.message.sessionId !== currentActiveSessionId) {
            // задача для другого проекта → ставим в очередь
            await messageQueue.enqueue(data.message.sessionId, {
                content: data.message.content,
                timestamp: Date.now(),
                notified: false
            });
            
            // Уведомляем клиента о постановке в очередь
            ws.send(JSON.stringify({ type: 'queued', position: messageQueue.size(data.message.sessionId) }));
            return;
        }
        
        // Нет конфликта → отправляем напрямую
        await runtime.sendMessage(session, data.message.content);
    }
}
```

**Ограничения in-memory очереди (из решения 9.3 v2):** потеря задач при рестарте сервера. Решение — уведомление клиенту, задача перезапускается. Полностью персистентная очередь — фаза 4 вместе с scheduler.

---

## 3. UI/UX требования

### 3.1 Экраны и компоненты

#### Sidebar навигация

```
┌──────────────────────────┐
│ 🏠 FAN Agent             │
├──────────────────────────┤
│ 📂 Проекты               │
│  ▼ my-project (3)       │ ← dropdown project switcher
│    📄 Fix auth bug       │
│    📄 Add login page     │
│    📄 Research alt.      │
│                          │
│  ➕ Новый проект         │
│                          │
│  ● idea-lab-workspace (7)│
├──────────────────────────┤
│ 💬 Активная сессия       │
│  [чат-интерфейс]         │
├──────────────────────────┤
│ ⚙️ Настройки             │
└──────────────────────────┘
```

#### Переключатель проектов (dropdown)

- Анимация появления
- Поиск по имени проекта (filter)
- Индикатор количества сессий
- Цветовой индикатор статуса (зелёный — есть активные сессии)

#### Группировка сессий (tree view)

- Раскрытие/сворачивание дерева проектов
- Счётчик сессий рядом с названием проекта
- Цветовая кодировка статусов:
  - 🟢 зелёный — active
  - 🔵 синий — completed
  - 🟡 жёлтый — draft/error
- Клик на сессию → открывается в основной панели

### 3.2 Взаимодействие

**Переключение проекта:**
1. Пользователь выбирает проект из dropdown
2. Dashboard делает `GET /api/sessions?project=<path>`
3. Список сессий обновляется
4. Runtime инициирует switchSession (с кешем сервисов)
5. Настройки перезагружаются автоматически
6. Чат показывает сессии выбранного проекта

**Отправка сообщения (с очередью):**
1. Пользователь пишет сообщение
2. Если движок занят (выполняет другую задачу):
   - Сообщение ставится в очередь
   - Пользователь видит: "В очереди, позиция N"
3. Если движок свободен:
   - Сообщение отправляется немедленно
4. После завершения текущей задачи — берётся следующая из очереди

### 3.3 Обработка ошибок

| Ситуация | Поведение |
|----------|-----------|
| Проект удалён с диска | Сообщение: "Проект не найден на диске" + кнопка удалить из реестра |
| Queue overflow (>50 сообщений) | Отклонение новых сообщений, предупреждение пользователю |
| Сбой переключения проекта | Retry once, затем error UI с описанием проблемы |
| Перестройка кеша сервисов медленная | Progress indicator во время загрузки сервисов |

---

## 4. Нефункциональные требования

### 4.1 Производительность

| Метрика | Целевое значение |
|---------|------------------|
| Время переключения проекта (с кешем) | <2 сек (текущее поведение без кеша — несколько секунд) |
| Размер Service Registry (LRU) | 3–5 проектов |
| Задержка очереди sendMessage | <100ms (встроенная проверка busy state) |
| Отклик UI при смене проекта | <300ms (запрос API параллелен с UX update) |

### 4.2 Надёжность

- Очередь in-memory — данные теряются при рестарте. Для MVP приемлемо: пользователь видит уведомление, перезапускает задачу.
- Персистентная очередь — фаза 4.

---

## 5. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Кеш сервисов: рост памяти (N проектов × все ресурсы) | Низкая | Низкое | LRU-лимит 5; cleanup при eviction |
| Устаревшие данные в кеше (settings.json изменился) | Средняя | Среднее | Инвалидация по mtime `.fan/settings.json`; периодическое обновление |
| MCP process leak при каждом переключении | Средняя | Среднее | Service Registry держит MCP живыми; LRU вытесняет старые |
| Очередь теряется при crash сервера | Высокая (in-memory) | Среднее | Notification клиенту; user retry; персистентная очередь — фаза 4 |
| UI freeze при загрузке кеша | Низкая | Низкое | Async load; progress spinner; graceful degradation |

---

## 6. Компромиссы

### 6.1 Принятые решения

- **In-memory очередь вместо персистентной** — простота реализации. Потеря задач при рестарте компенсируется тем что пользователь сам запустил задачу через Web UI (может перезапустить). Персистентная очередь — отдельное состояние, фаза 4.
- **LRU limit 5 проектов** — компромисс между скоростью и памятью. 5 проектов × (~10MB resources) ≈ 50MB — приемлемо для VPS.
- **Каждый проект перезагружает настройки с диска** — без централизованной БДИ настроек. Простота vs производительность. Для масштаба до 5 активных проектов — быстро.

### 6.2 Отклонённые альтернативы

- **Persistent queue в SQLite** — усложнение фазы 2. Отложено до фазы 4 вместе с scheduler'ом.
- **Background preloading сервисов** — избыточно: 5 проектов кэшируются достаточно для responsive UX.
- **Push-notifications для очередей** — слишком сложно для MVP. Пользователь работает из браузера (WebSocket), может видеть статус онлайн.

---

## 7. Приоритеты

### Must Have
- Service Registry: `Map<cwd, services>` с LRU (limit 5)
- Dashboard project switcher (dropdown)
- Dashboard session grouping (tree view по cwd)
- FIFO-очередь messages + mutex на sendMessage (in-memory)
- Settings reload при смене проекта

### Should Have
- MCP reconnect при смене проекта
- Auto-invalidation кеша по mtime settings
- Индикатор позиции в очереди в UI
- Error handling при недоступном проекте на диске

### Could Have
- Drag-and-drop reorder projects в sidebar
- Keyboard shortcuts для быстрого переключения (1, 2, 3...)
- History последнего открытого проекта

### Won't Have
- Persistent queue (фаза 4)
- Per-project tokens (фаза 5)
- Parallel execution (фаза 5)
- Multi-user features

---

## 8. Следующие шаги

- [ ] Создать `ServiceRegistry` class (service-registry.ts)
- [ ] Добавить LRU eviction + mtime-based invalidation
- [ ] Создать встраиваемый Mutex класс
- [ ] Реализовать InMemoryMessageQueue
- [ ] Интегрировать очередь в ws-handler (точка обработки sendMessage)
- [ ] Создать Lit компонент `<fan-project-switcher>`
- [ ] Модифицировать session list → tree grouping по cwd
- [ ] Подключить API client к project-aware endpoints
- [ ] Настроить settings/MCP reload на switch
- [ ] Регрессия: TUI продолжает работать, build 0 errors

---

*Создано: research-spec-generator skill · дата 2026-07-25*
*Фаза 2 из пакета «FAN Network Agent»*
*Спецификация ссылается на родительскую: [FAN Network Agent](./spec_fan-network-agent_2026-07-25.md)*
*Заменяет точки 8–13 фазы 2+5 v2 плана (точка 13 перенесена из фазы 5 в фазу 2 по решению 9.1/9.4)*
