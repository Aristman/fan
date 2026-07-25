# Спецификация: Фаза 1 — Workspace-aware API

## Метаданные
- **Дата**: 2026-07-25
- **Автор**: research-spec-generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича · Фаза 1 из пакета «FAN Network Agent»
- **Связь**: [Родительская спецификация](./spec_fan-network-agent_2026-07-25.md)

---

## 1. Обзор

### 1.1 Цель

Сделать API FAN aware к проектам (workspaces). Все session endpoints принимают параметр `project` (cwd), добавляется endpoint `GET /api/projects`, сессия получает поле `cwd` в Prisma, создаётся реестр проектов на диске. Без этой фазы невозможно работать с несколькими проектами через API.

### 1.2 Контекст

Code-research аудит (`.fan/reports/research-fan-workspace-mode.md`) выявил 14 точек изменений для workspace-режима. Фаза 1 покрывает точки 1–7 (S и M сложности):

| # | Изменение | Файл (предполагаемый) | Сложность |
|---|-----------|----------------------|-----------|
| 1 | Prisma: поле `cwd` в Session | `packages/db/prisma/schema.prisma` | S |
| 2 | API: `?project=` + `cwd` в CreateSessionRequest | `packages/api-gateway/src/http-server.ts` | M |
| 3 | SessionAdapter: project-aware операции | интерфейс в `packages/api-gateway/src/http-server.ts` (создаётся в `packages/coding-agent/src/main.ts`, ~строки 163–227) | M |
| 4 | Убрать зависимость от `process.cwd()` в runtime | `packages/coding-agent/src/core/agent-session-runtime.ts` | M |
| 5 | Реестр проектов `~/.fan/agent/projects.json` | новый файл или util | S |
| 6 | Стартовый cwd сервера = default workspace root | `packages/coding-agent/src/main.ts` | S |
| 7 | `listAll()` → проброс `cwd` в API | `packages/coding-agent/src/core/session-manager.ts` | S |

**Обязательное требование безопасности (из решения 9.3 v2):** whitelist-валидация cwd относительно workspace root. Публичный API не должен принимать произвольные пути — защита path traversal.

---

## 2. Функциональные требования

### 2.1 Точка изменения №1: Prisma `cwd` в Session

**Файл:** `packages/db/prisma/schema.prisma`

Добавить nullable поле `cwd` в модель `Session`:

```prisma
model Session {
    id      String @id @default(cuid())
    cwd     String? // абсолютный путь рабочей директории проекта
    // ... существующие поля ...
}
```

Миграция: `bunx prisma migrate dev --name add_session_cwd`

Обратная совместимость: nullable. Старые сессии без cwd будут иметь `null` → fallback на cwd из имени директории (`--encoded-cwd--`) при загрузке.

### 2.2 Точка изменения №2: Project-aware endpoints

**Файл:** `packages/api-gateway/src/http-server.ts`

Все session endpoints дополняются query-параметром `project` (path/to/project):

#### GET /api/sessions?project=/data/repos/my-project

Возвращает только сессии заданного проекта (фильтрация по `cwd`):

**Ответ 200:**
```json
{
    "sessions": [
        {
            "id": "clxxx...",
            "title": "Fix auth bug",
            "cwd": "/data/repos/my-project",
            "createdAt": "2026-07-25T10:00:00Z"
        }
    ]
}
```

Если `project` не указан — поведение прежнее (все сессии).

#### POST /api/sessions

Тело запроса дополняется полем `cwd`:

**Запрос:**
```json
{
    "cwd": "/data/repos/another-project"
}
```

**Ответ 201:**
```json
{
    "id": "clyyy...",
    "title": "New Session",
    "cwd": "/data/repos/another-project",
    "createdAt": "2026-07-25T11:00:00Z"
}
```

Без `cwd` — используется текущий рабочий процесс (`main.ts:894`).

#### DELETE /api/sessions/:id

Дополнительно принимает `?project=` для верификации принадлежности сессии к проекту. Если сессия принадлежит другому проекту — возврат 403.

### 2.3 Точка изменения №7: GET /api/projects

**Файл:** `packages/api-gateway/src/http-server.ts`

