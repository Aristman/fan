#!/usr/bin/env bash
set -euo pipefail
# Build fan-orchestrator-<VER>.tar.gz for FAN Store publish.
# Uses POSIX tar-compatible flags (works on Windows GnuWin tar).

SRC="C:/Users/User/projects/agents/fan/extensions/fan-orchestrator"
VERSION=$(python -c "import json; print(json.load(open('$SRC/package.json',encoding='utf-8'))['version'])")
STAGE="/tmp/fan-orchestrator-build-${VERSION}"
ARCHIVE="/tmp/fan-orchestrator-${VERSION}.tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE/fan-orchestrator"

cd "$SRC"

# Copy the same file list as 7.3.0 archive + new pipeline-state.* added in 7.4.0
cp agents/. "$STAGE/fan-orchestrator/agents/" 2>/dev/null || cp -r agents "$STAGE/fan-orchestrator/"
cp -r prompts "$STAGE/fan-orchestrator/"
cp agents.d.ts agents.js \
   audit.js \
   config.d.ts config.example.json config.js config.json \
   index.d.ts index.js \
   orchestrator-extension.d.ts orchestrator-extension.js \
   orchestrator-tools.d.ts orchestrator-tools.js \
   permissions.d.ts permissions.js \
   pipeline-state.d.ts pipeline-state.js \
   subagent-runner.d.ts subagent-runner.js \
   task-complexity.js \
   task-manager.d.ts task-manager.js \
   types.d.ts types.js \
   workers.d.ts workers.js \
   package.json \
   README.md \
   "$STAGE/fan-orchestrator/"

cd "$STAGE"
tar -czf "$ARCHIVE" fan-orchestrator

echo "=== Built: $ARCHIVE ==="
ls -la "$ARCHIVE"
echo ""
echo "=== Contents (with prefix) ==="
tar -tzf "$ARCHIVE" | head -60
echo ""
echo "=== File count ==="
tar -tzf "$ARCHIVE" | wc -l
