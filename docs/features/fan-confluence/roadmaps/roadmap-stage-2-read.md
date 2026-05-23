# Этап 2: Read

## Метаданные
- **Номер этапа:** 2
- **Подветка:** feature/fan-confluence/stage-2-read
- **Основная ветка:** feature/fan-confluence
- **Зависимости:** Этап 1 (foundation) — конфигурация и клиент
- **Результат этапа:** LLM-агент может читать страницы из Confluence: список пространств, список страниц, содержимое страницы (в Markdown), поиск по CQL

## Цель этапа

Реализовать четыре инструмента для чтения данных из Confluence Data Center и конвертер Storage Format → Markdown. Инструменты позволяют LLM-агенту получать контекст из корпоративной wiki в формате, пригодном для обработки.

## Блочная диаграмма этапа

```
┌─ Stage 2: Read ───────────────────────────────────────┐
│                                                        │
│  INPUT: config.ts, client.ts (из этапа 1)             │
│                                                        │
│  ┌──────────────────────────┐                          │
│  │  converters/             │                          │
│  │  storage-to-md.ts        │                          │
│  │  ├─ turndown init        │                          │
│  │  ├─ GFM plugin           │                          │
│  │  ├─ ac:link rule         │                          │
│  │  └─ code macro rule      │                          │
│  └──────────┬───────────────┘                          │
│             │                                           │
│  ┌──────────▼───────────┐ ┌────────────────────────┐  │
│  │  tools/read/         │ │  Confluence DC API     │  │
│  │                      │ │                        │  │
│  │  list-spaces.ts  ────┼→│  GET /space            │  │
│  │  list-pages.ts   ────┼→│  GET /content?spaceKey │  │
│  │  read-page.ts    ────┼→│  GET /content/{id}     │  │
│  │  search.ts       ────┼→│  GET /search?cql=      │  │
│  └──────────────────────┘ └────────────────────────┘  │
│             │                                           │
│             ▼                                           │
│  Storage Format (XHTML) ──→ turndown ──→ Markdown      │
│                                                        │
│  OUTPUT: 4 инструмента для чтения, конвертер S→MD     │
│  SMOKE: LLM читает страницу и получает Markdown        │
└────────────────────────────────────────────────────────┘
```

## TDD-подход

> **Важно:** Отмечайте пункты этого чеклиста по мере выполнения работы. Это ваш живый трекер прогресса этапа.

### Red — Определение тестов

- [ ] Unit-тест `storage-to-md.ts`: конвертация простого параграфа — `<p>text</p>` → `text`
- [ ] Unit-тест `storage-to-md.ts`: заголовки — `<h1>Title</h1>` → `# Title`
- [ ] Unit-тест `storage-to-md.ts`: список — `<ul><li>item</li></ul>` → `- item`
- [ ] Unit-тест `storage-to-md.ts`: таблица — `table/tr/td` → Markdown-таблица (через GFM plugin)
- [ ] Unit-тест `storage-to-md.ts`: блок кода — `<ac:structured-macro ac:name="code">` → ```code block```
- [ ] Unit-тест `storage-to-md.ts`: `ac:link` с `ri:page` → `[Page Title](/wiki/spaces/PAGE/pages/123)`
- [ ] Unit-тест `storage-to-md.ts`: жирный/курсивный — `<strong>/<em>` → `**bold`/`*italic*`
- [ ] Unit-тест `list-spaces.ts`: возвращает массив объектов с полями `key`, `name`, `id`
- [ ] Unit-тест `list-pages.ts`: пагинация — корректная обработка `limit` и `start`
- [ ] Unit-тест `read-page.ts`: возвращает `{title, space, id, content, url, version}`
- [ ] Unit-тест `search.ts`: CQL-запрос передаётся в API, результаты конвертируются
- [ ] Integration-тест: полный цикл — API-вызов → Storage Format → Markdown
- [ ] Smoke-тест: `/confluence` показывает список пространств

### Green — Реализация

- [ ] Создать `converters/storage-to-md.ts`:
  - Инициализация turndown с правилом по умолчанию
  - Подключение `turndown-plugin-gfm` для таблиц, зачёркнутого текста, task-листов
  - Кастомное правило для `ac:structured-macro[ac:name="code"]` → блок кода с языком
  - Кастомное правило для `ac:link` → Markdown-ссылка (извлечение `ri:content-title` или текста)
  - Кастомное правило для `ac:structured-macro[ac:name="info|warning|note|tip"]` → blockquote
  - Функция `convertStorageToMarkdown(html: string): string`
- [ ] Создать `tools/list-spaces.ts`:
  - Регистрация `confluence_list_spaces` через `pi.registerTool()`
  - Параметры: `limit` (default: 25)
  - Использование `client.space.getSpaces({ limit })`
  - Возврат: массив `{id, key, name, type}`
