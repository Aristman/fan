# Diagnostics Reference

Правила и паттерны диагностики проблем при failed шагах smoke-тестов.

---

## Общая стратегия

При падении шага skill выполняет **structured diagnosis**:

1. **Снимок состояния** — скриншот + console + network
2. **Анализ symptom** — что именно не совпало
3. **Классификация** — категория проблемы
4. **Рекомендация** — что проверять/чинить

---

## Symptom → Category Mapping

### URL не соответствует ожиданию

| Symptom | Category | Diagnosis |
|---------|----------|-----------|
| URL не изменился после click/submit | **Form Submission Failed** | Validation error, JS error, button not functional |
| URL редиректит на login | **Auth Issue** | Session expired, insufficient permissions, token invalid |
| URL содержит `?error=` | **Server Error** | Backend returned error parameter |
| URL содержит `#` (hash) вместо path | **Client-side Routing** | SPA routing issue, malformed navigation |
| URL изменился на неожиданный | **Redirect Chain** | Auth redirect, locale redirect, A/B test |

### Element не найден

| Symptom | Category | Diagnosis |
|---------|----------|-----------|
| Element есть в snapshot но ref не совпадает | **Selector Drift** | Text/label changed, i18n, A/B test |
| Element отсутствует в snapshot | **Missing Element** | Not rendered (conditional), lazy load, JS error |
| Element перекрыт другим | **Overlay/Modal** | Dialog, cookie banner, maintenance mode |
| Element в разных role | **ARIA Change** | Semantic role changed (div → button) |
| Element вне viewport | **Scroll Issue** | Element exists but not visible, need scroll |

### Expect value не совпадает

| Symptom | Category | Diagnosis |
|---------|----------|-----------|
| Текст отличается регистром | **Case Sensitivity** | Actual vs expected case mismatch |
| Текст содержит extra whitespace | **Formatting** | Trim issue, extra spaces/newlines |
| Текст частично совпадает | **Dynamic Content** | Timestamps, counters, random values |
| Count отличается | **Data Issue** | Pagination, filter, stale data |

### Console Errors

| Error Type | Category | Diagnosis |
|------------|----------|-----------|
| `TypeError: Cannot read property of null` | **JS Error** | DOM element expected but not found |
| `401 Unauthorized` (network) | **Auth Issue** | API auth failed, expired token |
| `403 Forbidden` (network) | **Permission** | Insufficient permissions |
| `500 Internal Server Error` | **Server Error** | Backend crash, unhandled exception |
| `CORS error` | **Configuration** | Missing CORS headers, wrong origin |
| `net::ERR_CONNECTION_REFUSED` | **Infrastructure** | Server down, wrong port |
| `ChunkLoadError` | **Deployment** | Stale deployment, missing assets |
| `Unhandled Promise Rejection` | **JS Error** | Unhandled async error |

---

## Diagnostic Steps (по категориям)

### 1. Form Submission Failed

```
1. browser_console_messages → ищем JS errors
2. browser_network_requests → ищем failing requests (4xx/5xx)
3. browser_snapshot → проверяем form state (validation errors visible?)
4. Диагноз:
   - Если console error → "JavaScript error: <error message>"
   - Если network 4xx → "Server rejected: <status> <body preview>"
   - Если validation error visible → "Form validation failed: <error text>"
   - Если ничего из выше → "Unknown: form submit did not navigate"
```

### 2. Auth Issue

```
1. browser_console_messages → ищем 401/403
2. browser_network_requests → проверяем auth headers
3. browser_cookie_list → проверяем наличие session cookies
4. browser_snapshot → проверяем наличие login form
5. Диагноз:
   - Если redirected to login → "Session expired or invalid"
   - Если cookies missing → "No session cookies found"
   - Если token expired → "Auth token expired (check exp claim)"
```

### 3. Selector Drift

```
1. browser_snapshot → полный дамп текущей страницы
2. Поиск похожих элементов (partial match по role/name)
3. Диагноз:
   - "Element not found: expected 'button "Submit"', found: 'button "Send"'
   - Suggestion: update ref to match current label
```

### 4. Missing Element

```
1. browser_snapshot → элемент отсутствует?
2. browser_evaluate → element в DOM но скрыт? (display:none, visibility:hidden)
3. browser_take_screenshot → визуально видно?
4. browser_wait_for 2s → retry snapshot
5. Диагноз:
   - В DOM но hidden → "Element exists but hidden (CSS/display)"
   - Не в DOM → "Element not rendered (conditional, JS error, lazy load)"
   - После wait появился → "Element requires loading time"
```

### 5. Performance Issue

```
1. Засечь время между action и expect
2. Если > 3s → potential performance issue
3. browser_network_requests → slow requests?
4. browser_evaluate → large DOM?
5. Диагноз:
   - "Page loaded in X.Xs (threshold: 3s)"
   - "N network requests, total X.Xs"
```

### 6. Visual Regression

```
1. browser_take_screenshot → current state
2. Если baseline exists → pixel diff
3. Диагноз:
   - Diff %: X.X%
   - Affected areas: top-left (header), center (form)
   - Possible cause: CSS change, font change, responsive breakpoint
```

---

## Recommendation Templates

### По категории проблемы

**Auth:**
```
🔴 **Auth Issue Detected**
- Credentials may be expired. Check test credentials in config/env.
- Verify SSO/session mechanism hasn't changed.
- Check if rate limiting triggered.
```

**Form:**
```
🔴 **Form Submission Failed**
- Check server logs for validation errors.
- Verify form action URL is correct.
- Check if required fields are all filled.
- Possible JS error: see console output above.
```

**Selector:**
```
🟡 **Element Reference Changed**
- Expected: `button "Submit"`
- Found: `button "Send"` (or similar)
- Action: Update scenario to match current UI.
- Tip: Use more stable refs (ARIA labels, test IDs).
```

**Missing:**
```
🟡 **Element Not Rendered**
- Element may require specific state/permission.
- Check if it's behind a conditional render.
- Verify the API that provides data for this element.
```

**Performance:**
```
🟡 **Slow Response (>3s)**
- Step "X" took Y.Ys.
- Consider: network requests optimization, lazy loading, caching.
```

**Server:**
```
🔴 **Server Error**
- URL: <endpoint>
- Status: <status code>
- Response preview: <first 200 chars>
- Check server logs, recent deployments, configuration.
```

---

## Severity Levels

| Level | Icon | Impact |
|-------|------|--------|
| Critical | 🔴 | Core flow broken, no workaround |
| Major | 🟠 | Important feature broken, partial workaround |
| Minor | 🟡 | Cosmetic/UX issue, functional workaround |
| Info | 🔵 | Observation, potential future issue |

---

## Aggregation

В итоговом отчёте recommendations сортируются по severity:

```
## Recommendations (by priority)

### 🔴 Critical (2)
1. Login flow broken — credentials rejected
   → Scenario: Login Flow, Step 3

2. Dashboard API returns 500
   → Scenario: Dashboard Load, Step 2

### 🟡 Minor (1)
1. Settings form label changed ("Save" → "Submit")
   → Scenario: Settings, Step 4
```
