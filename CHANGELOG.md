# Changelog

## [1.0.2] - 2026-06-15

### Исправления

- **fan-ask-answer extension (store)** — добавлена поддержка RPC mode для question и questionnaire.
  - Расширение `fan-ask-answer@1.0.1` опубликовано в FAN Store.
  - В RPC mode (`fan --mode rpc`) теперь использует `ctx.ui.select/input/confirm` вместо `ctx.ui.custom()`.
  - В TUI-режиме поведение не изменилось.

---

## [1.0.1] - 2026-06-15

### Исправления

- **questionnaire** — переписан для работы в RPC mode.
  - Использовал `ctx.ui.select/input/confirm` вместо `ctx.ui.custom()` для RPC.
  - Добавлен probe-детект режима: `custom()` возвращает `undefined` в RPC mode и `true` в TUI.
  - TUI-режим полностью сохранён (табы, редактор, навигация).

---

## [1.0.0] - 2026-06-14

### 🚀 FAN 1.0.0 — Первый стабильный релиз

Этот релиз знаменует собой стабилизацию API и архитектуры FAN. Все компоненты
достигли production-ready состояния. Основные направления разработки в этом цикле:
интеграция с IntelliJ IDEA, улучшение FAN Store, новый набор навыков, провайдеры LLM.

**Ключевые пакеты:**
- `@itone/fan-coding-agent` — CLI-интерфейс, runtime, набор инструментов
- `@itone/fan-ai` — унифицированное LLM API (10+ провайдеров)
- `@itone/fan-agent-core` — абстракция агента с транспортами и состоянием
- `@itone/fan-tui` — TUI-библиотека с дифференциальным рендерингом (отдельный npm-пакет)
- `@itone/fan-web-ui` — компоненты веб-интерфейса (отдельный npm-пакет)
- `@fan/api-gateway` — HTTP/WebSocket сервер для клиентских подключений
- `@fan/db` — слой базы данных (Prisma + SQLite)
- `@fan/model-manager` — маршрутизация провайдеров, fallback-цепочки, бюджет
- `@fan/dashboard` — веб-панель управления (Lit + Tailwind)
- `@fan/store` — менеджер пакетов (расширения, навыки, темы)

**Поставляемые навыки (8шт):**
`auto-tests`, `bug-fix`, `code-research`, `deep-dive`, `fan-forge`, `idea-lab`, `repo-explorer`, `research-spec-generator`

---

### Новое

- **IntelliJ IDEA Plugin** — полноценная интеграция FAN в IntelliJ Platform
  - JCEF-движок рендеринга чата (TUI-стиль визуализации)
  - Панели: Welcome, SessionList, Chat, Input, Renderer, StatusBar
  - Автостарт локального FAN-сервера, авто-провижинг без токенов
  - Уведомления, Actions (DeleteSession, OpenSettings, AskFan)
  - Поддержка IC-2024.2.2+, JCEF на Ubuntu 24.04
- **Расширение `fan-soul`** — управление идентичностью агента (SOUL.md / USER.md)
- **Расширение `fan-loop`** — цикл самостоятельного выполнения задач
- **Расширение `fan-confluence`** — интеграция с Confluence Data Center
- **Инструмент `confluence`** — чтение/запись/поиск страниц Confluence
- **Провайдеры LLM:**
  - MiniMax-M3, MiniMax-M1
  - MiMo (Mistral + Moonshot)
  - DeepSeek (встроенный провайдер)
  - Filin-LightLLM (лёгкий инференс)
  - Kimi
- **dev-docs-pack skill v1.1.0** — генератор полного пакета документации разработки
- **feature-pipeline + feature-roadmap skills** — TDD-пайплайн разработки фич

### Улучшения

- **FAN Store** — полная адаптация pi-store v1.7.1
  - `/store browse` — интерактивный браузер пакетов
  - Анимация операций install/remove/update
  - 11 предустановленных навыков (FAN Store)
  - SHA-256 верификация, path traversal защита, backup & rollback
  - Репозиторий по умолчанию: `https://fan.sea-agents.ru/fan-store/`
- **Оркестратор v5** — PI-style воркеры, новый протокол взаимодействия
- **Менеджер моделей** — обновление моделей перед `getAvailable`
- **TLS skip** — всегда пропускать верификацию TLS для fd/rg download
- **Корпоративные прокси** — поддержка прокси с самоподписанными сертификатами
- **Windows** — скрытие окна терминала при self-update
- **Версия инлайнится** в api-gateway dist на этапе сборки (bun compile)

### Исправления

- **build** — использование `bun install` вместо `npm`, работа с bun isolated linker
- **build** — cross-platform native bindings через `--ignore-scripts`
- **build** — исправление относительных require('./package.json') для bun compile
- **server** — режим foreground для корректного project CWD
- **server** — `resolveAppMode()` проверяет `--mode` флаг перед `FAN_FORCE_SERVER_MODE`
- **store** — переписана установка (bun CLI, staging, очистка workspace deps)
- **store** — показ локально установленных пакетов не из удалённого индекса
- **idea-plugin** — 40+ исправлений компиляции, рантайм-конфликты, JCEF краши
- **idea-plugin** — отключение корутин в UI-слое, замена на IntelliJ native threading
- **idea-plugin** — отображение статуса подключения, блокировка Send до коннекта
- **extensions** — `session_start` событие для серверного режима
- **fan-repo** — `rsync` без `--delete`, чтобы не терять пакеты
- **Загрузка системных CA-сертификатов** для HTTPS-соединений
- **Очистка зависимостей** — удалены неиспользуемые зависимости и сборки

