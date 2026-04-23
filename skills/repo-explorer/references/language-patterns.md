# Language Patterns for AST Extraction

Паттерны для извлечения символов из исходных файлов через `rg` (ripgrep).

## Общая стратегия

1. Определи primary language по расширениям файлов
2. Для каждого ключевого файла — примени соответствующие паттерны
3. Максимум 50 файлов для полного AST анализа
4. Для файлов >500 строк — анализируй только первые 200 строк + exports

---

## TypeScript / JavaScript (.ts, .tsx, .js, .jsx, .mjs)

### Функции
```bash
rg -n "export\s+(?:async\s+)?function\s+\w+" "{file}" --no-heading
rg -n "(?:export\s+)?(?:async\s+)?function\s+\w+" "{file}" --no-heading
# Arrow functions (only exported / assigned to const):
rg -n "export\s+const\s+\w+\s*=\s*(?:async\s*)?\(" "{file}" --no-heading
```

### Классы
```bash
rg -n "(?:export\s+)?(?:abstract\s+)?class\s+\w+" "{file}" --no-heading
```

### Интерфейсы / Типы
```bash
rg -n "(?:export\s+)?interface\s+\w+" "{file}" --no-heading
rg -n "export\s+type\s+\w+" "{file}" --no-heading
rg -n "export\s+enum\s+\w+" "{file}" --no-heading
```

### Импорты
```bash
rg -n "^import\s+" "{file}" --no-heading
# Извлекай модули из: from 'module-name'
```

### Ре-экспорты
```bash
rg -n "^export\s+\{.*\}\s+from" "{file}" --no-heading
rg -n "^export\s+\*\s+from" "{file}" --no-heading
```

### Decorators (Angular, NestJS и т.д.)
```bash
rg -n "^\s*@(?:Component|Controller|Injectable|Service|Module|Directive|Pipe|Guard)" "{file}" --no-heading
```

---

## Python (.py)

### Функции / Классы
```bash
rg -n "^(?:async\s+)?def\s+\w+" "{file}" --no-heading
rg -n "^class\s+\w+" "{file}" --no-heading
```

### Декораторы (классы)
```bash
rg -n "^@(?:dataclass|abstractmethod|staticmethod|classmethod|property|app\.(get|post|put|delete|patch))" "{file}" --no-heading
```

### Импорты
```bash
rg -n "^(?:from\s+\S+\s+)?import\s+" "{file}" --no-heading
```

### Type hints
```bash
rg -n ":\s*(?:int|str|float|bool|list|dict|tuple|set|None|Optional|Union|Callable)\b" "{file}" --no-heading --count
```

---

## Rust (.rs)

### Функции
```bash
rg -n "pub\s+(?:async\s+)?fn\s+\w+" "{file}" --no-heading
rg -n "(?:pub\s+)?async\s+fn\s+\w+" "{file}" --no-heading
rg -n "^fn\s+\w+" "{file}" --no-heading
```

### Структуры / Перечисления / Трейты
```bash
rg -n "pub\s+struct\s+\w+" "{file}" --no-heading
rg -n "pub\s+enum\s+\w+" "{file}" --no-heading
rg -n "pub\s+trait\s+\w+" "{file}" --no-heading
rg -n "^struct\s+\w+" "{file}" --no-heading
rg -n "^enum\s+\w+" "{file}" --no-heading
rg -n "^trait\s+\w+" "{file}" --no-heading
```

### Модули
```bash
rg -n "pub\s+mod\s+\w+" "{file}" --no-heading
rg -n "^mod\s+\w+" "{file}" --no-heading
```

### Impl блоки
```bash
rg -n "impl(?:<[^>]+>)?\s+\w+" "{file}" --no-heading
```

### Использования
```bash
rg -n "^use\s+" "{file}" --no-heading
```

### Макросы
```bash
rg -n "#\[derive\(" "{file}" --no-heading
rg -n "#\[macro_use\]" "{file}" --no-heading
```

---

## Go (.go)

### Функции
```bash
rg -n "^func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+" "{file}" --no-heading
```

### Типы
```bash
rg -n "^type\s+\w+\s+struct" "{file}" --no-heading
rg -n "^type\s+\w+\s+interface" "{file}" --no-heading
```

### Интерфейсы
```bash
rg -n "^type\s+\w+\s+interface\s*\{" "{file}" --no-heading
```

### Импорты
```bash
rg -n "^import" "{file}" --no-heading
```

---

## Java (.java)

