# Pipeline Report: Фаза 2 — Workspace UX

> **Дата старта:** 2026-07-26
> **Дата завершения:** 2026-07-26
> **Ветка:** FAN-007-REMOTE-ACCESS
> **Стратегия коммитов:** per-function (conventional)
> **Roadmap:** docs/features/phase2-workspace-ux/roadmap.md

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 15 |
| Реализовано (✅) | 15 |
| Провалено (❌) | 0 |
| Коммитов | 17 (15 feat + 2 fix) |
| Диапазон | `fba7f65..96bdbb0` |
| Тесты (итог) | api-gateway 143 · coding-agent 1207 · dashboard 58 · e2e-local.sh 29/29 PASS |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-2.1 ServiceRegistry — кеш сервисов по cwd | ✅ | `f2b75b4` | unit (`service-registry.test.ts`) | 1 |
| F-2.2 LRU eviction при достижении лимита | ✅ | `95f8910` | unit | 1 |
| F-2.3 InMemoryMutex базовый класс | ✅ | `36d7013` | unit | 1 |
| F-2.4 InMemoryMessageQueue — FIFO per-session | ✅ | `fb50970` | unit | 1 |
| F-2.5 WS integration — enqueue on busy | ✅ | `80e2633` | vitest (`ws-handler.test.ts`, TC-F-2.5-1/2) | 1 |
| F-2.6 `<fan-project-switcher>` компонент | ✅ | `1cef4bf` | vitest (`project-switcher.test.ts`) | 1 |
| F-2.7 session list tree grouping по cwd | ✅ | `d3f1a41` | vitest (`session-sidebar.test.ts`, 7/7) | 1 |
| F-2.8 Project-aware API client (dashboard) | ✅ | `6a41a57` | vitest (`api-client.test.ts`) | 1 |
| F-2.9 Settings reload (overlay API) | ✅ | `34d12cf` | unit (`settings-manager`) | 1 |
| F-2.10 McpSwitcher — reconnect при смене проекта | ✅ | `374141e` | unit (`mcp-switcher.test.ts`) | 1 |
| F-2.11 Auto-invalidation кеша по mtime settings | ✅ | `2f9854b` | unit (`service-registry-watch.test.ts`, +11) | 1 |
| F-2.12 Индикатор позиции в очереди (chat UI) | ✅ | `ddb8969` | vitest (`chat-view-queue.test.ts`) | 1 |
| F-2.13 Error handling недоступного проекта + DELETE /api/projects | ✅ | `d9a12d3` | api-gateway +5, coding-agent +4, dashboard +4 | 1 |
| F-2.15 Защита очереди от overflow (>50) | ✅ | `77969e9` | vitest (TC-F-2.15-1/2) | 1 |
| F-2.14-E2E Многопроектная работа с очередью | ✅ | `7445634` | e2e-local.sh секция 9 (8 проверок), прогон ×3 | 1 |

## Детали реализации

### Этап 2.1 — Service Registry + Mutex

- **F-2.1** (`f2b75b4`): `packages/coding-agent/src/workspace/service-registry.ts` —
  `Map<cwd, {services, lastAccess}>`, методы `get/set/invalidate/clear`,
  cleanup-hook при удалении entry, `maxItems` configurable (default 5).
- **F-2.2** (`95f8910`): LRU eviction — при `size >= maxItems` вытесняется
  entry с минимальным `lastAccess` (итерация Map), cleanup вызывается до
  вставки нового.
- **F-2.3** (`36d7013`): `packages/api-gateway/src/mutex.ts` — асинхронный
  FIFO-мьютекс, `acquire/release/withLock`; `withLock` возвращает результат fn.

### Этап 2.2 — FIFO-очередь сообщений

- **F-2.4** (`fb50970`): `packages/api-gateway/src/message-queue.ts` —
  per-session очереди `Array<QueuedMessage>` под per-session Mutex; монотонный
  `seq` для tie-break; `dequeueOldest()` — глобальный FIFO по timestamp
  между сессиями. In-memory: потеря при рестарте (documented, MVP).
