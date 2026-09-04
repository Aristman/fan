# Спецификация: Code-Review Worker для FAN Orchestrator

## Метаданные
- **Дата**: 2026-09-03
- **Автор**: Specification Generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича

## 1. Обзор

### 1.1 Цель
Добавить в FAN Orchestrator новый специализированный воркер `code-review` — агент для проведения архитектурного и качественного код-ревью diff-ов (PR / commit / branch). Воркер заполняет пробел между существующими `verify` (свежий diff: build/tests/lint) и `security` (глубокий OWASP/CWE-аудит), обеспечивая семантический анализ качества, стиля и архитектуры с учётом конвенций конкретного проекта и его стека.

### 1.2 Контекст
Текущие 9 воркеров оркестратора покрывают: разведку (`explore`), планирование (`plan`), реализацию (`implement`), верификацию diff-а (`verify`), security-аудит (`security`), фикс багов (`bug-fix`), глубокое исследование (`code-research`), тесты (`tests-impl`), документацию (`docs-impl`). `verify` — это механическая проверка «сломалось ли что-то» (build/tests/lint), он не оценивает архитектуру, паттерны, идиоматичность, дублирование, magic numbers, edge cases. Владелец продукта хочет, чтобы перед мойт работой (в режиме Plan → Implement → Verify) существовала стадия качественного ревью, которая:
1. Подтягивает конвенции проекта (стиль, подходы, архитектура).
2. Понимает стек (TypeScript/JS, Python, Kotlin/Java, Rust) и применяет релевантные правила.
3. Встраивается в систему оркестрации и допускает внешние код-ревью репозиториев (по git URL или локальному пути).
4. Расширяется через платформенные адаптеры (GitHub, Bitbucket) в следующих фазах.

### 1.3 Описание решения
Воркер `code-review` — десятый агент оркестратора, реализуется в `extensions/fan-orchestrator/agents/code-review.{js,md}` по образцу `verify`. Ключевые свойства:
- **Read-only** (сохраняет параллельный слот) с единственным исключением — запись `conventions.md` через `bash`-heredoc.
- **Stack-aware**: авто-детекция стека по манифестам + загрузка правил из `extensions/fan-orchestrator/review-rules/` (common + stack-specific).
- **Авто-профиль конвенций**: при первом ревью генерируется `.fan/code-review/conventions.md` (фронтматтер + секции Style/Architecture/Patterns), далее используется и обновляется при изменении `analyzed_files` или устаревании >30 дней; ручные правки пользователя сохраняются.
- **Diff-only по дефолту**: ревью — это `git diff <base>...HEAD` (или эквивалент для внешнего репо через клон-кэш). Полный аудит репо явно исключён.
- **Структурированные findings**: severity (CRITICAL/MAJOR/MINOR/INFO) + verdict (APPROVED / CHANGES_REQUESTED / NEEDS_DISCUSSION).
- **Security-handoff**: при обнаружении security-issue воркер помечает `security-note` и рекомендует делегировать на security-воркер.
- **Платформенный contract**: тип `PlatformReviewAdapter` описывает интерфейс адаптера (getDiff / postComments / resolvePr), реализации — отдельные extension в следующих фазах.

## 2. Функциональные требования

### 2.1 Основные функции

#### F-1. Stack detection
Воркер анализирует манифесты проекта (`package.json`, `pyproject.toml`, `Cargo.toml`, `build.gradle.kts`/`pom.xml`) и/или распределение файлов по расширениям, чтобы выбрать релевантный stack-specific файл правил. Поддерживаемые стеки v1: TypeScript/JS, Python, Kotlin/Java, Rust.

#### F-2. Загрузка правил (review-rules)
Из директории, указанной в контекстной constraint-переменной `CODE_REVIEW_RULES_DIR=<abs>`. Загружаются в порядке:
1. `common.md` — универсальный чек-лист (naming, дублирование, dead code, ошибки, валидация, утечки ресурсов, идемпотентность, magic numbers, сложность, edge cases) + cross-stack типичные баги + severity-модель + security-notes policy.
2. `<stack>.md` — идиомы, anti-patterns, reviewer checklist 10–15 пунктов, типичные баги стека, tooling.
3. `conventions.md` (project-local: `.fan/code-review/conventions.md`) или `conventions.<name>.md` для внешних репо.

#### F-3. Авто-профиль конвенций
При первом ревью (или при отсутствии файла, либо при устаревании >30 дней, либо при изменении `analyzed_files`) воркер генерирует `.fan/code-review/conventions.md` на основе анализа кода. Формат:
- **Frontmatter**: `stack`, `last_analyzed`, `analyzed_files` (хэш-список/список).
- **Секции**: `## Style` (форматирование, naming, импорты), `## Architecture` (слои, модули, потоки), `## Patterns` (применяемые паттерны, идиомы стека).
- При регенерации ручные секции пользователя сохраняются (merge по заголовкам).

#### F-4. Diff-only ревью (внутреннее)
Воркер получает на вход указание на diff: `git diff <base>...HEAD` через bash. Ревьюируется только изменённый код. Каждое ревью обязано вернуть:
- Review Scope (что проверено).
- Findings: `Severity | File:Line | Category | Problem | Suggestion`.
- Summary Table (распределение findings по severity).
- Security Handoffs (если есть).
- Финальный `VERDICT: APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION`.

#### F-5. Внешнее ревью по git URL
Поддерживается вход в виде git URL. Алгоритм:
1. Клон репо в `.fan/git/<name>` с `--depth 200`. Если директория уже существует — `git fetch --prune` + `git checkout <ref>` (cache hit).
2. `base` — обязательный аргумент задачи (commit / branch / tag).
3. `git diff <base>...HEAD` через bash.
4. Конвенции для внешнего репо — в `.fan/code-review/conventions.<name>.md` (а не в общем файле).
5. При отсутствии `base` в shallow-копии — инструкция `git fetch --unshallow` воркеру.

