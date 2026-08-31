# Roadmap: Security-воркер для FAN (agent type `security` + extension `fan-security`)

> **Дата генерации:** 2026-08-31
> **Источник:** docs/specs/spec_security-worker_2026-08-31.md (v1.1, утверждена оператором)
> **Версия SKILL:** 1.3.0
> **Функций / Этапов:** 13 / 3 (лимит: 15 / 8)

> **Зафиксированные решения:** этапы и приоритеты унаследованы от утверждённой спеки (решения оператора №1–8). Схлопывания по правилам обособленности: F0.2 → критерий приёмки F-0.1, F0.3 → TDD-тест F-0.1, F1.2/F1.6 → содержимое F-1.1 (один файл промпта), F1.7 → TDD-тесты соответствующих фич.

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 13 |
| Этапов | 3 |
| P0 (критические) | 10 |
| P1 (высокие) | 3 |
| P2 (средние) | 0 |
| P3 (низкие) | 0 |

## Легенда

- ✅ — Реализовано
- ☐ — Запланировано
- ⏳ — В работе
- ❌ — Заблокировано

### Приоритеты
- **P0** — Критично (без этого фича не имеет смысла)
- **P1** — Высокий (важно для большинства пользователей)
- **P2** — Средний (полезно, но не срочно)
- **P3** — Низкий (future enhancement)

### Слои архитектуры
- **[API]** — Backend endpoint / RPC / middleware
- **[UI]** — React-компонент / страница / форма
- **[DATA]** — Модель / миграция / схема
- **[INTEG]** — Интеграция с внешним сервисом
- **[BIZ]** — Бизнес-правило / процесс
- **[CLI]** — Команда / скрипт

---

## Этап 0: Динамические списки агентных типов (рефакторинг)

**Цель:** к завершению этапа `WORKER_TYPES` (types.js), `AGENT_TYPES` (model-editor.js:22) и `agentTypes` (orchestrator-extension.js:~494) читаются из `getAgentTypes()` реестра, что подтверждено тестом «добавление фиктивного агента в реестр отражается во всех трёх источниках без правок кода».
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* дев-окружение fan, сборка зелёная.
- *Шаги:* 1) запустить `npm run build`; 2) запустить vitest extensions/fan-orchestrator; 3) в TUI выполнить `/agents` и `/orchestrator models`.
- *Ожидаемый результат:* 0 ошибок сборки и тестов; `/agents` показывает 8 built-in агентов; `/orchestrator models` показывает те же 8 типов в настройке моделей — идентично поведению до рефакторинга.
**Smoke-критерий этапа:** vitest-тест консистентности списков зелёный + `npm run build` без ошибок.

#### ☐ F-0.1: Динамические списки агентных типов из реестра
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** `WORKER_TYPES` (types.js:8-18), `AGENT_TYPES` (model-editor.js:22) и `agentTypes` (orchestrator-extension.js:~494) импортируют список из `getAgentTypes()` (`agents/index.js`) вместо собственных констант; кастомные user/project агенты в model-editor и `/orchestrator models` не показываются (поведение не меняется).
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-0.1-1:** Фиктивный агент из реестра появляется в WORKER_TYPES
    - *Условие:* в тесте реестр дополнен фиктивным агентом `test-fake` (mock `AGENT_REGISTRY`).
    - *Шаги:* вызвать источник `WORKER_TYPES` (после рефакторинга — функцию) и проверить вхождение.
    - *Ожидаемый результат:* `WORKER_TYPES` содержит `test-fake` без правок types.js. Сейчас (Red) — не содержит: массив статичен.
  - [ ] **TC-F-0.1-2:** Списки трёх источников идентичны реестру
    - *Условие:* реестр без изменений (8 built-in агентов).
    - *Шаги:* сравнить вывод трёх источников (types.js, model-editor, orchestrator-extension) с `getAgentTypes()`.
    - *Ожидаемый результат:* множества и порядок элементов идентичны; кастомные .md-агенты в model-editor не появляются.
