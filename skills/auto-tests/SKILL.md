---
name: auto-tests
description: >
  Автономная генерация тестов для непокрытых модулей. Находит модули без тестового покрытия,
  пишет тесты по конвенциям проекта, запускает, итеративно фиксит до зелёных.
  Поддерживает Kotlin, Java, TypeScript, Python, Rust, Go, C#.
  Два режима: автономный (скан всего проекта) и целевой (--target для вызова из orchestrator'а).
compatibility: >
  Requires build/test infrastructure (Maven, Gradle, npm, pytest, cargo, go test, dotnet).
  No additional dependencies.
---

# Auto Tests

Автономный агент генерации тестов. Обходит проект, находит модули без покрытия,
генерирует тесты и итеративно фиксят до зелёных. Работает как standalone и как
подмодуль внешнего orchestrator'а.

---

## Когда использовать

- Пользователь говорит «напиши тесты», «добавь покрытие», «auto-tests»
- Нужно покрыть тестами новый или существующий проект
- Orchestrator вызывает с `--target` для тестирования конкретного модуля
- В рамках CI/CD pipeline как внешний модуль

---

## Когда НЕ использовать

- Пользователь хочет исправить падающий тест (→ bug-fix)
- Пользователь хочет рефакторить существующие тесты
- Пользователь хочет добавить конкретный тест-кейс вручную
- Проект не имеет build/test инфраструктуры и пользователь не хочет её настраивать

---

## Парсинг входных данных

Входная строка передаётся после `User:`.

### Автономный режим (default)
```
auto-tests [путь_к_проекту]
```
- `[путь_к_проекту]` — опционально, default: `ctx.cwd`
- Skill сам сканирует проект, находит непокрытые модули, приоритизирует, пишет тесты

### Целевой режим (для orchestrator)
```
auto-tests --target <file_or_dir> [--type unit|integration|e2e] [--max-attempts N]
```
- `--target` — конкретный файл или директория для тестирования (обязателен в этом режиме)
- `--type` — тип тестов (default: по конвенции проекта)
- `--max-attempts` — макс. итераций фикса (default: 5)

### Флаги
- `--dry-run` — только показать что бы было сделано, без записи файлов
- `--focus <pattern>` — фильтр модулей по паттерну имени/пути
- `--no-confirm` — не спрашивать подтверждение перед записью (для orchestrator'а)
- `--stop-on-fail` — остановиться при первом модуле который не удалось покрыть

---

## Системный промпт

Ты — Auto Test Agent. Твоя задача: найти модули без тестового покрытия, написать для них
тесты, запустить и итеративно фиксить до зелёных. Ты работаешь автономно: сам сканируешь
проект, определяешь инфраструктуру, генерируешь тесты по конвенциям, запускаешь, анализируешь
ошибки и фиксишь.

Твой подход:
1. **Понять проект.** Язык, build system, test runner, конвенции.
2. **Найти бреши.** Какие модули покрыты, какие нет.
3. **Приоритизировать.** Сначала важные модули.
4. **Генерировать.** Читая исходный код, писать осмысленные тесты.
5. **Верифицировать.** Запускать, анализировать ошибки, фиксить. Повторять.
6. **Отчитаться.** Структурированный результат.

---

## Процесс

### Фаза 0: Парсинг и инициализация

**0.1. Определи режим работы**

```
Если вход содержит --target → целевой режим
Иначе → автономный режим
```

**0.2. Определи рабочую директорию**

```
Автономный: первый аргумент без флагов → project dir, иначе ctx.cwd
Целевой: --target резолвится относительно ctx.cwd
```

**0.3. Прочитай reference-файлы (по требованию)**

Перед началом работы загрузи нужные reference:
- [language-detection.md](references/language-detection.md) — для определения инфраструктуры
- [test-conventions.md](references/test-conventions.md) — для маппинга source → test
- [test-patterns.md](references/test-patterns.md) — для паттернов генерации тестов

---

### Фаза 1: Discovery — определение инфраструктуры

**1.1. Детект языка и build system**

Следуй priority table из [language-detection.md](references/language-detection.md).

```bash
cd $PROJECT_DIR

# Check markers in priority order
[ -f "build.gradle.kts" ] && echo "GRADLE_KOTLIN"
[ -f "build.gradle" ] && echo "GRADLE"
[ -f "pom.xml" ] && echo "MAVEN"
[ -f "Cargo.toml" ] && echo "CARGO"
[ -f "package.json" ] && echo "NPM"
[ -f "pyproject.toml" ] && echo "PYTHON_POETRY"
[ -f "setup.py" ] && echo "PYTHON_SETUP"
[ -f "go.mod" ] && echo "GO"
[ -f "*.csproj" ] && echo "DOTNET"
```

**1.2. Детект test runner**

```bash
# Gradle
grep -E "junit|kotest|testng" build.gradle.kts 2>/dev/null

# npm
grep -E "jest|vitest|mocha" package.json 2>/dev/null

# Python
grep -E "pytest|unittest" pyproject.toml setup.cfg pytest.ini 2>/dev/null
```

Подробнее — в [language-detection.md](references/language-detection.md).

**1.3. Определи команды запуска**

Из [language-detection.md](references/language-detection.md) — Test Run Commands table.

Проверь что команды работают:
```bash
# Gradle
./gradlew test --dry-run 2>&1 | head -5

# Jest
npx jest --passWithNoTests 2>&1 | head -5

# pytest
python -m pytest --collect-only 2>&1 | head -5
```

**1.4. Если test infrastructure отсутствует**

Сообщи пользователю:
```
⚠️ Test infrastructure not detected in $PROJECT_DIR
Detected: language=X, build=Y, but no test runner configured.
```
Спроси через `question`:
- Setup test infrastructure (напиши команды/конфиг для setup)
- Skip and report

---

### Фаза 2: Scan — поиск непокрытых модулей

**2.1. Найти все source файлы**

```bash
# Kotlin/Java (Gradle)
find . -path "*/src/main/*" \( -name "*.kt" -o -name "*.java" \) -not -path "*/build/*"

# TypeScript
find . -name "*.ts" -not -name "*.test.ts" -not -name "*.spec.ts" \
  -not -path "*/__tests__/*" -not -path "*/node_modules/*" -not -path "*/dist/*"

# Python
find . -name "*.py" -not -name "test_*.py" -not -name "*_test.py" \
  -not -name "conftest.py" -not -path "*/venv/*" -not -path "*/__pycache__/*"

# Rust
find src -name "*.rs" -not -path "*/target/*"

# Go
find . -name "*.go" -not -name "*_test.go" -not -path "*/vendor/*"
```

**2.2. Для каждого source файла — проверить наличие теста**

Используй mapping rules из [test-conventions.md](references/test-conventions.md).

```bash
# Example: Kotlin
for source in $(find . -path "*/src/main/kotlin/*" -name "*.kt" -not -path "*/build/*"); do
  # Вычислить ожидаемый test path
  test_path=$(echo "$source" | sed 's|src/main/|src/test/|; s|\.kt$|Test.kt|')
  if [ ! -f "$test_path" ]; then
    echo "UNCOVERED: $source"
  fi
done
```

**2.3. Исключить файлы которые не нужно тестировать**

Пропускай:
- Data classes / records без логики
- Enums без methods
- Constants files
- Generated code (build/, generated/, *Generated*)
- Main entry points (main(), @SpringBootApplication, @Composable root)
- Configuration files
- DSL builders без сложной логики

Для определения — прочти файл и проверь: есть ли в нём логика (if/when/match, loops, function calls, throws).

**2.4. Построить список непокрытых модулей**

```
UNCOVERED_MODULES=()
for source in ...; do
  if [ ! -f "$test_path" ] && [ "$has_logic" = true ]; then
    UNCOVERED_MODULES+=("$source")
  fi
done
```

---

### Фаза 3: Prioritize — ранжирование

Если режим целевой (`--target`) — пропусти эту фазу, переходи к Фазе 4 с указанным target.

**3.1. Скоринг**

Для каждого непокрытого модуля вычисли score по формуле из
[test-conventions.md](references/test-conventions.md) — Priority Scoring:

```
score = (public_api * 3) + (dependencies * 2) + (complexity * 1) + (domain * 2)
```

Быстрая оценка:
```bash
# Public API count
public_count=$(grep -cE "fun |def |func |public |export " "$source" 2>/dev/null || echo 0)

# Dependencies (how many files import this)
import_count=$(rg -l "$(basename $source .kt)" --type kt 2>/dev/null | wc -l || echo 0)

# Complexity (LOC)
loc=$(wc -l < "$source")

# Domain (heuristic by path)
domain_score=0
echo "$source" | grep -qiE "domain|core|business|service|usecase|logic" && domain_score=2
echo "$source" | grep -qiE "util|constant|config|model|dto|entity" && domain_score=0
```

**3.2. Сортировка**

Отсортируй по score (убывание). Это порядок работы.

**3.3. Показать план**

Выведи пользователю таблицу:
```
## Найдено N непокрытых модулей:

| # | Модуль | Public API | Dependencies | Score |
|---|--------|-----------|-------------|-------|
| 1 | domain/service/AuthService.kt | 8 | 12 | 34 |
| 2 | data/repository/UserRepositoryImpl.kt | 5 | 8 | 23 |
| 3 | ... | | | |
```

Спроси через `question`:
- Начать со всех по порядку
- Выбрать конкретные модули
- Изменить порядок

---

### Фаза 4: Generate — генерация тестов

Для каждого модуля из приоритизированного списка (или `--target`):

**4.1. Прочитай исходный код**

```
read <source_file>
```

Определи:
- Package / module
- Imports (зависимости)
- Public functions / methods / properties
- External dependencies (что мокать)
- Return types, exception types
- Existing patterns (стиль, аннотации)

**4.2. Прочитай существующие тесты в проекте** (для style reference)

```bash
# Найти существующий тестовый файл
find . -name "*Test.kt" -o -name "*.test.ts" | head -5

# Прочитай один-два для understanding стиля
```

Следуй стилю проекта: если tests используют `describe/it` — используй `describe/it`.
Если `@Nested` + `@DisplayName` — используй их.

**4.3. Определи test location**

По convention из [test-conventions.md](references/test-conventions.md).

Если target директория не существует — создай:
```bash
mkdir -p $(dirname "$test_path")
```

**4.4. Напиши тесты**

Используй паттерны из [test-patterns.md](references/test-patterns.md).

Для каждого public method:
- 1 happy path test
- 1+ error path tests (если применимо)
- 1+ edge case tests (если применимо)

**4.5. Пиши ОДИН тестовый файл за раз.** Не генерируй все файлы разом.
Для каждого файла: напиши → запусти → фикс → следующий.

---

### Фаза 5: Validate — запуск и фикс

**5.1. Запуск тестов**

```bash
# Конкретный файл
./gradlew test --tests "com.example.FeatureTest" 2>&1
# или
npx jest src/foo/bar.test.ts 2>&1
# или
python -m pytest tests/test_foo.py -v 2>&1
```

**5.2. Анализ результата**

Проверь exit code и output:
- **Exit 0, все pass** → ✅ Готово, следующий модуль
- **Compilation error** → Прочитай ошибку, фиксим импорты/типы
- **Test failures** → Прочитай assertion error, фиксим ожидания или код
- **Import/resolve errors** → Фиксим пути и зависимости

**5.3. Итеративный фикс (max attempts loop)**

```
FOR attempt = 1 TO max_attempts:
  1. Запустить тесты для текущего файла
  2. Если все pass → BREAK (успех)
  3. Проанализировать ошибки:
     - Compilation → исправить типы/импорты
     - Assertion failure → исправить ожидания (перечитай source!)
     - Mock error → исправить setup моков
     - Missing dependency → добавить в build.gradle/package.json
  4. Применить фикс через `edit`
  5. Перезапустить

  IF attempt == max_attempts:
    LOG "⚠️ Failed to fix tests for <module> after N attempts"
    BREAK (partial)
```

**5.4. Правила фикса**

- **Перечитай исходный код** перед фиксом — возможно ты неправильно понял API
- **Перечитай ошибку** внимательно — не угадывай
- **Минимальный фикс** — меняй только то что нужно
- **НЕ меняй исходный код** (source module) — только тесты
  - Исключение: если в source баг (опечатка в API) — зафиксируй отдельно
- **Если test runner не найден** — установи зависимости, добавь в build config

---

### Фаза 6: Report — отчёт

**6.1. Человекочитаемый отчёт** (всегда) — таблица с модулями, статусами, тестами, attempts. См. [report-template.md](references/report-template.md).

**6.2. Структурированный результат** (для orchestrator — всегда в конце) — парсимая секция `## auto-tests result` с полями: target, status, modules_processed, tests_created/passing/failing, files_written, summary. См. [report-template.md](references/report-template.md).

---

## Обработка ошибок

| Ситуация | Действие |
|----------|----------|
| Язык/build system не определён | Сообщить, спросить пользователя |
| Test runner не найден | Предложить setup, спросить |
| Нет непокрытых модулей | Сообщить "All covered!", завершить |
| Все source файлы — data classes | Сообщить "Nothing to test", завершить |
| Тест не компилируется после 5 attempts | Mark as partial, перейти к следующему |
| Тест runner crash (не связан с тестами) | Сообщить, предложить проверить setup |
| Source код содержит баг (тест reveals bug) | НЕ фиксить source, зафиксировать в отчёте |
| `--target` указывает на несуществующий файл | Сообщить и остановить |
| Disk full / permission denied | Сообщить, остановить |
| Проект очень большой (>100 непокрытых модулей) | Спросить: сколько модулей обработать |
| Max attempts достигнут | Mark as partial, continue with next module |

---

## Чеклист: ЧТО ДОЛЖЕН делать

1. ✅ Определять язык, build system, test runner по файловым маркерам
2. ✅ Читать reference-файлы перед началом работы
3. ✅ Искать source файлы и маппить на test файлы по конвенциям
4. ✅ Исключать файлы без логики (data classes, constants, generated)
5. ✅ Приоритизировать по public API, dependencies, complexity, domain
6. ✅ Показывать план перед началом (в автономном режиме)
7. ✅ Читать исходный код модуля перед написанием тестов
8. ✅ Читать существующие тесты для понимания стиля проекта
9. ✅ Писать тесты по AAA pattern (Arrange → Act → Assert)
10. ✅ Тестировать public API, не implementation details
11. ✅ Запускать тесты после каждого файла
12. ✅ Итеративно фиксить ошибки (max 5 attempts)
13. ✅ НЕ менять исходный код (только тесты)
14. ✅ Выдавать структурированный отчёт в конце
15. ✅ Выдавать парсимую секцию `## auto-tests result` для orchestrator'а

## Чеклист: ЧТО НЕ ДОЛЖЕН делать

1. ❌ Писать тесты без чтения исходного кода
2. ❌ Генерировать все тесты разом без запуска
3. ❌ Менять source код для прохождения тестов
4. ❌ Игнорировать ошибки компиляции
5. ❌ Мокать всё подряд — мокать только внешние зависимости
6. ❌ Писать тривиальные тесты (getters, data classes)
7. ❌ Использовать `!!` / `println` / hardcoded values (если CLAUDE.md запрещает)
8. ❌ Пропускать верификацию (запуск тестов)
9. ❌ Писать тесты для generated кода
10. ❌ Бесконечно фиксить — max 5 attempts на файл

---

## Пример использования

Примеры автономного и целевого режима (консольный вывод, `auto-tests result` блок) — см. [report-template.md](references/report-template.md).

---

## Правила

1. **Read before write.** Не пиши тесты без чтения исходного кода.
2. **One file at a time.** Написал → запустил → фикснул → следующий.
3. **Follow project style.** Читай существующие тесты, следуй их конвенциям.
4. **Don't fix source.** Тестируй что есть, не меняй source для прохождения тестов.
5. **Max 5 attempts.** Если не вышло — partial, двигайся дальше.
6. **Structured output.** Секция `## auto-tests result` всегда в конце.
7. **Universal first.** Автодетект инфраструктуры, fallback к вопросу пользователю.
8. **Skip trivia.** Data classes, constants, generated code — не тестируем.
