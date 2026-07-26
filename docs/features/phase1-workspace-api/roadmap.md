# Roadmap: Фаза 1 — Workspace-aware API (project routing / cwd / whitelist)

> **Дата создания:** 2026-07-25
> **Источник:** [spec_fan-network-agent_phase1-workspace-api_2026-07-25.md](../../specs/spec_fan-network-agent_phase1-workspace-api_2026-07-25.md) · [родительская spec](../../specs/spec_fan-network-agent_2026-07-25.md)
> **Фич:** 14 | **Этапов:** 6 | **E2E-сценариев:** 1

---

## Сводная таблица по приоритетам

| Приоритет | Кол-во фич | Описание |
|-----------|-----------|----------|
| P0 (Must) | 12 | Prisma cwd, session filter, POST cwd, projects endpoint, whitelist, SessionAdapter, project registry, E2E |
| P1 (Should) | 2 | Auto-registration, CLI register command |
| P2–P3 | 0 | Нет |

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
| P0 | Must Have | Критично для мультипроектной работы через API |
| P1 | Should Have | Желательно до публичного запуска |
| P2 | Could Have | Можно отложить |
| P3 | Won't Have | Отклонено для текущей фазы |

### Слои реализации

| Слой | Описание |
|------|----------|
| [DATA] | Изменения моделей данных (Prisma schema, migration) |
| [API] | HTTP/WebSocket endpoints (http-server.ts, router) |
| [BIZ] | Бизнес-логика: whitelist-валидация, реестр проектов |
| [CORE] | Ядро runtime: agent-session-runtime, SessionManager |
| [CLI] | Команды CLI: `fan project register` |
| [INFRA] | Стартовый cwd, default workspace root |
| [E2E] | Комплексные сквозные сценарии |

---

## Этап 1.1 — Data layer: Prisma схема и миграция

**Цель SMART:** Поле `cwd` добавлено в модель `Session` как nullable String с индексом `@@index([cwd])`. Миграция обратносовместима: старые сессии имеют `null`, при загрузке используется fallback на dirname из имени папки (`--encoded-cwd--`). Сборка без ошибок, тесты Prisma passing.

### Фичи

#### ✅ F-1.1: Prisma поле cwd в модели Session

- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Добавить nullable поле `cwd: String?` в модель Session в `packages/db/prisma/schema.prisma`. Поле хранит абсолютный путь рабочей директории проекта. Nullable для обратной совместимости.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-1.1-1:** Схема парсится без ошибок
    - *Условие:* `cwd: String?` добавлен в model Session
    - *Шаги:* `bunx prisma validate`
    - *Ожидаемый результат:* Exit code 0; нет ошибок парсинга schema
  - [ ] **TC-F-1.1-2:** Migration применяется успешно
    - *Условие:* Схема валидна
    - *Шаги:* `bunx prisma migrate dev --name add_session_cwd`
    - *Ожидаемый результат:* Exit code 0; new migration file created; SQLite DB updated
  - [ ] **TC-F-1.1-3:** Старая сессия с null cwd загружается
    - *Условие:* Сессия с cwd = null существует в БД
    - *Шаги:* Загрузить сессию через SessionManager; проверить восстановление cwd
    - *Ожидаемый результат:* cwd восстановлен из dirname path (`--encoded-cwd--`) или установлен в null → fallback
- **Критерии приёмки:**
  1. Поле `cwd: String?` присутствует в `schema.prisma`
  2. Migrate создает ALTER TABLE ADD COLUMN — без потери данных
  3. Nullable позволяет старым сессиям существовать
- **Ожидаемый результат:** Обновлённый `packages/db/prisma/schema.prisma`; new migration file
- **Оценка объёма:** S

---

## Этап 1.2 — Project-aware session endpoints

**Цель SMART:** Все session endpoints поддерживают query-параметр `?project=<path>` для фильтрации. POST /api/sessions принимает `cwd` в теле запроса. DELETE верифицирует принадлежность к проекту. API остаётся backward compatible: вызов без параметров работает как раньше (все сессии).

