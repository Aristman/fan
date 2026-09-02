# Security-воркер для FAN — расширенный анализ архитектуры

> Дата: 2026-08-31 · Статус: на утверждение · Источники: `.fan/reports/code-research-agent-types.md`, `.fan/reports/code-research-extensions-vs-skills.md`, `.fan/reports/explore-security-landscape.md`

## TL;DR

Security-воркер — **полностью новая функциональность**: сейчас в fan нет ничего, кроме чеклиста из 4 строк в промпте verify-агента. Инфраструктура оркестратора готова к добавлению нового типа воркера почти без усилий (discovery, слоты, UI — всё динамическое).

**Рекомендация: два этапа.**

1. **Этап 1 — встроить в существующий флоу** как 9-й built-in agent type `security` в `extensions/fan-orchestrator` (read-only, ~7 файлов, основная работа — промпт-методология). Нейронка получает его автоматически (координатор видит в таблице агентов и делегирует), человек — через `/agents` и `/delegate security`.
2. **Этап 2 — гибридное расширение `fan-security`** (FAN Store): CLI-сканеры (secrets, dependencies, паттерны), вызываемые воркером через bash, + slash-команда `/security-scan` для человека + SKILL.md-методология.

Отдельный «доп-вариант» (user/project `.md`-агент без изменений кода) — годится только как однодневный пилот: не конфигурируется, не распространяется, конфликтует с маршрутизацией. Скилл в одиночку — слаб: не регистрирует инструменты и недоступен воркерам оркестратора (те спавнятся с `--no-skills`).

**Критический факт, влияющий на архитектуру:** воркеры спавнятся с `--no-extensions --no-skills` (`subagent-runner.js:237+`). Инструменты из extension'ов security-воркер **не увидит**. Значит, сканеры для воркера — только bash-CLI-скрипты; extension-tools работают в главной сессии (человек, координатор).

---

## 1. Что уже есть (и почему этого мало)

Существующая «security-активность» fan закрывает **другие** задачи:

| Механизм | Что делает | Почему не замена |
|---|---|---|
| `verify`-агент (`agents/verify.js:35`, `verify.md:64-68`) | Чеклист после имплементации: injection, secrets, auth, data | 4 строки декларации, без методологии и инструментов; проверяет дифф, а не кодовую базу |
| `permissions.js` → `isDangerousCommand()` | Runtime-защита от опасных bash-команд | Защита во время выполнения, не аудит кода |
| `SENSITIVE_PATTERNS` (persistent-memory, soul) | Редактирование секретов при записи в хранилища | Пассивная санитизация, не сканирование репо |
| `message-sanitizer.ts` (fan-mission) | Prompt-injection фильтр межагентных сообщений | Другой слой вообще |
| fan-store publish-валидация | Блокирует `.env/.ts/.js` в архивах | Защита стора, не пользователя |

Не покрыто вообще: secret scanning (regex+entropy), dependency audit (npm/pip/cargo audit, osv.dev), SAST-паттерны, configuration audit (CORS/CSP/debug), OWASP Top 10, IaC (Dockerfile/k8s), отчёты с severity-классификацией.

## 2. Кандидатные механизмы — сравнение

| Критерий | A. Built-in agent type | B. User/project `.md`-агент | C. Extension | D. Skill |
|---|---|---|---|---|
| Виден координатору как воркер | ✅ | ✅ (динамически) | ❌ (не воркер) | ❌ |
| Виден человеку | `/agents`, `/delegate` | те же | slash-команда | `/skill:name` |
| Собственные инструменты-сканеры | ❌ (только базовые tools) | ❌ | ✅ registerTool | ❌ |
| Доступен воркерам оркестратора | ✅ | ✅ | ❌ (`--no-extensions`) | ❌ (`--no-skills`) |
| Config (модель, temperature) | ✅ | ❌ (model-editor не знает) | n/a | n/a |
| Изменения кода | ~7 файлов | 0 | новый пакет | 1 файл |
| FAN Store / другим пользователям | ✅ (в составе fan) | ❌ | ✅ | ✅ |
| Override | — | project > user > builtin | — | — |

