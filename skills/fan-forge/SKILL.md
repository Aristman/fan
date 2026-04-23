---
name: fan-forge
description: >
  Проектирует, создаёт, тестирует и деплоит extensions и skills для fan из описания на естественном языке.
  7-фазный pipeline: постановка → исследование/spec → план → проектирование → тестирование (5 уровней) → документация → деплой.
  Используйте когда пользователь хочет создать, модифицировать или улучшить extension или skill для fan.
compatibility: "Requires Node.js for template scripts. Works with any fan installation."
---

# fan-forge — Extension & Skill Factory

Skill для создания fan-артефактов: extensions (.ts) и skills (SKILL.md).
Проводит от идеи до работающего артефакта через структурированный pipeline.

---

## Когда использовать

- Пользователь хочет создать extension для fan
- Пользователь хочет создать skill для fan
- Пользователь хочет модифицировать существующий extension/skill
- Пользователь описывает идею функциональности, которую можно реализовать как extension/skill

## Когда НЕ использовать

- Пользователь хочет создать theme или fan package (out of scope)
- Пользователь хочет что-то не связанное с fan extensibility

---

## Типы артефактов

### Extension (.ts)

TypeScript-модуль, экспортиющий `default function(pi: ExtensionAPI)`.
Может: регистрировать tools, подписываться на events, регистрировать commands, использовать UI API.

**Выбирай extension когда:**
- Нужен custom tool, callable LLM
- Нужна подписка на lifecycle events (tool_call, session_start, turn_end, etc.)
- Нужен command (`/my-command`)
- Нужна custom UI (widget, status, overlay)
- Нужен gate/interceptor (block/modify tool calls)
- Нужен stateful behaviour (persistence, connections)

### Skill (SKILL.md)

Markdown-файл с frontmatter + инструкции для LLM.
Прогрессивный disclosure: description — всегда в контексте, полный текст — по требованию.

**Выбирай skill когда:**
- Нужен workflow/instructions для LLM (как этот fan-forge)
- Нужен prompt template для определённого типа задач
- Нет потребности в runtime-поведении (tools, events, UI)
- Вся ценность — в инструкциях и reference-материалах

---

## Шаблоны

Шаблоны находятся в [templates/](templates/) и загружаются по требованию через `read`.
Они — отправная точка, а не ограничение. Адаптируй под задачу.

| Шаблон | Путь | Когда использовать |
|--------|------|-------------------|
| Tool extension | [tool-extension.ts](templates/extensions/tool-extension.ts) | Один custom tool |
| Command extension | [command-extension.ts](templates/extensions/command-extension.ts) | Slash command с UI |
| Gate extension | [gate-extension.ts](templates/extensions/gate-extension.ts) | Перехват/block tool calls |
| UI extension | [ui-extension.ts](templates/extensions/ui-extension.ts) | Custom UI components |
| Event extension | [event-extension.ts](templates/extensions/event-extension.ts) | Подписка на lifecycle events |
| Multi-file extension | [multi-extension/](templates/extensions/multi-extension/) | Complex extension, несколько файлов |
| With dependencies | [with-deps/](templates/extensions/with-deps/) | Extension с npm dependencies |
| Basic skill | [basic-skill/](templates/skills/basic-skill/) | Минимальный skill scaffold |

---

## Pipeline

### Фаза 1: Постановка задачи

**Вход:** Свободное описание пользователя.

**Действия:**

1. Зафиксируй «Ядро идеи» в формате:
   ```
   Ядро идеи: <краткое описание>
   ```

2. Определи тип артефакта:
   - **Extension** — если нужен runtime behaviour (tools, events, commands, UI, gates)
   - **Skill** — если нужны инструкции/workflow для LLM
   - **Модификация** — если пользователь хочет изменить существующий артефакт

   Если тип очевиден из контекста — определяй сам, не спрашивай.

3. Оцени полноту описания (0–1):
   - `1.0` — что создавать, какой API, как должно работать — всё ясно
   - `0.7–0.9` — понятно, но нужны 1–2 уточнения
   - `0.4–0.6` — тема ясна, детали размыты
   - `0.0–0.3` — нужны существенные уточнения