- [ ] Создать `tools/list-pages.ts`:
  - Регистрация `confluence_list_pages`
  - Параметры: `space_key` (default из конфига), `limit` (default: 25), `title` (опциональный фильтр)
  - Использование `client.content.getContent({ spaceKey, title, limit, start })`
  - Возврат: массив `{id, title, type, version}`
- [ ] Создать `tools/read-page.ts`:
  - Регистрация `confluence_read_page`
  - Параметры: `page_id` (Integer, обязательно) или `title` (String, поиск по заголовку)
  - Загрузка содержимого через `client.content.getContentById({ id })`
  - Извлечение Storage Format из `body.storage.value`
  - Конвертация через `convertStorageToMarkdown()`
  - Возврат: Markdown с метаданными (заголовок, пространство, URL, версия)
- [ ] Создать `tools/search.ts`:
  - Регистрация `confluence_search`
  - Параметры: `cql` (String, обязательно), `limit` (default: 25)
  - Использование `client.search.search({ cql, limit })`
  - Возврат: список результатов `{title, excerpt, space, url, id}`
- [ ] Обновить `index.ts` — импортировать и зарегистрировать все 4 инструмента
- [ ] Все тесты проходят (Red → Green)

### Refactor — Улучшение

- [ ] Вынести общий код API-вызовов в `client.ts` (обёртки с обработкой ошибок)
- [ ] Добавить форматирование результата: заголовок + метаданные + содержимое для read_page
- [ ] Ограничить длину содержимого для больших страниц (truncation с уведомлением)
- [ ] Тесты всё ещё проходят после рефакторинга
- [ ] Smoke-тесты этапа 1 не сломаны

## Ветвление и слияние (worktree для этапа)

1. Переключиться на основную ветку: `git checkout feature/fan-confluence`
2. Создать worktree этапа: `git worktree add .wt/fan-confluence/stage-2-read -b feature/fan-confluence/stage-2-read`
3. Переключиться в worktree этапа: `cd .wt/fan-confluence/stage-2-read`
4. Реализация (TDD-цикл, отмечать чеклисты в этом файле)
5. Smoke-тестирование всего проекта
6. Обновить чеклисты этого файла (отметить выполненные пункты)
7. Обновление документации (roadmap-main, guides)
8. Code review
9. Merge подветки в основную: `cd <project-root> && git checkout feature/fan-confluence` → `git merge --no-ff feature/fan-confluence/stage-2-read`
10. Удалить worktree этапа: `git worktree remove .wt/fan-confluence/stage-2-read`
11. После завершения **всех** этапов — пользователь самостоятельно выполняет merge `feature/fan-confluence` в целевую ветку

## Smoke-тесты этапа (обязательные)

| # | Проверка | Команда / Действие | Ожидаемый результат |
|---|----------|--------------------|---------------------|
| 1 | Список пространств | Попросить LLM: «Покажи доступные пространства в Confluence» | LLM вызывает `confluence_list_spaces`, возвращает список с ключами и названиями |
| 2 | Список страниц | Попросить LLM: «Список страниц в пространстве DEV» | LLM вызывает `confluence_list_pages`, возвращает страницы с заголовками |
| 3 | Чтение страницы | Попросить LLM: «Прочитай страницу [ID] из Confluence» | LLM вызывает `confluence_read_page`, возвращает Markdown-содержимое |
| 4 | Поиск | Попросить LLM: «Найди страницы про API в Confluence» | LLM вызывает `confluence_search` с CQL, возвращает результаты |
| 5 | Конвертация Storage→Markdown | Прочитать страницу с таблицей и кодом | Markdown содержит корректную таблицу и блок кода |
| 6 | Предыдущий этап | `/confluence` команда | Статус подключения по-прежнему работает |

## Критерии завершения этапа

- [ ] Все unit-тесты конвертера `storage-to-md.ts` проходят
- [ ] Все unit-тесты инструментов чтения проходят
- [ ] Все smoke-тесты этапа проходят
- [ ] Smoke-тесты этапа 1 не сломаны
- [ ] Все пункты TDD-чеклиста отмечены
- [ ] Подветка `feature/fan-confluence/stage-2-read` смержена в `feature/fan-confluence`
- [ ] Code review пройден
- [ ] Статус этапа обновлён в roadmap-main

## Обновление roadmap-stage

> По мере выполнения работы отмечайте пункты чеклистов прямо в этом файле.
> Это ваш живой трекер прогресса — обновляйте его после каждого значимого шага.

## Обновление roadmap-main

После завершения этапа обновить статус в [roadmap-main.md](roadmap-main.md):
- [x] Этап 2: read — Completed