#### F-6. Локальный путь
Воркер принимает локальный путь и проводит ревью на месте (без клонирования). Конвенции — общий `.fan/code-review/conventions.md` (если проект не external).

#### F-7. Findings со severity
Каждый finding структурирован:
```
- Severity: CRITICAL | MAJOR | MINOR | INFO
  File:Line: <relative_path>:<line>
  Category: <naming|dead-code|error-handling|...>
  Problem: <краткое описание>
  Suggestion: <конкретная рекомендация>
```

#### F-8. Вердикты
Парсер `parseVerdict` расширяется до 6 значений:
- `APPROVED` — только MINOR/INFO findings, либо их нет.
- `CHANGES_REQUESTED` — есть CRITICAL/MAJOR findings.
- `NEEDS_DISCUSSION` — неоднозначные случаи (например, MAJOR без чёткого решения, разногласия в команде, требует архитектурного решения).
Существующие `PASS|FAIL|PARTIAL` (verify) сохраняются.

#### F-9. Security-переадресация
Воркер **не** проводит глубокий security-аудит. При обнаружении потенциальной security-проблемы воркер:
1. Помечает finding с тегом `security-note`.
2. Добавляет в отчёт блок `## Security Handoffs` со ссылкой на конкретный file:line.
3. Рекомендует делегировать полный аудит на `security`-воркер (через координатор).

#### F-10. Routing (интеграция с classify_task)
`classifyTaskByDescription` обновляется:
- Новое правило №2 (после security): code-review.
- Удалить/сузить голое слово `review` из regex verify-воркера — оно маскирует code-review.
- Положительные маркеры для code-review: `code review`, `review this PR|diff|changes|commit|branch`, `PR review`, `LGTM`, `ревью`, `код-ревью`.
- Отрицательные маркеры (остаются за другими воркерами): `verify the build` → verify, `check for vulnerabilities` → security.

### 2.2 Пользовательские сценарии

#### Сценарий 1: Первое ревью с генерацией conventions
**Предусловия:** проект содержит TypeScript/JS-код, файла `.fan/code-review/conventions.md` нет.
**Шаги:**
1. Координатор классифицирует задачу `проведи code review последних изменений` → `code-review`.
2. Воркер запускается в read-only слоте с constraint `CODE_REVIEW_RULES_DIR=/abs/.../review-rules`.
3. STEP 0: определяет, что diff = `git diff origin/main...HEAD` через bash.
4. STEP 1: детектит стек TypeScript/JS по `package.json`.
5. STEP 2: загружает `common.md` + `typescript.md`.
6. STEP 3: `conventions.md` отсутствует → воркер анализирует стиль/архитектуру/паттерны кода, создаёт `.fan/code-review/conventions.md` через `bash`-heredoc (единственное исключение из read-only).
7. Проводит ревью diff-а, выдаёт Findings + Summary + Security Handoffs (если есть) + `VERDICT: CHANGES_REQUESTED` (т.к. обнаружены MAJOR findings).
**Ожидаемый результат:** структурированный отчёт, создан `conventions.md`, вердикт распарсен координатором.

#### Сценарий 2: Повторное ревью с существующим профилем
**Предусловия:** `.fan/code-review/conventions.md` существует, `last_analyzed` < 30 дней, `analyzed_files` не изменились.
**Шаги:**
1. Запуск code-review для нового diff-а.
2. STEP 3: conventions.md актуален → воркер использует его без перегенерации, применяет правила из `common.md` + `typescript.md` + проектные конвенции.
3. Возвращает VERDICT.
**Ожидаемый результат:** ревью быстрее (нет фазы анализа), результат согласован с ранее выявленными конвенциями.

#### Сценарий 3: Внешнее ревью по git URL
**Предусловия:** задача содержит git URL `https://github.com/owner/repo` и `base=main`.
**Шаги:**
1. Воркер клонирует репо в `.fan/git/repo` с `--depth 200`.
2. `git fetch --prune && git checkout main` (cache hit при повторе).
3. `git diff main...HEAD` через bash.
4. Stack по манифестам внешнего репо.
5. Конвенции внешнего → `.fan/code-review/conventions.repo.md` (отдельный от текущего проекта).
6. Ревью + вердикт.
**Ожидаемый результат:** отчёт по внешнему репо, кэш клона для последующих запусков.

#### Сценарий 4: Локальный путь
**Предусловия:** задача `code review путь /home/user/other-project`.
**Шаги:**
1. Воркер `cd /home/user/other-project`, читает манифесты, детектит стек.
2. Правила загружаются по `CODE_REVIEW_RULES_DIR` (одинаков для всех запусков).
3. Конвенции — общий `.fan/code-review/conventions.md` (не external).
4. Ревью + вердикт.
**Ожидаемый результат:** отчёт по указанному пути без клонирования.

#### Сценарий 5: Routing через classify_task
**Предусловия:** координатор получил задачу от пользователя.
**Шаги:**
1. `classifyTaskByDescription` применяет правила в порядке: security → code-review → explore → plan → verify.
2. Фраза `review this PR for code style` → code-review (новое правило №2 срабатывает первым).
3. Фраза `verify the build before merge` → verify (security/code-review не сработали, голое verify осталось).
4. Фраза `check for SQL injection in the auth module` → security (правило №1).
**Ожидаемый результат:** корректная маршрутизация без перекрытия verify/security.

