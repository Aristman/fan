# FAN Scheduler Guide

> **Status:** draft — разделы добавляются по мере реализации Phase 4 features. Полный гайд будет дополнен при docs-финализации фазы.

FAN Scheduler (`tools/fan-scheduler/`) — автономный cron-based runner задач: читает `config.yaml`, по расписанию ставит задачи в однопоточную очередь и выполняет их через FAN API Gateway.

---

## Bot Identity — GitHub PAT (F-4.6)

Автономные git/PR-действия (ветки `fan-auto/*`, push, создание PR) выполняются под **отдельным GitHub-аккаунтом бота**, а не под личным аккаунтом разработчика. Scheduler читает PAT из переменной окружения `GITHUB_TOKEN` при старте.

### Поведение scheduler'а

- При старте токен валидируется **один раз** запросом `GET https://api.github.com/user`; результат кэшируется (повторные обращения не ходят в сеть).
- Токен **никогда не логируется** в открытом виде — в логах используется маскированная форма (первые 4 символа + `***`, например `ghp_***`).
- Если токен **отсутствует** — scheduler логирует warning и продолжает работу; git/PR-зависимые действия помечаются недоступными (`gitEnabled=false`).
- Если токен **невалиден** (HTTP 401/403) или GitHub API недоступен — то же самое: warning с описанием причины, `gitEnabled=false`, scheduler не падает.
- Если у токена нет минимального scope `repo` (проверяется по заголовку `x-oauth-scopes`) — логируется предупреждение, что push/PR-действия могут завершаться ошибкой.

Программный интерфейс — `tools/fan-scheduler/lib/github-identity.ts`:

| Функция | Назначение |
|---------|-----------|
| `validateToken(token?)` | Валидация PAT через GitHub API (кэшируется); читает `GITHUB_TOKEN` из env, если аргумент не передан |
| `validateGitHubIdentity()` | Startup-helper: валидация + лог результата; никогда не бросает исключение |
| `isGitEnabled()` | `true`, если валидная identity подтверждена — можно выполнять git/PR-действия |
| `maskedToken(token)` | Маскировка токена для логов (`первые 4` + `***`) |

### Создание bot account

1. Зарегистрируйте отдельный GitHub-аккаунт (например, `fan-bot`) с отдельным email. Не используйте личный аккаунт — все автономные коммиты/PR будут подписаны этой identity.
2. Добавьте bot account как **collaborator** в целевые репозитории (или в организацию с ролью, дающей push).
3. (Рекомендуется) Включите **branch protection** на `main`/`master`: запрет direct push, обязательные PR — бот работает только через ветки `fan-auto/*` и PR.

### Создание PAT

1. Войдите под bot account → **Settings → Developer settings → Personal access tokens**.
2. Вариант A (рекомендуется) — **Fine-grained token**:
   - **Repository access:** Only select repositories → выберите репозитории для автономных задач;
   - **Permissions:** `Contents: Read and write`, `Pull requests: Read and write`;
   - срок жизни — по политике безопасности (с rotation).
3. Вариант B — **Classic token**: минимальный scope — `repo` (полный контроль приватных репозиториев). Для публичных репозиториев достаточно `public_repo`.
4. Скопируйте токен сразу — GitHub показывает его один раз.

### Настройка окружения

Токен передаётся только через env var — **никогда не коммитьте его в репозиторий**:

```bash
# .env / docker-compose environment / systemd unit
GITHUB_TOKEN=ghp_...
```

При деплое через Docker — секция `environment:` в `docker-compose.yml` (сам файл с секретами — вне VCS) или Docker secrets.

### Проверка вручную

```bash
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
# HTTP 200 → { "login": "fan-bot", ... }
```

При старте scheduler логирует результат валидации, например:

```
[github] identity validated: login=fan-bot (token ghp_***)
[github] git/PR-dependent actions unavailable (gitEnabled=false): GITHUB_TOKEN not configured
```

---

## Feature Branch Policy — fan-auto/<id>-<timestamp> (F-4.7)

Каждая автономная задача работает в уникальной feature-ветке. Коммиты **только** в feature-ветки — **никогда** в `main`/`master`.

