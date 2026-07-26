# Configuration Guide

Complete reference for all FAN configuration options.

## Configuration Files Overview

| File | Location | Purpose |
|------|----------|---------|
| `.env` | Project root | API keys and environment variables |
| `settings.json` | `~/.fan/agent/settings.json` | Global settings (all projects) |
| `settings.json` | `<project>/.fan/settings.json` | Project-specific overrides |
| `models.json` | `~/.fan/agent/models.json` | Custom model definitions |
| `config.json` | `packages/orchestrator/src/config.json` | Multi-agent orchestrator config |

## Precedence Rules

**CLI flags** > **Project settings** > **Global settings** > **Defaults**

Nested objects merge recursively (partial overrides supported).

## Environment Variables

### AI Provider API Keys

| Provider | FAN Variable | Standard Variable |
|----------|-------------|-------------------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY` |
| Google Cloud (Vertex) | `GOOGLE_CLOUD_API_KEY` | — |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | — |
| Groq | `GROQ_API_KEY` | — |
| xAI | `XAI_API_KEY` | — |
| OpenRouter | `OPENROUTER_API_KEY` | — |
| Mistral | `MISTRAL_API_KEY` | — |
| Cerebras | `CEREBRAS_API_KEY` | — |
| DeepSeek | `DEEPSEEK_API_KEY` | — |
| Z.AI | `ZAI_API_KEY` | — |
| MiniMax | `MINIMAX_API_KEY` | — |
| Kimi | `KIMI_API_KEY` | — |
| Qwen (Aliyun Token Plan) | `QWEN_API_KEY` | — |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | — |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | `GH_TOKEN`, `GITHUB_TOKEN` |

Keys can also be set per-provider in `models.json` via `apiKey` (takes precedence over env vars) or via the `envVar` field to explicitly name the environment variable to use.

### Runtime Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `FAN_CODING_AGENT_DIR` | `~/.fan/agent` | Custom agent directory |
| `FAN_CACHE_RETENTION` | `"default"` | `"long"` for 24h Anthropic cache TTL |
| `FAN_CLEAR_ON_SHRINK` | `"0"` | `"1"` to clear empty rows on shrink |
| `FAN_HARDWARE_CURSOR` | `"0"` | `"1"` to show hardware cursor |

### Server & Deployment

Server-mode variables (`fan server` / `fan --web` / Docker). Implementation: `packages/coding-agent/src/cli/server-config.ts`, `packages/api-gateway/src/cors-config.ts`, `packages/coding-agent/src/utils/file-logger.ts`. See [Deployment Guide](deployment.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port. `--port` flag overrides; unset/invalid values fall back to the default |
| `HOST` | `"localhost"` | Bind host. `--host` flag overrides; use `0.0.0.0` inside containers |
| `FAN_WORKSPACE_ROOT` | `~/projects` | Workspace root for server mode (F-1.11). Default cwd for sessions created without an explicit `cwd` and the cwd whitelist for `POST /api/sessions` — a `cwd` outside it is rejected with 403 (F-1.13, symlink-aware). Unset/empty → `~/projects`. Container sets `/data/repos` |
| `FAN_PUBLIC` | unset | Public mode: `"1"`/`"true"`/`"yes"`/`"on"` makes token auth mandatory and ignores `FAN_NO_AUTH`. Unrecognized values fail closed (treated as public, with a stderr warning) |
| `ALLOWED_ORIGINS` | `"*"` | CORS whitelist — comma-separated origins (whitespace trimmed, empty entries dropped). `"*"` = fully open (local dev) |
| `LOG_DIR` | unset | File logging directory (`app.log` + rotation). Unset/empty = file logging disabled (console only). Container sets it to `/data/logs` |
| `LOG_LEVEL` | `"info"` | File log verbosity: `error` \| `warn` \| `info` \| `debug`. Console output always passes through unchanged |
| `LOG_MAX_SIZE` | `10485760` (10 MB) | Rotate `app.log` when it reaches this size. Plain bytes or `k`/`m`/`g` suffix (e.g. `"5m"`) |
| `LOG_MAX_FILES` | `5` | Rotated files to keep: `app.log.1` … `app.log.N` (oldest dropped) |

**Persistent message queue (F-5.5/F-5.6).** In server mode the WS dispatcher queue is **persistent by default** (`PersistentMessageQueue`): queued `sendMessage` payloads are stored as JSONL under `<agentDir>/queues` (`FAN_CODING_AGENT_DIR` / `FAN_AGENT_DIR`, default `~/.fan/agent`) and restored on startup (`queues_restored` WS frame). No env flag — opt out programmatically via `ServerOptions.persistentQueue: false` (legacy in-memory queue). Details: [API Reference — Message Queueing](api-reference.md#message-queueing-phases-2--5).

**Per-project tokens (F-5.7).** Client tokens accept an optional `projectScope` at creation (`POST /api/tokens { "name", "projectScope" }`) restricting them to a single project (enforcement, lockdown policy and anti-escalation rules: [API Reference — Project Scope](api-reference.md#project-scope-f-57)). Existing tokens (`projectScope: null`) keep full access.

## Settings Reference

### Model Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | `string` | — | Default AI provider |
| `defaultModel` | `string` | — | Default model ID |
| `defaultThinkingLevel` | `"off"`\|`"minimal"`\|`"low"`\|`"medium"`\|`"high"`\|`"xhigh"` | — | Thinking budget |

```json
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514", "defaultThinkingLevel": "medium" }
```

### Model-Specific Settings

Per-model overrides keyed by `"provider/model-id"`. Stored in Prisma DB via Dashboard/API.

| Field | Type | Description |
|-------|------|-------------|
| `temperature` | `number` | Sampling temperature (0–2) |
| `maxTokens` | `number` | Max output tokens |
| `thinking` | `"off"`\|`"minimal"`\|`"low"`\|`"medium"`\|`"high"`\|`"xhigh"` | Thinking budget |

```json
{ "modelSettings": { "anthropic/claude-sonnet-4-20250514": { "temperature": 0.3, "thinking": "medium" } } }
```

### Routing Rules

First-match routing to preferred providers.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Rule name |
| `provider` | `string` | Target provider |
| `model` | `string` | Target model |
| `fallback` | `string?` | Fallback provider/model |
| `enabled` | `boolean?` | Active (default: `true`) |

```json
{ "routingRules": [{ "name": "Cheap tasks", "provider": "groq", "model": "gpt-oss-20b", "fallback": "openai/gpt-5-mini" }] }
```

### Budget

| Field | Type | Description |
|-------|------|-------------|
| `dailyTokenLimit` | `number?` | Max tokens/day |
| `dailyCostLimit` | `number?` | Max spend/day (USD) |
| `monthlyTokenLimit` | `number?` | Max tokens/month |
| `monthlyCostLimit` | `number?` | Max spend/month (USD) |

### Session & Behavior

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | `string?` | — | Custom session directory |
| `hideThinkingBlock` | `boolean` | `false` | Hide thinking blocks |
| `steeringMode` | `"all"`\|`"one-at-a-time"` | `"one-at-a-time"` | Multiple tool call handling |
| `followUpMode` | `"all"`\|`"one-at-a-time"` | `"one-at-a-time"` | Follow-up prompt handling |
| `collapseChangelog` | `boolean` | `false` | Condensed changelog |
| `quietStartup` | `boolean` | `false` | Suppress startup messages |

### Terminal & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | `string?` | — | UI theme name |
| `terminal.showImages` | `boolean` | `true` | Show images in terminal |
| `images.autoResize` | `boolean` | `true` | Resize images to 2000×2000 |
| `images.blockImages` | `boolean` | `false` | Block images from providers |
| `markdown.codeBlockIndent` | `string` | `"  "` | Code block indent |
| `editorPaddingX` | `number` | `0` | Editor padding (0–3) |
| `autocompleteMaxVisible` | `number` | `5` | Autocomplete items (3–20) |
| `doubleEscapeAction` | `"fork"`\|`"tree"`\|`"none"` | `"tree"` | Double-escape action |
| `treeFilterMode` | `"default"`\|`"no-tools"`\|`"user-only"`\|`"labeled-only"`\|`"all"` | `"default"` | `/tree` filter |
| `showHardwareCursor` | `boolean` | `false` | Show hardware cursor |

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | `boolean` | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | `number` | `16384` | Tokens reserved for prompt |
| `compaction.keepRecentTokens` | `number` | `20000` | Recent tokens to preserve |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | `boolean` | `true` | Enable auto-retry |
| `retry.maxRetries` | `number` | `3` | Max attempts |
| `retry.baseDelayMs` | `number` | `2000` | Backoff base delay (ms) |
| `retry.maxDelayMs` | `number` | `60000` | Max backoff delay (ms) |

### Thinking Budgets

Custom token counts: `thinkingBudgets.minimal`, `.low`, `.medium`, `.high` (all `number?`).

### Extensions & Skills

| Setting | Type | Description |
|---------|------|-------------|
| `extensions` | `string[]` | Extension paths or directories |
| `skills` | `string[]` | Skill paths or directories |
| `enableSkillCommands` | `boolean` | Register as `/skill:name` (default: `true`) |
| `prompts` | `string[]` | Prompt template paths |
| `themes` | `string[]` | Theme paths |
| `packages` | `PackageSource[]` | npm/git packages (string or `{ source, extensions?, skills?, ... }`) |

> **Pre-installed skills:** FAN ships with 8 skills in `skills/` (auto-tests, bug-fix, code-research, deep-dive, fan-forge, idea-lab, repo-explorer, research-spec-generator). These are loaded automatically. Additional skills can be installed via FAN Store (`fan store install <name>`).

### Advanced

| Setting | Type | Description |
|---------|------|-------------|
| `shellPath` | `string?` | Custom shell (e.g., `/bin/zsh`) |
| `shellCommandPrefix` | `string?` | Prefix for shell commands |
| `npmCommand` | `string[]?` | npm command argv (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |
| `transport` | `"sse"`\|`"websocket"` | Transport protocol (default: `"sse"`) |
| `enabledModels` | `string[]?` | Model patterns for cycling |

## Models Configuration (`models.json`)

`~/.fan/agent/models.json` — custom models and provider overrides.

For built-in providers (e.g. `zai`, `openai`, `anthropic`), you can add new models by ID only — `baseUrl` and `api` are inherited:

```json
{
  "providers": {
    "zai": {
      "models": [
        { "id": "glm-5-turbo" },
        { "id": "glm-5" }
      ]
    }
  }
}
```

For custom providers, specify `baseUrl`, `api`, and optionally `apiKey` or `envVar`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "qwen3:32b",
          "name": "Qwen 3 32B (local)",
          "reasoning": true,
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "anthropic": {
      "baseUrl": "https://custom-proxy.example.com",
      "apiKey": "sk-ant-...",
      "modelOverrides": {
        "claude-sonnet-4-20250514": { "name": "Claude (proxy)", "contextWindow": 200000 }
      }
    }
  }
}
```

