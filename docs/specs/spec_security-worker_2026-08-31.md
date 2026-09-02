# Спецификация: Security-воркер для FAN

## Метаданные
- **Дата**: 2026-08-31
- **Автор**: Specification Generator
- **Статус**: Черновик (утверждён оператором)
- **Версия**: 1.1 (добавлен Этап 0 — рефакторинг hardcoded-списков)
- **Тип**: Новая фича
- **Источники**: `docs/research/security-worker/ANALYSIS.md`, `.fan/reports/` (3 отчёта ресёрча)

### Утверждённые решения оператора (2026-08-31)
| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Архитектура | Этап 1 (agent type `security` во флоу) + Этап 2 (extension `fan-security`, гибрид) |
| 2 | Скоуп методологии | Полный: код (OWASP/CWE) + dependency audit + IaC + configuration audit |
| 3 | Имя типа воркера | `security` |
| 4 | Рефакторинг hardcoded-списков агентов | Нет, вне скоупа |
| 5 | Реализация CLI-сканеров | Гибрид: свои базовые + авто-детект установленных gitleaks/semgrep |
| 6 | Формат вывода CLI | JSON + текст, флаг `--format json\|text` |
| 7 | Размещение extension | Отдельный пакет, сразу под FAN Store (`fan store install fan-security`) |
| 8 | Рефакторинг hardcoded-списков агентов | Да, до Этапа 1, узким скоупом: динамический список из реестра; кастомные агенты в model-editor сознательно не показываем |

---

## 1. Обзор

### 1.1 Цель
Дать FAN специализированного security-специалиста: воркера-аудитора для нейронки-координатора и отдельные инструменты для человека — для выявления уязвимостей, утечек секретов, небезопасных зависимостей, IaC и конфигураций.

### 1.2 Контекст
Сейчас в fan security-функциональность практически отсутствует: verify-агент содержит только декларативный чеклист из 4 строк (`agents/verify.md:64-68`), остальная «security-активность» — runtime-защита (`permissions.js`), пассивная санитизация хранилищ (`SENSITIVE_PATTERNS`) и prompt-injection фильтр. Ни один из воркеров и скиллов не выполняет security-аудит кода. Routing-классификатор (`orchestrator-tools.js:155`) направляет security-задачи на verify — specialists не существует.

Ключевое ограничение инфраструктуры: воркеры оркестратора спавнятся с `--no-extensions --no-skills` (`subagent-runner.js:237+`) — extension-инструменты и скиллы воркерам недоступны. Следствие: сканеры для воркера — только bash-вызываемые CLI; extension-tools работают только в главной сессии.

### 1.3 Описание решения
Трёхшаговая разработка:

**Этап 0** — рефакторинг hardcoded-списков агентов: `WORKER_TYPES` (types.js), `AGENT_TYPES` (model-editor.js:22) и `agentTypes` (orchestrator-extension.js:494) читаются из реестра (`getAgentTypes()`) как единственного источника. Устраняет класс ошибок «забыть точку интеграции» и сокращает добавление нового агента до файла определения + регистрации. Кастомные user/project агенты в model-editor сознательно не показываются — поведение UI не меняется.

**Этап 1** — 9-й built-in agent type `security` в `extensions/fan-orchestrator`: read-only воркер с промпт-методологией полного скоупа (код + deps + IaC + конфиги), routing fix, регистрация в реестре. Доступен координатору (автоматически, через `buildCoordinatorPrompt`) и человеку (`/agents`, `/delegate security`).

**Этап 2** — отдельный extension-пакет `fan-security` под FAN Store (гибрид по образцу `stack-overflow-agents`): bash-вызываемые CLI-сканеры (секреты, паттерны, зависимости) в режиме JSON+text, slash-команда `/security-scan` для человека, SKILL.md-методология для обычных сессий.

---

## 2. Функциональные требования

### 2.1 Основные функции

**Этап 0 — рефакторинг hardcoded-списков агентов**

