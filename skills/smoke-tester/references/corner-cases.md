# Corner Cases Library

Автоматические corner-case проверки, которые skill добавляет к сценариям
если они не покрыты явно.

---

## Form Corner Cases

### FC-01: Empty Submit
**Когда:** Сценарий содержит `fill_form` + `click submit`
**Действие:** Кликнуть submit без заполнения формы
**Ожидание:** Валидационные ошибки видны, данные не отправлены

### FC-02: Invalid Email Format
**Когда:** Форма содержит email поле
**Действие:** Ввести `not-an-email` или `@domain.com`
**Ожидание:** Валидационная ошибка "Invalid email"

### FC-03: SQL Injection
**Когда:** Форма содержит текстовые поля
**Действие:** Ввести `' OR 1=1 --` в каждое поле
**Ожидание:** Текст обработан как literal, не как SQL

### FC-04: XSS Injection
**Когда:** Форма содержит текстовые поля
**Действие:** Ввести `<script>alert('xss')</script>`
**Ожидание:** Текст escaped, no script execution

### FC-05: Max Length
**Когда:** Форма содержит input/textbox
**Действие:** Ввести 1000+ символов
**Ожидание:** Поле truncates или показывает ошибку, нет crash

### FC-06: Special Characters
**Когда:** Форма содержит текстовые поля
**Действие:** Ввести `© ® ™ € ¥ «» " ' & < > \t \n`
**Ожидание:** Символы обработаны корректно, данные сохранены

### FC-07: Unicode / Emoji
**Когда:** Форма содержит текстовые поля
**Действие:** Ввести `🎉 Hello 世界 Привет`
**Ожидание:** Символы отображаются и сохраняются корректно

### FC-08: Double Submit
**Когда:** Сценарий содержит `click submit`
**Действие:** Кликнуть submit дважды быстро
**Ожидание:** Duplicate prevention (button disabled, debounce, unique constraint)

### FC-09: Leading/Trailing Spaces
**Когда:** Форма содержит текстовые поля
**Действие:** Ввести `  text  ` (с пробелами)
**Ожидание:** Пробелы trimmed или показаны как есть (в зависимости от типа поля)

### FC-10: Password Visibility Toggle
**Когда:** Форма содержит password поле
**Действие:** Найти toggle visibility кнопку (если есть), кликнуть
**Ожидание:** Пароль становится видимым/скрытым

### FC-11: Tab Navigation
**Когда:** Форма содержит несколько полей
**Действие:** Tab через все поля
**Ожидание:** Фокус перемещается в логичном порядке

### FC-12: Required Field Skip
**Когда:** Форма имеет required поля
**Действие:** Заполнить всё кроме одного required поля, submit
**Ожидание:** Error на пропущенном поле

---

## Navigation Corner Cases

### NC-01: Direct URL Access
**Когда:** Сценарий содержит многошаговый flow
**Действие:** Открыть финальный URL напрямую без прохождения предыдущих шагов
**Ожидание:** Redirect на первый шаг или 403/401

### NC-02: Browser Back After Submit
**Когда:** Сценарий заканчивается submit/transition
**Действие:** После успешного submit → browser_back
**Ожидание:** Корректное поведение (resubmit warning, redirect, или простой back)

### NC-03: Page Refresh Mid-flow
**Когда:** Многошаговый flow (wizard, multi-page form)
**Действие:** Заполнить первые шаги → refresh → проверить состояние
**Ожидание:** Данные сохранены (или clear с warning), не сломано

### NC-04: Broken Internal Link
**Когда:** Страница содержит навигационные ссылки
**Действие:** Кликнуть каждую внутреннюю ссылку (до 10)
**Ожидание:** Нет 404 страниц

### NC-05: External Link Opens New Tab
**Когда:** Страница содержит внешние ссылки
**Действие:** Кликнуть внешнюю ссылку
**Ожидание:** Открывается в новой вкладке или с target="_blank"

### NC-06: Bookmark / Direct Access to Protected Page
**Когда:** Есть auth-protected страницы
**Действие:** Открыть защищённый URL без login
**Ожидание:** Redirect на login page

---

## Viewport Corner Cases

### VC-01: Mobile Viewport
**Когда:** Сценарий desktop
**Действие:** Resize to 375x812 (iPhone)
**Ожидание:** Layout адаптирован, все элементы доступны, нет horizontal scroll

### VC-02: Small Viewport
**Действие:** Resize to 320x480
**Ожидание:** Контент usable, нет overflow, текст читаемый

### VC-03: Large Viewport
**Действие:** Resize to 2560x1440
**Ожидание:** Layout не сломан (max-width container), нет пустых пространств

### VC-04: Viewport Resize During Interaction
**Действие:** Начать заполнение формы → resize → продолжить
**Ожидание:** Данные не потеряны, форма functional

---

## Session Corner Cases

### SC-01: Session Expiry
**Действие:** Очистить cookies → выполнить action требующий auth
**Ожидание:** Redirect на login, не 500 error

### SC-02: Multiple Tabs Same Session
**Действие:** Открыть 2 вкладки → logout в одной → action в другой
**Ожидание:** Вторая вкладка корректно обрабатывает logout

### SC-03: Incognito Mode
**Действие:** (если доступен) Запустить в isolated mode
**Ожидание:** App работает без persisted state

---

## Error Handling Corner Cases

### EC-01: Network Offline
**Действие:** Отключить network → submit form → включить network
**Ожидание:** Error message, не crash, retry option

### EC-02: Slow Network
**Действие:** Ввести данные → жать submit → искусственная задержка
**Ожидание:** Loading indicator, нет duplicate submit

### EC-03: Server Error Response
**Действие:** Замокать API на 500 → submit
**Ожидание:** Error message пользователю, не crash

---

## Применение corner cases

1. Skill анализирует сценарий и определяет применимые corner cases
2. Для каждого применимого — проверяет, не покрыт ли уже явно
3. Непокрытые добавляются в конец сценария как `## Corner Cases` секция
4. Corner cases выполняются после основного сценария
5. Падение corner case = ⚠️ WARNING (не FAIL основного сценария)
6. Исключение: corner cases помеченные `critical` — дают FAIL

### Пример автоматического добавления

Сценарий содержит `fill_form` с email полем и `click submit`:

```
### Auto Corner Cases (not explicitly covered)
- CC-01: Empty Submit → ✅ PASSED
- CC-02: Invalid Email → ✅ PASSED
- CC-03: SQL Injection → ✅ PASSED
- CC-04: XSS Injection → ✅ PASSED
- CC-05: Max Length → ⚠️ WARNING (500 chars accepted without truncation)
- CC-08: Double Submit → ✅ PASSED (button disabled after click)
```
