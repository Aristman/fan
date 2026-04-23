# repo-explorer 🗺️

**Skill для исследования Git-репозиториев (GitHub и локальных).**

Составляет полную карту кодовой базы: структура, технологии, ключевые модули, AST-символы, C4-архитектура. Генерирует структурированный отчёт для быстрого понимания проекта.

---

## Что это

repo-explorer — это skill, который автоматически анализирует репозиторий и создаёт документ с навигацией по кодовой базе.

| Вход | Выход |
|------|-------|
| GitHub URL или путь к локальному репо | Полный отчёт в `docs/repo-research/` |

**Восемь фаз анализа:**

1. **Mapping** — получение дерева файлов (GitHub API / `git ls-files`)
2. **Filtering** — очистка от мусора (node_modules, build artifacts, media)
3. **Language Detection** — определение языков по расширениям
4. **Key Files** — извлечение README, манифестов, entry points, конфигов
5. **AST Analysis** — извлечение символов (функции, классы, интерфейсы, импорты)
6. **Architecture Overview** — определение типа (monolith, library, CLI...) + Mermaid-диаграмма
7. **C4 Architecture** — трёхуровневая модель: System Context → Container → Component
8. **Report Generation** — markdown-отчёт с полной картиной

---

## Как использовать

### Запуск

```
/skill:repo-explorer <GitHub-URL | локальный-путь>
```

**Примеры:**
```
/skill:repo-explorer https://github.com/facebook/react
/skill:repo-explorer .
/skill:repo-explorer --map https://github.com/expressjs/express
```

### Флаги

| Флаг | Описание |
|------|----------|
| `--map` | Только дерево + статистика, без глубокого анализа |
| `--analyze` | Полный анализ (по умолчанию) |
| `--sample` | Для больших репо (>10k файлов): top-level + src/ |

---

## Файловая структура

```
repo-explorer/
├── SKILL.md                      # Инструкции для LLM
└── references/
    ├── filter-patterns.md        # Паттерны исключения файлов
    ├── language-patterns.md      # AST-паттерны по языкам
    ├── key-file-patterns.md      # Правила поиска ключевых файлов
    └── c4-patterns.md            # Паттерны для C4-диаграмм
```

**Выходные файлы:**
```
docs/repo-research/<owner>-<repo>/<Название исследования>.md
.fan/cache/repo-explorer/<cache-key>.json
```

---

## Кэширование

Результаты кэшируются в `.fan/cache/repo-explorer/` с TTL 24 часа. При повторном запуске — кэш проверяется и обновляется при необходимости.

---

## Поддерживаемые языки AST

TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, C, C++, Ruby, PHP, Swift, Dart, Zig, Lua и другие. Для каждого языка — паттерны извлечения функций, классов, интерфейсов и импортов.

---

## Принципы

- **Source of truth — код.** C4-диаграммы только по реально найденным сущностям
- **Автоматический выбор глубины.** Тип архитектуры определяет уровни C4
- **Ключевые модули — не более 5–7.** Самые важные, не всё подряд
- **Следующие шаги.** Каждый отчёт заканчивается конкретными рекомендациями для дальнейшего изучения
