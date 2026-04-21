#!/bin/sh
#
# FAN (fan) one-liner installer for Unix (macOS + Linux).
# Usage:
#   curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
#
# Environment:
#   FAN_INSTALL_DIR  Custom data directory (default: ~/.local/share/fan)
#   FAN_BIN_DIR      Custom binary symlink directory (default: ~/.local/bin)
#   CI=true          Skip confirmation prompts
#
# Install layout:
#   ~/.local/share/fan/    ← all files (binary, assets, dashboard, etc.)
#   ~/.local/bin/fan       ← symlink → ~/.local/share/fan/fan
#

set -e

# ─── Terminal color helpers ────────────────────────────────────
if [ -t 1 ] && [ -t 2 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    DIM='\033[2m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' BOLD='' DIM='' RESET=''
fi

info()    { printf "${BLUE}${BOLD}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
warn()    { printf "${YELLOW}Warning:${RESET} %s\n" "$1" >&2; }
error()   { printf "${RED}Error:${RESET} %s\n" "$1" >&2; }
success() { printf "${GREEN}${BOLD}Success:${RESET} %s\n" "$1"; }

cleanup() {
    if [ -n "${TMPDIR_FAN:-}" ] && [ -d "${TMPDIR_FAN}" ]; then
        rm -rf "${TMPDIR_FAN}"
    fi
}
trap cleanup EXIT

# ─── OS / Arch detection ───────────────────────────────────────
detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Darwin) PLATFORM_OS="darwin" ;;
        Linux)  PLATFORM_OS="linux" ;;
        *)
            error "Unsupported operating system: $OS"
            exit 1
            ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  PLATFORM_ARCH="x64" ;;
        aarch64|arm64) PLATFORM_ARCH="arm64" ;;
        armv7l)        PLATFORM_ARCH="arm64" ;;  # fallback
        *)
            error "Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac

    PLATFORM="${PLATFORM_OS}-${PLATFORM_ARCH}"
}

# ─── Resolve install directories ───────────────────────────────
resolve_install_dirs() {
    # Data directory: all fan files live here
    if [ -n "${FAN_INSTALL_DIR:-}" ]; then
        DATA_DIR="$FAN_INSTALL_DIR"
    else
        DATA_DIR="$HOME/.local/share/fan"
    fi

    # Binary directory: symlink lives here
    if [ -n "${FAN_BIN_DIR:-}" ]; then
        BIN_DIR="$FAN_BIN_DIR"
    else
        BIN_DIR="$HOME/.local/bin"
    fi

    # Fallback chain for BIN_DIR: ~/.local/bin → ~/bin → /usr/local/bin
    NEED_SUDO=false
    if ! mkdir -p "$BIN_DIR" 2>/dev/null; then
        if [ -d "$HOME/bin" ] || mkdir -p "$HOME/bin" 2>/dev/null; then
            BIN_DIR="$HOME/bin"
        else
            BIN_DIR="/usr/local/bin"
            NEED_SUDO=true
        fi
    fi

    SYMLINK_PATH="${BIN_DIR}/fan"
    DATA_BIN="${DATA_DIR}/fan"
}

# ─── Check if already installed ────────────────────────────────
check_existing() {
    if [ -L "$SYMLINK_PATH" ] || [ -f "$SYMLINK_PATH" ]; then
        # Already installed (symlink or file)
        EXISTING_VERSION="$("$SYMLINK_PATH" --version 2>/dev/null || echo "unknown")"
        if [ "${CI:-}" = "true" ]; then
            info "Reinstalling fan (current: ${EXISTING_VERSION})..."
        else
            printf "${YELLOW}fan is already installed (version ${EXISTING_VERSION}).${RESET}\n"
            printf "Reinstall? [y/N] "
            read -r answer
            case "$answer" in
                y|Y|yes) ;;
                *) echo "Aborted." && exit 0 ;;
            esac
        fi
    elif [ -d "$SYMLINK_PATH" ]; then
        # Old install: fan was a directory, not a symlink
        warn "Removing old installation at ${SYMLINK_PATH}..."
        rm -rf "$SYMLINK_PATH"
    fi
}

