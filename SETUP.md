# FAN — Setup Guide

Complete installation and configuration for Windows, Ubuntu (Linux), and macOS.

## Quick Start (Recommended)

The fastest way to get started:

1. Install FAN (see [INSTALL.md](INSTALL.md) for platform-specific instructions)
2. Run the setup wizard:
   ```bash
   fan init
   ```
3. Verify everything works:
   ```bash
   fan doctor
   ```
4. Start using FAN:
   ```bash
   # Web dashboard (recommended)
   fan --web
   # → Dashboard available at http://localhost:3456
   ```
   Or use the interactive TUI:
   ```bash
   fan
   ```

The `fan init` wizard walks you through provider selection, API key configuration, budget limits, and thinking level. All settings are saved to `~/.fan/agent/` and can be edited manually later (see [Configuration](#configuration) below).

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥ 24.0 | `node --version` |
| npm | ≥ 10.0 | `npm --version` |
| Git | any | `git --version` |
| C/C++ compiler | any | `gcc --version` / `cl.exe` (for native modules) |

### Install Node.js 24

**Windows:**
```powershell
# Via winget
winget install OpenJS.NodeJS.LTS

# Or download from https://nodejs.org (v24+)
```

**Ubuntu/Debian:**
```bash
# Via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24
nvm use 24
```

**macOS:**
```bash
# Via Homebrew
brew install node@24

# Or via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24
nvm use 24
```

---

## Manual Setup (Advanced)

If you prefer to set up manually instead of using `fan init`, follow the steps below.

### Clone & Install

```bash
git clone https://oneproject.it-one.ru/stash/scm/ailab/fan.git
cd fan
npm install
```

### Linux: fix executable permissions

On some Linux systems, npm may create symlinks without execute permission:
```bash
chmod +x node_modules/.bin/*
```

### Platform-specific native modules

The project uses [tsgo](https://github.com/nicholasgasior/ts-go) (native TypeScript compiler). Install the platform-specific native binding:

```bash
# Linux x64
npm install @typescript/native-preview-linux-x64 --save-dev

# macOS ARM
npm install @typescript/native-preview-darwin-arm64 --save-dev

# macOS x64
npm install @typescript/native-preview-darwin-x64 --save-dev

# Windows x64 (usually included automatically)
npm install @typescript/native-preview-win32-x64 --save-dev
```

### Build

```bash
npm run build
```

Builds 10 packages sequentially: db → tui → ai → agent → model-manager → api-gateway → coding-agent → web-ui → orchestrator.

> **Note:** Dashboard (`packages/dashboard/`) is a separate Vite app. Build it separately:
> ```bash
> cd packages/dashboard && npm run build
> ```

### Verify installation

```bash
fan doctor
```

This runs diagnostics on your Node version, native modules, configuration files, API keys, and available models. Fix any reported issues before proceeding.

---

## Configuration

### 1. API Keys

Set provider API keys as environment variables. Create a `.env` file in project root (not committed):

```bash
# Provider API keys (note: custom suffix _AFAN_KEY for most providers)
ANTHROPIC_AFAN_KEY=sk-ant-...
OPENAI_AFAN_KEY=sk-...
GEMINI_AFAN_KEY=...
ZAI_API_KEY=...

# Runtime flags
FAN_NO_AUTH=1           # Disable API gateway auth (dev mode)
FAN_OFFLINE=1           # Skip version checks
```

**Provider → Environment Variable mapping:**

| Provider | Variable |
|----------|----------|
| Anthropic | `ANTHROPIC_AFAN_KEY` |
| OpenAI | `OPENAI_AFAN_KEY` |
| Google Gemini | `GEMINI_AFAN_KEY` |
| OpenRouter | `OPENROUTER_AFAN_KEY` |
| Groq | `GROQ_AFAN_KEY` |
| xAI | `XAI_AFAN_KEY` |
| Z.AI | `ZAI_API_KEY` |
| Mistral | `MISTRAL_AFAN_KEY` |
| Cerebras | `CEREBRAS_AFAN_KEY` |
| HuggingFace | `HF_TOKEN` |
| Ollama / LM Studio | _(no key needed)_ |

> **Tip:** Run `fan init` to configure API keys interactively instead of editing `.env` manually.

### 2. Project Settings (`.fan/settings.json`)

Create `.fan/settings.json` in project root to set default provider and model:

```json
{
  "defaultProvider": "zai",
  "defaultModel": "zai/glm-5-turbo",
  "defaultThinkingLevel": "medium",
  "hideThinkingBlock": false,
  "transport": "sse"
}
```

| Field | Description | Values |
|-------|-------------|--------|
| `defaultProvider` | Provider ID from `models.json` or built-in | `anthropic`, `openai`, `zai`, etc. |
| `defaultModel` | Full model reference | `provider/model-id` |
| `defaultThinkingLevel` | Default thinking/reasoning level | `off`, `low`, `medium`, `high` |
| `hideThinkingBlock` | Hide thinking blocks in TUI | `true` / `false` |
| `transport` | LLM transport protocol | `sse`, `streaming` |

### 3. Custom Models (`~/.fan/agent/models.json`)

Add custom providers not in the built-in registry (2000+ models). Create `~/.fan/agent/models.json`:

```bash
mkdir -p ~/.fan/agent
cat > ~/.fan/agent/models.json << 'EOF'
{
  "providers": {
    "zai": {
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "api": "openai-completions",
      "apiKey": "your-key",
      "compat": {
        "supportsDeveloperRole": false,
        "thinkingFormat": "zai"
      },
      "models": [
        {
          "id": "glm-5-turbo",
          "name": "GLM-5 Turbo",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
EOF
```

**Key fields:**

| Field | Description |
|-------|-------------|
| `baseUrl` | API endpoint URL |
| `api` | Protocol: `openai-completions`, `anthropic`, `google` |
| `apiKey` | Key string or `${ENV_VAR}` reference |
| `compat.thinkingFormat` | `openai`, `anthropic`, `zai`, `deepseek` |
| `models[].id` | Model ID (used in `defaultModel` as `provider/model-id`) |
| `models[].reasoning` | `true` for thinking/reasoning models |
| `models[].cost` | Per-token costs for budget tracking |

### Configuration File Locations

| File | Global Location | Project-Level |
|------|-----------------|---------------|
| `models.json` | `~/.fan/agent/models.json` | ❌ Not supported |
| `settings.json` | `~/.fan/agent/settings.json` | `<project>/.fan/settings.json` |
| `auth.json` | `~/.fan/agent/auth.json` | ❌ Not supported |
| `extensions/` | `~/.fan/agent/extensions/` | `<project>/.fan/extensions/` |
| `memory/` | `~/.fan/agent/memory/` | `<project>/.fan/memory/` |

---

## Run

```bash
# Interactive TUI
fan

# Web dashboard (recommended — API server + UI)
fan --web

# Server in foreground
fan server

# Background daemon (for IDE plugins)
fan server start

# Check server status
fan server status

# Server mode (API-only, equivalent to --web)
fan --mode server --port 3456

# Single prompt
fan -p "Hello, world!"

# Server without auth (dev)
FAN_NO_AUTH=1 fan --web --port 3456

# Dashboard dev mode (separate terminal, HMR)
cd packages/dashboard && npm run dev
# → http://localhost:5174
```

---

## Troubleshooting

### `tsgo: Unable to resolve @typescript/native-preview-*`
Install the native binding for your platform (see [Manual Setup](#manual-setup-advanced)). Run:
```bash
npm install @typescript/native-preview-<os>-<arch> --save-dev
```

### `prisma: Permission denied` (Linux)
```bash
chmod +x node_modules/.bin/*
```

### `MODULE_NOT_FOUND` when running CLI
Make sure you run from project root, not from a subdirectory:
```bash
# ❌ Wrong (from packages/db/)
fan

# ✅ Correct (from project root)
cd ~/projects/fan
fan
```

### Empty sessions in dashboard
Ensure the server was rebuilt after code changes:
```bash
cd packages/coding-agent && npm run build
```

### API key not picked up
Check the env var name — FAN uses `_AFAN_KEY` suffix (not `_API_KEY`):
```bash
# ❌ Wrong
export ANTHROPIC_API_KEY=sk-...

# ✅ Correct
export ANTHROPIC_AFAN_KEY=sk-...
```

Exception: Z.AI uses `ZAI_API_KEY` (no suffix).

### `fan init` fails
- **Check Node version:** FAN requires Node.js ≥ 24.0. Run `node --version` to verify.
- **Check disk permissions:** Ensure `~/.fan/agent/` is writable. Run:
  ```bash
  mkdir -p ~/.fan/agent && test -w ~/.fan/agent && echo "OK" || echo "PERMISSION DENIED"
  ```
- **Check npm install:** If native modules are missing, run `npm install` from the project root first.

### `fan doctor` shows errors
Run `fan doctor` and follow the specific diagnostic advice for each item. Common fixes:
- **"No config found"** → Run `fan init` to create default configuration.
- **"Native module missing"** → Install platform binding (see above).
- **"No API keys configured"** → Add keys to `.env` or run `fan init`.
- **"No models available"** → Check API keys (see below) or add entries to `~/.fan/agent/models.json`.

### No models available
1. Check that your API keys are set correctly in `.env`:
   ```bash
   grep _AFAN_KEY .env
   ```
2. Verify keys are valid by testing one:
   ```bash
   curl -H "x-api-key: $ANTHROPIC_AFAN_KEY" https://api.anthropic.com/v1/messages
   ```
3. If using custom providers, check that `~/.fan/agent/models.json` is valid JSON and the `baseUrl` is reachable.

### Port 3456 already in use
Use the `--port` flag to specify a different port:
```bash
fan --mode server --port 8080
```

To find what's using port 3456:
```bash
# Linux/macOS
lsof -i :3456

# Windows
netstat -ano | findstr :3456
```

### `fan server start` doesn't write PID file
- Check that the binary has write access to ~/.fan/agent/
- Check server.log in ~/.fan/agent/ for startup errors
- Try running `fan server` in foreground first to see errors