| ID | Функция | Описание |
|----|---------|----------|
| F0.1 | Единый источник списка | `getAgentTypes()` из `agents/index.js` — единственный источник; `WORKER_TYPES` (types.js:8-18), `AGENT_TYPES` (model-editor.js:22), `agentTypes` (orchestrator-extension.js:~494) читают из него |
| F0.2 | Поведение UI не меняется | Кастомные user/project `.md`-агенты в model-editor и `/orchestrator models` сознательно НЕ показываются (как и сейчас); config-модель и `resolveWorkerModel()` не трогаются |
| F0.3 | Тест консистентности | Юнит-тест: все три списка консистентны с реестром; добавление агента в реестр не требует правок в других местах |

**Этап 1 — agent type `security`**

| ID | Функция | Описание |
|----|---------|----------|
| F1.1 | Определение агента | `agents/security.js` + `agents/security.md`: `type: "security"`, `readOnly: true`, `tools: [read, bash, grep, find, ls]`, icon `🔒`, label `Security Auditor` |
| F1.2 | Промпт-методология | Полный скоуп: OWASP Top 10 / CWE-паттерны кода; secret scanning (regex + entropy); dependency audit через bash; IaC (Dockerfile, docker-compose, k8s); configuration audit (CORS, CSP, debug, permissions, TLS, cookie flags) |
| F1.3 | Регистрация | После Этапа 0: только `AGENT_REGISTRY` (agents/index.js) + `config.example.json` (models + `agentTemperature.security: 0.1`); `WORKER_TYPES` / model-editor / `/orchestrator models` подхватываются динамически |
| F1.4 | Routing fix | `classifyTaskByDescription` (orchestrator-tools.js ~:155): security-ключевые слова (`security`, `vulnerab`, `exploit`, `cve`, `owasp`, `injection`, `xss`, `secret`) → `security` **до** generic-правила verify; обычные review/check остаются на verify. `AGENT_ICONS` += security. `WORKER_PROFILES` (~:745) += профиль scoring |
| F1.5 | Разграничение с verify | verify = проверка свежего диффа после имплементации (включая базовые security-пункты); security = специализированный глубокий аудит фичи/модуля/репо по запросу, с отчётом и severity. Зафиксировано в `useFor` обоих агентов и в routing |
| F1.6 | Формат отчёта воркера | Findings с severity (CRITICAL/HIGH/MEDIUM/LOW/INFO); каждый: `file:line`, CWE (если применимо), описание, вектор эксплуатации, рекомендация по фиксу. Итог: сводная таблица + приоритеты. Каждый finding подтверждается цитатой кода; неподтверждённые подозрения помечаются `needs verification` |
| F1.7 | Юнит-тесты | Реестр содержит security (readOnly=true, tools); `discoverAgents` находит; classify: security-слова → security, старые кейсы не сломаны (review→verify) |

**Этап 2 — extension `fan-security`**

| ID | Функция | Описание |
|----|---------|----------|
| F2.1 | CLI `scan-secrets` | Regex-паттерны (api_key, AKIA…, sk-, ghp_, xox…, PEM-ключи, .env в репо) + entropy-эвристика. Вывод: JSON/text |
| F2.2 | CLI `scan-patterns` | Сигнатуры CWE/OWASP в коде: injection (SQL/cmd/path), XSS, weak crypto (md5/sha1), hardcoded IV, weak randomness, deserialization |
| F2.3 | CLI `dep-audit` | Определение манифестов (package.json/requirements.txt/pyproject.toml/Cargo.toml), вызов соответствующих audit-утилит через bash; fallback на osv.dev API при отсутствии локальных утилит |
| F2.4 | Гибридный режим | Авто-детект установленных gitleaks/semgrep (`--use-external auto`); при наличии — мердж их результатов с базовыми сканерами; `--use-external off\|auto\|only` |
| F2.5 | Формат вывода | `--format json` (машинный, для security-воркера) \| `--format text` (human-readable, дефолт для человека) |
| F2.6 | Slash-команда | `/security-scan [path] [--format]` в главной сессии (registerCommand) — запускает сканеры, выводит сводку |
| F2.7 | SKILL.md | Методология аудита для обычных (не-оркестраторных) сессий: `/skill:fan-security` или автоматическое срабатывание по description |
| F2.8 | Пакет FAN Store | package.json (`fan.type: extension`), манифест-совместимость с installer (`SKILL.md` → skill, `index.ts` → extension), готовность к публикации |

