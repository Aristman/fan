# Installation Guide

Complete installation instructions for FAN (Filin Agent Next) — a local AI runtime-agent for developers.

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **OS** | Windows 10+, Ubuntu 20.04+, Fedora 36+, Arch Linux, macOS 12+ | Latest stable |
| **Disk** | 200 MB for binary | 500 MB+ for sessions and data |
| **RAM** | 512 MB | 2 GB+ |
| **Network** | Internet access for AI provider APIs | Stable broadband |

**Runtime (pre-built binary):** None — standalone executable, no Node.js required.

**Build (source install only):** Node.js 24+, npm 10+, C/C++ compiler (gcc/clang/MSVC), Python 3.9+, Git 2.30+.

---

## Method A: One-Liner Installer (Recommended)

The fastest way to install FAN. The script detects your OS and architecture automatically.

### macOS / Linux

```bash
curl -fsSL http://185.219.41.46/fan/dist/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm http://185.219.41.46/fan/dist/install.ps1 | iex
```

The installer will:
1. Detect OS and architecture
2. Download the latest binary
3. Verify SHA-256 checksum
4. Extract to `~/.local/share/fan/` (Unix) or `%LOCALAPPDATA%\fan` (Windows)
5. Create a symlink or add to PATH automatically

**Custom install location:** set `FAN_INSTALL_DIR` or `FAN_BIN_DIR` environment variables before running the script.

---

## Method B: Download Pre-built Binary

### Step 1: Download

