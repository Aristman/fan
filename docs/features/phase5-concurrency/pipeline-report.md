# Pipeline Report: Фаза 5 — Конкурентность (опциональная)

> **Дата старта:** 2026-07-26
> **Дата финализации:** 2026-07-26
> **Ветка:** FAN-007-REMOTE-ACCESS
> **Стратегия коммитов:** per-function (conventional)
> **Roadmap:** docs/features/phase5-concurrency/roadmap.md
> **Аудит:** docs/research/process-cwd-audit-phase5.md
> **Примечание:** фаза опциональная; запущена по директиве пользователя «выполнять все роадмапы»

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 8 |
| Реализовано (✅) | 8 |
| Провалено (❌) | 0 |
| Fix-коммитов | 2 |
| Коммитов | 9 (`2681eff..ad3cff8` = `bb5c659..HEAD`) |
| Тесты api-gateway | 266 (266/266) |
| E2E | 107 проверок (секция 13 добавлена, `deploy/scripts/e2e-local.sh`) |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-5.1 аудит cwd | ✅ | `2681eff` (совм. с F-5.2) | TC-F-5.1-1/2 (ручная сверка grep) | 1 |
| F-5.2 аудит chdir | ✅ | `2681eff` | TC-F-5.2-1/2 | 1 |
| F-5.3 replace cwd в tools | ✅ | `29a57b8` | `tool-cwd-isolation.test.ts` (TC-F-5.3-1/2/3) | 1 |
| F-5.4 remove chdir | ✅ | `9a20eec` | `no-process-chdir.test.ts`, `per-session-cwd.test.ts` | 1 |
| F-5.5 persistent queue | ✅ | `2f9ab67` | `persistent-queue.test.ts`, `persistent-queue-io.test.ts` (+20) | 2 (verify FAIL→fixed) |
| F-5.6 restore on startup | ✅ | `6213235` | `queue-restore.test.ts` (TC-F-5.6-1/2, Node ws path) | 1 |
| F-5.7 per-project tokens | ✅ | `6bfbb97` | auth/http-server/ws-handler (+35) | 2 (verify FAIL→fixed) |
| F-5.8-E2E параллельные сессии | ✅ | `ae2218a` | секция 13 e2e-local.sh (TC-F-5.8-E2E-1/2/3 + scoped smoke) | 1 |

## Детали реализации

### Этап 5.0 — Аудит (F-5.1, F-5.2) — `2681eff`

- Отчёт `docs/research/process-cwd-audit-phase5.md`: 82 non-test совпадения
  `process.cwd()` (37 direct / 23 indirect / 22 safe skip, 32 файла);
  2 production вызова `process.chdir()` — оба в `agent-session-runtime.ts`
  (lines 119–124, 320–321); скрытых chdir в mcp/store/api-gateway/tools/skills
  нет. Покрытие целевых директорий 100% (TC-F-5.1-2).
- Вывод аудита: инфраструктура per-session cwd уже готова
  (`AgentSession._cwd`, `createAllToolDefinitions(cwd)`,
  `SessionManager.getCwd()`) — chdir избыточен.

### Этап 5.1 — Удаление chdir (F-5.3, F-5.4) — `29a57b8`, `9a20eec`

- **F-5.3:** tool factories (`create*ToolDefinition(cwd)`) для 7 инструментов
  (bash/read/write/edit/find/grep/ls); legacy default-экспорты
  (`bashTool`, `readTool`, …) помечены `@deprecated` (tools/index.ts +
  каждый tool-файл); `BashExecutor`, `settings-manager`, `shell.ts` — explicit
  cwd. Тест `tool-cwd-isolation.test.ts` (169 строк) — TC-F-5.3-1/2/3.
- **F-5.4:** `process.chdir()` полностью удалён из runtime — **0 production
  вызовов** в кодовой базе. `no-process-chdir.test.ts` (204 строки) —
  regression guard (spy на `process.chdir`, параллельные сессии).
