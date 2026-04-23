# Report Templates Reference

Шаблоны и форматы отчётов, генерируемых smoke-tester.

---

## Директория отчёта

```
docs/smoke-reports/<YYYY-MM-DD_HHmmss>/
├── report.md          # Основной отчёт (человекочитаемый)
├── report.json        # Machine-readable (для CI/CD)
├── screenshots/       # Скриншоты всех шагов
│   ├── 01-open-login-page.png
│   ├── 02-submit-empty-form.png
│   ├── 02-submit-empty-form_FAIL.png
│   └── 03-fill-valid-credentials.png
├── traces/            # Playwright traces (опционально)
└── scenarios/         # Копии использованных сценариев
```

---

## Markdown Report Template

```markdown
# Smoke Test Report

**Date:** 2026-04-18 14:30:00
**Environment:** chrome 1280x720 headless
**Base URL:** https://example.com
**Duration:** 1m 42s

## Summary

| Метрика | Значение |
|---------|----------|
| Сценариев | 3 |
| Шагов | 12 |
| ✅ Passed | 10 |
| ❌ Failed | 2 |
| ⚠️ Warnings | 1 |
| ⏭️ Skipped | 0 |

**Status: ❌ FAILED** (2 steps failed)

---

## Scenario: Login Flow
**Tags:** critical, auth | **Duration:** 35s

### Step 1: Open Login Page ✅
Actions: navigate /login
Expectations: 4/4 passed
Screenshot: [01-open-login-page.png](screenshots/01-open-login-page.png)

### Step 2: Submit Empty Form ✅
Actions: click "Sign In"
Expectations: 2/2 passed
Screenshot: [02-submit-empty-form.png](screenshots/02-submit-empty-form.png)

### Step 3: Fill Valid Credentials ❌
Actions: fill_form, click "Sign In"
Expectations: 2/3 failed

| Expect | Result | Detail |
|--------|--------|--------|
| url_contains /dashboard | ❌ | Actual URL: /login (redirected back) |
| element_visible "Welcome" | ❌ | Element not found in snapshot |
| not_visible "Sign In" | ✅ | |

**Diagnosis:** Form submission failed — server returned to /login.
Possible causes:
1. Invalid credentials (check test data)
2. Server-side validation error (check console)
3. Session/auth mechanism changed

Console errors:
- `POST /api/login 401 Unauthorized`

Screenshot: [03-fill-valid-credentials_FAIL.png](screenshots/03-fill-valid-credentials_FAIL.png)

### Step 4: Logout ⏭️
Skipped: previous step failed

---

## Corner Cases: Login Form

### CC-01: XSS in Username Field ✅
Input: `<script>alert(1)</script>`
Result: Text escaped in form field, no execution

### CC-02: SQL Injection in Password Field ✅
Input: `' OR 1=1 --`
Result: Treated as literal text

### CC-03: Double Submit ✅
Action: Click "Sign In" twice rapidly
Result: Second click disabled / request deduplicated

---

## Recommendations

1. **🔴 Critical:** Login flow broken — credentials rejected (Step 3)
   - Verify test credentials are still valid
   - Check server logs for auth changes

2. **🟡 Warning:** Slow response time on Settings page (>3s)
   - Consider performance optimization

3. **🟢 Info:** All corner cases passed — form is properly sanitized
```

---

## JSON Report Format (для CI/CD парсинга)

```json
{
  "meta": {
    "timestamp": "2026-04-18T14:30:00Z",
    "environment": { "browser": "chrome", "viewport": "1280x720", "headless": true },
    "base_url": "https://example.com",
    "duration_ms": 102000
  },
  "summary": {
    "scenarios": 3,
    "steps": 12,
    "passed": 10,
    "failed": 2,
    "warnings": 1,
    "skipped": 0,
    "status": "failed"
  },
  "scenarios": [
    {
      "name": "Login Flow",
      "tags": ["critical", "auth"],
      "duration_ms": 35000,
      "status": "failed",
      "steps": [
        {
          "name": "Open Login Page",
          "status": "passed",
          "duration_ms": 2000,
          "screenshot": "screenshots/01-open-login-page.png"
        },
        {
          "name": "Fill Valid Credentials",
          "status": "failed",
          "duration_ms": 5000,
          "expects": [
            { "type": "url_contains", "expected": "/dashboard", "actual": "/login", "status": "failed" }
          ],
          "diagnosis": "Form submission failed — server returned to /login",
          "screenshot": "screenshots/03-fill-valid-credentials_FAIL.png"
        }
      ]
    }
  ]
}
```

---

## Структурированный результат (для orchestrator)

Всегда в конце отчёта:

```markdown
## smoke-tester result
### scenarios: <count>
- status: passed | failed | partial
- steps_total: N
- steps_passed: N
- steps_failed: N
- steps_skipped: N
- duration: Ns
- report_path: docs/smoke-reports/<timestamp>/report.md
- screenshots_dir: docs/smoke-reports/<timestamp>/screenshots/
- failed_steps:
  - scenario: <name>
    step: <name>
    diagnosis: <diagnosis text>
- summary: <краткое описание — что прошло, что сломалось>
```

---

## Console Output Examples

### Single scenario
```
User: smoke-tester tests/smoke/login.smoke.md

→ Found 1 scenario: Login Flow (4 steps)
→ Running...
→ Step 1: Open Login Page ✅ (1.2s)
→ Step 2: Submit Empty Form ✅ (0.8s)
→ Step 3: Fill Valid Credentials ✅ (2.1s)
→ Step 4: Logout ✅ (1.5s)
→ Corner cases: 5/5 passed
→ Report: docs/smoke-reports/2026-04-18_143000/report.md
```

### Batch mode
```
User: smoke-tester tests/smoke/

→ Found 3 scenarios (8 steps total)
→ Running...
→ Login Flow: ✅ 4/4 steps
→ Dashboard: ✅ 2/2 steps
→ Settings: ❌ 2/5 steps (form validation broken)
→ Report: docs/smoke-reports/2026-04-18_143000/report.md
```

### Quick mode
```
User: smoke-tester https://example.com

→ Quick smoke test: https://example.com
→ Pages checked: 5 | Issues: 1 (/pricing → 404)
→ Report: docs/smoke-reports/2026-04-18_143000/report.md
```
