# MCP Integration Guide

> External MCP server connection for FAN.  
> Connects FAN agents to external Model Context Protocol servers via stdio or Streamable HTTP transports.

---

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open standard for connecting LLM agents to external tools, data sources, and APIs. MCP servers expose:

- **Tools** — callable functions (filesystem read/write, database queries, GitHub API, etc.)
- **Resources** — static or dynamic data (files, database records)
- **Prompts** — reusable prompt templates

FAN implements an **MCP client** — it connects to one or more MCP servers and exposes their tools as native FAN AgentTools. This means your agent can use `mcp__0__read_file` the same way it uses any built-in tool.

### When to use MCP

| Use case | Example MCP server |
|----------|--------------------|
| File operations | `@modelcontextprotocol/server-filesystem` |
| Database queries | Server exposing SQL via tools |
| GitHub API | `@modelcontextprotocol/server-github` |
| Custom APIs | Any JSON-RPC endpoint |

---

## Quickstart

### 1. Install the extension

```bash
fan store install fan-mcp
```

### 2. Configure an MCP server

Create `~/.fan/agent/mcp.json`:

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedTools": ["*"],
      "timeout": 30000
    }
  ]
}
```

### 3. Launch FAN

```bash
fan
```

On session start, the extension connects to all configured servers. Successful connection logs:

```
mcp: server 0 (npx) connected (5 tools)
```

Available tools are registered as:

```
mcp__0__read_file
mcp__0__write_file
mcp__0__read_directory
mcp__0__search_files
mcp__0__get_file_info
```

### 4. Check status

```
/mcp status
```

Example output:

```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
```

---

## Configuration

### File locations

| Path | Scope | Behaviour |
|------|-------|-----------|
| `~/.fan/agent/mcp.json` | **Global** — all projects | Base server definitions |
| `$CWD/.fan/mcp.json` | **Project-local** | Overrides global at same index, extras appended |

Both files use the array form `servers: []`. The server ID corresponds to the array index (0, 1, 2, …).

### Global example

Global + project merge example:

**`~/.fan/agent/mcp.json`:**
```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    {
      "transport": "streamable-http",
      "url": "https://api.github.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  ]
}
```

**`$CWD/.fan/mcp.json`:**
```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./project-data"],
      "allowedTools": ["read_file", "read_directory"]
    }
  ]
}
```

Result: server 0 is project-local (overrides global), server 1 remains global.

### Full config reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `transport` | `"stdio"` \| `"streamable-http"` | — | Transport protocol |
| `command` | string | — | (stdio) executable name or absolute path |
| `args` | string[] | — | (stdio) command-line arguments |
| `env` | object | safe whitelist | (stdio) environment variables (supports `${VAR}`) |
| `url` | string | — | (http) MCP endpoint URL |
| `headers` | object | — | (http) HTTP headers (supports `${VAR}`) |
| `allowedTools` | string[] | `["*"]` | Glob patterns — tool must match at least one |
| `deniedTools` | string[] | `[]` | Glob patterns — takes priority over `allowedTools` |
| `timeout` | number | `60000` | Per-call timeout in ms (1000–300000) |
| `autoRestart` | boolean | `false` | Auto-restart on stdio crash with exponential backoff |
| `allowLocal` | boolean | `false` | Allow loopback URLs in streamable-http |
| `allowPrivate` | boolean | `false` | Allow private network URLs (RFC 1918, CGNAT, link-local) |
| `oauth` | object | — | OAuth 2.0 PKCE config (see OAuth section) |

### Environment variables in config

`${VAR}` references are resolved from `process.env`:

```json
{
  "env": {
    "DB_CONNECTION": "${DATABASE_URL}"
  },
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}"
  }
}
```

If a referenced variable is undefined, a `MissingEnvVarError` is thrown at config load.

---

## Transports

### stdio

Spawns a subprocess that communicates over stdin/stdout JSON-RPC.

**When to use:**
- Local MCP servers (npm packages, local scripts)
- Servers that don't expose an HTTP endpoint
- Development and testing

**Security:**
- `shell: false` — no shell injection via `args`
- Safe env whitelist when no custom `env` is set: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USERPROFILE`
- `${VAR}` references resolved from `process.env`

