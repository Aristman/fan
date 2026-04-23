# Report Template & Examples

Форматы отчётов и примеры использования auto-tests.

---

## Человекочитаемый отчёт (Phase 6.1)

Выдаётся всегда в конце работы.

```markdown
## Auto Tests Report

### Проект: <name>
### Язык: <language> | Build: <build system> | Test runner: <test runner>

### Результаты

| # | Модуль | Статус | Тесты создано | Pass | Fail | Attempts |
|---|--------|--------|--------------|------|------|----------|
| 1 | domain/service/AuthService.kt | ✅ Passed | 7 | 7 | 0 | 1 |
| 2 | data/repository/UserRepoImpl.kt | ⚠️ Partial | 5 | 3 | 2 | 5 |
| 3 | domain/model/Config.kt | ⏭️ Skipped | 0 | - | - | - |

### Итого
- Модулей обработано: N
- Тестов создано: N
- Из них проходят: N
- Coverage improvement: +N% (estimated)
```

---

## Структурированный результат для orchestrator'а (Phase 6.2)

Выдаётся всегда в конце работы. Парсится по маркерам.

```markdown
## auto-tests result
### target: <file_or_dir_or_project>
- status: passed | failed | partial
- modules_processed: N
- tests_created: N
- tests_passing: N
- tests_failing: N
- files_written: [path1, path2, ...]
- summary: <краткое описание — что сделано, что не удалось>
```

**Маркеры для парсинга:**
- `### target:` → целевой модуль/проект
- `- status:` → общий результат
- `- modules_processed:` → кол-во обработанных
- `- tests_created/passing/failing:` → статистика
- `- files_written:` → список созданных файлов (для cleanup если нужно)
- `- summary:` → текстовое резюме

---

## Пример использования

### Автономный режим

```
User: auto-tests ~/projects/my-kotlin-app

→ Discovery: Kotlin + Gradle, JUnit5 + MockK detected
→ Scan: 23 source files found, 15 covered, 8 uncovered
→ Priority:
  # | Module                        | Score |
  --|-------------------------------|-------|
  1 | domain/service/AuthService.kt | 34    |
  2 | data/repo/UserRepoImpl.kt     | 23    |
  3 | domain/usecase/LoginUC.kt     | 18    |
→ Writing tests for #1 AuthService.kt...
  → 7 tests written
  → Running: ./gradlew test --tests AuthServiceTest
  → ✅ 7/7 passed (attempt 1)
→ Writing tests for #2 UserRepoImpl.kt...
  → 5 tests written
  → Running: ./gradlew test --tests UserRepoImplTest
  → ❌ 3/5 failed
  → Fixing: import resolve + mock setup
  → Running again... ✅ 5/5 passed (attempt 2)
→ Report generated.
```

### Целевой режим (orchestrator)

```
User: auto-tests --target src/main/kotlin/NetworkClient.kt --no-confirm

→ Discovery: Kotlin + Gradle, JUnit5
→ Target: src/main/kotlin/NetworkClient.kt
→ Reading source... 45 lines, 3 public methods, 2 external deps
→ Writing tests: src/test/kotlin/NetworkClientTest.kt
  → 6 tests written
  → Running... ❌ 2/6 failed (mock setup issue)
  → Fixing... Running... ✅ 6/6 passed (attempt 2)

## auto-tests result
### target: src/main/kotlin/NetworkClient.kt
- status: passed
- modules_processed: 1
- tests_created: 6
- tests_passing: 6
- tests_failing: 0
- files_written: [src/test/kotlin/NetworkClientTest.kt]
- summary: 6 tests for NetworkClient, all passing
```