### Фичи

#### ✅ F-1.2: GET /api/sessions с фильтром ?project=

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Модифицировать handler GET /api/sessions в `packages/api-gateway/src/http-server.ts`: при наличии query param `project` — фильтровать сессии по полю `cwd` в БД. Без параметра — вернуть все сессии (backward compatible). Response включает поле `cwd` в каждой сессии.
- **Зависимости:** F-1.1 (поле cwd в schema)
- **TDD-тесты:**
  - [ ] **TC-F-1.2-1:** Фильтр по project возвращает отфильтрованный список
    - *Условие:* 2 проекта с сессиями: `/data/repos/a` (3 сессии), `/data/repos/b` (2 сессии)
    - *Шаги:* `GET /api/sessions?project=/data/repos/a`; авторизованный request
    - *Ожидаемый результат:* HTTP 200; body.sessions.length === 3; все sessions.cwd === `/data/repos/a`
  - [ ] **TC-F-1.2-2:** Без параметра — все сессии
    - *Условие:* Тот же набор данных
    - *Шаги:* `GET /api/sessions` (без ?project=)
    - *Ожидаемый результат:* HTTP 200; body.sessions.length === 5 (все сессии обоих проектов)
  - [ ] **TC-F-1.2-3:** Пустой проект не найдено
    - *Условие:* Проект `/data/repos/unknown` не существует
    - *Шаги:* `GET /api/sessions?project=/data/repos/unknown`
    - *Ожидаемый результат:* HTTP 200; body.sessions.length === 0; пустой массив
- **Критерии приёмки:**
  1. Query parameter `project` читается из URL search params
  2. Если `project` задан — фильтр по `cwd` в Prisma query
  3. Ответ всегда содержит поле `cwd` (nullable)
- **Ожидаемый результат:** Обновлённый `packages/api-gateway/src/http-server.ts`; GET /api/sessions handler
- **Оценка объёма:** M

#### ✅ F-1.3: POST /api/sessions принимает cwd в теле

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Расширить тело POST /api/sessions полем `cwd?: string`. При наличии `cwd` — создать сессию с указанным рабочим каталогом. При отсутствии — использовать текущий cwd процесса (`main.ts:894`). Response 201 Created включает созданный cwd.
- **Зависимости:** F-1.1 (field exists), F-1.2 (pattern established)
- **TDD-тесты:**
  - [ ] **TC-F-1.3-1:** Создание сессии с cwd
    - *Условие:* CORS и auth настроены
    - *Шаги:* `POST /api/sessions` с `{ "cwd": "/data/repos/my-project" }`; Auth header valid
    - *Ожидаемый результат:* HTTP 201; response includes `cwd: "/data/repos/my-project"`
  - [ ] **TC-F-1.3-2:** Создание сессии без cwd (backward compat)
    - *Условие:* Нет поля cwd в body
    - *Шаги:* `POST /api/sessions` с `{}`
    - *Ожидаемый результат:* HTTP 201; response.cwd = process.cwd() (текущая директория сервера)
  - [ ] **TC-F-1.3-3:** Невалидный JSON в теле возвращает 400
    - *Условие:* malformed JSON
    - *Шаги:* `POST /api/sessions` с невалидным телом
    - *Ожидаемый результат:* HTTP 400 Bad Request; сообщение об ошибке в теле
- **Критерии приёмки:**
  1. Парсинг тела извлекает поле `cwd`, если оно задано
  2. `cwd` передаётся в поток создания сессии
  3. Обратная совместимость при отсутствии поля
- **Ожидаемый результат:** Модифицированный `http-server.ts`; POST /api/sessions handler update
- **Оценка объёма:** M