4. Если полнота < 0.7 — задай уточняющие вопросы через `question`/`questionnaire`.
   Не спрашивай то, что можешь найти сам (в docs, examples, memory).

5. Для модификации — прочитай текущий код через `read`/`bash`.

**Критерий завершения:** Тип определён, полнота ≥ 0.7.

---

### Фаза 2: Исследование и создание спецификации

**Вход:** Тип артефакта + полное описание.

**Действия:**

1. **Внутренние источники:**
   - `memory_search` — есть ли релевантный контекст
   - `read` templates — найди подходящий шаблон
   - `bash` — изучи существующие extensions/skills в `~/.fan/agent/extensions/` и `~/.fan/agent/skills/`

2. **Архитектурное исследование:**
   - Какие fan API нужны? (registerTool, on, registerCommand, UI, state, sendMessage)
   - Какие events подписывать? (tool_call, session_start, turn_end, before_agent_start, etc.)
   - Структура: single file / multi-file / directory?
   - Нужен ли npm dependencies?

3. **Прочитай fan extension docs** для нужных API:
   ```
   packages/coding-agent/docs/extensions.md
   ```

4. **Найди похожий пример:**
   ```
   packages/coding-agent/examples/extensions/
   ```

5. **Создай спецификацию** в `docs/specs/spec_<name>_<YYYY-MM-DD>.md`:

   ```markdown
   # Spec: <Название>

   ## Метаданные
   - **Дата**: <YYYY-MM-DD>
   - **Автор**: fan-forge
   - **Статус**: В работе
   - **Тип**: Extension / Skill / Модификация

   ## 1. Обзор
   ### 1.1 Цель
   ### 1.2 Описание решения

   ## 2. API Requirements
   ### 2.1 Tools (name, parameters, description)
   ### 2.2 Commands
   ### 2.3 Events
   ### 2.4 UI components

   ## 3. Архитектура
   ### 3.1 Файловая структура
   ### 3.2 Зависимости
   ### 3.3 State management

   ## 4. User Scenarios
   (каждый: предусловия → шаги → ожидаемый результат)

   ## 5. Test Criteria
   (конкретные проверки для каждого tool/command/event)

   ## 6. Риски
   ```

6. Представь спецификацию пользователю. Используй `question` для подтверждения.

**Критерий завершения:** Спецификация создана и подтверждена.

---

### Фаза 3: Создание плана работ

**Вход:** Утверждённая спецификация.

**Действия:**

1. Разбей реализацию на конкретные шаги.

2. Каждый шаг в формате:
   ```
   ### Шаг N: <Название>
   - **Файл:** что создаётся/изменяется
   - **API:** какой fan API используется
   - **Критерий:** конкретное условие успешности
   - **Тест:** как проверить
   ```

3. Упорядочи по зависимостям:
   - Utils / types → importable модули
   - Tool definitions → registerTool
   - Event handlers → pi.on()
   - UI components → ctx.ui
   - Commands → registerCommand
   - Entry point (index.ts) → wiring everything

4. Для multi-file extension'ов — пофайловый план.
   Для single file — пофункциональный план.

5. Представь план пользователю через `question` для подтверждения.

**Критерий завершения:** Все требования из спецификации покрыты шагами с критериями.

---

### Фаза 4: Проектирование и реализация

**Вход:** Утверждённый план.

**Действия:**

1. **Выбери шаблон** из [templates/](templates/) — `read` соответствующий файл.
   Если ни один не подходит — создавай с нуля, используя reference ниже.

2. **Реализуй по шагам плана:**
   - Новые файлы → `write`
   - Модификации → `edit`
   - Создавай временные файлы в рабочей директории (не сразу в `~/.fan/agent/`)

3. **Рабочая директория** для артефакта:
   - Создай в `~/.fan/agent/skills/fan-forge/workspace/<name>/`
   - После успешного тестирования — скопируешь на постоянное место

4. **Для extension'ов — следи за:**
   - Correct imports: `@fan/fan-coding-agent`, `@sinclair/typebox`, `@fan/fan-ai`, `@fan/fan-tui`
   - `StringEnum` для enum-ов (не `Type.Union`/`Type.Literal` — не работает с Google)
   - `withFileMutationQueue` для файловых операций в tools
   - `isToolCallEventType` для типизации в tool_call handlers
   - Export `default function(pi: ExtensionAPI)` в entry point

