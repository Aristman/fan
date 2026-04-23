# Scenario Schema Reference

Полная схема форматов smoke-сценариев.

---

## Общая структура

Каждый сценарий описывает **именованный набор шагов**, выполняемых последовательно.
Каждый шаг содержит **действия** (что делать) и **ожидания** (что проверить).

---

## Markdown формат (`.smoke.md`)

### Frontmatter (YAML)

```yaml
---
name: string          # Обязательное. Имя сценария.
url: string           # Базовый URL (абсолютный). Если не указан — из config.
tags: [string]        # Теги для фильтрации. Пример: [critical, auth, smoke]
viewport: string      # Override viewport. Формат: "WxH". Пример: "1280x720"
before: |             # JavaScript для выполнения перед началом (опционально)
  localStorage.setItem('token', 'test');
after: |              # JavaScript для выполнения после завершения (опционально)
  localStorage.clear();
skip: boolean         # Пропустить сценарий
skip_reason: string   # Причина пропуска
depends_on: [string]  # Сценарии, которые должны пройти перед этим
retries: number       # Override кол-ва retry при падении шага
timeout: number       # Override таймаута навигации (ms)
---
```

### Body

Тело документа — markdown с шагами. Каждый шаг — `## Step N: Name` или `## Name`.

Внутри шага — YAML-блоки с actions и expects:

```markdown
## Step 1: Open Login Page

- action: navigate
  url: /login

- expect:
    - element_visible: heading "Sign In"
    - element_visible: textbox "Username"
    - url_contains: /login

- screenshot: after_open
```

### Действия (actions)

Пишутся как YAML list items под `- action:`:

```markdown
- action: navigate
  url: /login

- action: click
  ref: button "Submit"

- action: type
  ref: textbox "Email"
  text: user@example.com

- action: fill_form
  values:
    - ref: textbox "Email"
      value: user@example.com
    - ref: textbox "Password"
      value: secret123
    - ref: checkbox "Remember me"
      value: true

- action: select_option
  ref: combobox "Country"
  value: Russia

- action: check
  ref: checkbox "Terms"

- action: uncheck
  ref: checkbox "Newsletter"

- action: press_key
  key: Enter

- action: hover
  ref: link "Help"

- action: drag
  from_ref: slider "Volume"
  to_ref: slider "Volume"  # (определяется агентом по позициям)

- action: wait_for
  text: Loading complete
  # или:
  time: 2000

- action: upload
  ref: button "Upload"
  path: /path/to/file.pdf

- action: resize
  width: 375
  height: 812

- action: tab_open
  url: /help

- action: tab_switch
  index: 1

- action: tab_close
  index: 1

- action: scroll
  direction: bottom

- action: screenshot
  name: custom_name

- action: evaluate
  code: document.title

- action: route_mock
  url_pattern: "**/api/user"
  response: '{"name": "Test User"}'
  status: 200

- action: set_cookie
  name: session_id
  value: test-session-123

- action: set_storage
  key: auth_token
  value: test-token-456
```

### Ожидания (expects)

```markdown
- expect:
    - element_visible: ref          # Элемент виден в a11y snapshot
    - text_visible: "text"          # Текст присутствует на странице
    - not_visible: ref              # Элемент НЕ виден
    - not_text_visible: "text"      # Текст НЕ присутствует
    - url_contains: "/path"         # URL содержит подстроку
    - url_equals: "https://..."     # URL точно равен
    - title_contains: "Page Title"  # document.title содержит
    - element_count:
        pattern: listitem           # Считает элементы с таким role
        count: 5                    # Ожидаемое кол-во
    - text_count:
        text: "Error"               # Ищет текст
        count: 0                    # Ожидаемое кол-во (0 = нет текста)
    - element_enabled: ref          # Элемент enabled (не disabled)
    - element_disabled: ref         # Элемент disabled
    - element_focused: ref          # Элемент в фокусе
    - console_no_errors: true       # Нет JS ошибок в console
    - network_status:
        url: "**/api/login"
        status: 200                 # HTTP статус
    - value_equals:
        ref: textbox "Email"
        value: "user@example.com"
    - selected_option:
        ref: combobox "Country"
        value: "Russia"
```

