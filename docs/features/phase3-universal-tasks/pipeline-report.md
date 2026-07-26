# Pipeline Report: Фаза 3 — Универсальные задачи и шаблоны workspaces

> **Дата старта:** 2026-07-26
> **Дата завершения:** 2026-07-26
> **Ветка:** FAN-007-REMOTE-ACCESS
> **Стратегия коммитов:** per-function (conventional)
> **Roadmap:** docs/features/phase3-universal-tasks/roadmap.md

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего функций | 12 |
| Реализовано (✅) | 12 |
| Провалено (❌) | 0 |
| Коммитов | 12 (`f29eb35..a1bbbd4`) |

## Функции

| Функция | Статус | Коммит | Тесты | Попыток |
|---------|--------|--------|-------|---------|
| F-3.1 типы в projects.json | ✅ | `56f2cb5` | unit (coding-agent) | 1 |
| F-3.2 автодетекция | ✅ | `9e94a0a` | unit (detector) | 1 |
| F-3.3 шаблон code | ✅ | `2779c25` | unit (workspace-templates) | 1 |
| F-3.4 шаблоны research/automation | ✅ | `184b667` | unit (workspace-templates) | 1 |
| F-3.5 POST /api/projects | ✅ | `2d1dadb` | api-gateway http-server.test | 1 |
| F-3.6 prompt override | ✅ | `98348c5` | unit (prompt-loader) | 1 |
| F-3.7 иконки типов | ✅ | `a2537dc` | dashboard (project-switcher) | 1 |
| F-3.8 диалог создания | ✅ | `494c4a0` | dashboard (create-project-dialog) | 1 |
| F-3.9 slash autocomplete | ✅ | `14fe0ec` | dashboard (chat-view-slash) | 1 |
| F-3.10 смена типа | ✅ | `4bdf45c` | api-gateway http-server.test | 1 |
| F-3.11-E2E research цикл | ✅ | `da2f772` | e2e-local.sh секция 10 | 1 |
| F-3.12-E2E 3 типа | ✅ | `2c76b0f` | e2e-local.sh секция 11 | 1 |
| Fix: 3 находки верификации | ✅ | `a1bbbd4` | api-gateway +5, coding-agent +1 | 1 |

## Детали реализации

### F-3.1 — Типы workspaces в projects.json (`56f2cb5`)

Поле `type: "code" | "research" | "automation" | "unknown"` в реестре
`~/.fan/agent/projects.json` (`packages/coding-agent/src/core/project-registry.ts`,
экспорт `PROJECT_TYPES`). `normalizeEntry()` даёт fallback `"unknown"` для
legacy-записей без типа — миграция не требуется, схема аддитивна.

### F-3.2 — Автодетекция типа (`9e94a0a`)

`detectWorkspaceType(cwd)` в `packages/coding-agent/src/workspace/detector.ts`.
Приоритет `code > research > automation > unknown`:

- `code`: `.git` (директория или gitfile — worktrees/submodules) + (`src/`
  или `package.json`)
- `research`: `docs/research/` или `.fan/prompts/`
- `automation`: скрипты (`*.sh`/`*.py` в корне или `scripts/`, один уровень)
  **и** конфиг (`config/` директория или корневые `*.yaml`/`*.yml`/`*.toml`/
  `*.ini`/`*.cfg`; `*.json` намеренно исключён — иначе non-git JS проекты
  классифицировались бы как automation)
- Никогда не бросает исключений: отсутствующие директории, permission
  errors, fs races → graceful fallthrough в `"unknown"`

### F-3.3 — Шаблон Code Project (`2779c25`)

`packages/coding-agent/src/workspace/templates/`: `types.ts`
(`WorkspaceTemplate`, `TemplateFile`, `ApplyTemplateResult`),
`apply-template.ts` (реестр + `applyTemplate`/`getTemplate`/`listTemplates`/
`registerTemplate`), `code-project.ts`: директории `.fan/`, `src/`,
`tests/`, `docs/`; файлы `.fan/settings.json`, `package.json`. Существующие
файлы не перезаписываются.