- **Red-тест:** TC-F-0.1-1 — падает первым: при добавлении агента в реестр статичный `WORKER_TYPES` его не содержит.
- **Refactor-цели:** удалить три дублирующихся массива; сохранить порядок реестра для стабильности UI.
- **Критерии приёмки:**
  1. Добавление агента в `agents/` + `index.js` не требует правок types.js / model-editor.js / orchestrator-extension.js (подтверждено TC-F-0.1-1).
  2. `/orchestrator models` показывает ровно 8 built-in типов — идентично до-рефакторингу (TC-F-0.1-2).
  3. `npm run build` и существующие vitest-тесты оркестратора зелёные.
- **Ожидаемый результат:** types.js экспортирует `WORKER_TYPES` на основе реестра; model-editor.js и orchestrator-extension.js не содержат локальных массивов типов.
- **Оценка объёма:** M (≤ 1 день)

---

## Этап 1: Agent type `security` в fan-orchestrator

**Цель:** к завершению этапа координатор делегирует security-задачи воркеру `security` (routing fix подтверждён тестами), человек видит его в `/agents` и может запустить `/delegate security <task>`, воркер возвращает отчёт с findings по severity, не изменяя код.
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* coordinator mode включён (Alt+O), этапы 0 завершён.
- *Шаги:* 1) `/agents` — security присутствует с icon 🔒; 2) ввод «проверь модуль packages/api/src/auth на уязвимости»; 3) координатор вызывает `classify_task` → `security`, затем `delegate_task(agent: "security")`; 4) воркер анализирует модуль.
- *Ожидаемый результат:* отчёт с findings (severity, file:line, CWE, remediation), ни один файл не изменён; `/orchestrator models` позволяет настроить модель security.
**Smoke-критерий этапа:** vitest: реестр содержит security (readOnly=true, tools), `classifyTaskByDescription('security...')` → `security`; `/agents` отображает security.

#### ☐ F-1.1: Определение агента security с промпт-методологией
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** создать `extensions/fan-orchestrator/agents/security.js` и `security.md` (двойное определение по образцу verify.js/verify.md): `type: "security"`, `label: "Security Auditor"`, icon `🔒`, `readOnly: true`, `tools: [read, bash, grep, find, ls]`; промпт — методология полного скоупа (OWASP Top 10 / CWE-паттерны кода, secret scanning regex+entropy, dependency audit через bash, IaC: Dockerfile/compose/k8s, config audit: CORS/CSP/debug/TLS/cookie flags) + формат отчёта (severity CRITICAL..INFO, file:line, CWE, exploit vector, remediation, маскирование секретов, `needs-verification` для неподтверждённых) + правило read-only.
- **Пользовательская история:** «Как координатор, я хочу делегировать security-задачи специализированному read-only воркеру, чтобы получать систематический аудит вместо 4 строк чеклиста verify».
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-1.1-1:** Реестр резолвит security с корректным определением
    - *Условие:* файлы security.js/.md созданы, реестр импортирован.
    - *Шаги:* `getAgentDefinition('security')`; проверить поля.
    - *Ожидаемый результат:* readOnly=true; tools = ровно [read, bash, grep, find, ls]; icon 🔒; type "security". Сейчас (Red): undefined.
  - [ ] **TC-F-1.1-2:** MD-определение парсится и согласовано с JS
    - *Условие:* security.md с YAML frontmatter.
    - *Шаги:* parseFrontmatter(security.md); сверить name/description/tools с JS-определением.
    - *Ожидаемый результат:* name="security", description ≤ 1024 chars, tools идентичны JS-версии.
  - [ ] **TC-F-1.1-3:** Промпт содержит обязательные секции методологии
    - *Условие:* systemPrompt из определения.
    - *Шаги:* проверить вхождение маркеров: OWASP, CWE, secret scanning, dependency audit, IaC, configuration audit, severity-модель, маскирование секретов, read-only запрет.
    - *Ожидаемый результат:* все 9 маркеров присутствуют в body обоих определений.