### Комбинированные expects

Можно группировать expects с логическими операторами:

```markdown
- expect:
    - all:
        - element_visible: heading "Dashboard"
        - element_visible: text "Welcome"
    - any:
        - element_visible: button "Settings"
        - element_visible: link "Settings"
```

---

## YAML формат (`.smoke.yaml` / `.smoke.yml`)

### Структура

```yaml
name: string              # Обязательное
url: string               # Базовый URL
tags: [string]
viewport: string
before: string            # JS before
after: string             # JS after
skip: boolean
skip_reason: string
depends_on: [string]
retries: number
timeout: number

steps:
  - name: string          # Обязательное
    actions:
      - type: action_type # Обязательное
        # ... параметры действия
    expects:
      - type: expect_type # Обязательное
        # ... параметры ожидания
    screenshot: string    # Опционально, имя скриншота
    on_fail: continue     # continue (default) | stop
    retry: number         # Override retry для этого шага
```

### Полный пример

```yaml
name: User Registration
url: https://example.com
tags: [registration, critical]

steps:
  - name: Navigate to Registration
    actions:
      - type: navigate
        url: /register
    expects:
      - type: element_visible
        ref: heading "Create Account"

  - name: Fill Registration Form
    actions:
      - type: fill_form
        values:
          - ref: textbox "Full Name"
            value: John Doe
          - ref: textbox "Email"
            value: john@example.com
          - ref: textbox "Password"
            value: SecurePass123!
          - ref: textbox "Confirm Password"
            value: SecurePass123!
    expects:
      - type: element_enabled
        ref: button "Create Account"

  - name: Submit Form
    actions:
      - type: click
        ref: button "Create Account"
    expects:
      - type: url_contains
        value: /dashboard
      - type: element_visible
        ref: text "Account created successfully"
      - type: console_no_errors

  - name: Verify Email Field Validation
    actions:
      - type: navigate
        url: /register
      - type: fill_form
        values:
          - ref: textbox "Email"
            value: invalid-email
      - type: click
        ref: button "Create Account"
    expects:
      - type: element_visible
        ref: text "Please enter a valid email"
      - type: element_enabled
        ref: textbox "Email"
```

---

## Ref формат (element references)

Refs берутся из Playwright MCP accessibility snapshot. Формат:

```
<role> "<name/label>"
```

Примеры из snapshot:
```
heading "Sign In" [level=1]          → ref: heading "Sign In"
textbox "Username"                    → ref: textbox "Username"
button "Submit"                       → ref: button "Submit"
link "Forgot password?"               → ref: link "Forgot password?"
checkbox "Remember me" [checked]      → ref: checkbox "Remember me"
combobox "Country"                    → ref: combobox "Country"
listitem "Item 1"                     → ref: listitem "Item 1"
```

**Partial match:** Если точный ref не найден, агент пробует substring match:
- `button "Submit"` → ищет все buttons, берёт содержащий "Submit"
- `heading "Sign"` → ищет все headings, берёт содержащий "Sign"

---

## Variables and Environment

### Из config

```json
{
  "credentials": {
    "env_prefix": "SMOKE_"
  }
}
```

В сценарии можно ссылаться на env-переменные:

```yaml
- type: fill_form
  values:
    - ref: textbox "Email"
      value: "${SMOKE_TEST_EMAIL}"        # из env
    - ref: textbox "Password"
      value: "${SMOKE_TEST_PASSWORD}"     # из env
```

### Inline variables

```yaml
- type: fill_form
  values:
    - ref: textbox "Email"
      value: "{{email}}"        # определён в scenario
```

Секция variables:
```yaml
variables:
  email: test@example.com
  password: TestPass123!
```

---

## Config merge priority

1. CLI flags (highest)
2. Scenario frontmatter
3. smoke-tester.config.json
4. Defaults (lowest)
