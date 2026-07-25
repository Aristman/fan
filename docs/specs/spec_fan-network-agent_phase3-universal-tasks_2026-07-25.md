# Спецификация: Фаза 3 — Универсальные задачи и шаблоны workspaces

## Метаданные
- **Дата**: 2026-07-25
- **Автор**: research-spec-generator
- **Статус**: Черновик
- **Версия**: 1.0
- **Тип**: Новая фича · Фаза 3 из пакета «FAN Network Agent»
- **Связь**: [Родительская спецификация](./spec_fan-network-agent_2026-07-25.md)

---

## 1. Обзор

### 1.1 Цель

Формализовать non-code use cases как первоклассный сценарий FAN Network Agent. Workspace = директория без обязательного `.git` — модель естественным образом покрывает кодовые репозитории, исследовательские workspaces и рабочие директории автоматизации. Фаза добавляет типы workspaces, шаблоны иерархии директорий и pre-built prompt templates для не-код задач.

### 1.2 Контекст

Исследование v2 (`docs/research/idea-lab/fan-remote-vps/FAN Network Agent — FAN как сетевой инструмент (v2).md`, раздел 2.3) показало: workspace в FAN — это просто директория + `.fan/`-конфиг. Git не обязателен. Модель «проект = директория на VPS» естественно покрывает:
- кодовые репозитории (клоны на VPS)
- исследовательские workspaces (idea-lab, research-spec-generator пишут в `docs/research/` проекта)
- рабочие директории автоматизации (скрипты, данные, отчёты)

Отдельной архитектуры для не-код задач не нужно — достаточно формализации типов workspaces и шаблонов.

---

## 2. Функциональные требования

### 2.1 Типы workspaces

**Файл:** обновление `~/.fan/agent/projects.json` — добавить поле `type`:

```json
{
    "path": "/data/repos/my-project",
    "name": "my-project",
    "type": "code",           // код: git repo, содержит src/, tests/
    "sessionCount": 3
}
```

| Тип | Описание | Критерий определения | Примеры |
|-----|----------|---------------------|---------|
| `code` | Кодовый проект | Наличие `.git` + `src/` или `package.json` | GitHub клонированные репо |
| `research` | Исследовательский workspace | Наличие `docs/research/` или `.fan/prompts/` | idea-lab, repo-explorer результаты |
| `automation` | Автоматизация | Наличие скриптов (`*.sh`, `*.py`) + config файлов | cron tasks, data processing |
| `unknown` | Не определён | Ни один критерий не совпал | Новый проект, требующий ручной классификации |

**Автоматическое определение типа:** при регистрации проекта (`POST /api/projects` или первый сеанс) система сканирует структуру директории и назначает тип. Пользователь может перегнать вручную через API:

```json
// PUT /api/projects/:path
{ "type": "research" }
```

### 2.2 Шаблоны workspaces

**Файл:** новые шаблонные структуры в `packages/coding-agent/src/workspace/templates/`

Готовые структуры директорий, создаваемые автоматически при регистрации нового проекта:

#### Шаблон «Code Project»
```
my-project/
├── .fan/
│   └── settings.json      # проектные настройки
├── src/
├── tests/
├── docs/
└── package.json
```

#### Шаблон «Research Lab»
```
idea-lab-workspace/
├── .fan/
│   ├── prompts/            # project-specific промпты
│   └── settings.json
├── docs/
│   └── research/           # результаты исследований
├── data/                   # сырые данные
└── reports/                # сгенерированные отчёты
```

#### Шаблон «Automation Hub»
```
automation-hub/
├── .fan/
│   └── settings.json
├── scripts/
│   ├── daily.sh
│   └── weekly.py
├── config/
├── output/
└── logs/
```

**API для создания из шаблона:**
```json
// POST /api/projects (новый endpoint)
{
    "name": "idea-lab-workspace",
    "template": "research",     // или "code", "automation"
    "rootPath": "/data/repos/"  // optional, default = ~/projects
}
```

