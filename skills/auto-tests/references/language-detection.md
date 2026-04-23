# Language Detection Reference

Автоматическое определение языка, build system и test runner по файловым маркерам.

---

## Detection Order

Проверяй маркеры **сверху вниз**. Первый match — побеждает.

## Priority Table

| Приоритет | Маркер(ы) | Язык | Build System | Test Runner(s) | Test Config |
|----------|-----------|------|-------------|----------------|-------------|
| 1 | `build.gradle.kts` + `*.kt` | Kotlin | Gradle (Kotlin DSL) | JUnit5, Kotest, MockK | `build.gradle.kts` (dependencies) |
| 2 | `build.gradle` + `*.kt` | Kotlin | Gradle (Groovy DSL) | JUnit5, Kotest, MockK | `build.gradle` |
| 3 | `build.gradle.kts` / `build.gradle` + `*.java` | Java | Gradle | JUnit5, TestNG, Mockito | `build.gradle.kts` |
| 4 | `pom.xml` | Java | Maven | JUnit5, TestNG, Mockito | `pom.xml` |
| 5 | `Cargo.toml` | Rust | Cargo | cargo test (built-in) | `Cargo.toml` [dev-dependencies] |
| 6 | `package.json` + `tsconfig.json` | TypeScript | npm/pnpm/yarn | Jest, Vitest, Mocha | `package.json` (devDependencies) |
| 7 | `package.json` + `*.js` (no tsconfig) | JavaScript | npm/pnpm/yarn | Jest, Vitest, Mocha | `package.json` |
| 8 | `pyproject.toml` | Python | pip/poetry/uv | pytest, unittest | `pyproject.toml` [tool.pytest] |
| 9 | `setup.py` / `setup.cfg` | Python | pip/setuptools | pytest, unittest | `setup.cfg` / `pytest.ini` |
| 10 | `go.mod` | Go | Go modules | go test (built-in) | `*_test.go` files |
| 11 | `*.csproj` | C# | .NET (dotnet) | xUnit, NUnit, MSTest | `*.csproj` |

---

## Test Runner Specific Detection

### Gradle (Kotlin/Java)

Проверь `build.gradle.kts` / `build.gradle` для test dependencies:

```bash
# JUnit5
grep -E "junit|jupiter" build.gradle.kts

# Kotest
grep -E "kotest" build.gradle.kts

# MockK
grep -E "mockk" build.gradle.kts
```

| Dependency в build.gradle.kts | Test Runner |
|------------------------------|-------------|
| `testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test")` | JUnit5 (likely) |
| `testImplementation("io.kotest:kotest-runner-junit5")` | Kotest |
| `testImplementation("org.junit.jupiter:junit-jupiter")` | JUnit5 |
| `testImplementation("org.testng:testng")` | TestNG |

### npm (TypeScript/JavaScript)

Проверь `package.json` devDependencies:

```bash
grep -E "jest|vitest|mocha|@testing-library" package.json
```

| Dependency в package.json | Test Runner | Framework |
|--------------------------|-------------|-----------|
| `"jest"` или `"@jest/globals"` | Jest | |
| `"vitest"` | Vitest | |
| `"mocha"` | Mocha | + chai/sinon |
| `"@testing-library/react"` | Jest/Vitest | React |
| `"@angular/core"` | Karma/Jest | Angular |
| `"vue"` + `"vitest"` | Vitest | Vue |

Конфиг-файлы:
- `jest.config.ts` / `jest.config.js` → Jest
- `vitest.config.ts` → Vitest

### Python

```bash
grep -E "pytest|unittest" pyproject.toml setup.cfg pytest.ini setup.py 2>/dev/null
```

| Маркер | Test Runner |
|--------|-------------|
| `[tool.pytest.ini_options]` в pyproject.toml | pytest |
| `pytest.ini` существует | pytest |
| `conftest.py` существует | pytest |
| `unittest` в setup.py deps | unittest |

### Rust

```bash
grep -E "\[dev-dependencies\]" Cargo.toml
```

Rust использует `cargo test` всегда. Дополнительные фреймворки:
- `proptest` — property-based testing
- `criterion` — benchmarks
- `mockall` — mocking

### Go

```bash
ls *_test.go 2>/dev/null | head -5
```

Go использует `go test` всегда. Никакого дополнительного setup.

---

## Test Run Commands

| Язык | Команда | Детали |
|------|---------|--------|
| Kotlin/Java (Gradle) | `./gradlew test` | Все тесты |
| Kotlin/Java (Gradle) | `./gradlew :module:test` | Конкретный модуль |
| Kotlin/Java (Gradle) | `./gradlew test --tests "com.example.FooTest"` | Конкретный тест |
| Java (Maven) | `mvn test` | Все тесты |
| Java (Maven) | `mvn test -Dtest=FooTest` | Конкретный тест |
| TypeScript (Jest) | `npx jest` | Все тесты |
| TypeScript (Jest) | `npx jest --testPathPattern="foo"` | По паттерну |
| TypeScript (Jest) | `npx jest src/foo/bar.test.ts` | Конкретный файл |
| TypeScript (Vitest) | `npx vitest run` | Все тесты |
| TypeScript (Vitest) | `npx vitest run src/foo/bar.test.ts` | Конкретный файл |
| Python (pytest) | `python -m pytest` | Все тесты |
| Python (pytest) | `python -m pytest tests/test_foo.py` | Конкретный файл |
| Python (pytest) | `python -m pytest -k "test_name"` | По имени |
| Python (unittest) | `python -m unittest discover` | Все тесты |
| Rust | `cargo test` | Все тесты |
| Rust | `cargo test --test integration_test` | Конкретный интеграционный тест |
| Rust | `cargo test module_name` | Тесты модуля |
| Go | `go test ./...` | Все тесты |
| Go | `go test ./path/to/package/...` | Конкретный пакет |
| C# (dotnet) | `dotnet test` | Все тесты |

---

## No Test Infrastructure Detected

Если ни один маркер не найден, но исходный код есть:

1. Проверь `ctx.cwd` на наличие исходников (по расширениям)
2. Если исходники есть но нет build/test инфраструктуры — сообщи пользователю
3. Предложи варианты: setup test infrastructure или skip
4. НЕ пиши тесты без возможности их запустить
