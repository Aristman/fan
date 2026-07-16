# fan-forge 🛠️

**Skill для создания расширений и навыков fan из описания на естественном языке.**

Проектирует, реализует, тестирует и деплоит extensions (.ts) и skills (SKILL.md) прямо в работающий экземпляр fan. 7-фазный pipeline — от идеи до работающего артефакта с hot-reload.

---

## Что это

fan-forge — это skill (набор инструкций + шаблоны + скрипты), который направляет LLM через структурированный процесс создания артефактов для pi:

| Артефакт | Что это | Когда нужен |
|----------|---------|-------------|
| **Extension** (.ts) | TypeScript-модуль с runtime-поведением: tools, events, commands, UI | Нужен custom tool, gate, command, widget, подписка на события |
| **Skill** (SKILL.md) | Markdown-файл с инструкциями для LLM | Нужен workflow, prompt template, reference-материал |

fan-forge **не является extension** — он использует встроенные инструменты fan (read, write, edit, bash, question, web_search) и направляет их через 7 фаз.

---

## Как использовать

### Запуск

```
/skill:fan-forge
```

Затем опиши что хочешь создать на естественном языке.

### Примеры запросов

**Простой extension:**
> Хочу extension, который добавляет tool для генерации UUID (v4)

**Extension с UI:**
> Сделай extension с командой /pomodoro, которая показывает таймер в виджете

**Gate extension:**
> Нужен gate, который блокирует запись в файлы .env

**Skill:**
> Создай skill для code review — проверка на антипаттерны, безопасность, стиль

**Модификация:**
> Добавь в мой extension session-name поддержку нескольких label'ов на entry

---

## Pipeline

fan-forge проводит артефакт через 7 фаз:

```
Идея → Постановка → Исследование/Spec → План → Код → Тесты → Документация → Деплой
```

### Фаза 1. Постановка задачи
- Фиксирует суть идеи
- Определяет тип артефакта (extension / skill / модификация)
- Оценивает полноту описания (0–1)
- Задаёт уточняющие вопросы если нужно (через `question` / `questionnaire`)

### Фаза 2. Исследование и спецификация
- Изучает fan docs, existing examples, memory
- Определяет какие fan API нужны
- Находит похожие паттерны
- Создаёт формальную спецификацию в `docs/specs/`
- Презентует пользователю на подтверждение

### Фаза 3. План работ
- Разбивает на конкретные шаги (файл за файлом)
- Каждый шаг с критерием проверки и тестом
- Упорядочивает по зависимостям
- Презентует на подтверждение

### Фаза 4. Проектирование и реализация
- Выбирает подходящий шаблон из набора
- Пишет код в workspace-директории
- Для extensions — TypeScript с ExtensionAPI
- Для skills — SKILL.md с frontmatter

### Фаза 5. Тестирование (5 уровней)

| Уровень | Что проверяет | Как |
|---------|--------------|-----|
| **L1** Structure | Файлы на месте, naming, exports, imports | bash-проверки |
| **L2** Parsing | TypeScript парсится без ошибок | jiti |
| **L3** Load | Extension загружается в fan без runtime errors | `fan -e --no-session` |
| **L4** Code review | TypeBox, StringEnum, isToolCallEventType, withFileMutationQueue | Manual |
| **L5** Edge cases | Abort signal, parallel safety, error handling, empty inputs | Manual |

При провале — возврат в Фазу 4. Максимум 3 итерации.

### Фаза 6. Документация
- Создаёт README.md с описанием, установкой, использованием
- Добавляет inline-комментарии
- Обновляет спецификацию (статус → «Реализовано»)

### Фаза 7. Деплой
- Спрашивает куда: глобально (`~/.fan/agent/`) или проектно (`.fan/`)
- Копирует файлы, создаёт backup если target существует
- `npm install` если есть зависимости
- Выполняет `/reload`
- При ошибке — автоматически откатывает (rollback)

---

## Шаблоны

Шаблоны — отправная точка, а не ограничение. LLM адаптирует их под задачу.

### Extensions

| Шаблон | Файл | Для чего |
|--------|------|----------|
| **Tool** | `tool-extension.ts` | Один custom tool с TypeBox parameters и рендером |
| **Command** | `command-extension.ts` | Slash-команда с UI interaction (select, confirm, input) |
| **Gate** | `gate-extension.ts` | Перехват и блокировка tool calls (permission gate, path protection) |
| **UI** | `ui-extension.ts` | Custom UI: статус, виджет, overlay-компонент |
| **Event** | `event-extension.ts` | Подписка на lifecycle events с state persistence |
| **Multi-file** | `multi-extension/` | Complex extension: index.ts + tools.ts + events.ts + utils.ts |
| **With deps** | `with-deps/` | Extension с npm-зависимостями (package.json + fan manifest) |

