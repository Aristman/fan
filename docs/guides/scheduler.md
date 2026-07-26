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

*Остальные разделы (config.yaml, очередь, budget caps, PR-политика, мониторинг) будут добавлены по мере реализации соответствующих фич Phase 4.*