- **Red-тест:** TC-F-1.1-1 — падает первым: `getAgentDefinition('security')` возвращает undefined, файла не существует.
- **Refactor-цели:** (none) — контент промпта уникален, общего кода с другими агентами нет; дублирование js↔md является паттерном проекта (все 8 агентов).
- **Критерии приёмки:**
  1. `getAgentDefinition('security')` возвращает определение со всеми полями (TC-F-1.1-1 зелёный).
  2. Промпт содержит все 9 обязательных секций и запрет изменения кода (TC-F-1.1-3).
  3. Найденные секреты в примерах отчёта промпта маскируются (4+4 символа).
- **Ожидаемый результат:** два файла agents/security.js + agents/security.md с полной методологией.
- **Оценка объёма:** L (≤ 2 дня, основное — промпт)

#### ☐ F-1.2: Регистрация в реестре и конфиге
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** добавить security в `AGENT_REGISTRY` (agents/index.js — import + запись) и `config.example.json` (ключ `"security"` в models cloud/local, `"security": 0.1` в agentTemperature). Благодаря F-0.1 других точек регистрации нет.
- **Зависимости:** F-0.1, F-1.1
- **TDD-тесты:**
  - [ ] **TC-F-1.2-1:** discoverAgents находит security среди built-in
    - *Условие:* реестр зарегистрирован, временный cwd с extensions-директорией.
    - *Шаги:* `discoverAgents(cwd, 'builtin')`; проверить наличие name="security" и source="builtin".
    - *Ожидаемый результат:* агент присутствует, readOnly=true. Сейчас (Red): отсутствует.
  - [ ] **TC-F-1.2-2:** Конфиг резолвит модель и температуру для security
    - *Условие:* config на основе config.example.json.
    - *Шаги:* `resolveWorkerModel('security', config, mode)` и `resolveWorkerTemperature('security', config)`.
    - *Ожидаемый результат:* без исключений; temperature = 0.1.
- **Red-тест:** TC-F-1.2-1 — падает первым: discoverAgents не возвращает security до регистрации.
- **Refactor-цели:** (none) — правка тривиальна, двух строк.
- **Критерии приёмки:**
  1. `discoverAgents(cwd, 'builtin')` содержит security (TC-F-1.2-1).
  2. config.example.json валиден (JSON.parse) и содержит оба ключа security.
- **Ожидаемый результат:** security виден во всех динамических потребителях: координаторский промпт, `/agents`, `/delegate`.
- **Оценка объёма:** S (≤ 4ч)

#### ☐ F-1.3: Routing fix классификатора задач
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** в `classifyTaskByDescription` (orchestrator-tools.js:~155) добавить проверку security-ключевых слов (`security`, `vulnerab`, `exploit`, `cve`, `owasp`, `injection`, `xss`, `secret`) **до** generic-правила verify; добавить security в `AGENT_ICONS` (🔒) и в `WORKER_PROFILES` (orchestrator-extension.js:~745) приоритет security-слов.
- **Пользовательская история:** «Как координатор, я хочу, чтобы задачи с security-симптомами автоматически направлялись security-воркеру, а обычные review/check оставались verify».
- **Зависимости:** F-1.2
- **TDD-тесты:**
  - [ ] **TC-F-1.3-1:** Security-задача направляется на security
    - *Условие:* classifyTaskByDescription реализован.
    - *Шаги:* `classifyTaskByDescription('проверь модуль на уязвимости и CVE')`.
    - *Ожидаемый результат:* `'security'`. Сейчас (Red): `'verify'`.
  - [ ] **TC-F-1.3-2:** Прежние маршруты не сломаны
    - *Условие:* текущие правила классификатора.
    - *Шаги:* прогнать 6 эталонных фраз: 'review this PR' → verify; 'fix bug in parser' → bug-fix; 'add feature X' → implement; 'write tests for Y' → tests-impl; 'research architecture' → code-research; 'update docs' → docs-impl.
    - *Ожидаемый результат:* все 6 маппингов без изменений.
- **Red-тест:** TC-F-1.3-1 — падает первым: security-слово уходит в verify по старому правилу.
- **Refactor-цели:** вынести security-ключевые слова в константу `SECURITY_KEYWORDS`, переиспользуемую task-complexity.js:44 (сейчас там дублирующийся regex).
- **Критерии приёмки:**
  1. Все 8 security-ключевых слов направляют на security (тест по каждому слову).
  2. 6 эталонных фраз прежних маршрутов без изменений (TC-F-1.3-2).
  3. `AGENT_ICONS['security']` = 🔒, `WORKER_PROFILES` содержит security-профиль.