### 2.3 Бизнес-правила
- **B-1**: Воркер `code-review` всегда `readOnly: true` и работает в параллельном слоте (не эксклюзивном).
- **B-2**: Единственное разрешённое исключение read-only — запись `.fan/code-review/conventions.md` и `.fan/code-review/conventions.<name>.md` через bash-heredoc.
- **B-3**: Воркер не запускает build/tests/lint — это ответственность `verify`.
- **B-4**: Воркер не проводит глубокий security-аудит — это ответственность `security` (воркер только маркирует и переадресует).
- **B-5**: Каждый finding имеет severity (одно из CRITICAL/MAJOR/MINOR/INFO).
- **B-6**: Каждый ответ воркера содержит `VERDICT: ...` (обязательно, координатор парсит).
- **B-7**: Конвенции регенерируются при отсутствии / >30 дней / изменении `analyzed_files`; ручные секции пользователя сохраняются при регенерации.
- **B-8**: Все файлы правил (common + 4 стека) — встроены в `extensions/fan-orchestrator/review-rules/` (НЕ в FAN Store).
- **B-9**: Платформенные адаптеры — отдельные пакеты, оркестратор остаётся platform-agnostic.

## 3. UI/UX требования (адаптировано для agent-воркера)

### 3.1 Компонент в UI оркестратора
- **Иконка**: 🔎 (distinguish от 🛡️ security и 🧪 verify) — добавляется в `agentIcons` (orchestrator-extension.js:500-504 и 1218).
- **Label**: `Code Reviewer` в таблице воркеров buildCoordinatorPrompt.
- **Слот**: read-only слот (как explore/plan/verify/security) — отображается как параллельный пул.

### 3.2 Взаимодействие
- Координатор парсит `VERDICT: APPROVED|CHANGES_REQUESTED|NEEDS_DISCUSSION` из ответа воркера и принимает решение о следующих шагах (продолжить / прервать / обсудить).
- При наличии `## Security Handoffs` в ответе координатор может опционально делегировать security-воркеру.
- Task widget отображает текущий вердикт рядом с прогрессом задачи.

### 3.3 Обработка ошибок
- Отсутствие `CODE_REVIEW_RULES_DIR` в контексте — координатор логирует warning, воркер работает без stack-specific правил (только common).
- Ошибка клонирования внешнего репо — воркер возвращает VERDICT: NEEDS_DISCUSSION с описанием ошибки (network / auth / not found).
- Превышение таймаута 900s — воркер возвращает partial findings + VERDICT: NEEDS_DISCUSSION.
- Отсутствие `base` в shallow-копии — инструкция `git fetch --unshallow`, при невозможности — VERDICT: NEEDS_DISCUSSION.

## 4. Нефункциональные требования

### 4.1 Производительность
- **Контекст-бюджет**: общий лимит `WorkerContext` = 22500 chars (~5650 tokens). Правила (common + stack) — не более 5000 chars/файл; conventions — отдельный файл, не входит в основной budget (читается ad-hoc).
- **Таймаут**: `agentTimeouts.code-review` = 900s (расширенный — для clone + большой diff).
- **Temperature**: `agentTemperature.code-review` = 0.2 (низкая для стабильности verdict).
- **Модель**: `cloud.models.code-review` — по умолчанию пустая (наследует orchestrator default), per-project override.

### 4.2 Безопасность
- Read-only enforcement: `PROFILES_BY_AGENT["code-review"] = "read-only"` в `broker-handler.js` — обязательно (иначе default `"all"` = write-MCP).
- Bash-исключение для heredoc — сужено до одного пути `.fan/code-review/conventions*.md`, контролируется промптом.
- Внешние клоны — в `.fan/git/<name>` (sandbox-зона), `--depth 200` ограничивает blast radius.
- API-ключи платформ (GitHub/Bitbucket) — в конфиге extension-ов адаптеров, не в orchestrator.

### 4.3 Надёжность
- Кэш внешних клонов: `.fan/git/<name>` переиспользуется через `git fetch --prune` (cache hit).
- Conventions versioning: `last_analyzed` + `analyzed_files` в frontmatter — основа для решения о регенерации.
- Вердикт всегда присутствует (B-6) — координатор не остаётся без решения.
- `parseVerdict` устойчив к case и whitespace (regex с `\s*` и `\b`, case-insensitive флаг).

### 4.4 Масштабируемость
- Параллельный слот read-only: code-review может запускаться одновременно с explore/plan/verify/security — без contention.
- Правила добавляются в `review-rules/` без правок runtime (новый `<stack>.md` автоматически доступен после правки `agents/code-review.md` STEP 2).
- Платформенные адаптеры — pluggable через `PlatformReviewAdapter` interface (см. §5.3).

## 5. Технические требования

### 5.1 Стек технологий
- **Runtime**: Bun, TypeScript strict mode.
- **Extension location**: `extensions/fan-orchestrator/` (standalone FAN Store extension).
- **Agent format**: hybrid (`agents/<name>.js` — type/definition, `agents/<name>.md` — frontmatter + system prompt).
- **Tools воркера**: `read`, `bash`, `grep`, `find`, `ls` (как у verify).
- **Конфигурация**: `config.example.json` + `config.js` (DEFAULTS).
- **Дистрибуция правил**: встроены в extension (`review-rules/`), НЕ через FAN Store.

### 5.2 Архитектура

