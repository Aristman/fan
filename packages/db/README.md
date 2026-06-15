# @fan/db

> FAN database layer — Prisma + SQLite

## Описание

`@fan/db` — это слой персистентности FAN, построенный на [Prisma](https://www.prisma.io/) и SQLite. Он обеспечивает хранение всех данных runtime: сессий, сообщений, настроек моделей, правил маршрутизации, бюджета и клиентских токенов.

**Решаемая задача:** централизованное управление данными FAN без необходимости внешней БД. SQLite-файл хранится локально (`~/.fan/agent/fan.db`) и не требует настройки сервера баз данных. Prisma обеспечивает типизированный API и миграции.

**Где используется:** всеми пакетами FAN — `@fan/api-gateway` (токены, сессии), `@fan/model-manager` (настройки моделей, бюджет, routing rules), `@fan/store` (пакеты), CLI (persistence runtime).

**Ключевые возможности:**
- Prisma ORM с автогенерацией клиента
- SQLite — zero-config, локальный файл
- 6 моделей: Session, Message, ModelSetting, RoutingRule, Budget, ClientToken
- DDL инициализация без миграций (через `initDatabase()`)
- Кросс-платформенные Prisma engine бинарники (Windows, macOS, Linux)
- Скрипты: миграции, Prisma Studio, push, validate, generate

## Архитектура / Как работает

Слой БД состоит из двух частей:

1. **Prisma Schema** (`prisma/schema.prisma`) — декларативное описание моделей и связей. Генерирует Prisma Client.
2. **Клиент** (`src/client.ts`) — singleton `PrismaClient` с автоопределением engine path для standalone-сборок. Функция `initDatabase()` выполняет DDL напрямую (CREATE TABLE IF NOT EXISTS) без Prisma Migrations для надёжного первого запуска.

```
@fan/db ──→ Prisma Client ──→ SQLite (.fan/agent/fan.db)
              │
              ├── 6 моделей (Session, Message, ModelSetting, RoutingRule, Budget, ClientToken)
              ├── cross-platform engine detection
              └── DDL init fallback
```

### Модели данных

| Модель | Описание | Ключевые поля |
|--------|----------|---------------|
| `Session` | Чат-сессия | id, title, model, provider, createdAt, updatedAt |
| `Message` | Сообщение в сессии | id, sessionId, role, content, toolCalls (JSON), tokens, cost |
| `ModelSetting` | Настройки модели | provider, model, temperature, maxTokens, thinking |
| `RoutingRule` | Правила маршрутизации | name, provider, model, fallback, enabled |
| `Budget` | Бюджет и лимиты | provider, period, tokenLimit, costLimit, tokensUsed |
| `ClientToken` | Токены клиентов | name, token (unique), createdAt, lastUsed |

## Использование

### Базовое использование

```ts
import { getPrismaClient, initDatabase } from "@fan/db";

// Инициализация БД (создаёт таблицы если их нет)
await initDatabase();

// Получение PrismaClient
const prisma = getPrismaClient();

// Запросы
const sessions = await prisma.session.findMany({
  include: { messages: true },
  orderBy: { updatedAt: "desc" },
});

const settings = await prisma.modelSetting.findMany({
  where: { provider: "openai" },
});
```

### API

#### Экспорты из `src/index.ts`

| Экспорт | Тип | Описание |
|---------|-----|----------|
| `getPrismaClient` | `() => PrismaClient` | Возвращает singleton PrismaClient |
| `initDatabase` | `(prisma?: PrismaClient) => Promise<void>` | Создаёт таблицы, если их нет |
| `closePrismaClient` | `() => Promise<void>` | Закрывает соединение с БД |
| `Prisma` | Namespace | Prisma namespace (типы, helpers) |
| `PrismaClient` | Type | Тип PrismaClient |

## Сборка

```bash
npm run build        # prisma generate → tsgo build
npm run dev          # watch mode
npm run db:migrate   # Prisma migrate dev
npm run db:studio    # Prisma Studio (GUI)
npm run db:push      # Prisma db push
npm run db:validate  # Prisma validate
npm run db:generate  # Prisma generate только
npm run clean        # удалить dist/
```

## Зависимости

**Runtime:**
- `@prisma/client` — Prisma ORM клиент

**Dev:**
- `prisma` — Prisma CLI (миграции, генерация)
- `shx` — кросс-платформенные shell команды

## Связанные документы

- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [docs/guides/configuration.md](../../docs/guides/configuration.md)
- [docs/RELEASE.md](../../docs/RELEASE.md)

## License

MIT © Filin Agent Next Team