### 2.2 Пользовательские сценарии

#### Сценарий 1: Координатор делегирует аудит (нейронка)
**Предусловия:** coordinator mode, этап 1 реализован.
**Шаги:**
1. Оператор: «проверь модуль auth на уязвимости»
2. Координатор: `assess_task` → delegate; `classify_task` возвращает `security` (routing fix)
3. `delegate_task(agent: "security", task: "аудит packages/api/src/auth")`
**Ожидаемый результат:** отчёт с findings по severity, file:line, рекомендациями; код не изменён; фиксы — отдельные задачи для `bug-fix`/`implement`.

#### Сценарий 2: Человек запускает аудит вручную
**Предусловия:** этап 2 установлен (`fan store install fan-security`).
**Шаги:**
1. `/security-scan packages/api --format text`
2. Скрипты сканируют, результат — сводка в чате
**Ожидаемый результат:** перечень findings с severity и путями; JSON-вариант доступен через флаг.

#### Сценарий 3: Security-воркер использует CLI-сканеры (после этапа 2)
**Предусловия:** этапы 1–2 реализованы.
**Шаги:**
1. Координатор делегирует security-воркеру аудит
2. Воркер вызывает `bun cli/scan-secrets.js <path> --format json` через bash
3. LLM-анализ поверх машинных результатов
**Ожидаемый результат:** детерминированные скан-результаты + семантический анализ модели; меньше токенов, меньше пропусков.

#### Сценарий 4: Обычная сессия без оркестратора
**Предусловия:** этап 2 установлен.
**Шаги:**
1. Оператор: «проверь этот файл на security issues»
2. Модель видит `<available_skills>` → читает SKILL.md → применяет методологию
**Ожидаемый результат:** аудит по методологии без оркестратора.

### 2.3 Бизнес-правила
- security-воркер — **read-only**: никогда не изменяет код; фиксы только через другие воркеров
- Никаких внешних действий (сетевых запросов из воркера) кроме audit-утилит и osv.dev
- Findings без подтверждения кодом не выдаются как факты — только `needs verification`
- Найденные секреты в отчётах **маскируются** (первые/последние 4 символа) — воркер и CLI не должны воспроизводить секреты полностью
- CLI-сканеры не требуют обязательных внешних зависимостей: без установленных gitleaks/semgrep базовый режим полностью работоспособен

## 3. UI/UX требования

### 3.1 Экраны и компоненты
- `/agents` — security отображается в списке с icon 🔒 и scope-меткой
- `/delegate security <task>` — запуск аудита вручную
- `/orchestrator models` — security присутствует в per-agent настройке модели/температуры
- `/security-scan [path]` — slash-команда с сводкой результатов (таблица severity/файл)
- Модель-координатор: security в таблице агентов (`buildCoordinatorPrompt`) с routing-правилами

### 3.2 Взаимодействие
- Отчёты воркера и CLI — в стандартном потоке сообщений сессии
- `/security-scan` — прогресс-индикация сканеров, сводка + путь к полному JSON при большом объёме

### 3.3 Обработка ошибок
- CLI: отсутствие манифестов/утилит → информативное сообщение, не падение; exit-code 0 (скан чистый) / 1 (есть findings) / 2 (ошибка)
- `/security-scan` вне репо/на пустом пути — валидация аргументов
- Воркер: недоступность audit-утилит → fallback на ручной анализ (rg-паттерны) с пометкой в отчёте

## 4. Нефункциональные требования

### 4.1 Производительность
- security-воркер read-only → собственный слот, параллелен другим read-only (до `parallelWorkers`, default 3)
- CLI-скан: репо до ~100k строк — до 30 сек без внешних тулов; `--format json` без лишнего вывода
- Скоуп аудита задаётся путём в задаче — полный аудит большого монорепо не является default-сценарием