#### Слои интеграции
```
extensions/fan-orchestrator/
├── agents/
│   ├── code-review.js              # НОВЫЙ: type "code-review", label "Code Reviewer", icon 🔎, readOnly: true
│   ├── code-review.md              # НОВЫЙ: frontmatter + промпт ~150-200 строк (паттерн verify.md)
│   ├── index.js                    # ПРАВКА: import + AGENT_REGISTRY
│   └── ...
├── review-rules/                   # НОВАЯ ДИРЕКТОРИЯ
│   ├── README.md                   # НОВЫЙ: индекс, loading order
│   ├── common.md                   # НОВЫЙ: cross-stack checklist + severity model + security policy
│   ├── typescript.md               # НОВЫЙ: TS/JS idioms + anti-patterns + tooling (tsc/eslint)
│   ├── python.md                   # НОВЫЙ: Python idioms + anti-patterns + tooling (ruff/mypy)
│   ├── kotlin.md                   # НОВЫЙ: Kotlin/Java idioms + anti-patterns + tooling (gradle/detekt)
│   └── rust.md                     # НОВЫЙ: Rust idioms + anti-patterns + tooling (cargo clippy/fmt)
├── review-adapters.d.ts            # НОВЫЙ: PlatformReviewAdapter interface (типы, 0 рантайма)
├── review-adapters.md              # НОВЫЙ: документация контракта + семантика ошибок + прецедент fan-confluence
├── broker-handler.js               # ПРАВКА: PROFILES_BY_AGENT["code-review"] = "read-only"
├── orchestrator-tools.js           # ПРАВКА: routing (правило №2, сужение verify) + REVIEW_RULES_DIR + enrichWorkerContext + 3 mergeContext (355/538/616) + AGENT_ICONS + delegate_task description + promptSnippet + classify_task description
├── orchestrator-extension.js       # ПРАВКА: agentIcons ×2 (500-504, 1218), WORKER_PROFILES, ASSIGNMENT_ORDER + "code-review"
├── agents.js                       # ПРАВКА: parseVerdict 6 вердиктов + buildCoordinatorPrompt (routing rules + workflow шаги 7-8)
├── agents.d.ts                     # ПЕРЕГЕНЕРАЦИЯ: после правки agents.js (parseVerdict)
├── config.js                       # ПРАВКА: DEFAULTS.agentTemperature.code-review = 0.2; agentTimeouts.code-review = 900
├── config.example.json             # ПРАВКА: cloud.models.code-review = "" × 2
└── test/
    ├── agents-security-routing.test.mjs   # ПРАВКА: "review this PR" → code-review (осознанная миграция)
    ├── agents-code-review-definition.test.mjs  # НОВЫЙ: definition контракт + .md парсинг + маркеры промпта
    ├── agents-code-review-routing.test.mjs     # НОВЫЙ: positive (8 фраз) + negative guards (5 фраз)
    └── agents-code-review-integration.test.mjs # НОВЫЙ: PROFILES_BY_AGENT, parseVerdict, файлы правил, инъекция RULES_DIR, orchestrator-extension контракты

DEPLOY.toml                         # ПРАВКА: include review-rules/*.md, review-adapters.d.ts, review-adapters.md
extensions/fan-orchestrator/README.md  # ПРАВКА: воркеров 9→10, таблица, read-only список, секция Code Review Worker
docs/guides/orchestrator.md         # ПРАВКА: документация нового воркера + routing
```

#### Промпт воркера (структура, ~150-200 строк)
По образцу `verify.md`:
1. **## ROLE** — Code Reviewer.
2. **## ROLE BOUNDARY** — только diff; build/tests → verify; deep security → security.
3. **## CRITICAL RULES** — read-only (исключение: bash-heredoc в `.fan/code-review/conventions*.md`); всегда VERDICT; каждый finding = file:line + excerpt + suggestion; security-issue → security-note + delegate.
4. **## STEP 0 — Locate inputs**: fresh diff / external URL (clone в `.fan/git/<name>`) / local path.
5. **## STEP 1 — Detect stack**: манифесты (`package.json`, `pyproject.toml`, `Cargo.toml`, `build.gradle.kts`/`pom.xml`).
6. **## STEP 2 — Load rules**: `CODE_REVIEW_RULES_DIR` → common.md → `<stack>.md` → conventions.md (auto-profile при отсутствии / 30 дней / изменении analyzed_files; ручные секции сохраняются).
7. **## REVIEW CHECKLIST**: корректность, согласованность, API-совместимость, полнота, тесты, идиоматичность стека.
8. **## COMMON MISTAKES**: nitpicking, ревью вне diff, дублирование verify/security.
9. **## MANDATORY OUTPUT FORMAT**: Review Scope → Findings (Severity/File/Category/Problem/Suggestion) → Summary Table → Security Handoffs → `VERDICT: APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION` + Summary.

### 5.3 Интеграции

#### D2 — Инъекция CODE_REVIEW_RULES_DIR через context.constraints
```js
// orchestrator-tools.js
const REVIEW_RULES_DIR = path.join(__dirname, "review-rules");

function enrichWorkerContext(agent, context) {
    if (agent === "code-review") {
        context.constraints = [
            ...(context.constraints || []),
            `CODE_REVIEW_RULES_DIR=${REVIEW_RULES_DIR}`,
        ];
    }
    return context;
}

// Обёртка mergeContext в 3 местах (chain:355, parallel:538, single:616)
const context = enrichWorkerContext(agent, mergeContext(...));
```
Работает во всех режимах установки (dev / `~/.fan/agent/extensions/` / `execDir`), т.к. путь вычисляется относительно `__dirname`.

#### parseVerdict (D4) — агенты.js
```js
export function parseVerdict(text) {
    if (!text) return null;
    const m = text.match(/VERDICT:\s*(PASS|FAIL|PARTIAL|APPROVED|CHANGES_REQUESTED|NEEDS_DISCUSSION)\b/i);
    return m ? m[1].toUpperCase() : null;
}
```
Маппинг severity → verdict: CRITICAL/MAJOR → CHANGES_REQUESTED; только MINOR/INFO → APPROVED; неоднозначность → NEEDS_DISCUSSION.