**Example:**
```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "env": {
    "PATH": "${PATH}",
    "HOME": "${HOME}"
  }
}
```

### Streamable HTTP

Connects via HTTP SSE (Server-Sent Events) using `StreamableHTTPClientTransport`.

**When to use:**
- Remote MCP servers
- Production deployments
- Services that already expose an HTTP API

**Security:**
- Only `https:` protocol is allowed
- Loopback addresses require `allowLocal: true`
- Private network addresses require `allowPrivate: true` or `allowLocal: true`

**Example:**
```json
{
  "transport": "streamable-http",
  "url": "https://api.example.com/mcp",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

---

## Permission System

### allowedTools / deniedTools

Each server can restrict which MCP tools are exposed to the agent:

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "allowedTools": ["read_*", "list_*"],
  "deniedTools": ["delete_file", "write_*"]
}
```

**Rules:**
1. `deniedTools` is checked first — if a tool matches any denied pattern, it's blocked.
2. If no `allowedTools` is set, defaults to `["*"]` (all allowed except denied).
3. Globs are simple wildcard patterns (single `*` matches any sequence).
4. Tool names use **raw MCP names** (without `mcp__<server>__` prefix).

### Glob pattern safety

- Maximum pattern length: 256 characters
- Maximum wildcards per pattern: 10
- Beyond limits, matching falls back to safe substring search (no regex)

### Per-worker profile filtering

In orchestrator mode, worker agents receive MCP tools filtered by their permission profile:

| Worker type | Profile | MCP access |
|-------------|---------|------------|
| `explore`, `plan`, `verify`, `code-research` | **read-only** | Only tools with `annotations.readOnly === true` |
| `implement`, `bug-fix`, `tests-impl` | **all** | All tools (subject to server-level `allowedTools`/`deniedTools`) |

Workers without any profile default to **all** access.

---

## Worker Proxy

### Overview

Worker agents (subprocesses spawned by the orchestrator) do **not** load the `fan-mcp` extension. Instead, they receive MCP tools via a proxy mechanism:

```
Orchestrator (parent)              Worker (subprocess)
      │                                  │
      │  ┌── fan-mcp extension ──┐      │
      │  │ connects to MCP servers│      │
      │  │ emits mcp:catalog      │      │
      │  └────────┬──────────────┘      │
      │           │                      │
      │  ┌────────┴──────────────┐      │
      │  │ broker-handler.js     │      │
      │  │ subscribes to catalog │      │
      │  │ maintains tool map    │      │
      │  └────────┬──────────────┘      │
      │           │                      │
      │  ┌────────┴──────────────┐      │
      │  │ RPC mode              │      │
      │  │ pendingRemoteToolReqs │      │
      │  │ correlation map       │      │
      │  └────────┬──────────────┘      │
      │           │                      │
      │     remote_tool_request  ◄────  │  RemoteProxyTool
      │     remote_tool_response ────►  │  (--remote-tools flag)
      │           │                      │
```

### How to enable

The orchestrator automatically passes `--remote-tools` to worker agents. No manual configuration is needed.

If you're running in custom RPC mode:

```bash
fan --mode rpc --remote-tools "mcp__0__read_file,mcp__0__write_file"
```

### Lifecycle

1. **Session start**: `fan-mcp` connects to all MCP servers and registers tools.
2. **Catalog broadcast**: `mcp:catalog` event is emitted on the EventBus.
3. **Orchestrator subscribes**: `broker-handler.js` receives the catalog via replay-on-subscribe.
4. **Worker spawn**: Orchestrator launches a worker with `--remote-tools=<list>`.
5. **Worker proxy**: `RemoteProxyTool` instances forward tool calls to the parent via JSONRPC.
6. **Broker routing**: Parent RPC mode receives the request, looks up the server/tool via `brokerHandler`, and calls the actual MCP client.
7. **Response**: The result flows back through the same chain.

---

## Observability

### /mcp status

Displays current connection state for all servers:

```
/mcp status
```

Output:
```
 # | status       | transport        | tools
---+--------------+------------------+-------
 0 | connected    | stdio            | 5 tools
 1 | unavailable  | streamable-http  | 0 tools (connect timeout 5000ms)
```

States: `connecting` → `connected` → `unavailable` (on crash or connect failure).

