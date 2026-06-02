# Этап 3: Write

## Метаданные
- **Номер этапа:** 3
- **Подветка:** feature/fan-confluence/stage-3-write
- **Основная ветка:** feature/fan-confluence
- **Зависимости:** Этап 1 (foundation), Этап 2 (read) — клиент и конвертер
- **Результат этапа:** LLM-агент может создавать и обновлять страницы в Confluence, передавая Markdown-контент, который расширение конвертирует в Storage Format. Команда `/confluence` выводит полный статус.

## Цель этапа

Реализовать два инструмента для записи данных в Confluence Data Center и конвертер Markdown → Confluence Storage Format. Инструменты позволяют LLM-агенту публиковать отчёты, спецификации и результаты анализа в корпоративную wiki.

## Блочная диаграмма этапа

```
┌─ Stage 3: Write ──────────────────────────────────────┐
│                                                        │
│  INPUT: config.ts, client.ts, converters/ (этапы 1-2)  │
│                                                        │
│  ┌──────────────────────────┐                          │
│  │  converters/             │                          │
│  │  md-to-storage.ts        │                          │
│  │  ├─ marked init          │                          │
│  │  ├─ кастомный renderer   │                          │
│  │  ├─ h1-h6               │                          │
│  │  ├─ lists (ul/ol/task)   │                          │
│  │  ├─ tables               │                          │
│  │  ├─ code blocks          │                          │
│  │  ├─ bold/italic/strike   │                          │
│  │  ├─ links + images       │                          │
│  │  └─ blockquotes          │                          │
│  └──────────┬───────────────┘                          │
│             │                                           │
│  ┌──────────▼───────────┐ ┌────────────────────────┐  │
│  │  tools/write/        │ │  Confluence DC API     │  │
│  │                      │ │                        │  │
│  │  create-page.ts  ────┼→│  POST /content          │  │
│  │  update-page.ts  ────┼→│  PUT /content/{id}      │  │
│  └──────────────────────┘ └────────────────────────┘  │
│             │                                           │
│             ▼                                           │
│  Markdown ──→ marked ──→ Storage Format (XHTML)        │
│                                                        │
│  OUTPUT: 2 инструмента записи, конвертер M→S, /confluence
│  SMOKE: LLM создаёт страницу из Markdown               │
└────────────────────────────────────────────────────────┘
```

## TDD-подход

> **Важно:** Отмечайте пункты этого чеклиста по мере выполнения работы. Это ваш живый трекер прогресса этапа.

### Red — Определение тестов

- [ ] Unit-тест `md-to-storage.ts`: заголовок — `# Title` → `<h1>Title</h1>`
- [ ] Unit-тест `md-to-storage.ts`: список — `- item` → `<ul><li>item</li></ul>`
- [ ] Unit-тест `md-to-storage.ts`: нумерованный список — `1. item` → `<ol><li>item</li></ol>`
- [ ] Unit-тест `md-to-storage.ts`: таблица GFM → `<table><tr><th>...</th></tr><tr><td>...</td></tr></table>`
- [ ] Unit-тест `md-to-storage.ts`: блок кода — ` ```ts ` → `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[...]]></ac:plain-text-body></ac:structured-macro>`
- [ ] Unit-тест `md-to-storage.ts`: жирный/курсивный — `**bold**` / `*italic*` → `<strong>` / `<em>`
- [ ] Unit-тест `md-to-storage.ts`: ссылка — `[text](url)` → `<a href="url">text</a>`
- [ ] Unit-тест `md-to-storage.ts`: изображение — `![alt](url)` → `<ac:image><ri:url ri:value="url" ri:filename="alt"/></ac:image>`
- [ ] Unit-тест `md-to-storage.ts`: blockquote — `> text` → `<blockquote><p>text</p></blockquote>`
- [ ] Unit-тест `md-to-storage.ts`: вложенный список — корректная вложенность `<ul>/<li>/<ul>`
- [ ] Unit-тест `create-page.ts`: корректный вызов API с spaceKey, title, body (Storage Format), parentId
- [ ] Unit-тест `create-page.ts`: создание без parentId — страница в корне пространства
- [ ] Unit-тест `create-page.ts`: создание с parentId — дочерняя страница
- [ ] Unit-тест `update-page.ts`: обновление content по ID с increment version
- [ ] Smoke-тест: LLM создаёт страницу и получает URL созданной страницы

### Green — Реализация

- [ ] Создать `converters/md-to-storage.ts`:
  - Инициализация `marked` с `renderer` и `extensions` (GFM: tables, strikethrough, task lists)
  - Переопределить `renderer.heading()` → `<h1>...<h6>`
  - Переопределить `renderer.list()` / `renderer.listitem()` → `<ul>/<ol>/<li>`
  - Переопределить `renderer.table()` → `<table><thead><tr><th>...<tbody><tr><td>...`
  - Переопределить `renderer.code()` → `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">{lang}</ac:parameter><ac:plain-text-body><![CDATA[{text}]]></ac:plain-text-body></ac:structured-macro>`
  - Переопределить `renderer.strong()` / `renderer.em()` / `renderer.del()`
  - Переопределить `renderer.link()` → `<a href="...">...</a>`
  - Переопределить `renderer.image()` → `<ac:image><ri:url ri:value="..."/></ac:image>`
  - Переопределить `renderer.blockquote()` → `<blockquote>...</blockquote>`
  - Обёртка: `<p>` для plain text, `<div>` для всего body
  - Функция `convertMarkdownToStorage(markdown: string): string`