Новый endpoint — перечисление всех известных проектов (workspace root + клонированные репозитории):

#### GET /api/projects

**Ответ 200:**
```json
{
    "projects": [
        {
            "path": "/data/repos/my-project",
            "name": "my-project",
            "type": "code",
            "sessionCount": 3
        },
        {
            "path": "/data/repos/idea-lab-workspace",
            "name": "idea-lab-workspace",
            "type": "research",
            "sessionCount": 7
        }
    ]
}
```

Реализация: чтение `~/.fan/agent/projects.json` (точка №5) + подсчёт сессий из `SessionManager.listAll()`.

### 2.4 Точка изменения №3: SessionAdapter — project-aware

**Интерфейс** в `packages/api-gateway/src/http-server.ts` (создаётся в `packages/coding-agent/src/main.ts`, ~строки 163–227)

Методы адаптируются к project context:

```typescript
// Интерфейс
interface SessionAdapter {
    createSession(cwd?: string): Promise<SessionInfo>;
    listSessions(projectPath?: string): Promise<SessionInfo[]>;
    getSessionById(id: string, projectPath?: string): Promise<SessionInfo | null>;
    deleteSession(id: string, projectPath?: string): Promise<void>;
}
```

Параметр `projectPath` фильтрует операции. Если не передан — операции глобальные (как сейчас).

### 2.5 Точка изменения №4: Per-session cwd вместо process.cwd()

**Файл:** `packages/coding-agent/src/core/agent-session-runtime.ts`

**Текущее поведение (line 119-120, 128-148 аудита):** один cwd процесса, переключение = `process.chdir()`.

**Изменение для фаases 1–2:** сохраняем `process.chdir()` при switch (не ломаем локальный TUI), но каждая сессия запоминает свой cwd. ResourceLoader, SettingsManager получают cwd из сессии, а не из процесса:

```typescript
// При создании сессии
const services = await this.createServicesForWorkspace(session.cwd ?? process.cwd());

// При switchSession — chdir сохраняется, но сервисы пересоздаются с новым cwd
await this.switchSession(targetPath);
```

**Замечание:** полное удаление `process.chdir()` запланировано в фазе 5 (точка изменений отсутствует здесь — отдельная крупная работа).

### 2.6 Точка изменения №5: Реестр проектов

**Файл:** `~/.fan/agent/projects.json`

Новый JSON-файл — реестр known workspaces:

```json
[
    {
        "path": "/data/repos/my-project",
        "name": "my-project",
        "type": "code",
        "addedAt": "2026-07-25T10:00:00Z"
    }
]
```

**Правила наполнения:**
- Автоматически: при первом сеансе в непустой директории она регистрируется
- Ручной: CLI `fan project register <path>` (будущая команда)
- Тип: определяется автоматически если возможно (наличие `.git` → код, наличие `docs/` → ресёрч), иначе `unknown`

### 2.7 Точка изменения №6: Стартовый cwd сервера

**Файл:** `packages/coding-agent/src/main.ts`

При запуске `fan server` без cwd в запросе — используется default workspace root:

```typescript
const startupCwd = process.env.FAN_WORKSPACE_ROOT 
    ?? path.join(os.homedir(), 'projects'); // ~/projects по умолчанию
```

Env var `FAN_WORKSPACE_ROOT` позволяет задать другой корень в docker-compose:
```yaml
environment:
  - FAN_WORKSPACE_ROOT=/data/repos
```

### 2.8 Точка изменения №7: listAll() → API cwd

**Файл:** `packages/coding-agent/src/core/session-manager.ts`

`SessionManager.listAll()` уже возвращает `cwd` в `SessionInfo`. Нужно обеспечить проброс в API:

```typescript
// Существующий метод (audited code-research)
async listAll(): Promise<SessionInfo[]> {
    // сканирует ~/.fan/agent/sessions/--encoded-cwd--/
    // SessionInfo включает cwd
}
```

API endpoint `GET /api/sessions` добавляет `cwd` в ответы SessionSummary.

---

## 3. Валидация cwd (whitelist-проверка)

### Критический риск (из решения 9.3 v2)

