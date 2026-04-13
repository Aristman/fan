# FAN — Setup Guide

Complete installation and configuration for Windows, Ubuntu (Linux), and macOS.

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

## Clone & Install

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

## Build

```bash
npm run build
```

Builds 10 packages sequentially: db → tui → ai → agent → model-manager → api-gateway → coding-agent → web-ui → orchestrator.

> **Note:** Dashboard (`packages/dashboard/`) is a separate Vite app. Build it separately:
> ```bash
> cd packages/dashboard && npm run build
> ```

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

### 3. Custom Models (`.fan/models.json`)

Add custom providers not in the built-in registry (2000+ models). Create `.fan/models.json` in project root:

```json
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

### `.fan/` Directory Structure

```
.fan/
├── models.json          # Custom provider/model definitions
├── settings.json        # Default provider, model, thinking settings
├── extensions/          # Installed extensions
│   └── fna-orchestrator.ts
└── memory/              # Auto-created at runtime
    └── project.db       # SQLite database (Prisma)
```

## Run

```bash
# Interactive TUI
node packages/coding-agent/dist/cli.js

# Server mode (REST + WebSocket)
node packages/coding-agent/dist/cli.js --mode server --port 3456

# Single prompt
node packages/coding-agent/dist/cli.js -p "Hello, world!"

# Server without auth (dev)
FAN_NO_AUTH=1 node packages/coding-agent/dist/cli.js --mode server --port 3456

# Dashboard (separate terminal)
cd packages/dashboard && npm run dev
# → http://localhost:5174
```

## Troubleshooting

### `tsgo: Unable to resolve @typescript/native-preview-*`
Install the native binding for your platform (see above). Run:
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
node packages/coding-agent/dist/cli.js

# ✅ Correct (from project root)
cd ~/projects/fan
node packages/coding-agent/dist/cli.js
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
