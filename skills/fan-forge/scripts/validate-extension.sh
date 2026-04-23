#!/usr/bin/env bash
# validate-extension.sh — Levels 1-2: Structural + TypeScript parsing validation
#
# Usage: bash ~/.fan/agent/skills/fan-forge/scripts/validate-extension.sh <path-to-extension>
#
# For single file: path/to/my-extension.ts
# For directory:   path/to/my-extension/index.ts
#
# Returns: 0 = all checks pass, 1 = any check fails

set -euo pipefail

# --- Arguments ---
if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-extension>"
  echo "  Single file: path/to/my-extension.ts"
  echo "  Directory:   path/to/my-extension/index.ts"
  exit 1
fi

EXT_PATH="$1"
FAILED=0

# --- Resolve entry point ---
if [ -d "$EXT_PATH" ]; then
  # Directory: look for index.ts
  ENTRY="$EXT_PATH/index.ts"
  if [ ! -f "$ENTRY" ]; then
    echo "FAIL: No index.ts found in $EXT_PATH"
    exit 1
  fi
elif [ -f "$EXT_PATH" ]; then
  ENTRY="$EXT_PATH"
else
  echo "FAIL: $EXT_PATH does not exist"
  exit 1
fi

echo "=== Level 1: Structural Validation ==="
echo "Entry point: $ENTRY"

# Check 1: File is .ts
if [[ "$ENTRY" != *.ts ]]; then
  echo "FAIL: Entry point must be a .ts file"
  FAILED=1
else
  echo "  [PASS] File is .ts"
fi

# Check 2: Exports default function
if grep -q "export default function" "$ENTRY"; then
  echo "  [PASS] Exports default function"
else
  echo "FAIL: Missing 'export default function' in $ENTRY"
  FAILED=1
fi

# Check 3: Imports from pi-coding-agent
if grep -q "@fan/fan-coding-agent" "$ENTRY"; then
  echo "  [PASS] Imports from @fan/fan-coding-agent"
else
  echo "FAIL: No imports from @fan/fan-coding-agent"
  FAILED=1
fi

# Check 4: Directory naming (if directory)
if [ -d "$EXT_PATH" ]; then
  DIR_NAME=$(basename "$EXT_PATH")
  if echo "$DIR_NAME" | grep -Eq '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$'; then
    echo "  [PASS] Directory name follows conventions: $DIR_NAME"
  else
    echo "WARN: Directory name '$DIR_NAME' may not follow fan conventions (lowercase, hyphens)"
  fi
fi

# Check 5: If directory has package.json with pi.extensions
PKG_JSON="$EXT_PATH/package.json"
if [ -f "$PKG_JSON" ]; then
  echo "  [INFO] Found package.json"
  if grep -q '"pi"' "$PKG_JSON" && grep -q '"extensions"' "$PKG_JSON"; then
    echo "  [PASS] package.json has pi.extensions manifest"
  else
    echo "WARN: package.json missing pi.extensions manifest"
  fi
fi

echo ""
echo "=== Level 2: TypeScript Parsing ==="

# Check 6: jiti parse test
# Find jiti from global dependencies
JITI_PATH=""
for candidate in \
  "$(bun pm ls -g 2>/dev/null | grep jiti | head -1 | awk '{print $NF}')/node_modules/jiti" \
  "$(npm root -g 2>/dev/null)/jiti"; do
  if [ -d "$candidate" ]; then
    JITI_PATH="$candidate"
    break
  fi
done

if [ -z "$JITI_PATH" ]; then
  echo "  [WARN] jiti not found, skipping parse test"
  echo "  Run: npm install -g jiti (or ensure fan is installed)"
else
  ENTRY_ABS=$(cd "$(dirname "$ENTRY")" && pwd)/$(basename "$ENTRY")
  if node -e "
    const jiti = require('$JITI_PATH');
    try {
      jiti('$ENTRY_ABS', { esmResolve: true });
      process.exit(0);
    } catch(e) {
      console.error('PARSE_FAIL: ' + e.message);
      process.exit(1);
    }
  " 2>&1; then
    echo "  [PASS] TypeScript parses without errors"
  else
    echo "FAIL: TypeScript parsing failed"
    FAILED=1
  fi
fi

# --- Summary ---
echo ""
if [ $FAILED -eq 0 ]; then
  echo "=== RESULT: ALL CHECKS PASSED ==="
  exit 0
else
  echo "=== RESULT: SOME CHECKS FAILED ==="
  exit 1
fi
