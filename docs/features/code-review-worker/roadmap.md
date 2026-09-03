# Roadmap: Code-Review Worker для FAN Orchestrator

> **Дата генерации:** 2026-09-03
> **Источник:** `docs/specs/spec_code-review-worker_2026-09-03.md` (v1.0) + `.fan/reports/plan-code-review-worker.md`
> **Версия SKILL:** 1.3.0
> **Функций / Этапов:** 15 / 7 (лимит: 15 / 8)

> **Примечание (Won't Have из спеки §9) — в roadmap НЕ включены:**
> - Реализации GitHub/Bitbucket адаптеров (только contract в v1, реализации — следующие фазы)
> - Полный аудит репо (только diff-only)
> - FAN Store дистрибуция правил (правила встроены в `extensions/fan-orchestrator/review-rules/`)
> - Глубокий security-аудит (ответственность `security`-воркера; code-review только маркирует и переадресует)
> - Программный stack detection (LLM-инструкция «прочитай манифесты»)
> - Memory для воркера (передаётся через coordinator previousFindings)
> - Программные хэши для регенерации conventions (LLM-энфорсится в v1; фаза 2)
>
> **Отклонения от предложений плана:**
> - Тесты НЕ выделены в отдельный этап (правило скилла: тесты внутри карточек функций, vitest-тесты TDD)
> - Этап «Доки» из плана НЕ включён (документация ведётся отдельным docs-impl-воркером)
> - Этап 4 плана «Платформенный contract» поглощён фичей F-15, отделён от интеграции в собственный этап 7 (позволяет выкатить v1 без готовых платформ)
> - 7 этапов (план предлагал 6) — добавлен этап-связка «Lifecycle + Loading + Injection», т.к. фичи F-6/F-4/F-13 имеют общий триггер (data flow conventions + rules в worker context) и общий red-тест на `enrichWorkerContext`

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 15 |
| Этапов | 7 |
| P0 (критические) | 13 |
| P1 (высокие) | 2 |
| P2 (средние) | 0 |
| P3 (низкие) | 0 |

## Легенда

- ✅ — Реализовано
- ☐ — Запланировано
- ⏳ — В работе
- ❌ — Заблокировано

### Приоритеты
- **P0** — Критично (без этого фича не имеет смысла) — взято из спеки §9 «Must Have»
- **P1** — Высокий (важно для большинства пользователей) — взято из спеки §9 «Should Have»
- **P2** — Средний (полезно, но не срочно) — взято из спеки §9 «Could Have» (в roadmap не попало)
- **P3** — Низкий (future enhancement) — в roadmap не попало

### Слои архитектуры
- **[API]** — Backend endpoint / RPC / middleware (в roadmap не использован — orchestrator-extension это CLI-runtime, не HTTP API)
- **[UI]** — React-компонент / страница / форма (в roadmap не использован — UI-иконка воркера в coordinator-промпте описана в F-14 [CLI])
- **[DATA]** — Файл данных / схема / формат (conventions.md, finding, rules-файлы)
- **[INTEG]** — Интеграция с внешним ресурсом (git clone, rules loading, types contract)
- **[BIZ]** — Бизнес-правило / процесс (routing, verdict mapping, review workflow)
- **[CLI]** — Конфигурация runtime / агент / профиль воркера

---

## Этап 1: Rules corpus (фундамент данных)

**Цель:** Создать статический контент-корпус правил `extensions/fan-orchestrator/review-rules/` (6 файлов), на который опираются все последующие этапы.
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* orchestrator-extension собран, `extensions/fan-orchestrator/` смонтирован.
- *Шаги:* `ls extensions/fan-orchestrator/review-rules/` → 6 файлов; `wc -c review-rules/*.md` показывает каждый ≤ 5000 chars; `grep -l "Loading order" review-rules/README.md` находит индекс.
- *Ожидаемый результат:* CI-проверка `wc -c review-rules/*.md` зелёная (правила влезают в контекст-бюджет 22500 chars), README содержит секцию «Loading order: common → <stack> → conventions».
**Smoke-критерий этапа:** `cat review-rules/README.md | grep "Loading order"` возвращает 1 строку с упоминанием `common.md` и `<stack>.md`.

#### ☐ F-1: Review-rules corpus
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Создать 6 markdown-файлов с правилами код-ревью (cross-stack + 4 стека + индекс) в `extensions/fan-orchestrator/review-rules/`. Каждый файл ≤ 5000 chars (CI-валидация). Объём ≥ 50% файлов покрывает checklist из 10–15 пунктов на стек.
- **Пользовательская история:** «Как reviewer-воркер, я хочу читать структурированные правила по манифесту стека, чтобы выдавать стабильные findings и severity».
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-1-1:** `review-rules/common.md` существует и содержит все 4 severity (`CRITICAL|MAJOR|MINOR|INFO`) + маппинг на verdict
    - *Условие:* orchestrator-extension смонтирован, CI запускает `npm test review-rules.test.mjs`.
    - *Шаги:* arrange: загрузить `review-rules/common.md` через `fs.readFileSync`. act: regex `/Severity:\s*(CRITICAL|MAJOR|MINOR|INFO)/g` по тексту + regex `/CHANGES_REQUESTED|APPROVED|NEEDS_DISCUSSION/` для маппинга. assert: ≥ 1 совпадение каждого severity; ≥ 1 совпадение каждого из 3 verdict-маркеров.
    - *Ожидаемый результат:* `toHaveLength(4)` для severity; `toHaveLength(3)` для verdict-маркеров.
  - [ ] **TC-F-1-2:** Каждый из 4 stack-файлов имеет Stack Detection Hints + Reviewer Checklist ≥ 10 пунктов
    - *Условие:* CI-валидация файлов правил.
    - *Шаги:* arrange: `["typescript", "python", "kotlin", "rust"].forEach(stack => loadFile(stack))`. act: regex `/Stack Detection Hints/` (1 совпадение) + `/^\d+\.\s/gm` (≥ 10 чек-айтемов). assert: оба условия true для каждого стека.
    - *Ожидаемый результат:* `expect(stackFiles).toHaveLength(4)` + каждый файл проходит оба regex.
  - [ ] **TC-F-1-3:** `wc -c review-rules/*.md` показывает ≤ 5000 chars на файл (контекст-бюджет)
    - *Условие:* CI-проверка размера перед коммитом.
    - *Шаги:* arrange: `fs.readdirSync(reviewRulesDir).map(fs.statSync).map(s => s.size)`. act: `Math.max(...sizes) <= 5000`. assert: `expect(max).toBeLessThanOrEqual(5000)`.
    - *Ожидаемый результат:* максимальный размер файла ≤ 5000 chars (4 правила + common укладываются в 22500 chars контекст-бюджета).
- **Red-тест:** TC-F-1-1 (самый первый: директория `review-rules/` не существует → `fs.readFileSync` бросает `ENOENT`, тест падает на arrange).
- **Refactor-цели:** Вынести общий severity-маппинг в один regex-блок (избежать дублирования между common.md и stack-файлами); добавить frontmatter в каждый файл (`stack: typescript`, `version: 1.0`) для программной валидации в Фазе 2.
- **Критерии приёмки:**
  1. 6 файлов (`common.md`, `typescript.md`, `python.md`, `kotlin.md`, `rust.md`, `README.md`) существуют в `review-rules/` и непусты.
  2. Каждый из 5 файлов правил — ≤ 5000 chars; каждый содержит обязательные секции (Severity Model + Reviewer Checklist).
  3. README содержит раздел «Loading order» с порядком `common.md → <stack>.md → conventions.md`.
- **Ожидаемый результат:** `extensions/fan-orchestrator/review-rules/{common,typescript,python,kotlin,rust,README}.md` — 6 файлов, проходят CI-валидацию `wc -c` + содержательный grep.
- **Оценка объёма:** M (≤ 1 день; ~3–5 K chars × 5 файлов + README)

---

## Этап 2: Agent definition & verdict parser (worker contract)

**Цель:** Зарегистрировать воркер `code-review` в агентурном реестре, разметить `readOnly:true` + иконку 🔎 + tools, расширить `parseVerdict` до 6 значений.
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* Этап 1 завершён, `getAgentTypes()` возвращает массив.
- *Шаги:* `import { getAgentTypes } from "../agents/index.js"` → содержит `"code-review"`; `parseVerdict("VERDICT: changes_requested\n")` → `"CHANGES_REQUESTED"`; `parseVerdict("VERDICT: NEEDS_DISCUSSION\n")` → `"NEEDS_DISCUSSION"`.
- *Ожидаемый результат:* `getAgentTypes()` length увеличился на 1 (было 9 → стало 10); `parseVerdict` устойчив к case + whitespace для всех 6 значений.
**Smoke-критерий этапа:** `npx vitest run test/agents-code-review-definition.test.mjs` — все ассерты зелёные.

#### ☐ F-2: Agent definition (code-review.js + .md)
- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** Создать `agents/code-review.{js,md}` по образцу `verify`: `label: "Code Reviewer"`, `icon: "🔎"`, `readOnly: true`, `tools: [read, bash, grep, find, ls]`, `description`/`useFor` с разграничением от verify («build/tests/lint») и security («deep OWASP»). Файл `code-review.md` — ~150–200 строк: ROLE → ROLE BOUNDARY → CRITICAL RULES → STEP 0-3 → REVIEW CHECKLIST → COMMON MISTAKES → MANDATORY OUTPUT FORMAT. Зарегистрировать в `agents/index.js`.
- **Пользовательская история:** «Как координатор, я хочу иметь 10-го воркера с иконкой 🔎 и атрибутами read-only, чтобы пользователь видел его в task widget и мог отправить ему задачу».
- **Зависимости:** (none — но F-1 должна существовать к моменту Green, т.к. STEP 2 промпта ссылается на `CODE_REVIEW_RULES_DIR`)
- **TDD-тесты:**
  - [ ] **TC-F-2-1:** `getAgentTypes()` содержит `"code-review"` + `agents/code-review.js` соответствует контракту (readOnly/icon/tools/label)
    - *Условие:* orchestrator собран, vitest импортирует `agents/index.js` + `agents/code-review.js`.
    - *Шаги:* arrange: `import { getAgentTypes } from "../agents/index.js"` + `import codeReviewDef from "../agents/code-review.js"`. act: `getAgentTypes().includes("code-review")` + extract definition fields. assert: `expect(types).toContain("code-review")` AND `toHaveLength(10)`; `expect(codeReviewDef.readOnly).toBe(true)`, `expect(codeReviewDef.icon).toBe("🔎")`, `expect(codeReviewDef.tools.sort()).toEqual(["bash","find","grep","ls","read"])`, `expect(codeReviewDef.label).toBe("Code Reviewer")`.
    - *Ожидаемый результат:* тип зарегистрирован (10 элементов) + контракт definition полностью совпадает с эталоном.
  - [ ] **TC-F-2-2:** `agents/code-review.md` содержит 10 обязательных секций: ROLE, ROLE BOUNDARY, CRITICAL RULES, STEP 0, STEP 1, STEP 2, STEP 3, REVIEW CHECKLIST, COMMON MISTAKES, MANDATORY OUTPUT FORMAT
    - *Условие:* файл существует, парсится как markdown.
    - *Шаги:* arrange: `fs.readFileSync("agents/code-review.md", "utf-8")`. act: `text.match(/^## (ROLE|ROLE BOUNDARY|CRITICAL RULES|STEP 0|STEP 1|STEP 2|STEP 3|REVIEW CHECKLIST|COMMON MISTAKES|MANDATORY OUTPUT FORMAT)/gm)`. assert: `expect(matches).toHaveLength(10)`.
    - *Ожидаемый результат:* все 10 секций присутствуют; файл содержит упоминания всех 4 стеков (`typescript`/`python`/`kotlin`/`rust`) + 6 вердиктов + `conventions.md` + heredoc-исключение.
  - [ ] **TC-F-2-3:** Error case — битый YAML-frontmatter или имя файла не совпадает → агент не резолвится, реестр не ломается (graceful)
    - *Условие:* две tmp-директории: (a) `code-review.md` с corrupted YAML-frontmatter (вместо `---` delimiters — `:::invalid\nfoo: bar\n:::invalid`); (b) валидный `code-review.md` + соседний `code-review-v2.md` с произвольным содержимым.
    - *Шаги:* arrange: создать tmp-структуру; запустить тот же loader, что использует `agents/index.js`. act + assert: (a) loader либо бросает `Error` с упоминанием `frontmatter` (явная ошибка), либо логирует warning и пропускает файл — главное, НЕ unhandled exception; `getAgentTypes()` всё равно содержит остальные типы; (b) `getAgentDef("code-review-v2")` → `undefined` (только точное имя `code-review.md` матчится типом `"code-review"`).
    - *Ожидаемый результат:* воркер не падает в рантайме при плохом frontmatter; файлы с другими именами не создают новых типов; реестр остаётся консистентным.
- **Red-тест:** TC-F-2-1 (падает первым, т.к. `agents/code-review.{js,md}` ещё не созданы, а `agents/index.js` не импортирует их → `getAgentTypes()` возвращает 9 типов).
- **Refactor-цели:** Извлечь общие поля (`readOnly: true`, `tools` list) в shared helper `makeReadOnlyAgent({label, icon, description, useFor})` если `agents/code-review.js` дублирует verify/security; унифицировать frontmatter-парсинг `.md` файлов.
- **Критерии приёмки:**
  1. `getAgentTypes()` возвращает массив из 10 элементов (включая `code-review`); `getAgentTypes().indexOf("code-review") === 9`.
  2. `agents/code-review.js` экспортирует объект с `readOnly: true`, `icon: "🔎"`, `tools: [read, bash, grep, find, ls]`, `label: "Code Reviewer"`.
  3. `agents/code-review.md` содержит 10 обязательных секций (см. TC-F-2-2) и ≥ 150 строк; битый frontmatter / нестандартное имя файла не ломают реестр (см. TC-F-2-3).
- **Ожидаемый результат:** `extensions/fan-orchestrator/agents/code-review.{js,md}` созданы; `agents/index.js` импортирует и регистрирует; `getAgentTypes()` length = 10.
- **Оценка объёма:** M (≤ 1 день; ~200 строк .md + ~30 строк .js + 1 правка index.js)

#### ☐ F-3: Stack detection (манифесты → стек)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Воркер в STEP 1 промпта читает манифесты (`package.json` → typescript, `pyproject.toml` → python, `Cargo.toml` → rust, `build.gradle.kts`/`pom.xml` → kotlin) и/или распределение файлов по расширениям (`.ts/.js`, `.py`, `.rs`, `.kt/.java`), выбирает один из 4 стеков. При множественных манифестах — приоритет по убыванию: typescript > python > rust > kotlin. При отсутствии — fallback на `unknown` (только common.md).
- **Пользовательская история:** «Как reviewer, я хочу автоматически определять стек проекта по манифестам, чтобы загрузить релевантный stack-specific файл правил».
- **Зависимости:** F-1 (правила ссылаются на Stack Detection Hints), F-2 (STEP 1 в промпте)
- **TDD-тесты:**
  - [ ] **TC-F-3-1:** Stack detection по манифестам: каждый из 4 манифестов однозначно маппит в стек
    - *Условие:* виртуальная файловая система с mock-манифестами (используем `memfs` или временные файлы).
    - *Шаги:* arrange: создать 4 tmp-директории, каждая с одним манифестом (`package.json`, `pyproject.toml`, `Cargo.toml`, `build.gradle.kts`). act: для каждой вызвать `detectStack(dir)`. assert: `["typescript", "python", "rust", "kotlin"]`.
    - *Ожидаемый результат:* детекция корректна для 4/4 манифестов.
  - [ ] **TC-F-3-2:** Приоритет при множественных манифестах: typescript > python > rust > kotlin
    - *Условие:* tmp-директория с `package.json` + `pyproject.toml` одновременно.
    - *Шаги:* arrange: tmp-директория с обоими манифестами. act: `detectStack(dir)`. assert: `expect(stack).toBe("typescript")` (первый в приоритете).
    - *Ожидаемый результат:* при конфликте манифестов побеждает typescript.
  - [ ] **TC-F-3-3:** Edge case — ни одного известного манифеста → `stack="unknown"`, воркер переходит на common-only правила без падения
    - *Условие:* tmp-директория без `package.json`/`pyproject.toml`/`Cargo.toml`/`build.gradle.kts`/`pom.xml` — только файлы `.txt` или пусто.
    - *Шаги:* arrange: tmp-директория без известных манифестов. act: `detectStack(dir)` + `loadRules(dir, stack, rulesDir)`. assert: `expect(stack).toBe("unknown")`; loader возвращает только `common.md` (без stack-файла) + warning в логе `"no known manifest detected"`; воркер НЕ падает, продолжает ревью с common-only правилами.
    - *Ожидаемый результат:* детекция gracefully падает в `unknown`; ревью работает на common-only без stack-специфичных правил.
- **Red-тест:** TC-F-3-1 (падает первым, т.к. STEP 1 промпта ещё не написан; mock фикстуры есть, но детектора нет).
- **Refactor-цели:** Вынести приоритет манифестов в массив `STACK_DETECTION_ORDER = ["typescript", "python", "rust", "kotlin"]` (single source of truth); добавить unit-тест на fallback `unknown` если ни один манифест не найден.
- **Критерии приёмки:**
  1. STEP 1 в `agents/code-review.md` содержит инструкции по чтению всех 4 манифестов и приоритизации.
  2. Детекция работает для всех 4 стеков (TC-F-3-1) + приоритет при конфликте (TC-F-3-2).
  3. При отсутствии манифестов воркер не падает, а переходит к common-only review с пометкой в Review Scope.
- **Ожидаемый результат:** раздел STEP 1 в `agents/code-review.md` описывает детекцию; unit-тесты в `test/agents-code-review-definition.test.mjs` зелёные.
- **Оценка объёма:** S (≤ 4ч; ~30 строк в промпте + 2 unit-теста)

#### ☐ F-10: Verdict parser extension (6 значений + severity-маппинг)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Расширить `parseVerdict` в `agents.js` regex до 6 значений: `PASS|FAIL|PARTIAL|APPROVED|CHANGES_REQUESTED|NEEDS_DISCUSSION` (case-insensitive, `\s*` вокруг). Маппинг severity→verdict: CRITICAL/MAJOR → CHANGES_REQUESTED; только MINOR/INFO → APPROVED; неоднозначность → NEEDS_DISCUSSION. Обновить `agents.d.ts` (перегенерация `tsc`).
- **Пользовательская история:** «Как координатор, я хочу парсить 6 разных вердиктов (включая 3 новых для code-review), чтобы корректно интерпретировать результат code-review и verify воркеров».
- **Зависимости:** F-2 (агент существует, выдаёт вердикт)
- **TDD-тесты:**
  - [ ] **TC-F-10-1:** `parseVerdict` распознаёт 6 значений + `severityToVerdict` реализует маппинг (объединены 2 теста: parse + mapping)
    - *Условие:* vitest импортирует `parseVerdict` + `severityToVerdict` из `agents.js`.
    - *Шаги:* arrange: 8 кейсов для `parseVerdict` — `"VERDICT: PASS\n"`, `"VERDICT: FAIL\n"`, `"VERDICT: PARTIAL\n"`, `"VERDICT: APPROVED\n"`, `"VERDICT: CHANGES_REQUESTED\n"`, `"VERDICT: NEEDS_DISCUSSION\n"`, `"verdict: approved\n"` (case-insensitive), `null`; + 4 кейса для `severityToVerdict` — `[CRITICAL]`, `[MAJOR, MINOR]`, `[MINOR, INFO]`, `[MAJOR]` с пометкой «unclear» в metadata. act: вызвать обе функции. assert: `parseVerdict` → `[PASS, FAIL, PARTIAL, APPROVED, CHANGES_REQUESTED, NEEDS_DISCUSSION, APPROVED, null]`; `severityToVerdict` → `[CHANGES_REQUESTED, CHANGES_REQUESTED, APPROVED, NEEDS_DISCUSSION]`.
    - *Ожидаемый результат:* 6 значений парсятся (case-insensitive); severity-маппинг соответствует решению D4 спеки.
  - [ ] **TC-F-10-2:** `agents.d.ts` после регенерации содержит новый union тип `Verdict = "PASS" | "FAIL" | "PARTIAL" | "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_DISCUSSION"`
    - *Условие:* `npm run build` запущен в `extensions/fan-orchestrator/`.
    - *Шаги:* arrange: `fs.readFileSync("agents.d.ts", "utf-8")`. act: regex `/Verdict.*=.*"PASS".*"FAIL".*"PARTIAL".*"APPROVED".*"CHANGES_REQUESTED".*"NEEDS_DISCUSSION"/s`. assert: `expect(matched).toBeTruthy()`.
    - *Ожидаемый результат:* тип Verdict в .d.ts содержит 6 значений (не рассинхрон с .js).
  - [ ] **TC-F-10-3:** Error case — отсутствующая или невалидная строка VERDICT → `parseVerdict` возвращает `null` + диагностическое сообщение
    - *Условие:* vitest импортирует `parseVerdict` из `agents.js`; собраны невалидные входы.
    - *Шаги:* arrange: 4 невалидных кейса — `""` (пустая строка), `"VERDICT:"` (без значения), `"VERDICT: UNKNOWN_VALUE\n"` (значение не из enum), `"Some random text without verdict line\n"`. act: `parseVerdict(input)` для каждого. assert: все 4 возвращают `null`; в логе или возвращённом объекте (если `{value, diagnostic}`) присутствует diagnostic с указанием причины (`"no VERDICT line"` / `"unknown verdict value: UNKNOWN_VALUE"` / `"valid values: PASS|FAIL|..."`); никаких unhandled exceptions.
    - *Ожидаемый результат:* невалидный/отсутствующий VERDICT безопасно обрабатывается: `null` + diagnostic, координатор может fallback на `NEEDS_DISCUSSION` (см. D4 спеки).
- **Red-тест:** TC-F-10-1 (падает первым: текущий regex `/VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i` не матчит `APPROVED|CHANGES_REQUESTED|NEEDS_DISCUSSION` → возвращает `null`).
- **Refactor-цели:** Извлечь `VERDICT_VALUES` в константу (используется в regex, в severity-маппере, в .d.ts); добавить helper `isCodeReviewVerdict(v)` для разграничения с verify-вердиктами в buildCoordinatorPrompt.
- **Критерии приёмки:**
  1. `parseVerdict` распознаёт 6 значений (PASS/FAIL/PARTIAL/APPROVED/CHANGES_REQUESTED/NEEDS_DISCUSSION), case-insensitive, устойчив к whitespace.
  2. `severityToVerdict(findings)` реализует маппинг CRITICAL/MAJOR → CHANGES_REQUESTED, MINOR/INFO-only → APPROVED, mixed → NEEDS_DISCUSSION.
  3. `agents.d.ts` перегенерирован и содержит обновлённый `Verdict` тип (без рассинхрона с `agents.js`).
- **Ожидаемый результат:** `agents.js:parseVerdict` + `agents.js:severityToVerdict` экспортируются; `agents.d.ts` обновлён; `npm run build` orchestrator-extension зелёный.
- **Оценка объёма:** S (≤ 4ч; ~10 строк .js + регенерация .d.ts + 3 unit-теста)

---

## Этап 3: Conventions & Findings schemas (data contracts)

**Цель:** Определить форматы данных, которые воркер пишет/читает: `conventions.md` (auto-профиль) и finding (единичный результат ревью).
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* воркер запущен на пустой директории `.fan/code-review/`.
- *Шаги:* воркер генерирует `.fan/code-review/conventions.md` с frontmatter (`stack`, `last_analyzed`, `analyzed_files`) и 3 секциями (Style/Architecture/Patterns); воркер выдаёт finding в формате `Severity | File:Line | Category | Problem | Suggestion`.
- *Ожидаемый результат:* `conventions.md` валиден по frontmatter-схеме; finding парсится в структуру `{severity, file, line, category, problem, suggestion}`.
**Smoke-критерий этапа:** vitest-тест парсинга finding + conventions frontmatter — оба зелёные.

#### ☐ F-5: Conventions.md schema (frontmatter + секции)
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Определить формат файла `.fan/code-review/conventions.md` (project-local) и `.fan/code-review/conventions.<name>.md` (для внешних репо). Frontmatter (YAML): обязательные `stack` (string, один из 4), `last_analyzed` (ISO 8601), `analyzed_files` (non-empty array строк). Тело: 3 секции (`## Style`, `## Architecture`, `## Patterns`) с markdown-списками. Парсер `parseConventions(path)` → `{stack, lastAnalyzed, analyzedFiles, sections: {style, architecture, patterns}}`. Валидация: frontmatter полный → OK; иначе → генерировать заново.
- **Пользовательская история:** «Как пользователь, я хочу, чтобы conventions.md имел стабильный формат, который парсер воркера понимает однозначно — даже после моих ручных правок».
- **Зависимости:** (none — но F-6 [BIZ] lifecycle использует эту схему)
- **TDD-тесты:**
  - [ ] **TC-F-5-1:** `parseConventions` корректно читает frontmatter с 3 обязательными полями
    - *Условие:* tmp-файл с валидным YAML-frontmatter + 3 секциями.
    - *Шаги:* arrange: написать tmp `conventions.md` с frontmatter `stack: typescript / last_analyzed: 2026-09-03T12:00:00Z / analyzed_files: ["src/index.ts", "src/cli/init.ts"]` + секции Style/Architecture/Patterns. act: `parseConventions(path)`. assert: `result.stack === "typescript"`, `result.lastAnalyzed instanceof Date`, `result.analyzedFiles.length === 2`, `result.sections.style` непуста.
    - *Ожидаемый результат:* все 3 обязательных поля прочитаны; секции доступны как `sections[key]`.
  - [ ] **TC-F-5-2:** `parseConventions` бросает ошибку при отсутствии обязательного поля frontmatter
    - *Условие:* tmp-файл без `analyzed_files`.
    - *Шаги:* arrange: написать tmp `conventions.md` с frontmatter без `analyzed_files`. act: `parseConventions(path)`. assert: `expect(() => parseConventions(path)).toThrow(/analyzed_files/)`.
    - *Ожидаемый результат:* ошибка содержит имя отсутствующего поля.
  - [ ] **TC-F-5-3:** Парсер устойчив к ручным секциям: если пользователь добавил `## Custom Notes`, парсер возвращает его в `result.customSections`
    - *Условие:* tmp-файл с дополнительной секцией `## Custom Notes`.
    - *Шаги:* arrange: написать tmp `conventions.md` с дополнительной секцией. act: `parseConventions(path)`. assert: `result.customSections["Custom Notes"]` содержит текст секции.
    - *Ожидаемый результат:* парсер не теряет пользовательские секции — они доступны для merge (F-6).
- **Red-тест:** TC-F-5-1 (падает первым: файл `conventions.md` не существует → `parseConventions` не написан → тест на arrange/setup падает).
- **Refactor-цели:** Использовать `gray-matter` или `@maverick-js/gray-matter` (если уже в зависимостях orchestrator) вместо regex-парсинга YAML-frontmatter; вынести Zod-схему frontmatter в shared `conventions-schema.ts`.
- **Критерии приёмки:**
  1. `parseConventions(path)` возвращает `{stack, lastAnalyzed, analyzedFiles, sections, customSections}` для валидного файла.
  2. Отсутствие любого обязательного поля frontmatter → throw с понятным сообщением.
  3. Пользовательские секции (`## ...`) сохраняются в `customSections` (для merge в F-6).
- **Ожидаемый результат:** `conventions.js` (или `conventions.ts`) экспортирует `parseConventions(path)` + `validateConventions(parsed)` + Zod-схему; 3 unit-теста зелёные.
- **Оценка объёма:** S (≤ 4ч; ~30 строк парсера + 3 unit-теста + 1 schema-файл)

#### ☐ F-9: Finding structure schema (Severity/File:Line/Category/Problem/Suggestion)
- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Определить формат единичного finding в выводе воркера: 5 полей (Severity, File:Line, Category, Problem, Suggestion). Парсер `parseFinding(line)` → `{severity: "CRITICAL"|"MAJOR"|"MINOR"|"INFO", file: string, line: number, category?: string, problem: string, suggestion: string}`. Валидация: File:Line формат `path:line` (regex `/^.+:\d+$/`); severity — enum из 4; проблема/сапоген непустые. Findings аггрегируются в `Finding[]` (массив).
- **Пользовательская история:** «Как координатор/пользователь, я хочу парсить findings воркера в структурированный массив, чтобы группировать по severity и генерировать Summary Table».
- **Зависимости:** F-2 (агент существует), F-10 (severity enum определён)
- **TDD-тесты:**
  - [ ] **TC-F-9-1:** `parseFinding` корректно парсит строку формата `Severity | File:Line | Category | Problem | Suggestion`
    - *Условие:* строка в формате вывода воркера.
    - *Шаги:* arrange: `"- Severity: CRITICAL | File:Line: src/auth.ts:42 | Category: validation | Problem: missing input check | Suggestion: add null guard"`. act: `parseFinding(line)`. assert: `{severity: "CRITICAL", file: "src/auth.ts", line: 42, category: "validation", problem: "missing input check", suggestion: "add null guard"}`.
    - *Ожидаемый результат:* все 5 полей распарсены.
  - [ ] **TC-F-9-2:** `parseFinding` бросает ошибку на невалидный severity (например, `HIGH`)
    - *Условие:* строка с невалидным severity.
    - *Шаги:* arrange: `"- Severity: HIGH | File:Line: src/x.ts:1 | Category: x | Problem: x | Suggestion: x"`. act: `parseFinding(line)`. assert: `expect(() => parseFinding(line)).toThrow(/severity/)`.
    - *Ожидаемый результат:* ошибка указывает на невалидный severity + список допустимых значений.
  - [ ] **TC-F-9-3:** `parseFindings` агрегирует массив: парсит многострочный вывод воркера в `Finding[]`
    - *Условие:* многострочный markdown-вывод воркера.
    - *Шаги:* arrange: 3 строки findings (CRITICAL, MAJOR, MINOR). act: `parseFindings(output)`. assert: `result.length === 3`, `result[0].severity === "CRITICAL"`, `result[2].severity === "MINOR"`, `result.every(f => typeof f.line === "number")`.
    - *Ожидаемый результат:* массив из 3 findings с корректными severity и числовыми line.
- **Red-тест:** TC-F-9-1 (падает первым: `parseFinding` не написан → тест падает на act).
- **Refactor-цели:** Использовать единый regex `/^- Severity:\s*(?<sev>CRITICAL|MAJOR|MINOR|INFO)\s*\|\s*File:Line:\s*(?<file>[^:]+):(?<line>\d+)\s*\|(?:\s*Category:\s*(?<cat>[^|]+)\s*\|)?\s*Problem:\s*(?<prob>[^|]+)\s*\|\s*Suggestion:\s*(?<sug>.*)$/i`; вынести Severity enum в shared.
- **Критерии приёмки:**
  1. `parseFinding` возвращает `{severity, file, line, category?, problem, suggestion}` для валидной строки.
  2. Невалидный severity (не из 4 enum) → throw.
  3. `parseFindings(markdownOutput)` агрегирует массив, фильтрует пустые строки.
- **Ожидаемый результат:** `findings.js` экспортирует `parseFinding`, `parseFindings`, `Finding` type; 3 unit-теста зелёные.
- **Оценка объёма:** S (≤ 4ч; ~40 строк парсера + 3 unit-теста)

---

## Этап 4: Lifecycle, loading & injection (data flow)

**Цель:** Связать данные (conventions.md, rules/*.md) с воркером через pipeline: генерация conventions по триггерам, загрузка правил в порядке common→stack→conventions, инъекция `CODE_REVIEW_RULES_DIR` через `WorkerContext.constraints` во всех 3 режимах.
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* проект существует, `.fan/code-review/conventions.md` отсутствует, `extensions/fan-orchestrator/review-rules/` на месте.
- *Шаги:* (1) воркер запускается → conventions регенерируется (триггер «файл отсутствует»); (2) `delegate_task(agent="code-review")` в режимах chain/parallel/single → каждый вызов `mergeContext` обогащён constraint `CODE_REVIEW_RULES_DIR=<abs>`; (3) воркер загружает common.md + typescript.md + conventions.md в указанном порядке.
- *Ожидаемый результат:* `delegate_task("code-review", ...)` во всех 3 режимах несёт CODE_REVIEW_RULES_DIR; conventions.md создан и валиден; воркер получил 3 файла правил в STEP 2.
**Smoke-критерий этапа:** vitest `enrichWorkerContext` test PASS (проверяет, что constraint добавлен при agent === "code-review" и НЕ добавлен для других).

#### ☐ F-6: Conventions auto-profile lifecycle (генерация + регенерация)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Воркер в STEP 3 промпта проверяет 3 триггера регенерации `.fan/code-review/conventions.md`: (1) файл отсутствует → сгенерировать; (2) `last_analyzed` > 30 дней назад → регенерировать; (3) `analyzed_files` изменились (хэш-список/список) → регенерировать. При регенерации: прочитать старый файл, извлечь `customSections`, сгенерировать новые Style/Architecture/Patterns, смерджить обратно customSections, записать через bash-heredoc. Формат heredoc: `cat > .fan/code-review/conventions.md << 'EOF'\n<new content>\nEOF`.
- **Пользовательская история:** «Как пользователь, я хочу, чтобы conventions.md обновлялся при изменении кода (>30 дней), но мои ручные секции (`## Custom Notes`) сохранялись при регенерации».
- **Зависимости:** F-2 (STEP 3 в промпте), F-5 (схема conventions.md для парсинга)
- **TDD-тесты:**
  - [ ] **TC-F-6-1:** Триггер «файл отсутствует ИЛИ >30 дней» → воркер (ре)генерирует conventions.md через bash-heredoc, customSections сохраняются
    - *Условие:* две tmp-директории: (a) `.fan/code-review/conventions.md` не существует; (b) conventions.md существует с `last_analyzed: 2026-07-01T00:00:00Z` и пользовательской секцией `## Custom Notes`.
    - *Шаги:* arrange: мок воркера с моком `bash` для каждой директории. act: вызвать `regenerateConventions(projectDir, stack="typescript")`. assert: (a) файл `.fan/code-review/conventions.md` создан, содержит frontmatter с `stack: typescript`, `last_analyzed` — текущая дата, `analyzed_files` непустой массив; (b) новый файл содержит обновлённый `last_analyzed` (текущая дата) + сохранённую секцию `## Custom Notes`.
    - *Ожидаемый результат:* оба триггера регенерируют conventions.md; пользовательские секции не теряются при регенерации.
  - [ ] **TC-F-6-2:** Триггер «analyzed_files изменились» → регенерация; bash-команда heredoc сужена до `.fan/code-review/conventions*.md`
    - *Условие:* tmp-директория с conventions.md (`analyzed_files: ["src/a.ts"]`), воркер видит `src/b.ts` (новый файл).
    - *Шаги:* arrange: создать conventions.md с одним файлом в `analyzed_files`; создать `src/b.ts`. act: вызвать `regenerateConventions`. assert: новый файл содержит `analyzed_files: ["src/a.ts", "src/b.ts"]`; единственная bash-команда в моке — `cat > .fan/code-review/conventions.md << 'EOF' ... EOF` (путь сужен).
    - *Ожидаемый результат:* регенерация по diff analyzed_files; bash write ограничен одним путём.
  - [ ] **TC-F-6-3:** Edge case — все 3 триггера ложны (файл существует + last_analyzed <30d + analyzed_files не изменились) → НЕ регенерировать, используется кэш
    - *Условие:* tmp-директория с conventions.md (`last_analyzed` = сегодня, `analyzed_files: ["src/a.ts"]`) и существующим `src/a.ts`.
    - *Шаги:* arrange: conventions.md актуален, файлы не изменились. act: вызвать `regenerateConventions(projectDir, stack="typescript")`. assert: файл НЕ перезаписан (содержимое байт-в-байт совпадает с входным); bash-мок НЕ получил команду `cat > .fan/code-review/conventions.md`; функция вернула `{regenerated: false, reason: "no triggers fired"}` или эквивалент.
    - *Ожидаемый результат:* cache-hit — регенерация пропускается, conventions.md используется как есть, воркер не делает лишних записей.
- **Red-тест:** TC-F-6-1 (падает первым: `regenerateConventions` не реализован → мок bash не получает команду → файл не создан → assert падает).
- **Refactor-цели:** Вынести тригеры в pure-функции `shouldRegenerate(parsed, currentFiles): {regen: bool, reason: string}` (легче юнит-тестить); добавить unit-тест на «все 3 триггера ложны → НЕ регенерировать, использовать кэш».
- **Критерии приёмки:**
  1. `regenerateConventions(projectDir, stack, analyzedFiles)` создаёт/обновляет conventions.md с валидным frontmatter.
  2. Триггеры работают: файл отсутствует / >30 дней / analyzed_files изменены → регенерация.
  3. Ручные секции (`## ...` не из Style/Architecture/Patterns) сохраняются при регенерации.
- **Ожидаемый результат:** STEP 3 в `agents/code-review.md` описывает триггеры и heredoc; unit-тесты зелёные.
- **Оценка объёма:** M (≤ 1 день; ~50 строк в промпте + bash-команда + 3 unit-теста)

#### ☐ F-4: Rules loading pipeline (common + stack + conventions)
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Воркер в STEP 2 промпта загружает правила в порядке: (1) `<RULES_DIR>/common.md`, (2) `<RULES_DIR>/<stack>.md`, (3) `.fan/code-review/conventions.md` (или `conventions.<name>.md` для внешних). Каждый файл читается через `read`, конкатенируется в блок `## Loaded Rules` в worker context. Если `<stack>.md` не существует (неизвестный стек) → воркер продолжает с common-only + warning в Review Scope. Если `common.md` отсутствует → error (минимальное требование).
- **Пользовательская история:** «Как reviewer-воркер, я хочу автоматически загружать правила для стека проекта, чтобы не дублировать их в промпте и не превышать контекст-бюджет».
- **Зависимости:** F-1 (правила существуют), F-2 (STEP 2 в промпте), F-3 (стек определён), F-5 (загружает conventions по схеме F-5), F-13 (RULES_DIR известен через constraint)
- **TDD-тесты:**
  - [ ] **TC-F-4-1:** Загрузка правил в правильном порядке для TypeScript-проекта: common.md → typescript.md → conventions.md
    - *Условие:* типизированный проект с `.fan/code-review/conventions.md`.
    - *Шаги:* arrange: tmp-директория с `review-rules/common.md` + `review-rules/typescript.md` + `.fan/code-review/conventions.md`. act: `loadRules(projectDir, stack="typescript", rulesDir)`. assert: результат — массив из 3 путей в указанном порядке; `result[0].endsWith("common.md")`, `result[1].endsWith("typescript.md")`, `result[2].endsWith("conventions.md")`.
    - *Ожидаемый результат:* порядок загрузки строго common → stack → conventions.
  - [ ] **TC-F-4-2:** Неизвестный стек → воркер загружает только common.md + warning в Review Scope
    - *Условие:* tmp-директория без манифестов (стек = `unknown`).
    - *Шаги:* arrange: tmp-директория без манифестов. act: `loadRules(projectDir, stack="unknown", rulesDir)`. assert: результат содержит только `common.md`; возвращён объект `{files: [...], warning: "Stack unknown, using common rules only"}`.
    - *Ожидаемый результат:* fallback на common-only с явным warning.
  - [ ] **TC-F-4-3:** Отсутствие common.md → error (не warning, т.к. common — минимальное требование)
    - *Условие:* rulesDir без common.md.
    - *Шаги:* arrange: rulesDir с только typescript.md. act: `loadRules(projectDir, "typescript", rulesDir)`. assert: `expect(() => loadRules(...)).toThrow(/common.md/)`.
    - *Ожидаемый результат:* без common.md ревью не запускается (явная ошибка).
- **Red-тест:** TC-F-4-1 (падает первым: `loadRules` не реализован → tmp-файлы не читаются в правильном порядке → assert на массив путей падает).
- **Refactor-цели:** Заменить ручное чтение файлов на `await Promise.all(files.map(readFile))` (параллелизация); кэшировать загруженные rules в worker context (не читать повторно между запросами).
- **Критерии приёмки:**
  1. `loadRules(projectDir, stack, rulesDir)` возвращает массив файлов в порядке common → stack → conventions.
  2. Неизвестный стек → fallback на common-only с warning.
  3. Отсутствие common.md → throw (минимальное требование для запуска ревью).
- **Ожидаемый результат:** STEP 2 в `agents/code-review.md` описывает loading order; `loadRules()` функция экспортируется и покрыта 3 unit-тестами.
- **Оценка объёма:** S (≤ 4ч; ~30 строк в промпте + 1 функция + 3 unit-теста)

#### ☐ F-13: RULES_DIR constraint injection через enrichWorkerContext
- **Приоритет:** P0
- **Слой:** [INTEG]
- **Описание:** Функция `enrichWorkerContext(agent, context)` в `orchestrator-tools.js` инжектит constraint `CODE_REVIEW_RULES_DIR=<abs>` в `context.constraints`, где `<abs> = path.join(__dirname, "review-rules")`. Вызывается во всех 3 точках `mergeContext` (chain:355, parallel:538, single:616). При agent !== "code-review" — контекст не меняется. Путь работает во всех режимах установки (dev / `~/.fan/agent/extensions/` / `execDir`), т.к. `__dirname` вычисляется относительно расположения `orchestrator-tools.js`.
- **Пользовательская история:** «Как reviewer-воркер, я хочу получать абсолютный путь к правилам через context.constraints, чтобы не зависеть от режима установки extension».
- **Зависимости:** F-2 (агент существует, тип известен)
- **TDD-тесты:**
  - [ ] **TC-F-13-1:** `enrichWorkerContext("code-review", ctx)` добавляет constraint `CODE_REVIEW_RULES_DIR=<abs>` в `ctx.constraints`
    - *Условие:* vitest импортирует `enrichWorkerContext` (или тестирует через `registerOrchestratorTools` с моком fan, как в `chain-render.test.mjs`).
    - *Шаги:* arrange: `const ctx = {constraints: []}`. act: `enrichWorkerContext("code-review", ctx)`. assert: `ctx.constraints.some(c => c.startsWith("CODE_REVIEW_RULES_DIR="))`; `ctx.constraints.find(c => c.startsWith("CODE_REVIEW_RULES_DIR=")).endsWith("review-rules")`; `path.isAbsolute(value)` = true.
    - *Ожидаемый результат:* constraint добавлен, значение — абсолютный путь заканчивающийся на `review-rules`.
  - [ ] **TC-F-13-2:** `enrichWorkerContext("verify", ctx)` НЕ добавляет constraint (другие агенты не получают RULES_DIR)
    - *Условие:* тот же setup.
    - *Шаги:* arrange: `const ctx = {constraints: []}`. act: `enrichWorkerContext("verify", ctx)`. assert: `ctx.constraints.length === 0` (или unchanged).
    - *Ожидаемый результат:* только агенты типа `code-review` получают инъекцию.
  - [ ] **TC-F-13-3:** `mergeContext` обогащён во всех 3 режимах: chain, parallel, single
    - *Условие:* unit-тест с моком mergeContext (паттерн `agents-security-routing.test.mjs`).
    - *Шаги:* arrange: для каждого режима создать мок `mergeContext` + spy. act: вызвать `registerOrchestratorTools` + найти 3 точки вызова mergeContext. assert: все 3 spy были вызваны с контекстом, содержащим `CODE_REVIEW_RULES_DIR`.
    - *Ожидаемый результат:* integration smoke — constraint доходит до воркера во всех 3 режимах установки/оркестрации.
- **Red-тест:** TC-F-13-1 (падает первым: `enrichWorkerContext` не экспортируется, constraint не инжектится → `ctx.constraints` остаётся пустым).
- **Refactor-цели:** Вынести `enrichWorkerContext` в shared `context-enricher.js` (если будет использоваться для других агентов в будущем); добавить no-op для не-code-review агентов, чтобы избежать лишней работы.
- **Критерии приёмки:**
  1. `enrichWorkerContext("code-review", ctx)` добавляет `CODE_REVIEW_RULES_DIR=<abs>` в `ctx.constraints` (где `<abs>` — абсолютный путь к `review-rules/`).
  2. Другие агенты не получают constraint (no-op).
  3. Все 3 точки `mergeContext` (chain/parallel/single) в `orchestrator-tools.js` обёрнуты вызовом `enrichWorkerContext`.
- **Ожидаемый результат:** `orchestrator-tools.js` экспортирует `enrichWorkerContext` (или встроен в `mergeContext` обёртку); 3 unit-теста + integration smoke зелёные.
- **Оценка объёма:** S (≤ 4ч; ~20 строк в `orchestrator-tools.js` + 3 unit-теста)

---

## Этап 5: Diff review workflow & Security handoff (core behavior)

**Цель:** Реализовать основной workflow ревью (git diff → findings → verdict) и security-handoff (маркировка + делегация).
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* проект с известным diff (`HEAD~1..HEAD`), `extensions/fan-orchestrator/review-rules/` на месте.
- *Шаги:* (1) воркер запускает `git diff HEAD~1..HEAD` через bash; (2) парсит diff пофайлово; (3) применяет common+stack+conventions правила; (4) обнаруживает потенциальный SQL-injection в `src/auth.ts:42`; (5) маркирует finding как `security-note` + добавляет блок `## Security Handoffs` со ссылкой; (6) рекомендует делегировать на security-воркер.
- *Ожидаемый результат:* вывод воркера содержит finding с severity, блок Security Handoffs (если есть security-issue), и `VERDICT: CHANGES_REQUESTED` (т.к. есть CRITICAL/MAJOR).
**Smoke-критерий этапа:** vitest-тест на integration `parseVerdict` + security-handoff блок — оба зелёные.

#### ☐ F-8: Diff-only review workflow (git diff → findings → verdict)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Воркер в STEP 0 промпта принимает один из 3 вариантов входа: (a) `gitUrl` — внешний репо (см. F-7, clone в `.fan/git/<slug>`); (b) `base` + cwd — `git diff <base>...HEAD` в текущей директории; (c) `path` — локальный путь к другому проекту (`cd <path>` + `git diff <base>...HEAD` без клонирования, конвенции берутся из `.fan/code-review/conventions.md` целевого проекта либо из общего). Парсит вывод пофайлово (`git diff -- <path>` для каждого изменённого файла), применяет правила (common + stack + conventions), генерирует findings в формате F-9, выводит: (1) Review Scope (что проверено), (2) Findings list, (3) Summary Table (распределение по severity), (4) Security Handoffs (если есть — см. F-11), (5) финальный `VERDICT: APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION`. Воркер НЕ запускает build/tests/lint (ответственность verify).
- **Пользовательская история:** «Как reviewer-воркер, я хочу получать diff проекта и выдавать структурированный отчёт с findings + verdict, чтобы координатор мог принять решение о merge».
- **Зависимости:** F-2 (агент существует), F-3 (стек определён), F-4 (правила загружены), F-6 (conventions.md lifecycle — review использует сгенерированный conventions.md), F-9 (формат findings), F-10 (verdict parser)
- **TDD-тесты:**
  - [ ] **TC-F-8-1:** Review на mock-проекте возвращает findings в формате Severity/File:Line/Category/Problem/Suggestion + VERDICT + Review Scope идёт первым
    - *Условие:* mock-проект с TypeScript-кодом, известным diff (3 файла в diff, 1 MAJOR finding: missing null-check).
    - *Шаги:* arrange: создать mock-проект с `package.json` + `src/{a,b,c}.ts` (3 файла в diff, в `src/auth.ts` — `user.id` без null-check). act: вызвать `runReview({projectDir, base: "HEAD~1"})` (мок воркера). assert: результат содержит секцию `## Review Scope` со списком 3 файлов ПЕРЕД секцией `## Findings`; содержит ≥ 1 finding с severity "MAJOR"; содержит строку `VERDICT: CHANGES_REQUESTED`; Summary Table содержит распределение по severity.
    - *Ожидаемый результат:* end-to-end review отрабатывает, структура вывода упорядочена (Scope → Findings → Summary → Handoffs → VERDICT), verdict соответствует severity (TC-F-10-1 маппинг).
  - [ ] **TC-F-8-2:** Edge case: пустой diff (нет изменений) → VERDICT: APPROVED + Review Scope с пометкой «no changes»
    - *Условие:* mock-проект без изменений между base и HEAD.
    - *Шаги:* arrange: mock-проект, `base = HEAD` (нет diff). act: `runReview()`. assert: вывод содержит `## Review Scope` с пометкой `no changes detected`; содержит `VERDICT: APPROVED`; findings пустой массив.
    - *Ожидаемый результат:* пустой diff обрабатывается gracefully, не падает.
  - [ ] **TC-F-8-3:** Edge case: локальный путь (`path="/home/user/other-project"`) → воркер работает в целевой директории + `git diff` без клонирования
    - *Условие:* внешний проект `/home/user/other-project` (TypeScript, 1 файл в diff) без сетевого доступа; локальные conventions — общий `.fan/code-review/conventions.md` (т.к. проект не external, конвенции не в `conventions.<name>.md`).
    - *Шаги:* arrange: создать tmp `/home/user/other-project` с `package.json` + 1 изменённым файлом; мок bash для отслеживания команд. act: `runReview({path: "/home/user/other-project", base: "HEAD~1"})`. assert: (a) **нет** вызова `git clone` (только `cd <path> && git diff <base>...HEAD` через bash); (b) воркер загружает `common.md` + `typescript.md` + общий `conventions.md` (НЕ `conventions.other-project.md`, т.к. путь — локальный, не external); (c) результат содержит findings + VERDICT по диффу в `/home/user/other-project`.
    - *Ожидаемый результат:* сценарий 4 спеки покрыт: локальный путь работает без клонирования; conventions берутся из общего файла, не из `conventions.<slug>.md` (это reserved для gitUrl).
- **Red-тест:** TC-F-8-1 (падает первым: `runReview` не существует → mock воркера не получает правила → вывод пустой → assert на findings и verdict падает).
- **Refactor-цели:** Вынести `runReview` в отдельный модуль `review-runner.js` (чистая функция от (projectDir, base) → ReviewResult); параметризовать `formatSummaryTable(findings)` для кастомного вывода; добавить метрики (время, количество файлов).
- **Критерии приёмки:**
  1. Воркер запускает `git diff <base>...HEAD`, парсит вывод пофайлово.
  2. Вывод содержит 5 секций в порядке: Review Scope → Findings → Summary Table → Security Handoffs (если есть) → VERDICT.
  3. Edge case пустого diff обрабатывается без падения (VERDICT: APPROVED + пометка «no changes»).
- **Ожидаемый результат:** `agents/code-review.md` STEP 0 + MANDATORY OUTPUT FORMAT описывают workflow; mock-тесты в `test/agents-code-review-integration.test.mjs` зелёные.
- **Оценка объёма:** M (≤ 1 день; ~80 строк в промпте + 1 runner + 3 теста)

#### ☐ F-11: Security-handoff tagging (security-note + delegate)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Воркер НЕ проводит глубокий security-аудит (D7 спеки). При обнаружении потенциальной security-проблемы в finding (маркеры: SQL injection, XSS, hardcoded secret, weak crypto, path traversal, insecure deserialization, missing auth, IDOR, etc.) воркер: (1) помечает finding тегом `security-note` (дополнительное поле в finding), (2) добавляет секцию `## Security Handoffs` со списком file:line + краткое описание проблемы, (3) рекомендует делегировать полный аудит на security-воркер через координатор (не вызывает security сам).
- **Пользовательская история:** «Как reviewer-воркер, я хочу маркировать подозрительные security-проблемы для последующей передачи security-воркеру, чтобы не дублировать OWASP-аудит».
- **Зависимости:** F-2 (агент), F-8 (review workflow генерирует findings), F-9 (finding schema)
- **TDD-тесты:**
  - [ ] **TC-F-11-1:** Finding с security-issue помечен `security-note: true` + попадает в `## Security Handoffs`
    - *Условие:* mock-проект с SQL-injection в коде.
    - *Шаги:* arrange: mock-проект с `src/auth.ts` содержащим `db.query("SELECT * FROM users WHERE id = " + userId)`. act: `runReview()`. assert: ≥ 1 finding имеет `securityNote: true`; вывод содержит секцию `## Security Handoffs` с упоминанием `src/auth.ts` + номера строки.
    - *Ожидаемый результат:* security-issue корректно промаркировано и собрано в Handoffs.
  - [ ] **TC-F-11-2:** Делегация рекомендована через явную инструкцию в Handoffs (НЕ через auto-call security-воркера)
    - *Условие:* mock-проект с security-issue.
    - *Шаги:* arrange: тот же setup. act: `runReview()`. assert: вывод содержит фразу `Recommend delegating to security worker` или эквивалент; НЕ содержит вызов `delegate_task` от code-review (code-review не вызывает других воркеров напрямую).
    - *Ожидаемый результат:* security-handoff — рекомендация, а не auto-call (сохраняет изоляцию воркера).
  - [ ] **TC-F-11-3:** Findings без security-issue НЕ попадают в `## Security Handoffs`
    - *Условие:* mock-проект только с non-security findings (naming, dead code, magic numbers).
    - *Шаги:* arrange: mock-проект с не-security code smells. act: `runReview()`. assert: секция `## Security Handoffs` отсутствует ИЛИ пуста (`## Security Handoffs\n\n_No security issues detected._`).
    - *Ожидаемый результат:* security-handoff блок появляется только при наличии security-issue.
- **Red-тест:** TC-F-11-1 (падает первым: в STEP 3 промпта нет security-маркеров → finding не получает `securityNote: true` → блок Security Handoffs пуст).
- **Refactor-цели:** Вынести список security-маркеров (SQL injection, XSS, hardcoded secret, weak crypto, path traversal, insecure deserialization, missing auth, IDOR) в `SECURITY_PATTERNS` константу; добавить unit-тест на каждый паттерн (мини-фикстуры: `db.query("..." + input)`, `innerHTML = ...`, `crypto.createHash("md5")`, etc.).
- **Критерии приёмки:**
  1. Findings с security-issue (SQL injection, XSS, hardcoded secret, etc.) помечены `securityNote: true` + собраны в блок `## Security Handoffs`.
  2. Блок Handoffs содержит явную рекомендацию «Recommend delegating to security worker».
  3. Non-security findings не попадают в Handoffs (блок пуст/отсутствует).
- **Ожидаемый результат:** STEP 3 + MANDATORY OUTPUT FORMAT в `agents/code-review.md` описывают security-handoff; 3 unit-теста зелёные.
- **Оценка объёма:** S (≤ 4ч; ~20 строк в промпте + 8 security-паттернов + 3 unit-теста)

---

## Этап 6: Routing & Profile config (orchestration)

**Цель:** Встроить воркер в систему маршрутизации (classify_task правило №2 после security + сужение verify-regex) и профиль безопасности (read-only + temperature 0.2 + timeout 900s).
**Приоритет функций:** P0
**E2E-сценарий этапа:**
- *Условие:* orchestrator собран, все этапы 1-5 завершены.
- *Шаги:* (1) `classify_task("проведи code review последних изменений")` → `Worker type: code-review`; (2) `classify_task("verify the build before merge")` → `Worker type: verify` (verify-regex сужен, не ловит голое «review»); (3) `classify_task("check for SQL injection in auth")` → `Worker type: security` (security остался №1); (4) `PROFILES_BY_AGENT["code-review"] === "read-only"` (контракт в broker-handler.js).
- *Ожидаемый результат:* routing корректно направляет 3 типа задач; profile code-review = "read-only" (не дефолтный "all").
**Smoke-критерий этапа:** `npx vitest run test/agents-code-review-routing.test.mjs test/agents-code-review-integration.test.mjs test/agents-consistency.test.mjs` — все зелёные.

#### ☐ F-12: Routing classification (classify_task правило №2 + сужение verify)
- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** В `orchestrator-tools.js:classifyTaskByDescription` добавить правило №2 (после security): regex `CODE_REVIEW_KEYWORDS = /\b(code\s*review|review\s+(this|the)\s+(pr|diff|changes|commit|branch)|pr\s*review|lgtm|ревью|код[\s-]ревью)\b/i`. Сузить verify-regex: убрать `\breview\b|\bsecurity\b` (эти домены теперь у code-review и security). Порядок: security (№1) → code-review (№2) → explore (→) → plan (→) → verify (default fallback). Осознанная миграция теста `agents-security-routing.test.mjs:201-205`: эталон `"review this PR"` → verify мигрирует на code-review.
- **Пользовательская история:** «Как координатор, я хочу автоматически направлять фразы «code review», «review this PR», «ревью» на воркер code-review, чтобы пользователь получал семантический анализ вместо механического verify».
- **Зависимости:** F-2 (агент зарегистрирован, `classifyTaskByDescription` знает типы)
- **TDD-тесты:**
  - [ ] **TC-F-12-1:** 8 positive phrases роутятся на code-review
    - *Условие:* vitest через `classify_task` (паттерн `agents-security-routing.test.mjs`).
    - *Шаги:* arrange: 8 фраз — `"code review of the auth module"`, `"review this PR"`, `"review the diff"`, `"review the changes"`, `"commit review for last commit"`, `"branch review before merge"`, `"LGTM check"`, `"ревью диффа"`. act: `classifyWorkerType(phrase)`. assert: все 8 → `"code-review"`.
    - *Ожидаемый результат:* positive routing зелёный для всех 8 фраз.
  - [ ] **TC-F-12-2:** 5 negative guards НЕ роутятся на code-review (каждая → свой домен)
    - *Условие:* тот же setup.
    - *Шаги:* arrange: 5 фраз — `"verify the build"` → `verify`; `"check for vulnerabilities"` → `security`; `"review the new feature design"` → `verify` (дизайн-ревью не code-review); `"run tests"` → `verify`; `""` → `implement` (default). act: `classifyWorkerType(phrase)`. assert: каждая → свой домен, ни одна → `"code-review"`.
    - *Ожидаемый результат:* negative guards защищают от перехвата чужих доменов.
  - [ ] **TC-F-12-3:** Regression guard — миграция теста `agents-security-routing.test.mjs:201-205`
    - *Условие:* vitest на `test/agents-security-routing.test.mjs`.
    - *Шаги:* arrange: прочитать REFERENCE_PHRASES в существующем тесте (строка `phrase: "review this PR"`, `expected: "verify"`). act: правка expected на `"code-review"`. assert: тест зелёный после миграции.
    - *Ожидаемый результат:* регрессионный тест зафиксировал миграцию, новые тесты не сломали старые.
- **Red-тест:** TC-F-12-1 (падает первым: `CODE_REVIEW_KEYWORDS` regex ещё не добавлен → все 8 positive фраз уходят в verify/implement).
- **Refactor-цели:** Вынести regex в константу `CODE_REVIEW_KEYWORDS` (single source of truth); добавить негативные `CODE_REVIEW_NEGATIVE_GUARDS` для edge-cases (дизайн-ревью → verify); добавить unit-тест на case-insensitive (`"LGTM"` = `"lgtm"`).
- **Критерии приёмки:**
  1. `classifyTaskByDescription` имеет правило №2 для code-review с regex `CODE_REVIEW_KEYWORDS`.
  2. 8 positive phrases → code-review; 5 negative guards → другие домены (verify/security/implement).
  3. Verify-regex сужен (без голого `\breview\b`); security правило осталось №1; регрессионный тест `agents-security-routing.test.mjs:201` мигрирован (`"review this PR"` → code-review) и зелёный.
- **Ожидаемый результат:** `orchestrator-tools.js:classifyTaskByDescription` экспортирует обновлённый классификатор; `test/agents-code-review-routing.test.mjs` создан; существующий `agents-security-routing.test.mjs` обновлён.
- **Оценка объёма:** M (≤ 1 день; ~30 строк regex + classify logic + 2 новых тест-файла + 1 правка)

#### ☐ F-14: Agent profile config (read-only + 0.2/900s + DEPLOY)
- **Приоритет:** P0
- **Слой:** [CLI]
- **Описание:** В `broker-handler.js:PROFILES_BY_AGENT` добавить `"code-review": "read-only"` (КРИТИЧНО — иначе default `"all"` → write-MCP). Заодно добить `"security": "read-only"` (отсутствие в текущей карте = permissions-дырка). В `config.js:DEFAULTS` добавить `agentTemperature.code-review = 0.2` и `agentTimeouts.code-review = 900`. В `config.example.json` добавить `cloud.models.code-review = ""` и `local.models.code-review = ""` (× 2 секции). В `orchestrator-extension.js`: `agentIcons["code-review"] = "🔎"` в 2 местах (500-504 и 1218), `WORKER_PROFILES["code-review"] = {reasoning: 1, context: 6, cost: 3, maxTokens: 0.3}`, `ASSIGNMENT_ORDER += ["code-review"]`. В `DEPLOY.toml` добавить `include = [..., "review-rules/*.md", "review-adapters.d.ts", "review-adapters.md"]`.
- **Пользовательская история:** «Как пользователь, я хочу, чтобы code-review воркер запускался в read-only слоте с temperature 0.2 (стабильный verdict) и timeout 900s (clone + большой diff), чтобы он не конкурировал с write-агентами и не падал по таймауту».
- **Зависимости:** F-2 (агент существует, тип известен)
- **TDD-тесты:**
  - [ ] **TC-F-14-1:** `PROFILES_BY_AGENT["code-review"] === "read-only"` (контракт)
    - *Условие:* vitest импортирует `PROFILES_BY_AGENT` из `broker-handler.js`.
    - *Шаги:* arrange: `import { PROFILES_BY_AGENT } from "../broker-handler.js"`. act: `PROFILES_BY_AGENT["code-review"]`. assert: `expect(profile).toBe("read-only")`; заодно `PROFILES_BY_AGENT["security"] === "read-only"` (regression guard для дырки).
    - *Ожидаемый результат:* оба профиля = "read-only" (никаких дефолтных "all").
  - [ ] **TC-F-14-2:** `DEFAULTS.agentTemperature.code-review === 0.2` + `DEFAULTS.agentTimeouts.code-review === 900`
    - *Условие:* vitest импортирует `DEFAULTS` из `config.js`.
    - *Шаги:* arrange: `import { DEFAULTS } from "../config.js"`. act: `DEFAULTS.agentTemperature["code-review"]` + `DEFAULTS.agentTimeouts["code-review"]`. assert: `0.2` + `900`.
    - *Ожидаемый результат:* конфигурация соответствует спеке §4.1 (стабильность + clone budget).
  - [ ] **TC-F-14-3:** Контрактная валидация исходников: `orchestrator-extension.js` (agentIcons ×2 + WORKER_PROFILES + ASSIGNMENT_ORDER) + `DEPLOY.toml` (review-rules/ + adapters). Error case — контракт нарушен → тест ловит рассинхрон (объединены TC-F-14-3 и TC-F-14-4).
    - *Условие:* vitest читает `orchestrator-extension.js` + `DEPLOY.toml` как текст (контракт исходников, паттерн `agents-security-routing.test.mjs`).
    - *Шаги:* arrange: `fs.readFileSync("orchestrator-extension.js")` + `fs.readFileSync("DEPLOY.toml")`. act: (1) regex `/agentIcons\s*\[?\s*["']code-review["']\s*\]?\s*=\s*["']🔎["']/g` (≥ 2 совпадения для дубля ~:500 и ~:1218) + `/WORKER_PROFILES\s*\[?\s*["']code-review["']\s*\]?\s*=/` + `/ASSIGNMENT_ORDER.*code-review/`; (2) regex для каждого из 3 паттернов в `include` секции DEPLOY.toml. assert: все regex совпадают; error-case демонстрирует, что при удалении/правке любой из 4 строк (icons×2, WORKER_PROFILES, ASSIGNMENT_ORDER, DEPLOY.toml-include) тест падает с конкретным diagnostic message (например, `"agentIcons[code-review] missing in line ~500"`, `"DEPLOY.toml missing review-rules/*.md"`).
    - *Ожидаемый результат:* контракт исходников полностью покрыт (icons ×2 + profile + order + DEPLOY includes); тест ловит любую регрессию до попадания в сборку.
- **Red-тест:** TC-F-14-1 (падает первым: `PROFILES_BY_AGENT` не содержит `"code-review"` → `undefined !== "read-only"`).
- **Refactor-цели:** Извлечь defaults в `agent-defaults.js` для переиспользования (security тоже там); унифицировать дубли `agentIcons` в один объект (если возможно без breaking change).
- **Критерии приёмки:**
  1. `PROFILES_BY_AGENT["code-review"] === "read-only"` + `PROFILES_BY_AGENT["security"] === "read-only"` (regression fix).
  2. `DEFAULTS.agentTemperature.code-review === 0.2` + `DEFAULTS.agentTimeouts.code-review === 900` + `config.example.json` содержит `cloud.models.code-review = ""` × 2 секции.
  3. `agentIcons["code-review"] === "🔎"` в 2 местах; `WORKER_PROFILES["code-review"]` существует; `ASSIGNMENT_ORDER.includes("code-review")`; `DEPLOY.toml` включает `review-rules/*.md`, `review-adapters.d.ts`, `review-adapters.md` (контрактная валидация, см. TC-F-14-3).
- **Ожидаемый результат:** 4 файла правок (`broker-handler.js`, `config.js`, `config.example.json`, `orchestrator-extension.js`) + `DEPLOY.toml`; 4 unit-теста зелёные.
- **Оценка объёма:** M (≤ 1 день; ~120 строк правок в 5 файлах + 4 unit-теста)

---

## Этап 7: External repos & Platform contract (extensibility)

**Цель:** Поддержать ревью внешних репо (по git URL) и определить contract для платформенных адаптеров (GitHub/Bitbucket) — реализации в следующих фазах.
**Приоритет функций:** P1
**E2E-сценарий этапа:**
- *Условие:* orchestrator собран, этапы 1-6 завершены, доступен `git` в PATH.
- *Шаги:* (1) воркер получает задачу с `gitUrl="https://github.com/owner/repo"` + `base="main"`; (2) `git clone --depth 200 https://... .fan/git/repo`; (3) `git fetch --prune && git checkout main`; (4) `git diff main...HEAD`; (5) конвенции внешнего → `.fan/code-review/conventions.repo.md`; (6) ревью + вердикт; (7) TypeScript-компилятор успешно компилирует `review-adapters.d.ts` без ошибок.
- *Ожидаемый результат:* внешний репо склонирован в кэш `.fan/git/<name>`, conventions.<name>.md создан, воркер выдал findings+verdict; платформенный contract импортируется без рантайма.
**Smoke-критерий этапа:** vitest `cloneExternalRepo` (с моком `git` через bash mock) + `review-adapters.d.ts` compile — оба зелёные.

#### ☐ F-7: External repo clone-cache (`.fan/git/<name>`, --depth 200)
- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** Воркер в STEP 0 промпта принимает git URL (`https://github.com/owner/repo` или `git@...`). Алгоритм: (1) вычислить slug из URL (`owner-repo`); (2) `mkdir -p .fan/git`; (3) если `.fan/git/<slug>` не существует → `git clone --depth 200 <url> .fan/git/<slug>` через bash; (4) если существует → `cd .fan/git/<slug> && git fetch --prune && git checkout <base>` (cache hit); (5) `base` — обязательный аргумент (commit/branch/tag); (6) `git diff <base>...HEAD` через bash; (7) конвенции внешнего → `.fan/code-review/conventions.<slug>.md` (отдельно от project-local); (8) при ошибке `fatal: bad revision` (base не в shallow-копии) → инструкция `git fetch --unshallow`; при невозможности → `VERDICT: NEEDS_DISCUSSION`.
- **Пользовательская история:** «Как пользователь, я хочу проводить code review внешнего GitHub-репо по URL с автоматическим кэшированием клона, чтобы повторные ревью были быстрее».
- **Зависимости:** F-2 (STEP 0 в промпте), F-5 (conventions.<name>.md использует ту же схему)
- **TDD-тесты:**
  - [ ] **TC-F-7-1:** Первый запуск — clone external repo в `.fan/git/<slug>` с `--depth 200`
    - *Условие:* mock `git` через bash (spy на `bash.execute`).
    - *Шаги:* arrange: `cloneExternalRepo({url: "https://github.com/owner/repo"})` с моком bash. act: вызвать функцию. assert: bash получил команду `git clone --depth 200 https://github.com/owner/repo .fan/git/owner-repo`; директория `.fan/git/owner-repo` создана.
    - *Ожидаемый результат:* shallow clone с depth 200.
  - [ ] **TC-F-7-2:** Повторный запуск — cache hit через `git fetch --prune && git checkout <base>`
    - *Условие:* `.fan/git/owner-repo` уже существует (от прошлого запуска).
    - *Шаги:* arrange: создать `.fan/git/owner-repo` (мок директории). act: `cloneExternalRepo({url: "...", base: "main"})`. assert: bash получил `cd .fan/git/owner-repo && git fetch --prune && git checkout main`; НЕ получил `git clone` (cache hit).
    - *Ожидаемый результат:* fetch + checkout, не повторный clone.
  - [ ] **TC-F-7-3:** Edge case — `base` не в shallow-копии → рекомендация `git fetch --unshallow`, при ошибке → VERDICT: NEEDS_DISCUSSION
    - *Условие:* shallow clone, `base` ссылается на commit старше depth 200.
    - *Шаги:* arrange: mock git возвращает `fatal: bad revision` на `git diff <base>...HEAD`. act: `runReview({gitUrl, base})`. assert: вывод содержит инструкцию `git fetch --unshallow`; при невозможности unshallow → `VERDICT: NEEDS_DISCUSSION` с описанием.
    - *Ожидаемый результат:* graceful fallback при shallow-ограничениях.
- **Red-тест:** TC-F-7-1 (падает первым: `cloneExternalRepo` не реализован → bash mock не получает команду clone → assert на bash command падает).
- **Refactor-цели:** Вынести URL → slug в `repoSlug(url)` (handle edge cases: `.git` suffix, `git@` SSH формат, self-hosted GitHub); кэшировать clone state в `.fan/git/<slug>/.cloned-at` для отслеживания давности.
- **Критерии приёмки:**
  1. `cloneExternalRepo({url, base})` выполняет shallow clone (`--depth 200`) при первом запуске.
  2. Cache hit: повторный запуск → `fetch --prune` + `checkout <base>` без нового clone.
  3. Edge case `bad revision` → рекомендация `git fetch --unshallow` + fallback VERDICT: NEEDS_DISCUSSION.
- **Ожидаемый результат:** STEP 0 в `agents/code-review.md` описывает алгоритм clone-cache; `cloneExternalRepo` функция экспортируется + 3 unit-теста.
- **Оценка объёма:** M (≤ 1 день; ~50 строк в промпте + 1 функция + bash mocks + 3 unit-теста)

#### ☐ F-15: PlatformReviewAdapter contract (типы + документация)
- **Приоритет:** P1
- **Слой:** [INTEG]
- **Описание:** Создать `extensions/fan-orchestrator/review-adapters.d.ts` (TypeScript declaration file, 0 рантайма): типы `ReviewSeverity`, `ReviewVerdict`, `PlatformRef`, `DiffRequest`, `DiffResult`, `ReviewComment`, `ReviewResolution` + interface `PlatformReviewAdapter { id, getDiff, postComments, resolvePr }`. Создать `review-adapters.md` с документацией: семантика ошибок (network → retry, auth → явная ошибка, not found → 404), модель расширения (новые extension регистрируют реализацию, orchestrator остаётся platform-agnostic), прецедент `fan-confluence/client.ts`. Реализации (GitHub, Bitbucket) — отдельные extension в следующих фазах (не в v1).
- **Пользовательская история:** «Как разработчик следующей фазы, я хочу иметь чёткий TypeScript-контракт адаптера + документацию с прецедентом, чтобы создать GitHub/Bitbucket адаптер по образцу».
- **Зависимости:** (none — contract существует без реализаций)
- **TDD-тесты:**
  - [ ] **TC-F-15-1:** `review-adapters.d.ts` содержит все 8 объявлений (6 типов + 1 interface + 1 re-export) + `review-adapters.md` покрывает 3 секции (Semantics of errors, Extension model, Precedent) — объединены структурные проверки файлов
    - *Условие:* TypeScript-компилятор доступен, файлы созданы.
    - *Шаги:* arrange: `fs.readFileSync("review-adapters.d.ts")` + `fs.readFileSync("review-adapters.md")`. act: (1) regex в `.d.ts`: `/export type ReviewSeverity/`, `/export type ReviewVerdict/`, `/export interface PlatformRef/`, `/export interface DiffRequest/`, `/export interface DiffResult/`, `/export interface ReviewComment/`, `/export interface ReviewResolution/`, `/export interface PlatformReviewAdapter/` (≥ 1 совпадение каждого, итого 8); (2) regex в `.md`: `/^##\s+(Semantics of errors|Extension model|Precedent)/` (≥ 3 совпадения). assert: `.d.ts` has all 8 declarations; `.md` has 3 sections.
    - *Ожидаемый результат:* контракт структурно полон (типы + interface) + документация покрывает 3 ключевые темы.
  - [ ] **TC-F-15-2:** TypeScript-компиляция `review-adapters.d.ts` без ошибок (0 рантайма, чистые типы)
    - *Условие:* `npx tsc --noEmit extensions/fan-orchestrator/review-adapters.d.ts` (или эквивалент).
    - *Шаги:* arrange: tmp tsconfig с `"noEmit": true, "strict": true`. act: запустить tsc на файле. assert: exit code 0, нет ошибок.
    - *Ожидаемый результат:* contract валиден с точки зрения TypeScript strict mode.
  - [ ] **TC-F-15-3:** Error/edge case — неизвестный `platform` в `PlatformRef.id` не отвергается типом (`string & {}` pattern для extensibility), но реализация обязана явно его обработать
    - *Условие:* `.d.ts` скомпилирован, `review-adapters.md` содержит раздел «Extension model».
    - *Шаги:* arrange: TypeScript-fixture с `const ref: PlatformRef = { id: "github-enterprise-self-hosted", ... };` + спецификация реализации в `.md`. act: (1) `tsc --noEmit` на fixture — должен пройти БЕЗ ошибок (тип принимает произвольный `string` через `string & {}` паттерн для сохранения autocomplete + extensibility); (2) grep `.md` на упоминание правила: «Unknown platform id must be explicitly handled by the implementation (logged + gracefully rejected or forwarded) — the type contract is intentionally permissive». assert: (1) tsc exit code 0; (2) в `.md` присутствует явное требование к реализации.
    - *Ожидаемый результат:* контракт extensibility сохранён (тип не режет неизвестные платформы), но документация требует explicit handling в реализации — нет ложных отказов + нет скрытых assumptions.
- **Red-тест:** TC-F-15-1 (падает первым: `review-adapters.d.ts` не существует → `fs.readFileSync` throws ENOENT).
- **Refactor-цели:** Вынести общие severity/verdict в shared `review-types.d.ts` (используется также в `agents.d.ts` после расширения F-10); добавить JSDoc-комментарии к каждому типу с примерами.
- **Критерии приёмки:**
  1. `review-adapters.d.ts` экспортирует 8 объявлений (6 типов + 1 interface + 1 re-export) и компилируется в strict mode без ошибок.
  2. `review-adapters.md` содержит секции: Semantics of errors, Extension model, Precedent (fan-confluence).
  3. Orchestrator остаётся platform-agnostic (не импортирует runtime-реализации; только типы).
- **Ожидаемый результат:** `extensions/fan-orchestrator/review-adapters.d.ts` + `review-adapters.md` созданы; tsc strict compile зелёный; DEPLOY.toml включает оба файла (покрыто F-14 TC-F-14-3).
- **Оценка объёма:** M (≤ 1 день; ~80 строк .d.ts + ~50 строк .md + 3 unit-теста)

---

## Полный чеклист по приоритетам

### P0 — Критические
- [ ] F-1 [DATA]: Review-rules corpus (6 markdown-файлов в `review-rules/`)
- [ ] F-2 [CLI]: Agent definition (`agents/code-review.{js,md}` + регистрация в `agents/index.js`)
- [ ] F-3 [BIZ]: Stack detection (манифесты → стек, 4 стека + приоритет)
- [ ] F-4 [INTEG]: Rules loading pipeline (common → stack → conventions)
- [ ] F-5 [DATA]: Conventions.md schema (frontmatter + секции + парсер)
- [ ] F-6 [BIZ]: Conventions auto-profile lifecycle (3 триггера регенерации)
- [ ] F-8 [BIZ]: Diff-only review workflow (git diff → findings → verdict)
- [ ] F-9 [DATA]: Finding structure schema (5 полей + парсер)
- [ ] F-10 [BIZ]: Verdict parser extension (6 значений + severity-маппинг)
- [ ] F-11 [BIZ]: Security-handoff tagging (security-note + delegate)
- [ ] F-12 [BIZ]: Routing classification (правило №2 после security)
- [ ] F-13 [INTEG]: RULES_DIR constraint injection (enrichWorkerContext × 3)
- [ ] F-14 [CLI]: Agent profile config (read-only + 0.2/900s + DEPLOY)

### P1 — Высокие
- [ ] F-7 [INTEG]: External repo clone-cache (`.fan/git/<name>`, `--depth 200`)
- [ ] F-15 [INTEG]: PlatformReviewAdapter contract (типы + документация)

---

## Граф зависимостей

Граф зависимостей между функциями (проверен на циклы — ациклический, 26 рёбер, A→B = «B зависит от A»):

```
F-1 (rules corpus) ────────> F-3, F-4
F-2 (agent def) ───────────> F-3, F-4, F-6, F-7, F-8, F-9, F-10, F-11, F-12, F-13, F-14
F-3 (stack detection) ─────> F-4, F-8
F-4 (rules loading) ───────> F-8
F-5 (conventions schema) ──> F-4, F-6, F-7
F-6 (conventions lifecycle)> F-8
F-8 (diff review) ─────────> F-11
F-9 (finding schema) ──────> F-8, F-11
F-10 (verdict parser) ─────> F-8, F-9
F-13 (RULES_DIR injection)─> F-4

Изолированная вершина: F-15 (platform adapter contract), deps = (none)
```

Контроль суммы: 2 + 11 + 2 + 1 + 3 + 1 + 1 + 2 + 2 + 1 = 26 рёбер.

**Ключевые зависимости:**
- F-2 — узел-хаб по исходящим рёбрам (11: F-3, F-4, F-6, F-7, F-8, F-9, F-10, F-11, F-12, F-13, F-14), т.к. все они требуют зарегистрированного типа `code-review` в `getAgentTypes()`.
- F-8 — узел-хаб по входящим рёбрам (6: F-2, F-3, F-4, F-6, F-9, F-10): review workflow требует агента, детектированный стек, загруженные правила, conventions.md, finding schema, verdict parser.
- F-4 — 5 входящих (F-1, F-2, F-3, F-5, F-13): концентратор rules loading pipeline (правила + тип агента + стек + conventions + RULES_DIR).
- F-5 — параллельный фундамент (3 исходящих: F-4, F-6, F-7), задаёт контракт conventions.md.
- F-1 — фундамент rules corpus (2 исходящих: F-3, F-4).

**Корни (нет входящих):** F-1, F-2, F-5, F-15.
**Листья (нет исходящих):** F-7, F-11, F-12, F-14, F-15.

**Проверка на циклы:** обход в ширину от каждого корня (F-1, F-2, F-5, F-15). Возврата к пройденным узлам нет (DAG из 26 рёбер, 15 узлов). Циклов нет.

---

## Делегирование (если применимо)

- Не применимо: roadmap сгенерирован из полной спеки v1.0 (589 строк), количество функций ≤ 15, этапов ≤ 8.
- Возможные будущие roadmap (при расширении спеки):
  - `docs/features/code-review-github-adapter/roadmap.md` — реализация GitHub-адаптера по contract F-15
  - `docs/features/code-review-bitbucket-adapter/roadmap.md` — реализация Bitbucket-адаптера
  - `docs/features/code-review-conventions-hashing/roadmap.md` — программные хэши для регенерации conventions (фаза 2 спеки)