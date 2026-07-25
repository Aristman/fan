# Roadmap: Фаза 0 — Сетевой контур (TLS / auth / Docker / nginx)

> **Дата создания:** 2026-07-25
> **Источник:** [spec_fan-network-agent_phase0-network-contour_2026-07-25.md](../../specs/spec_fan-network-agent_phase0-network-contour_2026-07-25.md) · [родительская spec](../../specs/spec_fan-network-agent_2026-07-25.md)
> **Фич:** 11 | **Этапов:** 4 | **E2E-сценариев:** 1

---

## Сводная таблица по приоритетам

| Приоритет | Кол-во фич | Описание |
|-----------|-----------|----------|
| P0 (Must) | 8 | Порт/хост env, FAN_PUBLIC, Dockerfile, compose, CORS, nginx, certbot, E2E smoke |
| P1 (Should) | 2 | Health endpoint, logging to volume |
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
| P0 | Must Have | Критично для публичного деплоя |
| P1 | Should Have | Желательно до публичного запуска |
| P2 | Could Have | Можно отложить |
| P3 | Won't Have | Отклонено для текущей фазы |

### Слои реализации

| Слой | Описание |
|------|----------|
| [API] | Изменения HTTP/WebSocket API (gateway, main.ts) |
| [INFRA] | Контейнеризация, nginx, certbot, VPS-инфраструктура |
| [CLI] | Команды CLI и переменные окружения |
| [BIZ] | Бизнес-логика: блокировка auth, whitelist-контроль |
| [E2E] | Комплексные сквозные сценарии |

---

## Этап 0.1 — Ядро сервера: env vars и публичный режим

**Цель SMART:** До конца этапа сервер читает `PORT`/`HOST` из env, а флаг `FAN_PUBLIC=1` надёжно блокирует автоотключение аутентификации. Локальный TUI/server работает без изменений (обратная совместимость).

### Фичи

#### ☐ F-0.1: Чтение PORT из переменной окружения

- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** Сервер считывает `process.env.PORT` как fallback для `--port` (default 3456). Env var имеет приоритет над CLI-дефолтом, но CLI-флаг перебивает всё.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.1-1:** Порт из env перебивает дефолт
    - *Условие:* `PORT=9999`, без `--port` CLI-флага
    - *Шаги:* Запустить `fan server`; проверить значение порта в логировании подключения
    - *Ожидаемый результат:* Порт = 9999; `parseInt(process.env.PORT ?? cli.port ?? '3456', 10)` возвращает 9999
  - [ ] **TC-F-0.1-2:** CLI-флаг перебивает env
    - *Условие:* `PORT=9999` + `--port 7777`
    - *Шаги:* Запустить; проверить порт в логе
    - *Ожидаемый результат:* Порт = 7777 (CLI wins over env)
- **Критерии приёмки:**
  1. `PORT` из env успешно парсится и применяется при старте сервера
  2. Отсутствие `PORT` → fallback на дефолт 3456
  3. CLI-флаг `--port` имеет наивысший приоритет
- **Ожидаемый результат:** Изменённый файл `packages/coding-agent/src/main.ts` (~line 1138+); unit-тест в новом тестовом файле
- **Оценка объёма:** S

#### ☐ F-0.2: Чтение HOST из переменной окружения

- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** Сервер считывает `process.env.HOST` как fallback для `--host` (default localhost). Аналогичный приоритетный механизм как PORT.
- **Зависимости:** F-0.1
- **TDD-тесты:**
  - [ ] **TC-F-0.2-1:** HOST из env перебивает default
    - *Условие:* `HOST=0.0.0.0`
    - *Шаги:* Запустить `fan server`; проверить bind address
    - *Ожидаемый результат:* Сервер привязан к 0.0.0.0
  - [ ] **TC-F-0.2-2:** Non-numeric host string treated correctly
    - *Условие:* `HOST=localhost.localdomain`
    - *Шаги:* Запустить; убедиться что строка передана без изменений
    - *Ожидаемый результат:* Host = «localhost.localdomain»
- **Критерии приёмки:**
  1. `HOST` читается из env; fallback на `localhost`
  2. Любой non-empty string принимается как хост-адрес
  3. Обратная совместимость: без `HOST` → `localhost`
- **Ожидаемый результат:** Дополнение `main.ts`; аналогичный паттерн F-0.1
- **Оценка объёма:** S

