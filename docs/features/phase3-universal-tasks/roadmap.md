# Roadmap: Фаза 3 — Универсальные задачи и шаблоны workspaces

> **Дата создания:** 2026-07-25
> **Источник:** [spec_fan-network-agent_phase3-universal-tasks_2026-07-25.md](../../specs/spec_fan-network-agent_phase3-universal-tasks_2026-07-25.md) · [родительская spec](../../specs/spec_fan-network-agent_2026-07-25.md)
> **Фич:** 12 | **Этапов:** 4 | **E2E-сценариев:** 1

---

## Сводная таблица по приоритетам

| Приоритет | Кол-во фич | Описание |
|-----------|-----------|----------|
| P0 (Must) | 8 | Типы workspaces, автодетекция, шаблоны, endpoint создания, prompt templates, E2E research, code template, dashboard icons |
| P1 (Should) | 2 | Slash command autocomplete, custom system prompt override |
| P2 (Could) | 1 | Manual type change via UI |
| P3 (Won't Have) | 1 | Workspace analytics |

---

## Легенда

| Маркер | Значение |
|--------|---------|
| ☐ | Не начато |
| ✅ | Готово |
| ⏳ | В работе |
| ❌ | Отклонено |

| Приоритет | MoSCoW | Оценка |
|-----------|--------|--------|
| P0 | Must Have | Критично для не-код сценариев |
| P1 | Should Have | Желательно до релиза фазы 3 |
| P2 | Could Have | Можно отложить |
| P3 | Won't Have | Отклонено для текущей фазы |

### Слои реализации

| Слой | Описание |
|------|----------|
| [API] | Изменения HTTP API (project creation endpoint, type dispatch) |
| [UI] | Lit компоненты dashboard (icons, form, slash commands) |
| [DATA] | Шаблонные структуры директорий, prompt templates |
| [BIZ] | Автодетекция типа workspace, бизнес-логика определения |
| [INTEG] | Интеграция skills (idea-lab, repo-explorer, research-spec-generator) |
| [E2E] | Комплексные сквозные сценарии |

---

## Этап 3.1 — DATA: Шаблоны директоровий + автодетекция типов

**Цель SMART:** Определить 4 типа workspaces (code/research/automation/unknown), реализовать автодетекцию по структуре директории в `~/.fan/agent/projects.json` (добавление поля `type`). Создать три шаблонных структуры (Code Project, Research Lab, Automation Hub) в `packages/coding-agent/src/workspace/templates/`. Детекция работает при регистрации нового проекта или при сканировании реестра проектов. Покрытие: 95% сценариев из spec (раздел 2.1).

### Фичи

#### ☐ F-3.1: Определение типов workspaces в projects.json

- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Обновление схемы `~/.fan/agent/projects.json`: добавить поле `type` со значениями `'code' | 'research' | 'automation' | 'unknown'`. Каждый тип имеет критерий определения (из spec раздел 2.1):
  - `code`: наличие `.git` + (`src/` или `package.json`)
  - `research`: наличие `docs/research/` или `.fan/prompts/`
  - `automation`: наличие `*.sh`, `*.py` скриптов + config файлов
  - `unknown`: ни один критерий не совпал
  Schema update в Prisma (если projects хранятся там) + backward compatibility migration (default 'unknown').
- **Зависимости:** Phase 1 (projects.json format из spec parent, раздел 3 «Модель данных»)
- **TDD-тесты:**
  - [ ] **TC-F-3.1-1:** Type field exists in project record
    - *Условие:* Projects schema updated with `type` field
    - *Шаги:* Query projects from DB/file
    - *Ожидаемый результат:* Каждый entry содержит string `type`; default = 'unknown' if not set
  - [ ] **TC-F-3.1-2:** Unknown type assigned by default to new entries
    - *Условие:* Новый проект в реестре без указания type
    - *Шаги:* Записать в registry; прочитать
    - *Ожидаемый результат:* type = 'unknown'
- **Критерии приёмки:**
  1. projects.json schema поддерживает поле `type: string`
  2. Старые записи без `type` получают fallback `'unknown'`
  3. Все четыре значения enum доступны: code, research, automation, unknown
- **Ожидаемый результат:** Обновлённая схема projects.json + migration (если Prisma)
- **Оценка объёма:** S

#### ☐ F-3.2: Автодетекция типа по структуре директории

- **Приоритет:** P0
- **Слой:** [BIZ]
- **Описание:** Функция `detectWorkspaceType(cwd: string): WorkspaceType` в `packages/coding-agent/src/workspace/detector.ts`. Логика проверки паттернов из spec (раздел 2.1):
  ```
  function detect(cwd):
    hasGit = exists(path.join(cwd, '.git'))
    hasSrc = exists(path.join(cwd, 'src')) || exists(path.join(cwd, 'package.json'))
    hasResearch = exists(path.join(cwd, 'docs', 'research')) || exists(path.join(cwd, '.fan', 'prompts'))
    hasScripts = glob('*.sh', '*.py') in cwd
    
    if hasGit && hasSrc → return 'code'
    if hasResearch → return 'research'
    if hasScripts → return 'automation'
    return 'unknown'
  ```
  Вызывается при регистрации нового проекта (`POST /api/projects`) и при фоновом сканировании реестра.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-3.2-1:** Code project detected correctly
    - *Условие:* tmp dir с .git/ и src/
    - *Шаги:* detectWorkspaceType(tmpDir)
    - *Ожидаемый результат:* Возвращает 'code'
  - [ ] **TC-F-3.2-2:** Research project detected correctly
    - *Условие:* tmp dir с docs/research/
    - *Шаги:* detectWorkspaceType(tmpDir)
    - *Ожидаемый результат:* Возвращает 'research'
  - [ ] **TC-F-3.2-3:** Unknown type for empty directory
    - *Условие:* Пустой tmp dir
    - *Шаги:* detectWorkspaceType(tmpDir)
    - *Ожидаемый результат:* Возвращает 'unknown'
- **Критерии приёмки:**
  1. Функция проверяет все три паттерна согласно spec
  2. Priority order: code > research > automation > unknown
  3. Graceful handling: missing directories don't throw errors
- **Ожидаемый результат:** `packages/coding-agent/src/workspace/detector.ts` + unit tests
- **Оценка объёма:** S

#### ☐ F-3.3: Шаблон «Code Project» — структура директорий

- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Шаблоны в `packages/coding-agent/src/workspace/templates/`: файл `code-project.json` (или JS module export) определяет структуру:
  ```
  my-project/
  ├── .fan/settings.json    # пустой объект {} или defaults
  ├── src/                  # пустая директория
  ├── tests/                # пустая директория
  ├── docs/                 # пустая директория
  └── package.json          # шаблонный минимальный JSON
  ```
  Создаётся при регистрации проекта с `template: 'code'`. `fs.mkdirSync` рекурсивно. Пустые директории создаются для immediate usability.
- **Зависимости:** (none)
- **TDD-тесты:**
  - [ ] **TC-F-3.3-1:** Template creates expected directory structure
    - *Условие:* targetDir не существует
    - *Шаги:* applyTemplate('code', targetDir)
    - *Ожидаемый результат:* .fan/settings.json, src/, tests/, docs/, package.json созданы
  - [ ] **TC-F-3.3-2:** Existing files are not overwritten
    - *Условие:* targetDir уже имеет существующую src/ с файлом
    - *Шаги:* applyTemplate('code', targetDir)
    - *Ожидаемый результат:* Существующий файл сохранён; новые директории созданы
- **Критерии приёмки:**
  1. Шаблон создаёт полную иерархию из spec (раздел 2.2)
  2. `.fan/settings.json` создаётся с дефолтным содержимым
  3. Не перезаписывает существующие файлы
- **Ожидаемый результат:** `packages/coding-agent/src/workspace/templates/code-project.ts`
- **Оценка объёма:** S

#### ☐ F-3.4: Шаблоны «Research Lab» и «Automation Hub»

- **Приоритет:** P0
- **Слой:** [DATA]
- **Описание:** Аналогично F-3.3, два дополнительных шаблона:
  **Research Lab:** `.fan/prompts/`, `.fan/settings.json`, `docs/research/`, `data/`, `reports/`.
  **Automation Hub:** `.fan/settings.json`, `scripts/`, `config/`, `output/`, `logs/`.
  Модули: `research-lab.ts`, `automation-hub.ts` в том же каталоге. Экспорт через `templates/index.ts`. Обёртка `createProject(template, name, rootPath)` объединяет логику.
- **Зависимости:** F-3.3 (паттерн template application)
- **TDD-тесты:**
  - [ ] **TC-F-3.4-1:** Research template creates correct structure
    - *Условие:* targetDir не существует
    - *Шаги:* applyTemplate('research', targetDir)
    - *Ожидаемый результат:* .fan/prompts/, .fan/settings.json, docs/research/, data/, reports/ созданы
  - [ ] **TC-F-3.4-2:** Automation template creates correct structure
    - *Условие:* targetDir не существует
    - *Шаги:* applyTemplate('automation', targetDir)
    - *Ожидаемый результат:* .fan/settings.json, scripts/, config/, output/, logs/ созданы
- **Критерии приёмки:**
  1. Оба шаблона создают правильную иерархию согласно spec
  2. Index export позволяет импортировать по имени ('code'|'research'|'automation')
  3. createProject() orchestrates template + type detection + registry update
- **Ожидаемый результат:** `packages/coding-agent/src/workspace/templates/research-lab.ts`, `automation-hub.ts`, `index.ts`
- **Оценка объёма:** S

---

## Этап 3.2 — API: Endpoint создания из шаблона

**Цель SMART:** Добавить `POST /api/projects` endpoint (или дополнить существующий из фазы 1) с поддержкой параметра `template`. Тело запроса: `{ "name": "...", "template": "code"|"research"|"automation", "rootPath": "/path/" }`. Сервер применяет шаблон, детектирует тип, обновляет projects.json, возвращает metadata созданного проекта.

### Фичи

#### ☐ F-3.5: POST /api/projects — создание из шаблона

- **Приоритет:** P0
- **Слой:** [API]
- **Описание:** Endpoint в api-gateway router: `POST /api/projects`. Принимает body с полями `name`, `template`, `rootPath` (optional, default `~/projects`). Последовательность: 1) resolve full path (`rootPath + name`), 2) apply template via `templates/index.ts`, 3) auto-detect type via `detectWorkspaceType()`, 4) add to registry (projects.json), 5) return metadata `{ path, name, type, template }`. Template validation: reject unknown template names with 400 Bad Request. Auth required (token-based). Path whitelist validation (phase 1) applies here too.
- **Зависимости:** F-3.1..F-3.4 (schema, detector, templates), phase 1 project registry
- **TDD-тесты:**
  - [ ] **TC-F-3.5-1:** Valid template creates project and returns metadata
    - *Условие:* POST /api/projects с { name:'test', template:'code', rootPath:'/tmp' }, valid auth token
    - *Шаги:* Send request; check response and filesystem
    - *Ожидаемый результат:* Response { path: '/tmp/test', name: 'test', type: 'code', template: 'code' }; directory structure created
  - [ ] **TC-F-3.5-2:** Invalid template returns 400
    - *Условие:* POST /api/projects с { template:'nonexistent' }
    - *Шаги:* Send request
    - *Ожидаемый результат:* HTTP 400; body { error: 'Unknown template: nonexistent' }
  - [ ] **TC-F-3.5-3:** Auto-detected type matches actual content
    - *Условие:* Template 'research' applied to new dir
    - *Шаги:* POST → check returned type
    - *Ожидаемый результат:* type = 'research' (because docs/research/ was created by template)