### Provider Config

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | `string?` | Override API base URL |
| `apiKey` | `string?` | API key (overrides env) |
| `api` | `string?` | API type: `"openai-completions"`, `"openai-responses"`, `"anthropic"`, etc. |
| `headers` | `Record<string, string>?` | Extra HTTP headers |
| `compat` | `object?` | Compatibility settings |
| `authHeader` | `boolean?` | Use Authorization header |
| `envVar` | `string?` | Environment variable name for this provider's API key |
| `models` | `ModelDef[]?` | Custom model definitions |
| `modelOverrides` | `Record<string, override>?` | Per-model tweaks by model ID |

Notes:
- For **built-in providers** (e.g. `zai`, `openai`, `anthropic`), `models` entries only need an `id` — `baseUrl` and `api` are inherited from existing built-in models.
- For **custom providers**, `baseUrl` and `api` are required unless the provider inherits from a built-in one.

### Model Definition

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` **(required)** | Model identifier |
| `name` | `string?` | Display name |
| `api` | `string?` | API protocol |
| `baseUrl` | `string?` | Per-model URL |
| `reasoning` | `boolean?` | Supports thinking |
| `input` | `("text"\|"image")[]?` | Input modalities |
| `cost` | `object?` | Per-1M-tokens: `{ input, output, cacheRead, cacheWrite }` |
| `contextWindow` | `number?` | Max context (tokens) |
| `maxTokens` | `number?` | Max output tokens |

Overrides use the same fields (all optional) and merge deeply with built-ins.

## Orchestrator Configuration

`packages/orchestrator/src/config.json` — multi-agent system config.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cloud.model` | `string` | — | Cloud model (e.g., `"anthropic/claude-sonnet-4-20250514"`) |
| `cloud.provider` | `string?` | — | Cloud provider (inferred if omitted) |
| `local.model` | `string` | — | Local model (e.g., `"ollama/qwen3:32b"`) |
| `local.provider` | `string?` | — | Local provider (inferred if omitted) |
| `providerMode` | `"cloud"`\|`"local"` | `"cloud"` | Active provider set |
| `parallelWorkers` | `number` | `3` | Max concurrent workers |
| `workerTimeout` | `number` | `300000` | Worker timeout (ms) |
| `maxRetries` | `number` | `2` | Retry count |
| `planTimeout` | `number` | `300000` | Planning timeout (ms) |
| `agentTimeouts` | `Record<WorkerType, number>` | — | Per-type: `explore`, `plan`, `implement`, `verify` |
| `dangerousCommands` | `string[]` | — | Commands requiring confirmation |

