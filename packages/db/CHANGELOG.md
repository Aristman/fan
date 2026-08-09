# Changelog

## [1.1.0] - 2026-08-09

### Новое

- **`ensureDatabase()`** — идемпотентный singleton для schema init: ошибки
  логируются, промис всегда resolved (без unhandled rejection при старте).
- **`closePrismaClient()`** сбрасывает init-singleton — поддержка reconnect
  сценариев (переподключение после закрытия).
- Первая тест-суита пакета (5 тестов, vitest).

---

## [1.0.1] - 2026-06-17

### Изменено

- Ребрендинг: замена оставшихся `pi`-упоминаний на `fan`.
- Удалён `scripts/sync-version.mjs`, независимое версионирование пакетов.

---

## [1.0.0] - 2026-06-14

FAN 1.0.0 — стабилизация схемы базы данных. Prisma + SQLite слой данных
для всех компонентов FAN. Финализированы таблицы и миграции.

### Новое

- **Стабилизация схемы** — финализированы все таблицы и типы
- **ClientToken** (id, name, token, createdAt, lastUsed) — управление токенами
- **RoutingRule** (id, name, provider, model, fallback, enabled) — правила маршрутизации
- **ModelSetting** (provider, model, temperature, maxTokens, thinking) — настройки моделей
- **Budget** (provider, dailyLimit, monthlyLimit, currentSpend) — учёт бюджета

### Улучшения

- **Migration orchestrator-v2** — добавлены таблицы для мульти-агентной платформы
- Prisma migrate workflow — `db:migrate`, `db:push`, `db:studio`, `db:validate`
- Полная генерация Prisma Client через `prisma generate`
- Интеграция с @fan/api-gateway и @fan/model-manager

---

## [0.13.2] - 2026-06-11

- Обновлена информация о провайдере Kimi

---

## [0.12.3] - 2026-06-08

- Исправление краша FAN Store

---

## [0.12.2] - 2026-06-06

- Добавлен провайдер MiniMax-3 (M3)

---

## [0.12.1] - 2026-06-04

- Исправления в API Gateway

---

## [0.12.0] - 2026-06-03

- **Orchestrator v5** — PI-style workers, новый протокол взаимодействия
- Добавлен провайдер MiniMax-M1

---

## [0.11.1] - 2026-06-01

- Добавлен провайдер MiMo (Mistral + Moonshot)

---

## [0.10.1] - 2026-05-31

- Миграция FAN Store на новый сервер: `fan.sea-agents.ru/fan-store`

---

## [0.10.0] - 2026-06-02

- **ModelSetting** — добавлена таблица настроек моделей (temperature, maxTokens, thinking)
- **Budget** — добавлена таблица бюджета (dailyLimit, monthlyLimit, currentSpend)
- Bump версии до 0.10.0

---

## [0.9.0] - 2026-05-30

- Inline версии в api-gateway dist на этапе сборки (bun compile)
- Рефактор: извлечение orchestrator в FAN Store

---

## [0.8.4] - 2026-05-25

- Добавлен DeepSeek как встроенный провайдер
- Исправление `_AFAN_KEY` → `_API_KEY`

---

## [0.7.8] - 2026-05-20

- Добавлен провайдер MiMo

---

## [0.7.5] - 2026-05-18

- **session_start событие** для серверного режима

---

## [0.7.4] - 2026-05-10

- **Orchestrator v2** — мульти-агентная платформа (миграция)
- Добавлены таблицы для воркеров и задач

---

## [0.7.1] - 2026-05-08

- FAN Store v0.7.0 — полная адаптация pi-store v1.7.1

---

## [0.6.0] - 2026-05-05

- Bump версии до 0.6.0

---

## [0.5.1] - 2026-05-01

- Улучшения сборки

---

## [0.4.5] - 2026-04-28

- Добавлен fan-repo как репозиторий по умолчанию

---

## [0.4.3] - 2026-04-25

- Исправления сборки

---

## [0.4.1] - 2026-04-22

- Исправления build

---

## [0.4.0] - 2026-04-20

- Оркестратор вынесен в standalone FAN Store extension

---

## [0.3.5] - 2026-04-18

- `/store browse` — интерактивный браузер пакетов

---

## [0.3.4] - 2026-04-17

### Новый пакет: @fan/db

- **Prisma + SQLite** — слой базы данных
- **ClientToken** — таблица для аутентификации (id, name, token, createdAt, lastUsed)
- **RoutingRule** — таблица правил маршрутизации (id, name, provider, model, fallback, enabled)
- Prisma schema, миграции, генерация клиента
- Интеграция с API Gateway и Model Manager
- Скрипты: `db:migrate`, `db:push`, `db:studio`, `db:validate`, `db:generate`