- **Критерии приёмки:**
  1. Endpoint принимает optional параметр `template`
  2. Шаблон применяется автоматически при создании проекта
  3. Возвращаемый metadata включает resolved path, name, type
- **Ожидаемый результат:** Обновлённый api-gateway router handler
- **Оценка объёма:** M

#### ⏳ F-3.6: Custom system prompt override (.fan/prompts/)

- **Приоритет:** P1
- **Слой:** [DATA]
- **Описание:** Механизм пользовательских промптов в `<cwd>/.fan/prompts/`. Базовые системные промпты для каждого типа (из spec раздел 2.4):
  - Code: coding assistant role
  - Research: research assistant role  
  - Automation: automation assistant role
  Пользователь может переопределить через `<cwd>/.fan/prompts/system.md`. Система загружает базовый шаблон → проверяет наличие custom override → merge: custom > template default. Prompt переменные: `{workspace_path}`, `{project_name}`.
- **Зависимости:** F-3.4 (templates exist), фаза 2 settings-manager
- **TDD-тесты:**
  - [ ] **TC-F-3.6-1:** Default prompt loaded for known type
    - *Условие:* code workspace, no custom .fan/prompts/system.md
    - *Шаги:* loadSystemPrompt('/myproj')
    - *Ожидаемый результат:* Возвращает code template prompt с подставленным {workspace_path}
  - [ ] **TC-F-3.6-2:** Custom override replaces default
    - *Условие:* custom .fan/prompts/system.md exists
    - *Шаги:* loadSystemPrompt('/myproj')
    - *Ожидаемый результат:* Custom content returned, not template default