- **Ожидаемый результат:** classifyTaskByDescription + AGENT_ICONS + WORKER_PROFILES обновлены, регресс-тесты зелёные.
- **Оценка объёма:** S (≤ 4ч)

#### ☐ F-1.4: Разграничение ролей verify и security в промптах
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** в verify.md/verify.js добавить явную границу роли «проверка свежего диффа после имплементации; глубокие аудиты → security-воркер»; в useFor security-определения (F-1.1) зеркальная формулировка «глубокий аудит фичи/модуля/репо по запросу, не дифф-проверка».
- **Зависимости:** F-1.1
- **TDD-тесты:**
  - [ ] **TC-F-1.4-1:** verify-промпт содержит границу роли
    - *Условие:* verify.md обновлён.
    - *Шаги:* проверить вхождение маркеров boundary-секции (fresh diff / после имплементации / передача аудитов security).
    - *Ожидаемый результат:* все 3 маркера присутствуют. Сейчас (Red): секции нет.
  - [ ] **TC-F-1.4-2:** useFor security и verify не пересекаются по триггерам
    - *Условие:* оба useFor распарсены.
    - *Шаги:* извлечь триггер-фразы, проверить отсутствие одинаковых routing-формулировок «после имплементации» в security и «глубокий аудит» в verify.
    - *Ожидаемый результат:* 0 пересечений.
- **Red-тест:** TC-F-1.4-1 — падает первым: boundary-секции в verify.md не существует.
- **Refactor-цели:** (none) — контент промптов.
- **Критерии приёмки:**
  1. verify.md/js содержат boundary-секцию (TC-F-1.4-1).
  2. useFor обоих агентов взаимно непересекающиеся (TC-F-1.4-2).
- **Ожидаемый результат:** согласованные промпты verify и security; координатор не путает роли.
- **Оценка объёма:** S (≤ 4ч)

---

## Этап 2: Extension `fan-security` (пакет FAN Store)

**Цель:** к завершению этапа существует самостоятельный пакет fan-security: три CLI-сканера (JSON+text, гибрид с авто-детектом gitleaks/semgrep), slash-команда `/security-scan`, SKILL.md, package.json готов к `fan store install`.
**Приоритет функций:** P0/P1
**E2E-сценарий этапа:**
- *Условие:* пакет собран и загружен (user scope), fixture-репо с seed-нарушениями (AWS-ключ, SQL-конкатенация, md5).
- *Шаги:* 1) `/security-scan <fixture> --format json` — валидный JSON со всеми тремя сканерами; 2) `bun cli/scan-secrets.js <fixture> --format text` — сводка, секрет замаскирован; 3) `/skill:fan-security` — методология загружена в контекст.
- *Ожидаемый результат:* findings по всем seed-нарушениям, exit-code 1, JSON валиден по схеме §6.1 спеки, секрет не воспроизводится полностью.
**Smoke-критерий этапа:** три CLI на fixture — корректные exit-codes и валидный JSON; extension загружается без ошибок (`/reload`).

#### ☐ F-2.1: Общая схема отчёта и text-рендер
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** создать `lib/report.ts` пакета fan-security: типы `Finding` (схема §6.1 спеки: id, scanner, severity, title, file, line, cwe, evidence, description, exploit, remediation, confidence) и `Report` ({tool, version, target, scannedAt, findings[], summary}); функция маскирования секретов (4+4 символа); text-рендер; хелперы exit-code (0/1/2).
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-2.1-1:** JSON-сериализация валидна и summary консистентна
    - *Условие:* Report с 3 findings (2 HIGH, 1 LOW).
    - *Шаги:* JSON.stringify → JSON.parse; сверить summary.bySeverity с фактическим подсчётом findings.
    - *Ожидаемый результат:* парсинг без ошибок; bySeverity = {HIGH:2, LOW:1}; total=3. Сейчас (Red): модуля нет, импорт падает.
  - [ ] **TC-F-2.1-2:** Маскирование секретов
    - *Условие:* evidence содержит 'AKIAABCDEFGHIJKLMNOP'.
    - *Шаги:* применить maskSecret(); проверить вывод.
    - *Ожидаемый результат:* 'AKIA…MNOP' — видны ровно первые 4 и последние 4 символа.