### Классы / Интерфейсы
```bash
rg -n "(?:public|private|protected)?\s*(?:abstract\s+)?(?:class|interface|enum)\s+\w+" "{file}" --no-heading
```

### Методы (публичные)
```bash
rg -n "public\s+(?:static\s+)?(?:synchronized\s+)?(?:final\s+)?\w+(?:<[^>]+>)?\s+\w+\s*\(" "{file}" --no-heading
```

### Аннотации
```bash
rg -n "^\s*@(?:RestController|Service|Repository|Component|Configuration|Bean|Autowired|Override|Entity|Column|Table)" "{file}" --no-heading
```

### Импорты
```bash
rg -n "^import\s+" "{file}" --no-heading
```

---

## Kotlin (.kt, .kts)

### Классы / Функции
```bash
rg -n "(?:public\s+|private\s+|internal\s+)?(?:abstract\s+|open\s+|data\s+|sealed\s+)?(?:class|object|interface|enum class)\s+\w+" "{file}" --no-heading
rg -n "fun\s+\w+" "{file}" --no-heading
```

### Аннотации
```bash
rg -n "^\s*@(?:Component|Service|Repository|Configuration|Bean|Autowired|Entity|Column|Table|Controller|RestController)" "{file}" --no-heading
```

### Импорты
```bash
rg -n "^import\s+" "{file}" --no-heading
```

---

## C (.c, .h)

### Функции
```bash
rg -n "^\w+\s+\*?\w+\s*\([^)]*\)\s*\{?" "{file}" --no-heading
```

### Структуры
```bash
rg -n "typedef\s+struct\s*\{?" "{file}" --no-heading
rg -n "^struct\s+\w+" "{file}" --no-heading
```

### Includes
```bash
rg -n "^#include" "{file}" --no-heading
```

---

## C++ (.cpp, .hpp, .cc, .cxx)

### Классы
```bash
rg -n "(?:class|struct)\s+\w+" "{file}" --no-heading
```

### Функции
```bash
rg -n "^\w+(?:::)?\s*\*?\w+\s*\([^)]*\)" "{file}" --no-heading
```

### Templates
```bash
rg -n "template\s*<.*>" "{file}" --no-heading
```

### Includes
```bash
rg -n "^#include" "{file}" --no-heading
```

---

## Ruby (.rb)

### Классы / Модули
```bash
rg -n "^(?:class|module)\s+\w+" "{file}" --no-heading
```

### Методы
```bash
rg -n "^\s*def\s+(?:self\.)?\w+" "{file}" --no-heading
```

### Requires
```bash
rg -n "^(?:require|require_relative|gem)" "{file}" --no-heading
```

---

## Swift (.swift)

### Классы / Структуры / Протоколы
```bash
rg -n "^(?:public\s+|private\s+|open\s+)?(?:class|struct|enum|protocol|extension)\s+\w+" "{file}" --no-heading
```

### Функции
```bash
rg -n "(?:public\s+|private\s+)?func\s+\w+" "{file}" --no-heading
```

### Imports
```bash
rg -n "^import\s+" "{file}" --no-heading
```

---

## PHP (.php)

### Классы / Интерфейсы
```bash
rg -n "^(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+\w+" "{file}" --no-heading
```

### Функции
```bash
rg -n "(?:public|private|protected)?\s*function\s+\w+" "{file}" --no-heading
```

### Использования
```bash
rg -n "^(?:use|namespace)\s+" "{file}" --no-heading
```

---

## Mapping: расширение → язык

```
.ts → TypeScript
.tsx → TypeScript
.js → JavaScript
.jsx → JavaScript
.mjs → JavaScript
.cjs → JavaScript
.py → Python
.rs → Rust
.go → Go
.java → Java
.kt → Kotlin
.kts → Kotlin
.c → C
.h → C
.cpp → C++
.hpp → C++
.cc → C++
.cxx → C++
.rb → Ruby
.php → PHP
.swift → Swift
.scala → Scala
.dart → Dart
.lua → Lua
.zig → Zig
.r → R
.jl → Julia
.ex → Elixir
.exs → Elixir
.hs → Haskell
.ml → OCaml
.cs → C#
.fs → F#
.vb → Visual Basic
.pl → Perl
.sh → Shell
.bash → Shell
.zsh → Shell
.sql → SQL
.graphql → GraphQL
.proto → Protocol Buffers
.tf → Terraform
.vue → Vue SFC
.svelte → Svelte
.jsx → React JSX
```
