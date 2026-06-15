# Changelog

## [1.0.0] - 2026-06-14

FAN 1.0.0 — стабилизация Dashboard. Веб-панель управления FAN достигла
production-ready состояния. Lit + Vite + Tailwind, тёмная тема, полный набор UI.

### Новое

- **Routing rules UI** — управление правилами маршрутизации провайдеров
- **Настройки подключения** — экран настройки соединения с сервером FAN
- **Settings dialog** — диалог настроек с поддержкой всех параметров
- **Валидация токена** — санитизация символов при вводе токена

### Улучшения

- **FAN theme** — собственная тёмная тема (oklch hue 260°), замена mini-lit theme
- **Model settings panel** — inline редактирование temperature, maxTokens, thinking
- **Budget visualization** — графическое отображение дневных и месячных лимитов
- **Alert toasts** — уведомления о превышении бюджета
- **Chat view** — обмен сообщениями через WebSocket с потоковой передачей
- **Session sidebar** — список сессий с навигацией и удалением
- **Shared icon helper** — рендеринг Lucide SVG иконок
- **Unit tests** — тесты для API client и WebSocket client

### Исправления

- JSON body отправляется для всех POST/PUT/PATCH запросов
- Исправлена отсутствующая закрывающая скобка в icon.ts
- Иконки, валидация соединения, подсказки
- Переименование `settings-dialog` → `fan-settings-dialog` для избежания конфликтов
- Статические импорты компонентов
- Удалён дублирующийся build key в vite.config.ts
- Vite warnings suppressed для server-side fan-ai импортов

### Компоненты (v1.0.0)

- **fan-app** — корневой компонент с роутингом и интеграцией WebSocket (app-shell)
- **fan-session-sidebar** — боковая панель списка сессий
- **fan-chat-view** — окно чата с потоковым выводом
- **fan-model-settings** — панель настроек моделей
- **fan-budget-view** — визуализация бюджета
- **fan-settings-dialog** — диалог настроек подключения
- **icon(name, classStr)** — хелпер для Lucide SVG

---

## [0.12.3] - 2026-06-08

- Исправление краша FAN Store
- Стабилизация установки пакетов

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

- Bump версии до 0.10.0
- Внутренние улучшения

---

## [0.9.0] - 2026-05-30

### Routing Rules UI

- **Управление правилами маршрутизации** — добавление, удаление, редактирование
- UI для провайдеров, моделей и fallback цепочек
- Интеграция с API Gateway

---

## [0.7.0] - 2026-05-08

### Budget Visualization

- **Графическое отображение бюджета** — дневные и месячные лимиты
- **Alert toasts** — уведомления о превышении лимитов
- Индикаторы заполнения бюджета для каждого провайдера

---

## [0.6.0] - 2026-05-05

### Model Settings & FAN Theme

- **Model settings panel** — inline редактирование параметров моделей
- **FAN theme** — собственная тёмная тема (oklch hue 260°)
- Замена mini-lit theme на кастомную тему
- Светлая/тёмная вариации

---

## [0.5.0] - 2026-04-30

### Chat & Session UI

- **Chat view** — обмен сообщениями через WebSocket
- **Streaming output** — потоковый вывод ответов LLM
- **Session sidebar** — список сессий с навигацией
- **App shell** — корневой layout с роутингом

---

## [0.4.0] - 2026-04-25

### Settings Dialog & Connection Setup

- **Settings dialog** — экран настройки соединения с сервером FAN
- **Connection setup** — ввод URL сервера и токена
- **Token validation** — санитизация не-ASCII символов
- Интеграция с API Gateway

---

## [0.3.0] - 2026-04-20

### Unit Tests

- **API client tests** — тестирование REST эндпоинтов
- **WebSocket client tests** — тестирование WS соединения
- Инфраструктура тестов (jsdom, vitest)

---

## [0.2.0] - 2026-04-15

### Icon System & API Client Layer

- **Shared icon helper** — рендеринг Lucide SVG иконок
- **FAN API client layer** — HTTP и WebSocket клиенты
- Базовая интеграция с @fan/api-gateway

---

## [0.1.0] - 2026-04-11

### Новый пакет: @fan/dashboard (private)

- **Package scaffold** — Vite + Lit + TypeScript + Tailwind
- **Build config** — Vite сборка static SPA
- **Global styles** — базовые стили и CSS переменные
- **App entry point** — корневой элемент приложения