#### ✅ F-1.4: DELETE /api/sessions/:id с верификацией проекта

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** DELETE endpoint принимает опциональный `?project=`. При наличии — проверяет что сессия принадлежит указанному проекту (cwd match). Если не совпадает — 403 Forbidden. Без параметра — удаление как раньше (глобально).
- **Зависимости:** F-1.2 (filtering pattern), F-1.3 (cwd storage)
- **TDD-тесты:**
  - [ ] **TC-F-1.4-1:** Удаление с совпадающим проектом проходит
    - *Условие:* Сессия в проекте A; delete с ?project=A
    - *Шаги:* `DELETE /api/sessions/<id>?project=/data/repos/a`
    - *Ожидаемый результат:* HTTP 204 No Content; сессия удалена
  - [ ] **TC-F-1.4-2:** Удаление чужого проекта блокируется
    - *Условие:* Сессия в проекте A; delete с ?project=/data/repos/b
    - *Шаги:* `DELETE /api/sessions/<id>?project=/data/repos/b`
    - *Ожидаемый результат:* HTTP 403 Forbidden; body `{ error: "session does not belong to this project" }`
  - [ ] **TC-F-1.4-3:** Удаление без ?project= — глобальное
    - *Условие:* Без параметра project
    - *Шаги:* `DELETE /api/sessions/<id>`
    - *Ожидаемый результат:* HTTP 204; сессия удалена независимо от проекта
- **Критерии приёмки:**
  1. Если `?project=` задан — загрузить сессию, сравнить cwd
  2. Несовпадение → 403; совпадение → удаление как обычно
  3. Отсутствие параметра → без перекрёстной проверки (прежнее поведение)
- **Ожидаемый результат:** Обновлённый `http-server.ts`; DELETE handler
- **Оценка объёма:** S

---

## Этап 1.3 — Projects endpoint + реестр

**Цель SMART:** Новый endpoint `GET /api/projects` возвращает массив зарегистрированных workspaces с подсчётом количества сессий. Реестр хранится в `~/.fan/agent/projects.json` (JSON array of {path, name, type, addedAt}). Авто-регистрация при первом сеансе в непустой директории.

### Фичи

#### ✅ F-1.5: NEW endpoint GET /api/projects

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Создать новый endpoint `GET /api/projects`. Ответ: `{ projects: [{path, name, type, sessionCount}, ...] }`. Реализация: чтение `~/.fan/agent/projects.json` + подсчёт сессий через `SessionManager.listAll()` группировкой по cwd.
- **Зависимости:** F-1.1 (cwd stored per session)
- **TDD-тесты:**
  - [ ] **TC-F-1.5-1:** Возвращает существующие проекты с session count
    - *Условие:* 2 проекта: A (3 сессии), B (7 сессий); projects.json заполнен
    - *Шаги:* `GET /api/projects`
    - *Ожидаемый результат:* HTTP 200; body.projects[0].sessionCount === 3; body.projects[1].sessionCount === 7
  - [ ] **TC-F-1.5-2:** Пустой реестр — пустой массив
    - *Условие:* projects.json пустой или отсутствует
    - *Шаги:* `GET /api/projects`
    - *Ожидаемый результат:* HTTP 200; body.projects = []
  - [ ] **TC-F-1.5-3:** Name вычисляется из path (basename)
    - *Условие:* path = `/data/repos/my-project`
    - *Шаги:* `GET /api/projects`
    - *Ожидаемый результат:* name = `"my-project"` (basename от path)
- **Критерии приёмки:**
  1. Endpoint route зарегистрирован в api-gateway router
  2. Чтение projects.json + агрегация количества сессий
  3. Структура ответа соответствует контракту
- **Ожидаемый результат:** Новый handler в `packages/api-gateway/src/http-server.ts`; route `GET /api/projects`
- **Оценка объёма:** M