#### ☐ F-0.3: Режим публичного сервера FAN_PUBLIC

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Добавить проверку `FAN_PUBLIC=1`. Если установлен — автоматическое выставление `FAN_NO_AUTH=1` (строки 1138–1143 аудита) НЕ происходит. `FAN_NO_AUTH` игнорируется. Два значения: `FAN_PUBLIC` не установлен → прежнее поведение; `FAN_PUBLIC=1` → auth обязательна.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.3-1:** FAN_PUBLIC=1 блокирует auto-disable auth
    - *Условие:* `FAN_PUBLIC=1`, `FAN_NO_AUTH=1`
    - *Шаги:* Запустить server mode; попытка запроса без токена
    - *Ожидаемый результат:* Запрос отвергается с 401 Unauthorized; `FAN_NO_AUTH` проигнорирован
  - [ ] **TC-F-0.3-2:** Без FAN_PUBLIC — обратная совместимость
    - *Условие:* Без `FAN_PUBLIC`, server mode
    - *Шаги:* Запустить; запрос без токена
    - *Ожидаемый результат:* Auth отключён (как сейчас); `FAN_NO_AUTH=1` выставлен автоматически
  - [ ] **TC-F-0.3-3:** FAN_PUBLIC=1 без FAN_NO_AUTH
    - *Условие:* Только `FAN_PUBLIC=1`
    - *Шаги:* Запустить; запрос без токена → должен потребоваться токен
    - *Ожидаемый результат:* Auth включена; токен обязателен
- **Критерии приёмки:**
  1. Условное ветвление по `process.env.FAN_PUBLIC === '1'` заменяет безусловное выставление `FAN_NO_AUTH`
  2. При `FAN_PUBLIC=1` система токенов остаётся активна
  3. Без `FAN_PUBLIC` — прежнее поведение локального server mode не нарушено
- **Ожидаемый результат:** Патч `main.ts`: замена строки автовыставления `FAN_NO_AUTH=1` на условную проверку
- **Оценка объёма:** S

#### ☐ F-0.4: Безопасность CORS — ALLOWED_ORIGINS

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Заменить открытую конфигурацию CORS (`origin: "*"`, line 131 audit) на перечислимый список из env var `ALLOWED_ORIGINS`, разделённого запятыми. Default — `['*']` для локального режима (обратная совместимость). В production docker-compose — только `https://agent.sea-agents.ru`.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.4-1:** Разрешённый origin проходит
    - *Условие:* `ALLOWED_ORIGINS=https://agent.sea-agents.ru`; запрос с `Origin: https://agent.sea-agents.ru`
    - *Шаги:* GET /api/sessions; проверить заголовок ответа
    - *Ожидаемый результат:* `Access-Control-Allow-Origin: https://agent.sea-agents.ru`; 200 OK
  - [ ] **TC-F-0.4-2:** Запрещённый origin заблокирован
    - *Условие:* `ALLOWED_ORIGINS=https://agent.sea-agents.ru`; запрос с `Origin: https://evil.com`
    - *Шаги:* GET /api/sessions
    - *Ожидаемый результат:* `Access-Control-Allow-Origin` отсутствует или пустой; браузер блокирует ответ
  - [ ] **TC-F-0.4-3:** Default '*' работает для локального режима
    - *Условие:* Без `ALLOWED_ORIGINS`
    - *Шаги:* Любой Origin; проверить CORS-заголовки
    - *Ожидаемый результат:* `Access-Control-Allow-Origin: *`; полная открытость
- **Критерии приёмки:**
  1. CORS конфиг читает `ALLOWED_ORIGINS` из env, парсит через `split(',')`
  2. Проверка Origin производится через includes/array lookup
  3. Default `['*']` сохраняет поведение для локального dev
- **Ожидаемый результат:** Изменённый `packages/api-gateway/src/http-server.ts` (~line 131)
- **Оценка объёма:** S

---

## Этап 0.2 — Контейнеризация: Dockerfile + docker-compose

**Цель SMART:** Создать мультистейдж Dockerfile и docker-compose.yml, которые собирают проект внутри контейнера и раздают только `dist/` в slim-образе. Volume для данных (`fan-data`) обеспечивает персистентность БД Prisma и JSONL-сессий. Сборка локальна — `docker build` проходит без ошибок.

### Фичи