### Naming convention

```
fan-auto/<task-id>-<YYYYMMDD-HHmmss>
# пример: fan-auto/review-1-20260725-090000
```

- Timestamp — UTC, формат `YYYYMMDD-HHmmss`.
- Имя всегда соответствует regex `/^fan-auto\/[\w-]+-\d{8}-\d{6}$/` (экспортируется как `AUTONOMOUS_BRANCH_NAME_REGEX`).
- Идентификатор задачи санитизируется в git-safe slug: unicode → ASCII (диакритика срезается через NFKD), lowercase, пробелы/слэши/спецсимволы схлопываются в одиночный `-`, края подрезаются, длина ограничена 50 символами (`MAX_SLUG_LENGTH`).
- Результат **никогда** не равен `main`/`master`: slug, в точности совпадающий с защищённой веткой, префиксуется `task-` (например `main` → `task-main`); кроме того, префикс `fan-auto/` и суффикс timestamp делают совпадение невозможным в принципе.

Программный интерфейс — `tools/fan-scheduler/lib/branch-policy.ts` (чистые функции, единственный I/O — часы, инъецируются параметром `now` для тестов):

| Экспорт | Назначение |
|---------|-----------|
| `generateBranchName(task, now?)` | Генерация имени ветки: `fan-auto/<slug>-<timestamp>`; принимает `{ id?, name? }` или строку |
| `sanitizeTaskId(raw)` | Санитизация идентификатора в git-safe slug |
| `formatBranchTimestamp(date)` | Форматирование даты как `YYYYMMDD-HHmmss` (UTC) |
| `isValidBranchName(name)` | Проверка имени по `AUTONOMOUS_BRANCH_NAME_REGEX` |
| `AUTONOMOUS_BRANCH_NAME_REGEX` | Regex валидации: `/^fan-auto\/[\w-]+-\d{8}-\d{6}$/` |
| `AUTONOMOUS_BRANCH_POLICY` | Текст-константа system prompt для autonomous mode (см. ниже) |
| `PROTECTED_BRANCHES` | `['main', 'master']` |

### System prompt template

`AUTONOMOUS_BRANCH_POLICY` — текст правила branch policy для агента в autonomous mode: создавай ветку `fan-auto/*` до начала изменений (`git checkout -b`), никогда не коммить/push в `main`/`master`, по завершении — `git add -A && git commit`, `git push -u origin <branch>`, `gh pr create --base main --head <branch>`.

> **Интеграция:** константа экспортируется как единый источник правды. Подстановка в сообщения задач будет реализована позже (F-4.16 / scheduler config) — до этого потребители добавляют текст в начало task message самостоятельно.

Ветка создаётся агентом через bash tool: `git checkout -b fan-auto/task-X-20260725-120000`.

---

## DB Backup — daily cron (F-4.15)

Ежедневный бэкап живой SQLite-базы `filin.db` (реальное имя файла — upstream hardcode, см. `packages/db/src/client.ts`; в ранних roadmap ошибочно упоминалась как `fan.db`). Реализация — standalone-скрипт **`deploy/scripts/backup-db.sh`** + системный cron на VPS. Scheduler не изменялся: бэкап — отдельная cron-задача ОС, сбой бэкапа изолирован и не влияет на scheduler.

### Что делает скрипт

1. Копирует `$FAN_AGENT_DIR/filin.db` (default `~/.fan/agent/filin.db`) в `$FAN_AGENT_DIR/backups/filin-YYYYMMDD-HHmmss.db`.
2. Ротирует старые копии — хранит **последние 7** (настраивается `KEEP`).
3. Идемпотентен: повторный запуск в ту же секунду пропускает копирование; ротация всегда сходится к `KEEP` файлам.
4. Сбой логируется в stderr и завершает скрипт с exit code 1 — процесс scheduler'а не затрагивается (задача выполняется системным cron'ом, не scheduler'ом).

### Механизм копирования: sqlite3 `.backup` vs cp