### 4.2 Безопасность
- Маскирование секретов в выводе CLI и отчётах воркера (см. 2.3)
- CLI-сканеры не выполняют содержимое сканируемых файлов, только читают
- Авто-детект внешних тулов — только по имени бинарника в PATH, без скачивания
- Промпт воркера запрещает изменение кода и установку пакетов

### 4.3 Надёжность
- CLI: предсказуемые exit-коды, JSON-схема стабильна (см. §6)
- Воркер наследует сталл-таймаут оркестратора (600s default)

### 4.4 Масштабируемость
- Паттерны сканеров — data-driven (JSON/TS-константы), расширение без изменения логики
- Пакет fan-security версируется независимо, распространяется через FAN Store

## 5. Технические требования

### 5.1 Стек технологий
- **Runtime**: Bun, TypeScript (strict), ESM — стиль соседних расширений
- **Этап 1**: изменения в `extensions/fan-orchestrator/` (см. F1.x)
- **Этап 2**: `packages/fan-security/` — отдельный пакет со структурой:

```
fan-security/
├── package.json          # { "type": "module", "fan": { "type": "extension", "name": "fan-security" } }
├── index.ts              # factory: registerCommand("security-scan")
├── SKILL.md              # методология (frontmatter: name, description ≤1024)
├── cli/
│   ├── scan-secrets.ts
│   ├── scan-patterns.ts
│   └── dep-audit.ts
├── lib/
│   ├── patterns/         # data-driven сигнатуры
│   ├── report.ts         # общая JSON-схема + text-рендер
│   └── external.ts       # авто-детект gitleaks/semgrep
└── README.md
```

### 5.2 Архитектура
- **Этап 1** повторяет паттерн существующих агентов: двойное определение (.js реестр + .md discovery), read-only слот, enrich модели через `resolveWorkerModel`
- **Этап 2** — гибрид `stack-overflow-agents`: extension регистрирует только slash-команду (никаких LLM-tools — они недоступны воркерам); вся «мускульная» часть — bash-вызываемые CLI; методология — SKILL.md
- Контракт «воркер → CLI»: security-воркер знает пути скриптов и флаги (прописано в его промпте после этапа 2); до этапа 2 воркер полнофункционален на rg/audit-утилитах

### 5.3 Интеграции
- npm/pnpm/yarn audit, pip-audit, cargo audit — опционально, через bash
- osv.dev API — fallback dependency-аудита (только запросы пакетов, без исходников)
- gitleaks / semgrep — опциональные усилители (авто-детект), без обязательной установки

## 6. Данные

### 6.1 Схема finding (общая для CLI и отчётов воркера)

```json
{
  "id": "SEC-001",
  "scanner": "scan-secrets | scan-patterns | dep-audit | external:<tool> | llm",
  "severity": "CRITICAL | HIGH | MEDIUM | LOW | INFO",
  "title": "string",
  "file": "relative/path",
  "line": 42,
  "cwe": "CWE-798",
  "evidence": "замаскированная цитата кода",
  "description": "string",
  "exploit": "вектор эксплуатации",
  "remediation": "рекомендация",
  "confidence": "confirmed | needs-verification"
}
```

### 6.2 Валидация / контракты CLI
- `--format json` → валидный JSON: `{ tool, version, target, scannedAt, findings[], summary: {bySeverity, total} }`
- Секреты в `evidence` маскируются всегда (кроме 4+4 символов)
- `summary.bySeverity` консистентен с `findings[]`

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Дублирование с verify (оба ловят одно и то же) | Средняя | Среднее | Routing fix + явное разграничение в useFor/prompts (F1.5) |
| Ложные срабатывания (entropy, regex) | Высокая | Низкое | Поле confidence, требование цитаты кода, LLM-подтверждение перед finding |
| Регрессия model-editor / `/orchestrator models` при Этапе 0 | Низкая | Среднее | Юнит-тест консистентности (F0.3) + отдельный verify; кастомные агенты в UI не добавляем (F0.2) |
| Сканеры этапа 2 не увидит воркер (ожидание extension-tools) | Низкая | Среднее | Контракт «воркер → CLI» зафиксирован в промпте этапа 2; задокументировано в анализе |
| Утечка найденных секретов в логи/отчёты | Низкая | Критичное | Обязательное маскирование (2.3, 6.2), тест на маскирование |
| Внешние тулы недоступны/несовместимы (Win) | Средняя | Низкое | Базовый режим самодостаточен; внешние — опция |