**Path traversal через cwd-параметр API.** Публичный endpoint, принимающий произвольный путь, — это чтение всей ФС VPS (например, `?project=/etc/passwd`).

### Митигация: обязательна в фазе 1, до публичного доступа

**Файл:** `packages/api-gateway/src/auth.ts` или отдельный модуль `packages/api-gateway/src/workspace-validation.ts`

```typescript
// Проверка cwd против whitelist
function validateCwd(path: string, allowedRoots: string[]): ValidationResult {
    const canonical = normalizePath(path);
    
    // Отказ на symlink-выход
    if (isSymlinkOutsideWhitelist(canonical, allowedRoots)) {
        return { valid: false, reason: 'symlink traversal detected' };
    }
    
    // Проверяем что путь начинается с одного из разрешённых root'ов
    const isValid = allowedRoots.some(root => canonical.startsWith(normalizePath(root)));
    
    return { valid: isValid, reason: isValid ? undefined : 'path outside allowed roots' };
}
```

**Настройка Whitelist (docker env):**
```yaml
environment:
  - FAN_WORKSPACE_ROOT=/data/repos
  # Несколько путей:
  # - FAN_WORKSPACE_ROOT=/data/repos;/data/lab
```

**Поведение при отказе:** HTTP 403 Forbidden с сообщением `{"error": "workspace path not allowed"}`. Логируется попытка в журнал аудита.

**Fallback:** если `FAN_WORKSPACE_ROOT` не установлен — whitelist пустой, все проверки пропускаются (локальный режим). В production-контейнере всегда устанавливается.

---

## 4. Пользовательские сценарии

### Сценарий 1: Создание сессии нового проекта

**Предусловия:** FAN запущен, `FAN_PUBLIC=1`, nginx настроен
**Шаги:**
1. Клиент запрашивает `GET /api/projects` — получает список
2. Клиент вызывает `POST /api/projects` (или CLI) для регистрации `/data/repos/new-project`
3. Клиент вызывает `POST /api/sessions` с `{cwd: "/data/repos/new-project"}`
4. FAN загружает per-project настройки из `/data/repos/new-project/.fan/`
5. Сессия создана, ID возвращается клиенту

**Ожидаемый результат:** новая сессия в проекте, сессию видно в `GET /api/sessions?project=/data/repos/new-project`

### Сценарий 2: Фильтрация сессий по проекту

**Предусловия:** несколько проектов с сессиями
**Шаги:**
1. Клиент запрашивает `GET /api/sessions?project=/data/repos/my-project`
2. Получает только сессии этого проекта

**Ожидаемый результат:** список сессий отфильтрован по cwd, включает поле `cwd`

### Сценарий 3: Попытка path traversal

**Предусловия:** whitelist настроен (`FAN_WORKSPACE_ROOT=/data/repos`)
**Шаги:**
1. Клиент вызывает `POST /api/sessions` с `{cwd: "/etc/passwd"}`
2. Сервер проверяет путь — не в whitelist
3. Возврат 403

**Ожидаемый результат:** доступ заблокирован, попытка залогирована

---

## 5. Нефункциональные требования

### 5.1 Обратная совместимость (из решения 9.2 v2)

| # | Изменение | Влияние на локальный TUI/dashboard | Риск |
|---|-----------|-----------------------------------|------|
| 1 | Prisma `cwd` nullable | Старые сессии → fallback на cwd из имени директории | 🟢 Низкий |
| 2 | Project-aware API | Аддитивно: новый query-параметр. Без параметра — поведение прежнее | 🟢 Низкий |
| 3 | SessionAdapter | Внутренний; без project-параметра путь исполнения не меняется | 🟢 Низкий |
| 4 | Per-session cwd | `process.chdir()` при switch СОХРАНЯЕТСЯ; однопроектный flow не затрагивается | 🟡 Средний (сглажен) |
| 5 | Реестр проектов | Новый файл, аддитивно | 🟢 Низкий |
| 6 | Стартовый cwd | Только server mode; TUI стартует как раньше | 🟢 Низкий |
| 7 | listAll() → API | Аддитивно | 🟢 Низкий |

### 5.2 Производительность

