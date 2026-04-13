# Phase 6 — Dashboard Client: Инструкция по проверке

> Пакет: `packages/dashboard/` · Ветка: `FAN/feature/phase6-dashboard-client` (2026-04-11)

**Статус:** Автоматические проверки — 14/14 ✅ · Ручные проверки — ожидают оператора

---

## Автоматически проверено ✅

Все нижеперечисленные кейсы проверены 2026-04-11.

### 1. Сборка монорепо ✅

```powershell
cd C:/Users/User/projects/fan
npm run build
```

**Результат:** 11 пакетов, 0 errors. Dashboard не входит в основную цепочку `npm run build` (Vite, не tsgo), но все остальные пакеты собираются корректно.

### 2. Сборка Dashboard (Vite) ✅

```powershell
cd C:/Users/User/projects/fan/packages/dashboard
npx vite build
```

**Результат:** 3546 модулей, built in ~9s. `dist/index.html` + `dist/assets/`. Адвисори warning на размер чанка (3.4MB из-за AI SDK) — не блокирует.

### 3. TypeScript type-check ✅

```powershell
cd C:/Users/User/projects/fan/packages/dashboard
npx tsc --noEmit
```

**Результат:** 0 errors.

### 4. Unit-тесты ✅

| Пакет | Тесты | Файлы | Результат |
|-------|-------|-------|-----------|
| `@fan/dashboard` | 23 | api-client (14), ws-client (9) | ✅ 23 passed |
| `@fan/api-gateway` | 39 | auth (12), http-server (24), ws-handler (3) | ✅ 39 passed |
| `@fan/model-manager` | 42 | db, router, fallback, budget | ✅ 42 passed |

**Итого: 104 теста, 0 фейлов.**

```powershell
cd packages/dashboard && npx vitest run
cd ../api-gateway && npx vitest run
cd ../model-manager && npx vitest run
```

### 5. Структура исходных файлов ✅

22 файла, все ненулевого размера:

```
packages/dashboard/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vite.config.ts
├── vitest.config.ts
├── index.html
└── src/
    ├── main.ts
    ├── app.css
    ├── api/
    │   ├── client.ts          (FanApiClient — 14 REST методов)
    │   ├── ws-client.ts       (FanWsClient — WS с авто-реконнектом)
    │   └── index.ts
    ├── lib/
    │   └── icon.ts            (Lucide icon() helper)
    ├── components/
    │   ├── dashboard-app.ts   (корневой компонент + layout + роутинг)
    │   ├── session-sidebar.ts (список сессий + поиск + CRUD)
    │   ├── chat-view.ts       (чат со стримингом через WS)
    │   ├── budget-panel.ts    (визуализация бюджета)
    │   ├── budget-alert-toast.ts (тосты при превышении бюджета)
    │   ├── model-settings-panel.ts (настройки моделей + routing rules)
    │   ├── settings-dialog.ts (диалог настроек: connection + tokens)
    │   └── connection-setup.ts (первый запуск: URL + token)
    └── __tests__/
        ├── api-client.test.ts
        └── ws-client.test.ts
```

### 6. Git-чистота ✅

```powershell
cd C:/Users/User/projects/fan
git status --short
```

**Результат:** Working tree clean. 14 коммитов в ветке `FAN/feature/phase6-dashboard-client`.

### 7. Отсутствие старых broken-паттернов ✅

- `lucide-lucide-*` CSS-классы: 0 вхождений (исправлено на `icon()` helper)
- `@mariozechner/mini-lit` в dependencies: удалён (не использовался)

### 8. Изменения в существующих файлах ✅

| Файл | Изменение | Обоснование |
|------|-----------|-------------|
| `packages/api-gateway/src/types.ts` | +1 строка (re-export BudgetStatus и др.) | Dashboard использует типы бюджета |
| `package.json` (root) | +build:dashboard, +dev:dashboard, dashboard в concurrently dev | Интеграция в монорепо |
| `package-lock.json` | Обновлён lockfile | Новый пакет + зависимостей |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | π → FAN в заголовке терминала | Ребрендинг |

### 9. Покрытие REST API endpoints ✅

| Endpoint | Метод в FanApiClient | Статус |
|----------|---------------------|--------|
| `GET /api/health` | `health()` | ✅ |
| `POST /api/sessions` | `createSession()` | ✅ |
| `GET /api/sessions` | `listSessions()` | ✅ |
| `GET /api/sessions/:id` | `getSession()` | ✅ |
| `DELETE /api/sessions/:id` | `deleteSession()` | ✅ |
| `POST /api/sessions/:id/messages` | `sendMessage()` | ✅ |
| `GET /api/models` | `getModels()` | ✅ |
| `GET /api/models/settings` | `getModelSettings()` | ✅ |
| `PUT /api/models/settings` | `updateModelSetting()` | ✅ |
| `GET /api/budget` | `getBudget()` | ✅ |
| `PUT /api/budget` | `updateBudget()` | ✅ |
| `POST /api/tokens` | `generateToken()` | ✅ |
| `GET /api/tokens` | `listTokens()` | ✅ |
| `DELETE /api/tokens/:id` | `revokeToken()` | ✅ |

