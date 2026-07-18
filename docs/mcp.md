# MCP (Model Context Protocol) in FAN

> **Source code:** `packages/mcp/` (bundled extension `@fan/mcp`, version `0.1.0`)
> **Tests:** 241+ (19 test files in `packages/mcp/test/`)

Connect FAN to external Model Context Protocol (MCP) servers and expose their tools
as native FAN AgentTools. MCP tools become available as `mcp__<serverId>__<toolName>`
and work exactly like built-in tools — the LLM can call them directly via the agent loop.

---

## Table of Contents

1. [What is MCP in FAN](#1-what-is-mcp-in-fan)
2. [Quick Start](#2-quick-start)
3. [Configuration Reference](#3-configuration-reference)
4. [Widget Usage (TUI)](#4-widget-usage-tui)
5. [Slash Commands](#5-slash-commands)
6. [Tool Filtering](#6-tool-filtering)
7. [Configuration Examples](#7-configuration-examples)
8. [Troubleshooting](#8-troubleshooting)
9. [Architecture](#9-architecture)
10. [Security Notes](#10-security-notes)

---

## 1. What is MCP in FAN

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open standard
for connecting LLM agents to external tools, data sources, and APIs. An MCP server
exposes **tools** (callable functions), **resources** (static/dynamic data), and
**prompts** (reusable prompt templates) over a JSON-RPC transport.

FAN implements the **client** side of MCP. When FAN starts a session, it:

1. Reads `mcp.json` from disk (global and/or project config).
2. Connects to each configured MCP server via `stdio` or `streamable-http`.
3. Calls `tools/list` on each server to discover available tools.
4. Registers each tool as a native FAN AgentTool with the name `mcp__<serverId>__<toolName>`.
5. Handles `tools/call` requests by forwarding them to the appropriate server.

**What the user gets:** Any MCP-compliant server instantly provides its tools to
the FAN agent, appearing alongside built-in tools in the agent's tool registry.
No custom integration code required.

---

## 2. Quick Start

### 2.1 Prerequisites

- FAN installed and working (`fan` command available)
- (For stdio servers) The MCP server executable or Node package available,
  e.g. `npx @modelcontextprotocol/server-filesystem`

### 2.2 Create the Config

Create `~/.fan/agent/mcp.json` with the simplest possible setup — a filesystem server:

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  ]
}
```

### 2.3 Start FAN

```bash
fan
```

On session start, the extension connects to all configured servers. You should see
the tools registered:

```
mcp__0__read_file
mcp__0__write_file
mcp__0__read_directory
mcp__0__search_files
mcp__0__get_file_info
```

### 2.4 Verify Connection

Use the slash command:

```
/mcp status
```

Expected output:

```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
```

Or open the interactive widget with **`Alt+M`** or **`F4`**.

### 2.5 Use the Tools

The tools are now available to the agent. For example, the agent can call
`mcp__0__read_file` to read a file, `mcp__0__search_files` to search, etc.

---

## 3. Configuration Reference

### 3.1 Config Locations

| Path | Scope | Behaviour |
|------|-------|-----------|
| `~/.fan/agent/mcp.json` | **Global** — all projects | Base definitions |
| `$CWD/.fan/mcp.json` | **Per-project** | Overrides global at same index, extras appended |

Both files use the array form `servers: []`. The server ID is the array index (0, 1, 2, …).
Configs are merged by index: `project[i]` replaces `global[i]`.

### 3.2 McpServerConfig Fields

Full schema from `packages/mcp/src/config.ts`:

| Field | Type | Default | Transport | Description |
|-------|------|---------|-----------|-------------|
| `transport` | `"stdio"` \| `"streamable-http"` | **required** | both | Transport protocol |
| `name` | `string` | command/url/`"Server #<n>"` | both | Display name in the TUI widget |
| `command` | `string` | — | stdio | Executable name or absolute path |
| `args` | `string[]` | `[]` | stdio | Command-line arguments |
| `env` | `Record<string, string>` | safe defaults | stdio | Environment variables (`${VAR}` supported) |
| `url` | `string` | — | http | MCP endpoint URL |
| `headers` | `Record<string, string>` | — | http | HTTP headers (`${VAR}` supported) |
| `allowedTools` | `string[]` | `["*"]` | both | Glob patterns — tool must match at least one |
| `deniedTools` | `string[]` | `[]` | both | Glob patterns — blocks matching tools (higher priority) |
| `timeout` | `number` | `60000` | both | Tool call timeout (ms), range 1000–300000 |
| `autoRestart` | `boolean` | `false` | both | Auto-restart on crash with exponential backoff |
| `silentStderr` | `boolean` | `true` | stdio | Suppress MCP server stderr in TUI |
| `allowLocal` | `boolean` | `false` | http | Allow loopback addresses (127.0.0.0/8, ::1) |
| `allowPrivate` | `boolean` | `false` | http | Allow private network addresses (RFC 1918, CGNAT, link-local) |
| `oauth` | `object` | — | http | OAuth 2.0 PKCE configuration (see §3.3) |

**Validation:** The config is validated against a TypeBox schema (`McpServerConfigSchema`
in `config.ts`). Invalid configs produce a warning and are skipped gracefully.

### 3.3 OAuth Config

```typescript
interface OAuthConfig {
  clientId: string;
  clientSecret?: string;     // For confidential clients
  authorizationUrl: string;  // URL for auth code request
  tokenUrl: string;          // URL for token exchange/refresh
  scopes?: string[];         // OAuth scopes
}
```

### 3.4 Environment Variable Resolution

Values containing `${VAR}` are resolved from `process.env` at config load time:

```json
{
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}"
  },
  "env": {
    "DATABASE_URL": "${DB_CONNECTION_STRING}"
  }
}
```

If a referenced env var is undefined, a `MissingEnvVarError` is thrown and the
config fails to load for that server.

### 3.5 Safe Env Defaults (stdio)

When no custom `env` is provided for a stdio server, only these variables are
inherited from `process.env` (defined in `SAFE_ENV_VARS` in `transport.ts`):

- `PATH`
- `HOME`
- `LANG`
- `LC_ALL`
- `TMPDIR`
- `USERPROFILE`

This prevents accidental leakage of secrets like `TOKEN`, `API_KEY`, `DATABASE_URL`.

---

## 4. Widget Usage (TUI)

The MCP widget is an interactive fullscreen browser for managing MCP servers,
opened with **`Alt+M`** or **`F4`** (registered as global shortcuts in `index.ts`).

### 4.1 Opening the Widget

| Shortcut | Action |
|----------|--------|
| `Alt+M` | Open/close MCP widget (toggle) |
| `F4` | Open/close MCP widget (toggle) |

The widget is a Store-style fullscreen overlay. It opens on top of the current
session view and returns you to the same position when closed.

### 4.2 Servers View (Level 1)

When opened, the widget shows a list of all configured MCP servers:

```
╭─ MCP Servers ─────────────────────────────────────────╮
│ ✓ npx                                 5 tools         │  ← green bg
│ ✗ github-mcp-server                   ! 0 tools       │  ← dim red bg
│ ⟳ server-3                           0 tools         │  ← yellow text, no bg
│ ...                                                     │
├────────────────────────────────────────────────────────┤
│ ↑↓ navigate · Enter tools · Space toggle · Esc close   │
╰────────────────────────────────────────────────────────╯
```

**Visual status indicators (background colors):**

| Status | Icon | Background | Text Color |
|--------|------|------------|------------|
| `connected` | ✓ (green) | Dim green (ANSI 22) | `theme.fg("success")` |
| `connecting` | ⟳ (yellow) | None | `theme.fg("warning")` |
| `unavailable` | ! (red) | Bright red (ANSI 124) | `theme.fg("error")` |
| `disabled` | ✗ (dim) | Dim red (ANSI 52) | `theme.fg("dim", fg("error"))` |

**Color implementation** (`widget.ts`):

| Status | ANSI Escape |
|--------|-------------|
| connected | `\x1b[48;5;22m` (bg green) + `theme.fg("success")` |
| unavailable | `\x1b[48;5;124m` (bg bright red) + `theme.fg("error")` |
| disabled | `\x1b[48;5;52m` (bg dim red) + `theme.fg("dim", fg("error"))` |
| connecting | No background + `theme.fg("warning")` |

**Navigation:**

| Key | Action |
|-----|--------|
| `↑` / `k` | Select previous server |
| `↓` / `j` | Select next server |
| `Enter` | Open tools list for selected server |
| `Space` | Toggle connect/disconnect the selected server (inline, 300ms debounce) |
| `Esc` / `q` | Close widget |

### 4.3 Tools View (Level 2)

After pressing `Enter` on a server, the widget shows its tools:

```
╭─ Tools: npx ───────────────────────────────────────────╮
│ ✓ read_file                                            │
│ ✓ write_file                                           │
│ ✓ read_directory                                       │
│ ✗ search_files                                         │  ← disabled by Space
│ ✓ get_file_info                                        │
│ ...                                                     │
├────────────────────────────────────────────────────────┤
│ ↑↓ navigate · Space toggle · Esc servers               │
╰────────────────────────────────────────────────────────╯
```

| Key | Action |
|-----|--------|
| `↑` / `k` | Select previous tool |
| `↓` / `j` | Select next tool |
| `Space` | Toggle enable/disable the selected tool (inline, 300ms debounce) |
| `Esc` / `q` | Back to servers view |

Tool toggling is **inline** — the widget stays open, no re-creation, no flicker.
A disabled tool is added to `deniedTools` in the server config and immediately
unregistered from the agent's tool registry via `setToolEnabled()` → `refreshServerTools()`.

### 4.4 Debounce

Both server and tool toggles are debounced to 300ms (`lastToggleAt` timestamp check)
to prevent flicker and promise storms from rapid `Space` presses.

---

## 5. Slash Commands

The `/mcp` command (registered in `index.ts` via `fan.registerCommand("mcp", ...)`)
provides CLI-style management:

| Command | Description |
|---------|-------------|
| `/mcp status` | ASCII table of all servers with status, transport, tool count |
| `/mcp list` | Simplified one-line-per-server summary |
| `/mcp reload` | Close all connections, reload config from disk, reconnect |
| `/mcp <name> connect` | Connect a specific server by name or index |
| `/mcp <name> disconnect` | Disconnect a specific server by name or index |

### 5.1 `/mcp status` output example

```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
 1 | unavailable  | streamable-http  | 0 tools (connect timeout 5000ms)
```

Statuses: `connected`, `connecting`, `unavailable` (crash) or `disabled` (manually disconnected).

### 5.2 `/mcp list` output example

```
MCP Servers:
✓ [#0] npx — connected — 5 tools
✗ [#1] github-api — unavailable — 0 tools (connect timeout 5000ms)
```

### 5.3 `/mcp <name> connect/disconnect`

Server lookup by:
1. Numeric index first (e.g. `/mcp 0 connect`)
2. Name match (case-insensitive, e.g. `/mcp npx disconnect`)

---

## 6. Tool Filtering

### 6.1 allowedTools / deniedTools

Each server can restrict which tools are available to the agent:

```json
{
  "allowedTools": ["read_*", "list_*"],
  "deniedTools": ["delete_file", "write_*"]
}
```

**Priority rules** (implemented in `permissions.ts`, `filterToolsByConfig()`):

1. `deniedTools` is checked **first** — if a tool matches any denied pattern, it's blocked.
2. If `allowedTools` is not set, it defaults to `["*"]` (all tools allowed, minus denied).
3. If `allowedTools` is set, the tool must match **at least one** allowed pattern.
4. `deniedTools` wins over `allowedTools` — a tool in both lists is denied.

**AllowedTools/deniedTools use RAW MCP tool names** (without the `mcp__<server>__` prefix).
For a tool named `mcp__0__read_file`, filter against `read_file`, not `mcp__0__read_file`.

If a tool name contains `__` and doesn't start with `mcp__`, the filter module warns:
> `filterToolsByConfig: tool name "foo__bar" contains "__" — did you mean just "bar"?`

### 6.2 Glob Pattern Details

Patterns are simple wildcard globs (one `*` matches any sequence):

| Pattern | Matches | Doesn't Match |
|---------|---------|---------------|
| `read_*` | `read_file`, `read_directory` | `write_file` |
| `*` | Everything | — |
| `mcp__*` | All MCP tools with that prefix | Built-in tools |

**Security limits** (from `matchGlob()` in `permissions.ts`):

- Maximum pattern length: **256 characters**
- Maximum asterisks: **10**
- Beyond limits: fallback to substring matching (no regex) to prevent ReDoS

### 6.3 Live Toggle via Widget

Pressing `Space` on a tool in the widget view toggles its enabled/disabled state.
This calls `setToolEnabled()` in the manager, which:

1. Adds/removes the tool name from `deniedTools`.
2. Calls `permissions.updateConfig()` to update the permission gate.
3. Re-registers the server's tools via `refreshServerTools()` (diff-based).

Changes are immediate — no config file update, no server restart.

### 6.4 Live Toggle via Widget (Server Level)

Pressing `Space` on a server entry toggles connect/disconnect without widget re-creation:

- If connected → calls `disconnectOne()` → marks disabled, unregisters all tools.
- If disconnected → calls `connectOne()` → connects, re-registers tools.

---

## 7. Configuration Examples

### 7.1 GitHub MCP Server

The `github-mcp-server` requires a GitHub PAT (Personal Access Token).
On Windows, Docker env var passing can be tricky — workaround via `-e` in args:

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "allowedTools": ["search_*", "get_*"],
      "deniedTools": ["create_*", "update_*", "delete_*"],
      "timeout": 30000
    }
  ]
}
```

This makes the server **read-only** for the agent (only `search_*` and `get_*` tools).

### 7.2 Filesystem MCP Server

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "allowedTools": ["read_file", "read_directory", "search_files", "get_file_info"],
      "deniedTools": ["write_file", "delete_file"],
      "timeout": 15000,
      "autoRestart": true
    }
  ]
}
```

Read-only filesystem, auto-restart on crash.

### 7.3 Streamable HTTP Server (Remote)

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/api",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}",
        "X-Request-Id": "fan-mcp"
      },
      "allowedTools": ["*"],
      "timeout": 60000,
      "autoRestart": true
    }
  ]
}
```

### 7.4 Multiple Servers

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "name": "Filesystem Server"
    },
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "name": "GitHub"
    },
    {
      "transport": "streamable-http",
      "url": "https://mcp.mycompany.com",
      "name": "My Company API"
    }
  ]
}
```

Server indices: 0 = Filesystem, 1 = GitHub, 2 = My Company.
Tools are registered as `mcp__0__read_file`, `mcp__1__search_repos`, `mcp__2__...`.

### 7.5 Streamable HTTP with OAuth

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "url": "https://api.secure-service.com/mcp",
      "oauth": {
        "clientId": "fan-client",
        "clientSecret": "${OAUTH_CLIENT_SECRET}",
        "authorizationUrl": "https://auth.secure-service.com/authorize",
        "tokenUrl": "https://auth.secure-service.com/token",
        "scopes": ["openid", "profile", "tools:read"]
      }
    }
  ]
}
```

### 7.6 Per-Project Override

**`~/.fan/agent/mcp.json`** (global):
```json
{
  "servers": [
    { "transport": "stdio", "command": "bun", "args": ["server-a.js"] },
    { "transport": "stdio", "command": "bun", "args": ["server-b.js"] }
  ]
}
```

**`$CWD/.fan/mcp.json`** (project override):
```json
{
  "servers": [
    { "transport": "stdio", "command": "bun", "args": ["server-a-local.js"], "allowedTools": ["read_*"] }
  ]
}
```

Result: server 0 → project config (overrides global), server 1 → global config.

---

## 8. Troubleshooting

### 8.1 Server shows "unavailable"

**Possible causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| Command not found | Run the command outside FAN | Install prerequisite, check `PATH` |
| MCP server crashed | Check `~/.fan/agent/logs/mcp-*.log` | Fix server errors, enable `autoRestart` |
| Connect timeout (5s) | Is the server slow to start? | Increase `timeout` field |
| Docker not available | Running Docker-based server | Ensure Docker is installed and running |
| Permission denied (Windows) | FAN not running as admin | Run FAN as administrator |
| Syntax error in config | Watch console for validation warnings | Check `mcp.json` syntax |

### 8.2 Tools not appearing

| Cause | Check | Fix |
|-------|-------|-----|
| Server not connected | `/mcp status` shows `unavailable` | See §8.1 |
| Filtered by `allowedTools` | Try `"allowedTools": ["*"]` | Widen tool filters |
| Filtered by `deniedTools` | Check `deniedTools` patterns | Remove or adjust patterns |
| Server returns empty tools/list | Test with `mcp-cli` or direct SDK | Confirm server has tools |

### 8.3 OAuth flow never completes

| Issue | Check | Fix |
|-------|-------|-----|
| Auth URL not visible | Look for `OAuth: open the following URL` in stderr | Run FAN in visible terminal, not background |
| Callback server not reachable | Docker container can't reach `127.0.0.1` | Use host networking or configure callback port |
| Token endpoint errors | Check response format | Ensure server returns standard OAuth JSON |
| Tokens file not writable | `~/.fan/agent/mcp-tokens.json` | Check filesystem permissions |

### 8.4 OAuth device code loop (Docker)

When running FAN inside Docker with MCP servers that expect OAuth:

1. The callback server listens on `127.0.0.1` inside the container, unreachable from the host browser.
2. The auth URL is printed to stderr but opening it in a browser won't reach the callback.

**Workaround:** Configure a reachable callback port with `--network host` or expose the port.
A proper solution requires a configurable `redirectUri` (not yet implemented).

### 8.5 Changes not applying

- The MCP config is read **once** at `session_start`.
- After editing `mcp.json`, use **`/mcp reload`** to re-read and reconnect.
- Toggling tools via the widget is immediate and does not require reload.

### 8.6 Worker cannot use MCP tools (Orchestrator mode)

| Issue | Check | Fix |
|-------|-------|-----|
| `fan-mcp` not loaded | `fan store list` shows `fan-mcp`? | Install missing extension |
| Broker not initialized | Orchestrator logs show "catalog received"? | Check orchestrator extension |
| Worker profile too restrictive | Read-only workers blocked from write tools | Use `implement`/`bug-fix` profile |

### 8.7 Config validation error

Typical error format:

```
mcp.json: Invalid mcp config: [{"path":"/servers/0","message":"Required property 'transport'"}]
```

Check that all required fields are present and of the correct type. The config
schema is `additionalProperties: false` — unknown fields are rejected.

---

## 9. Architecture

### 9.1 Package Structure

```
packages/mcp/
├── src/
│   ├── index.ts          — Extension factory, lifecycle hooks, shortcuts, /mcp command
│   ├── config.ts         — Config loader, TypeBox schema validation, env var resolution
│   ├── transport.ts      — StdioClientTransport & StreamableHTTPClientTransport factories
│   ├── manager.ts        — McpClientManager: lifecycle, crash handling, auto-restart
│   ├── adapter.ts        — MCP tool → AgentTool converter (JSON Schema → TypeBox)
│   ├── executor.ts       — Tool execution with timeout, abort signal linking, progress
│   ├── permissions.ts    — Permission gate (allowedTools/deniedTools, glob matching)
│   ├── logger.ts         — Structured JSON-lines logger with secret sanitisation
│   ├── oauth.ts          — OAuth 2.0 PKCE flow (code verifier, challenge, token exchange)
│   └── widget.ts         — McpWidget TUI component (2-level state machine)
└── test/                 — 19 test files (241+ tests)
```

### 9.2 Core Modules

#### config.ts (`createMcpConfigLoader`, `loadMcpConfig`)

- Reads `~/.fan/agent/mcp.json` (global) and `$CWD/.fan/mcp.json` (project).
- Validates against TypeBox schema with `additionalProperties: false`.
- Merges by array index: `project[i]` overrides `global[i]`, extras appended.
- Resolves `${ENV_VAR}` references in `env` and `headers` via `resolveEnvVars()`.
- Missing files are silently skipped; invalid JSON/schema produce a warning.

#### manager.ts (`createMcpClientManager`)

Central state machine for all MCP server connections.

**State transitions:**

```
┌────────────┐   connect    ┌─────────────┐   success    ┌─────────────┐
│  disabled  │ ───────────→ │  connecting  │ ───────────→ │  connected  │
└────────────┘              └─────────────┘              └─────────────┘
      ↑                           │                            │
      │         connect            │ fail/error                 │ crash
      │         (reconnect)        │                            │
      │                           ↓                            ↓
      │                     ┌──────────────┐            ┌──────────────┐
      │                     │ unavailable  │  ←──────── │  (crash)     │
      └─────────────────────┤ auto-restart │            └──────────────┘
                            └──────────────┘
```

**Key features:**
- `connectAll(config)`: Connects all servers in parallel. Failures are isolated (F-1.16).
- `connectOne(index)`: Connects a single server with 5s connect timeout.
- `disconnectOne(index)`: Marks disabled, unregisters tools, closes transport.
- `setToolEnabled(serverIdx, toolName, enabled)`: Toggle tool state via `refreshServerTools()`.
- `reloadConfig(configLoader)`: Disposes all, reloads config, reconnects.

**Crash handling** (F-1.17):
- Transport `onclose` → `handleCrash()` → unregisters all tools, marks unavailable.
- If `autoRestart: true` → exponential backoff (1s, 2s, 4s, 8s, 16s, max 5 attempts in 60s window).

**list_changed** (F-1.15):
- SDK config: `autoRefresh: false`, `debounceMs: 500`.
- Custom `onChanged` → `refreshServerEntries()` → diff-based tool re-registration.

#### transport.ts (`createStdioTransport`, `createHttpTransport`)

**Stdio:** Uses `StdioClientTransport` from `@modelcontextprotocol/sdk`.
- `shell: false` enforced by SDK.
- `silentStderr: true` (default) → stderr routed to `/dev/null`/`nul`.
- Safe env vars when no custom `env` provided.

**Streamable HTTP:** Uses `StreamableHTTPClientTransport` from SDK.
- Validates: only `https:` protocol (rejects `http:`).
- Loopback check: `127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0` → requires `allowLocal: true`.
- Private network check: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10` → requires `allowPrivate: true`.
- OAuth token injection in Authorization header.

#### permissions.ts (`createPermissionGate`, `filterToolsByConfig`)

- `gate(event)`: Called on every `tool_call` event. Parses `mcp__<serverId>__<toolName>`, checks `deniedTools` → `allowedTools`, returns `block: true` or `{}`.
- `filterToolsByConfig(tools, config)`: Filters a tool list by allowed/denied patterns at registration time.
- `isValidServerId(id)`: Rejects non-decimal strings like `"0e0"`, `"-0"`, `"+1"` (BUG-2 fix).
- Glob matching with ReDoS protection (256 char / 10 asterisk limits).
- Warning on tool names with `__` that don't start with `mcp__` (misconfiguration detection).

#### executor.ts (`executeMcpTool`, `mapCallToolResult`)

- Wraps MCP `CallToolResult` → FAN `AgentToolResult`.
- Supported content mapping: `text` → `TextContent`, `image` → `ImageContent`.
- Unsupported content types (audio, resource) → text fallback `[Unsupported content types: ...]`.
- 60s default timeout with `AbortController`.
- Signal linking: merges caller's abort signal with timeout signal.
- Progress throttling: high-frequency MCP progress notifications batched at 50ms.

#### oauth.ts (PKCE flow)

Components:
- `generateCodeVerifier()` / `generateCodeChallenge(verifier)`: S256 PKCE.
- `generateState()`: CSRF state parameter.
- `parseWwwAuthenticate(header)`: Parses `WWW-Authenticate: Bearer realm="...", error="..."`.
- `createCallbackServer(expectedState, onCode)`: Local HTTP server on `127.0.0.1:random`.
- `exchangeCodeForToken(...)`: POST to tokenUrl with PKCE code_verifier.
- `refreshAccessToken(...)`: POST with `grant_type=refresh_token`.
- `TokenStore`: JSON file at `~/.fan/agent/mcp-tokens.json` (mode 0o600).
- `ensureValidToken(config, serverId, store)`: High-level: check store → refresh → full flow.

#### logger.ts (Structured logging)

- Writes to `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`.
- Events: `tool_call_start`, `tool_call_end`, `tool_call_error`.
- Never logs: args, content, PII, secrets.
- `sanitizeMessage()` redacts: Bearer tokens, 32+ char hex/base64 strings, `api_key`, `token`, `sk-*`.
- `withLogging(serverId, toolName, execute)`: Wraps tool call with start/end/error logging.

#### adapter.ts (`mcpToolToDefinition`)

- `jsonSchemaToTypeBox(schema)`: Converts MCP JSON Schema to TypeBox `TSchema`.
  Supports: object, string, number, integer, boolean, array, enum, nested objects, optional fields.
  Falls back to `Type.Any()` for `$ref`, `oneOf`, `anyOf`.
- `normalizeToolName(serverId, toolName)`: Generates `mcp__<serverId>__<toolName>`.
- `mcpToolToDefinition(serverId, mcpTool, client)`: Full AgentTool wrapper with execute delegate.

### 9.3 Lifecycle

```
session_start
    │
    ├── configLoader.load() → McpConfig
    │
    ├── permissions.updateConfig(servers)
    │
    ├── createMcpClientManager(fan, permissions)
    │
    ├── manager.connectAll(config)
    │       │
    │       ├── For each server (parallel):
    │       │   ├── buildTransport(cfg) → Transport
    │       │   ├── new Client(...) → Client
    │       │   ├── client.connect(transport) — 5s timeout
    │       │   ├── client.listTools() → tools
    │       │   ├── filterToolsByConfig(tools, cfg)
    │       │   ├── For each tool:
    │       │   │   ├── mcpToolToDefinition(id, tool, client) → ToolDefinition
    │       │   │   └── fan.registerTool(def)
    │       │   └── status = "connected"
    │       │
    │       └── fan.events.emit("mcp:catalog", { servers })
    │
    └── (server runs)
            │
            ├── tool_call → permissions.gate(event) → blocked or forwarded
            │
            ├── transport.onclose → handleCrash → auto-restart (if enabled)
            │
            ├── list_changed notifications → refreshServerTools() (diff-based)
            │
            └── /mcp status/reload/list/connect/disconnect commands

session_shutdown
    │
    └── manager.dispose()
            ├── Cancel auto-restart timers
            ├── For each server:
            │   ├── client.close()
            │   └── transport.close()
            └── (5s total timeout)
```

### 9.4 Worker Proxy (Orchestrator Mode)

Worker agents (subprocesses `fan --mode rpc`) do **not** load the `fan-mcp` extension.
Instead, they receive MCP tools via a remote proxy mechanism:

```
Session Start
    │
    ├── fan-mcp connects to MCP servers
    ├── fan-mcp emits mcp:catalog on EventBus
    │
    ├── Orchestrator broker-handler.js subscribes to mcp:catalog
    │   (EventBus replays last event for late subscribers)
    │
    ├── Orchestrator launches worker with --remote-tools="mcp__0__read_file,..."
    │
    ├── Worker creates RemoteProxyTool instances for each listed tool
    │
    ├── When worker calls a proxy tool:
    │   ├── remote_tool_request (JSONRPC) → parent process
    │   ├── parent's RPC mode routes to brokerHandler
    │   ├── broker handler calls real MCP client via toolCallHandler
    │   └── remote_tool_response (JSONRPC) → worker
    │
    └── Profile filtering:
        - explore/plan/verify/code-research → readOnly tools only
        - implement/bug-fix/tests-impl → all tools
```

**Key files outside the MCP package:**

| File | Role |
|------|------|
| `packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts` | RemoteProxyTool implementation |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | remote_tool_request/response types |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | Correlation map `pendingRemoteToolRequests` |
| `packages/coding-agent/src/core/event-bus.ts` | EventBus with last-event replay |
| `extensions/fan-orchestrator/broker-handler.js` | Catalog subscriber + tool routing |

### 9.5 Event API

Events emitted on `fan.events`:

| Event | Payload | When |
|-------|---------|------|
| `mcp:ready` | `{ servers: number }` | After initial `connectAll()` completes |
| `mcp:catalog` | `{ servers: ServerEntry[] }` | After connection changes (connect, disconnect, toggle, reload) |

### 9.6 Key Design Decisions

**Why `autoRefresh: false` for list_changed?**
Setting `autoRefresh: true` in the SDK would cause a double-fetch of tools —
the SDK's internal handler plus FAN's own `refreshServerTools()`. By disabling
auto-refresh and using only the custom `onChanged` callback, FAN avoids redundant
`listTools()` calls and applies its own permission filtering during refresh.

**Why per-server isolation?**
Each MCP server connects independently via `Promise.allSettled()`. A crash in one
server (F-1.17) does not affect others. This is critical when one server is
unstable — the rest of the integrations continue working.

**Why tool names include server index?**
The `mcp__<serverId>__<toolName>` namespace avoids collisions between servers
that expose tools with the same name (e.g. two servers both exposing `read_file`).
The server ID is the config array index, not a name, because names can overlap
and indices are stable identifiers.

### 9.7 Known Limitations

| Limitation | Description | Future Work |
|------------|-------------|-------------|
| No `redirectUri` config | OAuth callback URL is auto-generated (`127.0.0.1:random`) | Add configurable `redirectUri` |
| No auto browser open | OAuth auth URL printed to stderr, must be opened manually | Integrate `open` / `xdg-open` |
| Token store JSON file | `~/.fan/agent/mcp-tokens.json` (mode 0o600) | OS keychain integration |
| Widget stale after reload | Widget references pre-reload manager instance | Pass AbortSignal to widget lifecycle |
| No Dashboard card | MCP status not visible on Web Dashboard | Phase 4 deferred |
| `silentStderr: true` default | stderr from MCP server subprocesses is hidden | Set `silentStderr: false` for debugging |

---

## 10. Security Notes

### 10.1 Tool Call Permissions

Every MCP tool call passes through the **permission gate** (`createPermissionGate`
in `permissions.ts`) via the `tool_call` event hook. The gate:

1. Parses the tool name (`mcp__<id>__<name>`).
2. Validates the server ID format (prevents alias injection like `"0e0"`).
3. Looks up the server config by index.
4. Checks `deniedTools` globs (block on match).
5. Checks `allowedTools` globs (block if no match, default `["*"]`).
6. Non-MCP tool names pass through unmodified.

**Disabled tools are NEVER sent to the LLM.** The permission gate operates
at two levels:
- **Registration level**: `filterToolsByConfig()` removes denied tools from the
  tool list before they are registered via `fan.registerTool()`.
- **Call level**: `gate()` blocks calls that somehow reach a disabled tool.

### 10.2 Transport Security

**Stdio transport:**
- `shell: false` — no shell injection via `args`.
- Safe env default — only 6 basic variables inherited when no custom `env` provided.
- Default silent stderr — prevents MCP server log noise in the TUI.

**Streamable HTTP transport:**
- Only `https:` protocol allowed.
- Loopback addresses require explicit `allowLocal: true`.
- Private networks (RFC 1918, CGNAT, link-local) require `allowPrivate: true`.
- URL validity and hostname checks performed at config load time.

### 10.3 OAuth Token Security

- OAuth tokens stored in `~/.fan/agent/mcp-tokens.json` with file mode `0o600`
  (owner-only read/write).
- Authorization header constructed at transport creation time.
- Token refresh handled automatically for expiring tokens.
- Full PKCE flow requires manual browser interaction (no headless CI support).

### 10.4 Secret Sanitisation in Logs

The structured logger (`logger.ts`) applies regex-based redaction to error
messages before writing:

| Pattern Type | Example | Redaction |
|-------------|---------|-----------|
| Bearer tokens | `Bearer eyJhbGciOi...` | `Bearer ***REDACTED***` |
| Long hex/base64 strings (32+ chars) | `dGhpcyBpcyBh...` | `***REDACTED***` |
| API key patterns | `api_key=sk-abc...` | `api_key=***REDACTED***` |
| Token patterns | `token=ghp_abc...` | `token=***REDACTED***` |
| OpenAI-style keys | `sk-proj-ABC...` | `sk-***REDACTED***` |

**What logs NEVER contain:** tool arguments, response content, PII.

### 10.5 Glob Pattern Protection

- Max pattern length: 256 characters (prevents memory exhaustion).
- Max asterisks: 10 (prevents catastrophic backtracking / ReDoS).
- Beyond limits: safe substring matching (no regex).

### 10.6 SSRF Protection

| Address Range | Risk | Required Flag |
|--------------|------|---------------|
| `127.0.0.0/8`, `::1`, `localhost`, `0.0.0.0` | Loopback SSRF | `allowLocal: true` |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | Internal network | `allowPrivate: true` (or `allowLocal`) |
| `169.254.0.0/16` | Link-local | `allowPrivate: true` |
| `100.64.0.0/10` | CGNAT | `allowPrivate: true` |
| All others (internet) | — | No additional flag |

### 10.7 Config Injection Protection

- JSON Schema validation (`additionalProperties: false`) rejects unknown config keys.
- Config merge errors are caught and gracefully skipped with a warning.
- Config load errors never crash the session — unsupported servers are skipped.

### 10.8 Best Practices

1. **Use `deniedTools`** to block dangerous operations (`write_*`, `delete_*`, `exec_*`).
2. **Set `allowedTools` to minimal set** — grant least privilege.
3. **Use env vars for secrets** (`${GITHUB_TOKEN}`) — never hardcode in `mcp.json`.
4. **Keep `allowLocal`/`allowPrivate` false** unless you explicitly need local/private HTTP servers.
5. **Prefer stdio** for local MCP servers — eliminates network exposure.
6. **Review logs** in `~/.fan/agent/logs/mcp-*.log` for unusual activity.
7. **Run `fan doctor`** to check environment before debugging MCP issues.

---

*Documentation source: `packages/mcp/src/` — 10 source files, 19 test files, 241+ tests.*
*Implementation status: Phases 1–3 complete, Phase 4 (OAuth/Dashboard) partial.*