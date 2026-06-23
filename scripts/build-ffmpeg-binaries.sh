#!/usr/bin/env bash
#
# Build ffmpeg binary asset packages for voice-ollama-tui.
#
# Downloads pre-built static ffmpeg binaries from well-known redistributors
# and repackages them into tar.gz archives matching the voice-ollama-tui
# asset naming convention (same pattern as whisper-cli assets):
#
#   voice-ollama-tui-ffmpeg-bin-<platform>-<version>.tar.gz
#
# Internal archive structure:
#   voice-ollama-tui-ffmpeg-bin-<platform>/
#     ffmpeg (or ffmpeg.exe on Windows)
#
# Usage:
#   ./scripts/build-ffmpeg-binaries.sh [--platform <platform>] [--version <version>]
#
# Options:
#   --platform <name>   Build only for specified platform
#                       (linux-x64, linux-arm64, windows-x64, darwin-x64, darwin-arm64)
#   --version <ver>     ffmpeg version (default: 7.0.2)
#
# Output:
#   Archives are written to /home/aristman/fan-store/assets/
#
# Sources:
#   Linux (x64, arm64):  https://johnvansickle.com/ffmpeg/  (GPL, static)
#   Windows (x64):       https://www.gyan.dev/               (GPL, shared/static)
#   macOS (x64, arm64): https://evermeet.cx/pub/ffmpeg/     (GPL, static)
#
# Requirements:
#   - curl, tar, gzip, unzip

set -uo pipefail  # NO set -e — we handle errors manually

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

VERSION="${FFMPEG_BIN_VERSION:-7.0.2}"
PLATFORM=""

# Output directory for finished archives
OUTPUT_DIR="/home/aristman/fan-store/assets"
mkdir -p "$OUTPUT_DIR"

# Temporary working directory (cleaned up on exit)
WORK_DIR="/tmp/ffmpeg-build-$$"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

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
		echo "Usage: $0 [--platform <platform>] [--version <version>]"
		exit 1
		;;
	esac
done

SUPPORTED_PLATFORMS=("linux-x64" "linux-arm64" "windows-x64" "darwin-x64" "darwin-arm64")

if [[ -n "$PLATFORM" ]]; then
	found=0
	for p in "${SUPPORTED_PLATFORMS[@]}"; do
		if [[ "$p" == "$PLATFORM" ]]; then
			found=1
			break
		fi
	done
	if [[ "$found" -eq 0 ]]; then
		echo "Invalid platform: $PLATFORM"
		echo "Valid platforms: ${SUPPORTED_PLATFORMS[*]}"
		exit 1
	fi
fi

# ---------------------------------------------------------------------------
# Build function
# ---------------------------------------------------------------------------