- **Red-тест:** TC-F-2.1-1 — падает первым: lib/report.ts не существует.
- **Refactor-цели:** выделить общие хелперы форматирования, переиспользуемые всеми CLI.
- **Критерии приёмки:**
  1. Схема Report соответствует §6.1 спеки, summary консистентна (TC-F-2.1-1).
  2. maskSecret всегда применяется к evidence (TC-F-2.1-2).
  3. vitest пакета зелёный.
- **Ожидаемый результат:** lib/report.ts — единый контракт данных всех CLI.
- **Оценка объёма:** S (≤ 4ч)

#### ☐ F-2.2: CLI scan-secrets
- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** `cli/scan-secrets.ts`: regex-паттерны (api_key, AKIA, sk-, ghp_, xox, PEM BEGIN, .env в репо) + entropy-эвристика; флаги `--format json|text` (text — дефолт), exit 0 чисто / 1 findings / 2 ошибка.
- **Зависимости:** F-2.1
- **TDD-тесты:**
  - [ ] **TC-F-2.2-1:** Находит AWS-ключ в fixture
    - *Условие:* tests/fixtures/secrets-sample.ts содержит 'AKIAABCDEFGHIJKLMNOP'.
    - *Шаги:* запустить сканер на fixture, --format json; парсинг вывода.
    - *Ожидаемый результат:* ≥1 finding, severity HIGH или CRITICAL, cwe CWE-798, evidence замаскирован, exit 1. Сейчас (Red): CLI не существует.
  - [ ] **TC-F-2.2-2:** Чистый файл даёт 0 findings
    - *Условие:* fixture без секретов.
    - *Шаги:* запустить сканер.
    - *Ожидаемый результат:* findings=[], exit 0.
  - [ ] **TC-F-2.2-3:** .env в сканируемой директории — finding
    - *Условие:* fixture содержит committed .env.
    - *Шаги:* запустить сканер.
    - *Ожидаемый результат:* finding INFO/LOW 'env file committed'.
- **Red-тест:** TC-F-2.2-1 — падает первым: cli/scan-secrets.ts не существует.
- **Refactor-цели:** паттерны — в data-driven `lib/patterns/secrets.ts` (расширение без изменения логики); entropy-константы вынесены.
- **Критерии приёмки:**
  1. 6 групп паттернов покрывают fixture (TC-F-2.2-1/3).
  2. exit-коды 0/1/2 корректны во всех трёх тестах.
  3. JSON-вывод валиден по схеме F-2.1.
- **Ожидаемый результат:** cli/scan-secrets.ts + fixtures.
- **Оценка объёма:** M (≤ 1 день)

#### ☐ F-2.3: CLI scan-patterns
- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** `cli/scan-patterns.ts`: сигнатуры CWE/OWASP в коде — SQL/cmd/path injection, XSS, weak crypto (md5/sha1), hardcoded IV/nonce, weak randomness; флаги и exit-codes как F-2.2.
- **Зависимости:** F-2.1
- **TDD-тесты:**
  - [ ] **TC-F-2.3-1:** Находит SQL-конкатенацию и md5 в fixture
    - *Условие:* tests/fixtures/patterns-sample.ts содержит SQL-конкатенацию и md5().
    - *Шаги:* запустить сканер --format json.
    - *Ожидаемый результат:* ≥2 findings: CWE-89 (SQLi), CWE-327 (weak crypto); file:line корректны; exit 1. Сейчас (Red): CLI нет.
  - [ ] **TC-F-2.3-2:** Чистый fixture — 0 findings, exit 0
