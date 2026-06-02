# Расширение fan для Confluence — Техническое исследование

## Метаданные
- **Дата:** 2026-05-22
- **Тип идеи:** Техническая
- **Глубина:** Стандартный
- **Статус:** Исследовано

## 1. Ядро идеи

> Хочу создать расширение для fan по интеграционной работе с Confluence. Идея — возможность читать из доступных пространств документы и создавать в настроенном пространстве доки и отчеты.

### Цель
Создать расширение для fan, обеспечивающее двустороннюю работу с Atlassian Confluence Data Center: чтение страниц из доступных пространств с конвертацией в Markdown, поиск по CQL, а также создание и обновление страниц с Markdown-контентом.

### Контекст
Разработка ИИ-инструментов для кодинга. Интеграция с Confluence позволит LLM-агенту напрямую читать техническую документацию из базы знаний команды и публиковать результаты своей работы (отчёты, спецификации, ревью) в корпоративную wiki, минуя ручное копирование.

---

## 2. Исследование

### 2.1 Проблема и аудитория

**Проблема:** Результаты работы LLM-агентов (анализы, отчёты, спецификации) остаются в локальной файловой системе или терминале. Для совместной работы в команде их нужно вручную переносить в Confluence. Обратная сторона — агент не имеет доступа к корпоративной документации, хранящейся в Confluence.

**Для кого:** Разработчики, использующие fan как основное ИИ-средство для кодинга, с корпоративной базой знаний на Confluence Data Center.

**Насколько острая:** Высокая — confirmed спрос подтверждён наличием минимум 4 MCP-серверов для Confluence, созданных в 2025-2026 годах.

### 2.2 Текущее состояние

Существующие решения для AI-интеграции с Confluence:

- **`@atlassian-dc-mcp/confluence`** (v0.19.0) — MCP-сервер специально для Confluence Data Center. Поддерживает чтение, поиск, создание страниц. Активно обновляется (последний релиз — 3 недели назад).
  URL: https://www.npmjs.com/package/@atlassian-dc-mcp/confluence

- **`atlassian-confluence-mcp-server`** (v1.3.2) — Универсальный MCP-сервер, поддерживает Cloud, Server и Data Center. TypeScript, Zod-валидация.
  URL: https://www.npmjs.com/package/atlassian-confluence-mcp-server

- **`@aashari/mcp-server-atlassian-confluence`** (v3.3.0) — MCP-сервер для Confluence с конвертацией в Markdown. Поддерживает чтение пространств, страниц и поиск по CQL.
  URL: https://www.npmjs.com/package/@aashari/mcp-server-atlassian-confluence

- **`confluence.js`** (v2.1.0) — TypeScript-клиент для Confluence REST API. Поддерживает Cloud и Server/Data Center. Полный набор методов: страницы, пространства, поиск, вложения, комментарии. Использует axios, Zod. MIT.
  URL: https://www.npmjs.com/package/confluence.js

- **`@shogobg/markdown2confluence`** (v0.1.12) — Конвертер Markdown → Confluence Storage Format на базе marked. Лёгкий (34 KB), активно обновляется.
  URL: https://www.npmjs.com/package/@shogobg/markdown2confluence

- **`showdown-confluence`** (v2.0.2) — Конвертер Markdown → Confluence Storage Format на базе showdown. BSD-3-Clause.
  URL: https://www.npmjs.com/package/showdown-confluence

- **`turndown`** — Стандартный конвертер HTML → Markdown. Используется в MCP-серверах для чтения страниц Confluence (конвертация из Storage Format).
  URL: https://github.com/mixmark-io/turndown

**Ни одно из существующих решений не является нативным расширением fan.** Все реализованы как MCP-серверы, требующие дополнительного слоя интеграции.

### 2.3 Источники исследования

