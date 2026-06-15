# Changelog

## [1.0.0] - 2026-06-14

FAN 1.0.0 — стабилизация API Gateway. Все 14 эндпоинтов достигли
production-ready состояния. HTTP/WebSocket сервер для клиентских подключений.

### Новое

- **Стабильное API** — документированы все эндпоинты, финализирована схема
- **GET /api/health** — эндпоинт проверки здоровья сервера
- **FAN_NO_AUTH** — режим без аутентификации для локального сервера
- **GET /api/budget** — получение состояния бюджета провайдеров
- **PUT /api/budget** — обновление лимитов бюджета
- **GET /api/models/settings** — получение индивидуальных настроек моделей
- **PUT /api/models/settings** — обновление настроек моделей (temperature, maxTokens, thinking)
- **Request body parsing** — @hono/node-server для корректного парсинга тел запросов
- **SessionAdapter** — чтение сессий с диска через SessionManager
- **Dashboard static serving** — раздача статики веб-панели
- **Re-export типов** — BudgetStatus, BudgetConfig, ModelSettingData

### Улучшения

- **Refresh моделей** перед getAvailable — актуальный список провайдеров
- **Inline версии** в dist на этапе сборки (bun compile)
- **Foreground режим** для корректного project CWD
- **resolveAppMode()** — проверка `--mode` флага перед `FAN_FORCE_SERVER_MODE`
- **session_start событие** — генерируется для расширений в server mode

### Исправления

- Удалён `__dirname`-based `package.json` read для версионности
- `createRequire('../package.json')` заменён на `readFileSync` в http-server
- Патч относительных `require('../package.json')` в зависимостях перед bun compile

### Эндпоинты (v1.0.0)

- `GET /api/health` — проверка здоровья
- `POST /api/sessions` — создание сессии
- `GET /api/sessions` — список сессий
- `DELETE /api/sessions/:id` — удаление сессии
- `GET /api/sessions/:id` — получение сессии
- `POST /api/sessions/:id/messages` — отправка сообщения
- `GET /api/models` — список доступных моделей
- `GET /api/models/settings` — настройки моделей
- `PUT /api/models/settings` — обновление настроек моделей
- `GET /api/budget` — состояние бюджета
- `PUT /api/budget` — обновление бюджета
- `POST /api/tokens` — создание токена
- `GET /api/tokens` — список токенов
- `DELETE /api/tokens/:id` — удаление токена
- `WS /api/ws` — WebSocket подключение

---

## [0.13.2] - 2026-06-11

- Обновлена информация о провайдере Kimi
- Исправления конфигурации провайдеров

---

## [0.12.3] - 2026-06-08

- Исправление краша FAN Store
- Стабилизация установки пакетов

---

## [0.12.2] - 2026-06-06

- Добавлен провайдер MiniMax-3 (M3)
- Обновление моделей провайдера

---

## [0.12.1] - 2026-06-04

- Удалён `__dirname`-based `package.json` read для версионности
- Исправления в API Gateway

---

## [0.12.0] - 2026-06-03

- **Orchestrator v5** — PI-style workers, новый протокол взаимодействия
- Добавлен провайдер MiniMax-M1
- Refresh моделей перед getAvailable
- Исправление SessionAdapter

---

## [0.11.1] - 2026-06-01

- Добавлен провайдер MiMo (Mistral + Moonshot)
- Обновление роутов провайдеров

---

## [0.10.1] - 2026-05-31

- Миграция FAN Store на новый сервер: `fan.sea-agents.ru/fan-store`

---

## [0.10.0] - 2026-06-02

- **GetModelSettings/UpdateModelSettings** — добавлены эндпоинты настроек моделей
- **/api/budget** — добавлены эндпоинты управления бюджетом
- **Dashboard static serving** — раздача статики веб-панели
- Bump версии до 0.10.0
- Внутренние улучшения сборки

---

## [0.9.0] - 2026-05-30

- **Inline версии** в dist на этапе сборки (bun compile)
- `createRequire` заменён на `readFileSync` в http-server
- Патч относительных `require('../package.json')` в зависимостях перед bun compile
- Отключение bun compile autoload для dotenv и package.json
- Рефактор: извлечение orchestrator в FAN Store

---

## [0.8.4] - 2026-05-25

- Поддержка system CA-сертификатов для HTTPS-соединений
- Добавлен DeepSeek как встроенный провайдер
- Исправление `_AFAN_KEY` → `_API_KEY`

---

## [0.7.8] - 2026-05-20

- Добавлен провайдер MiMo
- Обновление Filin-LightLLM провайдера

---

## [0.7.5] - 2026-05-18

- **session_start событие** — генерируется для расширений в server mode
- Фильтрация сессий по project CWD

---

## [0.7.4] - 2026-05-10

- 11 предустановленных навыков FAN Store
- **Orchestrator v2** — мульти-агентная платформа (миграция)

---

## [0.7.1] - 2026-05-08

- FAN Store v0.7.0 — полная адаптация pi-store v1.7.1

---

## [0.6.0] - 2026-05-05

- Bump версии до 0.6.0
- Исправление сборки: build-binaries.sh переписан для bun isolated linker

---

## [0.5.1] - 2026-05-01

- Улучшения сборки и самообновления

---

## [0.4.5] - 2026-04-28

- Добавлен fan-repo как репозиторий по умолчанию

---

## [0.4.3] - 2026-04-25

- Исправления сборки: `--no-scripts` для cross-platform deps

---

## [0.4.1] - 2026-04-22

- Исправления build: bun add вместо npm, работа с isolated linker

---

## [0.4.0] - 2026-04-20

- Оркестратор вынесен в standalone FAN Store extension
- Удалена жёсткая интеграция из core

---

## [0.3.5] - 2026-04-18

- `/store browse` — интерактивный браузер пакетов FAN Store

---

## [0.3.4] - 2026-04-17

### Новый пакет: @fan/api-gateway

- **HTTP/WebSocket сервер** на базе Hono для клиентских подключений
- **14 REST эндпоинтов**: управление сессиями, моделями, токенами
- **Token auth** — аутентификация через ClientToken
- **WebSocket** — потоковая передача сообщений
- **SessionAdapter** — управление сессиями через диск
- Парсинг тел запросов через @hono/node-server