- **Fix F1** — `a1121f9`: `ArchiveInstaller(cwd?)` — explicit cwd вместо
  ленивого `process.cwd()`; store-extension пересоздаёт installer с
  `ctx.cwd` на `session_start`; vitest в `packages/store` (2/2).

### Этап 5.2 — Персистентная очередь (F-5.5, F-5.6) — `2f9ab67`, `6213235`

- **F-5.5:** `PersistentMessageQueue` (`packages/api-gateway/src/message-queue.ts`):
  - Хранение `<queuesDir>/<sessionId>.queue.jsonl` (append-only, одна JSON-строка
    на сообщение) + `queue-index.json` (`{ <sessionId>: boolean }`, атомарная
    запись tmp+rename). `queuesDir` по умолчанию `<agentDir>/queues`
    (`FAN_CODING_AGENT_DIR`/`FAN_AGENT_DIR` → `~/.fan/agent`).
  - dequeue = атомарная перезапись файла без первой строки; при опустошении
    файл удаляется, флаг индекса → `false`. FIFO = порядок файла
    (`timestamp` — ключ упорядочивания после recovery).
  - Drop-in для WS dispatcher (`DrainableMessageQueue`); overflow-лимит 50
    (F-2.15) сохранён; I/O retry до 3 раз; malformed JSONL-строки
    логируются и пропускаются; `repairIndex` — ресинхронизация индекса по
    фактическим `*.queue.jsonl`.
- **F-5.6:** `restoreQueuesOnStartup()` в `startServer()` — очереди
  восстанавливаются из файлов **до** приёма соединений; каждый WS-клиент при
  подключении получает фрейм `queues_restored { restoredCount, sessions[] }`
  (только при `restoredCount > 0`; пустой старт — молча). Ошибки
  восстановления логируются и не фатальны.
- **Server mode по умолчанию persistent:** `startServer()` использует
  `PersistentMessageQueue`, если не передан `messageQueue` и не установлено
  `persistentQueue: false` (опция `ServerOptions`).

### Этап 5.3 — Per-project tokens (F-5.7) — `6bfbb97`

- Prisma: `ClientToken.projectScope String?` (+ индекс, additive-миграция —
  полная обратная совместимость, `null` = full access).
- `authorizeProjectScope()` (`packages/api-gateway/src/auth.ts`): exact match
  после `normalizeProjectPath` (без prefix/subtree); scoped токен без
  project-контекста → deny (консервативный дефолт) с whitelist
  `SCOPE_NEUTRAL_ENDPOINTS` / `SCOPE_RESOURCE_ENDPOINTS`.
- Enforcement: query `?project=`/`?path=`, body `cwd`/`project`/`rootPath`
  (все найденные контексты должны совпадать со scope), WS — по
  `session.cwd` при subscribe (Node + Bun пути), resource-level —
  `assertSessionInScope` в GET/POST/DELETE `/api/sessions/:id`.