- **Red-тест:** TC-F-2.3-1 — падает первым: cli/scan-patterns.ts не существует.
- **Refactor-цели:** сигнатуры — data-driven `lib/patterns/cwe.ts`; общий хелпер обхода файлов с F-2.2.
- **Критерии приёмки:**
  1. Минимум 6 групп сигнатур (injection SQL/cmd/path, XSS, weak crypto, randomness) срабатывают на fixtures.
  2. Единая схема отчёта с F-2.1 (JSON.parse валиден).
  3. Ложных срабатываний на чистом fixture: 0.
- **Ожидаемый результат:** cli/scan-patterns.ts + fixtures.
- **Оценка объёма:** M (≤ 1 день)

#### ☐ F-2.4: CLI dep-audit
- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** `cli/dep-audit.ts`: детект манифестов (package.json / requirements.txt / pyproject.toml / Cargo.toml), вызов соответствующих audit-утилит через bash (npm/pnpm/yarn audit, pip-audit, cargo audit); парсинг вывода в схему F-2.1; отсутствие утилиты/манифестов — информативное сообщение без падения.
- **Зависимости:** F-2.1
- **TDD-тесты:**
  - [ ] **TC-F-2.4-1:** Парсит вывод npm audit в findings
    - *Условие:* fixture-вывод npm audit --json (сохранён как файл, утилита замокана).
    - *Шаги:* запустить dep-audit с моком утилиты.
    - *Ожидаемый результат:* findings с severity из audit (critical/high), title содержит имя пакета, exit 1. Сейчас (Red): CLI нет.
  - [ ] **TC-F-2.4-2:** Нет манифестов — корректное сообщение
    - *Условие:* пустая директория без манифестов.
    - *Шаги:* запустить dep-audit.
    - *Ожидаемый результат:* 'no manifests found', findings=[], exit 0 (не ошибка).
- **Red-тест:** TC-F-2.4-1 — падает первым: cli/dep-audit.ts не существует.
- **Refactor-цели:** парсеры вывода утилит — отдельные функции с типами; общий runner внешних команд.
- **Критерии приёмки:**
  1. 3 формата манифестов распознаются (package.json, requirements.txt, Cargo.toml).
  2. Вывод npm audit транслируется в схему F-2.1 без потерь severity (TC-F-2.4-1).
  3. Отсутствие утилиты/манифестов не приводит к exit 2 (TC-F-2.4-2).
- **Ожидаемый результат:** cli/dep-audit.ts + fixture-выводы audit.
- **Оценка объёма:** M (≤ 1 день)

#### ☐ F-2.5: Гибридный режим авто-детекта внешних тулов
- **Приоритет:** P1
- **Слой:** [CLI]
- **Описание:** `lib/external.ts`: авто-детект gitleaks/semgrep по наличию бинаря в PATH (без скачивания); режимы `--use-external off|auto|only` (auto — дефолт); мердж findings внешних тулов с базовыми сканерами, дедупликация по (file, line, тип нарушения).
- **Пользовательская история:** «Как пользователь с установленным gitleaks, я хочу, чтобы fan-security использовал его результаты, чтобы получать более широкое покрытие без отказа базового режима».
- **Зависимости:** F-2.2, F-2.3
- **TDD-тесты:**
  - [ ] **TC-F-2.5-1:** Нет внешних тулов — чисто базовый режим
    - *Условие:* PATH без gitleaks/semgrep (мок env).
    - *Шаги:* скан с --use-external auto.
    - *Ожидаемый результат:* report.external = 'off', findings только от базовых сканеров, exit по ним.
  - [ ] **TC-F-2.5-2:** Мок gitleaks — результаты мерджатся и дедуплицируются
    - *Условие:* mock-бинарь gitleaks, возвращающий JSON с 2 findings (1 дублирует базовый по file:line).
    - *Шаги:* скан --use-external auto.
    - *Ожидаемый результат:* дубликат слит: ровно 1 из пары; scanner='external:gitleaks' у уникальных. Сейчас (Red): мерджа нет.
- **Red-тест:** TC-F-2.5-2 — падает первым: lib/external.ts не существует, мерджа нет.
- **Refactor-цели:** (none) — детект и мердж уже изолированы в lib/external.ts по плану.
- **Критерии приёмки:**
  1. Базовый режим самодостаточен при пустом PATH (TC-F-2.5-1).
  2. Дедупликация: 0 дублей (file, line, тип) в итоговом отчёте (TC-F-2.5-2).
  3. Флаги off|auto|only переключают поведение.