| Источник | Релевантность | Ключевые выводы |
|----------|--------------|----------------|
| [Confluence REST API v2 — Page](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-group-page) | Высокая | Эндпоинты для CRUD операций со страницами, курсорная пагинация |
| [Confluence REST API v2 — Space](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/#api-group-space) | Высокая | Эндпоинты для работы с пространствами |
| [fan Extensions Documentation](/packages/coding-agent/docs/extensions.md) | Высокая | API расширений: `pi.registerTool()`, зависимости, lifecycle events |
| [confluence.js — npm](https://www.npmjs.com/package/confluence.js) | Высокая | Готовый TypeScript-клиент, 2 MB, MIT, Data Center support |
| [@atlassian-dc-mcp/confluence — npm](https://www.npmjs.com/package/@atlassian-dc-mcp/confluence) | Средняя | Подтверждает спрос, показывает подход к конвертации |
| [@shogobg/markdown2confluence — npm](https://www.npmjs.com/package/@shogobg/markdown2confluence) | Средняя | Markdown → Storage Format, лёгкая библиотека на marked |
| [showdown-confluence — npm](https://www.npmjs.com/package/showdown-confluence) | Средняя | Альтернативный конвертер на showdown |
| [Пример расширения с зависимостями](/packages/coding-agent/examples/extensions/with-deps/) | Высокая | Референс для структуры расширения с npm-зависимостями |

### 2.4 Решения, принятые в ходе исследования

| Решение | Выбор | Обоснование |
|---------|-------|-------------|
| Целевая платформа | Confluence Data Center / Server | Корпоративное окружение, self-hosted |
| Пространство для записи | Фиксированное (из конфигурации) | Простота использования, нет необходимости выбирать при каждом вызове |
| Чтение | Полное: страницы + поиск по CQL | Максимум полезности для LLM-агента |
| Формат записи | Markdown → конвертация в Storage Format | Естественный формат для LLM, расширение конвертирует |
| Аутентификация | PAT (Bearer token) | Наиболее безопасный вариант для Data Center |
| Обработка при чтении | XHTML → Markdown | Чистый Markdown лучше подходит для обработки LLM |
| Структура страниц | Иерархическая (дочерние под родителем) | Логичная организация отчётов и документации |

---

## 3. SWOT-анализ

### Strengths (Сильные стороны) 🔵
- **Готовый TypeScript-клиент** — `confluence.js` v2.1.0 полностью покрывает REST API Confluence (страницы, пространства, поиск, вложения). Поддерживает Data Center, MIT-лицензия, активно развивается (36 версий за время существования).
- **Идеальное совпадение с архитектурой fan** — Extension API предоставляет `pi.registerTool()` для регистрации инструментов, вызываемых LLM. Расширение с npm-зависимостями — стандартный паттерн (пример `with-deps/`). Доступ к `ctx` (CWD, signal, session) для контекстуализации.
- **Конвертация в обе стороны на проверенных библиотеках** — `turndown` для XHTML→Markdown (чтение), `marked` с кастомным рендерером или `@shogobg/markdown2confluence` для Markdown→Storage Format (запись). Оба подхода используются в production MCP-серверах.
- **Нет аналогов для fan** — Ниша свободна, первое расширение такого типа получит преимущество первого хода и может быть опубликовано в FAN Store.

### Weaknesses (Слабые стороны) 🟠
- **Confluence Storage Format — сложный формат** — Это не обычный XHTML. Расширенные теги: `ac:structured-macro` (макросы типа info, warning, code), `ri:page` / `ri:user` (ссылки на внутренние ресурсы), `ac:link-body`, `ac:parameter`. Полная双向 конвертация — значительная инженерная задача.
- **Размер зависимостей** — `confluence.js` (2 MB) + `turndown` + `marked` = примерно 3-4 MB. Некритично для локального runtime, но заметный размер для расширения.
- **Зависимость от версии DC** — REST API v1 может отличаться между версиями Confluence DC (7.x, 8.x, 9.x). Некоторые эндпоинты и параметры появляются или меняются между версиями.

### Opportunities (Возможности) 🟢
- **Подтверждённый спрос** — Существование 4+ MCP-серверов для Confluence, созданных за 2025-2026 годы, однозначно подтверждает потребность в AI-интеграции с корпоративной wiki.
- **Преимущество нативности перед MCP** — fan-расширение работает напрямую через tools без MCP-слоя. Меньше задержка (нет IPC), проще отладка, прямой доступ к `ctx` (текущий проект, сессия, UI-взаимодействие).
- **Публикация в FAN Store** — Готовое расширение можно упаковать и опубликовать в репозитории FAN Store для других пользователей fan.
- **Расширение функциональности** — После базового чтения/записи можно добавить: работу с вложениями, комментариями, лейблами, экспорт страниц в markdown-файлы проекта, шаблоны отчётов.

### Threats (Угрозы) 🔴
- **Atlassian может изменить API** — В 2026 году Atlassian активно продвигает Forge и Cloud. Линейка Data Center получает меньше внимания. REST API v1 может быть объявлен устаревшим в будущих версиях.
- **Rate limiting и таймауты** — Confluence DC может быть настроен с жёсткими ограничениями частоты запросов. Обработка больших документов (с макросами, вложениями) может занимать значительное время.
- **Разнообразие Storage Format** — Разные версии Confluence и разные редакторы (old editor vs new editor) генерируют Storage Format с отличиями, что усложняет обратную конвертацию.

---

## 4. Альтернативы

### 4.1 Альтернатива: Нативное расширение fan с `confluence.js`

**Суть:** Расширение для fan, использующее `confluence.js` как API-клиент. Регистрирует набор инструментов (tools) для LLM: чтение страниц, поиск, создание и обновление. Аутентификация через PAT из конфигурации расширения.

**Инструменты:**
- `confluence_list_spaces` — список доступных пространств
- `confluence_list_pages` — страницы в пространстве (с пагинацией)
- `confluence_read_page` — чтение содержимого страницы (XHTML → Markdown)
- `confluence_search` — поиск по CQL (Confluence Query Language)
- `confluence_create_page` — создание страницы (Markdown → Storage Format)
- `confluence_update_page` — обновление существующей страницы

**Плюсы:**
- Полный контроль над функциональностью и конвертацией
- Нативная интеграция с fan Extension API
- Прямой доступ к `ctx` (CWD, signal, session, UI)
- Нет промежуточных слоёв и процессов

**Минусы:**
- Нужно реализовать конвертацию Markdown↔Storage Format
- Объёмный код (расширение с несколькими модулями)
- Зависимость от `confluence.js` (~2 MB)

| Параметр | Оценка |
|----------|--------|
| Сложность | Средняя |
| Время реализации | 16–24 часа |
| Риски | Конвертация форматов, совместимость версий DC |

### 4.2 Альтернатива: Обёртка над MCP-сервером

**Суть:** Использовать существующий MCP-сервер `@atlassian-dc-mcp/confluence` (v0.19.0). Расширение fan запускает MCP-сервер как subprocess и транслирует вызовы инструментов.

**Плюсы:**
- Минимум кода (только мост fan ↔ MCP)
- Уже реализованная конвертация форматов
- Готовые инструменты для чтения, поиска, создания

**Минусы:**
- Дополнительный процесс в памяти (MCP-сервер)
- Сложность отладки (два процесса, IPC)
- Жёсткая зависимость от стороннего MCP-сервера
- Меньше контроля над поведением и ошибками
- MCP overhead (сериализация/десериализация)

| Параметр | Оценка |
|----------|--------|
| Сложность | Низкая-Средняя |
| Время реализации | 8–12 часов |
| Риски | Стабильность MCP-моста, обновления стороннего пакета |

### 4.3 Альтернатива: Прямые HTTP-запросы без библиотеки

**Суть:** Расширение делает HTTP-запросы через встроенный `fetch` напрямую к REST API v1 Confluence Data Center. Без использования `confluence.js`.

**Плюсы:**
- Минимальный размер зависимостей (только конвертеры)
- Полный контроль над форматом запросов
- Нет внешних зависимостей от API-обёрток

**Минусы:**
- Нужно вручную реализовать пагинацию, обработку ошибок, все эндпоинты
- Больше boilerplate-кода
- Нет типизации ответов API
- Сложнее поддержка при изменениях API

| Параметр | Оценка |
|----------|--------|
| Сложность | Средняя-Высокая |
| Время реализации | 20–30 часов |
| Риски | Ручная поддержка API, отсутствие типизации |

### 4.4 Сравнительная матрица

| Критерий | Альт. 1: Нативное | Альт. 2: MCP-обёртка | Альт. 3: Прямой HTTP |
|----------|:---:|:---:|:---:|
| Совместимость с fan | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Скорость разработки | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| Производительность | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Поддерживаемость | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Минимальный размер | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Гибкость и контроль | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Качество конвертации | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Итого** | **27/30** | **21/30** | **24/30** |

---

## 5. Риски

| Риск | Вероятность | Влияние | Митигация |
|------|:-----------:|:-------:|-----------|
| Сложная конвертация Storage Format для макросов | Высокая | Среднее | Начать с базовой поддержки (заголовки, списки, таблицы, код, ссылки), макросы — отдельная итерация |
| Несовместимость REST API между версиями DC | Средняя | Среднее | Явно указывать поддерживаемые версии, добавить логирование версии при подключении |
| Rate limiting со стороны Confluence DC | Средняя | Низкое | Добавить задержки между запросами, кэшировать результаты, batch-операции |
| Большие документы вызывают таймаут | Низкая | Среднее | Streaming-ответы через `onUpdate`, настраиваемый таймаут в `pi.exec()` |
| PAT недоступен в старых версиях DC | Низкая | Высокое | Предусмотреть fallback на Basic Auth как опцию конфигурации |

---

## 6. Рекомендация

### Что делать: Нативное расширение fan с `confluence.js`

**Уверенность:** 0.85/1.0

**Обоснование:**
1. **Архитектурное совпадение** — Extension API fan создан именно для таких интеграций: набор инструментов для LLM, npm-зависимости, TypeScript, доступ к контексту сессии. Расширение с `confluence.js` — естественный и правильный паттерн.
2. **Зрелая библиотека** — `confluence.js` v2.1.0 покрывает весь REST API Confluence Data Center, включая пагинацию и обработку ошибок. Устраняет необходимость писать boilerplate.
3. **Ниша свободна** — Нет ни одного fan-расширения для Confluence. Первое решение получит преимущество и может быть опубликовано в FAN Store.
4. **MCP-обёртка — худший выбор** — Добавляет ненужный слой абстракции (subprocess + IPC), зависимость от стороннего проекта, сложность отладки. При этом не даёт преимуществ, которые компенсировали бы эти недостатки.

**Компромиссы:**
- Принимаем: размер зависимостей ~3-4 MB — некритично для локального runtime
- Принимаем: необходимость написать конвертацию Markdown↔Storage Format — решаемо, начинаем с базового подмножества
- Отклоняем: поддержку Confluence Cloud в первой версии — фокус на Data Center, Cloud добавляется позже через конфигурацию baseUrl

**Предупреждения:**
- ⚠️ **Конвертация Storage Format — самая сложная часть.** Рекомендую MVP-подход: сначала базовая поддержка (заголовки, параграфы, списки, таблицы, блоки кода, жирный/курсивный, ссылки, изображения). Макросы (info, warning, panel, expand), mention'ы и Jira-линки — во второй итерации.
- ⚠️ **PAT для Data Center** — убедитесь, что ваша версия DC поддерживает Personal Access Tokens (доступны с DC 7.12+). Для более старых версий потребуется fallback на Basic Auth.

---

## 7. План действий

### Приоритеты (MoSCoW)

**Must Have (Обязательно для MVP):**
- [ ] Настройка: baseUrl, PAT, spaceKey, defaultParentId
- [ ] Инструмент `confluence_list_spaces` — список доступных пространств
- [ ] Инструмент `confluence_list_pages` — список страниц в пространстве
- [ ] Инструмент `confluence_read_page` — чтение страницы (XHTML → Markdown)
- [ ] Инструмент `confluence_search` — поиск по CQL
- [ ] Инструмент `confluence_create_page` — создание страницы (Markdown → Storage Format)
- [ ] Базовая конвертация Markdown → Storage Format (заголовки, списки, таблицы, код, ссылки, форматирование)

**Should Have (Желательно):**
- [ ] Инструмент `confluence_update_page` — обновление существующей страницы
- [ ] Расширенная конвертация: макросы (info, warning, code, panel), mention'ы
- [ ] Slash-команда `/confluence` для быстрой настройки и проверки подключения
- [ ] Кэширование результатов чтения в рамках сессии

**Could Have (Возможно в будущем):**
- [ ] Работа с вложениями (загрузка/скачивание файлов)
- [ ] Работа с комментариями
- [ ] Работа с лейблами (тегирование страниц)
- [ ] Шаблоны документов (преднастроенные форматы отчётов)
- [ ] Поддержка Confluence Cloud (базовая совместимость)

**Won't Have (Не входит в scope):**
- [ ] Поддержка Confluence Server (pre-DC) — устаревшая платформа
- [ ] Создание и управление пространствами — делается вручную через UI
- [ ] Конвертация ADF (Atlassian Document Format) — используется только в Cloud

### Шаги реализации

| # | Действие | Зависимости | Срок | Статус |
|---|----------|-------------|------|--------|
| 1 | Структура расширения: `package.json`, `index.ts`, модули | — | 1 час | TODO |
| 2 | Конфигурация: загрузка baseUrl, PAT, spaceKey из env/файла | — | 1 час | TODO |
| 3 | Инициализация клиента `confluence.js`, проверка подключения | #2 | 1 час | TODO |
| 4 | Конвертер Markdown → Storage Format (базовый) | — | 4 часа | TODO |
| 5 | Конвертер Storage Format → Markdown (через turndown) | — | 2 часа | TODO |
| 6 | Инструмент `confluence_list_spaces` | #3 | 1 час | TODO |
| 7 | Инструмент `confluence_list_pages` | #3 | 1 час | TODO |
| 8 | Инструмент `confluence_read_page` | #3, #5 | 2 часа | TODO |
| 9 | Инструмент `confluence_search` | #3 | 2 часа | TODO |
| 10 | Инструмент `confluence_create_page` | #3, #4 | 2 часа | TODO |
| 11 | Инструмент `confluence_update_page` | #10 | 1 час | TODO |
| 12 | Slash-команда `/confluence` для диагностики | #3 | 1 час | TODO |
| 13 | Тестирование на реальном экземпляре DC | #6-#12 | 2 часа | TODO |
| 14 | Документация и публикация в FAN Store | #13 | 2 часа | TODO |

**Итого:** ~23 часа для полного MVP с документацией

---

## 8. Техническая архитектура

### Структура расширения

```
~/.fan/agent/extensions/fan-confluence/
├── package.json
├── index.ts                    # Точка входа, регистрация инструментов
├── config.ts                   # Загрузка и валидация конфигурации
├── client.ts                   # Инициализация confluence.js клиента
├── converters/
│   ├── md-to-storage.ts        # Markdown → Confluence Storage Format
│   └── storage-to-md.ts        # Storage Format → Markdown (turndown)
└── tools/
    ├── list-spaces.ts          # confluence_list_spaces
    ├── list-pages.ts           # confluence_list_pages
    ├── read-page.ts            # confluence_read_page
    ├── search.ts               # confluence_search
    ├── create-page.ts          # confluence_create_page
    └── update-page.ts          # confluence_update_page
```

### Стек технологий

| Компонент | Технология | Обоснование |
|-----------|-----------|-------------|
| API-клиент Confluence | `confluence.js` v2.1.0 | Зрелый TypeScript-клиент, поддержка DC, полный REST API |
| Markdown → Storage Format | `marked` + кастомный renderer | Гибкость, TypeScript, активная разработка |
| Storage Format → Markdown | `turndown` + плагин GFM | Стандарт де-факто для HTML→Markdown, хорошо работает с XHTML |
| Схемы параметров | `@sinclair/typebox` | Стандарт fan-расширений для валидации параметров инструментов |
| HTTP | `axios` (через confluence.js) | Уже включён в зависимости confluence.js |

### Конфигурация

Расширение читает конфигурацию из файла `~/.fan/agent/extensions/fan-confluence/.env` или переменных окружения:

```
CONFLUENCE_BASE_URL=https://confluence.example.com
CONFLUENCE_PAT=xxxxxxxxxxxxxxxx
CONFLUENCE_SPACE_KEY=DEV
CONFLUENCE_DEFAULT_PARENT_ID=12345    # опционально
```

### API инструментов (набросок)

```typescript
// confluence_list_spaces
pi.registerTool({
  name: "confluence_list_spaces",
  label: "Confluence: List Spaces",
  description: "Список доступных пространств Confluence",
  parameters: Type.Object({
    limit: Type.Optional(Type.Integer({ default: 25, description: "Максимум результатов" })),
  }),
  // ...
});

// confluence_search
pi.registerTool({
  name: "confluence_search",
  label: "Confluence: Search",
  description: "Поиск по страницам Confluence с использованием CQL",
  parameters: Type.Object({
    cql: Type.String({ description: "Confluence Query Language запрос" }),
    limit: Type.Optional(Type.Integer({ default: 25 })),
  }),
  // ...
});

// confluence_create_page
pi.registerTool({
  name: "confluence_create_page",
  label: "Confluence: Create Page",
  description: "Создание страницы в Confluence из Markdown-контента",
  parameters: Type.Object({
    title: Type.String({ description: "Заголовок страницы" }),
    content: Type.String({ description: "Содержимое в Markdown" }),
    parent_id: Type.Optional(Type.Integer({ description: "ID родительской страницы (иерархия)" })),
  }),
  // ...
});
```

### Интеграция

Расширение устанавливается в стандартную директорию fan-расширений и автоматически обнаруживается при запуске. Никаких дополнительных настроек fan не требуется — расширение сам инициализирует подключение к Confluence при первом вызове инструмента.

---

## 9. Приложения

### Дополнительные материалы
- [Confluence REST API v2 — Pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-group-page) — справочник эндпоинтов для страниц
- [Confluence REST API v2 — Spaces](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/#api-group-space) — справочник эндпоинтов для пространств
- [confluence.js — документация](https://mrrefactoring.github.io/confluence.js) — документация TypeScript-клиента
- [fan Extensions Documentation](/packages/coding-agent/docs/extensions.md) — документация Extension API fan
- [Пример расширения с зависимостями](/packages/coding-agent/examples/extensions/with-deps/) — референс структуры

### Глоссарий
| Термин | Определение |
|--------|------------|
| Confluence Data Center | Self-hosted версия Confluence для корпоративного развёртывания |
| Storage Format | XHTML-подобный формат хранения контента в Confluence с Atlassian-специфичными тегами (`ac:`, `ri:`) |
| CQL | Confluence Query Language — язык запросов для поиска по содержимому Confluence |
| PAT | Personal Access Token — персональный токен доступа для аутентификации в API |
| MCP | Model Context Protocol — протокол для взаимодействия AI-ассистентов с внешними инструментами |
| fan extension | TypeScript-модуль, расширяющий функциональность fan через Extension API |
| tool | Инструмент, зарегистрированный расширением через `pi.registerTool()`, вызываемый LLM |
| турндаун | Библиотека turndown для конвертации HTML/XHTML в Markdown |

---

*Создано: idea-lab skill*
*Глубина: Стандартный*
*Исходный запрос: «хочу создать расширение для fan по интеграционной работе с confluence. Идея — возможность читать из доступных пространств документы и создавать в настроенном пространстве доки и отчеты.»*