#### Routing (D3) — orchestrator-tools.js
```js
// classifyTaskByDescription — порядок правил
const CODE_REVIEW_KEYWORDS = /\b(code\s*review|review\s+(this|the)\s+(pr|diff|changes|commit|branch)|pr\s*review|lgtm|ревью|код[\s-]ревью)\b/i;
// verify-rule сужается: убрать \breview\b|security (т.к. эти домены теперь у code-review и security)
```
Порядок: security → code-review (новое №2) → explore → plan → verify.

#### PROFILES_BY_AGENT (broker-handler.js)
```js
const PROFILES_BY_AGENT = {
    "explore": "read-only",
    "plan": "read-only",
    "verify": "read-only",
    "code-research": "read-only",
    "code-review": "read-only",  // НОВОЕ — обязательно, иначе default "all" = write-MCP
    "security": "read-only",      // ДОБИТЬ — отсутствие в текущей карте = дырка
};
```

#### DEPLOY.toml include
```toml
include = [
    # ... existing
    "review-rules/*.md",
    "review-adapters.d.ts",
    "review-adapters.md",
]
```

### 5.4 Внешние зависимости
- `git` — для clone/fetch/diff (через bash).
- LLM — per-agent model из config.
- `fan-confluence/client.ts` — прецедент HTTP-клиента для будущих платформенных адаптеров.

## 6. Данные

### 6.1 Сущности

#### conventions.md (project-local: `.fan/code-review/conventions.md`)
```markdown
---
stack: typescript
last_analyzed: 2026-09-03T12:00:00Z
analyzed_files:
  - src/index.ts
  - src/cli/*.ts
  - extensions/fan-orchestrator/agents/*.js
---

## Style
- [Выявленные стилистические конвенции]

## Architecture
- [Слои, модули, потоки данных]

## Patterns
- [Применяемые паттерны, идиомы]
```
Внешний репо: `.fan/code-review/conventions.<name>.md` (аналогичная структура, но `analyzed_files` относительно клона).

#### review-rules/<stack>.md
```markdown
# Code Review Rules: <Stack>

## Stack Detection Hints
- Манифесты: <список>
- Файлы: <типичные расширения>

## Idioms
- [Идиоматичные паттерны стека]

## Anti-patterns
- [Антипаттерны с примерами]

## Reviewer Checklist
1. [пункт]
2. [пункт]
...
10-15. [пункт]

## Typical Bugs
- [Типичные баги стека]

## Tooling
- [Линтеры, форматтеры, типчекеры]
```

#### review-adapters.d.ts (контракт адаптера, 0 рантайма)
```typescript
export type ReviewSeverity = "CRITICAL" | "MAJOR" | "MINOR" | "INFO";
export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED" | "NEEDS_DISCUSSION";

export interface PlatformRef {
    platform: "github" | "bitbucket" | string;
    host?: string;            // для self-hosted
    owner: string;
    repo: string;
}

export interface DiffRequest {
    ref: PlatformRef;
    source: "commit" | "branch" | "pr";
    base?: string;            // commit/branch для source="branch"|"commit"
    maxDiffBytes?: number;
}

export interface DiffResult {
    diff: string;
    base: string;
    head: string;
    changedFiles: string[];
    truncated: boolean;
}

export interface ReviewComment {
    file: string;
    line: number;
    side: "LEFT" | "RIGHT";
    severity: ReviewSeverity;
    body: string;
}

export interface ReviewResolution {
    verdict: ReviewVerdict;
    summary: string;
}

export interface PlatformReviewAdapter {
    id: string;                                       // "github" | "bitbucket" | ...
    getDiff(req: DiffRequest): Promise<DiffResult>;
    postComments(ref: PlatformRef, comments: ReviewComment[]): Promise<void>;
    resolvePr(ref: PlatformRef, resolution: ReviewResolution): Promise<void>;
}
```

#### Verdict enum (parseVerdict)
```
PASS | FAIL | PARTIAL | APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION
```

#### Severity enum (findings)
```
CRITICAL | MAJOR | MINOR | INFO
```

### 6.2 Валидация
- **conventions.md frontmatter**: обязательные поля `stack`, `last_analyzed` (ISO 8601), `analyzed_files` (non-empty array).
- **finding**: обязательные поля `Severity`, `File:Line` (формат `path:line`), `Problem`, `Suggestion`; `Category` — опционально.
- **VERDICT**: обязательно присутствует в ответе воркера; одно из 6 значений; case-insensitive парсинг.
- **CODE_REVIEW_RULES_DIR constraint**: абсолютный путь; должен существовать (минимум `common.md`).
- **base (внешнее ревью)**: обязательный аргумент; commit/branch/tag.