#### ☐ F-0.5: Мультистейдж Dockerfile

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** `Dockerfile` (в корне репо) с двумя стадиями: builder (bun:1, полный сборка проекта) и runtime (bun:1-slim, только dist + node_modules). EXPOSE 3456. ENV FAN_DATA_DIR=/data/.fan/. CMD: `bun dist/index.js server`.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.5-1:** Сборка образует рабочую среду
    - *Условие:* Корень репо, Dockerfile присутствует
    - *Шаги:* `docker build -t fan-test .`
    - *Ожидаемый результат:* Exit code 0; образ создан; размер slim-стадии <500MB
  - [ ] **TC-F-0.5-2:** Container запускается в server mode
    - *Условие:* Образ fan-test собран
    - *Шаги:* `docker run --rm fan-test bun dist/index.js server`; ждать 3s
    - *Ожидаемый результат:* Процесс не падает; в логах сообщение о старте API gateway на порту 3456
- **Критерии приёмки:**
  1. Две стадии: builder + slim runtime
  2. COPY только необходимых файлов в финальный образ
  3. CMD = запуск server-режима через bun
- **Ожидаемый результат:** Новый файл `Dockerfile` в корне репозитория
- **Оценка объёма:** S

#### ☐ F-0.6: docker-compose.yml для продакшена

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** `docker-compose.yml` с сервисом `fan`: build из `.`, bind port к 127.0.0.1:3456 (только для nginx), volumes (fan-data + repos), environment (PORT, FAN_PUBLIC, ALLOWED_ORIGINS). `restart: unless-stopped`. Именованный volume `fan-data` для SQLite + JSONL.
- **Зависимости:** F-0.5
- **TDD-тесты:**
  - [ ] **TC-F-0.6-1:** compose поднимает контейнер
    - *Условие:* Dockerfile + docker-compose.yml в репо, docker + docker-compose доступны
    - *Шаги:* `docker-compose up -d --build`; ждать 10s
    - *Ожидаемый результат:* Статус сервиса `running`; `docker ps` показывает fan-agent на 127.0.0.1:3456
  - [ ] **TC-F-0.6-2:** Данные сохраняются при перезапуске
    - *Условие:* Контейнер работает, создана хотя бы одна сессия
    - *Шаги:* `docker-compose down` → `docker-compose up -d`; проверить наличие БД
    - *Ожидаемый результат:* `/data/.fan/agent/fan.db` существует после рестарта; сессии intact
  - [ ] **TC-F-0.6-3:** Порт привязан только к loopback
    - *Условие:* Контейнер запущен
    - *Шаги:* `netstat -tlnp | grep 3456` (внутри контейнера / на хосте)
    - *Ожидаемый результат:* Привязка к 127.0.0.1:3456; нет доступа извне напрямую
- **Критерии приёмки:**
  1. `ports: "127.0.0.1:3456:3456"` — loopback bind
  2. Volume `fan-data` монтируется в `/data/.fan/agent`
  3. Environment переменные заданы корректно
- **Ожидаемый результат:** Новый файл `docker-compose.yml` в корне репозитория
- **Оценка объёма:** S

---

## Этап 0.3 — Инфраструктура: nginx + TLS + deploy

**Цель SMART:** Настроенный nginx-конфиг (server block для agent.sea-agents.ru), certbot SSL-сертификат и документация по деплою. Все компоненты готовы к копированию на VPS 185.219.41.46. Smoke-тест подтверждает: health endpoint доступен по HTTPS, WebSocket подключается, POST /api/sessions работает.

### Фичи

#### ☐ F-0.7: Nginx конфиг с WebSocket поддержкой

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Server block в nginx конфиге (VPS 185.219.41.46): listen 443 ssl http2, proxy_pass на 127.0.0.1:3456, WebSocket upgrade headers (map directive), proxy headers (Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto), таймауты 86400s. Существующий блок `fan.sea-agents.ru` не затрагивается.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.7-1:** curl health endpoint через HTTPS
    - *Условие:* Nginx конфиг загружен, сертификат установлен
    - *Шаги:* `curl -k https://agent.sea-agents.ru/api/health`
    - *Ожидаемый результат:* HTTP 200; JSON body содержит `"status": "ok"` или аналогичный статус
  - [ ] **TC-F-0.7-2:** WebSocket upgrade проходит
    - *Условие:* Nginx настроен, websocket handler активен
    - *Шаги:* `wscat -c wss://agent.sea-agents.ru/ws` (или аналог); отправить message frame
    - *Ожидаемый результат:* Подключение установлено (код 101 Switching Protocols); pong возвращается
- **Критерии приёмки:**
  1. Map `$http_upgrade $connection_upgrade` для WS поддержки
  2. proxy_set_header Upgrade/connection присутствуют
  3. Proxy_read_timeout = 86400s (long-poll WS keepalive)
