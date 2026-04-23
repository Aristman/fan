# Test Conventions Reference

Маппинг source файлов → test файлов по языкам. Используется для определения какие модули покрыты тестами, а какие нет.

---

## Общий алгоритм

```
1. Найти все source файлы (по расширению)
2. Для каждого source файла → вычислить ожидаемый test файл (по convention)
3. Проверить существует ли test файл
4. Если нет → модуль непокрыт
```

---

## Kotlin / Java (Gradle)

### Source location
```
src/main/kotlin/com/example/app/module/Feature.kt
src/main/java/com/example/app/module/Feature.java
```

### Test location
```
src/test/kotlin/com/example/app/module/FeatureTest.kt
src/test/java/com/example/app/module/FeatureTest.java
```

### Mapping rule
```
source = src/main/{kotlin|java}/com/example/app/module/Feature.{kt|java}
  ↓
  Replace: src/main/ → src/test/
  Replace: .{kt|java} → Test.{kt|java}
test  = src/test/{kotlin|java}/com/example/app/module/FeatureTest.{kt|java}
```

### Multi-module Gradle
```
module-a/src/main/kotlin/com/example/Feature.kt
  ↓
module-a/src/test/kotlin/com/example/FeatureTest.kt
```

Scan: `find . -path "*/src/main/kotlin/*" -name "*.kt"` → map each

---

## TypeScript / JavaScript (Jest / Vitest)

### Convention A: Co-located tests
```
src/modules/auth/login.ts
src/modules/auth/login.test.ts
src/modules/auth/login.spec.ts
```

### Convention B: __tests__ directory
```
src/modules/auth/login.ts
src/modules/auth/__tests__/login.test.ts
```

### Convention C: Root tests directory (less common)
```
src/modules/auth/login.ts
tests/auth/login.test.ts
```

### Detection priority
1. Check co-located: `{source}.test.{ext}` or `{source}.spec.{ext}`
2. Check `__tests__/`: `{dir}/__tests__/{name}.test.{ext}`
3. Check project-level `tests/` dir (if exists)
4. Check `package.json` → `jest.config` → `testMatch` / `testRegex`

### Mapping for scan
```bash
# Source files
find src -name "*.ts" -not -name "*.test.ts" -not -name "*.spec.ts" -not -path "*/__tests__/*" -not -path "*/node_modules/*"

# For each source, check:
source="src/modules/auth/login.ts"
# Possible test locations:
${source}.test.ts
${source}.spec.ts
$(dirname $source)/__tests__/$(basename $source .ts).test.ts
```

---

## Python (pytest / unittest)

### Convention A: tests/ mirror
```
src/mypackage/module.py
tests/test_module.py
```

### Convention B: tests/ with subdirs
```
src/mypackage/sub/module.py
tests/sub/test_module.py
```

### Convention C: In-package tests
```
src/mypackage/module.py
src/mypackage/test_module.py
```

### Detection priority
1. Check `tests/test_{name}.py` in project root
2. Check `tests/{subdir}/test_{name}.py`
3. Check co-located: `src/mypackage/test_{name}.py`
4. Check `conftest.py` for custom test paths

### Mapping for scan
```bash
# Source files
find src -name "*.py" -not -name "test_*.py" -not -name "*_test.py" -not -name "conftest.py"

# For each source, check:
source="src/mypackage/module.py"
name=$(basename $source .py)
# Possible test locations:
tests/test_${name}.py
tests/$(echo $source | sed 's|src/||;s|/|_|g;s|\.py$||')/test_${name}.py
$(dirname $source)/test_${name}.py
```

---

## Rust

### Convention A: Unit tests (in-source)
```rust
// src/lib.rs or src/foo/bar.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_something() {
        // ...
    }
}
```

### Convention B: Integration tests
```
tests/integration_test.rs      // tests/ dir, NOT src/
tests/common/mod.rs            // shared helpers
```

### Detection for Rust
```bash
# Source files (library code)
find src -name "*.rs" -not -path "*/target/*"

# For each source file, check for #[cfg(test)] mod tests
rg '#\[cfg\(test\)\]' $source_file && echo "HAS_UNIT_TESTS"

# Integration tests (separate files)
ls tests/*.rs 2>/dev/null
```

### Coverage assessment
- Source has `#[cfg(test)]` block → covered (unit)
- `tests/` has corresponding file → covered (integration)
- Neither → uncovered

---

## Go

### Convention: Co-located
```
pkg/foo/bar.go
pkg/foo/bar_test.go
```

### Mapping rule
```
source.go → source_test.go (same directory)
```

### Scan
```bash
# Source files (non-test)
find . -name "*.go" -not -name "*_test.go" -not -path "*/vendor/*"

# For each, check:
${source%.go}_test.go
```

---

## C# (.NET)

### Convention
```
src/MyApp/Services/UserService.cs
tests/MyApp.Tests/Services/UserServiceTests.cs
```

### Mapping rule
```
Source project: src/{ProjectName}/
Test project: tests/{ProjectName}.Tests/ or tests/{ProjectName}Tests/
Same relative path within project.
```

### Scan
```bash
# Source files
find src -name "*.cs" -not -path "*/obj/*" -not -path "*/bin/*"

# Test projects
find tests -name "*.csproj"

# For each source, find corresponding test project and check:
# tests/{ProjectName}.Tests/{relative_path_from_src_project}/test_{name}.cs
# tests/{ProjectName}.Tests/{relative_path_from_src_project}/{Name}Tests.cs
```

---

## Priority Scoring (для ранжирования непокрытых модулей)

При сортировке непокрытых модулей используй скоринг:

| Фактор | Вес | Как измерять |
|--------|------|-------------|
| Public API surface | 3 | Кол-во `public`/`open` функций и классов |
| Dependencies (на него) | 2 | Сколько других файлов импортируют этот модуль |
| Complexity | 1 | Размер файла (LOC), кол-во ветвлений |
| Domain importance | 2 | По имени/пути (domain/, core/, business/) vs util/, constants/ |

```
score = (public_api * 3) + (dependencies * 2) + (complexity * 1) + (domain * 2)
```

Сортируй по убыванию score. Высший priority → пишем тесты первым.