5. **Для skills — следи за:**
   - Корректный frontmatter: `name` (lowercase, hyphens), `description` (max 1024 chars)
   - Имя директории = `name` из frontmatter
   - Используй `[relative paths](./path)` для ссылок на helper-скрипты

6. **Отслеживай прогресс** — после каждого крупного шага сообщай пользователю.

**Критерий завершения:** Все файлы созданы.

---

### Фаза 5: Тестирование и проверка

**Вход:** Реализованный код.

**Последовательно пройди 5 уровней. Если уровень фейлит — исправь и перепроверь. Максимум 3 итерации на уровень.**

#### Уровень 1: Структурная валидация

Выполни через `bash`:

```bash
# Check file exists
ls -la <workspace>/<name>/index.ts   # или <name>.ts

# Check naming (lowercase, hyphens only)
echo "<name>" | grep -Pq '^[a-z0-9][a-z0-9-]*[a-z0-9]$'

# Check exports default function (extension)
grep -q "export default function" <workspace>/<name>/index.ts

# Check imports
grep -q "@fan/fan-coding-agent" <workspace>/<name>/index.ts

# Check SKILL.md frontmatter (skill)
grep -q "^name:" <workspace>/<name>/SKILL.md
grep -q "^description:" <workspace>/<name>/SKILL.md
```

**Pass/Fail:** Все проверки успешны.

#### Уровень 2: Парсинг TypeScript (extension only)

```bash
# Quick syntax check via node + jiti
cd <workspace>/<name> && node -e "
const jiti = require('jiti')(__filename);
try { jiti('./index.ts'); console.log('PARSE_OK'); } catch(e) { console.error('PARSE_FAIL:', e.message); process.exit(1); }
"
```

**Pass/Fail:** `PARSE_OK`, нет ошибок.

#### Уровень 3: Загрузочный тест (extension only)

```bash
fan -e <workspace>/<name>/index.ts --no-session 2>&1
echo "EXIT_CODE=$?"
```

**Pass/Fail:** Exit code = 0, нет runtime errors в output.

#### Уровень 4: Ревью кода

Выполни manually — прочитай код и проверь:

- [ ] Tool `parameters` используют `Type` из `@sinclair/typebox` (не raw JSON schema)
- [ ] Enum-ы используют `StringEnum` из `@fan/fan-ai`
- [ ] `tool_call` handlers используют `isToolCallEventType` для типизации
- [ ] Tool `execute` возвращает `{ content: [...], details: {...} }`
- [ ] Ошибки в tools signalling через `throw new Error()` (не через return)
- [ ] Файловые операции в tools обёрнуты в `withFileMutationQueue`
- [ ] Event handlers не throw при normal operation
- [ ] State properly persisted via `pi.appendEntry()` и восстанавливается в `session_start`
- [ ] `renderCall` и `renderResult` возвращают Component из `@fan/fan-tui`
- [ ] Commands: handler `async (args, ctx) => { ... }`

#### Уровень 5: Edge cases ревью

- [ ] `signal?.aborted` проверяется в long-running tool execute
- [ ] Empty/undefined inputs обрабатываются (не crash)
- [ ] `event.input` мутация безопасна (в tool_call handlers)
- [ ] Нет hardcoded путей (используется `ctx.cwd`)
- [ ] Cleanup в `session_shutdown` если нужно

**Если любой уровень фейлит после 3 итераций** — остановись и спроси пользователя за помощью.

**Критерий завершения:** Все 5 уровней пройдены.

---

### Фаза 6: Документация

**Вход:** Протестированный код.

**Действия:**

1. Создай `README.md` в директории артефакта:

   ```markdown
   # <Название>

   ## Описание
   <Краткое описание>

   ## Установка
   Скопировать в нужную директорию:
   - Глобально: `~/.fan/agent/extensions/<name>/` (extension) или `~/.fan/agent/skills/<name>/` (skill)
   - Проектно: `.fan/extensions/<name>/` или `.fan/skills/<name>/`

   ## Использование

   ### Tools
   - `<tool-name>`: <description>

   ### Commands
   - `/<command>`: <description>

   ### Events
   - Подписывается на: <events>

   ## Конфигурация
   <если есть>

   ## Примеры
   <конкретные примеры использования>
   ```

