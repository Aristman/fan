# @fan/mcp-extension

MCP (Model Context Protocol) client extension for [FAN](https://fan.sea-agents.ru/).

Connects FAN to external MCP servers and exposes their tools as native FAN AgentTools.

## Installation

```bash
fan store install fan-mcp
```

## Configuration

Edit `~/.fan/agent/mcp.json` (or `${cwd}/.fan/mcp.json` for project-local config):

```json
{
  "servers": [
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    {
      "transport": "streamable-http",
      "url": "https://api.github.com/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  ]
}
```

Note: this package uses the array form `servers: []`. Older documentation using `servers: {}` (object keyed by serverId) is the legacy form.

## Per-server options

| Field | Type | Description |
|-------|------|-------------|
| `transport` | `"stdio"` \| `"streamable-http"` | Transport protocol |
| `command` | string | (stdio) executable name or absolute path |
| `args` | string[] | (stdio) command-line arguments |
| `env` | object | (stdio) environment variables (supports `${VAR}` references) |
| `url` | string | (http) MCP endpoint URL |
| `headers` | object | (http) HTTP headers (supports `${VAR}` references) |
| `allowedTools` | string[] | glob patterns; default `["*"]` (all) |
| `deniedTools` | string[] | glob patterns; takes priority over `allowedTools` |
| `timeout` | number | per-call timeout in ms (default 60000) |
| `autoRestart` | boolean | restart on crash (Phase 3) |
| `allowLocal` | boolean | allow loopback URLs in streamable-http (default false) |

## Tool naming

MCP tools are exposed as `mcp__<serverId>__<toolName>`. The `serverId` is the array index in `servers[]`.

## Phase 1 scope

This package implements **coordinator-only** MCP access. Worker agents (subprocesses `fan --mode rpc --no-extensions`) do not receive MCP tools. Worker proxy support is planned for Phase 2.

## License

MIT