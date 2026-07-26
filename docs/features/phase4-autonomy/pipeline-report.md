# Pipeline Report: Фаза 4 — Автономность

> **Дата старта:** 2026-07-26
> **Дата финализации:** 2026-07-26
> **Ветка:** FAN-007-REMOTE-ACCESS
> **Стратегия коммитов:** per-function (conventional)
> **Roadmap:** docs/features/phase4-autonomy/roadmap.md

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 16 |
| Реализовано (✅) | 16 |
| Провалено (❌) | 0 |
| Коммитов | 18 (`8b6ca9a..HEAD` = `f114f07..11f270b`) — 16 feat + 2 fix |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-4.1 scheduler package + YAML | ✅ | `f114f07` | TC-1..3 ✅ (config-loader.test) | 1 |
| F-4.2 FAN API client | ✅ | `72375fc` | TC-1..2 ✅ (client.test) | 1 |
| F-4.3 TaskQueue | ✅ | `45be19d` | TC-1..3 ✅ (queue.test) | 1 |
| F-4.4 execution pipeline | ✅ | `f51a7b6` | TC-1..2 ✅ (executor.test) | 1 |
| F-4.5 cron loop | ✅ | `3c71b12` | TC-1..2 ✅ (cron-scheduler.test) | 1 |
| F-4.6 bot identity | ✅ | `438e205` | TC-1..2 ✅ (github-identity.test) | 1 |
| F-4.7 branch policy | ✅ | `d747b41` | TC-1..2 ✅ (branch-policy.test) | 1 |
| F-4.8 PR via gh | ✅ | `cd6c673` | TC-1..2 ✅ (gh-client.test) | 1 |
| F-4.9 budget cap | ✅ | `7031450` + fix `11f270b` | TC-1..3 ✅ (executor.test, gateway budget tests) | 2 |
| F-4.10 retry/backoff | ✅ | `ea384fe` | TC-1..2 ✅ (retry.test) | 1 |
| F-4.11 JSON logging | ✅ | `95160ae` | TC-1..2 ✅ (logger.test) | 1 |
| F-4.12 chat interruption | ✅ | `025e9b5` | TC-1..2 ✅ (activity-monitor.test, control-server.test) | 1 |
| F-4.13 persistent queue | ✅ | `4f3d40a` | TC-1..2 ✅ (persistent-storage.test) | 1 |
| F-4.14 health endpoint | ✅ | `3943f88` | TC-1..2 ✅ (control-server.test, gateway proxy test) | 1 |
| F-4.15 DB backup | ✅ | `8d040a3` + fix `36b8c75` | TC-1..2 ✅ (реальные прогоны на тестовой БД, оба пути) | 2 |
| F-4.16-E2E полный цикл | ✅ | `ed0a02e` | TC-1..3 ✅ (e2e-local.sh секция 12, 103/103 ×2) | 1 |

## Детали реализации

### Коммиты (git log `8b6ca9a..HEAD`, 20 шт.)

| Коммит | Содержание |
|--------|-----------|
| `f114f07` | feat(phase-4/F-4.1): пакет fan-scheduler + YAML config-loader |
| `72375fc` | feat(phase-4/F-4.2): FAN API Client для scheduler |
| `45be19d` | feat(phase-4/F-4.3): TaskQueue однопоточное выполнение |
| `f51a7b6` | feat(phase-4/F-4.4): execution pipeline (createTaskExecutor) |
| `3c71b12` | feat(phase-4/F-4.5): cron scheduling loop |
| `438e205` | feat(phase-4/F-4.6): bot identity — GitHub PAT |
| `d747b41` | feat(phase-4/F-4.7): feature branch policy fan-auto/<id>-<timestamp> |
| `cd6c673` | feat(phase-4/F-4.8): PR creation via gh CLI |
| `7031450` | feat(phase-4/F-4.9): budget cap per task + per-project budget в gateway |
| `ea384fe` | feat(phase-4/F-4.10): retry with exponential backoff |
| `95160ae` | feat(phase-4/F-4.11): structured JSON logging |
| `025e9b5` | feat(phase-4/F-4.12): chat interruption — pause autonomous tasks |
| `4f3d40a` | feat(phase-4/F-4.13): persistent queue — file durability |
| `3943f88` | feat(phase-4/F-4.14): health & metrics endpoint scheduler |
| `8d040a3` | feat(phase-4/F-4.15): DB backup daily cron |
| `36b8c75` | fix(phase-4/F-4.15): безопасность бэкапов (verify finding) |
| `ed0a02e` | feat(phase-4/F-4.16): E2E автономного цикла + scheduler в compose |
| `11f270b` | fix(phase-4): 5 находок верификации (budget per-task delta, права, валидация, biome) |

### Архитектура (что построено)