### Почему «отдельный доп-вариант» (B) слаб
- Работает мгновенно, но **не продукт**: нет в коробке fan, нет per-agent конфига моделей, hardcode-массивы (`WORKER_TYPES`, model-editor) его не знают.
- **Конфликт маршрутизации**: `classifyTaskByDescription` (`orchestrator-tools.js:155`) направляет задачи со словами `security|audit|...` на `verify`. Кастомный агент конкурирует с этим маршрутом — поведение недетерминированное.
- Позиционируется как личный костыль, а fan — релизный проект (Phase 7 завершена).

### Почему скилл (D) в одиночку — не ответ
- Скилл — это **инструкции**, не инструменты и не воркер. Координатор не может делегировать скилл; модель в обычной сессии может его прочитать, но это ad-hoc, без слотов, отчётов и трекинга.
- Воркеры оркестратора спавнятся с `--no-skills` — security-воркер скилл не увидит.

## 3. Ключевая развилка: встраивать во флоу?

**Да.** Аргументы:

1. **Инфраструктура готова.** Discovery агентов, слоты (read-only воркер получает собственный слот и параллелится), координаторский промпт (`buildCoordinatorPrompt` строит таблицу агентов из реестра), `/agents` и `/delegate` — всё динамическое. Добавление типа — низкий риск.
2. **Симметрия для нейронки и человека.** Координатор получает security в списке агентов + routing-правила → осознанная делегация. Человек — `/delegate security "audit auth module"` или через RPC-клиентов (IDE-плагины, dashboard).
3. **Разделение ответственности с verify** можно зафиксировать явно:
   - `verify` — после имплементации, проверка диффа (включая базовые security-пункты);
   - `security` — специализированный глубокий аудит фичи/модуля/репозитория по запросу, с отчётом и severity.
   - Routing (`classifyTaskByDescription`, task-complexity keywords, WORKER_PROFILES) обновляется в том же изменении.

Против встраивания нет технических аргументов; единственный «против» — touching hardcoded-массивов, что и так является техдолгом оркестратора (модель/temperature-конфиг держит фиксированный список типов).

## 4. Рекомендуемая архитектура

### Этап 1 — agent type `security` в fan-orchestrator (встройка во флоу)

Read-only воркер (`tools: read, bash, grep, find, ls`, `readOnly: true`) — свой слот, параллелен другим read-only.

Изменения (~7 файлов):
1. **Новый** `agents/security.js` + `agents/security.md` — определение и промпт-методология:
   - чеклист: OWASP Top 10, CWE-паттерны, hardcoded secrets (regex + entropy-эвристика), injection (SQL/cmd/path), auth/authz, sensitive data в логах;
   - техники через bash: `rg` по паттернам, `npm audit` / `pip-audit` / `cargo audit`, анализ конфигов (CORS, debug, permissions), IaC-файлы;
   - формат отчёта: findings с severity (critical/high/medium/low), file:line, вектор эксплуатации, рекомендация по фиксу;
   - границы: read-only, никакого кода не менять, findings → координатор (фикс — отдельная задача для `bug-fix`).
2. `agents/index.js` — регистрация в `AGENT_REGISTRY`.
3. `types.js` — `WORKER_TYPES` += `"security"`.
4. `model-editor.js:22` и `orchestrator-extension.js:494` — hardcoded-списки += `security`.
5. `config.example.json` — `models.security`, `agentTemperature.security` (низкая, ~0.1–0.2 — аудиту нужна детерминированность).
6. **Routing fix**: `orchestrator-tools.js:155` (`classifyTaskByDescription`) — выделить `security|vulnerab|exploit|CVE|secret` → `security` вместо `verify`; WORKER_PROFILES и/или правила в `buildCoordinatorPrompt`.

Тесты: юнит на реестр/discover (новый тип резолвится, readOnly=true), routing-классификатор. Прогон: vitest оркестратора + `npm run build`.

