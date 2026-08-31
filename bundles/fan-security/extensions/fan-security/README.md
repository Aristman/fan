# fan-security 🛡️

Extension-компонент бандла fan-security: аудита безопасности для FAN. Три
CLI-сканера и агрегирующая slash-команда `/security-scan`; SKILL.md-методология
ручного прохода (/skill:fan-security — OWASP Top 10 / CWE-чеклист, secret
scanning, аудит зависимостей, IaC и конфигураций) — в skill-компоненте бандла
(`bundles/fan-security/skills/fan-security/`).

## Состав пакета

| Компонент | Что делает |
|-----------|------------|
| `cli/scan-secrets.ts` | Поиск закоммиченных секретов (AWS, OpenAI, GitHub PAT, Slack, PEM, `.env`, entropy-эвристика); evidence маскируется (4+4) |
| `cli/scan-patterns.ts` | CWE-сигнатуры кода: SQL-инъекции (CWE-89), command injection (CWE-78), path traversal (CWE-22), XSS (CWE-79), weak crypto/randomness, hardcoded IV |
| `cli/dep-audit.ts` | Уязвимые зависимости: `npm audit` / `pnpm audit` / `yarn audit`, `pip-audit`, `cargo audit` |
| `/security-scan` | Slash-команда: запускает все три сканера разом и агрегирует отчёт в чат |

Skill-компонент бандла — `SKILL.md`-методология аудита — устанавливается рядом
(в `~/.fan/agent/skills/fan-security/`) и доступен через `/skill:fan-security`.

## Установка

Расширение распространяется в составе **бандла fan-security** (extension +
skill устанавливаются одной командой):

```bash
fan store install fan-security
```

Installer авто-детектит bundle по поддиректориям `extensions/` + `skills/` —
указывать `--type` не нужно: расширение встанет в
`~/.fan/agent/extensions/fan-security/`, скилл — в `~/.fan/agent/skills/fan-security/`.

Из локального архива (.tar.gz) — тоже без явного типа (авто-детект bundle
работает и для распакованного архива):

```bash
fan store install ./fan-security-1.0.0.tar.gz
```

После установки выполните `/reload` в сессии FAN.

## Использование

### CLI-сканеры

Команды выполняются из корня установленного расширения fan-security (обычно
`~/.fan/agent/extensions/fan-security/`):

```bash
# Секреты (ключи, токены, .env, entropy)
bun cli/scan-secrets.ts <path> [--format json] [--use-external off|auto|only]

# CWE-сигнатуры в коде
bun cli/scan-patterns.ts <path> [--format json] [--use-external off|auto|only]

# Уязвимые зависимости (npm/pnpm/yarn/pip/cargo)
bun cli/dep-audit.ts <path> [--format json]
```

- `<path>` — файл или директория (рекурсивный обход; `node_modules`/`.git` пропускаются).
- `--format json` — весь stdout — валидный JSON-отчёт; по умолчанию — человекочитаемый text.
- `--use-external off|auto|only` — гибридный режим с внешними тулзами (gitleaks / semgrep),
  по умолчанию `auto` (детект всегда, мердж если найдены).

### Slash-команда

```
/security-scan [path] [--format json]
```

Запускает все три сканера одним вызовом и публикует сводку в чат:
сканеры с счётчиками по severity, строки `[SEVERITY] file:line — title`, Total.
`--format json` — полный JSON-агрегат `{ summary, findings, scanners, target }`.
Если в отчёте сканера больше 20 findings, полный JSON этого отчёта пишется во
временный файл `security-scan-*.json` (путь указывается в сводке).

## Выход и коды возврата

Отчёт каждого сканера (схема `lib/report.ts`): `tool`, `target`, `findings[]`
(`severity` CRITICAL/HIGH/MEDIUM/LOW/INFO, `file:line`, `title`, `evidence`,
`remediation`, `confidence`), `summary { total, bySeverity }`, `externalTools`.

Коды возврата CLI (все три сканера):

| Код | Значение |
|-----|----------|
| `0` | чисто — findings нет |
| `1` | findings найдены |
| `2` | ошибка запуска (неверный путь/аргументы) |

Секреты в `evidence` всегда маскируются (`AKIA…MNOP`) — полный секрет не
попадает ни в отчёт, ни в чат.

## Зависимость от Этапа 1 (orchestrator)

Пакет работает и **независимо**: CLI-сканеры и `/security-scan` доступны в
обычной сессии без оркестратора.

Для **воркер-сценария** нужен Этап 1 фичи security-worker: agent type
`security`, зарегистрированный в fan-orchestrator (реестр агентных типов +
routing классификатора). Тогда координатор может декомпозировать план на
security-задачи и делегировать их воркеру типа `security`, который проходит
методологию SKILL.md и запускает сканеры пакета, возвращая сводный отчёт.

```text
Координатор ── делегирует security-задачу ──→ воркер (agent type security)
                                                 ├─ SKILL.md-методология
                                                 └─ cli/scan-*.ts + /security-scan
```

## Spec

- Спека: `docs/specs/spec_security-worker_2026-08-31.md`
- Roadmap: `docs/features/security-worker/roadmap.md` → F-2.8