## 7. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| **Routing-регрессия**: «review this PR» зашит в `agents-security-routing.test.mjs:201-205` как verify — без миграции теста новый code-review не получит задачу | Высокая | Критичное | Этап 5.1: обязательная правка теста (`"review this PR" → code-review`); Этап 5.3: новый позитивный routing-тест с тем же маркером |
| **PROFILES_BY_AGENT default `"all"`**: если не добавить `"code-review": "read-only"`, воркер получит write-MCP пермишены (эксклюзивный слот + риск записи вне `conventions.md`) | Высокая | Критичное | Этап 3.2: обязательная правка `broker-handler.js`; Этап 5.4: контракт-тест `PROFILES_BY_AGENT["code-review"] === "read-only"`; заодно добить `security: "read-only"` (отсутствие в текущей карте = та же дырка) |
| **Bash-write trade-off**: read-only воркер с инструментом `bash` = теоретический вектор произвольной записи; промпт сужает до одного пути | Средняя | Среднее | Осознанный trade-off (D1 — параллельность важнее enforcement); промпт содержит CRITICAL RULE «только `.fan/code-review/conventions*.md`»; мониторинг через task widget (видны `bash`-команды воркера) |
| **`agents.d.ts` генерируемый**: правка `parseVerdict` в `agents.js` без перегенерации `.d.ts` = рассинхрон типов | Средняя | Среднее | Этап 3.7: явно перегенерировать `agents.d.ts` после правки `parseVerdict` (запустить `npm run build` / `tsc` для пакета) |
| **`--depth 200` без base-коммита**: shallow-копия может не содержать указанный `base` → `git diff` вернёт ошибку | Средняя | Среднее | В промпте: STEP 0 инструкция «если `fatal: bad revision` → `git fetch --unshallow`»; при невозможности — VERDICT: NEEDS_DISCUSSION с описанием |
| **Кэш `.fan/git/<name>`**: scratch-зона клонов мутирует (fetch/checkout); конфликт имён между проектами; разрастание диска | Низкая | Низкое | README: пометить `.fan/git/` как cache/scratch (мутация ok); очистка — ответственность пользователя (`rm -rf .fan/git/<name>`); именование по URL-slug |
| **Conventions регенерация — LLM-энфорсится**: воркер может перезаписать ручные правки пользователя | Средняя | Среднее | B-7: ручные секции сохраняются при регенерации (merge по заголовкам); программные хэши analyzed_files — фаза 2 |
| **Контекст-бюджет 22500 chars**: большой diff + правила + conventions могут не влезть | Средняя | Среднее | Правила <5K chars/файл (валидация в CI); diff читать пофайлово через `git diff -- <path>` (не целиком) |
| **Двойное описание verify как «code review» в `delegate_task` description и `promptSnippet` (orchestrator-tools.js:244, 250-257)** — конфликт ролей после появления code-review | Средняя | Среднее | Этап 3.3: разграничить формулировки (verify = «build/tests/lint», code-review = «качество/стиль/архитектура diff-а») |
| **`config.js` DEFAULTS.agentTemperature рассинхрон с `config.example.json`** (security есть в example, нет в DEFAULTS) | Низкая | Низкое | Этап 3.5: при добавлении code-review в оба файла — заодно добить security в DEFAULTS |
| **agentIcons дублируется** (orchestrator-extension.js:500-504 и 1218) — пропуск одной локации = иконка 🔎 не отображается в части UI | Низкая | Низкое | Этап 3.6: править оба места; контракт-тест в `agents-code-review-integration.test.mjs` |

## 8. Компромиссы (Tradeoffs)

### D1. Запись conventions.md через bash-heredoc из read-only воркера
- **Решение**: воркер остаётся `readOnly: true`, tools `[read, bash, grep, find, ls]`; запись `.fan/code-review/conventions*.md` — единственное исключение через `bash`-heredoc.
- **Альтернативы отклонённые**:
  - Добавить `write` в tools воркера → воркер становится write-агентом (эксклюзивный слот, не параллелится с explore/plan/verify/security).
  - Координатор пишет conventions.md → координатор не имеет доступа к bash/read в текущем цикле + требует ещё один delegation round-trip.
  - Extension-код пишет conventions.md после runSingleAgent → extension не имеет LLM-контекста для анализа стиля/архитектуры.
- **Обоснование**: параллельный слот важнее, чем enforcement. Промпт сужает bash-исключение до одного пути.

### D2. CODE_REVIEW_RULES_DIR через WorkerContext.constraints
- **Решение**: инъекция constraint `CODE_REVIEW_RULES_DIR=<abs>` через `enrichWorkerContext` во всех 3 местах вызова mergeContext (chain/parallel/single).
- **Альтернативы**: env-variable в spawn → не работает с `--no-extensions`; hardcode в промпте → ломается при установке extension в `~/.fan/agent/extensions/`.
- **Обоснование**: `path.join(__dirname, "review-rules")` корректен во всех режимах установки.

### D3. Routing — code-review вторым (после security), сужение verify
- **Решение**: `security → code-review → explore → plan → verify`; убрать `\breview\b|\bsecurity\b` из verify-regex; code-review матчит только связки (`code review`, `review this PR|diff|...`, `LGTM`, `ревью`, `код-ревью`).
- **Альтернатива**: code-review после verify → роли конфликтуют, фразы «review this PR» уходят в verify.
- **Обоснование**: security — наиболее специфичный домен (не пересекается с code-review); code-review — более специфичен, чем explore/plan/verify.

### D4. Вердикты: 6 значений с явным маппингом severity
- **Решение**: расширить parseVerdict до `APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION` (плюс существующие `PASS|FAIL|PARTIAL`); маппинг CRITICAL/MAJOR → CHANGES_REQUESTED, MINOR/INFO-only → APPROVED, неоднозначность → NEEDS_DISCUSSION.
- **Альтернатива**: оставить только PASS/FAIL → теряется семантика «ревью успешно, но есть nitpicks» (APPROVED с MINOR) и «неоднозначность требует обсуждения» (NEEDS_DISCUSSION).
- **Обоснование**: 3-уровневая модель лучше отражает реальный PR-review workflow.

### D5. Внешние репо: клон-кэш + diff `git diff <base>...HEAD`
- **Решение**: клон в `.fan/git/<name>` (`--depth 200`, cache hit через `fetch --prune`); `base` — обязательный аргумент; конвенции внешнего → `conventions.<name>.md`.
- **Альтернатива (отклонённая владельцем)**: полный аудит репо вместо diff-only → слишком дорого (контекст-бюджет 22500 chars, таймаут).
- **Альтернатива**: GitHub API напрямую через curl → прецедент есть в repo-explorer SKILL.md, но для code-review требуется contract (см. §5.3) — реализации GitHub/Bitbucket в следующих фазах.
- **Обоснование**: классический PR-review workflow (commit / branch vs base) — наиболее частый use case.