Pre-built binaries are created automatically by CI/CD on every release.
Go to [GitHub Releases](https://github.com/user/fan/releases) and download for your platform:

| Platform | File |
|----------|------|
| macOS ARM (Apple Silicon) | `fan-darwin-arm64.tar.gz` |
| macOS Intel | `fan-darwin-x64.tar.gz` |
| Linux x64 | `fan-linux-x64.tar.gz` |
| Linux ARM64 | `fan-linux-arm64.tar.gz` |
| Windows x64 | `fan-windows-x64.zip` |

Or via command line:

```bash
# macOS ARM
curl -LO https://github.com/user/fan/releases/latest/download/fan-darwin-arm64.tar.gz
# macOS Intel
curl -LO https://github.com/user/fan/releases/latest/download/fan-darwin-x64.tar.gz
# Linux x64
curl -LO https://github.com/user/fan/releases/latest/download/fan-linux-x64.tar.gz
# Linux ARM64
curl -LO https://github.com/user/fan/releases/latest/download/fan-linux-arm64.tar.gz
# Windows (PowerShell)
Invoke-WebRequest -Uri https://github.com/user/fan/releases/latest/download/fan-windows-x64.zip -OutFile fan-windows-x64.zip
```

> **Tip:** Check your architecture: `uname -m` on Linux/macOS (`arm64` = Apple Silicon/ARM64, `x86_64` = Intel/x64). On Windows: `echo %PROCESSOR_ARCHITECTURE%`.

### Step 2: Extract

**macOS / Linux:**

```bash
mkdir -p ~/.local/bin && cd ~/.local/bin
tar xzf ~/Downloads/fan-darwin-arm64.tar.gz   # replace with your platform file
```

**Windows:**

```powershell
`Expand-Archive -Path .\fan-windows-x64.zip -DestinationPath $env:USERPROFILE\bin\fan`
```

### Step 3: Add to PATH

**macOS / Linux (zsh):**

```bash
echo 'export PATH="$HOME/.local/bin/fan:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

**macOS / Linux (bash):**

```bash
echo 'export PATH="$HOME/.local/bin/fan:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**Linux (system-wide, no PATH editing needed):**

```bash
sudo cp ~/.local/bin/fan /usr/local/bin/fan
```

**Windows (PowerShell — permanent):**

```powershell
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$currentPath;$env:USERPROFILE\bin\fan", "User")
$env:Path += ";$env:USERPROFILE\bin\fan"
```

**Windows (GUI):** `Win+R` → `sysdm.cpl` → **Advanced** → **Environment Variables** → Edit user `Path` → Add `%USERPROFILE%\bin\fan` → Restart terminals.

### Step 4: Verify

```bash
fan --version
# fan v1.0.0

# Verify the web dashboard works
fan --web
# → Dashboard available at http://localhost:3456
```

---

## Method C: Install from Source

For contributors or users who want to modify FAN.

### Prerequisites

| Platform | Compiler | Install |
|----------|----------|---------|
| Windows | MSVC 2022 | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — select "Desktop development with C++" |
| macOS | Apple Clang | `xcode-select --install` |
| Ubuntu/Debian | GCC | `sudo apt install build-essential python3` |
| Fedora | GCC | `sudo dnf groupinstall "Development Tools" && sudo dnf install python3` |
| Arch | GCC | `sudo pacman -S base-devel python` |

### Install Node.js 24+

**macOS / Linux (NodeSource):**

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
# Fedora
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash - && sudo dnf install -y nodejs
# macOS (Homebrew)
brew install node@24
# Arch (usually has latest)
sudo pacman -Syu nodejs npm
```

**Windows:** Download from [nodejs.org](https://nodejs.org/) (LTS `.msi` installer, check "Add to PATH").

Verify: `node --version` → `v24.x.x`, `npm --version` → `10.x.x`.

### Build

```bash
git clone https://github.com/user/fan.git
cd fan
npm install
npm run build
```

Builds all 10 monorepo packages (1–3 minutes). Output should end with: `Build complete — 0 errors`.

### Create Symlink

**macOS / Linux:**

```bash
# User-level
mkdir -p ~/.local/bin
ln -sf "$(pwd)/packages/fan-tui/dist/index.js" ~/.local/bin/fan
# Or system-wide
sudo ln -sf "$(pwd)/packages/fan-tui/dist/index.js" /usr/local/bin/fan
```

**Windows:**

```powershell
$binDir = "$env:USERPROFILE\bin\fan"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
@"
@echo off
node "$(Get-Location)\packages\fan-tui\dist\index.js" %*
"@ | Out-File -Encoding ascii "$binDir\fan.cmd"
# Then add to PATH (see Method A, Step 3)
```

Verify: `fan --version`.

---

## First-Time Configuration

### Option A: Setup Wizard (Recommended)

```bash
fan init
```

Interactive wizard guides you through provider selection, API key entry, model choice, and settings. Creates `~/.fan/agent/settings.json`, `~/.fan/agent/models.json`, and optionally `.env`.

### Option B: Manual Configuration

```bash
# Create config directory
mkdir -p ~/.fan/agent

# Create .env with API keys
cat > ~/.fan/agent/.env << 'EOF'
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_API_KEY=...
# GROQ_API_KEY=gsk_...
# XAI_API_KEY=xai-...
# MISTRAL_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
# GITHUB_TOKEN=ghp_...
# CEREBRAS_API_KEY=...
# ZAI_API_KEY=...
EOF
chmod 600 ~/.fan/agent/.env

# Create settings.json
cat > ~/.fan/agent/settings.json << 'EOF'
{
  "provider": "openai",
  "model": "gpt-4o",
  "temperature": 0.7,
  "maxTokens": 4096,
  "thinking": false
}
EOF
```

> **Security:** Keys are stored locally and only sent directly to the respective AI provider API. No third-party servers.

---

## Verify Installation

```bash
fan doctor
```

Checks binary version, config files, API key reachability, default model response, file permissions, and disk space. All checks should pass.

---

## Quick Start

```bash
# Web dashboard (recommended — API server + UI)
fan --web

# Interactive TUI
fan

# Background daemon (for IDE plugins)
fan server start

# Server in foreground
fan server

# Check server status
fan server status

# API server with web dashboard (equivalent to --web)
fan --mode server

# Custom port
fan --web --port 3000

# Run diagnostics
fan doctor

# Interactive setup
fan init

# Version / help
fan --version
fan --help
```

**Slash commands (inside TUI):** `/plan <task>`, `/delegate <task>`, `/model <name>`, `/budget`, `/settings`, `/clear`, `/help`, `/quit`.

---

## Platform-Specific Troubleshooting

### Windows

**PowerShell execution policy:**

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**CRLF line endings (source build):**

```powershell
git config --global core.autocrlf input
```

**Clipboard module errors:** Install [VC++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist):

```powershell
winget install Microsoft.VCRedist.2015+.x64
```

**Antivirus false positives:** Add exclusion in Windows Security → **Exclusions** → add the FAN install directory.

### macOS

**Apple Silicon vs Intel:** `uname -m` → `arm64` (use `darwin-arm64`) or `x86_64` (use `darwin-x64`).

**Homebrew Node conflicts:** `which node` to check. `brew unlink node` to remove Homebrew's version if using the official installer.

**Gatekeeper blocking unsigned binary:**

```bash
xattr -d com.apple.quarantine /path/to/fan
# Or: System Preferences → Security & Privacy → "Open Anyway"
```

**Xcode CLI tools missing:** `xcode-select --install` (or `sudo xcode-select --reset` if already installed but broken).

### Linux

**Permission denied:** `chmod +x ~/.local/bin/fan`

**Missing image libraries:**

```bash
# Ubuntu/Debian
sudo apt install -y libvips42 libglib2.0-0
# Fedora
sudo dnf install -y vips glib2
# Arch
sudo pacman -S libvips glib2
```

If `libvips.so` not found: `export LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH`

**Wayland clipboard issues:** Install `sudo apt install -y xclip` or `xsel` for X11 clipboard support.

**AppImage vs binary:** Both are identical in functionality. AppImage is self-contained; plain binary is smaller but needs shared libraries.

---

## Uninstalling

**macOS / Linux:**

```bash
rm ~/.local/bin/fan                    # or: sudo rm /usr/local/bin/fan
rm -rf ~/.fan/                         # config, sessions, database
# In each project directory:
rm -rf .fan/                           # project-level config
```

**Windows:**

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\bin\fan"
# Remove from PATH: edit user Path variable, remove the fan entry
Remove-Item -Recurse -Force "$env:USERPROFILE\.fan"
# In each project directory:
Remove-Item -Recurse -Force .fan
```

**Source install** — also remove the cloned repo: `rm -rf ~/fan`

> **Warning:** Deleting `~/.fan/` removes all session history. Back up first: `cp -r ~/.fan/agent/sessions/ ~/fan-sessions-backup/`

| Removed item | Location | Contents |
|-------------|----------|----------|
| Binary | `~/.local/bin/fan` or `/usr/local/bin/fan` | Executable |
| Config | `~/.fan/agent/` | Settings, models, API keys |
| Sessions | `~/.fan/agent/sessions/` | Chat history (JSONL) |
| Database | `~/.fan/agent/prisma/` | SQLite metadata |
| Project config | `<project>/.fan/` | Per-project settings |
