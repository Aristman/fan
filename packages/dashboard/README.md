# @fan/dashboard

> FAN Dashboard — Web UI client built with Lit, Vite, and Tailwind CSS

> **Note:** This package is `private: true` — it is not published to npm. It is bundled into the FAN distribution archive.

## Описание

`@fan/dashboard` — это веб-клиент FAN, построенный на [Lit](https://lit.dev/), [Vite](https://vite.dev/) и [Tailwind CSS](https://tailwindcss.com/). Он предоставляет графический интерфейс для управления моделями, сессиями, бюджетом и настройками FAN.

**Решаемая задача:** удобный веб-интерфейс для пользователей, которые предпочитают GUI вместо TUI. Dashboard запускается вместе с сервером через флаг `--web` и доступен в браузере.

**Где используется:** запускается командой `fan --web` или вручную через `npm run dev` в режиме разработки. Vite dev server проксирует `/api` запросы к API Gateway на `localhost:3456`.

**Ключевые возможности:**
- Управление сессиями: создание, просмотр, удаление, отправка сообщений
- WebSocket стриминг ответов моделей в реальном времени
- Настройки моделей: температура, maxTokens, thinking mode
- Визуализация бюджета: лимиты токенов/стоимости по провайдерам
- Управление клиентскими токенами
- Тёмная тема FAN (oklch hue 260°)
- Connection Setup: форма ввода URL и токена при первом запуске

## Архитектура / Как работает

Dashboard — это SPA (Single Page Application), написанная на Lit Custom Elements без shadow DOM (для совместимости с Tailwind). Состояние хранится на сервере (SQLite), а dashboard — тонкий клиент.

```
Browser ──→ Vite Dev Server (port 5174) ──proxy──→ API Gateway (port 3456)
  │                                                    │
  ├── dashboard-app (корневой компонент)               ├── /api/health
  ├── session-sidebar (список сессий)                  ├── /api/sessions/*
  ├── chat-view (сообщения)                            ├── /api/models/*
  ├── model-settings-panel (настройки моделей)         ├── /api/budget
  ├── budget-panel (бюджет)                            └── /api/tokens
  └── settings-dialog (настройки)
```

### Компоненты

| Компонент | Описание |
|-----------|----------|
| `dashboard-app` | Корневой компонент, управляет layout'ом |
| `connection-setup` | Экран ввода URL и токена (первый запуск) |
| `session-sidebar` | Боковая панель со списком сессий |
| `chat-view` | Просмотр и отправка сообщений |
| `model-settings-panel` | Настройки параметров моделей |
| `budget-panel` | Визуализация бюджета и лимитов |
| `budget-alert-toast` | Уведомления о превышении бюджета |
| `settings-dialog` | Диалог общих настроек |

### API Client

`FanApiClient` (`src/api/client.ts`) — TypeScript-клиент для REST API FAN. Поддерживает все эндпоинты API Gateway: health, sessions, messages, models, budget, tokens. Автоматически обрабатывает ошибки 401 (auth error → connection setup).

## Использование

### Разработка

```bash
# Запустить API Gateway (в отдельном терминале)
fan server

# Запустить Dashboard dev server (автоматический прокси к API)
npm run dev
# → http://localhost:5174
```

### Production

```bash
# Использовать встроенный сервер FAN
fan --web
# → Автоматически запускает сервер и открывает http://localhost:3456
```

### Сборка standalone

```bash
npm run build   # Vite build → dist/
```

## API

### Экспорты

Dashboard экспортирует API клиент и WebSocket клиент для использования в других web-приложениях:

```ts
import { FanApiClient, FanApiError, FanWsClient } from "@fan/dashboard/api";

const api = new FanApiClient({ baseUrl: "http://localhost:3456", token: "..." });

// Проверка здоровья
const health = await api.health();

// Получение сессий
const { sessions } = await api.listSessions();

// WebSocket подключение
const ws = new FanWsClient("ws://localhost:3456", "token");
ws.onMessage((msg) => console.log(msg));
```

## Тема

FAN Dashboard использует кастомную тему на CSS-переменных (oklch, hue 260°):

- **Светлая тема:** `:root` — белый фон, синий акцент
- **Тёмная тема:** `.dark` — тёмный фон, яркий синий акцент
- **Кастомные элементы:** display block/flex (native custom elements по умолчанию inline)

## Сборка

```bash
npm run build      # Vite build → dist/
npm run dev        # Vite dev server (port 5174)
npm run preview    # Vite preview собранной версии
npm run check      # TypeScript проверка (tsgo --noEmit)
npm run test       # vitest run
npm run clean      # удалить dist/
```

## Зависимости

**Runtime:**
- `lit` — Web Components фреймворк
- `lucide` — SVG иконки
- `@seaagents/fan-web-ui` — общие UI-компоненты FAN

**Dev:**
- `vite` — сборщик и dev-сервер
- `tailwindcss` + `@tailwindcss/vite` — CSS утилиты
- `typescript`, `shx`, `vitest`, `jsdom`

## Связанные документы

- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [docs/guides/dashboard.md](../../docs/guides/dashboard.md)
- [docs/guides/configuration.md](../../docs/guides/configuration.md)
- [docs/RELEASE.md](../../docs/RELEASE.md)
- [docs/develop/tests/dashboard-phase6.md](../../docs/develop/tests/dashboard-phase6.md)

## License

MIT © Fast Agents Network Team