#### ✅ F-1.6: Реестр проектов projects.json

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Создать утилиты для управления `~/.fan/agent/projects.json`: чтение, запись (атомарная: write temp + rename), добавление. Формат: `[{"path": "/abs/path", "name": "basename", "type": "code|research|automation|unknown", "addedAt": "ISO8601"}]`. Атомарная запись предотвращает race condition при concurrent access.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-1.6-1:** Проект добавляется атомарно
    - *Условие:* projects.json существует (пустой [])
    - *Шаги:* Вызвать addToProjects(`/data/repos/new`, `"new"`); read файл
    - *Ожидаемый результат:* Array содержит entry с корректными path/name/type/timestamp; файл валиден JSON
  - [ ] **TC-F-1.6-2:** Дублирующий путь игнорируется
    - *Условие:* Path уже существует в реестре
    - *Шаги:* Вызвать addToProjects(existingPath, newName)
    - *Ожидаемый результат:* Array unchanged; entry not duplicated
  - [ ] **TC-F-1.6-3:** Повреждённый файл — корректная обработка без краша
    - *Условие:* projects.json содержит невалидный JSON
    - *Шаги:* Вызвать listProjects()
    - *Ожидаемый результат:* Возвращает пустой массив []; логирование warning; без краша
- **Критерии приёмки:**
  1. Атомарная запись: tmp-файл → rename в целевой
  2. Детект дублей по сравнению путей
  3. Корректная обработка отсутствующих/повреждённых файлов
- **Ожидаемый результат:** Новый модуль утилит для реестра (e.g. `packages/coding-agent/src/core/project-registry.ts` или в main.ts util секции)
- **Оценка объёма:** M

#### ✅ F-1.7: Авто-регистрация при первом сеансе

- **Приоритет:** P1
- **Слой:** [BIZ]
- **Описание:** При создании сессии в непустой директории (не null, не temporary) — автоматически добавить проект в реестр. Тип определяется: наличие `.git` → `code`, наличие `docs/` → `research`, иначе `unknown`. Проверяется только если cwd не пустой и не находится в системных путях.
- **Зависимости:** F-1.6 (registry utils)
- **TDD-тесты:**
  - [x] **TC-F-1.7-1:** Git-репозиторий автоматически регистрируется как 'code'
    - *Условие:* Сессия в `/data/repos/repo-with-git` (есть .git dir)
    - *Шаги:* Создать сессию с этим cwd
    - *Ожидаемый результат:* projects.json содержит entry type='code'; basename извлечён корректно
  - [x] **TC-F-1.7-2:** Системные пути исключены из регистрации
    - *Условие:* CWD = `/tmp` or system directory
    - *Шаги:* Создать сессию
    - *Ожидаемый результат:* Не зарегистрировано в реестре
- **Критерии приёмки:**
  1. Проверка выполняется при CREATE SESSION
  2. Регистрируются только непустые, несистемные директории
  3. Вывод типа использует проверки файловой системы (.git, docs/)
- **Ожидаемый результат:** Hook в Session creation flow (inside `http-server.ts` or service layer)
- **Оценка объёма:** M

#### ✅ F-1.8: CLI команда fan project register

- **Приоритет:** P1
- **Слой:** [CLI]
- **Описание:** Команда `fan project register <path>` для ручной регистрации проекта. Автоматически определяет тип (если не передан --type). Поддерживает `fan project list` для просмотра реестра.
- **Зависимости:** F-1.6 (registry utils)
- **TDD-тесты:**
  - [ ] **TC-F-1.8-1:** Команда регистрирует проект вручную
    - *Условие:* projects.json пустой
    - *Шаги:* `fan project register /data/repos/manual-test`
    - *Ожидаемый результат:* Exit 0; projects.json содержит entry; output confirms registration
  - [ ] **TC-F-1.8-2:** Список показывает все зарегистрированные проекты
    - *Условие:* Несколько проектов в реестре
    - *Шаги:* `fan project list`
    - *Ожидаемый результат:* Выводит таблицу: PATH | NAME | TYPE | ADDED AT
- **Критерии приёмки:**
  1. Команда парсит аргумент и вызывает реестр
  2. Выводит человекочитаемое подтверждение
  3. `project list` formats data as table
- **Ожидаемый результат:** Новый CLI command handler в `packages/coding-agent/src/cli/`
- **Оценка объёма:** S