Оценка: ~200–300 строк, большая часть — промпт. Один implement-воркер + verify.

### Этап 2 — расширение `fan-security` (гибрид по образцу `stack-overflow-agents`)

```
extensions/fan-security/
├── package.json            # fan.type = "extension"
├── index.ts                # factory: registerCommand("security-scan")
├── SKILL.md                # методология аудита (для человека: /skill:security)
├── cli/                    # bash-вызываемые сканеры — ВОТ они доступны воркеру
│   ├── scan-secrets.js     # regex + entropy (gitleaks-подход)
│   ├── scan-patterns.js    # CWE/OWASP сигнатуры
│   └── dep-audit.js        # обёртка npm/pip/cargo audit + osv.dev
└── README.md
```

- **Для воркера**: CLI-сканеры вызываются через bash (как `scripts/` в скилле auto-tests). Детерминированные, дешёвые по токенам сканы + LLM-анализ результатов сверху.
- **Для человека**: `/security-scan [path]` в главной сессии + SKILL.md как standalone-методология для обычных (не-оркестраторных) сессий.
- **Распространение**: FAN Store (`fan store install fan-security`).
- Extension-tools (`registerTool`) — опционально, для главной сессии; воркерам они всё равно не видны, поэтому CLI — обязательная часть.

Публикация этапа 2 в FAN Store отдельным вопросом (store-сервер уже поднят, tools/fan-store-server/GUIDE.md).

## 5. Что НЕ делать

- ❌ Не пилотить «отдельным .md в `~/.fan/agent/agents/`» как конечное решение — это костыль вне продукта.
- ❌ Не рассчитывать на extension-tools внутри воркеров — `--no-extensions` это исключает.
- ❌ Не расширять verify до полноценного аудитора — он про дифф-проверку; смешение ролей ухудшит маршрутизацию и промпты обоих.
- ❌ Не встраивать сканеры в ядро coding-agent — security-аудит не нужен каждой сессии; extension-граница правильная.

## 6. Риски

| Риск | Митигация |
|---|---|
| Дублирование с verify (оба начнут ловить одно и то же) | Явное разграничение в промптах + routing fix; verify остаётся «после-имплементационный дифф» |
| Hardcoded-массивы снова забудут при следующем типе | (опционально) заодно отрефакторить WORKER_TYPES/model-editor на динамический список — отдельная задача |
| Ложные срабатывания сканеров (entropy → false positives) | Severity-модель + требование подтверждения LLM-анализом перед finding'ом |
| Дорогие audits на больших репо | Скоуп-параметр в задаче (путь/модуль); параллельность read-only слотов |

## 7. Решение (утверждено оператором 2026-08-31)

1. **Архитектура:** Этап 1 + Этап 2 (гибрид).
2. **Скоуп методологии:** полный — код (OWASP/CWE) + dependency audit + IaC + configuration audit.
3. **Имя типа:** `security`.
4. **Hardcoded-списки агентов:** не рефакторим в рамках этой задачи (отдельная задача на потом).

План реализации Этапа 1: новые `agents/security.js` + `agents/security.md`, регистрация в `agents/index.js`, `WORKER_TYPES` (types.js), model-editor.js:22, orchestrator-extension.js:494, config.example.json, routing fix в orchestrator-tools.js:155 + AGENT_ICONS + WORKER_PROFILES, юнит-тесты (реестр/discover/classify).

## 8. Открытые вопросы (решение за оператором)

1. Подтвердить поэтапность: Этап 1 сейчас, Этап 2 следом (или только Этап 1 / сразу оба)?
2. Скоуп методологии Этапа 1: код-only, или сразу + dependency audit + IaC?
3. Имя типа: `security` (рекомендую) vs `security-audit`.
4. Нужен ли заодно рефакторинг hardcoded-списков агентов на динамические (выйдет за скоуп, но закроет техдолг).

> Ответы на §8 утверждены оператором — см. §7.