### /mcp reload

Dispose all connections, reload config from disk, and reconnect:

```
/mcp reload
```

### MCP Logs

Structured JSON-lines to `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`:

```json
{"timestamp":"2026-07-16T12:00:00.000Z","event":"tool_call_end","serverId":"0","toolName":"read_file","durationMs":142,"status":"success"}
```

**What's logged:**
- `tool_call_start` — entry timestamp
- `tool_call_end` — duration + success status
- `tool_call_error` — duration + sanitized error message

**What's NOT logged** (never): tool arguments, response content, PII, secrets. Error messages are sanitized (Bearer tokens, API keys, `sk-*` keys redacted).

### Auto-restart

When `autoRestart: true` is set on a stdio server config, crashes trigger automatic reconnection with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |

After 5 failed attempts within a 60-second window, auto-restart is permanently disabled. The counter resets after 60s without a crash.

---

## OAuth (Phase 4 — partial)

### Prerequisites

The MCP server must support OAuth 2.0 Authorization Code flow with PKCE (S256).

### Configuration

```json
{
  "transport": "streamable-http",
  "url": "https://mcp.secure-service.com",
  "oauth": {
    "clientId": "fan-client",
    "clientSecret": "optional-for-confidential-clients",
    "authorizationUrl": "https://auth.secure-service.com/authorize",
    "tokenUrl": "https://auth.secure-service.com/token",
    "scopes": ["openid", "profile", "tools:read"]
  }
}
```

### Flow

1. **Session start**: The extension checks `~/.fan/agent/mcp-tokens.json` for a valid token.
2. **Token valid** (>60s remaining): reused directly.
3. **Token expired, has refresh token**: automatic refresh via `grant_type=refresh_token`.
4. **No valid token**: PKCE flow initiated:
   - A local callback server starts on `127.0.0.1` (random port).
   - The authorization URL is printed to stderr.
   - User opens the URL in a browser and authorizes.
   - The callback server receives the code, exchanges it for a token.
   - Token is saved to `~/.fan/agent/mcp-tokens.json` (mode `0o600`).

### Current limitations

- **No automatic browser opening** — the URL is printed to stderr; the user must copy-paste it manually.
- **Token storage** uses a JSON file. Production deployments may replace with OS keychain (`libsecret`, macOS Keychain, Windows Credential Manager).
- **Full browser flow** requires manual user intervention; headless/CI environments cannot complete OAuth without additional tooling.

---

## Security

### Threat model

| Threat | Mitigation |
|--------|-----------|
| Malicious MCP server | `allowedTools`/`deniedTools` glob filtering per server |
| SSRF via HTTP transport | Only `https:`, loopback/private ranges blocked by default |
| Shell injection via stdio | `shell: false` enforced |
| Server ID spoofing | `isValidServerId()` rejects non-decimal aliases (`0e0`, `-0`, `+1`) |
| Secret leakage in logs | `sanitizeMessage()` redacts tokens, keys, `sk-*` patterns |
| Environment leakage | Safe env whitelist (only 6 safe vars inherited by default) |
| ReDoS via glob patterns | Pattern length/wildcard caps (256 chars, 10 `*`) |
| Untrusted config files | JSON schema validation at load, graceful invalid handling |

### Best practices

1. **Prefer stdio** for local MCP servers — no network exposure.
2. **Use `deniedTools`** to block destructive operations (`delete_file`, `write_*`, `rm_*`).
3. **Set `allowLocal: false`** (default) to prevent SSRF attacks against local services.
4. **Use environment variables** for secrets (`${GITHUB_TOKEN}`) — never hardcode tokens in `mcp.json`.
5. **Review MCP server logs** at `~/.fan/agent/logs/mcp-*.log`.
6. **Restrict `allowedTools`** per server — granular tool access limits blast radius.

### Bug fixes

Critical security fixes applied in commits `01d6eb1` and `1058927`:

| Bug | Description |
|-----|-------------|
| BUG-1 | Permission gate created without config — empty gate, all calls blocked |
| BUG-2 | Server ID alias injection via `Number("0e0")` coercion |
| BUG-3 | SSRF loopback bypass — incomplete IP range coverage |
| BUG-4 | Argument mismatch causing timeout hangs |
| BUG-5 | `list_changed` double-fetch wasting bandwidth |
| BUG-6 | Secret leakage in error log messages |
| BUG-7 | Dead code cleanup |

