# Key File Patterns

Правила определения ключевых файлов репозитория для анализа.

## Приоритет поиска

Ключевые файлы ищутся в порядке приоритета. Если найден файл высшего приоритета — анализируй его.

## 1. README (описание проекта)

**Файлы:** `README.md`, `readme.md`, `README.rst`, `README.txt`, `README.adoc`, `Readme.md`

**Что извлечь:**
- Название проекта
- Краткое описание (первые 10-20 строк)
- Основные фичи (секция Features)
- Технологии (упоминания в тексте)
- Ссылки на документацию
- Quick start / installation instructions

## 2. Manifest files (зависимости и конфигурация)

### JavaScript / TypeScript
| Файл | Что извлечь |
|------|------------|
| `package.json` | name, version, description, main/module, scripts, dependencies, devDependencies, workspaces |
| `tsconfig.json` | compilerOptions (target, module, strict), include/exclude paths |
| `.eslintrc*`, `eslint.config.*` | Правила линтинга (опционально) |
| `jest.config.*`, `vitest.config.*` | Тестовая конфигурация |

### Python
| Файл | Что извлечь |
|------|------------|
| `pyproject.toml` | name, version, dependencies, optional-dependencies, scripts |
| `requirements.txt` | Список зависимостей |
| `setup.py`, `setup.cfg` | name, version, install_requires, entry_points |
| `Pipfile` | packages, dev-packages |

### Rust
| Файл | Что извлечь |
|------|------------|
| `Cargo.toml` | name, version, edition, dependencies, dev-dependencies, features, [[bin]], [lib] |
| `Cargo.lock` | Точные версии (опционально) |

### Go
| Файл | Что извлечь |
|------|------------|
| `go.mod` | module name, go version, dependencies |
| `go.sum` | Точные версии (опционально) |

### Java / Kotlin
| Файл | Что извлечь |
|------|------------|
| `build.gradle`, `build.gradle.kts` | dependencies, plugins, sourceSets |
| `pom.xml` | groupId, artifactId, version, dependencies |
| `settings.gradle` | include-ы, pluginManagement |

### Ruby
| Файл | Что извлечь |
|------|------------|
| `Gemfile` | source, gem dependencies |
| `*.gemspec` | name, version, dependencies |

### PHP
| Файл | Что извлечь |
|------|------------|
| `composer.json` | name, version, require, require-dev, autoload |

## 3. Entry Points (точки входа)

### JavaScript / TypeScript
- Поле `"main"` или `"module"` в `package.json`
- `src/index.ts`, `src/index.js`, `src/main.ts`, `src/main.js`
- `index.ts`, `index.js` в корне
- `src/app.ts`, `src/server.ts` (для серверных приложений)
- `cli.ts`, `bin/*` (для CLI)

### Python
- `__main__.py` (в корне или в package)
- `setup.py` → `entry_points`
- `pyproject.toml` → `[project.scripts]`
- `manage.py` (Django)
- `app.py` (Flask/FastAPI)

### Rust
- `src/main.rs` (binary)
- `src/lib.rs` (library)
- `examples/*.rs` (examples)
- ` benches/*.rs` (benchmarks)

### Go
- `main.go` (в корне или `cmd/*/`)
- `cmd/*/main.go` (multi-binary)

### Java / Kotlin
- `src/main/java/**/Application.java` (Spring Boot)
- `src/main/java/**/Main.java`
- `src/main/kotlin/**/Main.kt`

## 4. Config files (конфигурация)

| Файл | Назначение |
|------|------------|
| `.env.example`, `.env.sample` | Переменные окружения |
| `docker-compose.yml`, `docker-compose.yaml` | Docker конфигурация |
| `Dockerfile` | Docker build |
| `Makefile` | Build targets |
| `CMakeLists.txt` | C/C++ build |
| `.github/workflows/*.yml` | CI/CD |
| `.gitlab-ci.yml` | CI/CD GitLab |
| `vercel.json`, `netlify.toml` | Deploy конфигурация |
| `tsconfig.json` | TypeScript конфигурация |
| `jest.config.*` | Тесты |
| `.prettierrc*` | Code formatting |

## 5. Documentation

| Файл | Назначение |
|------|------------|
| `CONTRIBUTING.md` | Как контрибьютить |
| `CHANGELOG.md` | История изменений |
| `LICENSE` | Лицензия |
| `ARCHITECTURE.md`, `docs/architecture*` | Архитектура |
| `docs/` | Документация |
| `CODE_OF_CONDUCT.md` | Правила поведения |

## 6. Test files

Не читай содержимое тестов для маппинга, но учти их наличие:
- `tests/`, `test/`, `__tests__/`, `spec/`
- `*.test.ts`, `*.spec.ts`, `*_test.go`, `test_*.py`
- `src/**/*.test.*`, `src/**/*.spec.*`
