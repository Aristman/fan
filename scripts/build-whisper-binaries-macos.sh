#!/usr/bin/env bash
#
# Build whisper.cpp whisper-cli binaries on macOS for macOS.
#
# Usage:
#   ./scripts/build-whisper-binaries-macos.sh [--platform <platform>] [--version <version>]
#
# Options:
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64)
#   --version <ver>     whisper.cpp version tag without 'v' prefix (default: 1.9.1)
#
# Output:
#   /tmp/voice-ollama-tui-whisper-bin-<platform>-<version>.tar.gz
#
# Requirements (macOS):
#   - Xcode Command Line Tools
#   - cmake (brew install cmake)
#   - git

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${WHISPER_BIN_VERSION:-1.9.1}"
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

SUPPORTED_PLATFORMS=(darwin-arm64 darwin-x64)

if [[ -n "$PLATFORM" ]]; then
    found=0
    for p in "${SUPPORTED_PLATFORMS[@]}"; do
        if [[ "$p" == "$PLATFORM" ]]; then
            found=1
            break
        fi
    done
    if [[ "$found" -eq 0 ]]; then
        echo "Invalid platform for macOS host: $PLATFORM"
        echo "Valid platforms: ${SUPPORTED_PLATFORMS[*]}"
        exit 1
    fi
fi

# Verify required tools
for tool in cmake make git; do
    if ! command -v "$tool" &>/dev/null; then
        echo "Missing required tool: $tool"
        exit 1
    fi
done

WORK_DIR="/tmp/whisper-build-$$"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

echo "==> Cloning whisper.cpp v$VERSION..."
git clone --depth 1 --branch "v$VERSION" https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp

build_platform() {
    local platform="$1"
    local build_dir="build-$platform"
    local cmake_args="-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF"
    local output_name="whisper-cli"

    case "$platform" in
        darwin-arm64)
            cmake_args="$cmake_args -DCMAKE_OSX_ARCHITECTURES=arm64"
            ;;
        darwin-x64)
            cmake_args="$cmake_args -DCMAKE_OSX_ARCHITECTURES=x86_64"
            ;;
    esac

    echo "==> Building for $platform..."
    rm -rf "$build_dir"
    cmake -B "$build_dir" $cmake_args
    cmake --build "$build_dir" --config Release --target whisper-cli -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

    local pkg_dir="$WORK_DIR/voice-ollama-tui-whisper-bin-$platform"
    rm -rf "$pkg_dir"
    mkdir -p "$pkg_dir"
    cp "$build_dir/bin/$output_name" "$pkg_dir/"

    (cd "$WORK_DIR" && tar -czf "voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz" "voice-ollama-tui-whisper-bin-$platform")
    cp "$WORK_DIR/voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz" /tmp/
    echo "==> Created: /tmp/voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz"
}

if [[ -n "$PLATFORM" ]]; then
    build_platform "$PLATFORM"
else
    for p in "${SUPPORTED_PLATFORMS[@]}"; do
        build_platform "$p"
    done
fi

rm -rf "$WORK_DIR"

echo ""
echo "==> Build complete. Artifacts in /tmp/"
ls -lh /tmp/voice-ollama-tui-whisper-bin-*
