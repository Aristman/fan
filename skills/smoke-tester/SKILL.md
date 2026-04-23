---
name: smoke-tester
compatibility: Requires Playwright MCP extension (playwright-tools). TUI mode only.
description: >
  ИИ-агент smoke-тестирования веб-приложений через Playwright MCP.
  Читает сценарии (Markdown/YAML), протыкивает UI: навигация, клики, формы,
  верификация элементов и текста, скриншоты на каждом шаге.
  Формирует детализированный отчёт со скриншотами, pass/fail на каждом шаге,
  диагностикой проблем. Поддерживает corner-cases, visual regression,
  accessibility проверки.
---

# smoke-tester

ИИ-агент smoke-тестирования веб-приложений. Берёт сценарий → протыкивает UI через
Playwright MCP → формирует отчёт со скриншотами и диагностикой.

---

## Когда использовать

- Пользователь говорит «smoke test», «протестируй UI», «smoke-tester»
- Нужно проверить веб-приложение end-to-end по сценарию
- Нужно smoke-тестировать после деплоя
- Нужно визуально проверить страницы, формы, навигацию
- Нужно проверить corner-cases (пустые формы, невалидные данные, long text)

## Когда НЕ использовать

- Unit/integration тесты кода (→ auto-tests)
- Load/performance тестирование (→ специализированные инструменты)
- API-тестирование без UI (→ curl/httpie)
- Баг-фикс конкретного дефекта (→ bug-fix)

---

## Парсинг входных данных

Входная строка передаётся после `User:`.

### Основной режим
```
smoke-tester <url_or_scenario_path>
```
- `<url_or_scenario_path>` — URL для быстрого теста или путь к файлу/директории сценариев

### С флагами
```
smoke-tester [путь_или_url] [--config <path>] [--headed] [--browser chrome|firefox|webkit]
  [--viewport WxH] [--output <dir>] [--timeout <ms>] [--dry-run]
  [--scenarios <glob>] [--tags <tag1,tag2>] [--viewport-mobile]
```

### Флаги
| Флаг | Описание | Default |
|------|----------|---------|
| `--config` | Путь к конфигурационному файлу | `smoke-tester.config.json` (auto-detect) |
| `--headed` | Визуальный режим браузера | headless |
| `--browser` | Браузер: chrome, firefox, webkit | chrome |
| `--viewport` | Размер окна, например `1280x720` | `1280x720` |
| `--viewport-mobile` | Мобильный viewport (375x812) | — |
| `--output` | Директория для отчётов | `docs/smoke-reports/<timestamp>/` |
| `--timeout` | Таймаут навигации в ms | 30000 |
| `--dry-run` | Только парсинг сценариев, без выполнения | — |
| `--scenarios` | Glob-паттерн для файлов сценариев | `**/*.smoke.{md,yaml,yml}` |
| `--tags` | Запуск только сценариев с указанными тегами | все |
| `--verbose` | Детальный вывод в консоль | — |
| `--fail-fast` | Остановиться при первом падении | — |

---

## Зависимости

### Обязательные
- **playwright-tools extension** — должен быть загружен в fan
  (расположение: `~/.fan/agent/extensions/playwright-tools/`)
- **Chromium** — `npx playwright install chromium`

Единый tool `browser` с параметром `action`. Первый вызов авто-стартует
сервер. Action `close` — выключает сервер и освобождает ресурсы.

### Опциональные
- **Vision model** (GPT-4o, Claude) — для visual regression проверки скриншотов
- **Chrome DevTools MCP** — для deep diagnostics при падениях (perf, network)

---

## Системный промпт

Ты — Smoke Test Agent. Твоя задача: прочитать smoke-сценарий(ы), выполнить их
через Playwright MCP, фиксируя результаты на каждом шаге. Ты работаешь
автономно: парсишь сценарии, выполняешь шаги, верифицируешь результат,
делаешь скриншоты, формируешь отчёт.

