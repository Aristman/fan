# Спецификация: Фаза 0 — Сетевой контур (TLS / auth / Docker / nginx)

## Метаданные
- **Дата**: 2026-07-25
- **Автор**: research-spec-generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича · Фаза 0 из пакета «FAN Network Agent»
- **Связь**: [Родительская спецификация](./spec_fan-network-agent_2026-07-25.md)

---

## 1. Обзор

### 1.1 Цель

Сделать FAN доступным из интернета безопасно. Фундаментальный слой: публичный режим сервера (auth не отключается), Docker-контейнеризация, nginx reverse proxy с TLS (Let's Encrypt), деплой на существующий VPS (185.219.41.46). Без этой фазы ничего не выносится наружу.

### 1.2 Контекст

Аудит server mode (`.fan/reports/explore-fan-server-vps-audit.md`) выявил критические пробелы для публичного доступа:
- 🔴 Нет TLS/HTTPS в коде вообще — обязателен reverse proxy
- 🔴 В server mode аутентификация принудительно отключается (`main.ts:1138-1143`): `FAN_NO_AUTH=1` выставляется автоматически
- 🟡 `PORT`/`HOST` не читаются из переменных окружения — только CLI-флаги (`--host`, `--port`)
- 🟢 Нет Dockerfile, compose, deployment guide

VPS уже содержит FAN Store на `fan.sea-agents.ru` с nginx + certbot. FAN runtime соседствует с FAN Store; предлагается поддомен `agent.sea-agents.ru` и порт 3456 (не конфликтует — FAN Store раздает статику).

### 1.3 Описание решения

Три группы изменений: патчи ядра FAN, контейнеризация, инфраструктура VPS.

---

## 2. Функциональные требования

### 2.1 Патч ядра: env vars PORT/HOST

**Файл:** `packages/coding-agent/src/main.ts`

Текущее поведение (line 1138-1143, по данным аудита): в server mode принудительно `FAN_NO_AUTH=1`, порт берётся из CLI-аргументов или дефолта 3456.

**Изменение:**
- Добавить чтение `process.env.PORT` как fallback для `--port` (default 3456)
- Добавить чтение `process.env.HOST` как fallback для `--host` (default localhost)
- Env vars имеют приоритет над CLI-дефолтами (но CLI-флаг перебивает всё)

```typescript
// Псевдокод изменения
const port = parseInt(process.env.PORT ?? cli.port ?? '3456', 10);
const host = process.env.HOST ?? cli.host ?? 'localhost';
```

### 2.2 Патч ядра: режим публичного сервера (FAN_PUBLIC)

**Файл:** `packages/coding-agent/src/main.ts`

**Проблема:** Line 1138-1143 аудита: автоматическое выставление `FAN_NO_AUTH=1` в server mode. Это делает опасным любой публичный деплой.

**Изменение:** Добавить проверку env `FAN_PUBLIC`:
```typescript
// Псевдокод изменения
if (mode === 'server' && process.env.FAN_PUBLIC !== '1') {
    process.env.FAN_NO_AUTH = '1'; // старый путь для локального server mode
}
// Если FAN_PUBLIC=1 — авто-отключение auth НЕ происходит
```

**Поведение:**
- `FAN_PUBLIC` не установлен → прежнее поведение (auto-disable auth в server mode) — обратная совместимость с локальным TUI
- `FAN_PUBLIC=1` → auth ОБЯЗАТЕЛЬНА; `FAN_NO_AUTH` игнорируется
- `FAN_PUBLIC=1` + `FAN_NO_AUTH=1` → приоритет у `FAN_PUBLIC=1`, auth включена (защищённый fallback)

### 2.3 Безопасность CORS

**Файл:** `packages/api-gateway/src/http-server.ts`

Аудит показал CORS: `origin: "*"` полностью открытый (line 131). Для публичного режима необходимо ограничить доменами:

```typescript
// Изменение
const corsConfig = {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['*'],
    credentials: true,
};
```

В docker-compose: `ALLOWED_ORIGINS=https://agent.sea-agents.ru`

### 2.4 Dockerfile

**Файл:** `Dockerfile` (в корне репозитория)

```dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock packages/ ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/packages/coding-agent/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./

EXPOSE 3456

ENV FAN_DATA_DIR=/data/.fan/agent

CMD ["bun", "dist/index.js", "server"]
```

Объёмы: `/data/.fan/agent` — БД Prisma (SQLite), JSONL-сессии, настройки.

### 2.5 docker-compose

**Файл:** `docker-compose.yml`

```yaml
services:
  fan:
    build: .
    container_name: fan-agent
    ports:
      - "127.0.0.1:3456:3456"  # Только для nginx прокси
    environment:
      - PORT=3456
      - FAN_PUBLIC=1
      - ALLOWED_ORIGINS=https://agent.sea-agents.ru
    volumes:
      - fan-data:/data/.fan/agent
      - ./repos:/data/repos  # Проекты (git clone'ed)
    restart: unless-stopped

volumes:
  fan-data:
```

### 2.6 Nginx конфигурация на VPS

**Файл:** nginx конфиг (существующая инсталляция nginx на 185.219.41.46)

```nginx
server {
    listen 443 ssl http2;
    server_name agent.sea-agents.ru;

    ssl_certificate     /etc/letsencrypt/live/agent.sea-agents.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agent.sea-agents.ru/privkey.pem;

    # WebSocket поддержка
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Таймауты для long-poll WebSocket
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Существующий блок `fan.sea-agents.ru` остается без изменений — статика FAN Store.

### 2.7 Certbot

```bash
sudo certbot certonly --nginx -d agent.sea-agents.ru
```

Автоматическое обновление через systemd timer certbot (уже настроен на VPS для fan.sea-agents.ru — проверить наличие).

---

## 3. Пользовательские сценарии

### Сценарий 1: Локальный запуск (без FAN_PUBLIC)

**Предусловия:** локальная машина, без переменных окружения
**Шаги:**
1. Запустить `fan server` без `FAN_PUBLIC`
2. Подключиться к `http://localhost:3456`
**Ожидаемый результат:** auth отключена, работа как прежде (локальный TUI/server)

### Сценарий 2: Деплой на VPS

**Предусловия:** VPS 185.219.41.46, docker-compose установлен, домен зарегистрирован
**Шаги:**
1. Скопировать Dockerfile + docker-compose на VPS
2. Создать DNS A-запись: `agent.sea-agents.ru` → 185.219.41.46
3. Получить SSL-сертификат через certbot
4. Добавить nginx конфиг
5. `docker-compose up -d`
6. Проверить подключение

**Ожидаемый результат:** FAN доступен по `https://agent.sea-agents.ru`, auth запрашивается, dashboard работает

### Сценарий 3: Подключение по WebSocket из Web UI

**Предусловия:** FAN запущен с FAN_PUBLIC=1, nginx настроен
**Шаги:**
1. Открыть `https://agent.sea-agents.ru`
2. Войти с токеном (CLI: `fan token create`)
3. Отправить сообщение через чат

**Ожидаемый результат:** WebSocket подключается, сообщения передаются, ответы приходят в реальном времени

---

## 4. Нефункциональные требования

### 4.1 Безопасность

| Требование | Реализация |
|------------|-----------|
| TLS обязательна | nginx + certbot, нет прямого доступа к порту 3456 извне |
| Auth обязательна | `FAN_PUBLIC=1` блокирует авто-отключение |
| Токены | Существующая система ClientToken (Prisma/SQLite) |
| CORS | Ограничен ALLOWED_ORIGINS env var |
| Прямой доступ к порту | Заблокирован (bind to 127.0.0.1 в docker-compose) |

### 4.2 Надёжность

- `restart: unless-stopped` в docker-compose
- Логирование в stdout/stderr контейнера (docker logs)
- PID-файлы daemon'а не нужны (управляется docker)

### 4.3 Производительность

- Nginx reverse proxy добавляет <1ms задержки на каждый запрос
- WebSocket keepalive: ping/pong каждые 30s (существующее поведение ws-handler.ts)

---

## 5. Технические требования

### 5.1 Стек

| Компонент | Технология |
|-----------|-----------|
| Runtime | Bun (oven/bun:1-slim) |
| Containerization | Docker + docker-compose |
| Reverse proxy | nginx (существующий на VPS) |
| TLS | Let's Encrypt (certbot) |
| Домен | agent.sea-agents.ru (A-запись на 185.219.41.46) |

### 5.2 Зависимости

- Существующая сборка `bun run build` должна проходить внутри контейнера (как сейчас — `npm run build` 10 пакетов, 0 ошибок)
- Все зависимости из `package.json` доступны в образе (COPY node_modules из стадии сборки)

---

## 6. Данные

### 6.1 Персистентные данные (volume `fan-data`)

| Путь в контейнере | Описание |
|-------------------|----------|
| `/data/.fan/agent/fan.db` | Prisma SQLite — модели, токены, настройки моделей, бюджет |
| `/data/.fan/agent/sessions/` | JSONL-сессии (по cwd) |
| `/data/.fan/agent/settings.json` | Глобальные настройки |
| `/data/.fan/agent/models.json` | Глобальные настройки моделей (hardcoded path) |

### 6.2 Проекты (volume `repos`)

| Путь в контейнере | Описание |
|-------------------|----------|
| `/data/repos/` | Клониемые репозитории и рабочие директории |

---

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Сертификат certbot истёк | Низкая | Среднее | Certbot renew — стандартный механизм, cron/job |
| Невалидный nginx конфиг сломает FAN Store | Низкая | Критичное | Тестировать конфиг `nginx -t` перед reload; отдельные server blocks |
| Порт 3456 занят другим сервисом | Низкая | Среднее | Проверяем: FAN Store — статика через nginx, порт свободен |
| Подключение к порту напрямую обходит nginx | Средняя | Критичное | Bind to 127.0.0.1 в docker-compose; iptables правило при необходимости |
| Потеря volume данных при пересборке | Низкая | Среднее | Volume привязан к именованному томy docker, бэкапы `~/.fan/agent` |

---

## 8. Компромиссы

### 8.1 Принятые решения

- **Nginx вместо встроенного TLS** — FAN не имеет HTTPS-кода. Используем существующий nginx на VPS. Плюс: стандартный стек, проверен для FAN Store. Минус: один дополнительный компонент инфраструктуры.
- **Bind to 127.0.0.1 вместо firewall** — контейнер не слушает внешние интерфейсы. Защита от обхода nginx через прямой IP-доступ.
- **Отдельный поддомен вместо пути** — `agent.sea-agents.ru` вместо `fan.sea-agents.ru/fan`. Чистота разделения, проще nginx конфиг.

### 8.2 Отклонённые альтернативы

- **Встроенный TLS в ядре FAN** — усложнение core, дублирование работы nginx. Отклонено: `docs/develop/tests/orchestrator-phase4.md` подтверждает что API gateway проектировался без TLS.
- **Cloudflare Tunnel** — выбор пользователя: свой домен + полный контроль.
- **Tailscale Funnel** — требует установки Tailscale, ограниченная аудитория.

---

## 9. Приоритеты

### Must Have
- ENV PORT/HOST readback
- FAN_PUBLIC режим (блокировка auto-disable auth)
- Dockerfile + docker-compose
- Nginx конфиг с WebSocket support
- Certbot SSL

### Should Have
- Health endpoint (/api/health)
- Logging to file (docker volume)
- Basic auth как второй слой

### Could Have
- Readiness/liveness probes для healthcheck
- Automatic backup cron job

### Won't Have
- Multi-user access control — один оператор, токены дают полный доступ
- Built-in TLS — решается nginx
- Systemd unit — управление через docker

---

## 10. Следующие шаги

- [ ] Реализовать патч `main.ts`: env PORT/HOST + FAN_PUBLIC
- [ ] Создать Dockerfile и docker-compose.yml
- [ ] Настроить DNS A-запись: agent.sea-agents.ru → 185.219.41.46
- [ ] Получить SSL-сертификат: certbot --nginx -d agent.sea-agents.ru
- [ ] Добавить nginx server block
- [ ] `docker-compose up -d`, smoke-тест
- [ ] Обновить документацию: docs/guides/deployment.md

---

*Создано: research-spec-generator skill · дата 2026-07-25*
*Фаза 0 из пакета «FAN Network Agent»*
*Спецификация ссылается на родительскую: [FAN Network Agent](./spec_fan-network-agent_2026-07-25.md)*