- **Критерии приёмки:**
  1. Базовые промпты определены для code/research/automation типов
  2. Переменные `{workspace_path}`, `{project_name}` заменяются на актуальные значения
  3. Custom .fan/prompts/system.md переопределяет шаблон целиком
- **Ожидаемый результат:** `packages/coding-agent/src/workspace/prompt-loader.ts`
- **Оценка объёма:** M

---

## Этап 3.3 — Frontend: Dashboard integration

**Цель SMART:** Обновить dashboard для визуализации типов workspaces: иконки в sidebar, форма создания проекта с выбором шаблона, интеграция slash commands в chat input. Иконки соответствуют spec: 💻 code, 🔬 research, ⚙️ automation, ❓ unknown. Форма создания — модальное окно с radio buttons для выбора шаблона.

### Фичи

#### ☐ F-3.7: Dashboard icons для типов workspace

- **Приоритет:** P0
- **Слой:** [UI]
- **Описание:** В `packages/dashboard/src/components/project-switcher.ts` (обновление): каждый проект отображается с иконкой типа. CSS классы: `.type-code` (💻), `.type-research` (🔬), `.type-automation` (⚙️), `.type-unknown` (❓). Icon рендерится как SVG Lucide или unicode emoji перед именем проекта. Иконка берётся из `project.type` в данных API. Обновлённый tree view session list тоже показывает иконки проектов.
- **Зависимости:** F-3.1 (type field in projects.json), F-2.6 (project switcher component)
- **TDD-тесты:**
  - [ ] **TC-F-3.7-1:** Icon rendered based on type
    - *Условие:* project={name:'Alpha', type:'research'}
    - *Шаги:* Render project item in switcher
    - *Ожидаемый результат:* 🔬 icon displayed before 'Alpha'; class='type-research'
  - [ ] **TC-F-3.7-2:** Unknown type shows question mark
    - *Условие:* project={name:'Beta', type:'unknown'}
    - *Шаги:* Render project item
    - *Ожидаемый результат:* ❓ icon displayed
