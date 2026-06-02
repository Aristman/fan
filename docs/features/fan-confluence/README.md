# fan-confluence — Расширение fan для Confluence Data Center

## Обзор

Расширение для fan, обеспечивающее двустороннюю работу с Atlassian Confluence Data Center. LLM-агент получает 6
инструментов: чтение страниц, поиск по CQL, создание и обновление страниц. Конвертация Markdown ↔ Confluence Storage
Format выполняется автоматически.

## Исходная спецификация

[Расширение fan для Confluence — исследование](../../research/idea-lab/confluence-extension/Расширение fan для
Confluence — исследование.md) — результат исследования Idea Lab, содержащий SWOT, альтернативы, архитектуру и план
действий.

## Структура

```
docs/features/fan-confluence/
└── roadmaps/
    ├── roadmap-main.md              ← Основной roadmap с архитектурой
    ├── roadmap-stage-1-foundation.md ← Каркас, конфигурация, подключение
    ├── roadmap-stage-2-read.md       ← 4 инструмента чтения, конвертер S→MD
    ├── roadmap-stage-3-write.md      ← 2 инструмента записи, конвертер M→S
    └── roadmap-stage-4-polish.md     ← Ошибки, кэш, документация
```

## Быстрые ссылки

| Документ                                                                | Содержание                                                |
|-------------------------------------------------------------------------|-----------------------------------------------------------|
| [roadmap-main.md](roadmaps/roadmap-main.md)                             | Общая архитектура, этапы, риски, критерии успеха          |
| [roadmap-stage-1-foundation.md](roadmaps/roadmap-stage-1-foundation.md) | Каркас расширения, package.json, конфигурация, API-клиент |
| [roadmap-stage-2-read.md](roadmaps/roadmap-stage-2-read.md)             | Конвертер Storage→MD, 4 инструмента чтения                |
| [roadmap-stage-3-write.md](roadmaps/roadmap-stage-3-write.md)           | Конвертер MD→Storage, 2 инструмента записи, /confluence   |
| [roadmap-stage-4-polish.md](roadmaps/roadmap-stage-4-polish.md)         | Обработка ошибок, кэш, README, FAN Store                  |

## Текущий статус

**Запланировано.** Основная ветка: `feature/fan-confluence`.

| Этап          | Статус    |
|---------------|-----------|
| 1. foundation | ⏳ Pending |
| 2. read       | ⏳ Pending |
| 3. write      | ⏳ Pending |
| 4. polish     | ⏳ Pending |

## Стек

| Компонент             | Технология                         |
|-----------------------|------------------------------------|
| API-клиент Confluence | `confluence.js` v2.1.0             |
| Storage → Markdown    | `turndown` + `turndown-plugin-gfm` |
| Markdown → Storage    | `marked` + кастомный renderer      |
| Схемы параметров      | `@sinclair/typebox`                |
| Платформа             | fan Extension API (TypeScript)     |

## Инструменты (6 шт.)

| Инструмент               | Описание                               | Этап |
|--------------------------|----------------------------------------|:----:|
| `confluence_list_spaces` | Список доступных пространств           |  2   |
| `confluence_list_pages`  | Страницы в пространстве (с пагинацией) |  2   |
| `confluence_read_page`   | Чтение страницы (XHTML → Markdown)     |  2   |
| `confluence_search`      | Поиск по CQL                           |  2   |
| `confluence_create_page` | Создание страницы (Markdown → Storage) |  3   |
| `confluence_update_page` | Обновление страницы                    |  3   |
