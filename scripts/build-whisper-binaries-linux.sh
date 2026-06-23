#!/usr/bin/env bash
#
# Build whisper.cpp whisper-cli binaries on Linux for Linux and Windows.
#
# Usage:
#   ./scripts/build-whisper-binaries-linux.sh [--platform <platform>] [--version <version>]
#
# Options:
#   --platform <name>   Build only for specified platform (linux-x64, linux-arm64, windows-x64)
#   --version <ver>     whisper.cpp version tag without 'v' prefix (default: 1.9.1)
#
# Output:
#   /tmp/voice-ollama-tui-whisper-bin-<platform>-<version>.tar.gz (or .zip for windows)
#
# Requirements (Ubuntu/Debian):
#   sudo apt-get install -y cmake build-essential gcc-aarch64-linux-gnu g++-aarch64-linux-gnu mingw-w64

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

SUPPORTED_PLATFORMS=(linux-x64 linux-arm64 windows-x64)

if [[ -n "$PLATFORM" ]]; then
    found=0
    for p in "${SUPPORTED_PLATFORMS[@]}"; do
        if [[ "$p" == "$PLATFORM" ]]; then
            found=1
            break
        fi
    done
    if [[ "$found" -eq 0 ]]; then
        echo "Invalid platform for Linux host: $PLATFORM"
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
    local compiler=""

    case "$platform" in
        linux-x64)
            if ! command -v gcc &>/dev/null || ! command -v g++ &>/dev/null; then
                echo "Missing native compiler (gcc/g++). Install build-essential."
                exit 1
            fi
            ;;
        linux-arm64)
            compiler="aarch64-linux-gnu"
            if ! command -v "${compiler}-gcc" &>/dev/null || ! command -v "${compiler}-g++" &>/dev/null; then
                echo "Missing cross compiler: ${compiler}-gcc/g++. Install gcc-aarch64-linux-gnu g++-aarch64-linux-gnu."
                exit 1
            fi
            cmake_args="$cmake_args -DCMAKE_C_COMPILER=${compiler}-gcc -DCMAKE_CXX_COMPILER=${compiler}-g++ -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 -DCMAKE_CROSSCOMPILING=ON -DGGML_CPU_ARM_ARCH=armv8-a -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DGGML_SSE42=OFF -DGGML_USE_CPU_REPACK=OFF"
            ;;
        windows-x64)
            compiler="x86_64-w64-mingw32"
            if ! command -v "${compiler}-gcc" &>/dev/null || ! command -v "${compiler}-g++" &>/dev/null; then
                echo "Missing cross compiler: ${compiler}-gcc/g++. Install mingw-w64."
                exit 1
            fi
            output_name="whisper-cli.exe"
            # The toolchain file sets -D_WIN32_WINNT and a header patch for
            # THREAD_POWER_THROTTLING_STATE compatibility.
            # Disable OpenMP so the binary doesn't depend on libgomp-1.dll;
            # whisper.cpp falls back to std::thread which links statically.
            cmake_args="$cmake_args -DCMAKE_TOOLCHAIN_FILE=$SCRIPT_DIR/cmake/mingw-w64-x86_64.cmake -DCMAKE_CROSSCOMPILING=ON -DGGML_OPENMP=OFF"
            ;;
    esac

    echo "==> Building for $platform..."
    rm -rf "$build_dir"
    cmake -B "$build_dir" $cmake_args
    cmake --build "$build_dir" --config Release --target whisper-cli -j"$(nproc 2>/dev/null || echo 4)"

    local pkg_dir="$WORK_DIR/voice-ollama-tui-whisper-bin-$platform"
    rm -rf "$pkg_dir"
    mkdir -p "$pkg_dir"
    cp "$build_dir/bin/$output_name" "$pkg_dir/"

    if [[ "$platform" == windows-x64 ]]; then
        (cd "$WORK_DIR" && zip -rq "voice-ollama-tui-whisper-bin-$platform-$VERSION.zip" "voice-ollama-tui-whisper-bin-$platform")
        cp "$WORK_DIR/voice-ollama-tui-whisper-bin-$platform-$VERSION.zip" /tmp/
        echo "==> Created: /tmp/voice-ollama-tui-whisper-bin-$platform-$VERSION.zip"
    else
        (cd "$WORK_DIR" && tar -czf "voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz" "voice-ollama-tui-whisper-bin-$platform")
        cp "$WORK_DIR/voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz" /tmp/
        echo "==> Created: /tmp/voice-ollama-tui-whisper-bin-$platform-$VERSION.tar.gz"
    fi
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