- **Критерии приёмки:**
  1. Все четыре типа имеют соответствующие иконки (unicode/Lucide)
  2. Иконка берётся из project.type и рендерится корректно
  3. Tree view в session-list также отображает иконки групп проектов
- **Ожидаемый результат:** Обновлённый `project-switcher.ts` + CSS стили
- **Оценка объёма:** S

#### ⏳ F-3.8: Форма создания проекта с выбором шаблона

- **Приоритет:** P0
- **Слой:** [UI]
- **Описание:** Modal/dialog компонент `<fan-create-project-dialog>` в `packages/dashboard/src/components/create-project-dialog.ts`. Содержимое из spec (раздел 4.2): название проекта, radio-кнопки шаблонов (Код-проект / Исследование / Автоматизация / Пустая папка), поле расположения (path input). Данные отправляются через `POST /api/projects` с полем `template`. Validation: name required, template selected, path valid. После успешного создания — обновить список проектов (re-fetch GET /api/projects), закрыть диалог.
- **Зависимости:** F-3.5 (POST /api/projects endpoint), F-3.3..F-3.4 (templates available)
- **TDD-тесты:**
  - [ ] **TC-F-3.8-1:** Dialog renders all template options
    - *Условие:* Component mounted
    - *Шаги:* Проверить shadow DOM на наличие radio-кнопок шаблонов
    - *Ожидаемый результат:* 4 radio options visible: Code, Research, Automation, Empty folder
  - [ ] **TC-F-3.8-2:** Create button sends correct payload
    - *Условие:* Form filled: name='MyProj', template='research', root='/tmp'
    - *Шаги:* Click Create
    - *Ожидаемый результат:* POST /api/projects отправлен с корректным body; диалог закрывается при успехе
