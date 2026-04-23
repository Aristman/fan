---
name: Smoke Test Config Template
description: "Template for smoke-tester configuration. Copy to your project root."
---

# Smoke Test Configuration

Копируй этот файл в корень проекта как `smoke-tester.config.json` и адаптируй.

## Минимальная конфигурация

```json
{
  "base_url": "https://your-app.example.com",
  "scenarios_dir": "tests/smoke"
}
```

## Полная конфигурация

```json
{
  "$schema": "https://raw.githubusercontent.com/.../smoke-tester.schema.json",

  "base_url": "https://your-app.example.com",
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

## Конфигурация по environment

```json
{
  "base_url": "${SMOKE_BASE_URL}",
  "browser": "chrome",
  "viewport": "1280x720",
  "tags": {
    "run": ["critical", "smoke"]
  },
  "credentials": {
    "env_prefix": "SMOKE_"
  },
  "report": {
    "format": "markdown"
  }
}
```

Использование:
```bash
# Staging
SMOKE_BASE_URL=https://staging.example.com SMOKE_TEST_EMAIL=... SMOKE_TEST_PASSWORD=... \
  smoke-tester tests/smoke/

# Production
SMOKE_BASE_URL=https://example.com SMOKE_TEST_EMAIL=... SMOKE_TEST_PASSWORD=... \
  smoke-tester tests/smoke/ --tags critical
```