- **F-2.5** (`80e2633`): `WsMessageDispatcher` в `ws-handler.ts` — busy =
  `sessionAdapter.isExecuting()`; busy + чужая сессия → enqueue +
  `{ type: "queued", position }`; idle → direct dispatch; drain по
  `agent_end` и по settlement dispatch (покрывает REST-инициированные turn'ы);
  сериализация drain флагом `draining`.

### Этап 2.3 — Dashboard components

- **F-2.6** (`1cef4bf`): `packages/dashboard/src/components/project-switcher.ts` —
  dropdown (поиск, счётчик сессий, inline-форма «+»), события
  `project-select` / `project-add`, no shadow DOM (Tailwind).
- **F-2.7** (`d3f1a41`): tree grouping в `session-sidebar.ts` — группы по
  `cwd` (toggle ▼/▶, счётчик, status-dot 🟢/🔵/🟡), legacy-сессии без cwd →
  группа «Без проекта» (последняя).
- **F-2.8** (`6a41a57`): `api/client.ts` — опциональный `project` во всех
  session-методах (`?project=` через URLSearchParams, backward compatible).

### Этап 2.4 — Интеграция: settings + MCP

- **F-2.9** (`34d12cf`): `settings-manager.ts` — `loadProjectSettings(cwd)`
  (чтение `<cwd>/.fan/settings.json`, отсутствующий файл → `{}`),
  `applyOverlay(settings)`, `resetToGlobal()`.
- **F-2.10** (`374141e`): `packages/coding-agent/src/workspace/mcp-switcher.ts` —
  lazy init из `<cwd>/.fan/mcp.json` при первом access; одинаковый cwd →
  no-op; старые соединения не разрываются; `InMemoryMcpConnectionCache`.
- **F-2.11** (`2f9854b`): auto-invalidation — polling mtime
  `<cwd>/.fan/settings.json` (default 5 s, опции `watch`,
  `watchPollIntervalMs`, `statFn`); старт при first access, стоп при
  invalidate/clear/eviction (`unref`); детектит появление файла.

### Этап 2.5 — Доп. функции + E2E

- **F-2.12** (`ddb8969`): `chat-view.ts` — индикатор «В очереди, позиция N»
  при `queued`; скрытие при старте стриминга; предупреждение при
  `queue_full` (dismiss вручную).
- **F-2.13** (`d9a12d3`): `GET /api/projects` — `available` +
  `error: "PROJECT_NOT_FOUND"` для отсутствующих директорий (не исключаются);
  `DELETE /api/projects?path=` (204/400/404/501), `removeFromProjects` в
  реестре; switcher — индикатор «Not found on disk» + кнопка удаления
  (событие `project-remove`).
- **F-2.15** (`77969e9`): лимит очереди 50/сессию (`DEFAULT_QUEUE_MAX_SIZE`,
  configurable); overflow → `enqueue()` возвращает `null` → dispatcher шлёт
  `{ type: "queue_full", error: "QUEUE_OVERFLOW", limit }`.
- **F-2.14-E2E** (`7445634`): секция 9 в `deploy/scripts/e2e-local.sh` —
  8 проверок: 3 workspace, timed switch A→B→C→A < 2 s (факт ~20 ms), WS
  sendMessage end-to-end (connect → pong → dispatch → ожидаемая
  provider-ошибка в `app.log` как evidence полного пути). Прогон ×3:
  PASS=29 FAIL=0.

## Находки верификации и их исправления

| # | Находка | Исправление | Коммит |
|---|---------|-------------|--------|
| M-1 | Race в диспетчере: rapid sendMessage → второй queued (TOCTOU между решением о dispatch и `isExecuting()=true`) | Guard `dispatchPending` — пока dispatch стартует, все входящие sendMessage ставятся в очередь | `96bdbb0` |
| M-2 | Race в McpSwitcher: конкурентный switch к одному cwd → два connect (утечка manager) | Per-cwd in-flight Map — конкурентный вызов ждёт первого, один connect | `96bdbb0` |
| M-3 | Biome strict gate ослаблен (unused import, мёртвые suppressions) | Strict gate восстановлен | `96bdbb0` |
| L-1 | Нет валидации `maxItems` в ServiceRegistry | Валидация: integer ≥ 1 | `96bdbb0` |
| — | tsgo-несовместимость `session-sidebar.test.ts` (root tsgo без DOM.Iterable) | Spread NodeListOf → `Array.from`, untyped querySelectorAll + cast | `baa59e7` |

Тесты после исправлений: api-gateway 143 (+1), coding-agent 1207 (+5),
e2e 29/29 PASS.

## Известные ограничения / backlog (в следующие фазы)

1. **ServiceRegistry и McpSwitcher — standalone.** Оба модуля реализованы и
   покрыты тестами, но НЕ подключены к runtime (`AgentSessionRuntime`).
   Интеграция (использование кеша в `switchSession`, передача MCP-менеджеров
   в кеш сервисов) — явный пункт следующей фазы. E2E-секция 9 фиксирует это:
   замер switching — public-API аппроксимация «honest timing, cold switches
   included».
2. **`mutexes` Map в InMemoryMessageQueue растёт неограниченно** — по одному
   Mutex на sessionId, записи не удаляются. Documented в коде; утечка
   пренебрежима для MVP (один Mutex ≈ десятки байт на сессию).
3. **Очередь in-memory** — сообщения теряются при рестарте сервера.
   Persistent queue — фаза 5 (concurrency).
4. **Ветки queued/queue_full не воспроизводимы в docker E2E** — без
   LLM-ключей движок не становится busy (`prompt()` падает на валидации
   провайдера до стриминга). Покрыты vitest с mock busy adapter
   (`ws-handler.test.ts`: TC-F-2.5-1, позиции 1..N, global-FIFO dequeue,
   TC-F-2.15-2). Обоснование задокументировано в шапке секции 9
   `e2e-local.sh`.

---

*Финализировано: docs-impl agent · 2026-07-26*