- **Критерии приёмки:**
  1. Диалог имеет все элементы формы из spec дизайна
  2. Payload включает name, template, rootPath
  3. Success → refresh project list; error → show error message
- **Ожидаемый результат:** `packages/dashboard/src/components/create-project-dialog.ts`
- **Оценка объёма:** M

#### ⏰ F-3.9: Slash command autocomplete в чате

- **Приоритет:** P1
- **Слой:** [UI]
- **Описание:** В поле ввода чата (`chat-input.ts`) добавить autocomplete dropdown при вводе `/`. Команды загружаются из активных скиллов в текущем проекте. Для research workspace: `/idea-lab:*` и `/research-spec:*`. Для code workspace: стандартные команды (bash-related). Dropdown показывается при вводе символа `/`, фильтруется по введённому тексту, выбирается Enter. Референс: spec раздел 4.3 «Быстрые команды». Интеграция с existing skill registry from phase 1–2.
- **Зависимости:** F-2.8 (API client), существующий skill registry
- **TDD-тесты:**
  - [ ] **TC-F-3.9-1:** Autocomplete dropdown appears on '/' input
    - *Условие:* Chat input focused, typing '/'
    - *Шаги:* Observe DOM
    - *Ожидаемый результат:* Dropdown visible with available slash commands for current project type
  - [ ] **TC-F-3.9-2:** Selected command inserts into input
    - *Условие:* Dropdown open, commands ['idea-lab:analyze', 'research-spec:generate']
    - *Шаги:* Select first command
    - *Ожидаемый результат:* Input text = '/idea-lab:analyze '; cursor after space
- **Критерии приёмки:**
  1. Autocomplete вызывается при вводе '/' в чат
  2. Список команд соответствует активным скиллам проекта
  3. Выбор команды вставляет текст в input
- **Ожидаемый результат:** Обновлённый `chat-input.ts`
- **Оценка объёма:** M

#### ⏰ F-3.10: Ручная смена типа проекта через API/UI

- **Приоритет:** P2
- **Слой:** [API]
- **Описание:** Дополнение endpoint: `PUT /api/projects/:path` с телом `{ type: 'code'|'research'|'automation' }`. Обновляет type в projects.json. UI: контекстное меню проекта в sidebar (правый клик) → «Изменить тип» → dropdown для выбора. Используется когда автодетекция ошиблась (risk: medium probability per spec section 5). Invalidation ServiceRegistry cache после обновления type (раздел 2.1 spec).
- **Зависимости:** F-3.1 (type field), F-2.1 (ServiceRegistry invalidation)
- **TDD-тесты:**
  - [ ] **TC-F-3.10-1:** PUT updates type in registry
    - *Условие:* Project type='unknown'
    - *Шаги:* PUT /api/projects/{path} { type: 'research' }
    - *Ожидаемый результат:* projects.json updated; type='research'; GET returns new type
- **Критерии приёмки:**
  1. PUT /api/projects/:path принимает type parameter
  2. Type обновляется в registry file
  3. UI показывает обновлённую иконку после изменения
- **Ожидаемый результат:** Обновлённый api-gateway handler + context menu in project-switcher
- **Оценка объёма:** M

---

## Этап 3.4 — E2E сценарии и финализация

**Цель SMART:** Выполнить два комплексных E2E сценария, проверяющих всю цепочку: создание workspace → запуск не-код задачи → сохранение результата. Первый: non-git research workspace + idea-lab scenario. Второй: multi-template project lifecycle (create → run → verify).

### Фичи

