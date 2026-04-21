#!/usr/bin/env bash
#
# Build FAN (fan) binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform dependencies
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output:
#   packages/coding-agent/binaries/
#     fan-darwin-arm64.tar.gz
#     fan-darwin-x64.tar.gz
#     fan-linux-x64.tar.gz
#     fan-linux-arm64.tar.gz
#     fan-windows-x64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64"
            exit 1
            ;;
    esac
fi

# Ensure bun is installed
if ! command -v bun &>/dev/null; then
    if [[ -x "$HOME/.bun/bin/bun" ]]; then
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
    else
        echo "==> bun not found, installing..."
        curl -fsSL https://bun.sh/install | bash
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
    fi
fi
echo "==> Using bun $(bun --version)"

# Display version being built
echo "==> FAN (fan) version: $(node -e "console.log(require('./package.json').version)")"

# ─── Install dependencies ──────────────────────────────────────
# bun install understands workspace:* protocol used by the monorepo.
# --ignore-scripts skips canvas native build (needs libgif-dev system dep).
# After install, fix-bun-symlinks.sh creates symlinks in node_modules for
# tsgo and bun build --compile (bun's isolated linker doesn't hoist all
# transitive deps into node_modules).

echo "==> Installing dependencies..."
bun install --ignore-scripts || true

echo "==> Fixing bun isolated linker symlinks..."
bash "$(dirname "$0")/fix-bun-symlinks.sh"

# Generate Prisma client (skipped by --ignore-scripts)
echo "==> Generating Prisma client..."
cd packages/db && npx prisma generate && cd ../..

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    # We need all platform bindings for bun cross-compilation
    # Use --force to bypass platform checks (os/cpu restrictions in package.json)
    bun add --no-save --ignore-scripts --force \
        @mariozechner/clipboard-darwin-arm64@0.3.0 \
        @mariozechner/clipboard-darwin-x64@0.3.0 \
        @mariozechner/clipboard-linux-x64-gnu@0.3.0 \
        @mariozechner/clipboard-linux-arm64-gnu@0.3.0 \
        @mariozechner/clipboard-win32-x64-msvc@0.3.0 \
        @img/sharp-darwin-arm64@0.34.5 \
        @img/sharp-darwin-x64@0.34.5 \
        @img/sharp-linux-x64@0.34.5 \
        @img/sharp-linux-arm64@0.34.5 \
        @img/sharp-win32-x64@0.34.5 \
        @img/sharp-libvips-darwin-arm64@1.2.4 \
        @img/sharp-libvips-darwin-x64@1.2.4 \
        @img/sharp-libvips-linux-x64@1.2.4 \
        @img/sharp-libvips-linux-arm64@1.2.4 || true
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

echo "==> Building all packages..."
npm run build

# Build dashboard
echo "Building dashboard..."
npm run build:dashboard

echo "==> Building FAN (fan) binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf binaries
mkdir -p binaries/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Externalize koffi to avoid embedding all 18 platform .node files (~74MB)
    # into every binary. Koffi is only used on Windows for VT input and the
    # call site has a try/catch fallback. For Windows builds, we copy the
    # appropriate .node file alongside the binary below.
    if [[ "$platform" == "windows-x64" ]]; then
        bun build --compile --external koffi --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/fan.exe
    else
        bun build --compile --external koffi --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/fan
    fi
done

echo "==> Bundling FAN-specific assets..."

# Prepare orchestrator assets in a temp directory
ORCH_ASSETS_DIR=$(mktemp -d)
trap "rm -rf '$ORCH_ASSETS_DIR'" EXIT

mkdir -p "$ORCH_ASSETS_DIR/orchestrator/agents"
mkdir -p "$ORCH_ASSETS_DIR/orchestrator/prompts"

# Copy orchestrator config
if [[ -f ../../packages/orchestrator/src/config.json ]]; then
    cp ../../packages/orchestrator/src/config.json "$ORCH_ASSETS_DIR/orchestrator/"
fi

