# Auto Tests

Автономная генерация тестов для непокрытых модулей проекта.

## Описание

Skill находит модули без тестового покрытия, пишет тесты по конвенциям проекта,
запускает и итеративно фиксит до зелёных. Поддерживает Kotlin, Java, TypeScript,
Python, Rust, Go, C#.

Два режима работы:
- **Автономный** — сканирует весь проект, приоритизирует, пишет тесты для всех непокрытых модулей
- **Целевой** (`--target`) — для вызова из orchestrator'а, тестирует конкретный файл/модуль

## Установка

Глобально:
```bash
cp -r auto-tests/ ~/.fan/agent/skills/auto-tests/
```

Проектно:
```bash
cp -r auto-tests/ .fan/skills/auto-tests/
```

## Использование

### Автономный режим
```
auto-tests                           # текущий проект
auto-tests ~/projects/my-kotlin-app  # конкретный проект
```

### Целевой режим (orchestrator)
```
auto-tests --target src/main/kotlin/NetworkClient.kt
auto-tests --target src/modules/auth/ --type unit
auto-tests --target src/foo.py --max-attempts 10 --no-confirm
```

### Флаги

| Флаг | Описание | Default |
|------|----------|---------|
| `--target <path>` | Конкретный файл или директория | (автономный режим) |
| `--type <type>` | Тип тестов: unit, integration, e2e | по конвенции проекта |
| `--max-attempts N` | Макс. итераций фикса на файл | 5 |
| `--dry-run` | Показать план без записи | false |
| `--focus <pattern>` | Фильтр модулей по паттерну | все |
| `--no-confirm` | Не спрашивать подтверждения | false |
| `--stop-on-fail` | Стоп при первом неудачном модуле | false |

### Orchestrator Integration

Для programmatic вызова из другого skill/extension:

1. Вызвать с `--target` + `--no-confirm`
2. Парсить output — искать секцию `## auto-tests result`
3. Ключевые поля:
   - `status`: passed / failed / partial
   - `tests_created`: N
   - `tests_passing`: N
   - `tests_failing`: N
   - `files_written`: [paths]
   - `summary`: текст

## Поддерживаемые языки

| Язык | Build System | Test Runner |
|------|-------------|-------------|
| Kotlin | Gradle | JUnit5, Kotest |
| Java | Gradle, Maven | JUnit5, TestNG |
| TypeScript | npm/pnpm | Jest, Vitest |
| JavaScript | npm/pnpm | Jest, Vitest, Mocha |
| Python | pip/poetry | pytest, unittest |
| Rust | Cargo | cargo test |
| Go | Go modules | go test |
| C# | .NET | xUnit, NUnit |

## Helper Scripts

### coverage-scan.sh
Быстрый скан покрытия — показывает source файлы без соответствующих тестов.

```bash
bash ~/.fan/agent/skills/auto-tests/scripts/coverage-scan.sh [project_dir]
```

Output:
```
PROJECT_TYPE: gradle
---
UNCOVERED: ./src/main/kotlin/domain/service/AuthService.kt (api_count=8)
UNCOVERED: ./src/main/kotlin/data/repository/UserRepoImpl.kt (api_count=5)
```

## Структура файлов

```
auto-tests/
├── SKILL.md                      # Основной skill-файл
├── README.md                     # Этот файл
├── references/
│   ├── language-detection.md     # Детект языка, build system, test runner
│   ├── test-conventions.md       # Source → Test path mapping
│   └── test-patterns.md          # Паттерны и шаблоны тестов
└── scripts/
    └── coverage-scan.sh          # Быстрый скан покрытия
```

## Примеры

### Kotlin/Gradle проект
```
auto-tests ~/projects/my-app

→ Найдено 8 непокрытых модулей
→ Приоритет: AuthService.kt (score: 34)
→ Написано 7 тестов, все проходят ✅
→ Приоритет: UserRepository.kt (score: 23)
→ Написано 5 тестов, 3/5 pass → фикс → 5/5 ✅
→ Итого: 15 тестов создано, 15 pass
```

### Python/pytest проект
```
auto-tests --target src/analytics/calculator.py

→ Написано 4 теста для calculator.py
→ 4/4 pass ✅
→ Файл: tests/test_calculator.py
```