`filin.db` — **живая** БД. Голый `cp` может скопировать файл в середине записи (в WAL-режиме некоммиченные страницы лежат в `-wal`-сайдкаре, который cp не захватит согласованно). Поэтому скрипт выбирает механизм автоматически:

| Условие | Механизм | Гарантии |
|---------|----------|----------|
| `sqlite3` CLI доступен (предпочтительно) | `sqlite3 "$DB" ".backup '<dest>'"` — SQLite Online Backup API | Crash-safe для живой БД (корректен при WAL и активных писателях); результат проверяется `PRAGMA integrity_check` |
| `sqlite3` отсутствует (fallback) | `cp` + WARN в лог | Допустимо только потому, что окно 03:00 не пересекается с запланированными задачами — БД почти наверняка idle. Установите sqlite3: `apt-get install -y sqlite3` |

**Выбор задокументирован:** primary path — `.backup` (единственный безопасный способ для live-БД без остановки сервиса); cp — явно помеченный fallback с оговоркой про WAL.

### Cron-запись на VPS

```cron
# FAN DB backup — daily at 03:00 (F-4.15)
0 3 * * * /opt/fan-agent/deploy/scripts/backup-db.sh >> /var/log/fan-backup.log 2>&1
```

Установка: `crontab -e` под root, либо `/etc/cron.d/fan-backup`.

### Docker / volumes

- В контейнере БД живёт в `/data/.fan/agent/filin.db` (volume **`fan-data`**, env `FAN_AGENT_DIR=/data/.fan/agent`).
- Бэкапы по умолчанию пишутся в `/data/.fan/agent/backups/` — **в тот же volume `fan-data`** (отдельный volume `fan-backups` не требуется; compose не изменялся).
- Скрипт запускается **на хосте** через `docker exec` — в slim-образе нет sqlite3, поэтому cron-команда на VPS:

```cron
0 3 * * * docker exec fan-agent sh -c 'cp /data/.fan/agent/filin.db /data/.fan/agent/backups/filin-$(date +\%Y\%m\%d-\%H\%M\%S).db' >> /var/log/fan-backup.log 2>&1
```

либо (рекомендуется) примонтировать директорию `backups` из volume наружу и запускать хостовый `backup-db.sh` с `DB_PATH`/`BACKUP_DIR`, где хостовый sqlite3 даст безопасный `.backup`. Локальный запуск вне Docker (без контейнера) — прямой вызов скрипта, как в первой cron-записи.

### Env vars скрипта

| Переменная | Default | Назначение |
|-----------|---------|-----------|
| `FAN_AGENT_DIR` | `~/.fan/agent` | Директория данных агента (в Docker: `/data/.fan/agent`) |
| `DB_PATH` | `$FAN_AGENT_DIR/filin.db` | Полный путь к БД |
| `BACKUP_DIR` | `$FAN_AGENT_DIR/backups` | Директория бэкапов |
| `KEEP` | `7` | Сколько последних копий хранить |

### Безопасность бэкапов

Бэкапы содержат **те же секреты, что и БД** — токены `ClientToken` (доступ к API), историю сессий. Скрипт выставляет `chmod 600` на каждую копию (owner-only). Дополнительно:
- директория `backups/` — права `0700`;
- не выносите бэкапы в публично доступные mount'ы;
- при бэкапе наружу (off-site) — шифруйте (`gpg -c`) или используйте приватное хранилище.

### Проверка (TDD)

- **TC-F-4.15-1:** запуск скрипта → создан `filin-YYYYMMDD-HHmmss.db`; содержимое проверено через SQL (`SELECT` + `PRAGMA integrity_check` = ok). Побайтовое совпадение **не** гарантируется при `.backup` (online backup API перепаковывает БД) — корректность проверяется данными и integrity check; при cp-fallback копия побайтова.
- **TC-F-4.15-2:** 8-й запуск → самая старая копия удалена, осталось ровно 7 файлов.
- `bash -n` чист; реальные прогоны на тестовой БД (оба пути: sqlite3 и cp-fallback) — PASS.

---

*Остальные разделы (config.yaml, очередь, budget caps, мониторинг) будут добавлены по мере реализации соответствующих фич Phase 4.*