- Anti-escalation: scoped caller в `POST /api/tokens` может выпускать только
  токены своего scope (опущенный `projectScope` наследует scope caller'а).

### Этап 5.4 — E2E (F-5.8) — `ae2218a`

- Секция 13 `deploy/scripts/e2e-local.sh` (+4 проверки → **107**):
  - TC-F-5.8-E2E-1: staggered sendMessage → direct dispatch + queued position 1
    (persistent queue), обе задачи завершены в своих сессиях, JSONL изолированы.
  - TC-F-5.8-E2E-2: инвариант `process.cwd()` — `/proc/1/cwd == /app` до и
    после переключений X→Y→X (ноль chdir).
  - TC-F-5.8-E2E-3: очередь переживает `compose restart` — 3 сообщения на
    диске, фрейм `queues_restored`, drain продолжился, ни одно сообщение не
    потеряно.
  - Scoped token smoke (F-5.7): `?project=` own → 200, foreign → 403.

## Верификации

| Проверка | Результат | Находки и исправления |
|----------|-----------|------------------------|
| F-5.5 verify | FAIL → fixed | 3 находки: (1) `enqueue` throw → WS-фрейм `QUEUE_PERSISTENCE_ERROR` вместо молчаливого отказа; (2) `drainQueue` обёрнут в catch; (3) `writeFileAtomic` — cleanup tmp-файлов + `repairIndex` (битый индекс → rescan `*.queue.jsonl`, phantom flags очищены). Фикс в том же коммите `2f9ab67` |
| F-5.7 verify | FAIL → fixed | 2 bypass: (1) claim-based bypass — resource-level `assertSessionInScope` в GET/POST/DELETE `/api/sessions/:id` (закрыты чтение чужой сессии и prompt injection через `POST .../messages`); (2) scoped без project-контекста на resource-роутах — разрешается по `session.cwd`. Фикс в том же коммите `6bfbb97` |
| Финальная verify | FAIL → fixed | `ad3cff8`: **HIGH** — эскалация scoped token → scope lockdown (GET `/api/tokens` фильтр по scope; DELETE `/api/tokens/:id` только своего scope; PUT `/api/models/settings`, provider-scope PUT `/api/budget`, DELETE/PUT `/api/projects` вне scope → 403; GET `/api/projects` фильтр; POST `/api/projects` только внутри scope) + **F2** — `mcpExtension` использует `ctx.cwd` (session_start + `/mcp reload`): project `.fan/mcp.json` снова грузится для сессий с cwd ≠ `process.cwd()`. Тесты: api-gateway 266 (+18 lockdown), mcp 310 (+1), build 0 errors |

## Backlog (переносится в следующие фазы)

1. **Deprecated API — путь удаления не определён:** legacy default-экспорты
   tools (`bashTool`/`readTool`/…, `createAllTools` и др. в
   `packages/coding-agent/src/core/tools/`) помечены `@deprecated`, но срок и
   версия удаления не назначены.
2. **Queue dequeue = at-least-once:** при crash между dispatch и атомарной
   перезаписью файла сообщение будет доставлено повторно после рестарта
   (дубликаты возможны; потерь нет). Задокументировано в api-reference.md.
3. **Queue-файлы 0644:** JSONL-файлы очередей создаются с umask-правами
   (0644), не 0600 — содержимое сообщений читаемо другим пользователям хоста.
4. **FIFO-перестановка при busy-окне (minor, pre-existing):** глобальный drain
   по `createdAt` может переупорядочить сообщения разных сессий относительно
   порядка их WS-приёма (унаследовано от фазы 2).
5. **`SessionManager.open()` legacy fallback на `process.cwd()`**
   (`session-manager.ts:1284`): используется только когда в заголовке сессии
   нет cwd и не передан `cwdOverride` (legacy-сессии фазы 1).
6. **52 старых ClientToken в dev-БД** без `projectScope` — работают в режиме
   full access (обратная совместимость); при желании — пересоздать со scope.

## Коммиты

```
2681eff feat(phase-5/F-5.1,F-5.2): аудит process.cwd()/chdir consumers
29a57b8 feat(phase-5/F-5.3): replace cwd в tool definitions — per-session context
9a20eec feat(phase-5/F-5.4): удаление process.chdir() из runtime
a1121f9 fix(phase-5): F1 — store installer использует session cwd
2f9ab67 feat(phase-5/F-5.5): PersistentMessageQueue (JSONL per sessionId)
6213235 feat(phase-5/F-5.6): restore queues on startup + WS notify
6bfbb97 feat(phase-5/F-5.7): per-project tokens scope
ae2218a feat(phase-5/F-5.8): E2E параллельных сессий — секция 13
ad3cff8 fix(phase-5): HIGH эскалация scoped token + F2 MCP project-config
```