- [ ] Создать `tools/create-page.ts`:
  - Регистрация `confluence_create_page`
  - Параметры: `title` (String, обязательно), `content` (String, обязательно, Markdown), `parent_id` (Integer, опционально)
  - Конвертация Markdown → Storage Format через `convertMarkdownToStorage()`
  - Вызов `client.content.createContent({ spaceKey, title, body: { storage: { value, representation: "storage" } }, ancestors: parentId ? [{ id: parentId }] : undefined, type: "page", status: "current" })`
  - Возврат: `{id, title, url, space, version}` созданной страницы
- [ ] Создать `tools/update-page.ts`:
  - Регистрация `confluence_update_page`
  - Параметры: `page_id` (Integer, обязательно), `title` (String, опционально — обновление заголовка), `content` (String, обязательно, Markdown)
  - Чтение текущей версии страницы (для version increment)
  - Конвертация Markdown → Storage Format
  - Вызов `client.content.updateContentById({ id, title, body, version: { number: currentVersion + 1 } })`
  - Возврат: `{id, title, url, version}` обновлённой страницы
- [ ] Обновить `index.ts` — импортировать и зарегистрировать create_page и update_page
- [ ] Все тесты проходят (Red → Green)

### Refactor — Улучшение

- [ ] Добавить в `/confluence` вывод: количество зарегистрированных инструментов, целевое пространство, версия DC
- [ ] Добавить информативные сообщения при успешном создании/обновлении (URL созданной страницы)
- [ ] Обработать дублирование заголовков — при создании страницы с существующим title вернуть предупреждение
- [ ] Тесты всё ещё проходят после рефакторинга
- [ ] Smoke-тесты этапов 1-2 не сломаны

## Ветвление и слияние (worktree для этапа)

1. Переключиться на основную ветку: `git checkout feature/fan-confluence`
2. Создать worktree этапа: `git worktree add .wt/fan-confluence/stage-3-write -b feature/fan-confluence/stage-3-write`
3. Переключиться в worktree этапа: `cd .wt/fan-confluence/stage-3-write`
4. Реализация (TDD-цикл, отмечать чеклисты в этом файле)
5. Smoke-тестирование всего проекта
6. Обновить чеклисты этого файла (отметить выполненные пункты)
7. Обновление документации (roadmap-main, guides)
8. Code review
9. Merge подветки в основную: `cd <project-root> && git checkout feature/fan-confluence` → `git merge --no-ff feature/fan-confluence/stage-3-write`
10. Удалить worktree этапа: `git worktree remove .wt/fan-confluence/stage-3-write`
11. После завершения **всех** этапов — пользователь самостоятельно выполняет merge `feature/fan-confluence` в целевую ветку

## Smoke-тесты этапа (обязательные)

| # | Проверка | Команда / Действие | Ожидаемый результат |
|---|----------|--------------------|---------------------|
| 1 | Создание страницы | Попросить LLM: «Создай страницу "Тест" с содержимым "Привет" в Confluence» | Страница создана в настроенном пространстве, URL возвращён |
| 2 | Создание дочерней страницы | Попросить LLM: «Создай страницу "Подстраница" под родителем [ID]» | Дочерняя страница создана под указанным родителем |
| 3 | Обновление страницы | Попросить LLM: «Обнови страницу [ID], добавив текст "Обновлено"» | Содержимое страницы обновлено, версия инкрементирована |
| 4 | Конвертация таблицы | Создать страницу с Markdown-таблицей | Страница в Confluence содержит корректную таблицу |
| 5 | Конвертация кода | Создать страницу с блоком кода ` ```typescript ` | Конфлюенс-макрос code с подсветкой |
| 6 | `/confluence` статус | Выполнить `/confluence` | Показаны все 6 инструментов, статус подключения, пространство |
| 7 | Предыдущие этапы | Прочитать страницу из Confluence | Чтение по-прежнему работает корректно |

## Критерии завершения этапа

- [ ] Все unit-тесты конвертера `md-to-storage.ts` проходят
- [ ] Все unit-тесты инструментов записи проходят
- [ ] Все smoke-тесты этапа проходят
- [ ] Smoke-тесты этапов 1-2 не сломаны
- [ ] Все пункты TDD-чеклиста отмечены
- [ ] Подветка `feature/fan-confluence/stage-3-write` смержена в `feature/fan-confluence`
- [ ] Code review пройден
- [ ] Статус этапа обновлён в roadmap-main

## Обновление roadmap-stage

> По мере выполнения работы отмечайте пункты чеклистов прямо в этом файле.
> Это ваш живый трекер прогресса — обновляйте его после каждого значимого шага.

## Обновление roadmap-main

После завершения этапа обновить статус в [roadmap-main.md](roadmap-main.md):
- [x] Этап 3: write — Completed