#### ⏳ F-3.11-E2E: Исследовательский workspace — полный цикл

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Сквозной сценарий создания не-git workspace для ресёрча, запуска idea-lab сценария, сохранения документа. Проверяет весь стек: template creation → type detection → skill integration → document generation. Выполнимо вручную через Web UI или скриптом.
- **Зависимости:** F-3.1..F-3.9 (все core features)
- **TDD-тесты:**
  - [ ] **TC-F-3.11-E2E-1:** Non-git workspace creation + idea-lab execution
    - *Условие:* FAN Network Agent running, dashboard connected, no pre-existing research workspace
    - *Шаги:*
      1. Нажать «+ Новый проект» → выбрать шаблон «Research Lab» → имя `market-analysis-q3`
      2. Убедиться: создана структура `market-analysis-q3/` с `.fan/`, `docs/research/`, `data/`, `reports/`
      3. Убедиться: проект тип='research' (автодетекция по docs/research/)
      4. Проект появился в sidebar с иконкой 🔬
      5. В чат написать: `/idea-lab:analyze "AI-powered code review tool"`
      6. Дождаться завершения idea-lab
      7. Проверить: файл `docs/research/swot-ai-code-review.md` создан
      8. Проверить: документ содержит SWOT секции (Strengths, Weaknesses, Opportunities, Threats)
    - *Ожидаемый результат:* Документ спецификации полностью сгенерирован, сохранён в правильной директории, доступен в файловой системе проекта
  - [ ] **TC-F-3.11-E2E-2:** Research spec generator workflow
    - *Условие:* Исследовательский workspace active, research-spec-generator skill installed
    - *Шаги:*
      1. В чат: `/research-spec:generate "Distributed task queue architecture"`
      2. Подождать завершения
      3. Проверить путь сохранения документа
      4. Открыть документ: проверить наличие TOC, секций архитектуры, сравнения подходов
    - *Ожидаемый результат:* Полная markdown-спецификация в указанной директории, contains expected sections
- **Критерии приёмки:**
  1. Исследовательский workspace создан автоматически с правильной структурой директорий
  2. idea-lab и research-spec-generator работают в не-git workspace
  3. Результаты сохраняются в ожидаемые директории (`docs/research/`, `reports/`)
  4. Документы содержат релевантное содержимое (не пустые файлы)
- **Ожидаемый результат:** Ручной тест через Web UI или automation script; документы в workspace подтверждают успешность
- **Оценка объёма:** M

#### ⏳ F-3.12-E2E: Многошаговый жизненный цикл проектов разных типов

- **Приоритет:** P0
- **Слой:** [E2E]
- **Описание:** Создание трёх проектов разных типов → выполнение задач в каждом → проверка результатов. Проверяет isolation между проектами, корректность типов, шаблонов и prompt templates.
- **Зависимости:** F-3.1..F-3.11-E2E (все core features + E2E validation of previous scenario)
- **TDD-тесты:**
  - [ ] **TC-F-3.12-E2E-1:** Full lifecycle across three project types
    - *Условие:* Чистая среда, FAN running, no pre-existing projects
    - *Шаги:*
      1. Создать код-проект «backend-api» (шаблон code)
      2. Создать исследовательский «competitor-analysis» (шаблон research)
      3. Создать автоматизационный «backup-pipeline» (шаблон automation)
      4. В «backend-api»: задача «Add user authentication» → создать `src/auth.ts`
      5. В «competitor-analysis»: `/idea-lab:analyze "Enterprise AI platform"` → сохранить в `docs/research/`
      6. В «backup-pipeline»: задача «Create daily backup script» → создать `scripts/daily-backup.sh`
      7. Вернуться к «backend-api»: проверить что `src/auth.ts` существует
      8. Вернуться к «competitor-analysis»: проверить что research doc существует
      9. Вернуться к «backup-pipeline»: проверить что скрипт существует
    - *Ожидаемый результат:* Все три проекта созданы с правильными типами и структурами; задачи в каждом создали правильные файлы; контексты изолированы (возврат к проекту показывает его данные)
  - [ ] **TC-F-3.12-E2E-2:** System prompts match workspace type
    - *Условие:* Три проекта разных типов активны поочерёдно
    - *Шаги:*
      1. Включить debug mode (или посмотреть системный промпт в UI)
      2. Открыть каждый проект по очереди
      3. Проверить системный промпт загружен правильно
    - *Ожидаемый результат:* 
      - backend-api: prompt содержит role «coding assistant» и tool references для bash/git
      - competitor-analysis: prompt содержит role «research assistant» и output path `docs/research/`
      - backup-pipeline: prompt содержит role «automation assistant» и script path `scripts/`
- **Критерии приёмки:**
  1. Все три шаблона создают корректные директории
  2. Системные промпты применяются корректно к каждому типу
  3. Изоляция контекста: возврат к проекту восстанавливает его состояние
- **Ожидаемый результат:** Ручной or scripted test; confirms multi-project universal task support
- **Оценка объёма:** M

---

## Граф зависимостей