- **Ожидаемый результат:** lib/external.ts + интеграция в scan-secrets/scan-patterns.
- **Оценка объёма:** M (≤ 1 день)

#### ☐ F-2.6: Slash-команда /security-scan
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** index.ts extension-factory регистрирует `registerCommand('security-scan', ...)`: парсинг аргументов `[path] [--format json|text]`, запуск трёх сканеров, агрегация summary, вывод текстовой сводки (таблица severity × файл) в чат; JSON-путь к полному отчёту при объёме > 20 findings.
- **Пользовательская история:** «Как оператор, я хочу запустить аудит каталога одной командой и увидеть сводку в чате, чтобы не формулировать задачу координатору».
- **Зависимости:** F-2.2, F-2.3, F-2.4
- **TDD-тесты:**
  - [ ] **TC-F-2.6-1:** Команда регистрируется при загрузке extension
    - *Условие:* factory с mock ExtensionAPI.
    - *Шаги:* выполнить factory; проверить вызовы mock.registerCommand.
    - *Ожидаемый результат:* registerCommand('security-scan') вызван 1 раз с handler-функцией. Сейчас (Red): index.ts нет.
  - [ ] **TC-F-2.6-2:** Handler агрегирует три сканера
    - *Условие:* мок-запуск CLI (child_process замокан).
    - *Шаги:* вызвать handler('fixture --format json').
    - *Ожидаемый результат:* сводка содержит counts по трём scanner'ам; суммарный summary консистентен.
  - [ ] **TC-F-2.6-3:** Неверные аргументы — usage-подсказка
    - *Условие:* вызов без path.
    - *Шаги:* handler('').
    - *Ожидаемый результат:* сообщение с usage, без запуска сканеров, без исключения.
- **Red-тест:** TC-F-2.6-1 — падает первым: extension-файла не существует.
- **Refactor-цели:** (none) — тонкий слой над CLI.
- **Критерии приёмки:**
  1. Команда видна в списке slash-команд сессии после /reload.
  2. Сводка в чате: severity × файл, консистентна с JSON (TC-F-2.6-2).
  3. Вне репо/с пустыми аргументами — валидация без исключений (TC-F-2.6-3).
- **Ожидаемый результат:** index.ts с factory + registerCommand.
- **Оценка объёма:** M (≤ 1 день)

#### ☐ F-2.7: SKILL.md методология
- **Приоритет:** P1
- **Слой:** [BIZ]
- **Описание:** SKILL.md в корне пакета: frontmatter (name: fan-security, description ≤ 1024 chars) + методология аудита для обычных сессий: OWASP/CWE-чеклист, secret scanning, deps, IaC, config audit, формат отчёта с маскированием, ссылки на CLI-сканеры пакета (относительные пути, resolve against skill dir).
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-2.7-1:** SKILL.md валиден по правилам skill-движка
    - *Условие:* файл создан.
    - *Шаги:* parseFrontmatter + правила skills.ts (name = имени директории пакета, [a-z0-9-], description ≤ 1024).
    - *Ожидаемый результат:* 0 ошибок валидации. Сейчас (Red): файла нет.
  - [ ] **TC-F-2.7-2:** Методология полна
    - *Условие:* body SKILL.md.
    - *Шаги:* проверить 6 секций (OWASP/CWE, secrets, deps, IaC, config, формат отчёта) + упоминание маскирования.
    - *Ожидаемый результат:* все 7 маркеров присутствуют.
- **Red-тест:** TC-F-2.7-1 — падает первым: SKILL.md отсутствует.
- **Refactor-цели:** (none) — контент.
- **Критерии приёмки:**
  1. Валидация skill-движка проходит (TC-F-2.7-1).
  2. `/skill:fan-security` доступен при enableSkillCommands=true (ручная проверка на /reload).
- **Ожидаемый результат:** SKILL.md, подгружаемый и автоматически (по description), и через slash-команду.
- **Оценка объёма:** S (≤ 4ч)