Ответ: созданный путь и metadata.

### 2.3 Не-код задачи как первоклассный сценарий

#### Idea Lab интеграция

Скилл `idea-lab` (уже существует в `skills/idea-lab/SKILL.md`) работает в любом workspace — генерирует SWOT-анализы, альтернативы, action plans. Результат сохраняется в `<workspace>/docs/research/`.

При выборе research workspace в dashboard:
- Показываются доступные скиллы: idea-lab, research-spec-generator
- Быстрые команды (slash commands): `/idea-lab:analyze <topic>`, `/research-spec:generate <topic>`

#### Repo Explorer интеграция

Скилл `repo-explorer` анализирует локальные git-репозитории на VPS. Для не-git директорий предлагает анализ структуры как «простого workspace».

#### Research Spec Generator интеграция

Скилл `research-spec-generator` использует template из `C:\Users\User\.fan\agent\skills\research-spec-generator\references\spec-template.md`. Работает в любом workspace. Результат — полный markdown документ спецификации в указанную директорию.

### 2.4 Промпт-шаблоны для типов workspace

**Файл:** `<workspace>/.fan/prompts/` — проектные системные промпты

Каждый тип workspace имеет базовый системный промпт, который подгружается вместе с per-project settings:

#### System prompt для code workspace
```
You are a coding assistant working in a code repository at {workspace_path}.
Help with: code changes, testing, refactoring, PR preparation.
Available tools: bash (git, npm, etc.), read/write/edit files, grep/find.
Follow best practices for this codebase structure.
```

#### System prompt для research workspace
```
You are a research assistant working in an analysis workspace at {workspace_path}.
Help with: SWOT analysis, competitive research, spec generation, data analysis.
Available tools: read/write/edit files, idea-lab skill, research-spec-generator.
Output goes to {workspace_path}/docs/research/ by default.
```

#### System prompt для automation workspace
```
You are an automation assistant working at {workspace_path}.
Help with: script creation, cron job setup, data processing pipelines.
Available tools: bash, file operations, cron management.
Scripts go to {workspace_path}/scripts/ by default.
```

---

## 3. Пользовательские сценарии

### Сценарий 1: Создание исследовательского workspace

**Предусловия:** Dashboard подключён к FAN Network Agent
**Шаги:**
1. Пользователь нажимает «+ Новый проект»
2. Выбирает шаблон «Research Lab»
3. Вводит имя: `market-analysis-q3`
4. FAN создаёт структуру директорий, регистрирует проект
5. Проект появляется в sidebar с иконкой 📊 (research)

**Ожидаемый результат:** новый workspace создан, можно запускать idea-lab и research-spec-generator

### Сценарий 2: Анализ идеи в research workspace

**Предусловия:** research workspace активен
**Шаги:**
1. Пользователь пишет в чат: `/idea-lab:analyze "AI-powered code review tool"`
2. Agent запускает idea-lab скилл
3. Генерируется SWOT-анализ, сохраняется в `docs/research/swot-ai-code-review.md`
4. Результат доступен в файловой системе проекта

**Ожидаемый результат:** полный анализ идеи в markdown формате

### Сценарий 3: Автоматизация — создание cron-скрипта

**Предусловия:** automation workspace активен
**Шаги:**
1. Пользователь просит: «Создай скрипт ежедневного бэкапа БД»
2. Agent создаёт `scripts/daily-backup.sh` с логикой бекапа
3. Предлагает настроить cron через scheduler-сервис (если фаза 4 доступна)

**Ожидаемый результат:** рабочий скрипт в правильной директории проекта

---

## 4. UI/UX требования

### 4.1 Иконки типов workspace

В sidebar навигации каждый проект отображается с иконкой типа:
- 💻 `code` — ноутбук/кодовая скобка
- 🔬 `research` — лупа/микроскоп
- ⚙️ `automation` — шестерёнка/инструмент
- ❓ `unknown` — вопросительный знак