- **Ожидаемый результат:** Файл nginx конфига (например `/etc/nginx/sites-available/agent.sea-agents.ru.conf`) + docs/guides/deployment.md
- **Оценка объёма:** S

#### ☐ F-0.8: Certbot SSL сертификаты

- **Приоритет:** P0
- **Слой:** [INFRA]
- **Описание:** Получить SSL-сертификат через `certbot certonly --nginx -d agent.sea-agents.ru`. Настроить автоматическое обновление (systemd timer certbot уже настроен на VPS для fan.sea-agents.ru — проверить/дублировать). Документация шагов в руководстве по деплою.
- **Зависимости:** F-0.7 (dns запись + nginx конфиг должны существовать)
- **TDD-тесты:**
  - [ ] **TC-F-0.8-1:** Сертификат получен и валиден
    - *Условие:* DNS A-запись агент.sea-agents.ru → 185.219.41.46
    - *Шаги:* `certbot certonly --nginx -d agent.sea-agents.ru`; `openssl x509 -in /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem -noout -dates`
    - *Ожидаемый результат:* Exit code 0; expires > 0 дней (90-дневный LE сертификат)
  - [ ] **TC-F-0.8-2:** Автоматический ренов работает
    - *Условие:* Сертификат получен; systemd timer active
    - *Шаги:* `systemctl status certbot.timer`; `certbot renew --dry-run`
    - *Ожидаемый результат:* Timer active; dry-run exit 0
- **Критерии приёмки:**
  1. Сертификат лежит в `/etc/letsencrypt/live/agent.sea-agents.ru/`
  2. nginx config ссылается на корректные пути к сертификатам
  3. Certbot renew configured и working
- **Ожидаемый результат:** Сертификаты на VPS + проверка в деплой-документации
- **Оценка объёма:** S

#### ⏳ F-0.9: Health endpoint для мониторинга

- **Приоритет:** P1
- **Слой:** [API]
- **Описание:** Эндпоинт `GET /api/health` — быстрая проверка здоровья сервиса. Возвращает `{ status: "ok", uptime: <ms>, version: "<semver>" }`. Используется для readiness/liveness probes в docker-compose healthcheck и внешних мониторинг систем.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.9-1:** Health returns ok
    - *Условие:* Сервер запущен
    - *Шаги:* `curl http://localhost:3456/api/health`
    - *Ожидаемый результат:* HTTP 200; body содержит `{ "status": "ok", ... }`
- **Критерии приёмки:**
  1. Endpoint добавлен в api-gateway router
  2. Возвращает статус + uptime без блокирующих операций
  3. Работает с аутентификацией и без
- **Ожидаемый результат:** Новый route в `packages/api-gateway/src/http-server.ts`
- **Оценка объёма:** S

#### ⏳ F-0.10: Логирование в volume

- **Приоритет:** P1
- **Слой:** [INFRA]
- **Описание:** Перенаправление stdout/stderr логов в mountable volume (`logs:` в docker-compose, путь `/app/logs/`). Loglevel configurable через `LOG_LEVEL` env. Это позволяет видеть логи через `docker logs` и собирать их внешними системами.
- **Зависимости:** F-0.6 (docker-compose с volumes)
- **TDD-тесты:**
  - [ ] **TC-F-0.10-1:** Логи появляются в volume
    - *Условие:* Контейнер запущен с LOG_LEVEL debug
    - *Шаги:* Выполнить операцию (e.g. создать сессию); проверить `/data/logs/app.log`
    - *Ожидаемый результат:* Файл существует; содержит log entry с timestamp
- **Критерии приёмки:**
  1. stdout/stderr redirect в файл на mounted volume
  2. LOG_LEVEL env управляет verbosity
  3. Logs не растут бесконечно (rotation, e.g. max size)
- **Ожидаемый результат:** Обновлённый docker-compose.yml + логгер-модуль
- **Оценка объёма:** M

---

## E2E-сценарии фазы 0

