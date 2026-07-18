#!/usr/bin/env bash
#
# Build FAN (fan) RELEASE binaries for all platforms.
# For FAN v1.0.0+ with INDEPENDENT versioning (each package manages its own version).
#
# Version scheme:
#   FAN_VERSION   = version from root package.json (monorepo workspace root, e.g. 2.0.0)
#                   used for archive names, manifest.json, and in-binary version display
#   CODING_AGENT_VERSION = version from packages/coding-agent/package.json (npm package,
#                          e.g. 1.0.3) embedded as @seaagents/fan-coding-agent metadata
#
# Unlike build-binaries.sh (legacy), this script:
#   - Reads FAN version from root package.json (not coding-agent/package.json)
#   - Reads npm-package version separately from packages/coding-agent/package.json
#   - Does NOT synchronize versions across packages (scripts/sync-version.mjs removed in v1.0.1)
#   - Tags archives as RELEASE builds in all output messages
#
# Usage:
#   ./scripts/release-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform dependencies
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output:
#   packages/coding-agent/binaries/
#     fan-<VERSION>-darwin-arm64.tar.gz
#     fan-<VERSION>-darwin-x64.tar.gz
#     fan-<VERSION>-linux-x64.tar.gz
#     fan-<VERSION>-linux-arm64.tar.gz
#     fan-<VERSION>-windows-x64.zip
#
# Version is read dynamically from packages/coding-agent/package.json during build.
# The version in api-gateway dist is inlined via sed at build time.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$SCRIPT_DIR/.."

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

# Read FAN_VERSION from root package.json (monorepo release version, e.g. 2.0.0)
FAN_VERSION=$(node -e "console.log(require('./package.json').version)")
# Read CODING_AGENT_VERSION from packages/coding-agent/package.json (npm package version, e.g. 1.0.3)
CODING_AGENT_VERSION=$(node -e "console.log(require('./packages/coding-agent/package.json').version)")
echo "==> Building release binaries for FAN v1.0.0+ with independent versioning..."
echo "==> FAN (fan) version: ${FAN_VERSION}"
echo "==> @seaagents/fan-coding-agent version: ${CODING_AGENT_VERSION}"

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

# Build all packages.
# NOTE: root package.json has NO "prebuild" hook and scripts/sync-version.mjs
# has been removed. `npm run build` only compiles packages; it does NOT modify
# any package.json version fields. Each package keeps its independent version.
echo "==> Building all packages (independent versions preserved)..."
npm run build

# Build dashboard
echo "Building dashboard..."
npm run build:dashboard

# Inline version into api-gateway dist (bun compile cannot resolve __dirname-relative
# package.json reads at runtime — use coding-agent version as single source of truth).
echo "==> Inlining version v${FAN_VERSION} into api-gateway dist..."
sed -i "s|JSON\.parse(readFileSync(join(__dirname, '\.\.', 'package\.json'), 'utf-8'))\.version|'${FAN_VERSION}'|g" packages/api-gateway/dist/http-server.js

# Inline version into coding-agent dist as well. The compiled binary reads
# package.json next to the executable at runtime; if that file is ever stale
# (e.g. partial self-update or install), the binary should still report the
# release version it was built with.
echo "==> Inlining version v${FAN_VERSION} into coding-agent dist..."
sed -i "s|export const VERSION = pkg\.version;|export const VERSION = '${FAN_VERSION}';|g" packages/coding-agent/dist/config.js

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
        bun build --compile --external koffi --no-compile-autoload-dotenv --no-compile-autoload-package-json --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/fan.exe
    else
        bun build --compile --external koffi --no-compile-autoload-dotenv --no-compile-autoload-package-json --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/fan
    fi
done

echo "==> Bundling FAN-specific assets..."

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
    # Bun stores generated client in its cache, not in node_modules/.prisma/client/
    PRISMA_CLIENT_DIR=$(find ../../node_modules/.bun -path '*/.prisma/client' -type d 2>/dev/null | head -1)
    if [[ -n "${prisma_engine:-}" && -n "${PRISMA_CLIENT_DIR:-}" && -f "$PRISMA_CLIENT_DIR/$prisma_engine" ]]; then
        mkdir -p binaries/$platform/node_modules/.prisma/client
        cp "$PRISMA_CLIENT_DIR/$prisma_engine" binaries/$platform/node_modules/.prisma/client/
    elif [[ -n "${prisma_engine:-}" && -f ../../node_modules/.prisma/client/$prisma_engine ]]; then
        mkdir -p binaries/$platform/node_modules/.prisma/client
        cp ../../node_modules/.prisma/client/$prisma_engine binaries/$platform/node_modules/.prisma/client/
    else
        echo "  ⚠ Warning: Prisma engine '$prisma_engine' not found (checked bun cache and node_modules/.prisma/client/)"
    fi
done

# Create archives
cd binaries

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        # Windows (zip) - use wrapper directory for consistency with Unix
        echo "Creating fan-$FAN_VERSION-$platform.zip..."
        mv $platform fan && zip -rq fan-$FAN_VERSION-$platform.zip fan && mv fan $platform
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating fan-$FAN_VERSION-$platform.tar.gz..."
        mv $platform fan && tar -czf fan-$FAN_VERSION-$platform.tar.gz fan && mv fan $platform
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf $platform
    if [[ "$platform" == "windows-x64" ]]; then
        unzip -q fan-$FAN_VERSION-$platform.zip && mv fan $platform
    else
        tar -xzf fan-$FAN_VERSION-$platform.tar.gz && mv fan $platform
    fi
done

echo ""
echo "==> FAN RELEASE build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    echo "  binaries/$platform/fan"
done

# Generate manifest.json (cross-platform Node replacement for python3 heredoc)
echo "==> Generating manifest.json..."
export FAN_VERSION
node "$SCRIPT_DIR/gen-manifest.mjs"

# Copy artifacts to dist repo
DIST_REPO="$HOME/fan-store/dist"
mkdir -p "$DIST_REPO"
echo "==> Copying artifacts to $DIST_REPO/"
cp -v manifest.json "$DIST_REPO/"
cp -v fan-$FAN_VERSION-*.{tar.gz,zip} "$DIST_REPO/" 2>/dev/null
cp -v "$SCRIPT_DIR/install.sh" "$DIST_REPO/"
cp -v "$SCRIPT_DIR/install.ps1" "$DIST_REPO/"
echo "==> Dist repo ready. Run: fan-store publish"
