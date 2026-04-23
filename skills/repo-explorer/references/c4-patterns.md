# C4 Patterns — Определение сущностей по коду

Справочник для Фазы 6B repo-explorer. Как по файлам, зависимостям и конфигам определить,
что рисовать на C4-диаграммах.

---

## Базы данных

Определи по драйверам в dependencies и импортам:

| Признак | Технология | C4-тип |
|---------|-----------|--------|
| `pg`, `postgres`, `node-postgres` | PostgreSQL | `[(PostgreSQL)]` |
| `mysql`, `mysql2`, `mariadb` | MySQL/MariaDB | `[(MySQL)]` |
| `mongodb`, `mongoose`, `motor` | MongoDB | `[(MongoDB)]` |
| `sqlite3`, `better-sqlite3`, `rusqlite` | SQLite | `[(SQLite)]` |
| `prisma` | ORM (см. schema.prisma на provider) | по провайдеру |
| `typeorm`, `sequelize`, `knex` | ORM | по connection string |
| `diesel`, `sqlx` | Rust DB | по DATABASE_URL |
| `sqlalchemy`, `asyncpg`, `aiosqlite` | Python DB | по connection string |
| `redis`, `ioredis`, `bull`, `bullmq` | Redis | `[(Redis)]` |
| `@elastic/elasticsearch` | Elasticsearch | `[(Elasticsearch)]` |

**Где искать:** `dependencies` в манифесте, `DATABASE_URL` в `.env`, `connection` в конфигах,
импорты драйверов в `src/`.

---

## Брокеры сообщений и очереди

| Признак | Технология | C4-тип |
|---------|-----------|--------|
| `kafka-node`, `kafkajs`, `rdkafka` | Kafka | `[(Kafka)]` |
| `amqplib`, `bullmq` | RabbitMQ | `[(RabbitMQ)]` |
| `nats`, `nats.ws` | NATS | `[(NATS)]` |
| `bull`, `bullmq` | Redis Queue | `[(Redis Queue)]` |
| `celery` (Python) | по broker URL | по брокеру |

---

## HTTP-клиенты (внешние API)

| Признак | Что значит | C4-тип |
|---------|-----------|--------|
| `axios`, `got`, `node-fetch`, `undici`, `reqwest`, `hyper` | HTTP calls | `[External API]` |
| `@grpc/grpc-js`, `tonic`, `grpc` | gRPC calls | `[gRPC Service]` |
| `socket.io-client`, `ws` | WebSocket | `[WebSocket Service]` |

**Как найти:** Ищи в imports и usage — `axios.get/post`, `fetch(`, `client.call`.
Проверь конфиги на base URLs, API keys, endpoints.

---

## Хранилища файлов

| Признак | Технология | C4-тип |
|---------|-----------|--------|
| `aws-sdk`, `@aws-sdk/client-s3` | S3 | `[AWS S3]` |
| `@google-cloud/storage` | GCS | `[Google Cloud Storage]` |
| `multer-s3`, `sharp` (с s3) | S3 | `[AWS S3]` |
| `minio` | MinIO | `[MinIO]` |

---

## Аутентификация / Авторизация

| Признак | Технология | C4-тип |
|---------|-----------|--------|
| `jsonwebtoken`, `jose`, `jwt` | JWT | `[Auth Provider]` |
| `passport`, `next-auth`, `auth0` | OAuth/OIDC | `[Identity Provider]` |
| `bcrypt`, `argon2` | Password hashing | часть контейнера |
| `@google-cloud/firestore`, `firebase-admin` | Firebase Auth | `[Firebase]` |

---

## Определение контейнеров (Level 2)

### По директориям

```
packages/     → Monorepo: каждый subfolder — контейнер
apps/         → Monorepo apps: каждый subfolder — контейнер
src/web/      → Web UI контейнер
src/api/      → API контейнер
src/cli/      → CLI контейнер
src/worker/   → Background worker контейнер
server/       → Backend контейнер
client/       → Frontend контейнер
mobile/       → Mobile app контейнер
```

### По фреймворкам