14/14 endpoints покрыты. Все типизированы через импорты из `@fan/api-gateway/types`.

### 10. Покрытие WS message types ✅

| Server message | Обработка в FanWsClient | Статус |
|---------------|------------------------|--------|
| `connected` | Статус → connected | ✅ |
| `pong` | Игнорируется (pong keepalive) | ✅ |
| `agent_event` | Проброс в callback (message_update, tool_execution_start/end, agent_start/end) | ✅ |
| `budget_alert` | Проброс в callback → CustomEvent в dashboard-app | ✅ |
| `model_switch` | Проброс в callback → обновление currentModel | ✅ |
| `error` | Статус → error, проброс в callback | ✅ |

6/6 типов (включая undocumented `connected` и `pong`) обработаны.

---

## Ручное тестирование ⏳

> Автоматизация невозможна — нужен запущенный FAN runtime (API Gateway + Agent + TUI).

### Предварительная подготовка

#### Windows (PowerShell)

1. Поднять FAN runtime:
   ```powershell
   cd C:/Users/User/projects/fan
   npm run build
   npx prisma db push --schema packages/db/prisma/schema.prisma
   node packages/coding-agent/dist/cli.js  # интерактивный режим
   ```

2. Сгенерировать API-токен. В TUI нет `/tokens` команды.
   Первый токен создаётся через API с отключённой авторизацией:
   ```powershell
   # В одном терминале — FAN server с отключённой авторизацией
   $env:FAN_NO_AUTH = "1"
   node packages/coding-agent/dist/cli.js --mode server --port 3456

   # В другом терминале — создать токен
   Invoke-RestMethod -Method POST -Uri http://localhost:3456/api/tokens `
     -ContentType application/json -Body '{"name":"dashboard"}' | `
     Select-Object -ExpandProperty token
   ```
   Скопировать полученный токен.
   Затем перезапустить FAN runtime **без** `FAN_NO_AUTH` (авторизация включена,
   токен уже в БД и будет валидироваться).

3. Запустить dashboard dev server:
   ```powershell
   cd C:/Users/User/projects/fan/packages/dashboard
   npm run dev
   ```
   Открыть http://localhost:5174

#### Ubuntu (bash)

1. Поднять FAN runtime:
   ```bash
   cd ~/projects/fan
   npm run build
   chmod +x node_modules/.bin/*  # если permissions сбиты после install
   npx prisma db push --schema packages/db/prisma/schema.prisma
   node packages/coding-agent/dist/cli.js  # интерактивный режим
   ```

2. Сгенерировать API-токен:
   ```bash
   # В одном терминале — FAN server с отключённой авторизацией
   FAN_NO_AUTH=1 node packages/coding-agent/dist/cli.js --mode server --port 3456

   # В другом терминале — создать токен
   curl -s -X POST http://localhost:3456/api/tokens \
     -H "Content-Type: application/json" \
     -d '{"name":"dashboard"}' | jq -r '.token'
   ```
   Скопировать полученный токен.
   Затем перезапустить FAN runtime **без** `FAN_NO_AUTH`.

3. Запустить dashboard dev server:
   ```bash
   cd ~/projects/fan/packages/dashboard
   npm run dev
   ```
   Открыть http://localhost:5174

### T1 — Экран подключения (Connection Setup) ⏳

1. Открыть http://localhost:5174
2. **Ожидание:** Отображается карточка с заголовком "FAN Dashboard", полем Server URL (по умолчанию `http://localhost:3456`), полем API Token, кнопкой "Test Connection"
3. Вставить токен из TUI
4. Нажать "Test Connection"
5. **Ожидание:** Зелёная галочка, версия, uptime
6. Через ~1 сек автоматически переходит к основному интерфейсу

**Проверить:**
- [x] Карточка отображается корректно, иконки видны
- [x] Пустой token → ошибка валидации
- [x] Неверный token → красная ошибка "Connection failed"
- [x] Успешный коннект → сохранение в localStorage
- [x] Reload страницы → сразу открывается dashboard (без повторного ввода)

### T2 — Session Sidebar ⏳

1. В сайдбаре нажать "New Session"
2. **Ожидание:** Новая сессия создаётся, вид переключается на чат
3. Создать ещё 2-3 сессий (можно через TUI: отправить сообщение в каждой)
4. Вернуться к списку сессий (кликнуть в пустую область / закрыть чат)

**Проверить:**
- [ ] Сессии отображаются с заголовками
- [x] Сортировка по дате обновления (новые сверху)
- [x] Поиск по названию фильтрует список
- [x] Активная сессия подсвечена
- [x] Удаление сессии (красная корзина на hover) → confirm → удаление
- [x] Клик по сессии → переход в чат

### T3 — Chat View (стриминг сообщений) ⏳