### Skills

| Шаблон | Файл | Для чего |
|--------|------|----------|
| **Basic** | `basic-skill/SKILL.md` | Минимальный scaffold с frontmatter, секциями setup/usage/reference |

---

## Структура

```
~/.fan/agent/skills/fan-forge/
├── SKILL.md                          # Инструкции для LLM (pipeline, reference, правила)
├── README.md                         # Этот файл
├── templates/
│   ├── extensions/
│   │   ├── tool-extension.ts
│   │   ├── command-extension.ts
│   │   ├── gate-extension.ts
│   │   ├── ui-extension.ts
│   │   ├── event-extension.ts
│   │   ├── multi-extension/           # index.ts, tools.ts, events.ts, utils.ts
│   │   └── with-deps/                # package.json, src/index.ts
│   └── skills/
│       └── basic-skill/              # SKILL.md
└── scripts/
    ├── validate-extension.sh         # L1-L2: структура + парсинг
    └── test-load-extension.sh        # L3: загрузка через fan CLI
```

---

## Helper scripts

### validate-extension.sh — Уровни 1-2

```bash
bash ~/.fan/agent/skills/fan-forge/scripts/validate-extension.sh <path>
```

Проверяет:
- Файл .ts существует
- Экспортирует `default function`
- Импортирует `@fan/fan-coding-agent`
- TypeScript парсится через jiti без ошибок

```bash
# Single file
bash ~/.fan/agent/skills/fan-forge/scripts/validate-extension.sh my-ext.ts

# Directory (ищет index.ts)
bash ~/.fan/agent/skills/fan-forge/scripts/validate-extension.sh my-extension/
```

### test-load-extension.sh — Уровень 3

```bash
bash ~/.fan/agent/skills/fan-forge/scripts/test-load-extension.sh <path>
```

Запускает `fan -e <path> --no-session` и проверяет exit code = 0.

---

## Workspace

Артефакты создаются в workspace-директории до прохождения всех тестов:

```
~/.fan/agent/skills/fan-forge/workspace/<name>/
├── index.ts
└── README.md
```

Только после успешного тестирования файлы копируются на постоянное место (`~/.fan/agent/extensions/` или `.fan/extensions/`).

---

## Rollback

Если `/reload` после деплоя вызвал ошибку:

1. fan-forge автоматически удаляет неработающий артефакт
2. Восстанавливает backup (если target существовал до деплоя)
3. Отправляет `/reload` повторно
4. Сообщает об ошибке

---

## Quick Reference — fan Extension API

Для тех, кто хочет понимать что fan-forge генерирует:

**Skeleton:**
```typescript
import type { ExtensionAPI } from "@fan/fan-coding-agent";
export default function (pi: ExtensionAPI) {
  fan.registerTool({ ... });
  fan.on("event", (event, ctx) => { ... });
  fan.registerCommand("name", { ... });
}
```

**Key imports:**
```typescript
import { Type } from "@sinclair/typebox";           // Schema definitions
import { StringEnum } from "@fan/fan-ai";   // String enums (for Google)
import { Text, Container } from "@fan/fan-tui"; // UI components
import { isToolCallEventType } from "@fan/fan-coding-agent"; // Type guards
import { withFileMutationQueue } from "@fan/fan-coding-agent"; // File safety
```

**Key rules:**
- `StringEnum()` для enum-ов, **не** `Type.Literal` (Google не поддерживает)
- `withFileMutationQueue()` для файловых операций в tools (race condition safety)
- `throw new Error()` для ошибок в tool execute, **не** return с error
- `isToolCallEventType("toolName", event)` для типизации в `tool_call` handlers
- `ctx.signal?.aborted` для проверки cancellation в long-running tools

---

## Зависимости

Нет внешних зависимостей. Всё работает через встроенные fan инструменты.

Helper scripts требуют:
- `bash` (Git Bash на Windows)
- `node` + `jiti` (автоматически доступен через fan)

---

## Совместимость

- **OS:** Windows (Git Bash), Linux, macOS
- **pi:** любая версия с поддержкой skills и extensions
- **LLM:** любая модель, поддерживаемая fan (больше токенов контекста = лучше для complex extensions)