### Технический долг / Архитектура

- Оркестратор вынесен в отдельное расширение FAN Store (v4 → v5)
- Удалён `--delete` из rsync при публикации в fan-repo
- Обновлён CLAUDE.md с правилами импорта
- Роадмапы фич и документация по плагину

---

## [0.10.0] - 2026-06-02

- Bump версии до 0.10.0
- Миграция FAN Store на новый сервер `fan.sea-agents.ru/fan-store`

---

## [0.9.0] - 2026-05-30

- Bump версии до 0.9.0
- Исправление inlining версии в api-gateway dist для bun compile
- Refactor: извлечение orchestrator в FAN Store, исправление версионирования

---

## [0.8.4] - 2026-05-25

- Исправления сборки: отключение autoload для dotenv и package.json
- Поддержка system CA-сертификатов
- Добавлен DeepSeek как встроенный провайдер

---

## [0.7.8] - 2026-05-20

- Провайдер MiMo
- Исправление Windows: скрытие окна терминала при self-update

---

## [0.7.5] - 2026-05-18

### IntelliJ IDEA Plugin (масштабная интеграция)

- JCEF-движок рендеринга (TUI-стиль визуализации)
- Панели: Welcome, SessionList, Chat, Input, Renderer, StatusBar
- Работа с сессиями, навигация, отправка сообщений
- Автостарт/стоп FAN-сервера в проекте
- Состояние подключения, уведомления, Actions
- 40+ исправлений: компиляция, рантайм-конфликты, JCEF краши

### Прочее

- `session_start` событие для серверного режима
- Фильтрация сессий по project CWD

---

## [0.7.4] - 2026-05-10

- 11 предустановленных навыков для FAN Store
- Оркестратор v2 — мульти-агентная платформа (миграция)

---

## [0.7.1] - 2026-05-08

- FAN Store v0.7.0 — полная адаптация pi-store v1.7.1
- `/store browse` — интерактивный браузер пакетов
- Анимация операций install/remove/update

---

## [0.6.0] - 2026-05-05

- Bump версии до 0.6.0
- Исправление сборки: build-binaries.sh переписан для bun isolated linker
- Self-update: `fan update` + install.sh / install.ps1
- Авто-копирование артефактов сборки в `~/fan-repo/dist/`

---

## [0.5.1] - 2026-05-01

- Исправление установки: полная директория + symlink + realpath resolution
- Trim бинарной дистрибуции до runtime-необходимого
- Хэндлинг существующей директории в install.sh

---

## [0.4.5] - 2026-04-28

- Добавлен fan-repo как репозиторий по умолчанию
- Переписан установщик FAN Store: bun CLI, staging, очистка workspace deps

---

## [0.4.3] - 2026-04-25

- Исправления сборки: --no-scripts для cross-platform deps, skip native compilation

---

## [0.4.1] - 2026-04-22

- Исправления build: bun add вместо npm, работа с isolated linker
- FAN Store: animation install/remove/update

---

## [0.4.0] - 2026-04-20

- **Оркестратор вынесен** в standalone расширение FAN Store (v0.4.0)
- Удалена жёсткая интеграция из core, авто-обнаружение через Store

---

## [0.3.5] - 2026-04-18

- `/store browse` — интерактивный браузер пакетов

---

## [0.3.4] - 2026-04-17

### FAN Store — Package Manager Extension

#### Новый пакет: `@fan/store`
- Менеджер пакетов для установки расширений, навыков и тем
- 5 LLM-инструментов: `store_search`, `store_install`, `store_remove`, `store_update`, `store_list`
- `/store` slash-команда с подкомандами
- Управление репозиториями, multi-repo поиск
- Установка из архивов (.tar.gz, .tgz, .zip)
- Bundle support (extensions/, skills/, themes/)
- SHA-256 верификация, path traversal protection, backup & rollback
- Оффлайн-режим, file:// URL поддержка

---

## [0.3.3] - 2026-04-17

- Исправление: восстановлены агенты в оркестраторе

---

## [0.3.1] - 2026-04-16

- Исправление: загрузка глобального `.env` в process.env при старте

---

## [0.3.0] - 2026-04-16

### Новый пакет: `@fan/persistent-memory` v2.0.0
- Расширение для сохранения знаний между сессиями
- Память вынесена из core в отдельный пакет

---

## [0.2.2] - 2026-04-15

- Исправление бага загрузки .env
- Обновление README, CHANGELOG и roadmap ссылок

---

## [0.2.1] - 2026-04-15

- TLS skip для fd/rg download
- Поддержка корпоративных прокси

---

## [0.2.0] - 2026-04-15

### Оркестратор — TUI работников и архитектура

- Живое отображение инструментов работников
- Состояния: running, completed collapsed/expanded
- Task List Widget с авто-скрытием
- Slot pool для контроля конкурентности
- stop_worker, parseVerdict()
- Документация и обновление системного промпта координатора