1. Выбрать или создать сессию
2. Ввести сообщение "Привет, расскажи про себя в двух предложениях"
3. Нажать Enter или кнопку Send

**Проверить:**
- [x] Сообщение пользователя появляется справа (бабл)
- [x] Индикатор "Thinking..." пока агент обрабатывает
- [x] Ответ ассистента стримится посимвольно слева
- [x] Markdown рендерится (bold, inline code, code blocks)
- [x] Tool calls отображаются как сворачиваемые блоки (bash, read и т.д.)
- [ ] Auto-scroll вниз при новых сообщениях
- [ ] Скролл вверх → auto-scroll отключается (не дёргает обратно)
- [x] Shift+Enter → новая строка (не отправляет)
- [x] Пустое сообщение не отправляется
- [ ] После завершения агента: token count и cost отображаются

### T4 — WebSocket переподключение ⏳

1. Открыть сессию в dashboard
2. В TUI: отправить сообщение в ту же сессию

**Проверить:**
- [x] События через WS приходят в dashboard (агент работает на сервере)
- [x] Перезапустить API Gateway → dashboard пытается реконнектиться
- [x] После перезапуска: статус-индикатор в header переключается обратно на зелёный

### T5 — Budget Panel ⏳

1. В сайдбаре нажать "💰 Budget Overview"

**Проверить:**
- [x] Отображаются карточки бюджетов по провайдерам/периодам
- [ ] Progress-бары для tokens и cost с корректными значениями
- [ ] Цвет прогресс-бара: зелёный <60%, жёлтый 60-85%, красный >85%
- [ ] Кнопка Refresh обновляет данные
- [x] Автообновление каждые 30 сек

### T6 — Budget Alert Toasts ⏳

> Требует настройки бюджета с низкими лимитами для триггера алерта.

1. В TUI или через API: установить бюджет с лимитом, близким к текущему использованию
2. Отправить сообщение в чат, чтобы превысить порог

**Проверить:**
- [ ] Появляется тост-уведомление в правом верхнем углу
- [ ] Тост содержит провайдера, период, тип алерта
- [ ] Клик по тосту → переход к Budget Overview
- [ ] Тост исчезает через 10 сек

### T7 — Model Settings Panel ⏳

1. В сайдбаре нажать "🤖 Model Settings"

**Проверить:**
- [x] Три таба: Model Settings, Routing Rules, Available Models
- [ ] Model Settings: таблица с provider, model, temperature, maxTokens, thinking
- [ ] Inline-редактирование: pencil → input → save/cancel
- [ ] Save → данные обновляются (перезагрузить панель для проверки)
- [ ] Routing Rules: карточки с name, provider, model, fallback, enabled
- [ ] Available Models: сетка по провайдерам

### T8 — Settings Dialog ⏳

1. Нажать ⚙ (шестерёнку) в header

**Проверить:**
- [x] Открывается диалог с бэкдропом
- [x] Tab "Connection": текущий URL и token (замаскированный), кнопка Test Connection
- [x] Tab "API Tokens": список токенов с name, created, last used
- [x] Generate New Token: ввести имя → сгенерировать → токен показан ОДИН раз
- [x] Copy token → буфер обмена
- [x] Revoke token → confirm → удалён из списка
- [x] Закрытие диалога (крестик или бэкдроп)

### T9 — Responsive (мобильный вид) ⏳

1. Открыть DevTools → Toggle Device Toolbar → 375px (iPhone)

**Проверить:**
- [ ] Сайдбар скрыт
- [ ] Гамбургер-меню в header открывает сайдбар как overlay
- [ ] Клик по бэкдропу закрывает сайдбар
- [ ] Чат занимает всю ширину
- [ ] Input и send button доступны

### T10 — Production Build ⏳

#### Windows
```powershell
cd C:/Users/User/projects/fan/packages/dashboard
npx vite build
npx vite preview
```

#### Ubuntu
```bash
cd ~/projects/fan/packages/dashboard
npx vite build
npx vite preview
```

1. Открыть http://localhost:4173

**Проверить:**
- [ ] Приложение загружается без ошибок в консоли
- [ ] API прокси НЕ работает (preview не проксирует) → connection setup покажет ошибку
- [ ] Для полноценного preview: настроить reverse proxy или использовать dev mode

---

## Известные ограничения (non-blocking)

| # | Описание | Влияние |
|---|----------|---------|
| 1 | Бандл 3.4MB (gzip 964KB) — тянет AI SDK через api-gateway types | Время загрузки, но не функциональность. Fix: code-splitting или type-only bundle |
| 2 | Token в URL query param для WS | Появляется в логах. Наследовано от api-gateway дизайна |
| 3 | Markdown рендерер — basic (bold, code, lists) | Не полный CommonMark. Достаточно для AI-ответов |
| 4 | Connection setup не проверяет CORS | Если API Gateway за прокси без CORS — молчит. Нужное сообщение об ошибке |
