# fan-security 🛡️

> Bundle для аудита безопасности FAN — extension и skill одним пакетом: три CLI-сканера, агрегирующая slash-команда `/security-scan` и SKILL.md-методология ручного прохода (OWASP Top 10 / CWE-чеклист, secret scanning, аудит зависимостей, IaC и конфигураций).

**fan-security** объединяет два компонента, которые вместе закрывают полный контур
аудита: автоматика (сканеры) + методология для агента (ручной проход по чеклисту).

---

## Состав бандла

| Компонент | Тип | Версия | Что делает |
|-----------|-----|--------|------------|
| **fan-security** | extension | 1.0.0 | CLI-сканеры `scan-secrets` (секреты: AWS, OpenAI, GitHub PAT, Slack, PEM, `.env`, entropy), `scan-patterns` (CWE-сигнатуры: SQLi CWE-89, command injection CWE-78, path traversal CWE-22, XSS CWE-79, weak crypto), `dep-audit` (npm/pnpm/yarn/pip/cargo) + slash-команда `/security-scan` |
| **fan-security** | skill | 1.0.0 | SKILL.md-методология ручного аудита для агента (`/skill:fan-security`): OWASP/CWE-чеклист, secret scanning, dependency audit, IaC, configuration audit, формат отчёта с severity, маскирование секретов 4+4 |

Связь компонентов: воркер или агент проходит методологию skill'а и запускает
сканеры extension'а; сводный отчёт публикуется в чат.

---

## Установка

### FAN Store (рекомендуется)

```bash
fan store install fan-security
```

Installer авто-детектит bundle по поддиректориям `extensions/` + `skills/` —
указывать `--type` не нужно. Компоненты встанут в:

- extension → `~/.fan/agent/extensions/fan-security/`
- skill → `~/.fan/agent/skills/fan-security/`

### Из локального архива (.tar.gz)

```bash
fan store install ./fan-security-1.0.0.tar.gz
```

Архив распаковывается, авто-детект видит `extensions/` + `skills/` и
устанавливает бандл тем же путём.

После установки выполните `/reload` в сессии FAN.

---

## Использование

### Slash-команда

```
/security-scan [path] [--format json]
```

Запускает все три сканера одним вызовом и публикует сводку в чат: сканеры со
счётчиками по severity, строки `[SEVERITY] file:line — title`, Total.
`--format json` — полный JSON-агрегат `{ summary, findings, scanners, target }`.

### CLI-сканеры

Команды выполняются из корня установленного расширения
(обычно `~/.fan/agent/extensions/fan-security/`):

```bash
# Секреты (ключи, токены, .env, entropy)
bun cli/scan-secrets.ts <path> [--format json] [--use-external off|auto|only]

# CWE-сигнатуры в коде
bun cli/scan-patterns.ts <path> [--format json] [--use-external off|auto|only]

# Уязвимые зависимости (npm/pnpm/yarn/pip/cargo)
bun cli/dep-audit.ts <path> [--format json]
```

Коды возврата: `0` — чисто, `1` — findings найдены, `2` — ошибка запуска.
Секреты в `evidence` всегда маскируются (4+4: `AKIA…MNOP`).

### Skill-методология

```
/skill:fan-security
```

Ручной проход по шести разделам (код → секреты → зависимости → IaC →
конфигурации → отчёт) с запуском CLI-сканеров там, где возможно.

---

## Требования

| Требование | Детали |
|------------|--------|
| FAN | Phase 7+ (текущая версия) |
| Runtime | Bun (≥ 1.1) — для запуска CLI-сканеров |
| Внешние тулзы (опционально) | gitleaks / semgrep — гибридный режим `--use-external auto` |

---

## Зависимость от Этапа 1 (orchestrator)

Бандл работает и **независимо**: CLI-сканеры и `/security-scan` доступны в
обычной сессии без оркестратора.

Для **воркер-сценария** нужен Этап 1 фичи security-worker: agent type
`security`, зарегистрированный в fan-orchestrator. Координатор декомпозирует
план на security-задачи и делегирует их воркеру типа `security`, который
проходит методологию SKILL.md и запускает сканеры пакета, возвращая сводный
отчёт.

---

## Что внутри архива

```
fan-security-1.0.0.tar.gz
└── fan-security/
    ├── package.json      ← manifest бандла (v1.0.0)
    ├── DEPLOY.toml       ← deploy manifest (schema v1, type = bundle)
    ├── README.md         ← этот файл
    ├── extensions/
    │   └── fan-security/      (index.ts + cli/ + lib/ + package.json + README.md)
    └── skills/
        └── fan-security/      (SKILL.md + package.json)
```

---

## Spec

- Спека: `docs/specs/spec_security-worker_2026-08-31.md`
- Roadmap: `docs/features/security-worker/roadmap.md` → F-2.8

## Лицензия

MIT — см. корневой `LICENSE` репозитория FAN.
