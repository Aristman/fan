# Скилы FAN (Skills)

## Обзор

Скилы FAN — это специализированные инструкции для AI-агента в формате [Agent Skills](https://agentskills.io/specification). Каждый скил — это директория с `SKILL.md` (YAML frontmatter + инструкции), описывающая конкретную задачу, которую агент может выполнить.

## Архитектура

```
┌────────────────────────────────────────────────────────────────┐
│                       Skill Engine                              │
│          packages/coding-agent/src/core/skills.ts               │
│                                                                │
│  • Парсинг SKILL.md с YAML frontmatter                         │
│  • Валидация против Agent Skills spec                          │
│  • Обнаружение из директорий: ~/.fan/agent/skills/, .fan/     │
│    skills/, ~/.agents/skills/                                 │
│  • Разрешение коллизий имён (project > user > global)          │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    12 Предустановленных Скилов                   │
│                            skills/*                             │
│                                                                │
│  ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐   │
│  │ auto-tests│ │ bug-fix  │ │code-research│ │  deep-dive   │   │
│  └───────────┘ └──────────┘ └────────────┘ └──────────────┘   │
│  ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐   │
│  │dev-docs-  │ │fan-forge │ │  feature-  │ │ feature-     │   │
│  │   pack    │ │          │ │  pipeline  │ │  roadmap     │   │
│  └───────────┘ └──────────┘ └────────────┘ └──────────────┘   │
│  ┌───────────┐ ┌──────────┐ ┌──────────────────────────────┐  │
│  │ idea-lab  │ │repo-     │ │ research-spec-               │  │
│  │           │ │explorer  │ │ generator                    │  │
│  └───────────┘ └──────────┘ └──────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ stack-overflow-agents-skill (standalone variant)       │    │
│  └────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

## Формат SKILL.md

```yaml
---
name: my-skill
description: Описание скила
version: 1.0.0
author: FAN
type: skill
tags: [tag1, tag2]
model_invocation: true  # может ли агент вызывать модели
commands:
  - command: /skill:my-skill
    description: Активировать скил
requirements:
  - tool: delegate_task
---
# Инструкции скила

Здесь описывается, что делает скил и как его использовать.
Может ссылаться на внешние файлы в той же директории.
```

## Детальное описание скилов

### 1. auto-tests — Автономная генерация тестов

**Назначение:** Автономно генерирует тесты для непокрытых модулей на 8 языках (TypeScript, Rust, Python, Java, Go, C++, C#, Kotlin).

**Директория:** `skills/auto-tests/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |
| `references/` | Референсные материалы по тестовым фреймворкам |
| `scripts/` | Скрипты для запуска тестов |

**Ключевая особенность:** Генерация зелёных тестов (которые проходят) для непокрытых модулей.

---

### 2. bug-fix — Автономный баг-фикс

**Назначение:** Исправление багов: воспроизвести → найти причину → исправить → проверить.

**Директория:** `skills/bug-fix/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |

**Процесс:** Reproduce → Root Cause → Fix → Verify. Минимальный diff.

---

### 3. code-research — READ-ONLY анализ кода

**Назначение:** Глубокий read-only анализ кодовой базы: архитектура, зависимости, символы, трассировка.

**Директория:** `skills/code-research/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |

**Ключевая особенность:** Read-only — не вносит изменений. Используется для понимания кода.

---

### 4. deep-dive — Углублённое исследование

**Назначение:** Углублённый анализ по пунктам из отчёта `repo-explorer`. Читает код, трассирует зависимости, синтезирует выводы.

**Директория:** `skills/deep-dive/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |

**Вход:** Список пунктов из отчёта repo-explorer
**Выход:** Отдельные отчёты по каждому пункту

---

### 5. dev-docs-pack — Пак документации разработки

**Назначение:** Генерация полного пакета документации по спецификации фичи: roadmap, блок-схемы, TDD-roadmap, API docs, стратегия тестирования, план релиза.

**Директория:** `skills/dev-docs-pack/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |
| `references/` | Референсные материалы |

**Выход:** `docs/features/<feature>/`

---

### 6. fan-forge — Фабрика расширений и скилов

**Назначение:** Самая сложная тула — создаёт новые расширения и скилы для FAN (7-фазный пайплайн). Содержит шаблоны для генерации.

**Директория:** `skills/fan-forge/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |
| `references/` | Референсные материалы |
| `scripts/test-load-extension.sh` | Скрипт: загрузка расширения для теста |
| `scripts/validate-extension.sh` | Скрипт: валидация расширения |
| `templates/extensions/command-extension.ts` | Шаблон: command-based extension |
| `templates/extensions/event-extension.ts` | Шаблон: event-based extension |
| `templates/extensions/gate-extension.ts` | Шаблон: gate/permission extension |
| `templates/extensions/tool-extension.ts` | Шаблон: tool-based extension |
| `templates/extensions/ui-extension.ts` | Шаблон: UI-component extension |
| `templates/extensions/multi-extension/` | Шаблон: многомодульное расширение (index.ts, tools.ts, events.ts, utils.ts) |
| `templates/extensions/with-deps/` | Шаблон: расширение с npm-зависимостями |
| `templates/skills/basic-skill/SKILL.md` | Шаблон: базовый скил |

**7-фазный пайплайн:**
1. Разведка (explore codebase)
2. Планирование (design)
3. Реализация
4. Верификация
5. Документация
6. Тестирование
7. Установка

---

### 7. idea-lab — Исследование идей

**Назначение:** Исследует идеи любого типа (технические, бизнес, креативные) — опрос, веб-поиск, SWOT, брейншторм, план действий.

**Директория:** `skills/idea-lab/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |
| `references/` | Референсные материалы |

**Выход:** `docs/research/idea-lab/<kebab-case>/<Название>.md`

---

### 8. feature-pipeline — TDD-пайплайн фичи

**Назначение:** Полный TDD-пайплайн от roadmap до готового результата. Проходит по всем этапам и функциям roadmap, выполняет: реализация → верификация → тестирование → коммит.

**Директория:** `skills/feature-pipeline/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |

**Вход:** `docs/features/<slug>/roadmap.md`
**Выход:** Готовая реализация + документация + коммиты

---

### 9. feature-roadmap — TDD-роадмапа

**Назначение:** Генерирует TDD-роадмапу в стиле чеклиста на основе спецификации фичи. Парсит спецификацию, извлекает функции, группирует по этапам, создаёт roadmap.md.

**Директория:** `skills/feature-roadmap/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |

**Лимиты:** 3–8 этапов, 3–15 функций. При превышении — делегирование `research-spec-generator` для разбивки.
**Выход:** `docs/features/<slug>/roadmap.md`

---

### 10. repo-explorer — Исследование репозиториев

**Назначение:** Исследует Git-репозитории (GitHub и локальные). Составляет схему структуры, определяет технологии, выявляет модули, извлекает символы (AST), генерирует отчёт.

**Директория:** `skills/repo-explorer/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |
| `references/` | Референсные материалы |

**Выход:** `docs/repo-research/<repo-name>.md`

---

### 11. research-spec-generator — Исследование + спецификация

**Назначение:** Исследует тему по запросу, проводит интервью, создаёт файл спецификации. Цикл: исследование → анализ → уточнения → спецификация.

**Директория:** `skills/research-spec-generator/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |
| `README.md` | Документация |
| `references/` | Референсные материалы |

**Выход:** `docs/specs/<topic>.md`

---

### 12. stack-overflow-agents-skill — Stack Overflow для агентов (standalone)

**Назначение:** Самостоятельная версия скила для работы со Stack Overflow for Agents (SOFA). Отдельная от `extensions/stack-overflow-agents/`.

**Директория:** `skills/stack-overflow-agents-skill/`

| Файл | Назначение |
|------|-----------|
| `SKILL.md` | Инструкции скила |
| `package.json` | Метаданные |

**Примечание:** Существует также гибридная версия `extensions/stack-overflow-agents/SKILL.md` (расширение + скил).

## Пути и приоритет обнаружения

| Приоритет | Директория | Scope |
|-----------|-----------|-------|
| 1 (высший) | `.fan/skills/` | Project |
| 2 | `~/.fan/agent/skills/` | User |
| 3 | `~/.agents/skills/` | Global |
| 4 | Встроенные (исходники в проекте) | Built-in |

При коллизии имён побеждает с более высоким приоритетом.

## Инфраструктура

| Файл | Назначение |
|------|-----------|
| `packages/coding-agent/src/core/skills.ts` | Ядро: парсинг, валидация, загрузка (479 строк) |
| `packages/coding-agent/docs/skills.md` | Полная документация формата скилов |
| `packages/coding-agent/examples/sdk/04-skills.ts` | SDK пример |
| `packages/coding-agent/test/skills.test.ts` | Тесты скилов |
| `packages/coding-agent/test/sdk-skills.test.ts` | SDK интеграционные тесты |
| `packages/coding-agent/test/fixtures/skills/` | 17 тестовых фикстур (валидация, коллизии, вложенность) |
| `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts` | TUI-компонент вызова скила |

## Использование

```bash
# Через slash-команду (если enableSkillCommands: true)
/skill:repo-explorer
/skill:bug-fix

# По имени скила
/skill:auto-tests

# Установка из FAN Store
fan store install repo-explorer
```