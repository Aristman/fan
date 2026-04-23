#!/usr/bin/env bash
# test-load-extension.sh — Level 3: Load test via fan CLI
#
# Usage: bash ~/.fan/agent/skills/fan-forge/scripts/test-load-extension.sh <path-to-extension>
#
# For single file: path/to/my-extension.ts
# For directory:   path/to/my-extension/index.ts
#
# Runs fan -e <path> --no-session and checks exit code.
# Returns: 0 = load successful, 1 = load failed

set -euo pipefail

# --- Arguments ---
if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-extension>"
  exit 1
fi

EXT_PATH="$1"

# --- Resolve entry point ---
if [ -d "$EXT_PATH" ]; then
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

echo "=== Level 3: Load Test ==="
echo "Entry point: $ENTRY"
echo "Running: fan -e $ENTRY --no-session"
echo ""

# --- Run fan load test ---
OUTPUT=$(fan -e "$ENTRY" --no-session 2>&1)
EXIT_CODE=$?

echo "$OUTPUT"
echo ""

if [ $EXIT_CODE -eq 0 ]; then
  # Also check for error patterns in output
  if echo "$OUTPUT" | grep -qi "error\|fail\|crash\|unhandled"; then
    echo "WARN: Exit code 0 but potential errors in output"
    echo "  Review output above for false positives"
    echo ""
    echo "=== RESULT: PASSED (with warnings) ==="
    exit 0
  fi

  echo "=== RESULT: LOAD SUCCESSFUL ==="
  exit 0
else
  echo "FAIL: fan exited with code $EXIT_CODE"
  echo ""
  echo "=== RESULT: LOAD FAILED ==="
  exit 1
fi
