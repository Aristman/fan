#!/bin/sh
#
# FAN (fan) one-liner installer for Unix (macOS + Linux).
# Usage:
#   curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
#
# Environment:
#   FAN_INSTALL_DIR  Custom install directory (default: ~/.local/bin)
#   CI=true          Skip confirmation prompts
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

info()  { printf "${BLUE}${BOLD}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
warn()  { printf "${YELLOW}Warning:${RESET} %s\n" "$1" >&2; }
error() { printf "${RED}Error:${RESET} %s\n" "$1" >&2; }
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

# ─── Install directory ─────────────────────────────────────────
resolve_install_dir() {
    if [ -n "${FAN_INSTALL_DIR:-}" ]; then
        INSTALL_DIR="$FAN_INSTALL_DIR"
    else
        INSTALL_DIR="$HOME/.local/bin"
    fi

    # Fallback chain: ~/.local/bin → ~/bin → /usr/local/bin (with sudo)
    if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
        if [ -d "$HOME/bin" ] || mkdir -p "$HOME/bin" 2>/dev/null; then
            INSTALL_DIR="$HOME/bin"
        else
            INSTALL_DIR="/usr/local/bin"
            NEED_SUDO=true
        fi
    else
        NEED_SUDO=false
    fi

    INSTALL_PATH="${INSTALL_DIR}/fan"
}

# ─── Check if already installed ────────────────────────────────
check_existing() {
    # If INSTALL_PATH is a directory (e.g. from old install), remove it
    if [ -d "${INSTALL_PATH}" ] && [ ! -f "${INSTALL_PATH}/fan" ]; then
        warn "${INSTALL_PATH} is a directory — replacing with binary..."
        rm -rf "${INSTALL_PATH}"
    fi

    if [ -f "${INSTALL_PATH}" ]; then
        EXISTING_VERSION=$("${INSTALL_PATH}" --version 2>/dev/null || echo "unknown")
        if [ "${CI:-}" = "true" ]; then
            info "Reinstalling fan (current: ${EXISTING_VERSION})..."
        else
            printf "${YELLOW}fan is already installed at ${INSTALL_PATH} (version ${EXISTING_VERSION}).${RESET}\n"
            printf "Reinstall? [y/N] "
            read -r answer
            case "$answer" in
                y|Y|yes) ;;
                *) echo "Aborted." && exit 0 ;;
            esac
        fi
    fi
}

# ─── Add to PATH ───────────────────────────────────────────────
add_to_path() {
    # Check if INSTALL_DIR is already in PATH
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*) return 0 ;;
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
        echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$SHELL_RC"
        info "Added ${INSTALL_DIR} to PATH in ${SHELL_RC}"
        warn "Restart your shell or run: export PATH=\"${INSTALL_DIR}:\$PATH\""
    else
        warn "Could not find shell config file. Add ${INSTALL_DIR} to your PATH manually."
    fi
}

# ─── Main installation ─────────────────────────────────────────
main() {
    info "Installing FAN (fan)..."

    detect_platform
    info "Detected platform: ${PLATFORM}"

    resolve_install_dir
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

    # Parse manifest (POSIX-safe: use grep + sed)
    LATEST_VERSION="$(grep '"latest"' "$MANIFEST_FILE" | head -1 | sed 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
    if [ -z "$LATEST_VERSION" ]; then
        error "Failed to parse manifest: could not find latest version"
        exit 1
    fi
    info "Latest version: ${LATEST_VERSION}"

    # Get platform-specific info from manifest
    # Extract hash for this platform
    EXPECTED_HASH=""
    if command -v python3 >/dev/null 2>&1; then
        EXPECTED_HASH="$(python3 -c "
import json, sys
with open('$MANIFEST_FILE') as f:
    m = json.load(f)
p = m.get('platforms', {}).get('$PLATFORM', {})
print(p.get('hash', ''))
")"
    else
        # Fallback: grep-based extraction (fragile but works for simple JSON)
        EXPECTED_HASH="$(grep -A5 "\"${PLATFORM}\"" "$MANIFEST_FILE" | grep '"hash"' | head -1 | sed 's/.*"hash"[[:space:]]*:[[:space:]]*"sha256:\([^"]*\)".*/\1/')"
    fi
    EXPECTED_HASH="${EXPECTED_HASH#sha256:}"

    # Determine archive format and URL
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
            # The archive contains a 'fan' directory with all files
            BINARY_SRC="${EXTRACT_DIR}/fan/fan"
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
            BINARY_SRC="${EXTRACT_DIR}/fan/fan.exe"
            ;;
    esac

    if [ ! -f "$BINARY_SRC" ]; then
        error "Binary not found in archive at ${BINARY_SRC}"
        exit 1
    fi

    # Install binary
    info "Installing fan to ${INSTALL_PATH}..."
    if [ "${NEED_SUDO:-false}" = "true" ]; then
        sudo mkdir -p "$INSTALL_DIR"
        sudo cp "$BINARY_SRC" "$INSTALL_PATH"
        sudo chmod +x "$INSTALL_PATH"
    else
        mkdir -p "$INSTALL_DIR"
        cp "$BINARY_SRC" "$INSTALL_PATH"
        chmod +x "$INSTALL_PATH"
    fi

    # Verify installation
    if "$INSTALL_PATH" --version >/dev/null 2>&1; then
        INSTALLED_VERSION="$("$INSTALL_PATH" --version)"
        success "fan ${INSTALLED_VERSION} installed successfully!"
    else
        error "Installation verification failed. Binary may not be executable."
        exit 1
    fi

    # Add to PATH if needed
    add_to_path

    # Print next steps
    echo ""
    printf "${BOLD}Next steps:${RESET}\n"
    printf "  1. ${DIM}Restart your shell or run:${RESET} export PATH=\"${INSTALL_DIR}:\$PATH\"\n"
    printf "  2. ${DIM}Initialize FAN:${RESET} ${GREEN}fan init${RESET}\n"
    printf "  3. ${DIM}Check for updates:${RESET} ${GREEN}fan update${RESET}\n"
    echo ""
}

main "$@"