Твой подход:
1. **Парсить.** Прочитать сценарии, валидировать структуру.
2. **Планировать.** Определить порядок выполнения, зависимости между шагами.
3. **Выполнять.** Навигация, клики, заполнение форм — через Playwright MCP tools.
4. **Верифицировать.** На каждом шаге: проверка ожиданий (видимость, текст, URL, состояние).
5. **Снимать.** Скриншот на каждом шаге + при ошибках.
6. **Отчитаться.** Структурированный отчёт со скриншотами и диагностикой.

---

## Формат сценариев

Поддерживаются Markdown (`.smoke.md`) и YAML (`.smoke.yaml`/`.smoke.yml`) форматы.
Полная схема, все действия (actions), ожидания (expects) и примеры — в
[scenario-schema.md](references/scenario-schema.md).

---

## Конфигурация

Файл `smoke-tester.config.json` (auto-detect в корне проекта):

```json
{
  "base_url": "https://example.com",
  "browser": "chrome",
  "viewport": "1280x720",
  "timeout": {
    "action": 5000,
    "navigation": 30000
  },
  "output_dir": "docs/smoke-reports",
  "scenarios_dir": "tests/smoke",
  "scenarios_glob": "**/*.smoke.{md,yaml,yml}",
  "screenshots": {
    "on_each_step": true,
    "on_error": true,
    "format": "png"
  },
  "credentials": {
    "env_prefix": "SMOKE_",
    "storage_state": null
  },
  "retries": {
    "failed_steps": 1,
    "flaky_threshold": 0.3
  },
  "tags": {
    "run": ["critical"],
    "skip": []
  },
  "visual_regression": {
    "enabled": false,
    "threshold": 0.1,
    "baseline_dir": "tests/smoke/baselines"
  },
  "report": {
    "format": "markdown",
    "include_screenshots": true,
    "include_trace": false,
    "include_network": false
  }
}
```

---

## Процесс

### Фаза 0: Инициализация

**0.1. Первый вызов browser tool**

Первый вызов `browser` tool с любым action (например, `navigate`) автоматически
стартует Playwright MCP сервер. Нет необходимости в отдельной активации.

После завершения работы — **обязательно** вызови `browser` с action `close`
чтобы выключить сервер и освободить ресурсы.

**0.2. Определи режим**

```
Если вход — URL (начинается с http) → quick mode (single page)
Если вход — путь к файлу → single scenario mode
Если вход — путь к директории → batch mode (все .smoke.* файлы)
Если вход пуст → поиск сценариев в default locations
```

**0.3. Загрузи конфигурацию**

```
1. Ищем smoke-tester.config.json в ctx.cwd
2. Если нет — используем defaults
3. Merge CLI флаги поверх config
```

**0.4. Прочитай reference** (по требованию)

- [scenario-schema.md](references/scenario-schema.md) — полная схема сценариев
- [corner-cases.md](references/corner-cases.md) — библиотека corner-case паттернов
- [diagnostics.md](references/diagnostics.md) — правила диагностики проблем

**0.5. Если --dry-run → парсинг + валидация, завершить**

---

### Фаза 1: Парсинг и валидация сценариев

**1.1. Найти файлы сценариев**

```bash
# По glob из конфига
find . -name "*.smoke.md" -o -name "*.smoke.yaml" -o -name "*.smoke.yml" | head -50
```

**1.2. Фильтрация по тегам** (если --tags указан)

```
Для каждого файла:
  - Парси frontmatter (для MD) или верхний уровень (для YAML)
  - Если tags не пересекаются с --tags → skip
```

**1.3. Парсинг сценария**

Для каждого файла:
- MD: парси YAML frontmatter + markdown body (actions/expect blocks)
- YAML: парси как YAML, валидируй schema

**1.4. Валидация**

Проверь для каждого сценария:
- ✅ Обязательные поля: `name`, `steps`
- ✅ Каждый шаг имеет `name` и хотя бы одну `action`
- ✅ 每个 `ref` валидный формат (role + name/label, как в a11y snapshot)
- ✅ `expects` используют поддерживаемые типы
- ✅ Отсутствуют циклические зависимости между шагами
- ✅ `navigate` как первый action (если не указан — warn)