2. Добавь inline-комментарии к complex logic в коде.

3. Обнови спецификацию в `docs/specs/` — измени статус на «Реализовано».

**Критерий завершения:** README.md создан.

---

### Фаза 7: Деплой

**Вход:** Задокументированный и протестированный артефакт.

**Действия:**

1. Спроси пользователя через `question`:

   ```
   question({
     question: "Куда деплоить <name>?",
     options: [
       { label: "Глобально", description: "~/.fan/agent/extensions/ (extension) или ~/.fan/agent/skills/ (skill)" },
       { label: "Проектно", description: ".fan/extensions/ или .fan/skills/ в текущей директории" }
     ]
   })
   ```

2. **Скопируй файлы:**

   ```bash
   # Extension — глобально
   cp -r <workspace>/<name>/ ~/.fan/agent/extensions/<name>/

   # Extension — проектно
   mkdir -p .fan/extensions && cp -r <workspace>/<name>/ .fan/extensions/<name>/

   # Skill — глобально
   cp -r <workspace>/<name>/ ~/.fan/agent/skills/<name>/

   # Skill — проектно
   mkdir -p .fan/skills && cp -r <workspace>/<name>/ .fan/skills/<name>/
   ```

3. **npm dependencies** (если есть `package.json`):
   ```bash
   cd <target>/<name> && npm install
   ```

4. **Backup + Deploy:**

   ```bash
   # Если целевой путь уже существует — создай backup
   if [ -d "<target>/<name>" ]; then
     cp -r "<target>/<name>" "<target>/<name>.bak.$(date +%s)"
   fi
   ```

5. **Reload:**
   Отправь `/reload` как follow-up message. Пиши пользователю что нужно дождаться reload.

6. **Верификация после reload:**
   - Extension: проверь что tools/commands доступны (спроси пользователя или проверь через `fan.getAllTools()`)
   - Skill: проверь что `/skill:<name>` доступен

7. **Rollback при ошибке:** см. [Rollback Procedure](references/rollback-procedure.md) — удалить неработающий, восстановить из backup, `/reload`.

**Критерий завершения:** Артефакт загружен и работает.

---

## References

- **Rollback Procedure:** [references/rollback-procedure.md](references/rollback-procedure.md) — полный алгоритм отката при ошибке деплоя
- **Extension API:** [references/extension-api-reference.md](references/extension-api-reference.md) — полный reference с примерами кода для всех fan Extension API

**Ключевые API:**
- `pi.registerTool()` — register LLM-callable tools (parameters via `Type.Object` + `StringEnum`)
- `pi.on(event, handler)` — subscribe to lifecycle events (`tool_call`, `session_start`, `turn_end`, etc.)
- `pi.registerCommand()` — register slash commands with UI interaction
- `ctx.ui` — `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `custom`
- `pi.appendEntry()` / `ctx.sessionManager.getEntries()` — state persistence
- `withFileMutationQueue()` — safe concurrent file mutations

---

## Helper Scripts

### validate-extension.sh — Уровни 1-2

```bash
bash ~/.fan/agent/skills/fan-forge/scripts/validate-extension.sh <path-to-extension>
```

Проверяет:
- Файл существует и .ts
- Экспортирует default function
- Импортирует из @fan/fan-coding-agent
- Парсится без синтаксических ошибок (jiti)

### test-load-extension.sh — Уровень 3

```bash
bash ~/.fan/agent/skills/fan-forge/scripts/test-load-extension.sh <path-to-extension>
```

Проверяет:
- Extension загружается через `fan -e` без runtime ошибок
- Exit code = 0

---

## Правила

1. **Не ломай fan** — всё тестируется перед деплоем
2. **Минимум вопросов** — сначала read/docs/examples, потом спрашивай
3. **Шаблоны — отправная точка** — адаптируй, не копируй слепо
4. **Файлы → workspace** — сначала создаёшь в workspace, потом деплоишь
5. **Backup перед перезаписью** — если target существует
6. **Rollback при ошибке** — автоматический
7. **Сохраняй контекст** — спецификация и план в файлах для восстановления после compaction
8. **Windows-aware** — используй cross-platform команды в bash или учитывай Windows paths