## 8. Компромиссы (Tradeoffs)

### 8.1 Принятые решения
- **Решение**: встроить как 9-й built-in agent type. **Альтернатива**: user/project `.md`-агент. **Обоснование**: динамическая инфраструктура готова; кастомный .md не конфигурируется, не распространяется, конфликтует с routing.
- **Решение**: гибрид extension (CLI + slash + SKILL.md) вместо extension-tools. **Альтернатива**: registerTool-сканеры. **Обоснование**: воркеры спавнятся с `--no-extensions`; LLM-tools видны только главной сессии.
- **Решение**: свои сканеры + авто-детект внешних. **Альтернатива**: только обёртки над gitleaks/semgrep. **Обоснование**: работа из коробки на Win/Linux/macOS без установки; мощность внешних — как усилитель.
- **Решение**: отдельный пакет для FAN Store. **Альтернатива**: каталог extensions/ в монорепо. **Обоснование**: распространение и независимое версирование; решение оператора (№7).
- **Решение**: рефакторинг hardcoded-списков до Этапа 1 (Этап 0). **Альтернатива**: security первым, рефакторинг потом или не делать. **Обоснование**: сокращает security-задачу с 7 до 4 файлов, устраняет класс ошибок «забыть точку», чистая git-история; скоуп ограничен (F0.2), цена ~полдня.
- **Решение**: verify не расширяется до аудитора. **Альтернатива**: усилить verify. **Обоснование**: разные роли (дифф vs аудит), смешение ухудшает промпты и маршрутизацию обоих.

## 9. Приоритеты

### Must Have (Обязательно)
- F0.1–F0.3: рефакторинг hardcoded-списков (Этап 0)
- F1.1–F1.7: agent type `security`, методология полного скоупа, routing fix, регистрация, юнит-тесты
- F2.1–F2.3, F2.5: базовые CLI-сканеры с JSON+text
- F2.6: `/security-scan`

### Should Have (Желательно)
- F2.4: авто-детект gitleaks/semgrep
- F2.7: SKILL.md
- F2.8: полная готовность пакета к публикации в FAN Store

### Could Have (Возможно)
- WORKER_PROFILES scoring-профиль (F1.4, опциональная часть)
- osv.dev fallback в dep-audit
- Тюнинг entropy-детектора по фидбеку

### Won't Have (Не входит)
- Отображение кастомных user/project агентов в model-editor и `/orchestrator models` (сознательное ограничение F0.2)
- Собственный SAST-движок уровня semgrep/CodeQL
- Extension-tools для воркеров (изменение `--no-extensions`)
- Расширение verify-агента
- Автоматический аудит на каждый commit/PR (по запросу только)

## 10. Следующие шаги

- [ ] Сгенерировать TDD-роадмапу (`/skill:feature-roadmap`) на основе спеки → `docs/features/security-worker/roadmap.md`
- [ ] Этап 0: рефакторинг hardcoded-списков (implement → verify)
- [ ] Этап 1: реализация agent type + routing fix + тесты (implement → verify)
- [ ] Этап 2: пакет fan-security — CLI-сканеры, slash-команда, SKILL.md (implement → verify)
- [ ] Документация: docs/guides/orchestrator.md, README, README пакета
- [ ] Опционально: публикация fan-security в FAN Store

---

*Создано: research-spec-generator skill*
*Исходный запрос: «Нужно разработать нового воркера — специалист по безопасности. Воркер будет исследовать код на уязвимости, утечки, проблемы безопасности. Исследовать варианты — встраивать ли во флоу или отдельный вариант, расширение или скилл, дать расширенный анализ».*
