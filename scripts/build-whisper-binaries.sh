#!/usr/bin/env bash
#
# Build whisper.cpp whisper-cli binaries for all supported platforms.
#
# Usage:
#   ./scripts/build-whisper-binaries.sh [--platform <platform>]
#
# Options:
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output:
#   /tmp/voice-ollama-tui-whisper-bin-<platform>-<version>.tar.gz (or .zip for windows)
#
# Requirements:
#   - cmake, make
#   - native compiler for the target platform
#   - for linux-arm64: aarch64-linux-gnu-gcc / g++
#   - for darwin-*: macOS + Xcode command line tools
#   - for windows-x64: mingw-w64 or MSVC

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

WORK_DIR="/tmp/whisper-build-$$"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

echo "==> Cloning whisper.cpp $VERSION..."
git clone --depth 1 --branch "v$VERSION" https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp

build_platform() {
    local platform="$1"
    local build_dir="build-$platform"
    local cmake_args="-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_EXAMPLES=ON"
    local output_name="whisper-cli"

    case "$platform" in
        linux-x64)
            ;;
        linux-arm64)
            cmake_args="$cmake_args -DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++ -DCMAKE_SYSTEM_PROCESSOR=arm64 -DCMAKE_CROSSCOMPILING=ON"
            ;;
        darwin-arm64)
            cmake_args="$cmake_args -DCMAKE_OSX_ARCHITECTURES=arm64"
            ;;
        darwin-x64)
            cmake_args="$cmake_args -DCMAKE_OSX_ARCHITECTURES=x86_64"
            ;;
        windows-x64)
            output_name="whisper-cli.exe"
            ;;
    esac

    echo "==> Building for $platform..."
    cmake -B "$build_dir" $cmake_args
    cmake --build "$build_dir" --config Release --target whisper-cli -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

    local pkg_dir="$WORK_DIR/voice-ollama-tui-whisper-bin-$platform"
    mkdir -p "$pkg_dir"
    cp "$build_dir/bin/$output_name" "$pkg_dir/"

    if [[ "$platform" == windows-x64 ]]; then
        (cd "$WORK_DIR" && zip -rq "voice-ollama-tui-whisper-bin-$platform-$VERSION.zip" "voice-ollama-tui-whisper-bin-$platform")
        echo "==> Created: /tmp/voice-ollama-tui-whisper-bin-$platform-$VERSION.zip"
        cp "$WORK_DIR/voice-ollama-tui-whisper-bin-$platform-$VERSION.zip" /tmp/
    else
        (cd "$WORK_DIR" && tar -czf "voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz" "voice-ollama-tui-whisper-bin-$platform")
        echo "==> Created: /tmp/voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz"
        cp "$WORK_DIR/voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz" /tmp/
    fi
}

if [[ -n "$PLATFORM" ]]; then
    build_platform "$PLATFORM"
else
    for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64; do
        build_platform "$p"
    done
fi

echo "==> Build complete. Artifacts in /tmp/"
ls -lh /tmp/voice-ollama-tui-whisper-bin-*