# ─── Add BIN_DIR to PATH ──────────────────────────────────────
add_to_path() {
    case ":${PATH}:" in
        *":${BIN_DIR}:"*) return 0 ;;
    esac

    SHELL_RC=""
    if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
        if [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"; fi
    fi
    if [ -z "$SHELL_RC" ] && [ -f "$HOME/.bashrc" ]; then
        SHELL_RC="$HOME/.bashrc"
    fi
    if [ -z "$SHELL_RC" ] && [ -f "$HOME/.profile" ]; then
        SHELL_RC="$HOME/.profile"
    fi

    if [ -n "$SHELL_RC" ]; then
        echo "" >> "$SHELL_RC"
        echo "# Added by FAN installer" >> "$SHELL_RC"
        echo "export PATH=\"${BIN_DIR}:\$PATH\"" >> "$SHELL_RC"
        info "Added ${BIN_DIR} to PATH in ${SHELL_RC}"
        warn "Restart your shell or run: export PATH=\"${BIN_DIR}:\$PATH\""
    else
        warn "Could not find shell config file. Add ${BIN_DIR} to your PATH manually."
    fi
}

# ─── Main installation ─────────────────────────────────────────
main() {
    info "Installing FAN (fan)..."

    detect_platform
    info "Detected platform: ${PLATFORM}"

    resolve_install_dirs
    check_existing

    # Fetch manifest
    MANIFEST_URL="http://185.219.41.46/fan/dist/manifest.json"
    info "Fetching manifest..."

    TMPDIR_FAN="$(mktemp -d)"
    MANIFEST_FILE="${TMPDIR_FAN}/manifest.json"

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --max-time 30 "$MANIFEST_URL" -o "$MANIFEST_FILE" || {
            error "Failed to download manifest from ${MANIFEST_URL}"
            exit 1
        }
    elif command -v wget >/dev/null 2>&1; then
        wget -q --timeout=30 -O "$MANIFEST_FILE" "$MANIFEST_URL" || {
            error "Failed to download manifest from ${MANIFEST_URL}"
            exit 1
        }
    else
        error "Neither curl nor wget is available. Please install one of them."
        exit 1
    fi

    # Parse manifest
    LATEST_VERSION="$(grep '"latest"' "$MANIFEST_FILE" | head -1 | sed 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
    if [ -z "$LATEST_VERSION" ]; then
        error "Failed to parse manifest: could not find latest version"
        exit 1
    fi
    info "Latest version: ${LATEST_VERSION}"

    # Get platform-specific hash
    EXPECTED_HASH=""
    if command -v python3 >/dev/null 2>&1; then
        EXPECTED_HASH="$(python3 -c "
import json
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
p = m.get('platforms', {}).get('$PLATFORM', {})
print(p.get('hash', ''))
")"
    else
        EXPECTED_HASH="$(grep -A5 "\"${PLATFORM}\"" "$MANIFEST_FILE" | grep '"hash"' | head -1 | sed 's/.*"hash"[[:space:]]*:[[:space:]]*"sha256:\([^"]*\)".*/\1/')"
    fi
    EXPECTED_HASH="${EXPECTED_HASH#sha256:}"

    # Determine archive name
    case "$PLATFORM" in
        *windows*)
            ARCHIVE_NAME="fan-${LATEST_VERSION}-${PLATFORM}.zip"
            ;;
        *)
            ARCHIVE_NAME="fan-${LATEST_VERSION}-${PLATFORM}.tar.gz"
            ;;
    esac

    ARCHIVE_URL="http://185.219.41.46/fan/dist/${ARCHIVE_NAME}"
    ARCHIVE_FILE="${TMPDIR_FAN}/${ARCHIVE_NAME}"

    # Download archive
    info "Downloading ${ARCHIVE_NAME}..."
    if command -v curl >/dev/null 2>&1; then
        curl -fSL --progress-bar --max-time 120 "$ARCHIVE_URL" -o "$ARCHIVE_FILE" || {
            error "Failed to download ${ARCHIVE_URL}"
            exit 1
        }
    elif command -v wget >/dev/null 2>&1; then
        wget --progress=bar:force --timeout=120 -O "$ARCHIVE_FILE" "$ARCHIVE_URL" || {
            error "Failed to download ${ARCHIVE_URL}"
            exit 1
        }
    fi
    echo ""

    # Verify SHA-256 hash
    if [ -n "$EXPECTED_HASH" ]; then
        info "Verifying SHA-256 checksum..."
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL_HASH="$(sha256sum "$ARCHIVE_FILE" | cut -d' ' -f1)"
        elif command -v shasum >/dev/null 2>&1; then
            ACTUAL_HASH="$(shasum -a 256 "$ARCHIVE_FILE" | cut -d' ' -f1)"
        else
            warn "sha256sum/shasum not found — skipping verification"
            ACTUAL_HASH=""
        fi

        if [ -n "$ACTUAL_HASH" ] && [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
            error "SHA-256 checksum mismatch!"
            error "  Expected: ${EXPECTED_HASH}"
            error "  Actual:   ${ACTUAL_HASH}"
            exit 1
        fi
        info "Checksum verified."
    fi

    # Extract archive
    EXTRACT_DIR="${TMPDIR_FAN}/extract"
    mkdir -p "$EXTRACT_DIR"

    info "Extracting archive..."
    case "$ARCHIVE_NAME" in
        *.tar.gz)
            tar xzf "$ARCHIVE_FILE" -C "$EXTRACT_DIR" || {
                error "Failed to extract archive"
                exit 1
            }
            ;;
        *.zip)
            if command -v unzip >/dev/null 2>&1; then
                unzip -q "$ARCHIVE_FILE" -d "$EXTRACT_DIR" || {
                    error "Failed to extract archive"
                    exit 1
                }
            else
                error "unzip is required to extract .zip archives"
                exit 1
            fi
            ;;
    esac

    # Locate the extracted 'fan' directory (wrapper dir in both tar.gz and zip)
    SOURCE_DIR="${EXTRACT_DIR}/fan"
    if [ ! -d "$SOURCE_DIR" ]; then
        error "Archive does not contain expected 'fan' directory"
        exit 1
    fi

    # Verify binary exists in extracted directory
    if [ ! -f "${SOURCE_DIR}/fan" ]; then
        error "Binary not found in archive at ${SOURCE_DIR}/fan"
        exit 1
    fi

    # Install: copy entire directory to DATA_DIR
    info "Installing to ${DATA_DIR}/..."

    # Remove old data directory contents (keep directory itself)
    if [ -d "$DATA_DIR" ]; then
        rm -rf "${DATA_DIR:?}"/*
    fi
    mkdir -p "$DATA_DIR"

    # Copy all files from archive
    cp -a "$SOURCE_DIR/." "$DATA_DIR/"
    chmod +x "$DATA_BIN"

    # Create symlink in BIN_DIR
    if [ "${NEED_SUDO:-false}" = "true" ]; then
        sudo rm -f "$SYMLINK_PATH"
        sudo ln -s "$DATA_BIN" "$SYMLINK_PATH"
    else
        rm -f "$SYMLINK_PATH"
        ln -s "$DATA_BIN" "$SYMLINK_PATH"
    fi

    # Verify installation
    if "$SYMLINK_PATH" --version >/dev/null 2>&1; then
        INSTALLED_VERSION="$("$SYMLINK_PATH" --version)"
        success "fan ${INSTALLED_VERSION} installed successfully!"
        info "  Binary:  ${SYMLINK_PATH} → ${DATA_BIN}"
        info "  Data:    ${DATA_DIR}/"
    else
        error "Installation verification failed."
        exit 1
    fi

    # Add BIN_DIR to PATH if needed
    add_to_path

    # Print next steps
    echo ""
    printf "${BOLD}Next steps:${RESET}\n"
    printf "  1. ${DIM}Restart your shell or run:${RESET} export PATH=\"${BIN_DIR}:\$PATH\"\n"
    printf "  2. ${DIM}Initialize FAN:${RESET} ${GREEN}fan init${RESET}\n"
    printf "  3. ${DIM}Check for updates:${RESET} ${GREEN}fan update${RESET}\n"
    echo ""
}

main "$@"