---

## Этап 1.4 — Core: SessionAdapter + per-session cwd

**Цель SMART:** SessionAdapter адаптирован для operation с project context. ResourceLoader и SettingsManager получают cwd из сессии а не из процесса. `process.chdir()` сохраняется (фаза 5 removal separately). Service layers initialized per workspace. Сборка без ошибок, регрессионные тесты TUI pass.

### Фичи

#### ✅ F-1.9: SessionAdapter project-aware methods

- **Приоритет:** P0
- **Слой:** [CORE]
- **Описание:** Интерфейс SessionAdapter (`packages/api-gateway/src/http-server.ts` внутри `packages/coding-agent/src/main.ts`, ~строки 163–227 аудита) расширяется: методы принимают optional `projectPath?: string`. Без параметра — операции глобальные. С параметром — filtered by cwd. Включая `createSession(cwd?)`, `listSessions(projectPath?)`, `getSessionById(id, projectPath?)`, `deleteSession(id, projectPath?)`.
- **Зависимости:** F-1.2..F-1.4 (API patterns established), F-1.1 (cwd field)
- **TDD-тесты:**
  - [ ] **TC-F-1.9-1:** createSession с cwd инициализирует сервисы
    - *Условие:* Новый cwd не в кеше сервисов
    - *Шаги:* call adapter.createSession('/data/repos/x')
    - *Ожидаемый результат:* SessionInfo returned with cwd='/data/repos/x'; resources loaded for that workspace
  - [ ] **TC-F-1.9-2:** listSessions без projectPath возвращает все
    - *Условие:* 2 проекта с сессиями
    - *Шаги:* adapter.listSessions() (no arg)
    - *Ожидаемый результат:* All sessions returned; length equals sum across both projects
  - [ ] **TC-F-1.9-3:** getSessionById проверяет принадлежность проекту
    - *Условие:* Session belongs to project A
    - *Шаги:* adapter.getSessionById(id, '/data/repos/B')
    - *Ожидаемый результат:* Возвращает null или выбрасывает ошибку 403 (сессия не найдена в запрошенном проекте)
- **Критерии приёмки:**
  1. Опциональный параметр projectPath на всех CRUD-методах
  2. Null/undefined → прежние глобальные операции
  3. Заданный путь → фильтрация по Session.cwd
- **Ожидаемый результат:** Updated `packages/coding-agent/src/main.ts`; interface extension
- **Оценка объёма:** M

#### ✅ F-1.10: Per-session cwd вместо process-wide cwd

- **Приоритет:** P0
- **Слой:** [CORE]
- **Описание:** `agent-session-runtime.ts` модифицирован: ResourceLoader и SettingsManager получают cwd из сессии а не из процесса. При switchSession — chdir сохраняется, но сервисы пересоздаются с новым cwd. Полное удаление `process.chdir()` оставлено для фазы 5.
- **Зависимости:** F-1.9 (adapter methods), F-1.1 (cwd field)
- **TDD-тесты:**
  - [ ] **TC-F-1.10-1:** Сервисы загружаются для каждого workspace
    - *Условие:* Workspace имеет `.fan/settings.json` специфичный
    - *Шаги:* createSession with specific cwd; trigger settings load
    - *Ожидаемый результат:* Settings loaded from `<cwd>/.fan/settings.json` not global `~/.fan/agent/settings.json`
  - [ ] **TC-F-1.10-2:** Переключение сохраняет chdir, но переинициализирует сервисы
    - *Условие:* Active session in project A
    - *Шаги:* switchSession to project B; check chdir(); check resources
    - *Ожидаемый результат:* process.cwd() changed to B; resources reloaded for B
  - [ ] **TC-F-1.10-3:** Однопроектный поток не нарушен
    - *Условие:* Одна сессия, один проект (как сейчас)
    - *Шаги:* Normal TUI flow — start session, send message, receive response
    - *Ожидаемый результат:* Works exactly as before; no regression
