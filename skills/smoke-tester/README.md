# smoke-tester

ИИ-агент smoke-тестирования веб-приложений. Берёт сценарии → протыкивает UI через Playwright MCP → формирует отчёт со скриншотами и диагностикой.

## Возможности

- 🎭 **Автоматическое UI-тестирование** через Playwright MCP (40+ tools)
- 📸 **Скриншоты на каждом шаге** + при ошибках
- 🔍 **Accessibility tree** вместо скриншотов (быстрее, deterministic)
- 🧪 **Corner cases** — автоматические проверки валидации форм, инъекций, навигации
- 📊 **Детальный отчёт** — Markdown + JSON, с диагнозами и рекомендациями
- 📝 **Два формата сценариев** — Markdown (для людей) + YAML (для автоматизации)
- 🏷️ **Фильтрация по тегам** — запуск по группам (critical, smoke, regression)
- 🔄 **Recovery** — partial match refs, wait+retry при missing elements
- 📱 **Viewport тестирование** — desktop + mobile + edge cases

## Использование

```
smoke-tester <url_or_scenario_path>
smoke-tester tests/smoke/                    # Все сценарии в директории
smoke-tester tests/smoke/login.smoke.md      # Один сценарий
smoke-tester https://example.com             # Quick smoke test
smoke-tester --tags critical tests/smoke/    # Только критичные
```

## Зависимости

- **playwright-tools extension** (встроен в fan) — gate-активация browser tools
- **Chromium** — устанавливается через `npx playwright install chromium`

## Использование

Browser tools активируются по требованию через gate-tool `browser_automation`.
В обычных запросах (код, чат) — **0 overhead**.
Когда нужен браузер — LLM вызывает `browser_automation` → сервер стартует → 21 tool
регистрируется для текущей сессии.

## Структура

```
smoke-tester/
├── SKILL.md                    # Skill definition (основной файл)
├── README.md                   # Этот файл
├── references/
│   ├── scenario-schema.md      # Полная схема форматов сценариев
│   ├── corner-cases.md         # Библиотека автоматических corner cases
│   └── diagnostics.md          # Правила диагностики проблем
└── examples/
    ├── todomvc.smoke.md        # Пример: Markdown сценарий
    ├── login-dashboard.smoke.yaml  # Пример: YAML сценарий
    └── config-template.md      # Шаблон конфигурации
```

## Формат сценариев

### Markdown (`.smoke.md`)

```markdown
---
name: Login Flow
url: https://example.com
tags: [critical, auth]
---

## Step 1: Open Login Page
- action: navigate
  url: /login
- expect:
    - element_visible: heading "Sign In"
    - element_visible: textbox "Email"

## Step 2: Fill and Submit
- action: fill_form
  values:
    - ref: textbox "Email"
      value: "${SMOKE_TEST_EMAIL}"
    - ref: textbox "Password"
      value: "${SMOKE_TEST_PASSWORD}"
- action: click
  ref: button "Sign In"
- expect:
    - url_contains: /dashboard
```

### YAML (`.smoke.yaml`)

```yaml
name: Login Flow
url: https://example.com
tags: [critical, auth]
steps:
  - name: Open Login Page
    actions:
      - type: navigate
        url: /login
    expects:
      - type: element_visible
        ref: heading "Sign In"
```

## Отчёт

```
docs/smoke-reports/2026-04-18_143000/
├── report.md          # Markdown отчёт
├── report.json        # JSON для CI/CD
├── screenshots/       # Скриншоты шагов
└── traces/            # Playwright traces (опционально)
```

## Архитектура

```
Пользователь → fan → smoke-tester skill → Playwright MCP → Chrome/Firefox/WebKit
                                        ↓
                              Accessibility snapshot (ref-карта)
                                        ↓
                              Actions: click, type, fill, navigate
                              Expects: visible, text, url, state
                                        ↓
                              Скриншоты на каждом шаге
                                        ↓
                              Диагностика при ошибках
                                        ↓
                              Отчёт (MD + JSON) + Рекомендации
```