### Отклонённые альтернативы (на уровне владельца)
- **Полный аудит репо вместо diff-only** — отклонён владельцем.
- **Хранение правил через FAN Store** — отклонён владельцем: правила встроены в `extensions/fan-orchestrator/review-rules/`.
- **Write-tools воркеру** — отклонён D1 (потеря параллельности).
- **GitHub/Bitbucket адаптеры сразу** — отклонён владельцем: только contract в v1, реализации в следующих фазах.

## 9. Приоритеты

### Must Have (Обязательно)
- Воркер `code-review` (agents/code-review.{js,md}) с `readOnly: true`, tools `[read, bash, grep, find, ls]`, иконкой 🔎.
- Правила для 4 стеков: TypeScript/JS, Python, Kotlin/Java, Rust (`review-rules/{common,typescript,python,kotlin,rust}.md` + README).
- Авто-профиль `.fan/code-review/conventions.md` (генерация → использование → обновление по 30 дням / изменению analyzed_files, ручные секции сохраняются).
- Routing: новое правило №2 после security; сужение verify-regex; code-review матчит связки (`code review`, `review this PR|diff|...`, `LGTM`, `ревью`, `код-ревью`).
- Вердикты: расширение parseVerdict до 6 значений (`APPROVED | CHANGES_REQUESTED | NEEDS_DISCUSSION` + существующие PASS/FAIL/PARTIAL).
- Security-переадресация: `security-note` + рекомендация делегировать на security-воркер.
- Инъекция `CODE_REVIEW_RULES_DIR` через WorkerContext.constraints во всех 3 режимах.
- PROFILES_BY_AGENT["code-review"] = "read-only" в broker-handler.js.
- DEPLOY.toml включает `review-rules/*.md`, `review-adapters.d.ts`, `review-adapters.md`.
- Тесты: agents-code-review-{definition,routing,integration}.test.mjs + правка agents-security-routing.test.mjs.

### Should Have (Желательно)
- Платформенный contract: `review-adapters.d.ts` (типы `PlatformReviewAdapter`, `ReviewSeverity`, `ReviewVerdict`, `PlatformRef`, `DiffRequest`, `DiffResult`, `ReviewComment`, `ReviewResolution`) + `review-adapters.md` (семантика ошибок, прецедент fan-confluence/client.ts).
- Внешние ревью по git URL: клон-кэш `.fan/git/<name>` с `--depth 200` + `fetch --prune`; `base` — обязательный аргумент; `git diff <base>...HEAD` через bash.
- Внешние конвенции: `.fan/code-review/conventions.<name>.md` (отдельно от основного проекта).
- README для `extensions/fan-orchestrator/README.md` (воркеров 9→10, таблица, read-only список, секция Code Review Worker).
- `docs/guides/orchestrator.md` — документация нового воркера + routing.

### Could Have (Возможно)
- Смарт-назначение модели в `WORKER_PROFILES` (`code-review: {reasoning:1, context:6, cost:3, maxTokens:0.3}`).
- README в `review-rules/` с loading order и примерами.
- Дополнительные negative-guards в routing-тестах (например, «run tests» → verify).

### Won't Have (Не входит в v1)
- **Реализации GitHub/Bitbucket адаптеров** — отдельные extension в следующих фазах (согласовано с владельцем).
- **Полный аудит репо** — только diff-only (отклонено владельцем).
- **FAN Store дистрибуция правил** — правила встроены в extension (отклонено владельцем).
- **Глубокий security-аудит** — ответственность `security`-воркера; code-review только маркирует и переадресует.
- **Программный stack detection** — LLM-инструкция «прочитай манифесты» (нет API для этого в context-builder).
- **Memory для воркера** — воркеры изолированы (`--no-extensions`); знания передаются через coordinator (previousFindings).
- **Программные хэши для регенерации conventions** — LLM-энфорсится в v1; фаза 2.

## 10. Следующие шаги

### Этап 1 — Правила (без связей с рантаймом)
- [ ] Создать `extensions/fan-orchestrator/review-rules/common.md`: Review Checklist (naming, дублирование, dead code, ошибки, валидация, утечки ресурсов, идемпотентность, magic numbers, сложность, edge cases), Typical Bugs cross-stack, Severity Model + маппинг вердиктов, Security Notes Policy.
- [ ] Создать `extensions/fan-orchestrator/review-rules/typescript.md`: Stack Detection Hints (манифесты package.json), Idioms, Anti-patterns (any, non-null !), Reviewer Checklist 10-15 п., Typical Bugs (floating promises), Tooling (tsc/eslint).
- [ ] Создать `extensions/fan-orchestrator/review-rules/python.md`: Stack Detection Hints (pyproject.toml), Idioms, Anti-patterns (mutable defaults, bare except), Reviewer Checklist, Typical Bugs (late binding), Tooling (ruff/mypy).
- [ ] Создать `extensions/fan-orchestrator/review-rules/kotlin.md`: Stack Detection Hints (build.gradle.kts/pom.xml), Idioms, Anti-patterns (!!, platform types), Reviewer Checklist, Typical Bugs (smart-cast), Tooling (gradle/detekt).
- [ ] Создать `extensions/fan-orchestrator/review-rules/rust.md`: Stack Detection Hints (Cargo.toml), Idioms, Anti-patterns (unwrap вне тестов, clone для borrow-checker), Reviewer Checklist, Typical Bugs (overflow), Tooling (cargo clippy/fmt).
- [ ] Создать `extensions/fan-orchestrator/review-rules/README.md` — индекс, loading order: common → stack → conventions.