## Common Patterns

### Local-Only (Offline)

```jsonc
{ "defaultProvider": "ollama", "defaultModel": "qwen3:32b", "budget": { "dailyTokenLimit": 500000 } }
```

### Cloud-Only

```jsonc
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium", "budget": { "dailyCostLimit": 10.0, "monthlyCostLimit": 100.0 } }
```

### Hybrid (Cloud + Local Fallback)

```jsonc
// settings.json
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514",
  "routingRules": [{ "name": "Fallback", "provider": "ollama", "model": "qwen3:32b" }] }
// config.json
{ "cloud": { "model": "anthropic/claude-sonnet-4-20250514" },
  "local": { "model": "ollama/qwen3:32b" }, "providerMode": "cloud" }
```

### Budget-Conscious

```jsonc
{ "defaultProvider": "groq", "defaultModel": "gpt-oss-20b", "defaultThinkingLevel": "low",
  "budget": { "dailyTokenLimit": 200000, "dailyCostLimit": 2.0, "monthlyCostLimit": 30.0 },
  "routingRules": [{ "name": "Complex", "provider": "anthropic", "model": "claude-sonnet-4-20250514" }] }
```

### Multi-Provider

```jsonc
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-20250514",
  "modelSettings": { "anthropic/claude-sonnet-4-20250514": { "thinking": "medium" }, "openai/gpt-5-mini": { "temperature": 0.5 } },
  "routingRules": [
    { "name": "Fast", "provider": "groq", "model": "gpt-oss-20b" },
    { "name": "Vision", "provider": "openai", "model": "gpt-5-mini" },
    { "name": "Reasoning", "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
  ] }
```

## Quick Setup

Run **`fan init`** for an interactive setup wizard (provider, API keys, budget, thinking level).

Or use the **Dashboard** at `http://localhost:5174` (`cd packages/dashboard && npm run dev`) for a visual model settings, routing, and budget configuration UI.