# Copy agent definitions (if they exist)
for f in ../../packages/orchestrator/src/agents/*.md; do
    if [[ -f "$f" ]]; then
        cp "$f" "$ORCH_ASSETS_DIR/orchestrator/agents/"
    fi
done

# Copy prompt templates (if they exist)
for f in ../../packages/orchestrator/src/prompts/*.md; do
    if [[ -f "$f" ]]; then
        cp "$f" "$ORCH_ASSETS_DIR/orchestrator/prompts/"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json binaries/$platform/
    cp README.md binaries/$platform/
    cp CHANGELOG.md binaries/$platform/
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm binaries/$platform/
    mkdir -p binaries/$platform/theme
    cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
    mkdir -p binaries/$platform/assets
    cp dist/modes/interactive/assets/* binaries/$platform/assets/
    cp -r dist/core/export-html binaries/$platform/

    # Bundle FAN orchestrator assets
    cp -r "$ORCH_ASSETS_DIR/orchestrator" binaries/$platform/

    # Dashboard
    echo "  Copying dashboard..."
    mkdir -p binaries/$platform/dashboard
    cp -r ../../packages/dashboard/dist/* binaries/$platform/dashboard/

    # Copy koffi native module for Windows (needed for VT input support)
    if [[ "$platform" == "windows-x64" ]]; then
        mkdir -p binaries/$platform/node_modules/koffi/build/koffi/win32_x64
        cp ../../node_modules/koffi/index.js binaries/$platform/node_modules/koffi/
        cp ../../node_modules/koffi/package.json binaries/$platform/node_modules/koffi/
        cp ../../node_modules/koffi/build/koffi/win32_x64/koffi.node binaries/$platform/node_modules/koffi/build/koffi/win32_x64/
        prisma_engine="query_engine-windows.dll.node"
    elif [[ "$platform" == "darwin-arm64" ]]; then
        prisma_engine="libquery_engine-darwin-arm64.dylib.node"
    elif [[ "$platform" == "darwin-x64" ]]; then
        prisma_engine="libquery_engine-darwin.dylib.node"
    elif [[ "$platform" == "linux-arm64" ]]; then
        prisma_engine="libquery_engine-linux-arm64-openssl-3.0.x.so.node"
    elif [[ "$platform" == "linux-x64" ]]; then
        prisma_engine="libquery_engine-debian-openssl-3.0.x.so.node"
    fi

    # Copy Prisma query engine for this platform
    if [[ -n "${prisma_engine:-}" && -f ../../node_modules/.prisma/client/$prisma_engine ]]; then
        mkdir -p binaries/$platform/node_modules/.prisma/client
        cp ../../node_modules/.prisma/client/$prisma_engine binaries/$platform/node_modules/.prisma/client/
    fi
done

# Create archives
cd binaries

VERSION=$(node -e "console.log(require('../package.json').version)")

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        # Windows (zip)
        echo "Creating fan-$VERSION-$platform.zip..."
        (cd $platform && zip -r ../fan-$VERSION-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating fan-$VERSION-$platform.tar.gz..."
        mv $platform fan && tar -czf fan-$VERSION-$platform.tar.gz fan && mv fan $platform
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf $platform
    if [[ "$platform" == "windows-x64" ]]; then
        mkdir -p $platform && (cd $platform && unzip -q ../fan-$platform.zip)
    else
        tar -xzf fan-$platform.tar.gz && mv fan $platform
    fi
done

echo ""
echo "==> FAN build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    echo "  binaries/$platform/fan"
done

# ─── Generate manifest.json ────────────────────────────────────
echo "==> Generating manifest.json..."
VERSION=$(node -e "console.log(require('../package.json').version)")
MANIFEST="{"
MANIFEST+=\"\"latest\":\"$VERSION\","
MANIFEST+=\"\"releasedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
MANIFEST+=\"\"releaseNotes\":\"\","
MANIFEST+=\"\"platforms\":{"

FIRST=true
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        ARCHIVE="fan-$VERSION-$platform.zip"
    else
        ARCHIVE="fan-$VERSION-$platform.tar.gz"
    fi

    if [[ -f "$ARCHIVE" ]]; then
        HASH=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
        SIZE=$(stat -f%z "$ARCHIVE" 2>/dev/null || stat -c%s "$ARCHIVE" 2>/dev/null)

        if [[ "$FIRST" == "true" ]]; then
            FIRST=false
        else
            MANIFEST+=","
        fi

        MANIFEST+=\"\"$platform\":{"
        MANIFEST+=\"\"url\":\"http://185.219.41.46/fan/dist/$ARCHIVE\","
        MANIFEST+=\"\"hash\":\"sha256:$HASH\","
        MANIFEST+=\"\"size\":$SIZE"
        MANIFEST+=\"}"
    fi
done

MANIFEST+=\"}}"
echo "$MANIFEST" | python3 -m json.tool > manifest.json
echo "Manifest written to packages/coding-agent/binaries/manifest.json"