- **Критерии приёмки:**
  1. Применён паттерн `createServicesForWorkspace(session.cwd ?? process.cwd())`
  2. ResourceLoader respects per-session cwd
  3. `process.chdir()` preserved at switch time (not removed)
- **Ожидаемый результат:** Обновлённый `packages/coding-agent/src/core/agent-session-runtime.ts`
- **Оценка объёма:** M

#### ✅ F-1.11: Стартовый cwd сервера = default workspace root

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** При запуске `fan server` без cwd в запросе — используется default workspace root. Env var `FAN_WORKSPACE_ROOT` переопределяет дефолт (`~/projects`). В docker-compose: `FAN_WORKSPACE_ROOT=/data/repos`.
- **Зависимости:** F-1.10 (per-session cwd pattern)
- **TDD-тесты:**
  - [ ] **TC-F-1.11-1:** Дефолтный workspace root используется, когда cwd не задан
    - *Условие:* Без FAN_WORKSPACE_ROOT env
    - *Шаги:* Start `fan server`; POST /api/sessions без cwd
    - *Ожидаемый результат:* Session cwd = os.homedir() + '/projects'
  - [ ] **TC-F-1.11-2:** FAN_WORKSPACE_ROOT переопределяет дефолт
    - *Условие:* FAN_WORKSPACE_ROOT=/data/custom
    - *Шаги:* Start server; create session without cwd
    - *Ожидаемый результат:* Session cwd = `/data/custom`
  - [ ] **TC-F-1.11-3:** Явный cwd в запросе переопределяет стартовый root
    - *Условие:* FAN_WORKSPACE_ROOT=/data/default
    - *Шаги:* POST /api/sessions with `{ cwd: '/data/explicit' }`
    - *Ожидаемый результат:* Session cwd = `/data/explicit` (request wins over env)
- **Критерии приёмки:**
  1. Fallback chain: explicit cwd → FAN_WORKSPACE_ROOT → ~/projects
  2. Настроено в секции environment docker-compose
  3. Работает и в локальном, и в контейнерном режимах
- **Ожидаемый результат:** Обновлённый `packages/coding-agent/src/main.ts`; docker-compose.yml env vars
- **Оценка объёма:** S

#### ✅ F-1.12: listAll() проброс cwd в API responses

- **Приоритет:** P0
- **Слой:** [CORE]
- **Описание:** `SessionManager.listAll()` уже возвращает cwd в SessionInfo. Обеспечить проброс в ответ API endpoint. GET /api/sessions должен включать `cwd` в каждый элемент массива sessions. Filter по ?project= применяется после listAll().
- **Зависимости:** F-1.2 (GET filtering), F-1.11 (startup cwd set)
- **TDD-тесты:**
  - [ ] **TC-F-1.12-1:** CWD включён в ответ списка сессий
    - *Условие:* listAll возвращает SessionInfo[] с cwd populated
    - *Шаги:* GET /api/sessions
    - *Ожидаемый результат:* Каждый элемент response.sessions содержит поле cwd со значением
  - [ ] **TC-F-1.12-2:** Фильтр применяется после listAll
    - *Условие:* Multi-project setup
    - *Шаги:* GET /api/sessions?project=/data/repos/X
    - *Ожидаемый результат:* Только сессии с cwd = X; cwd поле присутствует
- **Критерии приёмки:**
  1. Результаты listAll маппятся в формат ответа API
  2. Each session summary includes cwd field
  3. Filter logic operates on returned data (in-memory) or via indexed DB query
- **Ожидаемый результат:** Обновлённый mapping в `http-server.ts` GET handler
- **Оценка объёма:** S

---

## Этап 1.5 — Безопасность: whitelist-валидация cwd

**Цель SMART:** Модуль `workspace-validation.ts` или встроенный validator в `auth.ts` обеспечивает проверку cwd против разрешённых корневых путей (FAN_WORKSPACE_ROOT). Symlink traversal detected → reject. Canonical path normalization. HTTP 403 Forbidden при отказе. Логирование попытки в audit journal. Fallback: если whitelist пустой — все проверки пропускаются (локальный режим).

