# Pipeline Report: Фаза 1 — Workspace-aware API

> **Дата старта:** 2026-07-25
> **Дата завершения:** 2026-07-25
> **Ветка:** FAN-007-REMOTE-ACCESS
> **Стратегия коммитов:** per-function (conventional)
> **Roadmap:** docs/features/phase1-workspace-api/roadmap.md

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 14 |
| Реализовано (✅) | 14 |
| Провалено (❌) | 0 |
| Коммитов | 15 (14 feat + 1 fix), диапазон `5b0b944..ee49635` |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-1.1 Prisma cwd | ✅ | `8846b55` | vitest (db) | 1 |
| F-1.2 GET ?project= | ✅ | `567869a` | http-server.test.ts | 1 |
| F-1.3 POST cwd | ✅ | `e4db4d1` | http-server.test.ts | 1 |
| F-1.4 DELETE verify | ✅ | `ce68980` | http-server.test.ts | 1 |
| F-1.5 GET /api/projects | ✅ | `a2c98ef` | http-server.test.ts (TC-F-1.5-1..3) | 1 |
| F-1.6 projects.json | ✅ | `b4e71b9` | project-registry.test.ts | 1 |
| F-1.7 авто-регистрация | ✅ | `81f0bc4` | auto-register.test.ts | 1 |
| F-1.8 CLI register | ✅ | `dc18faf` | project-command.test.ts | 1 |
| F-1.9 SessionAdapter | ✅ | `f8f1955` | http-server.test.ts | 1 |
| F-1.10 per-session cwd | ✅ | `a32b130` | контракт + TDD | 1 |
| F-1.11 FAN_WORKSPACE_ROOT | ✅ | `cb697e6` | server-config.test.ts | 1 |
| F-1.12 listAll cwd | ✅ | `a833584` | http-server.test.ts | 1 |
| F-1.13 whitelist | ✅ | `bad03c6` | workspace-validation.test.ts | 2 (fix `ee49635`) |
| F-1.14-E2E workflow | ✅ | `ca51d86` | e2e-local.sh секция 8 (21 проверка) | 1 |

## Детали реализации

### Ключевые файлы

| Файл | Назначение |
|------|-----------|
| `packages/db/prisma/schema.prisma` | Поле `cwd: String?` в модели Session + `@@index([cwd])` |
| `packages/api-gateway/src/http-server.ts` | `?project=` фильтр (GET/DELETE), `cwd` в POST, `GET /api/projects`, нормализация путей |
| `packages/api-gateway/src/workspace-validation.ts` | `validateCwd` / `resolveAllowedRoots` / `logCwdRejection` — whitelist-валидация (F-1.13) |
| `packages/api-gateway/src/types.ts` | `CreateSessionRequest.cwd`, `SessionSummary.cwd`, `ProjectSummary`, `ListProjectsResponse` |
| `packages/coding-agent/src/core/project-registry.ts` | Реестр `~/.fan/agent/projects.json`: атомарная запись, дедупликация |
| `packages/coding-agent/src/core/project-auto-register.ts` | Авто-регистрация при создании сессии (`.git` → code, `docs/` → research) |
| `packages/coding-agent/src/cli/project-command.ts` | CLI `fan project register/list` |
| `packages/coding-agent/src/cli/server-config.ts` | `resolveWorkspaceRoot` — `FAN_WORKSPACE_ROOT` → `~/projects` |
| `packages/coding-agent/src/main.ts` | Стартовый cwd сервера, `allowedRoots` в startServer, `handleProjectCommand` |
| `docker-compose.yml` | `FAN_WORKSPACE_ROOT=/data/repos`, volume `fan-repos` |
| `deploy/scripts/e2e-local.sh` | Секция 8: мультипроектный E2E (F-1.14-E2E) |

### Контракты API (фаза 1)

- `GET /api/sessions?project=<path>` — фильтр по `cwd` (нормализованное сравнение); без параметра — все сессии
- `POST /api/sessions { cwd }` — 400 при невалидном типе `cwd`; 403 при отказе whitelist
- `DELETE /api/sessions/:id?project=<path>` — 204 / 403 (cross-project) / 404
- `GET /api/projects` → `{ projects: [{ path, name, type, sessionCount }] }`
- Legacy-сессии: `cwd` omitted (никогда не `null`/пустая строка), не матчатся `?project=` фильтром

### Безопасность (F-1.13)

- Whitelist = resolved workspace root (`FAN_WORKSPACE_ROOT` → `~/projects`) в server mode
- Каноникализация: `path.resolve` + `realpath` на longest existing prefix — закрыт partial-symlink bypass
- Segment-boundary сравнение — `/data/repos2` ≠ `/data/repos`
- Отказы: 403 + структурированный audit log (`[api-gateway][audit] cwd rejected`, max 500 chars)

### Fix верификации

`ee49635` — 4 находки верификации в валидации cwd (граничные случаи F-1.13).

### E2E (F-1.14-E2E)

`deploy/scripts/e2e-local.sh` секция 8: проекты A/B → сессии в обоих →
реестр + `?project=` фильтры → cross-project delete 403 → path traversal
403 → in-project delete 204. Всего 21 проверка в скрипте.