| Фреймворк | Тип контейнера |
|-----------|---------------|
| react, vue, angular, svelte | Web UI |
| next, nuxt, remix | Full-stack Web (SSR + API) |
| express, fastify, koa, hono | API Server |
| django, flask, fastapi, spring-boot | API Server |
| actix, axum, rocket, warp | API Server |
| electron, tauri | Desktop App |
| react-native, flutter | Mobile App |
| nestjs | API Server (modular) |

### По docker-compose

Если есть `docker-compose.yml` — каждый service это контейнер:
```yaml
services:
  web:    → [Web Server]
  api:    → [API Server]
  db:     → [(PostgreSQL)]
  redis:  → [(Redis)]
  worker: → [Background Worker]
```

### По Makefile / Procfile

```
web: npm start     → Web Server
api: uvicorn ...   → API Server
worker: celery ... → Background Worker
```

---

## Определение компонентов (Level 3)

### Паттерны по директории

| Директория | C4-компонент | Тип |
|-----------|-------------|-----|
| `routes/`, `controllers/`, `handlers/` | HTTP routing | `Router` |
| `services/`, `usecases/`, `domain/` | Business logic | `Service` |
| `repositories/`, `dao/`, `dal/` | Data access | `Repository` |
| `models/`, `entities/`, `schemas/`, `types/` | Data models | `Model` |
| `middleware/`, `interceptors/` | Cross-cutting | `Middleware` |
| `config/`, `settings/` | Configuration | `Config` |
| `utils/`, `helpers/`, `shared/` | Utilities | `Utility` |
| `validators/`, `parsers/` | Validation | `Validator` |
| `jobs/`, `tasks/`, `cron/` | Background tasks | `Job` |
| `events/`, `listeners/`, `subscribers/` | Event handling | `Event Handler` |
| `plugins/`, `extensions/` | Plugins | `Plugin` |
| `tests/`, `__tests__/`, `spec/` | Tests | не рисовать |

### Паттерны по naming convention

| Паттерн имени файла | Тип компонента |
|--------------------|---------------|
| `*Controller.ts`, `*Handler.ts` | Controller |
| `*Service.ts`, `*UseCase.ts`, `*Interactor.ts` | Service |
| `*Repository.ts`, `*Dao.ts` | Repository |
| `*Model.ts`, `*Entity.ts`, `*Schema.ts` | Model |
| `*Middleware.ts`, `*Guard.ts` | Middleware |
| `*Worker.ts`, `*Job.ts`, `*Task.ts` | Background Job |
| `*Adapter.ts`, `*Gateway.ts` | External Service Adapter |
| `*Config.ts`, `*Settings.ts` | Config |
| `index.ts`, `main.ts`, `app.ts` | Entry Point |

---

## Связи между компонентами

### Определи по import-ам (AST-анализ Фазы 5)

```
controllers/ → services/    (controller вызывает service)
services/    → repositories/ (service использует repository)
services/    → models/       (service работает с моделью)
repositories/ → models/      (repository возвращает модели)
middleware/  → controllers/  (middleware оборачивает controller)
config/      → *            (конфиг используется везде)
```

### Типы связей на диаграмме

| Отношение | Mermaid стрелка | Подпись |
|-----------|----------------|---------|
| import/uses | `-->` | (без подписи или «uses») |
| implements/interface | `-.->` | «implements» |
| extends/inherits | `==>` | «extends» |
| async/event | `-.->` | «publishes/subscribe» |

---

## Ограничения и правила

1. **Не рисуй то, чего нет.** Нет Redis в dependencies — не рисуй Redis.
2. **Агрегируй.** 15 файлов в `controllers/` → один бокс «controllers/».
3. **Лимит компонентов:** максимум 15 на диаграмму. Больше — разбей на суб-диаграммы.
4. **Не рисуй тесты** как компоненты. Они не часть runtime архитектуры.
5. **Config — рисуй только если он сложный** (много файлов, dynamic loading). Иначе — пропусти.
6. **Утилиты — рисуй только если они ключевые** (shared types, core utils). Пропустив `utils/formatDate`.
7. **Порядок уровней:** System Context → Container → Component. Не пропускай уровни без причины.