```
┌────────── ЭТАП 3.1: TEMPLATES + DETECTION ──────────┐
│                                                      │
│   F-3.1 Type Schema    F-3.2 Auto-detection          │
│         │                    │                        │
│         └──── depends on ────┘                        │
│              projects.json format                      │
│                                                      │
│   F-3.3 Code Template      F-3.4 Research+Automation  │
│         │                         │                    │
│         └────── depends on ───────┘                    │
│               template pattern                         │
│                                                      │
└──────────────────────┬───────────────────────────────┘
                       │
┌────────── ЭТАП 3.2: API ENDPOINTS ───────────────────┐
│                                                       │
│   F-3.5 POST /api/projects                           │
│           │                                          │
│           ├──→ F-3.3 (code template)                │
│           ├──→ F-3.4 (research/automation templates)│
│           └──→ F-3.2 (auto-detect type)             │
│                                                       │
│   F-3.6 System Prompts Override                      │
│           │                                          │
│           └──→ F-3.1 (type schema)                   │
│                                                       │
└──────────────────────┬───────────────────────────────┘
                       │
┌───────── ЭТАП 3.3: DASHBOARD INTEGRATION ────────────┐
│                                                        │
│   F-3.7 Icons         F-3.8 Create Project Dialog     │
│         │                         │                    │
│         └────→ depends on ────────┘                    │
│                F-3.5 (API endpoint)                    │
│                                                        │
│   F-3.9 Slash Commands       F-3.10 Manual Type Change│
│         │                              │              │
│         └──────── depends on ───────────┘             │
│            Skill Registry + API                       │
│                                                        │
└──────────────────────┬───────────────────────────────┘
                       │
┌───────── ЭТАП 3.4: E2E SCENARIOS ────────────────────┐
│                                                        │
│   F-3.11-E2E (Research cycle)    F-3.12-E2E (Multi-type lifecycle) │
│           │                                  │        │
│           └────────── depends on ALL ────────┘        │
│              stages 3.1 → 3.3                          │
└────────────────────────────────────────────────────────┘
```

**Проверка циклов:** Циклов нет. Все зависимости направленные (DAG). E2E зависит от всех предыдущих этапов.

---

## Полный чеклист по приоритетам

### P0 (Must Have) — 8 фич

- [ ] ☐ F-3.1 Определение типов workspaces в projects.json
- [ ] ☐ F-3.2 Автодетекция типа по структуре директории
- [ ] ☐ F-3.3 Шаблон «Code Project»
- [ ] ☐ F-3.4 Шаблоны «Research Lab» и «Automation Hub»
- [ ] ☐ F-3.5 POST /api/projects — создание из шаблона
- [ ] ☐ F-3.7 Dashboard icons для типов workspace
- [ ] ☐ F-3.8 Форма создания проекта с выбором шаблона
- [ ] ☐ F-3.11-E2E Исследовательский workspace — полный цикл

### P1 (Should Have) — 2 фич

- [ ] ⏳ F-3.6 Custom system prompt override (.fan/prompts/)
- [ ] ⏰ F-3.9 Slash command autocomplete в чате

### P2 (Could Have) — 1 фич

- [ ] ⏰ F-3.10 Ручная смена типа проекта через API/UI

### P3 (Won't Have) — 1 фич

- [ ] ❌ Workspace analytics (отклонено для MVP)

---

## Итоговая оценка

| Мера | Значение |
|------|---------|
| Всего фич | 12 (10 реализаций + 2 E2E) |
| P0 фич | 8 |
| P1 фич | 2 |
| P2 фич | 1 |
| P3 фич | 1 (отклонено) |
| Этапов | 4 (templates+detection, API endpoints, dashboard integration, E2E) |
| Оценка P0 | ~2.5 дня (templates: 4h + API: 6h + dashboard: 6h + E2E: 6h) |
| Оценка полная | ~3–5 дней (с учётом P1/P2) |
| Путь к публикации | P0-complete → E2E validation → publish |

*Зависимость от предыдущих фаз:* Phase 2 workspace UX (ServiceRegistry, project switcher, API client) должен быть завершён для полной многопроектной работы. Phase 1 API (projects.json, project endpoints) обеспечивает инфраструктуру реестра. Скиллы idea-lab, repo-explorer, research-spec-generator уже существуют (пре-инсталлированы в `skills/`).

---

*Сгенерировано: docs-impl agent · 2026-07-25*
*На основе: spec_fan-network-agent_phase3-universal-tasks_v1.0*