### Этап 2 — Агент
- [ ] Создать `extensions/fan-orchestrator/agents/code-review.js` (type "code-review", label "Code Reviewer", icon 🔎, readOnly: true, tools [read, bash, grep, find, ls], description/useFor с разграничением от verify и security).
- [ ] Создать `extensions/fan-orchestrator/agents/code-review.md` (~150-200 строк, паттерн verify.md): ROLE REVIEWER → ROLE BOUNDARY → CRITICAL RULES → STEP 0-3 → REVIEW CHECKLIST → COMMON MISTAKES → MANDATORY OUTPUT FORMAT.

### Этап 3 — Интеграция
- [ ] `agents/index.js`: import + AGENT_REGISTRY.
- [ ] `broker-handler.js`: PROFILES_BY_AGENT["code-review"]="read-only" (+security: "read-only" добить).
- [ ] `orchestrator-tools.js`: CODE_REVIEW_KEYWORDS regex + правило №2 в classifyTaskByDescription + сузить verify-regex (убрать review|security) + AGENT_ICONS + delegate_task description + promptSnippet + classify_task description.
- [ ] `orchestrator-tools.js`: REVIEW_RULES_DIR + enrichWorkerContext(agent, context) + обернуть 3 mergeContext (355/538/616).
- [ ] `config.example.json` + `config.js`: model "" ×2, temperature 0.2, timeout 900.
- [ ] `orchestrator-extension.js`: agentIcons ×2, WORKER_PROFILES {reasoning:1, context:6, cost:3, maxTokens:0.3}, ASSIGNMENT_ORDER + "code-review".
- [ ] `agents.js` + `agents.d.ts`: parseVerdict 6 вердиктов; buildCoordinatorPrompt routing rules (code-review для diff/PR; NEVER для build-verify; security-note → delegate security) + workflow шаг 7 вердикты + статический COORDINATOR_PROMPT таблица + шаг 8; перегенерировать .d.ts.
- [ ] `DEPLOY.toml`: include review-rules/*.md, review-adapters.d.ts, review-adapters.md.

### Этап 4 — Платформенный contract (типы, 0 рантайма)
- [ ] Создать `extensions/fan-orchestrator/review-adapters.d.ts`: ReviewSeverity, ReviewVerdict, PlatformRef, DiffRequest, DiffResult, ReviewComment, ReviewResolution, PlatformReviewAdapter.
- [ ] Создать `extensions/fan-orchestrator/review-adapters.md`: семантика ошибок (network → retry, auth → явная ошибка); модель (новые extension регистрируют реализацию, orchestrator platform-agnostic); прецедент fan-confluence/client.ts.

### Этап 5 — Тесты
- [ ] `test/agents-security-routing.test.mjs`: "review this PR" → code-review (осознанная миграция).
- [ ] `test/agents-code-review-definition.test.mjs`: definition контракт (readOnly, tools, иконка) + .md парсинг + маркеры промпта (ROLE, DIFF-ONLY, RULES_DIR, conventions, манифесты всех 4 стеков, severity, 3 вердикта, security-note, heredoc-исключение).
- [ ] `test/agents-code-review-routing.test.mjs`: positive (code review of X, review this PR, review the diff, LGTM, ревью диффа, branch changes, commit review) + negative guards (verify the build → verify, check for vulnerabilities → security, review the new feature design → verify, run tests → verify, пустая → implement).
- [ ] `test/agents-code-review-integration.test.mjs`: PROFILES_BY_AGENT контракт, parseVerdict 6 вердиктов + null + case, наличие/непустота файлов правил + adapters + DEPLOY include, инъекция RULES_DIR (мок runSingleAgent → delegate_task; или прямой тест экспортируемой enrichWorkerContext), orchestrator-extension контракты (icons ×2, profiles, order).
- [ ] Прогнать `agents-consistency.test.mjs` — ожидаемо без правок.

### Этап 6 — Доки
- [ ] `extensions/fan-orchestrator/README.md` (воркеров 9→10, таблица, read-only список, config-примеры, секция Code Review Worker).
- [ ] `docs/guides/orchestrator.md`.

### Ветка и критерий готовности
- **Ветка**: `FAN/feature/code-review-worker`.
- **Критерий готовности**: `cd extensions/fan-orchestrator && npx vitest run` — зелёный (все новые + существующие тесты).
- **Дополнительные success criteria** (из плана):
  1. `getAgentTypes()` содержит `code-review`.
  2. `classify_task`: "code review of this PR" → code-review; "verify the build" → verify; security-фразы → security.
  3. `parseVerdict` — 6 вердиктов; оба coordinator-промпта описывают новые вердикты.
  4. `delegate_task(code-review)` во всех 3 режимах несёт `CODE_REVIEW_RULES_DIR=<существующий путь>`.
  5. DEPLOY.toml включает правила; файлы существуют и непусты.
  6. E2E-смоук: "проведи code review последних изменений" → воркер запускается, читает правила, создаёт conventions.md при первом прогоне, возвращает Findings + VERDICT.

---

*Создано: research-spec-generator skill*
*Исходный запрос: добавить в оркестратор новый воркер для проведения код ревью: 1) донастройки из текущего проекта — кодстайл, подходы, архитектура; 2) понимание текущего стека, подтягивание правил под стек, дефолтное хранение общих практик по стекам; 3) встраивание в систему оркестрации + внешние код ревью репозиториев; 4) на будущее расширение через расширения под платформы (гитхаб, битбакет и т.п.)*