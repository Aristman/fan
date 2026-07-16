# @fan/mcp-extension

MCP (Model Context Protocol) client extension for [FAN](https://fan.sea-agents.ru/).

Connects FAN to external MCP servers and exposes their tools as native FAN AgentTools.

**Status**: Coordinator-only MCP ready; Worker Proxy + auto-restart + `/mcp` commands + structured content + logging implemented.  
**Tests**: 241 passing (19 test files).  
**Version**: 0.1.0 (`@fan/mcp-extension`).

---

## Installation

```bash
fan store install fan-mcp
```

## Quickstart

Create `~/.fan/agent/mcp.json`:

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

Launch FAN — tools are auto-discovered and registered as `mcp__0__<toolName>`.

> **Note**: this package uses the array form `servers: []`. Older documentation using `servers: {}` (object keyed by serverId) is the legacy form.

---

## Configuration

### mcp.json Locations

| Path | Scope | Priority |
|------|-------|----------|
| `~/.fan/agent/mcp.json` | Global (all projects) | Base config |
| `$CWD/.fan/mcp.json` | Project-local | Overrides global per-server index |

Both files are merged by server array index: project config at index *i* replaces global config at index *i*. Extra project servers are appended.

### Per-server options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `transport` | `"stdio"` \| `"streamable-http"` | — | Transport protocol |
| `command` | string | — | (stdio) executable name or absolute path |
| `args` | string[] | — | (stdio) command-line arguments |
| `env` | object | safe whitelist | (stdio) environment variables (supports `${VAR}` references) |
| `url` | string | — | (http) MCP endpoint URL |
| `headers` | object | — | (http) HTTP headers (supports `${VAR}` references) |
| `allowedTools` | string[] | `["*"]` | Glob patterns — tool must match at least one |
| `deniedTools` | string[] | `[]` | Glob patterns — blocks matching tools; takes priority |
| `timeout` | number | `60000` | Per-call timeout in ms (1000–300000) |
| `autoRestart` | boolean | `false` | Auto-restart on stdio crash with exponential backoff |
| `allowLocal` | boolean | `false` | Allow loopback URLs in streamable-http (127.0.0.0/8, ::1) |
| `allowPrivate` | boolean | `false` | Allow private network URLs (10.0.0.0/8, 192.168.0.0/16, etc.) |
| `oauth` | object | — | OAuth 2.0 PKCE configuration (see below) |

### Tool naming

MCP tools are exposed as `mcp__<serverId>__<toolName>`. The `serverId` is the array index in `servers[]`.

### Config resolution order

1. `allowedTools`/`deniedTools` use **raw MCP tool names** (without `mcp__<server>__` prefix).  
   Example: `{ deniedTools: ["delete_file"] }` blocks `mcp__0__delete_file`.
2. `deniedTools` is checked first — any matching tool is blocked regardless of `allowedTools`.
3. If no `allowedTools` are specified, defaults to `["*"]` (all tools allowed except denied).
4. Non-MCP tool names (not prefixed `mcp__`) pass through unmodified.

---

## Transports

### stdio

Spawns a subprocess via `StdioClientTransport` ([SDK docs](https://github.com/modelcontextprotocol/typescript-sdk)). The process communicates over stdin/stdout JSON-RPC.

- `shell: false` enforced for security.
- Environment variables: if `env` is not set, a safe whitelist is used (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USERPROFILE`).
- `${VAR}` references in `env` values are resolved from `process.env`.

### Streamable HTTP

Connects via HTTP SSE with `StreamableHTTPClientTransport`.

- Only `https:` protocol is allowed (not `http:`).
- Loopback addresses (`127.0.0.0/8`, `::1`, `0.0.0.0`) require `allowLocal: true`.
- Private network addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`) require `allowPrivate: true` or `allowLocal: true`.
- `${VAR}` references in `headers` are resolved from `process.env`.

---

## OAuth (Phase 4 — partial)

MCP servers using Streamable HTTP may require OAuth 2.0 Authorization Code flow with PKCE (S256).

### Configuration

```json
{
  "servers": [
    {
      "transport": "streamable-http",
      "url": "https://mcp.example.com",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "authorizationUrl": "https://auth.example.com/authorize",
        "tokenUrl": "https://auth.example.com/token",
        "scopes": ["read", "write"]
      }
    }
  ]
}
```

### How it works

1. On session start, the extension checks `~/.fan/agent/mcp-tokens.json` for existing tokens.
2. If a token exists with >60s remaining lifetime, it's reused.
3. If expired but has a refresh token, automatic refresh is attempted.
4. Otherwise, the full PKCE flow is initiated:
   - A local callback server starts on `127.0.0.1` (random port).
   - The authorization URL is printed to stderr (requires manual browser open).
   - After authorization, the server receives the code and exchanges it for a token.

### Limitations

- The full PKCE flow currently prints the URL to stderr — automatic browser opening is not implemented (requires `open` / `xdg-open` integration).
- Token storage uses a JSON file at `~/.fan/agent/mcp-tokens.json` with mode `0o600`. Production deployments may replace with OS keychain integration.

---

## Worker Proxy (Phase 2 — complete)

Worker agents (subprocesses `fan --mode rpc --no-extensions`) receive MCP tools via the Worker Proxy mechanism.

### How it works

1. **Catalog broadcast**: On session start, `fan-mcp` emits an `mcp:catalog` event on the core `EventBus`. The EventBus caches the last event (replay-on-subscribe), so late subscribers still receive the catalog.

2. **Broker handler** (`extensions/fan-orchestrator/broker-handler.js`):
   - Subscribes to `mcp:catalog` and maintains an in-memory `Map<string, MCPToolDescriptor>`.
   - Exposes `getTool()`, `listTools()`, `invokeTool()`, and `handleRemoteToolInvocation()`.

3. **RemoteProxyTool** (`packages/coding-agent/src/modes/rpc/remote-proxy-tool.ts`):
   - Worker agents are launched with `--remote-tools=<list>` CLI flag.
   - For each MCP tool name in the list, a `RemoteProxyTool` is created locally.
   - When the worker calls a proxied tool, it sends a `remote_tool_request` JSONRPC message to the parent.
   - The parent orchestrator's RPC mode matches the request to its `pendingRemoteToolRequests` Map and routes it through the broker handler.
   - The broker invokes the actual MCP client via `toolCallHandler` callback.
   - The result is returned as a `remote_tool_response` JSONRPC message.

4. **Profile filtering** (F-2.7):
   - Worker permission levels: `explore`/`plan`/`verify`/`code-research` → **read-only** (only tools with `annotations.readOnly === true`).
   - `implement`/`bug-fix`/`tests-impl` → **all** tools.

### CLI Flag

```
fan --mode rpc --remote-tools "mcp__0__read_file,mcp__0__write_file"
```

The list is provided by the orchestrator which knows which MCP tools are available from the broker catalog.

---

## /mcp Commands

Two slash commands are available (when `enableSlashCommands` is true):

| Command | Description |
|---------|-------------|
| `/mcp status` | Display connection status table (index, status, transport, tool count) |
| `/mcp reload` | Dispose all connections, reload config, reconnect |

---

## Security

### Bug fixes (commits `01d6eb1`, `1058927`)

| Bug | ID | Description | Fix |
|-----|----|-------------|-----|
| BUG-1 | CRITICAL | Permission gate created without config — empty `byIndex` map, all calls blocked | Added `updateConfig()` method, called on `session_start` after config load |
| BUG-2 | HIGH | Server ID alias injection — `Number("0e0") === 0` allowed spoofing index `0` | Added `isValidServerId()` guard with `^\d+$` regex in permission gate |
| BUG-3 | HIGH | SSRF loopback bypass — only `localhost/127.0.0.1/::1` checked | Full `127.0.0.0/8` coverage, `0.0.0.0`, private network ranges, new `allowPrivate` flag |
| BUG-4 | MEDIUM | `TC-F1.7-9` argument mismatch — `executeMcpTool` call missing `undefined` for `onUpdate` param | Fixed call signature |
| BUG-5 | MEDIUM | `list_changed` double-fetch — SDK auto-fetch + our refresh = 2x `listTools()` | Set `autoRefresh: false` in SDK config |
| BUG-6 | HIGH | Secret leakage in logger — error messages could contain Bearer tokens, API keys | Added `sanitizeMessage()` with regex patterns for tokens, keys, `sk-*` keys |
| BUG-7 | LOW | Dead code — unused `pendingRemoteToolRequests` declaration in `rpc-mode.ts` | Removed |

### Security practices

- **Stdio spawn**: `shell: false` (no shell injection via `args`).
- **Safe env whitelist**: Only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USERPROFILE` are inherited when no custom `env` is set.
- **Loopback protection**: Streamable HTTP requires explicit `allowLocal: true` for local addresses.
- **Private network protection**: Private IP ranges require `allowPrivate: true`.
- **Glob ReDoS protection**: `matchGlob()` caps patterns at 256 chars and 10 asterisks.
- **Logger redaction**: Error messages in logs are sanitized (Bearer tokens, `sk-*` keys, any pattern matching `[32+ char hex/base64]`).
- **Transport validation**: URL schema, hostname, and env-variable validation at config load time.

---

## Observability

### MCP Logs

Structured JSON-lines logs are written to `~/.fan/agent/logs/mcp-YYYY-MM-DD.log`.

Each log entry contains:
- `timestamp` — ISO 8601
- `event` — `tool_call_start` | `tool_call_end` | `tool_call_error`
- `serverId`, `toolName` — identification
- `durationMs` — elapsed time
- `status` — `success` | `error`
- `errorMessage` — sanitized (no PII/secrets)

Logs are written asynchronously; write failures never break tool execution.

### Auto-restart

When `autoRestart: true` is set on a stdio server config, crashed servers are automatically restarted with exponential backoff:

| Attempt | Delay  |
|---------|--------|
| 1       | 1s     |
| 2       | 2s     |
| 3       | 4s     |
| 4       | 8s     |
| 5       | 16s    |

After 5 failed attempts within a 60-second window, auto-restart is permanently disabled for that server. The attempt counter resets after 60s without a crash.

---

## Package Structure

```
src/
  adapter.ts         — MCP tool → AgentTool converter (JSON Schema → TypeBox)
  config.ts          — mcp.json loader (global + project merge, TypeBox validation)
  executor.ts        — Tool execution wrapper with timeout and logging
  index.ts           — Extension factory (lifecycle hooks, /mcp commands)
  logger.ts          — Structured JSON-lines logger (sanitized, daily files)
  manager.ts         — Client manager (connect/disconnect, crash handling, auto-restart)
  oauth.ts           — OAuth 2.0 PKCE flow (code verifier, challenge, token exchange)
  permissions.ts     — Permission gate (allowedTools/deniedTools, glob matching)
  timeout.ts         — AbortController timeout utility
  transport.ts       — StdioClientTransport + StreamableHTTPClientTransport factories
```

### Phase overview

| Phase | Status | Features |
|-------|--------|----------|
| Phase 1 | ✅ Complete | MCP client core: transports, tool discovery, config, permissions, lifecycle |
| Phase 2 | ✅ Complete | Worker Proxy: RemoteProxyTool, broker-handler, catalog broadcast, profile filtering |
| Phase 3 | ✅ Complete | Auto-restart, `/mcp` commands, logging/metrics, structured content, `GET /api/mcp/servers` stub |
| Phase 4 | 🔶 Partial | OAuth (stubbed PKCE), dashboard MCP card (deferred) |

---

## License

MIT