- **`tools/fan-scheduler/`** — новый Bun-пакет (npm workspaces через `"tools/*"`): `scheduler.ts` (entry point) + 13 модулей в `lib/` (config-loader, client, queue, executor, cron-scheduler (Croner), retry, logger, persistent-storage, activity-monitor, control-server, github-identity, branch-policy, gh-client). 202 unit-теста (vitest).
- **Отдельный процесс** от api-gateway; интеграция только через HTTP API (`FAN_API_URL`/`FAN_API_TOKEN`). Gateway изменён минимально: per-project budget endpoints (F-4.9) + прокси `GET /api/scheduler/health` (F-4.14).
- **docker-compose:** сервис `fan-scheduler` (тот же образ, команда `bun tools/fan-scheduler/dist/scheduler.js /data/scheduler/config.yaml`), `depends_on: fan (service_healthy)`; config — read-only mount `./deploy/scheduler/config.yaml` (override `FAN_SCHEDULER_CONFIG`); токен — `FAN_SCHEDULER_TOKEN` из `.env`.
- **deploy/scripts/backup-db.sh** — daily SQLite backup (sqlite3 `.backup` + cp-fallback, ротация 7, chmod 600/700) + системный cron.

### Находки верификаций

**Верификация F-4.15 (backup security) — fix `36b8c75`:**
- Бэкапы содержат те же секреты, что и БД (ClientToken) → добавлен `chmod 600` на каждую копию; задокументирована секция «Безопасность бэкапов» (0700 на директорию, не публиковать, gpg для off-site).

**Верификация F-4.16-E2E — PASS:**
- Секция 12 `deploy/scripts/e2e-local.sh`: 103 проверки всего, 2× прогон 103/103 PASS (идемпотентно). Автоматизировано: config load → cron trigger → FIFO-сериализация двух задач (TC-3) → persistent queue на диске → pause/resume через control server → createSession 201 → `budget_cap_set` до `sendMessage` → provider boundary (ожидаемый `failed` после 3 retry, no-LLM контур) → `/api/scheduler/health` proxy → budget API PUT/GET/400 + файл в fan-data volume. Git/PR/LLM-шаги TC-1 и реальный `budget_exceeded` TC-2 — manual checklist в шапке секции 12; `budget_exceeded` покрыт unit-тестом executor (TC-F-4.9-2).

**Финальная верификация — fix `11f270b` (5 находок):**
- **P1: budget cap = per-task delta** — кап enforcement вёлся по lifetime usage проекта: любой проект с историей мгновенно выбивал `budget_exceeded`. Исправлено: baseline на старте задачи, стоп при `delta >= limit`; fallback на lifetime с warning при недоступном baseline (тест: lifetime=1000/limit=500/spend=200 → completed).
- **P2-1:** `backup-db.sh` — `chmod 700` на `BACKUP_DIR` (дополнение к 600 на копии).
- **P2-2:** `persistent-storage` — валидация чисел `timeout`/`budget_limit` при restore (битые записи пропускаются с warning).
- **P2-3:** `biome.json` — `tools/fan-scheduler` добавлен в includes (+29 файлов отформатированы, 696 файлов чисто).
- **P2-4:** `raceWithDeadline` — `clearTimeout` в `finally` (утечка таймера).
- Verify: scheduler 202 теста (+6), biome чист, e2e 103/103.

### Ключевые отклонения от roadmap (обоснованы)

1. **F-4.12 chat interruption** — вместо изменений gateway реализован scheduler-side polling (`UserActivityMonitor` → `GET /api/sessions`) + localhost control server. Gateway не тронут (его 183 теста целы). Задокументировано в roadmap и scheduler.md.
2. **F-4.15 имя БД** — реальный файл `filin.db` (upstream hardcode в `packages/db/src/client.ts`), в roadmap ошибочно `fan.db`; скрипт parametrize (`DB_PATH`).
3. **F-4.9 enforcement** — per-task delta вместо lifetime (см. находку P1).
4. **F-4.13 file lock** — атомарный tmp+rename вместо явного lock (single-writer процесс).

### Backlog (известные ограничения)

1. **Budget enforcement на gateway отсутствует** — gateway хранит/отдаёт капы, но не блокирует `sendMessage`; enforcement только scheduler-side (polling, per-task delta).
2. **Pause/timeout/budget не абортируют in-flight задачу** — у gateway нет interruption endpoint; обрывается только ожидание scheduler'а, агент дорабатывает server-side.
3. **Branch policy — prompt-level** — hard-enforcement только через GitHub branch protection (рекомендуется, задокументировано).
4. **`gh-client.ts` не подключён в прод-путь** — PR создаёт агент через bash tool по `AUTONOMOUS_BRANCH_POLICY`; библиотека реализована и протестирована, интеграция — future.
5. **Задачи, удалённые из config.yaml, остаются в pending-файле** — очистка вручную.
6. **Workspace clone перед задачей** (P2) — перенесена в «Вне roadmap (future)».
7. **LLM-шаги E2E** (git/PR реальный цикл, реальный budget_exceeded) — manual checklist (в контейнере нет API-ключей).

### Документация (финализация 2026-07-26)

- `docs/guides/scheduler.md` — полный гайд (архитектура, установка/compose, config.yaml справочник, budget delta, control server, activity monitor, persistent queue, Git/PR, backup, troubleshooting, production checklist, backlog)
- `docs/guides/api-reference.md` — per-project budget (F-4.9) + `/api/scheduler/health` (F-4.14) уже были; enforcement note обновлён до per-task delta
- `docs/guides/deployment.md` — секция 8.4 (fan-scheduler, `FAN_SCHEDULER_TOKEN`, backup cron), файлы в §2, `filin.db` в §8
- `README.md` — фича «Autonomous tasks (scheduler)» + строка в таблице docs + абзац в Docker-разделе
- `CHANGELOG.md` — [2.7.0]
- `docs/MANIFEST.md` — обновлён