---

## Troubleshooting

### Server shows "unavailable"

**Check:**
1. Can the command run outside FAN? `npx -y @modelcontextprotocol/server-filesystem .`
2. Is the path correct? Use absolute paths for custom scripts.
3. Is the network reachable? `curl https://api.example.com/mcp`
4. Check `~/.fan/agent/logs/mcp-*.log` for details.

### Tools not appearing

**Check:**
1. `/mcp status` — is the server `connected`?
2. Does the server actually expose tools? `tools/list` should return non-empty.
3. Are `allowedTools` too restrictive? Try `"allowedTools": ["*"]`.
4. Is a stale `deniedTools` pattern blocking everything?

### OAuth flow doesn't complete

**Check:**
1. Is the authorization URL printed to stderr? Look for `OAuth: open the following URL`.
2. Is the redirect URI reachable? The callback server listens on `127.0.0.1` at a random port.
3. Does the token endpoint return valid JSON? Check the response format.
4. Is `~/.fan/agent/mcp-tokens.json` writable?

### Worker can't use MCP tools

**Check:**
1. Is the `fan-mcp` extension installed and loaded?
2. Does the orchestrator show "catalog received" in logs?
3. Is the broker handler initialized? `/mcp status` shows connected servers.
4. Is the worker's profile filtering too strict? Read-only workers can't call write tools.

### Config changes not applied

Use `/mcp reload` to reload config and reconnect. The extension reads config once on `session_start`.

---

## Package architecture

```
fan-mcp extension
  ├── src/config.ts          — Config loader, TypeBox validation, env var resolution
  ├── src/transport.ts       — Stdio + Streamable HTTP transport factories
  ├── src/manager.ts         — Client connection lifecycle, crash handling, auto-restart
  ├── src/adapter.ts         — MCP tool → AgentTool converter (JSON Schema → TypeBox)
  ├── src/executor.ts        — Tool execution with timeout + logging wrapper
  ├── src/permissions.ts     — Permission gate (allowed/denied tools, glob matching)
  ├── src/logger.ts          — Structured JSON-lines logger with secret sanitization
  ├── src/oauth.ts           — OAuth 2.0 PKCE flow (verifier, challenge, token exchange)
  ├── src/timeout.ts         — AbortController utility for call cancellation
  └── src/index.ts           — Extension factory (lifecycle hooks, /mcp commands)

core (outside extension)
  ├── packages/coding-agent/src/core/event-bus.ts                    — LastEvent cache (replay-on-subscribe)
  ├── packages/coding-agent/src/modes/rpc/rpc-types.ts               — Remote tool types (request/response/cancel/catalog)
  ├── packages/coding-agent/src/modes/rpc/rpc-mode.ts                — pendingRemoteToolRequests correlation map
  ├── packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts       — RemoteProxyTool for worker→parent forwarding
  ├── packages/coding-agent/src/core/agent-session.ts               — registerCustomTools method
  └── packages/coding-agent/src/cli/args.ts                          --remote-tools CLI flag

orchestrator extension
  ├── extensions/fan-orchestrator/broker-handler.js                  — Catalog subscriber, proxy tool routing
  └── extensions/fan-orchestrator/orchestrator-extension.js          — Initializes broker handler on session start
```

### Phase status

| Phase | Features | Status |
|-------|----------|--------|
| **1** | MCP client core: transports, tool discovery, config, permissions, lifecycle | ✅ Complete |
| **2** | Worker Proxy: RemoteProxyTool, broker-handler, catalog broadcast, profile filtering | ✅ Complete |
| **3** | Auto-restart, `/mcp` commands, logging/metrics, structured content, API gateway stub | ✅ Complete |
| **4** | OAuth (PKCE), full API gateway bridge, Dashboard MCP card | 🔶 Partial |

---

## See also

- [Model Context Protocol specification](https://modelcontextprotocol.io/)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [FAN extension API docs](../docs/extensions.md)
- [Orchestrator guide](./orchestrator.md)
- [API reference](./api-reference.md)