### F-3.4 — Шаблоны Research Lab и Automation Hub (`184b667`)

`research-lab.ts`: `.fan/prompts/`, `docs/research/`, `data/`, `reports/`,
`.fan/settings.json`. `automation-hub.ts`: `scripts/`, `config/`, `output/`,
`logs/`, `.fan/settings.json`, `scripts/example.sh`. `index.ts` — barrel +
`createProject(template, name, rootPath)`: apply → detect → metadata.
Documented decision: `createProject()` НЕ пишет в реестр — registry writes
на стороне API-слоя (F-3.5). Documented fallback: code-шаблон не создаёт
`.git` → детекция дала бы `unknown`, поэтому при `unknown` типом становится
имя шаблона (если валидный ProjectType).

### F-3.5 — POST /api/projects (`2d1dadb`)

`packages/api-gateway/src/http-server.ts` + adapter `createProject` в
`packages/coding-agent/src/main.ts`. Контракт:

- Body `{ name, template?, rootPath? }`; `name` — обязательный, единственный
  сегмент пути (без `/`, `\`, `..`, `.`); не может резолвиться в корень
  whitelist (defense-in-depth)
- `rootPath` default = workspace root (`FAN_WORKSPACE_ROOT` → `~/projects`)
- Whitelist-валидация (F-1.13) **до** обращения к fs → 403
- Unknown template → 400 до любой fs-записи (`Unknown template: <name>`)
- 201 при создании, 200 при уже зарегистрированном path (идемпотентный
  dedup по path); тело `{ path, name, type, template? }`
- 501 если адаптер не реализует `createProject`

### F-3.6 — System prompt override (`98348c5`)

`packages/coding-agent/src/workspace/prompt-loader.ts`:
`BASE_SYSTEM_PROMPTS` для code/research/automation + generic
`DEFAULT_SYSTEM_PROMPT` для unknown; override `<cwd>/.fan/prompts/system.md`
заменяет шаблон целиком (пустой/whitespace-only файл = нет override —
защита от случайного пустого промпта); переменные `{workspace_path}`
(forward slashes) и `{project_name}` (basename) подставляются в оба
источника. Никогда не бросает исключений. **STANDALONE** — интеграция в
runtime (`AgentSession._rebuildSystemPrompt()` / `ResourceLoader`
systemPromptOverride hook) задокументирована как future phase.

### F-3.7 — Иконки типов в dashboard (`a2537dc`)

`packages/dashboard/src/lib/workspace-type.ts`: маппинг type → Lucide
иконка + CSS-класс (`code` → CodeXml, `research` → FlaskConical,
`automation` → Cog, `unknown` → CircleQuestionMark), `normalizeWorkspaceType`
fallback в unknown, `normalizeProjectPath` для cwd↔path matching. Иконки в
`project-switcher.ts` (per-project) и на группах cwd в session tree.

### F-3.8 — Диалог создания проекта (`494c4a0`)

`packages/dashboard/src/components/create-project-dialog.ts`:
`<fan-create-project-dialog>` — имя (client-side отказ path-traversal),
radio-группа шаблонов (Code/Research/Automation/Empty Folder — «Empty» =
без поля `template`), опциональный `rootPath` (пусто = server default).
Submit → `POST /api/projects`; success → событие `project-created`
(bubbles + composed), re-fetch списка, переход на новый проект; ошибки
400/403 показываются inline, диалог остаётся открытым. Кнопка «+» в
project-switcher заменена на открытие диалога (событие `project-create`).

### F-3.9 — Slash command autocomplete (`14fe0ec`)

`packages/dashboard/src/lib/slash-commands.ts` + `chat-view.ts`: dropdown
по вводу `/`. Статический список 8 предустановленных скиллов как
`/skill:<name>` — documented decision: `/api/commands` endpoint не
существует; `/skill:<name> <args>` — единственный slash-синтаксис,
работающий через server path (expand в SKILL.md через
`_expandSkillCommand`); TUI-команды (`/model`, `/compact`) через server
path не работают и намеренно не показаны. Порядок команд — по типу
проекта (research → idea-lab/research-spec-generator/deep-dive и т.д.).
Навигация ↑/↓, Enter/Tab — вставка, Esc — dismiss; фильтрация по вводу.

### F-3.10 — Ручная смена типа (`4bdf45c`)

`PUT /api/projects?path= { type }` в http-server.ts (200 с обновлённой
записью / 400 невалидный type или пустой path / 404 не зарегистрирован /
501 нет `updateProject`; registry-only — сессии и файлы не трогаются) +
inline type picker в project-switcher (событие `project-update-type`,
иконка обновляется после re-fetch).

### F-3.11-E2E — Research workspace, полный цикл (`da2f772`)

Секция 10 в `deploy/scripts/e2e-local.sh`: unknown template → 400 до
fs-записи; `POST /api/projects` (template=research) → 201 + auto-detected
type=research; структура шаблона на диске в контейнере; запись в реестре;
`loadSystemPrompt` из реального dist в контейнере (default + override);
round-trip ручной смены типа (F-3.10); идемпотентный re-POST → 200.
LLM-шаги TC-F-3.11-E2E-1 (5–8) и TC-F-3.11-E2E-2 — **manual чеклист** в
шапке секции (в контейнере нет API-ключей — та же граница, что в секции 9).

### F-3.12-E2E — Жизненный цикл 3 типов (`2c76b0f`)

Секция 11 в `deploy/scripts/e2e-local.sh` (38 проверок): создание трёх
проектов (code/research/automation), структуры на диске, типы в реестре,
изоляция `?project=`, возврат к проекту; 11.8 — `loadSystemPrompt` для
каждого из трёх типов (code-проект получает симулированный `git init`,
т.к. шаблон намеренно не создаёт `.git`). LLM-шаги 4–6 — manual чеклист.
Итого скрипт: **76 проверок, PASS=76 FAIL=0 ×2 прогона, идемпотентно**.

## Верификация — находки и фиксы (`a1bbbd4`)

| # | Находка | Фикс |
|---|---------|------|
| 1 | **Biome strict gate сломан** — нарушения `useImportType` + форматирование после фич фазы 3 | `biome --write` — 666 файлов чисто, gate восстановлен |
| 2 | **`POST /api/projects` принимал `name: "."` / `".."`** — резолвилось в корень whitelist | 400 для `.`/`..`/dot-only имён + defense `resolve(root, name) != root`; тесты +5 (api-gateway 168) |
| 3 | **Shell-инъекция в automation-hub `example.sh`** — `projectName` подставлялся без экранирования | `shellQuote(projectName)`; тест +1 (coding-agent 1274) |

Итоговые тесты: **api-gateway 168, coding-agent 1274, dashboard 93,
e2e 76/76.**

## Backlog (следующие фазы)

- **ServiceRegistry / McpSwitcher / prompt-loader — standalone-модули:**
  интеграция в runtime (`AgentSession._rebuildSystemPrompt()`,
  `ResourceLoader`, invalidation кеша при смене типа) — будущая фаза
- **`.git` нюанс code-шаблона:** шаблон намеренно не создаёт `.git`;
  детекция дала бы `unknown` → fallback на имя шаблона (documented
  decision, см. F-3.3/F-3.4)
- **LLM-зависимые E2E-шаги** (idea-lab, research-spec-generator) — manual
  чеклисты; автоматизация возможна только в окружении с настроенной
  моделью
- **Скиллы в контейнере:** runtime-образ не содержит `skills/` (только
  package.json + dist); скиллы резолвятся из `/data/.fan/agent/skills`
  (fan-data volume) через `fan store install` — задокументировано в шапке
  секции 10

*Финализировано: docs-impl agent · 2026-07-26*