- Запросы с фильтрацией по `cwd` используют индекс Prisma (индекс на поле `cwd`)
- Reестр проектов читается с диска при каждом запросе — для MVP приемлемо (<100 проектов)

---

## 6. Технические требования

### 6.1 Модели данных Prisma

```prisma
model Session {
    id        String   @id @default(cuid())
    title     String   @default("New Session")
    model     String?
    provider  String?
    cwd       String?  // НОВОЕ: абсолютный путь рабочей директории
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
    messages  Message[]
    
    @@index([cwd])   // НОВЫЙ: индекс для фильтрации по проекту
}
```

### 6.2 API контракты

#### GET /api/projects

```
Request:  GET /api/projects
Response: 200 OK
Body:     {"projects": [{path, name, type, sessionCount}, ...]}
```

#### GET /api/sessions

```
Request:  GET /api/sessions?project=<path>
Response: 200 OK
Body:     {"sessions": [{id, title, cwd, createdAt}, ...]}
```

#### POST /api/sessions

```
Request:  POST /api/sessions
Headers:  Authorization: Bearer <token>
Body:     {"title?": "string", "cwd?": "string"}
Response: 201 Created
Body:     {id, title, cwd, createdAt}
```

---

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Path traversal через cwd-параметр | Высокая без защиты | Критичное | Whitelist-валидация cwd (раздел 3) |
| Удаление process.chdir() ломает расширения/MCP | Средняя | Среднее | Chdir сохраняется до фазы 5 (точка №4) |
| Индекс cwd на большом количестве сессий | Низкая | Низкое | Простой B-tree индекс, MySQL-compatible для SQLite |
| Персистентность projects.json при race condition | Низкая | Низкое | Атомарная запись (write to temp + rename) |

---

## 8. Компромиссы

### 8.1 Принятые решения

- **Nullable `cwd` в Session** — обратная совместимость с миграцией. Старые сессии восстанавливают cwd из имени папки сессии (`--encoded-cwd--`).
- **Project-aware как опциональный параметр** — API backward compatible: вызов без `?project=` работает как раньше. Это не ломает клиентов, которые ещё не обновились.
- **In-memory реестр из JSON** — без отдельной БД для проектов. Для масштаба <100 projects производительность достаточна.

### 8.2 Отклонённые альтернативы

- **Принудительный cwd во всех request'ах** — сломает существующих клиентов. Выбран аддитивный подход.
- **Prisma-реестр проектов** — избыточная сложность для начального этапа. JSON-файл проще и достаточно надёжен для single-writer.

---

## 9. Приоритеты

### Must Have
- Prisma `cwd` в Session + миграция
- `?project=` filter в session endpoints
- `cwd` в теле POST /api/sessions
- `GET /api/projects` endpoint
- Whitelist-валидация cwd (безопасность!)
- Реестр проектов `projects.json`
- Проект-aware SessionAdapter

### Should Have
- Auto-registration проектов при первом сеансе
- CLI команда `fan project register`
- Подсчёт sessionCount в `/api/projects` ответе

### Could Have
- `fan project remove <path>` — deregister
- Автоматическое определение типа проекта (.git → code, docs/ → research)

### Won't Have
- Git-интеграция в registry — клонирование через external tool
- Multi-user projects — один оператор

---

## 10. Следующие шаги

- [ ] Добавить поле `cwd` в Prisma schema, создать миграцию
- [ ] Добавить индекс по `cwd`
- [ ] Реализовать `validateCwd()` — whitelist validator
- [ ] Модифицировать `http-server.ts`: `?project=` фильтр, `cwd` в POST body
- [ ] Создать `GET /api/projects` endpoint
- [ ] Обновить SessionAdapter с project-aware методами
- [ ] Создать `~/.fan/agent/projects.json` утилиты
- [ ] Настроить default workspace root в main.ts
- [ ] Регрессионные тесты: сборка, тесты api-gateway, ручная проверка TUI

---

*Создано: research-spec-generator skill · дата 2026-07-25*
*Фаза 1 из пакета «FAN Network Agent»*
*Спецификация ссылается на родительскую: [FAN Network Agent](./spec_fan-network-agent_2026-07-25.md)*
