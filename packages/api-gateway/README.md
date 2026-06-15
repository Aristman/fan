# @fan/api-gateway

> FAN API Gateway — HTTP/WebSocket server for client connections

## Описание

`@fan/api-gateway` — это HTTP/WebSocket сервер FAN, построенный на [Hono](https://hono.dev/). Он предоставляет REST API для всех клиентских подключений: TUI, Web Dashboard (Lit), IDE-плагинов и сторонних интеграций.

**Решаемая задача:** единая точка входа для UI-клиентов FAN. Вместо того чтобы каждому клиенту подключаться к runtime напрямую, все запросы проходят через API Gateway, который отвечает за аутентификацию, маршрутизацию, управление сессиями и проксирование WebSocket-событий.

**Где используется:** запускается командой `fan server` или `fan --web`. Интегрирован в CLI как серверный процесс. Dashboard обращается к нему через прокси Vite в dev-режиме и напрямую в production.

**Ключевые возможности:**
- REST эндпоинты: health, sessions, messages, models, budget, tokens
- Bearer token аутентификация через `tokenAuth` middleware
- WebSocket handler для стриминга событий сессий
- CORS, логирование, классификация ошибок (4xx/5xx)
- Опциональная раздача статики Dashboard'а (SPA fallback)
- Поддержка Bun native serve и Node.js (`@hono/node-server`)

## Архитектура / Как работает

Gateway состоит из трёх слоёв:

1. **HTTP сервер** (`http-server.ts`) — Hono-приложение с REST эндпоинтами. Использует `SessionAdapter` (интерфейс для session management) и `ModelManager` (для моделей, бюджета, настроек).
2. **Аутентификация** (`auth.ts`) — middleware `tokenAuth` проверяет Bearer token из `ClientToken` таблицы (Prisma/SQLite). Только `/api/health` открыт без токена.
3. **WebSocket** (`ws-handler.ts`) — подключается к тому же HTTP-серверу, форвардит события сессий через `sessionAdapter.subscribeToSession()`.

```
Client → REST/WS → API Gateway → SessionAdapter → FAN Runtime
                     │
                     ├── static dashboard (optional)
                     └── health endpoint (no auth)
```

## Использование

### Базовое использование

```ts
import { ModelManager } from "@fan/model-manager";
import { startServer } from "@fan/api-gateway";

const modelManager = new ModelManager();
const sessionAdapter = createSessionAdapter(); // ваша реализация

const { port, stop } = await startServer(modelManager, sessionAdapter, {
  port: 3456,
  host: "localhost",
  dashboardDir: "/path/to/dashboard/dist",
});

console.log(`Server running on http://localhost:${port}`);

// Остановка сервера
await stop();
```

### API

#### Экспорты из `src/index.ts`

| Экспорт | Тип | Описание |
|---------|-----|----------|
| `createApp` | `(ModelManager, SessionAdapter, ServerOptions?) => Promise<Hono>` | Создаёт Hono-приложение без запуска сервера |
| `startServer` | `(...) => Promise<{ port, stop }>` | Создаёт и запускает HTTP/WS сервер |
| `tokenAuth` | Middleware | Hono middleware для Bearer token аутентификации |
| `generateToken` | `(name: string) => Promise<ClientToken>` | Создаёт новый клиентский токен |
| `validateToken` | `(token: string) => Promise<ClientToken \| null>` | Проверяет токен |
| `isAuthDisabled` | `() => boolean` | Проверяет `FAN_NO_AUTH` env |
| `listTokens` | `() => Promise<ClientToken[]>` | Список всех токенов |
| `revokeToken` | `(id: string) => Promise<boolean>` | Удаляет токен |
| `attachWebSocketHandler` | `(WsHandlerOptions) => WebSocketServer` | Подключает WebSocket к HTTP-серверу |
| `ServerOptions` | Interface | `{ port, host, dashboardDir, version }` |
| `SessionAdapter` | Interface | Абстракция для session management |

#### REST Endpoints

| Метод | Путь | Аутентификация | Описание |
|-------|------|---------------|----------|
| GET | `/api/health` | Нет | Статус сервера, версия, uptime |
| GET | `/api/sessions` | Bearer | Список сессий |
| POST | `/api/sessions` | Bearer | Создать сессию |
| GET | `/api/sessions/:id` | Bearer | Детали сессии с сообщениями |
| DELETE | `/api/sessions/:id` | Bearer | Удалить сессию |
| POST | `/api/sessions/:id/messages` | Bearer | Отправить сообщение |
| GET | `/api/models` | Bearer | Список моделей и routing rules |
| GET | `/api/models/settings` | Bearer | Настройки моделей |
| PUT | `/api/models/settings` | Bearer | Обновить настройки модели |
| GET | `/api/budget` | Bearer | Статус бюджета |
| PUT | `/api/budget` | Bearer | Настроить бюджет |
| POST | `/api/tokens` | Bearer | Создать токен |
| GET | `/api/tokens` | Bearer | Список токенов |
| DELETE | `/api/tokens/:id` | Bearer | Удалить токен |

## Сборка

```bash
npm run build      # production build (tsgo)
npm run dev        # watch mode
npm run test       # vitest run
npm run clean      # удалить dist/
```

## Зависимости

**Runtime:**
- `@fan/db` — Prisma + SQLite для хранения токенов и настроек
- `@fan/model-manager` — маршрутизация моделей, бюджет
- `hono` — HTTP фреймворк
- `@hono/node-server` — Node.js адаптер (fallback для Bun)
- `ws` — WebSocket сервер

**Dev:**
- `typescript`, `shx`, `vitest`

## Связанные документы

- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [docs/guides/api-reference.md](../../docs/guides/api-reference.md)
- [docs/RELEASE.md](../../docs/RELEASE.md)

## License

MIT © Filin Agent Next Team
