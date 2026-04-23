#!/usr/bin/env bash
# coverage-scan.sh — Quick scan of source/test coverage gap
# Usage: bash coverage-scan.sh [project_dir]
# Output: list of uncovered source files (one per line)

set -euo pipefail

PROJECT_DIR="${1:-.}"
cd "$PROJECT_DIR"

# Detect project type
if [ -f "build.gradle.kts" ] || [ -f "build.gradle" ]; then
  # Kotlin / Java (Gradle)
  TEST_EXT=".kt"
  SOURCE_DIRS=$(find . -path "*/src/main/*" \( -name "*.kt" -o -name "*.java" \) -not -path "*/build/*" 2>/dev/null)
  if [ -z "$SOURCE_DIRS" ]; then
    echo "NO_SOURCE_FILES_FOUND"
    exit 0
  fi

  echo "PROJECT_TYPE: gradle"
  echo "---"
  while IFS= read -r source; do
    # Map source → test
    ext="${source##*.}"
    test_path=$(echo "$source" | sed 's|src/main/|src/test/|')
    if [ "$ext" = "kt" ]; then
      test_path="${test_path%.kt}Test.kt"
    else
      test_path="${test_path%.java}Test.java"
    fi
    if [ ! -f "$test_path" ]; then
      # Quick logic check: does file have any functions/methods?
      has_logic=$(grep -cE "(fun |def |func |public |private |internal )" "$source" 2>/dev/null || echo 0)
      if [ "$has_logic" -gt 0 ]; then
        echo "UNCOVERED: $source (api_count=$has_logic)"
      fi
    fi
  done <<< "$SOURCE_DIRS"

elif [ -f "package.json" ]; then
  # TypeScript / JavaScript (npm)
  echo "PROJECT_TYPE: npm"
  echo "---"
  while IFS= read -r source; do
    [ -z "$source" ] && continue
    name="${source%.*}"
    covered=false
    for test_ext in ".test.ts" ".spec.ts" ".test.js" ".spec.js"; do
      if [ -f "${name}${test_ext}" ]; then
        covered=true
        break
      fi
    done
    dir_test=$(dirname "$source")/__tests__/$(basename "$source").test.ts
    [ -f "$dir_test" ] && covered=true
    dir_test2=$(dirname "$source")/__tests__/$(basename "$source").spec.ts
    [ -f "$dir_test2" ] && covered=true

    if [ "$covered" = false ]; then
      has_logic=$(grep -cE "(export (function|class|const|async)|function |class )" "$source" 2>/dev/null || echo 0)
      if [ "$has_logic" -gt 0 ]; then
        echo "UNCOVERED: $source (api_count=$has_logic)"
      fi
    fi
  done < <(find . -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v dist | grep -v ".test." | grep -v ".spec." | grep -v __tests__)

elif [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "setup.cfg" ]; then
  # Python
  echo "PROJECT_TYPE: python"
  echo "---"
  while IFS= read -r source; do
    [ -z "$source" ] && continue
    name=$(basename "$source" .py)
    covered=false
    # Check tests/test_*.py
    for test_dir in "tests" "."; do
      if [ -f "${test_dir}/test_${name}.py" ]; then
        covered=true
        break
      fi
    done
    # Check co-located
    co_located=$(dirname "$source")/test_${name}.py
    [ -f "$co_located" ] && covered=true

    if [ "$covered" = false ]; then
      has_logic=$(grep -cE "(def |class )" "$source" 2>/dev/null || echo 0)
      if [ "$has_logic" -gt 0 ]; then
        echo "UNCOVERED: $source (api_count=$has_logic)"
      fi
    fi
  done < <(find . -name "*.py" | grep -v __pycache__ | grep -v venv | grep -v ".venv" | grep -v "test_" | grep -v "_test.py" | grep -v conftest.py)

elif [ -f "Cargo.toml" ]; then
  # Rust
  echo "PROJECT_TYPE: rust"
  echo "---"
  while IFS= read -r source; do
    [ -z "$source" ] && continue
    # Check for #[cfg(test)] in source
    has_unit=$(grep -c '#\[cfg(test)\]' "$source" 2>/dev/null || echo 0)
    if [ "$has_unit" -eq 0 ]; then
      has_logic=$(grep -cE "(fn |pub fn |pub async fn )" "$source" 2>/dev/null || echo 0)
      if [ "$has_logic" -gt 1 ]; then  # >1 because there's always at least one
        echo "UNCOVERED: $source (api_count=$has_logic)"
      fi
    fi
  done < <(find src -name "*.rs" 2>/dev/null | grep -v mod.rs | grep -v main.rs)

elif [ -f "go.mod" ]; then
  # Go
  echo "PROJECT_TYPE: go"
  echo "---"
  while IFS= read -r source; do
    [ -z "$source" ] && continue
    test_file="${source%.go}_test.go"
    if [ ! -f "$test_file" ]; then
      has_logic=$(grep -cE "(func [A-Z])" "$source" 2>/dev/null || echo 0)
      if [ "$has_logic" -gt 0 ]; then
        echo "UNCOVERED: $source (api_count=$has_logic)"
      fi
    fi
  done < <(find . -name "*.go" -not -name "*_test.go" | grep -v vendor)

else
  echo "UNKNOWN_PROJECT_TYPE"
  echo "---"
  echo "Cannot detect project type. Supported: Gradle, npm, Python, Rust, Go."
  exit 1
fi
