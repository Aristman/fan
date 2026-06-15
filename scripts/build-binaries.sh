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
#     fan-<VERSION>-darwin-arm64.tar.gz
#     fan-<VERSION>-darwin-x64.tar.gz
#     fan-<VERSION>-linux-x64.tar.gz
#     fan-<VERSION>-linux-arm64.tar.gz
#     fan-<VERSION>-windows-x64.zip
# Version is read dynamically from root package.json during build.

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

# Inline version into api-gateway dist (bun compile cannot resolve __dirname-relative
# package.json reads at runtime — use the monorepo root version as single source of truth).
FAN_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "==> Inlining version v${FAN_VERSION} into api-gateway dist..."
sed -i "s|JSON\.parse(readFileSync(join(__dirname, '\.\.', 'package\.json'), 'utf-8'))\.version|'${FAN_VERSION}'|g" packages/api-gateway/dist/http-server.js

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
VERSION=$(node -e "console.log(require('./package.json').version)")
export VERSION
cd binaries

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        # Windows (zip) - use wrapper directory for consistency with Unix
        echo "Creating fan-$VERSION-$platform.zip..."
        mv $platform fan && zip -rq fan-$VERSION-$platform.zip fan && mv fan $platform
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
        unzip -q fan-$VERSION-$platform.zip && mv fan $platform
    else
        tar -xzf fan-$VERSION-$platform.tar.gz && mv fan $platform
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

# Generate manifest.json
echo "==> Generating manifest.json..."
python3 << 'PYEOF'
import json, hashlib, os, glob
version = os.environ['VERSION']
released_at = os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip()
platforms = {}
for f in sorted(glob.glob(f"fan-{version}-*.tar.gz") + glob.glob(f"fan-{version}-*.zip")):
    name = f.replace(f"fan-{version}-", "").replace(".tar.gz", "").replace(".zip", "")
    h = hashlib.sha256(open(f, "rb").read()).hexdigest()
    s = os.path.getsize(f)
    platforms[name] = {"url": f"https://fan.sea-agents.ru/fan-store/dist/{f}", "hash": f"sha256:{h}", "size": s}
manifest = {"latest": version, "releasedAt": released_at, "releaseNotes": "", "platforms": platforms}
with open("manifest.json", "w") as out:
    json.dump(manifest, out, indent=2)
    out.write("\n")
print(f"Manifest: {len(platforms)} platforms, version {version}")
for name, p in sorted(platforms.items()):
    print(f"  {name}: {p['size']} bytes")
PYEOF

# Copy artifacts to dist repo
DIST_REPO="$HOME/fan-store/dist"
mkdir -p "$DIST_REPO"
echo "==> Copying artifacts to $DIST_REPO/"
cp -v manifest.json "$DIST_REPO/"
cp -v fan-$VERSION-*.{tar.gz,zip} "$DIST_REPO/" 2>/dev/null
cp -v "$SCRIPT_DIR/install.sh" "$DIST_REPO/"
cp -v "$SCRIPT_DIR/install.ps1" "$DIST_REPO/"
echo "==> Dist repo ready. Run: fan-store publish"