### Фичи

#### ✅ F-1.13: Whitelist validation middleware

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Функция `validateCwd(path: string, allowedRoots: string[]): ValidationResult`. Нормализует путь (path.resolve + symlink check). Проверяет что canonical path начинается с одного из allowed roots. Результат: `{ valid: boolean, reason: string? }`. При отказе → HTTP 403. Логируется attempt.
- **Зависимости:** F-1.3 (POST принимает cwd), F-1.11 (allowed roots из FAN_WORKSPACE_ROOT)
- **TDD-тесты:**
  - [ ] **TC-F-1.13-1:** Valid path within whitelist + empty whitelist bypass
    - *Условие:* allowedRoots = ['/data/repos']; path = '/data/repos/my-project/secrets.txt'; ИЛИ allowedRoots = []
    - *Шаги:* validateCwd(path, ['/data/repos']); затем validateCwd('/any/path', [])
    - *Ожидаемый результат:* Оба: { valid: true }; при пустом whitelist — все пути проходят (локальный режим)
  - [ ] **TC-F-1.13-2:** Путь вне whitelist отклонён
    - *Условие:* allowedRoots = ['/data/repos']; path = '/etc/passwd'
    - *Шаги:* validateCwd(path, allowedRoots)
    - *Ожидаемый результат:* { valid: false, reason: 'path outside allowed roots' }; срабатывает 403
  - [ ] **TC-F-1.13-3:** Обход через symlink обнаружен и заблокирован
    - *Условие:* Path resolves through symlink to outside whitelist
    - *Шаги:* validateCwd('/data/repos/link-to-etc', allowedRoots)
    - *Ожидаемый результат:* { valid: false, reason: 'symlink traversal detected' }; срабатывает 403
- **Критерии приёмки:**
  1. Нормализация пути (path.resolve + realpath для symlink) и проверка startsWith по каждому разрешённому корню
  2. Middleware интегрирован в POST /api/sessions и любой endpoint, принимающий cwd; при отказе — запись в audit log
- **Ожидаемый результат:** Новый модуль `packages/api-gateway/src/workspace-validation.ts` или расширение `auth.ts`; middleware integration в http-server.ts
- **Оценка объёма:** L

---

## E2E-сценарии фазы 1

#### ✅ F-1.14-E2E: Мультипроектный API workflow

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Сквозной сценарий: через API создан проект → создана сессия в проекте A и B → переключение между ними → попытка path traversal отклонена. Проверяет всю цепочку: реестр → сессия → filter → безопасность.
- **Зависимости:** F-1.1..F-1.13
- **TDD-тесты:**
  - [x] **TC-F-1.14-E2E-1:** Сквозной мультипроектный API-поток
    - *Условие:* FAN запущен, FAN_PUBLIC=1, whitelist configured (`FAN_WORKSPACE_ROOT=/data/repos`)
    - *Шаги:*
      1. `POST /api/projects` (или CLI register) → регистрация `/data/repos/project-a`
      2. `POST /api/projects` → регистрация `/data/repos/project-b`
      3. `GET /api/projects` → verify оба проекта в списке
      4. `POST /api/sessions` с `{ cwd: "/data/repos/project-a" }` → создать сессию A
      5. `POST /api/sessions` с `{ cwd: "/data/repos/project-b" }` → создать сессию B
      6. `GET /api/sessions?project=/data/repos/project-a` → получить сессии A
      7. `GET /api/sessions?project=/data/repos/project-b` → получить сессии B
      8. `DELETE /api/sessions/<a-id>?project=/data/repos/project-a` → удалить сессию A
      9. Убедиться: GET /api/sessions без filter → осталась только сессия B
    - *Ожидаемый результат:* Все шаги завершаются успешно; фильтры корректны; удаление только своей сессии
  - [x] **TC-F-1.14-E2E-2:** Межпроектное удаление заблокировано
    - *Условие:* Сессия A в проекте A
    - *Шаги:* `DELETE /api/sessions/<a-id>?project=/data/repos/project-b`
    - *Ожидаемый результат:* HTTP 403 Forbidden; session NOT deleted
  - [x] **TC-F-1.14-E2E-3:** Обход путей (path traversal) заблокирован
    - *Условие:* Whitelist = `/data/repos`
    - *Шаги:* `POST /api/sessions` с `{ cwd: "/etc/passwd" }`
    - *Ожидаемый результат:* HTTP 403 Forbidden; body contains error message; no session created; attempt logged