#### ☐ F-2.8: Упаковка extension-пакета
- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** package.json пакета (`"type": "module"`, `"fan": {"type": "extension", "name": "fan-security"}`, main → index.ts) + README (установка user scope, использование CLI и /security-scan, зависимость от Этапа 1 для воркер-сценария); структура соответствует эвристикам installer (SKILL.md → skill, index.ts → extension).
- **Зависимости:** F-2.2, F-2.3, F-2.4, F-2.6, F-2.7
- **TDD-тесты:**
  - [ ] **TC-F-2.8-1:** package.json соответствует контракту extension
    - *Условие:* файл создан.
    - *Шаги:* JSON.parse; проверить fan.type, fan.name, main, type=module.
    - *Ожидаемый результат:* все поля корректны. Сейчас (Red): package.json пакета нет.
  - [ ] **TC-F-2.8-2:** Factory загружается без ошибок
    - *Условие:* index.ts реализован.
    - *Шаги:* выполнить factory с mock ExtensionAPI (как TC-F-2.6-1).
    - *Ожидаемый результат:* без исключений, регистрации применены.
- **Red-тест:** TC-F-2.8-2 — падает первым: index.ts не существует.
- **Refactor-цели:** (none) — упаковка.
- **Критерии приёмки:**
  1. Автоопределение типа installer'ом даст 'extension' (присутствие index.ts + package.json fan-секции).
  2. `fan store install ./fan-security-0.1.0.tar.gz` (локальный архив) устанавливает пакет в user scope, `/reload` подхватывает (ручная smoke).
  3. README описывает установку и оба сценария использования.
- **Ожидаемый результат:** готовый к публикации пакет fan-security v0.1.0.
- **Оценка объёма:** S (≤ 4ч)

---

## Полный чеклист по приоритетам

### P0 — Критические
- [ ] F-0.1 [INTEG]: Динамические списки агентных типов из реестра
- [ ] F-1.1 [BIZ]: Определение агента security с промпт-методологией
- [ ] F-1.2 [INTEG]: Регистрация в реестре и конфиге
- [ ] F-1.3 [BIZ]: Routing fix классификатора задач
- [ ] F-1.4 [BIZ]: Разграничение ролей verify и security
- [ ] F-2.1 [DATA]: Общая схема отчёта и text-рендер
- [ ] F-2.2 [CLI]: scan-secrets
- [ ] F-2.3 [CLI]: scan-patterns
- [ ] F-2.4 [CLI]: dep-audit
- [ ] F-2.6 [INTEG]: Slash-команда /security-scan

### P1 — Высокие
- [ ] F-2.5 [CLI]: Гибридный режим авто-детекта внешних тулов
- [ ] F-2.7 [BIZ]: SKILL.md методология
- [ ] F-2.8 [INTEG]: Упаковка extension-пакета

### P2 — Средние
(нет)

### P3 — Низкие
(нет)

---

## Граф зависимостей

```
F-0.1 ──→ F-1.2 ──→ F-1.3
F-1.1 ──→ F-1.2
F-1.1 ──→ F-1.4

F-2.1 ──→ F-2.2 ──→ F-2.5
  │    ──→ F-2.3 ──↗
  │    ──→ F-2.4
  │         │
  ├──→ F-2.2, F-2.3, F-2.4 ──→ F-2.6
  └── F-2.7 (независима)

F-2.2, F-2.3, F-2.4, F-2.6, F-2.7 ──→ F-2.8
```

- F-0.1 ← F-1.2 (регистрация использует консистентную инфраструктуру)
- F-1.1 ← F-1.2, F-1.4
- F-1.2 ← F-1.3
- F-2.1 ← F-2.2, F-2.3, F-2.4, F-2.6
- F-2.2, F-2.3 ← F-2.5
- F-2.2, F-2.3, F-2.4, F-2.6, F-2.7 ← F-2.8
- Циклов: нет (проверено). Этапы 0/1 и этап 2 параллелизуемы: fan-security не зависит от оркестратора.

---

## Делегирование (если применимо)

Не требуется: 13 функций ≤ 15, 3 этапа ≤ 8, все фичи однослойные.