### 4.2 Форма создания проекта

Диалог создания нового проекта:
```
┌───────── Создать новый проект ─────────┐
│                                        │
│ Название: [____________]               │
│                                        │
│ Шаблон:                               │
│ ○ Код-проект     💻                    │
│ ○ Исследование   🔬                    │
│ ○ Автоматизация  ⚙️                     │
│ ○ Пустая папка   📁                    │
│                                        │
│ Расположение: [/data/repos/]           │
│                                        │
│          [Отмена]    [Создать]         │
└────────────────────────────────────────┘
```

### 4.3 Быстрые команды

В поле ввода чата доступны slash commands, определённые в активных скиллах:
- `/idea-lab:*` — анализ идей
- `/research-spec:*` — генерация спецификаций
- `/repo-explorer:*` — анализ репозиториев

Commands показываются в dropdown автокомплита при вводе `/`.

---

## 5. Риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|------|-------------|---------|-----------|
| Неправильное автоматическое определение типа | Средняя | Низкое | Ручная перегруппировка через API; fallback → unknown |
| Шаблоны создают лишнюю структуру для простых проектов | Низкая | Низкое | Опциональное применение шаблона; пустая папка по умолчанию |
| Системные промпты конфликтуют со скиллами | Низкая | Среднее | Чёткое разделение: system prompt задаёт роль, скиллы расширяют функционал |
| Template-промпты слишком жёсткие | Низкая | Низкое | Перезаписываемые в `.fan/prompts/system.md` пользователем |

---

## 6. Компромиссы

### 6.1 Принятые решения

- **Три предопределённых типа + unknown** — покрывают 95% сценариев. Добавление новых типов требует обновления кода. Достаточно для MVP.
- **Автодетекция типа по структуре** — простота UX vs возможная ошибка. Ручная коррекция доступна.
- **Промпт-шаблоны как текстовые файлы** — нет компиляции, легко редактировать. Безопасно (только text, no code execution from prompts).

### 6.2 Отклонённые альтернативы

- **YAML-конфигурация типов** — усложнение без явной выгоды для личного инструмента. JSON достаточно.
- **ML-классификатор типов** — избыточно для нескольких паттернов директорий.
- **Отдельные API endpoints для каждого типа** — DRY violation. Один endpoint, dispatch по типу.

---

## 7. Приоритеты

### Must Have
- Типы workspaces: code, research, automation, unknown
- Автодетекция типа по структуре директории
- Шаблонная структура директорий (3 шаблона)
- Система prompt templates (.fan/prompts/)

### Should Have
- Ручная смена типа проекта через API/UI
- Custom system prompt override (`custom-system.md`)
- Подсказки slash commands в UI autocomplete

### Could Have
- Wizard создания проекта (guided multi-step form)
- Import из существующей директории
- Workspace analytics (сколько сессий, сколько токенов потрачено)

### Won't Have
- Multi-format configs (YAML/TOML) — JSON достаточно
- Template versioning — single source of truth
- Community template marketplace — личный инструмент

---

## 8. Следующие шаги

- [ ] Определить структуру `projects.json` с полем `type`
- [ ] Реализовать auto-detect logic (scan directory, match patterns)
- [ ] Создать шаблоны директорий в `packages/coding-agent/src/workspace/templates/`
- [ ] Добавить API endpoint для создания из шаблона
- [ ] Определить систему prompt templates (.fan/prompts/)
- [ ] Интегрировать slash commands в chat UI (autocomplete)
- [ ] Обновить dashboard icons для типов workspace
- [ ] Регрессия: build 0 errors, локальный TUI не сломан

---

*Создано: research-spec-generator skill · дата 2026-07-25*
*Фаза 3 из пакета «FAN Network Agent»*
*Спецификация ссылается на родительскую: [FAN Network Agent](./spec_fan-network-agent_2026-07-25.md)*