- **Критерии приёмки:**
  1. Все CRUD операции работают с project context; фильтрация по ?project= точна
  2. Безопасность: path traversal заблокирован, межпроектные операции отклонены
  3. Обратная совместимость: API без project-параметров работает
- **Ожидаемый результат:** Ручной или автоматический test script; результаты фиксируются
- **Оценка объёма:** M

---

## Граф зависимостей

```
Phase 1 Dependencies:
│
├── F-1.1 (Prisma cwd field) ──→┬── F-1.2 (GET ?project= filter) ──→ F-1.12 (listAll → API)
├──                                ├── F-1.3 (POST cwd body) ──→ F-1.4 (DELETE verify)
│                               │
├── F-1.6 (Registry utils) ──→┬── F-1.5 (GET /api/projects) ──→ (no downstream)
├──                            ├── F-1.7 (Auto-registration) ──→ (enhancement)
├──                            └── F-1.8 (CLI register) ──→ (enhancement)
│
├── F-1.9 (SessionAdapter) ──→ F-1.10 (Per-session cwd) ──→ F-1.11 (Startup cwd)
│
├── F-1.3 + F-1.11 ──→ F-1.13 (Whitelist validation)
│
└── All P0 above ──→ F-1.14-E2E (Multi-project workflow)
```

**Проверка циклов:** Циклов нет. DAG verified: DATA → API → CORE → BIZ → E2E.

---

## Полный чеклист по приоритетам

### P0 (Must Have) — 12 фич

- [ ] ✅ F-1.1 Prisma cwd в Session + migration
- [ ] ✅ F-1.2 GET /api/sessions с фильтром ?project=
- [ ] ✅ F-1.3 POST /api/sessions принимает cwd
- [ ] ✅ F-1.4 DELETE /api/sessions/:id с верификацией проекта
- [ ] ✅ F-1.5 GET /api/projects endpoint
- [ ] ✅ F-1.6 Реестр проектов projects.json
- [ ] ✅ F-1.9 SessionAdapter project-aware methods
- [ ] ✅ F-1.10 Per-session cwd вместо process-wide
- [ ] ✅ F-1.11 Стартовый cwd сервера = default workspace root
- [ ] ✅ F-1.12 listAll() проброс cwd в API
- [ ] ✅ F-1.13 Whitelist validation middleware
- [x] ✅ F-1.14-E2E Мультипроектный API workflow

### P1 (Should Have) — 2 фич

- [x] ✅ F-1.7 Авто-регистрация при первом сеансе
- [x] ✅ F-1.8 CLI команда `fan project register`

### P2 (Could Have) — 0 фич

_Нет фич._

---

## Итоговая оценка

| Мера | Значение |
|------|---------|
| Всего фич | 14 (13 реализаций + 1 E2E) |
| P0 фич | 12 (11 реализаций + 1 E2E) |
| P1 фич | 2 |
| P2 фич | 0 |
| Этапов | 6 (data layer, session endpoints, projects, core/runtime, security, E2E) |
| Оценка P0 | ~3 дня (data: 2h + endpoints: 8h + core: 8h + security: 4h + E2E: 4h) |
| Оценка полная | ~5 дней (с учётом P1) |
| Путь к публикации | P0-complete → integration tests → staging → production |

---

*Сгенерировано: docs-impl agent · 2026-07-25*
*На основе: spec_fan-network-agent_phase1-workspace-api_v1.0*
