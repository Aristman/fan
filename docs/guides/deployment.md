# Руководство по развёртыванию — FAN Runtime на VPS

Продакшн-развёртывание API-шлюза FAN за nginx с TLS на
**agent.sea-agents.ru** (VPS `185.219.41.46`).

```
Internet ──HTTPS/443──► nginx (TLS termination, WS upgrade)
                            │ proxy_pass
                            ▼
                     http://127.0.0.1:3456  (loopback only)
                            │
                            ▼
                Docker container `fan-agent` (docker-compose.yml)
```

На том же VPS уже работает **FAN Store** (`fan.sea-agents.ru`, статические файлы +
htpasswd basic auth) на том же экземпляре nginx. FAN runtime сосуществует с ним:

- nginx владеет портами 80/443; виртуальные хосты разделены по `server_name` (SNI) —
  конфликтов портов нет.
- Файлы FAN Store, его server block и `/etc/nginx/.fan-htpasswd`
  **не затрагиваются** этим развёртыванием.
- API-шлюз FAN слушает на `127.0.0.1:3456` (только loopback, см.
  `docker-compose.yml`) и доступен исключительно через nginx.

---

## 1. Требования

На VPS (`root@185.219.41.46`, Ubuntu):

| Компонент | Проверка | Установка |
|-----------|----------|-----------|
| Docker | `docker --version` | [docs.docker.com/engine/install/ubuntu](https://docs.docker.com/engine/install/ubuntu/) |
| Compose plugin | `docker compose version` | `apt-get install docker-compose-plugin` |
| nginx | `nginx -v` | уже установлен (FAN Store) |
| certbot | `certbot --version` | `apt-get install certbot python3-certbot-nginx` |
| DNS | A-запись `agent.sea-agents.ru → 185.219.41.46` | панель регистратора / DNS-провайдера |

Проверьте DNS перед продолжением:

```bash
dig +short agent.sea-agents.ru
# expected: 185.219.41.46
```

## 2. Используемые файлы (в этом репозитории)

| Файл | Назначение |
|------|------------|
| `Dockerfile` | Многоэтапная сборка → компактный runtime-образ |
| `docker-compose.yml` | Сервис `fan`, привязка к loopback-порту, volumes, env |
| `deploy/nginx/agent.sea-agents.ru.conf` | server block nginx (443 + редирект 80→443, WS upgrade) |
| `deploy/scripts/setup-tls.sh` | Идемпотентный скрипт настройки/проверки certbot (F-0.8), запускается на VPS |
| `deploy/scripts/e2e-local.sh` | Автоматизированный E2E smoke-тест на локальном Docker / loopback VPS (F-0.11-E2E, раздел 7; 107 проверок включая конкурентность phase 5 — раздел 13) |
| `docs/guides/deployment.md` | Данное руководство |
| `deploy/scheduler/config.yaml` | Конфиг задач планировщика по умолчанию (монтируется в `fan-scheduler`, F-4.16) |
| `deploy/scripts/backup-db.sh` | Скрипт ежедневного бэкапа SQLite с ротацией (F-4.15) |

## 3. Копирование файлов на VPS

Из локальной копии репозитория:

```bash
# Исходники приложения (сборка происходит на VPS внутри Docker)
rsync -avz --delete \
  --exclude node_modules --exclude .git --exclude dist \
  ./ root@185.219.41.46:/opt/fan-agent/

# Конфиг nginx
scp deploy/nginx/agent.sea-agents.ru.conf \
  root@185.219.41.46:/etc/nginx/sites-available/agent.sea-agents.ru.conf
```

> **Примечание:** копирование всего репозитория — самый простой путь (Dockerfile
> собирает из корня репо). Более лёгкая альтернатива — git clone на VPS —
> важно лишь чтобы `Dockerfile` и `docker-compose.yml` оказались в одном
> каталоге (например, `/opt/fan-agent/`).

## 4. TLS-сертификат — certbot (F-0.8)

Server block на 443 ссылается на
`/etc/letsencrypt/live/agent.sea-agents.ru/…` — nginx не пройдёт `nginx -t`,
пока сертификат не существует. Выпустите его **до** включения server block nginx.

### 4.1 Автоматически: `deploy/scripts/setup-tls.sh` (предпочтительно)

Скрипт покрывает TC-F-0.8-1 / TC-F-0.8-2 полностью и **идемпотентен**
(безопасно перезапускать — существующий действующий сертификат никогда не перевыпускается):

```bash
ssh root@185.219.41.46
cd /opt/fan-agent
bash deploy/scripts/setup-tls.sh
# или полностью неинтерактивно:
CERTBOT_EMAIL=admin@sea-agents.ru bash deploy/scripts/setup-tls.sh
```

Шаги, выполняемые скриптом:

1. Проверка DNS — `agent.sea-agents.ru` должен резолвиться в `185.219.41.46`
   (прерывается заранее, если A-запись отсутствует/неверная).
2. Проверка установки certbot (устанавливает `certbot python3-certbot-nginx`
   через apt, если отсутствует).
3. `certbot certonly --nginx -d agent.sea-agents.ru` — пропускается, если
   `/etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem` уже существует.
4. Проверка таймера обновления certbot — включает `certbot.timer`, если не активен.
5. `certbot renew --dry-run` — проверяет, что обновление работает.
6. Выводит subject/issuer/dates сертификата + количество дней до истечения.

### 4.2 Ручной вариант

Если предпочитаете выполнить шаги вручную:

```bash
ssh root@185.219.41.46

# предварительное условие: DNS A-запись agent.sea-agents.ru → 185.219.41.46
dig +short agent.sea-agents.ru

certbot certonly --nginx -d agent.sea-agents.ru

openssl x509 -in /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem -noout -dates
```

Certbot поднимает временный блок ACME challenge на порту 80 (FAN Store
не затрагивается).

### 4.3 Расположение сертификов

| Путь | Содержимое |
|------|------------|
| `/etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem` | Сертификат + цепочка (symlink → `../../archive/…`), используется nginx `ssl_certificate` |
| `/etc/letsencrypt/live/agent.sea-agents.ru/privkey.pem` | Приватный ключ, используется nginx `ssl_certificate_key` |
| `/etc/letsencrypt/archive/agent.sea-agents.ru/` | Все исторические версии сертификов |
| `/etc/letsencrypt/renewal/agent.sea-agents.ru.conf` | Параметры обновления (authenticator = nginx) |

И nginx, и certbot должны сохранять доступ к этим путям — не перемещайте их.

### 4.4 Автоматическое обновление

apt-пакет certbot поставляется с **systemd timer**, который запускает
`certbot renew` дважды в сутки; сертификаты обновляются, когда остаётся <30 дней
(Let's Encrypt выпускает 90-дневные сертификаты). Тот же timer уже обслуживает
`fan.sea-agents.ru` (FAN Store) — один timer обрабатывает все домены на хосте.

```bash
systemctl status certbot.timer   # expected: active (waiting), enabled
certbot renew --dry-run          # expected: exit 0, "Congratulations, all simulated renewals succeeded"
```

nginx authenticator выполняет HTTP-01 challenge через сам nginx
(порт 80 должен быть доступен из интернета для работы обновлений —
блок `location /.well-known/acme-challenge/` в конфиге nginx также
поддерживает webroot flow).

### 4.5 Если сертификат истёк или обновление не работает

Симптомы: браузеры показывают `NET::ERR_CERT_DATE_INVALID`, curl падает с
`certificate has expired`, `openssl x509 … -enddate` показывает дату в прошлом.

1. Перезапустите скрипт настройки — он повторно проверит DNS, перевыпустит
   если live-сертификат отсутствует, и сообщит остаток дней:
   `bash /opt/fan-agent/deploy/scripts/setup-tls.sh`
2. Изучите ошибки обновления: `certbot renew --dry-run` и
   `journalctl -u certbot.timer` / `less /var/log/letsencrypt/letsencrypt.log`.
3. Типичные причины: DNS-запись изменена/удалена, порт 80 заблокирован файрволом,
   nginx не запущен (nginx authenticator требует его), или rate limits
   (Let's Encrypt: 5 дубликатных сертификов на домен в неделю — используйте
   `--dry-run`/staging для экспериментов).
4. Принудительный перевыпуск при необходимости: `certbot certonly --nginx -d agent.sea-agents.ru --force-renewal`
   затем `systemctl reload nginx`.

## 5. Запуск стека

Порядок важен: сначала контейнер (чтобы цель прокси существовала), затем nginx.

```bash
# 1. Сборка и запуск FAN runtime
cd /opt/fan-agent
docker compose up -d --build

# 2. Ожидание healthcheck
docker compose ps            # status: (healthy)
docker compose logs -f fan   # Ctrl-C для выхода

# 3. Включение server block nginx
ln -s /etc/nginx/sites-available/agent.sea-agents.ru.conf \
      /etc/nginx/sites-enabled/agent.sea-agents.ru.conf

# 4. Валидация и перезагрузка (существующий fan.sea-agents.ru продолжает работать)
nginx -t
systemctl reload nginx
```

> **Если `nginx -t` падает с "duplicate map $connection_upgrade":** другой
> конфиг на хосте уже определяет эту map. Удалите блок `map` из
> `agent.sea-agents.ru.conf` (он определяется ровно один раз на экземпляр nginx)
> и повторно запустите `nginx -t`.

## 6. Контрольный список пост-развёртывания

TC-F-0.7-1 / TC-F-0.7-2 и проверки auth smoke. Запускайте с любой машины
(или с самого VPS):

- [ ] **TC-F-0.7-1 — Health endpoint по HTTPS**

  ```bash
  curl -s https://agent.sea-agents.ru/api/health
  ```
  Ожидается: HTTP 200, JSON-тело с `"status": "ok"`.
  (`/api/health` не требует авторизации.)

- [ ] **Авторизация принудительна — 401 без токена** (FAN_PUBLIC=1)

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://agent.sea-agents.ru/api/sessions
  ```
  Ожидается: `401`.

- [ ] **Авторизованный запрос работает**

  ```bash
  # Начальная настройка: POST /api/tokens сам защищён токеном и не существует
  # команды `fan token create` — создайте первый токен напрямую в БД
  # внутри контейнера через собственный Prisma-слой @fan/db приложения
  # (см. "Token bootstrap" в разделе 7):
  TOKEN=$(ssh root@185.219.41.46 "docker exec -w /app/packages/coding-agent fan-agent bun -e '
import { getPrismaClient } from \"@fan/db\";
import { randomBytes, randomUUID } from \"node:crypto\";
const p = getPrismaClient();
const t = randomBytes(32).toString(\"hex\");
await p.clientToken.create({ data: { id: randomUUID(), name: \"manual\", token: t } });
await p.\$disconnect();
console.log(t);'" | grep -oE '[0-9a-f]{64}')

  curl -s -X POST https://agent.sea-agents.ru/api/sessions \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d '{}'
  ```
  Ожидается: HTTP 201 с созданной сессией.

- [ ] **TC-F-0.7-2 — WebSocket upgrade**

  ```bash
  # wscat: npm i -g wscat
  wscat -c "wss://agent.sea-agents.ru/api/ws/<sessionId>?token=$TOKEN"
  ```
  Ожидается: `Connected (press CTRL+C to quit)` — сервер ответил
  `101 Switching Protocols`.

  Негативная проверка (без токена → 401):

  ```bash
  wscat -c "wss://agent.sea-agents.ru/api/ws/<sessionId>"
  ```
  Ожидается: соединение отклонено (`error: Unexpected server response: 401`).

- [ ] **FAN Store по-прежнему работает**

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://fan.sea-agents.ru/fan/index.json
  ```
  Ожидается: `401` (htpasswd prompt) или `200` с учётными данными — поведение не изменилось.

- [ ] **Прямой доступ к порту невозможен** (привязка к loopback)

  ```bash
  curl -s --max-time 3 http://185.219.41.46:3456/api/health
  ```
  Ожидается: connection refused / timeout.

## 7. E2E-проверка после развёртывания (F-0.11-E2E)

Два уровня: **автоматизированный скрипт** для полного цикла в локальном Docker
(также запускаемый на VPS против loopback-порта) и **ручной чеклист**
для VPS-специфичных частей, которые скрипт не может покрыть (HTTPS/TLS через
nginx, `wss://`, certbot).

### 7.1 Автоматически: `deploy/scripts/e2e-local.sh`

Запускает весь стек локально, точно как на VPS (те же Dockerfile,
docker-compose.yml, `FAN_PUBLIC=1`, `ALLOWED_ORIGINS`) и проверяет
контур сквозным образом:

```bash
bash deploy/scripts/e2e-local.sh
```

Что выполняется:

1. `docker compose up -d --build`, затем опрашивает `GET /api/health` до 200
   (таймаут `E2E_HEALTH_TIMEOUT`, по умолчанию 180 с).
2. **Health** — 200 + `db:"up"` в теле ответа.
3. **Авторизация принудительна** — `GET /api/sessions` без токена → 401
   (доказывает, что `FAN_PUBLIC=1` сохраняет авторизацию включённой, F-0.3).
4. **Token bootstrap** — создаёт токен внутри контейнера (см. 7.2).
5. **Sessions** — `POST /api/sessions` с токеном → 201; сессия
   получаемая через `GET /api/sessions/<id>` и отображается как активная в
   `/api/health`; `GET /api/sessions` → 200 с массивом сессий.
   (Новая сессия появляется в *списке* только после сохранения первого
   assistant-сообщения — SessionManager создаёт JSONL-файл при первом
   ответе ассистента, это штатное поведение.)
6. **CORS** — `Origin: https://evil.com` не получает
   `Access-Control-Allow-Origin`; `https://agent.sea-agents.ru` получает (F-0.4).
7. **Файловое логирование** — `/data/logs/app.log` существует и не пуст (F-0.10).
8. **WebSocket** (опционально — требует `bun` или `wscat` на хосте) — upgrade
   на `/api/ws/<sessionId>?token=…` проходит успешно и приходит приветственный
   фрейм `connected`.
9. `docker compose down` через `trap` при выходе (volumes сохраняются).

Код возврата 0 только если все проверки пройдены; каждая проверка выводит
цветную строку `[PASS]`/`[FAIL]`/`[SKIP]`.

**На VPS после развёртывания:** API привязан к `127.0.0.1:3456`, поэтому
тот же скрипт работает без изменений по SSH:

```bash
ssh root@185.219.41.46 "cd /opt/fan-agent && bash deploy/scripts/e2e-local.sh"
```

### 7.2 Token bootstrap (первый токен при включённой авторизации)

`POST /api/tokens` защищён той же middleware `tokenAuth`, что и каждый
другой маршрут `/api/*`, и не существует CLI-команды `fan token create` — поэтому
первый токен невозможно создать через HTTP (проблема курицы и яйца). Рабочий
путь — операторское создание напрямую в SQLite БД внутри контейнера,
используя собственный Prisma-слой `@fan/db` приложения (это **не ослабляет**
runtime-авторизацию — это эквивалент ручного добавления строки в таблицу
`ClientToken`):

```bash
docker exec -w /app/packages/coding-agent fan-agent bun -e '
import { getPrismaClient } from "@fan/db";
import { randomBytes, randomUUID } from "node:crypto";
const prisma = getPrismaClient();
const token = randomBytes(32).toString("hex");
await prisma.clientToken.create({ data: { id: randomUUID(), name: "bootstrap", token } });
await prisma.$disconnect();
console.log(token);
'
```

Примечания:

- `-w /app/packages/coding-agent` обязателен: bun's isolated install линкует
  workspace-пакеты в `node_modules` потребляющего пакета, поэтому
  `@fan/db` не резолвится из cwd `/app`.
- БД расположена по пути `/data/.fan/agent/filin.db` (volume `fan-data`).
- `e2e-local.sh` выполняет этот шаг автоматически (проверка 3).

### 7.3 Ручной чеклист VPS (TC-F-0.11-E2E-1/2/3)

Скрипт покрывает HTTP на loopback; следующее необходимо проверить вручную
на VPS, поскольку это затрагивает nginx + TLS:

- [ ] **TC-F-0.11-E2E-1 — стек поднят**: `docker ps` показывает `fan-agent`
  `(healthy)`; `ss -tlnp | grep -E ':(80|443)\b'` показывает nginx;
  `nginx -t` чист.
- [ ] **TC-F-0.11-E2E-2 — HTTPS health**: `curl -sk https://agent.sea-agents.ru/api/health`
  → 200 с `db:"up"` (действующий сертификат, `-k` не нужен при доступе снаружи).
- [ ] **TC-F-0.11-E2E-2 — WebSocket поверх TLS**: `wscat -c "wss://agent.sea-agents.ru/api/ws/<sessionId>?token=$TOKEN"`
  → `Connected`; приходит приветственный фрейм `{"type":"connected",...}`.
  Негативная: без `?token=` → `Unexpected server response: 401`.
- [ ] **TC-F-0.11-E2E-2 — сессия по HTTPS**: `curl -sk -X POST https://agent.sea-agents.ru/api/sessions -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'`
  → 201; `curl -sk https://agent.sea-agents.ru/api/sessions/<id> -H "Authorization: Bearer $TOKEN"` → 200.
- [ ] **TC-F-0.11-E2E-3 — авторизацию нельзя отключить**: при `FAN_PUBLIC=1`
  (и даже с установленным `FAN_NO_AUTH=1`), `curl -sk https://agent.sea-agents.ru/api/sessions`
  → 401.
- [ ] **Валидность сертификата** (TC-F-0.8-1):
  `openssl x509 -in /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem -noout -dates`
  → `notAfter` в будущем (90-дневный LE сертификат); повторная проверка в любое время через
  `bash /opt/fan-agent/deploy/scripts/setup-tls.sh` (выводит оставшиеся дни).
- [ ] **Обновление работает** (TC-F-0.8-2): `systemctl status certbot.timer`
  → active; `certbot renew --dry-run` → exit 0.

## 8. Обновления (повторное развёртывание)

```bash
rsync -avz --delete --exclude node_modules --exclude .git --exclude dist \
  ./ root@185.219.41.46:/opt/fan-agent/
ssh root@185.219.41.46 "cd /opt/fan-agent && docker compose up -d --build"
```

Данные (SQLite `filin.db`, JSONL-сессии, токены, очередь pending планировщика)
сохраняются в именованных volumes `fan-data` / `fan-repos` между пересборками.

### 8.1 Workspaces — поддержка мульти-проектов (Phase 1)

Контейнер считает `/data/repos` **корнем workspace**
(`FAN_WORKSPACE_ROOT=/data/repos` в `docker-compose.yml`, на базе volume
`fan-repos`). Все проекты агентов должны располагаться внутри этого каталога.

- **Защита whitelist (F-1.13):** `POST /api/sessions` принимает `cwd`
  только внутри корня workspace. Пути за его пределами — включая symlink
  escapes — отклоняются с HTTP 403 и записываются в аудит-лог
  (`[api-gateway][audit] cwd rejected ...` в `/data/logs/app.log`).
- **Реестр проектов:** зарегистрированные workspace отслеживаются в
  `/data/.fan/agent/projects.json` (внутри volume `fan-data`).
  `GET /api/projects` отдаёт реестр с количеством сессий по каждому проекту.
- **Авто-регистрация (F-1.7):** первая сессия, созданная в workspace,
  регистрирует его автоматически — `.git` присутствует → тип `"code"`, `docs/`
  присутствует → `"research"`, иначе `"unknown"`.
- **Ручная регистрация** (редко требуется — авто-регистрация покрывает
  типичный случай), внутри контейнера:

  ```bash
  docker exec -w /app fan-agent bun packages/coding-agent/dist/cli.js project register /data/repos/my-project
  docker exec -w /app fan-agent bun packages/coding-agent/dist/cli.js project list
  ```

  Или через любой бинарник `fan` на хосте: `fan project register /data/repos/my-project`,
  `fan project list`.

### 8.2 Очередь сообщений при занятом движке (Phase 2)

Runtime выполняет одну сессию за раз. Когда движок занят и приходит
`sendMessage` для другой сессии (например, вторая вкладка браузера работает
с другим проектом), WebSocket-диспетчер ставит её в очередь по сессии
(FIFO, лимит 50 сообщений) и подтверждает клиенту
`{ type: "queued", position: N }`; сверх лимита сообщение отклоняется
с `{ type: "queue_full", error: "QUEUE_OVERFLOW", limit: 50 }`. После
завершения каждого хода автоматически диспетчеризуется самое старое
сообщение в глобальной очереди. Очередь **только в памяти** — ожидающие
сообщения теряются при `docker compose restart`, поэтому клиентам следует
повторить отправку после переподключения, если они не получили `agent_event`
для отправленного в очередь сообщения. Очистка реестра для удалённых workspace:
`DELETE /api/projects?path=` (удаляет записи только из `projects.json` —
сессии и файлы не затрагиваются).

### 8.3 Типы workspace и шаблоны (Phase 3)

Workspace внутри `/data/repos` классифицируются по **типу** — `code`,
`research`, `automation` или `unknown` — хранятся в реестре проектов
(`/data/.fan/agent/projects.json`). Типы определяют иконки дашборда и
системные промпты с учётом типа.

- **Авто-определение (F-3.2)** запускается при регистрации и при создании проекта:
  приоритет `code > research > automation > unknown`. Критерии: `code` =
  `.git` + (`src/` или `package.json`); `research` = `docs/research/` или
  `.fan/prompts/`; `automation` = скриптовые файлы (`*.sh`/`*.py` в корне или
  `scripts/`) + конфиг (каталог `config/` или `*.yaml`/`*.yml`/`*.toml`/
  `*.ini`/`*.cfg` в корне); иначе `unknown`.
- **Создание из шаблонов (F-3.5):** `POST /api/projects` с
  `{ "name", "template": "code"|"research"|"automation", "rootPath": "/data/repos" }`
  развёртывает структуру каталогов внутри корня workspace и
  регистрирует проект (см. [API reference](api-reference.md#create-project)
  для полного контракта). Дашборд предлагает тот же поток через диалог создания проекта.
- **Ручное переопределение:** когда определение неверно классифицирует проект,
  `PUT /api/projects?path= { "type": ... }` исправляет записи в реестре
  (дашборд: редактор типа для каждого проекта в переключателе).
- **Системные промпты по типу (F-3.6, standalone):**
  `packages/coding-agent/src/workspace/prompt-loader.ts` резолвит базовый
  промпт по типу, с `<cwd>/.fan/prompts/system.md` как полным переопределением
  и подстановкой переменных `{workspace_path}` / `{project_name}`.
  Модуль пока НЕ интегрирован в runtime — интеграция в
  `AgentSession._rebuildSystemPrompt()` — это задокументированная будущая фаза.
- Шаблон `code` намеренно не выполняет `git init` — без
  `.git` детектор вернёт `unknown`, поэтому имя шаблона используется
  как fallback объявленного типа. Выполните `git init` внутри нового проекта,
  когда будете готовы.

### 8.4 Автономные задачи — сервис fan-scheduler (Phase 4)

`docker-compose.yml` включает второй сервис, **`fan-scheduler`** —
автономный cron-based раннер задач (`tools/fan-scheduler`, тот же образ, что и
`fan`, команда `bun tools/fan-scheduler/dist/scheduler.js
/data/scheduler/config.yaml`). Он читает YAML-конфиг задач, ставит задачи
в очередь по cron-триггерам и выполняет их через gateway API (одна задача за раз,
FIFO). Полное руководство: [scheduler.md](scheduler.md).

- **`FAN_SCHEDULER_TOKEN` (обязателен для выполнения задач).** Планировщик
  аутентифицируется перед шлюзом обычным ClientToken. Создайте его через
  token bootstrap (раздел 7.2) и поместите в `.env`:
  `FAN_SCHEDULER_TOKEN=<64-hex>`. Без него сервис всё равно запускается
  (control/health сервер работают), но каждая задача падает с
  `"FAN API token is not configured"`.
- **Конфиг задач** — артефакт оператора, монтируется только для чтения:
  `./deploy/scheduler/config.yaml → /data/scheduler/config.yaml` (переопределите
  источник монтирования через `FAN_SCHEDULER_CONFIG` в `.env`). Пути `workspace` —
  это **пути контейнера** внутри `/data/repos` (volume `fan-repos`).
  Планировщик перечитывает файл при изменении (mtime watcher) — редактируйте
  на хосте, перезапуск не нужен.
- **Сеть:** планировщик обращается к шлюзу через внутреннюю
  compose-сеть (`FAN_API_URL=http://fan:3456`); его control-сервер
  (порт 3457) привязан к `0.0.0.0` внутри сети, чтобы шлюз мог
  проксировать `GET /api/scheduler/health` (`FAN_SCHEDULER_URL=http://fan-scheduler:3457`
  на сервисе `fan`). **Порт 3457 никогда не публикуется на хост.**
- **Персистентность:** очередь pending (`scheduler-pending.json`, F-4.13)
  находится в общем volume `fan-data` — ожидающие задачи переживают
  пересоздание контейнера.
- **`GITHUB_TOKEN` (опционально):** PAT выделенного bot-аккаунта для
  автономных git/PR-действий (ветки `fan-auto/*`, `gh pr create`). Задаётся в
  `.env`; когда не установлен, git/PR-действия помечаются недоступными
  (`gitEnabled=false`) и планировщик продолжает работу. Рекомендуется:
  branch protection на `main`/`master` в GitHub (см. scheduler.md).
- **Health:** `curl http://127.0.0.1:3456/api/scheduler/health` →
  `{"status":"ok","running":false,"pendingCount":0,...}`; `503
  scheduler:"down"` когда контейнер планировщика недоступен.

```bash
docker compose up -d --build        # запускает fan + fan-scheduler
docker compose logs -f fan-scheduler  # структурированные логи JSONL
docker compose ps                    # оба сервиса (healthy)
```

#### Cron бэкапа БД (F-4.15)

Ежедневный бэкап SQLite через `deploy/scripts/backup-db.sh` + системный cron на
VPS (хранит последние 7 копий, `chmod 600` на каждую копию / `chmod 700` на
каталог бэкапов; использует `sqlite3 .backup` когда доступен — безопасно для живой БД):

```cron
# FAN DB backup — daily at 03:00 (F-4.15)
0 3 * * * /opt/fan-agent/deploy/scripts/backup-db.sh >> /var/log/fan-backup.log 2>&1
```

Бэкапы записываются в `$FAN_AGENT_DIR/backups/` (в Docker: внутри volume
`fan-data`). См. [scheduler.md — DB Backup](scheduler.md) для env-переменных
(`DB_PATH`, `BACKUP_DIR`, `KEEP`), варианта с docker exec и
заметок о шифровании off-site.

### 8.5 Конкурентность — персистентная очередь и токены по проекту (Phase 5)

- **Персистентная очередь сообщений (F-5.5/F-5.6).** В серверном режиме
  очередь WS-диспетчера персистентна по умолчанию: сообщения клиента в очереди
  хранятся как JSONL-файлы в `/data/.fan/agent/queues` (внутри **volume `fan-data`**,
  поскольку compose устанавливает `FAN_CODING_AGENT_DIR=/data/.fan/agent`) и
  переживают перезапуск/пересоздание контейнера. При запуске сервер восстанавливает
  ожидающие очереди и уведомляет WS-клиентов (фрейм `queues_restored`).
  Доставка at-least-once (крах во время диспетчеризации может повторно доставить сообщение).
  E2E-очистка стирает каталог очереди для идемпотентности — делайте то же самое
  после упавшего развёртывания, если накапливаются устаревшие записи:
  `docker exec fan-agent rm -rf /data/.fan/agent/queues`.
- **Токены по проекту (F-5.7).** Для мультитенантных конфигураций можно выпускать
  токены, ограниченные одним проектом:
  `POST /api/tokens { "name": "...", "projectScope": "/data/repos/<project>" }`.
  Токен с ограниченной областью может обращаться только к своему проекту
  (сессии, бюджет), управлять только своими токенами, и получает `403`
  на глобальных мутациях (настройки моделей, бюджет провайдера, изменения реестра проектов).
  Существующие токены остаются с полным доступом. Подробности: [api-reference.md — Project Scope](api-reference.md#project-scope-f-57).
- **Никакого `process.chdir()` в runtime (F-5.4):** параллельные сессии
  разных проектов полностью изолированы по cwd; `/proc/1/cwd` контейнера
  никогда не меняется (проверено в E2E раздел 13).

## 9. Откат

Уровень nginx (снимает agent.sea-agents.ru с линии, FAN Store не затрагивается):

```bash
rm /etc/nginx/sites-enabled/agent.sea-agents.ru.conf
nginx -t && systemctl reload nginx
```

Уровень контейнера:

```bash
cd /opt/fan-agent
docker compose down            # volumes сохраняются; добавьте -v для удаления данных
```

Полный откат = оба шага. Сертификаты и `/etc/letsencrypt` не нужно
удалять — они просто станут неиспользуемыми.

## 10. Заметки по безопасности

- **Единый слой авторизации:** FAN ClientToken (Bearer token / `?token=` для WS),
  обеспечивается `FAN_PUBLIC=1` в `docker-compose.yml`. HTTP Basic Auth на уровне
  nginx рассматривался и **отклонён** для v2; закомментированные
  строки `auth_basic` в конфиге nginx документируют, как добавить его, если
  решение когда-либо будет пересмотрено.
- **CORS** ограничен `https://agent.sea-agents.ru` через
  `ALLOWED_ORIGINS` (F-0.4).
- API-шлюз никогда не привязывается к публичному интерфейсу — только `127.0.0.1:3456`.
- **Токены в query-string в логах:** логгер приложения очищает значение
  любого параметра `?token=` / `&token=` до того, как он попадёт в
  `/data/logs/app.log` или `docker logs`. Однако `access_log` nginx
  по умолчанию записывает полный URI запроса. На VPS избегайте утечки токенов
  в логи nginx, используя `log_format`, который опускает query string
  (например, логируйте `$uri` вместо `$request_uri`) или регулярно
  ротируйте/очищайте access-логи.
- **Workspace whitelist (F-1.13):** `cwd` сессии ограничен
  `FAN_WORKSPACE_ROOT` (`/data/repos`). Попытки вне whitelist и symlink-escape
  возвращают 403 и записываются в аудит-лог — следите за
  записями `cwd rejected by workspace whitelist` в `/data/logs/app.log`.