#### ☐ F-0.11-E2E: Полная цепочка деплоя с нуля

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Сквозной сценарий деплоя с чистого VPS до работающего агента. Проверяет все компоненты фазы 0 целиком. Выполнимо скриптом или вручную.
- **Зависимости:** F-0.1..F-0.8
- **TDD-тесты:**
  - [ ] **TC-F-0.11-E2E-1:** End-to-end deploy pipeline
    - *Условие:* Чистый VPS (185.219.41.46), домен зарегистрирован, Docker installed
    - *Шаги:*
      1. Скопировать Dockerfile + docker-compose.yml на VPS
      2. Создать DNS A-запись: `agent.sea-agents.ru → 185.219.41.46`
      3. `certbot certonly --nginx -d agent.sea-agents.ru`
      4. Добавить nginx server block, `nginx -t && nginx -s reload`
      5. `docker-compose up -d --build`
      6. Ждать 30s; проверить `docker ps`
    - *Ожидаемый результат:* Контейнер running, nginx слушает 443, Docker image построен
  - [ ] **TC-F-0.11-E2E-2:** Post-deploy verification
    - *Условие:* Деплой завершён, контейнер запущен
    - *Шаги:*
      1. `curl -sk https://agent.sea-agents.ru/api/health` → должен вернуть 200 OK
      2. WebSocket подключение: `wscat -c wss://agent.sea-agents.ru/ws` → connected
      3. CLI: `fan token create` → токен создан
      4. `curl -sk -X POST https://agent.sea-agents.ru/api/sessions -H "Authorization: Bearer <token>" -d '{}'` → 201 Created
      5. `curl -sk https://agent.sea-agents.ru/api/sessions -H "Authorization: Bearer <token>"` → 200 OK, содержит созданную сессию
    - *Ожидаемый результат:* Все 5 проверок проходят; сессия создана и получена обратно через HTTPS
  - [ ] **TC-F-0.11-E2E-3:** FAN_PUBLIC blocks unauthenticated access
    - *Условие:* FAN_PUBLIC=1, FAN_NO_AUTH=1
    - *Шаги:* `curl -sk https://agent.sea-agents.ru/api/sessions` (без токена)
    - *Ожидаемый результат:* HTTP 401 Unauthorized; `FAN_NO_AUTH` проигнорирован
- **Критерии приёмки:**
  1. Весь стек: Docker → nginx → TLS → API → auth — работает как единое целое
  2. HTTPS подключается, WebSocket работает, сессии создаются
  3. Auth не отключается при FAN_PUBLIC=1
- **Ожидаемый результат:** Ручной или автоматический test script; результаты фиксируются в CI/CD pipeline
- **Оценка объёма:** M

---

## Граф зависимостей

```
F-0.1 (PORT env)          F-0.3 (FAN_PUBLIC)         F-0.4 (CORS)
      │                         │                          │
      ▼                         ▼                          ▼
   [Готово]                   [Готово]                   [Готово]

F-0.5 (Dockerfile)          F-0.6 (docker-compose)      F-0.2 (HOST env)
      │                         ▲                          │
      │                        ║                           │
      └─────────┬───────────────┘                           │
                ▼                                           │
              [Готово]                                      ▼
                                                        [Готово]

F-0.7 (nginx)                    F-0.8 (certbot)
      │                               │
      └───────→ F-0.11-E2E (deploy) ←┘
                      │
                 F-0.9 (health)     F-0.10 (logging)
                    │                   │
                    ▼                   ▼
              [Optional]            [Optional]
```

**Проверка циклов:** Циклов нет. Все зависимости направленные (DAG).

---

## Полный чеклист по приоритетам

### P0 (Must Have) — 8 фич

- [ ] ☐ F-0.1 Чтение PORT из env
- [ ] ☐ F-0.2 Чтение HOST из env
- [ ] ☐ F-0.3 Режим FAN_PUBLIC — блокировка auth
- [ ] ☐ F-0.4 CORS — ALLOWED_ORIGINS
- [ ] ☐ F-0.5 Dockerfile (мультистейдж)
- [ ] ☐ F-0.6 docker-compose.yml
- [ ] ☐ F-0.7 Nginx конфиг + WebSocket
- [ ] ☐ F-0.11-E2E Полная цепочка деплоя с нуля

### P1 (Should Have) — 2 фич

- [ ] ⏳ F-0.9 Health endpoint
- [ ] ⏳ F-0.10 Логирование в volume

---

## Итоговая оценка

| Мера | Значение |
|------|---------|
| Всего фич | 11 (10 реализаций + 1 E2E) |
| P0 фич | 8 |
| P1 фич | 2 |
| Этапов | 4 (ядро, контейнеризация, инфраструктура, E2E) |
| Оценка P0 | ~2.5 дня (ядро: 3h + контейнеры: 8h + infra: 6h + E2E: 4h) |
| Оценка полная | ~5 дней (с учётом P1) |
| Путь к публикации | P0-complete → staging → smoke tests → production |

---

*Сгенерировано: docs-impl agent · 2026-07-25*
*На основе: spec_fan-network-agent_phase0-network-contour_v1.0*
