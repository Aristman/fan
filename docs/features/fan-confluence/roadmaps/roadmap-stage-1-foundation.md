# Этап 1: Foundation

## Метаданные
- **Номер этапа:** 1
- **Подветка:** feature/fan-confluence/stage-1-foundation
- **Основная ветка:** feature/fan-confluence
- **Зависимости:** Нет (первый этап)
- **Результат этапа:** Расширение fan-confluence загружается в fan, подключается к Confluence Data Center через PAT, проверяет доступность API

## Цель этапа

Создать каркас расширения fan-confluence: структура директорий, файл `package.json` с зависимостями, модули конфигурации и API-клиента. Расширение должно загружаться в fan без ошибок и уметь проверять подключение к Confluence Data Center.

## Блочная диаграмма этапа

```
┌─ Stage 1: Foundation ────────────────────────────────┐
│                                                       │
│  INPUT: npm, fan Extension API, .env с конфигурацией  │
│                                                       │
│  ┌─────────────┐      ┌───────────────────────┐      │
│  │ package.json│─────→│ npm install            │      │
│  │ (зависимости)│     │ confluence.js           │      │
│  └─────────────┘      │ turndown                │      │
│                       │ turndown-plugin-gfm     │      │
│  ┌─────────────┐      │ marked                  │      │
│  │ config.ts   │      └───────────────────────┘      │
│  │ ├─ load()   │                                     │
│  │ ├─ validate │      ┌───────────────────────┐      │
│  │ └─ types    │─────→│ client.ts              │      │
│  └─────────────┘      │ ├─ initClient()        │      │
│                       │ ├─ PAT auth header     │      │
│  ┌─────────────┐      │ └─ healthCheck()       │      │
│  │ index.ts    │─────→│                        │      │
│  │ (заглушка,  │      └───────────────────────┘      │
│  │  /confluence│                                     │
│  │  команда)   │                                     │
│  └─────────────┘                                     │
│                                                       │
│  OUTPUT: Работающее расширение с подключением к DC    │
│  SMOKE: fan → /confluence → "Connected: OK"          │
└───────────────────────────────────────────────────────┘
```

## TDD-подход

> **Важно:** Отмечайте пункты этого чеклиста по мере выполнения работы. Это ваш живой трекер прогресса этапа.

### Red — Определение тестов

- [ ] Unit-тест `config.ts`: валидация загруженной конфигурации — корректные значения проходят, отсутствующие поля выбрасывают ошибку с описанием
- [ ] Unit-тест `config.ts`: парсинг переменных окружения — `CONFLUENCE_BASE_URL` без trailing slash нормализуется
- [ ] Unit-тест `config.ts`: опциональное поле `CONFLUENCE_DEFAULT_PARENT_ID` — absence не вызывает ошибку
- [ ] Unit-тест `client.ts`: `initClient()` создаёт экземпляр Confluence с корректным baseUrl и заголовком Authorization
- [ ] Unit-тест `client.ts`: `healthCheck()` возвращает `true` при успешном ответе от `/rest/api/space`
- [ ] Unit-тест `client.ts`: `healthCheck()` возвращает `false` с описанием ошибки при 401/403/_network error
- [ ] Smoke-тест: fan загружает расширение без ошибок, `/confluence` показывает статус

### Green — Реализация

- [ ] Создать директорию `~/.fan/agent/extensions/fan-confluence/`
- [ ] Создать `package.json` с зависимостями: `confluence.js`, `turndown`, `turndown-plugin-gfm`, `marked`
- [ ] Выполнить `npm install` в директории расширения
- [ ] Создать `config.ts` — загрузка из `.env` / process.env, типы `ConfluenceConfig`, функция `loadConfig()`, валидация
- [ ] Создать `client.ts` — функция `initClient(config)` возвращает экземпляр `Confluence`, функция `healthCheck()` делает тестовый запрос
- [ ] Создать `index.ts` — заглушка с `export default function (pi: ExtensionAPI)`, регистрация команды `/confluence`
- [ ] Реализовать `/confluence` — загружает конфигурацию, проверяет подключение, выводит статус через `ctx.ui.notify()`
- [ ] Все тесты проходят (Red → Green)

### Refactor — Улучшение

- [ ] Вынести типы конфигурации в отдельный блок внутри `config.ts`
- [ ] Добавить информативные сообщения об ошибках конфигурации (какой параметр отсутствует, где его указать)
- [ ] Добавить логирование версии Confluence DC при успешном подключении
- [ ] Тесты всё ещё проходят после рефакторинга

## Ветвление и слияние (worktree для этапа)

1. Переключиться на основную ветку: `git checkout feature/fan-confluence`
2. Создать worktree этапа: `git worktree add .wt/fan-confluence/stage-1-foundation -b feature/fan-confluence/stage-1-foundation`
3. Переключиться в worktree этапа: `cd .wt/fan-confluence/stage-1-foundation`
4. Реализация (TDD-цикл, отмечать чеклисты в этом файле)
5. Smoke-тестирование всего проекта
6. Обновить чеклисты этого файла (отметить выполненные пункты)
7. Обновление документации (roadmap-main, guides)
8. Code review
9. Merge подветки в основную: `cd <project-root> && git checkout feature/fan-confluence` → `git merge --no-ff feature/fan-confluence/stage-1-foundation`
10. Удалить worktree этапа: `git worktree remove .wt/fan-confluence/stage-1-foundation`
11. После завершения **всех** этапов — пользователь самостоятельно выполняет merge `feature/fan-confluence` в целевую ветку

## Smoke-тесты этапа (обязательные)

| # | Проверка | Команда / Действие | Ожидаемый результат |
|---|----------|--------------------|---------------------|
| 1 | Расширение загружается | Запустить `fan`, проверить отсутствие ошибок в логе при старте | Нет ошибок загрузки расширения |
| 2 | Команда /confluence — успешное подключение | Ввести `/confluence` в fan TUI | Уведомление: «Confluence: подключено (v8.x.x), пространство: DEV» |
| 3 | Команда /confluence — ошибка конфигурации | Удалить `CONFLUENCE_PAT` из `.env`, выполнить `/confluence` | Уведомление об ошибке: «CONFLUENCE_PAT не указан...» |
| 4 | Конфигурация загружается | Проверить чтение `.env` | `loadConfig()` возвращает объект с baseUrl, pat, spaceKey |

## Критерии завершения этапа

- [ ] Все unit-тесты проходят (`npx vitest run` в директории расширения)
- [ ] Все smoke-тесты этапа проходят
- [ ] Все пункты TDD-чеклиста отмечены
- [ ] Подветка `feature/fan-confluence/stage-1-foundation` смержена в `feature/fan-confluence`
- [ ] Code review пройден
- [ ] Статус этапа обновлён в roadmap-main

## Обновление roadmap-stage

> По мере выполнения работы отмечайте пункты чеклистов прямо в этом файле.
> Это ваш живой трекер прогресса — обновляйте его после каждого значимого шага.

## Обновление roadmap-main

После завершения этапа обновить статус в [roadmap-main.md](roadmap-main.md):
- [x] Этап 1: foundation — Completed