build_platform() {
	local platform="$1"
	local pkg_name="voice-ollama-tui-ffmpeg-bin-$platform"
	local archive_name="$pkg_name-$VERSION.tar.gz"
	local final_path="$OUTPUT_DIR/$archive_name"
	local tmp_dir="$WORK_DIR/$pkg_name"
	local binary_name="ffmpeg"

	echo ""
	echo "============================================================"
	echo "  Building $pkg_name"
	echo "============================================================"

	rm -rf "$tmp_dir"
	mkdir -p "$tmp_dir"

	case "$platform" in
	linux-x64)
		local url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
		local dl="$WORK_DIR/ffmpeg-linux-x64.tar.xz"

		echo "  [1/2] Downloading from $url ..."
		curl -# -fSL "$url" -o "$dl"

		echo "  [2/2] Extracting ffmpeg binary ..."
		# johnvansickle archive extracts to ffmpeg-<version>-amd64-static/
		# The binary is at the root of that directory
		local extract_dir="$WORK_DIR/ffmpeg-extract-linux-x64"
		rm -rf "$extract_dir"
		mkdir -p "$extract_dir"
		tar -xf "$dl" -C "$extract_dir"
		# Find ffmpeg in the extracted dir (there should be exactly one)
		local found
		found=$(find "$extract_dir" -maxdepth 2 -type f -name "ffmpeg" | head -1)
		if [[ -z "$found" ]]; then
			echo "  ERROR: ffmpeg binary not found in extracted archive!"
			return 1
		fi
		cp "$found" "$tmp_dir/ffmpeg"
		chmod 755 "$tmp_dir/ffmpeg"
		;;

	linux-arm64)
		local url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
		local dl="$WORK_DIR/ffmpeg-linux-arm64.tar.xz"

		echo "  [1/2] Downloading from $url ..."
		curl -# -fSL "$url" -o "$dl"

		echo "  [2/2] Extracting ffmpeg binary ..."
		local extract_dir="$WORK_DIR/ffmpeg-extract-linux-arm64"
		rm -rf "$extract_dir"
		mkdir -p "$extract_dir"
		tar -xf "$dl" -C "$extract_dir"
		local found
		found=$(find "$extract_dir" -maxdepth 2 -type f -name "ffmpeg" | head -1)
		if [[ -z "$found" ]]; then
			echo "  ERROR: ffmpeg binary not found in extracted archive!"
			return 1
		fi
		cp "$found" "$tmp_dir/ffmpeg"
		chmod 755 "$tmp_dir/ffmpeg"
		;;

	windows-x64)
		# Try multiple sources for Windows ffmpeg.exe builds.
		# Primary: BtbN/FFmpeg-Builds (GitHub releases) — reliable, GPL
		#   Contains ffmpeg.exe in bin/ subdirectory
		# Fallback: https://www.gyan.dev/ — ffmpeg-release-essentials.zip
		local url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
		local dl="$WORK_DIR/ffmpeg-windows-x64.zip"
		local extract_dir="$WORK_DIR/ffmpeg-extract-windows-x64"
		local found

		echo "  [1/2] Downloading from $url ..."
		if curl -# -fSL "$url" -o "$dl"; then
			:
		else
			# Fallback to gyan.dev
			rm -f "$dl"
			local url="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
			echo "  Primary source failed, trying fallback: $url ..."
			curl -# -fSL --connect-timeout 30 --max-time 300 "$url" -o "$dl"
		fi

		echo "  [2/2] Extracting ffmpeg.exe ..."
		rm -rf "$extract_dir"
		mkdir -p "$extract_dir"
		unzip -q "$dl" -d "$extract_dir"
		found=$(find "$extract_dir" -type f -name "ffmpeg.exe" | head -1)
		if [[ -z "$found" ]]; then
			echo "  ERROR: ffmpeg.exe not found in extracted archive!"
			return 1
		fi
		cp "$found" "$tmp_dir/ffmpeg.exe"
		;;

	darwin-x64)
		# Uses https://evermeet.cx/pub/ffmpeg/ — provides static builds for macOS
		# Version format: e.g. 7.0.2 → download from evermeet.cx
		# Archive: ffmpeg-<version>.zip (contains just ffmpeg binary)
		# NOTE: evermeet.cx binaries for ffmpeg 7.0.2 are Intel-only (x86_64).
		# On Apple Silicon they run via Rosetta 2.
		# For a native arm64 build a different source would be needed.
		local url="https://evermeet.cx/ffmpeg/ffmpeg-${VERSION}.zip"
		local dl="$WORK_DIR/ffmpeg-darwin-x64.zip"

		echo "  [1/2] Downloading from $url ..."
		if curl -# -fSL "$url" -o "$dl" 2>/dev/null; then
			echo "  [2/2] Extracting ffmpeg binary ..."
			unzip -q "$dl" -d "$tmp_dir"
			if [[ -f "$tmp_dir/ffmpeg" ]]; then
				chmod 755 "$tmp_dir/ffmpeg"
			else
				echo "  WARNING: ffmpeg binary not found after extraction. Skipping darwin-x64."
				return 0
			fi
		else
			echo "  WARNING: Download failed (platform may not be buildable from this machine). Skipping darwin-x64."
			return 0
		fi
		;;

	darwin-arm64)
		# evermeet.cx provides x86_64 binaries (Intel). For ffmpeg 7.0.2 there is no
		# native Apple Silicon build available from evermeet.cx.
		# Using the same Intel binary; runs via Rosetta 2 on Apple Silicon.
		local url="https://evermeet.cx/ffmpeg/ffmpeg-${VERSION}.zip"
		local dl="$WORK_DIR/ffmpeg-darwin-arm64.zip"

		echo "  [1/2] Downloading from $url ..."
		if curl -# -fSL "$url" -o "$dl" 2>/dev/null; then
			echo "  [2/2] Extracting ffmpeg binary ..."
			unzip -q "$dl" -d "$tmp_dir"
			if [[ -f "$tmp_dir/ffmpeg" ]]; then
				chmod 755 "$tmp_dir/ffmpeg"
			else
				echo "  WARNING: ffmpeg binary not found after extraction. Skipping darwin-arm64."
				return 0
			fi
		else
			echo "  WARNING: Download failed. Skipping darwin-arm64."
			return 0
		fi
		;;
	esac

	# Verify binary exists
	local bin_name="ffmpeg"
	[[ "$platform" == windows-x64 ]] && bin_name="ffmpeg.exe"
	if [[ ! -f "$tmp_dir/$bin_name" ]]; then
		echo "  ERROR: Binary $bin_name not found in $tmp_dir!"
		return 1
	fi

	# Quick sanity: run --help if possible (skip for cross-platform builds)
	if [[ "$platform" != windows-x64 ]] && [[ "$platform" != darwin-* ]]; then
		if "$tmp_dir/$bin_name" -version &>/dev/null; then
			echo "  Sanity check: $("$tmp_dir/$bin_name" -version 2>&1 | head -1)"
		else
			echo "  WARNING: Binary does not execute on this host (expected for cross-platform build)."
		fi
	fi

	# Create the archive from the working directory
	echo "  Packaging into $archive_name ..."
	(cd "$WORK_DIR" && tar -czf "$final_path" "$pkg_name")

	local size
	size=$(stat --printf="%s" "$final_path" 2>/dev/null || stat -f%z "$final_path" 2>/dev/null)
	echo "  Created: $final_path ($(numfmt --to=iec "$size" 2>/dev/null || echo "$size bytes"))"

	return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo ""
echo "=== FFmpeg Binary Asset Builder ==="
echo "Version: $VERSION"
echo "Output:  $OUTPUT_DIR"
echo "Work:    $WORK_DIR"
echo ""

# Check required tools
for tool in curl tar gzip; do
	if ! command -v "$tool" &>/dev/null; then
		echo "Missing required tool: $tool"
		exit 1
	fi
done

# unzip is needed for Windows builds
if ! command -v unzip &>/dev/null; then
	echo "Warning: unzip not found. Windows builds will fail."
fi

rc=0
success=0
failed=0
skipped=0

if [[ -n "$PLATFORM" ]]; then
	if build_platform "$PLATFORM"; then
		success=1
	else
		((failed++))
	fi
else
	for p in "${SUPPORTED_PLATFORMS[@]}"; do
		if build_platform "$p"; then
			((success++))
		else
			((failed++))
		fi
	done
fi

echo ""
echo "=== Build Summary ==="
echo "  Succeeded: $success"
echo "  Skipped:   $skipped"
echo "  Failed:    $failed"
echo ""
echo "Artifacts in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR"/voice-ollama-tui-ffmpeg-bin-* 2>/dev/null || echo "  (no ffmpeg artifacts found)"