При ошибках валидации — вывести список проблем, спросить: фиксить или пропустить.

---

### Фаза 2: Планирование

**2.1. Определить порядок выполнения**

- Один файл → линейное выполнение шагов
- Несколько файлов → сортировка по tags.priority (если указан), иначе по имени
- Зависимости между сценариями → topological sort

**2.2. Показать план**

```
## Smoke Test Plan

Scenarios: 3 | Steps: 12 | Estimated time: ~2min

| # | Сценарий | Шаги | Теги | Приоритет |
|---|----------|------|------|-----------|
| 1 | Login Flow | 4 | critical, auth | high |
| 2 | Dashboard Load | 3 | critical | high |
| 3 | Settings Form | 5 | medium | medium |

Proceed? → (если не --no-confirm)
```

---

### Фаза 3: Выполнение

Для каждого сценария → для каждого шага:

**3.1. Перед шагом: snapshot**

```
browser_snapshot → сохранить ref-карту текущей страницы
```

**3.2. Выполнить action(ы)**

Для каждого action в шаге:
- Найти ref в текущем snapshot
- Если ref не найден → ошибка + скриншот + попытка recover (см. 3.4)
- Вызвать соответствующий Playwright MCP tool
- Фиксировать результат вызова

**3.3. Верифицировать expects**

Для каждого expect в шаге:
- Если `element_visible` / `text_visible` → `browser_verify_element_visible` / `browser_verify_text_visible`
- Если `not_visible` / `not_text_visible` → проверить в snapshot, элемент/текст отсутствует
- Если `url_contains` / `url_equals` → сравнить с текущим URL
- Если `element_count` / `text_count` → посчитать в snapshot
- Если `visual_match` → скриншот + сравнение с baseline
- Если `console_no_errors` → `browser_console_messages`
- Если `network_status` → `browser_network_requests`

**Результат каждого expect:**
- ✅ PASS — ожидание выполнено
- ❌ FAIL — ожидание не выполнено (фактическое значение ≠ ожидаемое)
- ⚠️ WARN — частичное выполнение (timeout, partial match)

**3.4. Recovery при ошибках**

Если action или expect упал:
1. Снять скриншот текущего состояния
2. Получить console messages (`browser_console_messages`)
3. Попробовать alternative refs:
   - Если `ref: button "Submit"` не найден → искать по partial match
   - Если элемент за loading overlay → `browser_wait_for` 2s + повторить
   - Если элемент в iframe → предложить пользователю
4. Если recovery не удался → зафиксировать FAIL, перейти к следующему шагу
   (если не --fail-fast)

**3.5. Скриншоты**

```
На каждом шаге (если config.screenshots.on_each_step):
  browser_take_screenshot → <step_name>.png

При ошибке:
  browser_take_screenshot → <step_name>_FAIL.png

Явные screenshot action:
  browser_take_screenshot → <provided_name>.png
```

**3.6. Трассировка (опционально)**

Если config.report.include_trace:
```
browser_start_tracing → в начале сценария
browser_stop_tracing → в конце сценария
```

---

### Фаза 4: Corner Cases (автоматические)

После основного прохождения сценария, skill автоматически проверяет corner cases
если они не покрыты в сценарии явно.

Авто-corner-cases выполняются **только если** `--tags` не указан или включает `corner-case`.

Полная библиотека corner-case паттернов (формы, навигация, viewport, сессии, ошибки) —
в [corner-cases.md](references/corner-cases.md).

---

### Фаза 5: Отчёт

Skill генерирует три артефакта в `docs/smoke-reports/<timestamp>/`:

- **report.md** — человекочитаемый Markdown отчёт (summary, сценарии, шаги, corner cases, recommendations)
- **report.json** — machine-readable JSON (для CI/CD парсинга)
- **screenshots/** — скриншоты каждого шага + `_FAIL.png` при ошибках

В конце отчёта — структурированная секция `## smoke-tester result` для orchestrator'а.

Полные шаблоны Markdown отчёта, JSON формат, структура директории и примеры
консольного вывода — в [report-templates.md](references/report-templates.md).

---

## Обработка ошибок

| Ситуация | Действие |
|----------|----------|
| Playwright MCP не найден | Сообщить + инструкция по настройке |
| Сценарий не найден | Сообщить, показать доступные `.smoke.*` файлы |
| Ошибка парсинга сценария | Показать строку с ошибкой, предложить фикс |
| Element ref не найден в snapshot | Recovery: partial match, wait, screenshot. FIX в отчёте |
| Navigation timeout | Скриншот + console log. FIXED шаг + переход дальше |
| Dialog (alert/confirm) неожиданно | `browser_handle_dialog` (auto-dismiss). Логировать |
| Network error (5xx) | Скриншот + network log. FIXED шаг |
| 404 страница | Зафиксировать как FAIL, diag: "Page returned 404" |
| Браузер краш | Перезапустить браузер, перепустить текущий шаг |
| Сценарий полностью красный | Диагноз + recommendations в отчёте |
| Все сценарии зелёные | Краткий отчёт "All passed ✅" |
| --fail-fast и первый шаг упал | Стоп, полный отчёт по текущему состоянию |

---

## Быстрый режим (URL без сценария)

Если передан URL вместо пути к сценарию — skill делает **обзорный smoke-test**:

1. Открывает URL
2. Делает snapshot accessibility tree
3. Проверяет:
   - Page loads without errors (console)
   - Main heading visible
   - Navigation/menu present
   - No broken images
   - No console errors
   - Page title not empty
   - Viewport responsive (опционально)
4. Кликает на основные навигационные ссылки (до 5)
5. На каждой странице: повторяет базовые проверки
6. Скриншоты всех страниц
7. Формирует отчёт

```
User: smoke-tester https://example.com

→ Quick smoke test: https://example.com
→ Page loaded in 1.2s
→ Checking... heading ✅ nav ✅ no console errors ✅
→ Following links:
  → /about — ✅ (0.8s)
  → /contact — ✅ (1.1s)
  → /pricing — ❌ (404)
→ Report: docs/smoke-reports/.../report.md
```

---

## Чеклист: ЧТО ДОЛЖЕН делать

1. ✅ Проверять доступность Playwright MCP перед запуском
2. ✅ Парсить и валидировать сценарии (MD + YAML) перед выполнением
3. ✅ Показывать план перед выполнением (если не --no-confirm)
4. ✅ Читать reference-файлы перед началом работы
5. ✅ Делать snapshot перед каждым шагом для определения ref'ов
6. ✅ Вызывать Playwright MCP tools для действий
7. ✅ Верифицировать все expects на каждом шаге
8. ✅ Делать скриншот на каждом шаге (если сконфигурировано)
9. ✅ Делать скриншот при любой ошибке
10. ✅ Attempt recovery при missing refs (partial match, wait)
11. ✅ Получать console messages при ошибках для диагностики
12. ✅ Проверять corner cases (формы, навигация, viewport)
13. ✅ Формировать детальный Markdown отчёт
14. ✅ Формировать JSON отчёт (для CI/CD)
15. ✅ Давать рекомендации по каждому FAILED шагу
16. ✅ Выдавать парсимую секцию `## smoke-tester result` для orchestrator'а
17. ✅ Поддерживать quick mode (URL без сценария)
18. ✅ Поддерживать фильтрацию по тегам

## Чеклист: ЧТО НЕ ДОЛЖЕН делать

1. ❌ Выполнять сценарии без парсинга и валидации
2. ❌ Игнорировать failed expects — каждый фиксить в отчёте
3. ❌ Останавливаться на первом падении (если не --fail-fast)
4. ❌ Угадывать ref'ы без snapshot — всегда брать из свежего snapshot
5. ❌ Менять код приложения
6. ❌ Сохранять credentials в отчётах
7. ❌ Использовать hardcoded credentials (только из env/config)
8. ❌ Бесконечно retry — max retries из config
9. ❌ Пропускать diagnosis для failed шагов

