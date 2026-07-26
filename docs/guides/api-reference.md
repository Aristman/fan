# API Reference

REST API and WebSocket protocol for FAN server mode.

## Getting Started

Start the FAN server:

```bash
fan server
```

Or with auto-open browser:

```bash
fan --web
```

API-only (no browser auto-open):

```bash
fan --mode server
```

The API is available at:

| Component    | URL                                    |
|-------------|----------------------------------------|
| REST API    | `http://localhost:3456/api`            |
| WebSocket   | `ws://localhost:3456/api/ws/{sessionId}` |
| Health      | `http://localhost:3456/api/health`     |

Change the port with the `--port` flag or `PORT` environment variable:

```bash
fan server --port 8080
# Or:
PORT=8080 fan server
```

## Authentication

All `/api/*` routes (except `/api/health`) require authentication via a **client token**.

### Methods

**Header (recommended):**

```bash
Authorization: Bearer fan_tk_abc123...
```

**Query parameter:**

```bash
curl http://localhost:3456/api/sessions?token=fan_tk_abc123...
```

### Disable Authentication

For local development or trusted networks, disable auth entirely:

```bash
FAN_NO_AUTH=1 fan server
```

> ⚠️ Disabling auth exposes all endpoints without any access control. Use only in trusted environments.

### Creating a Token

See [Create Token](#create-token) below. The full token secret is returned **only once** at creation time. Store it securely.

---

## REST Endpoints

### Health Check

```
GET /api/health
```

No authentication required.

Readiness probe (F-0.9): returns HTTP `200` when all checks pass, HTTP `503` when the database is unreachable (used by the Docker healthcheck).

**Response `200`:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 1847,
  "db": "up",
  "session": { "active": true, "id": "sess_abc123" }
}
```

**Response `503`** (DB probe failed or timed out after 1.5 s):

```json
{
  "status": "degraded",
  "version": "1.0.0",
  "uptime": 1847,
  "db": "down",
  "session": { "active": false, "id": null }
}
```

| Field          | Type      | Description                                             |
|----------------|-----------|---------------------------------------------------------|
| status         | `string`  | `"ok"` when all checks pass, `"degraded"` when any fails |
| version        | `string`  | FAN version number                                      |
| uptime         | `number`  | Server uptime in seconds                                |
| db             | `string`  | Database (Prisma/SQLite) reachability: `"up"` / `"down"` |
| session.active | `boolean` | Whether a session is currently active                   |
| session.id     | `string?` | Active session ID (`null` when none)                    |

---

### Sessions

#### Create Session

```
POST /api/sessions
```

Create a new conversation session.

**Request body:**

| Field            | Type     | Required | Description                    |
|------------------|----------|----------|--------------------------------|
| title            | `string` | No       | Session title (auto-generated if omitted) |
| parentSessionId  | `string` | No       | ID of a parent session for branching |
| cwd              | `string` | No       | Working directory (project workspace) for the new session. Normalized by the server; validated against the workspace whitelist (F-1.13) — see errors below. Default: the server workspace root (`FAN_WORKSPACE_ROOT` → `~/projects`) |

**Example:**

```bash
curl -X POST http://localhost:3456/api/sessions \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Refactor auth module", "cwd": "/data/repos/my-project"}'
```

**Response `201`:**

```json
{
  "id": "sess_a1b2c3d4",
  "title": "Refactor auth module",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "createdAt": "2026-04-13T10:30:00.000Z",
  "updatedAt": "2026-04-13T10:30:00.000Z",
  "cwd": "/data/repos/my-project"
}
```

**Error `400`** (`BAD_REQUEST`) — the body is not a JSON object, or `cwd` is present but is not a non-empty string:

```json
{ "error": "cwd must be a non-empty string", "code": "BAD_REQUEST" }
```

**Error `403`** (`FORBIDDEN`) — `cwd` rejected by the workspace whitelist (active in server mode: `allowedRoots = [FAN_WORKSPACE_ROOT → ~/projects]`). Rejections are written to the audit log (`[api-gateway][audit] cwd rejected ...`). Possible `reason` values: `"empty path"`, `"invalid characters in path"`, `"path outside allowed roots"`, `"symlink traversal detected"`:

```json
{ "error": "cwd rejected: path outside allowed roots", "code": "FORBIDDEN" }
```

#### List Sessions

```
GET /api/sessions
```

Returns all sessions with summary information.

**Query parameters:**

| Param    | Type     | Required | Description                              |
|----------|----------|----------|------------------------------------------|
| project  | `string` | No       | Project path filter (F-1.2) — only sessions whose `cwd` matches the path (normalized comparison: separators, `.`/`..`, trailing slash, Windows case-folding). Without the param all sessions are returned (backward compatible). Sessions without `cwd` (legacy) never match the filter |

**Example:**

```bash
curl "http://localhost:3456/api/sessions?project=/data/repos/my-project" \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "sessions": [
    {
      "id": "sess_a1b2c3d4",
      "title": "Refactor auth module",
      "model": "claude-sonnet-4-20250514",
      "provider": "anthropic",
      "createdAt": "2026-04-13T10:30:00.000Z",
      "updatedAt": "2026-04-13T10:45:00.000Z",
      "cwd": "/data/repos/my-project"
    },
    {
      "id": "sess_e5f6g7h8",
      "title": "Fix API rate limiter",
      "model": "gpt-4o",
      "provider": "openai",
      "createdAt": "2026-04-13T09:00:00.000Z",
      "updatedAt": "2026-04-13T09:20:00.000Z",
      "cwd": "/data/repos/my-project"
    }
  ]
}
```

> **Note:** `cwd` is omitted for legacy sessions whose JSONL header has no working directory — it is never `null` or an empty string (F-1.12). A project path with no sessions yields `"sessions": []` with HTTP 200.

#### Get Session

```
GET /api/sessions/:id
```

Returns a session with its full message history.

**Example:**

```bash
curl http://localhost:3456/api/sessions/sess_a1b2c3d4 \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "id": "sess_a1b2c3d4",
  "title": "Refactor auth module",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "createdAt": "2026-04-13T10:30:00.000Z",
  "updatedAt": "2026-04-13T10:45:00.000Z",
  "cwd": "/data/repos/my-project",
  "messages": [
    {
      "role": "user",
      "content": "Can you refactor the auth module to use JWT?",
      "timestamp": "2026-04-13T10:30:05.000Z"
    },
    {
      "role": "assistant",
      "content": "I'll refactor the auth module to use JWT tokens...",
      "timestamp": "2026-04-13T10:30:15.000Z"
    }
  ]
}
```

**Error `404`:** Session not found.

#### Delete Session

```
DELETE /api/sessions/:id
```

Permanently deletes a session and its messages.

**Query parameters:**

| Param    | Type     | Required | Description                              |
|----------|----------|----------|------------------------------------------|
| project  | `string` | No       | Project path verification (F-1.4) — the session must belong to this project (`cwd` match, normalized comparison) or the delete is rejected with `403`. Without the param the delete is global (backward compatible) |

**Example:**

```bash
curl -X DELETE "http://localhost:3456/api/sessions/sess_a1b2c3d4?project=/data/repos/my-project" \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `204`:** No body (`No Content`).

**Error `404`:** Session not found.

**Error `403`** — the session exists but belongs to a different project than `?project=` (also when the session has no `cwd` at all):

```json
{ "error": "session does not belong to this project" }
```

#### Send Message

```
POST /api/sessions/:id/messages
```

Send a message to the agent in the given session. The response acknowledges receipt; actual agent content is delivered in real-time via the [WebSocket stream](#websocket-protocol).

**Request body:**

| Field               | Type     | Required | Description                                      |
|---------------------|----------|----------|--------------------------------------------------|
| message             | `string` | Yes      | The user message to send                         |
| streamingBehavior   | `string` | No       | Streaming preference (e.g., `"stream"`)          |

**Example:**

```bash
curl -X POST http://localhost:3456/api/sessions/sess_a1b2c3d4/messages \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "List all files in the src directory"}'
```

**Response `200`:**

```json
{
  "success": true
}
```

> **Note:** This endpoint only enqueues the message. To receive the agent's reply, connect to the WebSocket and listen for `agent_event` messages.

---

### Projects

#### List Projects

```
GET /api/projects
```

Returns the project registry (`~/.fan/agent/projects.json`, F-1.6) enriched with per-project session counts (F-1.5). Projects are registered manually via `fan project register` or automatically on first session creation in a workspace (F-1.7 — `.git` → `"code"`, `docs/` → `"research"`, otherwise `"unknown"`; system paths are excluded).

**Example:**

```bash
curl http://localhost:3456/api/projects \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "projects": [
    {
      "path": "/data/repos/my-project",
      "name": "my-project",
      "type": "code",
      "sessionCount": 3,
      "available": true
    },
    {
      "path": "/data/repos/research-notes",
      "name": "research-notes",
      "type": "research",
      "sessionCount": 0,
      "available": true
    },
    {
      "path": "/data/repos/deleted-project",
      "name": "deleted-project",
      "type": "unknown",
      "sessionCount": 0,
      "available": false,
      "error": "PROJECT_NOT_FOUND"
    }
  ]
}
```

| Field        | Type      | Description                                                                |
|--------------|-----------|----------------------------------------------------------------------------|
| path         | `string`  | Absolute path of the project workspace                                     |
| name         | `string`  | Display name (from the registry; basename fallback)                        |
| type         | `string`  | `"code"` \| `"research"` \| `"automation"` \| `"unknown"`                   |
| sessionCount | `number`  | Sessions whose `cwd` matches the project path (normalized comparison)      |
| available    | `boolean` | `false` when the project directory no longer exists on disk (F-2.13)       |
| error        | `string`  | `"PROJECT_NOT_FOUND"` — present only when `available` is `false` (F-2.13)  |

An empty or missing registry yields `{ "projects": [] }` with HTTP 200.

> **F-2.13 — unavailable projects:** projects whose directory was deleted from
> disk are **not excluded** from the list. They are flagged with
> `"available": false, "error": "PROJECT_NOT_FOUND"` so the user can see them
> and remove them from the registry (see `DELETE /api/projects` below).
> Similarly, `GET /api/sessions?project=<path>` with a non-existent path is
> **not an error** — the whitelist allows not-yet-created directories inside a
> workspace root, and orphaned sessions of a deleted project must remain
> visible/manageable. The endpoint simply returns the cwd-filtered list
> (empty when no session ever ran with that cwd).

#### Create Project

```
POST /api/projects
```

Creates a new project workspace — optionally from a built-in template
(F-3.3/F-3.4) — auto-detects its type (F-3.2) and registers it in
`~/.fan/agent/projects.json` (F-3.5).

**Request body:**

```json
{
  "name": "market-analysis-q3",
  "template": "research",
  "rootPath": "/data/repos"
}
```

| Field    | Type     | Required | Description                                                                                                    |
|----------|----------|----------|----------------------------------------------------------------------------------------------------------------|
| name     | `string` | yes      | Project name, used as the directory name under `rootPath`. Must be a single path segment: no `/`, `\`, `".."` or `"."`, and must not resolve to the workspace root itself |
| template | `string` | no       | `"code"` \| `"research"` \| `"automation"`. Unknown names are rejected with `400` before any filesystem write          |
| rootPath | `string` | no       | Parent directory for the new project. Defaults to the workspace root (`FAN_WORKSPACE_ROOT`, falling back to `~/projects` when no whitelist is configured) |

Without `template` the server performs `mkdir -p` + type detection on the
resulting (empty) directory — type will be `"unknown"`.

**Template structures** (`packages/coding-agent/src/workspace/templates/`):

| Template    | Directories                                              | Files                                        |
|-------------|----------------------------------------------------------|----------------------------------------------|
| `code`      | `.fan/`, `src/`, `tests/`, `docs/`                       | `.fan/settings.json`, `package.json`         |
| `research`  | `.fan/`, `.fan/prompts/`, `docs/research/`, `data/`, `reports/` | `.fan/settings.json`                    |
| `automation`| `.fan/`, `scripts/`, `config/`, `output/`, `logs/`       | `.fan/settings.json`, `scripts/example.sh`   |

Templates never overwrite existing files. The `code` template deliberately
does **not** create `.git` (the user runs `git init` when ready) — since
detection would then yield `"unknown"`, the template name is used as the
declared type fallback.

**Example:**

```bash
curl -X POST http://localhost:3456/api/projects \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"market-analysis-q3","template":"research","rootPath":"/data/repos"}'
```

**Response `201` (created):**

```json
{
  "path": "/data/repos/market-analysis-q3",
  "name": "market-analysis-q3",
  "type": "research",
  "template": "research"
}
```

`template` is present only when a template was applied. `type` is
auto-detected from the created structure (e.g. the `research` template
creates `docs/research/` → detected as `"research"`).

**Responses:**

| Status | Meaning                                                                                              |
|--------|------------------------------------------------------------------------------------------------------|
| `201`  | Workspace created and newly registered                                                               |
| `200`  | Idempotent: the path was already registered — the existing registry entry is returned (dedup by path) |
| `400`  | Invalid body: missing/empty `name`, path-traversal name (`/`, `\`, `..`, `.`), name resolving to the workspace root, empty `template`/`rootPath`, or `Unknown template: <name>` |
| `403`  | `rootPath + name` is outside the workspace whitelist (`FORBIDDEN`, logged to the audit log, F-1.13)  |
| `501`  | The session adapter does not support project creation (`NOT_IMPLEMENTED`)                            |

#### Remove Project from Registry

```
DELETE /api/projects?path=<absolute path>
```

Removes a project entry from the registry (`~/.fan/agent/projects.json`).
Registry-only: sessions and files on disk are **never** touched. The path is
passed as a query parameter (not a body) for symmetry with the `?project=`
convention of the session endpoints.

**Example:**

```bash
curl -X DELETE "http://localhost:3456/api/projects?path=%2Fdata%2Frepos%2Fdeleted-project" \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Responses:**

| Status | Meaning                                                        |
|--------|----------------------------------------------------------------|
| `204`  | Entry removed (no body)                                        |
| `400`  | `path` query parameter missing or empty                        |
| `404`  | Path is not registered (`NOT_FOUND`)                           |
| `501`  | The session adapter does not support project removal (`NOT_IMPLEMENTED`) |

#### Update Project Type

```
PUT /api/projects?path=<absolute path>
```

Manually overrides a project's workspace type in the registry
(`~/.fan/agent/projects.json`) — used when auto-detection (F-3.2)
misclassified the project. The path travels as a query parameter (symmetry
with `DELETE /api/projects`); the body carries only the new type.
Registry-only: sessions and files on disk are **never** touched.

**Request body:**

```json
{ "type": "research" }
```

`type` must be one of `"code"`, `"research"`, `"automation"`, `"unknown"`.

**Example:**

```bash
curl -X PUT "http://localhost:3456/api/projects?path=%2Fdata%2Frepos%2Fmy-proj" \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"research"}'
```

**Response `200`:** the updated registry entry.

```json
{ "path": "/data/repos/my-proj", "name": "my-proj", "type": "research" }
```

**Responses:**

| Status | Meaning                                                        |
|--------|----------------------------------------------------------------|
| `200`  | Type updated — returns the updated entry                       |
| `400`  | `path` query parameter missing/empty, or `type` not in the enum |
| `404`  | Path is not registered (`NOT_FOUND`)                           |
| `501`  | The session adapter does not support project update (`NOT_IMPLEMENTED`) |

> **ServiceRegistry note (F-2.1):** the workspace `ServiceRegistry` is
> currently standalone (not wired into the runtime), so no cache
> invalidation is performed. When it gets integrated, a successful type
> update must be followed by `serviceRegistry.invalidate(cwd)` so cached
> per-workspace services are rebuilt for the new type.

---

### Models

#### List Models

```
GET /api/models
```

Returns all configured models and routing rules. Merges built-in model catalog with custom entries from `~/.fan/agent/models.json`. For built-in providers, models can be added by ID only — `baseUrl` and `api` are inherited from existing models.

**Example:**

```bash
curl http://localhost:3456/api/models \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "provider": "anthropic",
      "name": "Claude Sonnet 4",
      "enabled": true
    },
    {
      "id": "gpt-4o",
      "provider": "openai",
      "name": "GPT-4o",
      "enabled": true
    }
  ],
  "routingRules": [
    {
      "pattern": "coding",
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "priority": 1
    }
  ]
}
```

#### Get Model Settings

```
GET /api/models/settings
```

Returns per-model configuration overrides (temperature, max tokens, thinking) stored in the database.

**Example:**

```bash
curl http://localhost:3456/api/models/settings \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "settings": [
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "temperature": 0.7,
      "maxTokens": 8192,
      "thinking": false
    }
  ]
}
```

#### Update Model Settings

```
PUT /api/models/settings
```

Create or update settings for a specific model. Settings are stored in the database (not in `models.json`).

**Request body:**

| Field        | Type      | Required | Description                         |
|--------------|-----------|----------|-------------------------------------|
| provider     | `string`  | Yes      | Provider name (e.g., `"anthropic"`) |
| model        | `string`  | Yes      | Model identifier                    |
| temperature  | `number`  | No       | Sampling temperature (0.0–2.0)      |
| maxTokens    | `number`  | No       | Max output tokens                   |
| thinking     | `boolean` | No       | Enable extended thinking            |

**Example:**

```bash
curl -X PUT http://localhost:3456/api/models/settings \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "temperature": 0.3,
    "maxTokens": 16384,
    "thinking": true
  }'
```

**Response `200`:**

```json
{
  "setting": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "temperature": 0.3,
    "maxTokens": 16384,
    "thinking": true
  }
}
```

---

### Budget

#### Get Budget Status

```
GET /api/budget
```

Returns current budget status for all configured providers.

**Example:**

```bash
curl http://localhost:3456/api/budget \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "budgets": [
    {
      "provider": "anthropic",
      "period": "daily",
      "tokenLimit": 200000,
      "costLimit": 10.00,
      "tokensUsed": 45000,
      "costUsed": 2.35
    },
    {
      "provider": "openai",
      "period": "daily",
      "tokenLimit": 100000,
      "costLimit": 5.00,
      "tokensUsed": 12000,
      "costUsed": 0.60
    }
  ]
}
```

#### Update Budget

```
PUT /api/budget
```

Update budget configuration for a provider.

**Request body:**

| Field       | Type     | Required | Description                              |
|-------------|----------|----------|------------------------------------------|
| provider    | `string` | No       | Provider name (updates specific provider)|
| period      | `string` | Yes      | Budget period (`"daily"`, `"weekly"`, `"monthly"`) |
| tokenLimit  | `number` | No       | Token limit for the period               |
| costLimit   | `number` | No       | Cost limit in USD for the period         |

**Example:**

```bash
curl -X PUT http://localhost:3456/api/budget \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "period": "daily",
    "tokenLimit": 500000,
    "costLimit": 25.00
  }'
```

**Response `200`:**

```json
{
  "config": {
    "provider": "anthropic",
    "period": "daily",
    "tokenLimit": 500000,
    "costLimit": 25.00
  }
}
```

#### Get Project Budget (F-4.9)

```
GET /api/budget?project=<path>
```

Project-scoped branch of the budget endpoint. Returns the aggregated token
usage of a single project and its stored cap.

- `used` — sum of `tokens` of all assistant messages across every session
  whose cwd belongs to the project (aggregated from the JSONL session files —
  disk is the single source of truth).
- `limit` — per-project token cap stored via the project-scoped `PUT`
  (below), or `null` when no cap was set.

**Example:**

```bash
curl "http://localhost:3456/api/budget?project=/data/repos/my-project" \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "project": "/data/repos/my-project",
  "used": 12500,
  "limit": 500
}
```

#### Set Project Budget (F-4.9)

```
PUT /api/budget
```

When the request body contains a non-empty `project` string, the endpoint
switches to the project-scoped branch and stores a per-project token cap.
Caps are persisted in `~/.fan/agent/project-budgets.json` (flat JSON file
next to the `projects.json` registry — no DB migration, human-inspectable).
Project paths are normalized with the same rules as the `?project=` session
filter, so `C:\proj` and `c:/proj` resolve to one entry.

**Request body:**

| Field      | Type     | Required | Description                    |
|------------|----------|----------|--------------------------------|
| project    | `string` | Yes      | Project path (normalized)      |
| tokenLimit | `number` | Yes      | Non-negative token cap         |

**Example:**

```bash
curl -X PUT http://localhost:3456/api/budget \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "project": "/data/repos/my-project", "tokenLimit": 500 }'
```

**Response `200`:**

```json
{
  "project": "/data/repos/my-project",
  "limit": 500,
  "updatedAt": "2026-07-26T12:00:00.000Z"
}
```

> **Enforcement note:** the gateway only stores and serves per-project
> budgets — it does NOT block `sendMessage` when a cap is exhausted (deep
> integration with BudgetTracker/model-manager was deliberately deferred).
> Enforcement is the scheduler's job (F-4.9 part B): `fan-scheduler` sets the
> cap before each task and polls this endpoint during execution, marking the
> task `budget_exceeded` when `used >= limit`.

---

### Tokens

#### Create Token

```
POST /api/tokens
```

Create a new client token for API authentication.

> ⚠️ **The full token secret is returned only in this response.** It cannot be retrieved later. Store it immediately.

**Request body:**

| Field | Type     | Required | Description          |
|-------|----------|----------|----------------------|
| name  | `string` | Yes      | Human-readable label |

**Example:**

```bash
curl -X POST http://localhost:3456/api/tokens \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "VS Code extension"}'
```

**Response `201`:**

```json
{
  "token": {
    "id": "tok_9x8w7v6u",
    "name": "VS Code extension",
    "token": "fan_tk_a1b2c3d4e5f6g7h8i9j0",
    "createdAt": "2026-04-13T10:00:00.000Z",
    "lastUsed": null
  }
}
```

#### List Tokens

```
GET /api/tokens
```

Returns all tokens **without** their secrets.

**Example:**

```bash
curl http://localhost:3456/api/tokens \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "tokens": [
    {
      "id": "tok_9x8w7v6u",
      "name": "VS Code extension",
      "createdAt": "2026-04-13T10:00:00.000Z",
      "lastUsed": "2026-04-13T11:30:00.000Z"
    },
    {
      "id": "tok_5t4r3s2q",
      "name": "CI pipeline",
      "createdAt": "2026-04-12T15:00:00.000Z",
      "lastUsed": "2026-04-13T09:00:00.000Z"
    }
  ]
}
```

#### Revoke Token

```
DELETE /api/tokens/:id
```

Permanently revoke a token. The token can no longer be used for authentication.

**Example:**

```bash
curl -X DELETE http://localhost:3456/api/tokens/tok_5t4r3s2q \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "success": true
}
```

**Error `404`:** Token not found.

---

## Error Handling

All errors return a JSON body with a consistent format:

```json
{
  "error": "Session not found",
  "code": "NOT_FOUND"
}
```

### Error Codes

| Code              | HTTP Status | Description                              |
|-------------------|-------------|------------------------------------------|
| `BAD_REQUEST`     | 400         | Malformed request body or parameters     |
| `UNAUTHORIZED`    | 401         | Missing or invalid authentication token  |
| `FORBIDDEN`       | 403         | Token does not have permission for this action; or `cwd` rejected by the workspace whitelist / cross-project delete (see [Sessions](#sessions)) |
| `NOT_FOUND`       | 404         | Requested resource does not exist        |
| `CONFLICT`        | 409         | Resource conflict (e.g., duplicate name) |
| `VALIDATION_ERROR`| 422         | Request body failed validation           |
| `INTERNAL_ERROR`  | 500         | Unexpected server error                  |

---

## WebSocket Protocol

Connect to receive real-time agent events for a session.

### Connection

```
ws://localhost:3456/api/ws/{sessionId}?token=<your_token>
```

**Example:**

```bash
wscat -c "ws://localhost:3456/api/ws/sess_a1b2c3d4?token=fan_tk_a1b2c3d4e5f6g7h8i9j0"
```

### Authentication

Pass the token as a query parameter (`?token=...`). WebSocket connections without a valid token are closed immediately with code `4001`.

### Server → Client Events

All events are JSON messages with a `type` field:

#### `connected`

Sent immediately after a successful connection.

```json
{
  "type": "connected",
  "sessionId": "sess_a1b2c3d4",
  "timestamp": "2026-04-13T10:30:00.000Z"
}
```

#### `agent_event`

Agent activity for the session. Emitted when the agent starts processing, produces output, uses tools, or completes a turn.

```json
{
  "type": "agent_event",
  "event": "text_delta",
  "data": {
    "content": "I'll look at the auth module..."
  },
  "timestamp": "2026-04-13T10:30:05.000Z"
}
```

Common `event` values: `text_delta`, `tool_start`, `tool_result`, `turn_complete`, `error`.

#### `budget_alert`

Emitted when a budget threshold is approached or exceeded.

```json
{
  "type": "budget_alert",
  "data": {
    "provider": "anthropic",
    "period": "daily",
    "tokensUsed": 180000,
    "tokenLimit": 200000,
    "costUsed": 9.40,
    "costLimit": 10.00
  },
  "timestamp": "2026-04-13T10:35:00.000Z"
}
```

#### `model_switch`

Emitted when the orchestrator switches to a different model (fallback or routing).

```json
{
  "type": "model_switch",
  "data": {
    "from": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    "to": { "provider": "openai", "model": "gpt-4o" },
    "reason": "budget_limit_reached"
  },
  "timestamp": "2026-04-13T10:35:01.000Z"
}
```

#### `error`

Emitted when an error occurs on the session's WebSocket stream.

```json
{
  "type": "error",
  "data": {
    "message": "Session not found",
    "code": "NOT_FOUND"
  },
  "timestamp": "2026-04-13T10:35:02.000Z"
}
```

#### `queued`

The `sendMessage` was **accepted into the queue** because the engine is busy executing another session (F-2.5). The message will be dispatched automatically once the engine becomes idle.

```json
{
  "type": "queued",
  "sessionId": "sess_e5f6g7h8",
  "position": 2,
  "timestamp": "2026-07-26T10:35:02.000Z"
}
```

| Field     | Type     | Description                                          |
|-----------|----------|------------------------------------------------------|
| sessionId | `string` | Session the message was queued for                   |
| position  | `number` | 1-based position in that session's queue             |

#### `queue_full`

The `sendMessage` was **rejected** — the session's queue reached its capacity (F-2.15, default 50 messages). The message is dropped; nothing is dispatched.

```json
{
  "type": "queue_full",
  "sessionId": "sess_e5f6g7h8",
  "error": "QUEUE_OVERFLOW",
  "limit": 50,
  "timestamp": "2026-07-26T10:35:03.000Z"
}
```

| Field     | Type     | Description                                          |
|-----------|----------|------------------------------------------------------|
| sessionId | `string` | Session whose queue is full                          |
| error     | `string` | Stable machine-readable code: `"QUEUE_OVERFLOW"`     |
| limit     | `number` | Per-session queue capacity that was reached          |

### Client → Server Messages

#### `ping`

Send to verify the connection is alive. The server responds with `pong`.

```json
{ "type": "ping" }
```

**Response:**

```json
{ "type": "pong" }
```

#### `subscribe`

Reserved for future use. Currently a no-op.

```json
{ "type": "subscribe" }
```

#### `sendMessage`

Send a user message to the agent in this session over the WebSocket connection.

```json
{ "type": "sendMessage", "content": "List all files in src", "streamingBehavior": "steer" }
```

| Field             | Type     | Required | Description                                    |
|-------------------|----------|----------|------------------------------------------------|
| content           | `string` | Yes      | The user message text                          |
| streamingBehavior | `string` | No       | `"steer"` or `"followUp"` (steering preference) |

The runtime executes **one session at a time** (single engine). How the message is handled depends on the engine state (see [Message Queueing](#message-queueing-phase-2) below):

- **Engine idle** (or busy with *this same* session) → dispatched immediately; the reply streams as `agent_event` messages.
- **Engine busy with another session** → the message is queued; you receive a [`queued`](#queued) notification with the position.
- **Queue full** → the message is rejected with a [`queue_full`](#queue_full) notification.

### Message Queueing (Phase 2)

Because the runtime executes one session at a time, `WsMessageDispatcher` (`packages/api-gateway/src/ws-handler.ts`) serializes `sendMessage` requests:

- **Enqueue on busy:** when the engine is streaming a response for session A, a `sendMessage` for session B is appended to B's per-session FIFO queue (`InMemoryMessageQueue`, `packages/api-gateway/src/message-queue.ts`) and acknowledged with `{ type: "queued", position: N }`. A message for the *active* session is dispatched directly (the agent's internal steer/followUp queue handles it).
- **Global FIFO drain:** after a turn completes (`agent_end` event or dispatch settlement), the **globally oldest** queued message across all sessions is dispatched first, regardless of which session it belongs to.
- **Overflow protection (F-2.15):** each session's queue is capped at 50 messages (configurable server-side). New messages beyond the cap are rejected with `{ type: "queue_full", error: "QUEUE_OVERFLOW", limit: 50 }`.
- **In-memory only:** queued messages are **lost on server restart** (MVP; persistence is out of scope).
- **REST bypass:** `POST /api/sessions/:id/messages` dispatches directly and is never queued.

---

## Example Scripts

### cURL — Common Operations

```bash
# Set your token
export FAN_TOKEN="fan_tk_a1b2c3d4e5f6g7h8i9j0"

# Health check (no auth)
curl -s http://localhost:3456/api/health | jq .

# Create a session
SESSION=$(curl -s -X POST http://localhost:3456/api/sessions \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Debug session"}' | jq -r '.id')
echo "Session: $SESSION"

# Send a message
curl -s -X POST "http://localhost:3456/api/sessions/$SESSION/messages" \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "What files are in the current directory?"}' | jq .

# List all sessions
curl -s http://localhost:3456/api/sessions \
  -H "Authorization: Bearer $FAN_TOKEN" | jq .

# Update model temperature
curl -s -X PUT http://localhost:3456/api/models/settings \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-sonnet-4-20250514","temperature":0.5}' | jq .

# Check budget
curl -s http://localhost:3456/api/budget \
  -H "Authorization: Bearer $FAN_TOKEN" | jq .
```

### Python

```python
import requests

BASE = "http://localhost:3456/api"
TOKEN = "fan_tk_a1b2c3d4e5f6g7h8i9j0"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# Create session
res = requests.post(f"{BASE}/sessions", headers=HEADERS, json={"title": "Python test"})
session = res.json()
session_id = session["id"]
print(f"Created session: {session_id}")

# Send message
requests.post(
    f"{BASE}/sessions/{session_id}/messages",
    headers=HEADERS,
    json={"message": "Explain the project structure in 3 sentences."},
)

# Retrieve session with messages
res = requests.get(f"{BASE}/sessions/{session_id}", headers=HEADERS)
data = res.json()
print(f"Title: {data['title']}")
for msg in data.get("messages", []):
    print(f"  [{msg['role']}] {msg['content'][:100]}")
```

### JavaScript (fetch)

```javascript
const BASE = "http://localhost:3456/api";
const TOKEN = "fan_tk_a1b2c3d4e5f6g7h8i9j0";
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

// Create session
const { id: sessionId } = await (
  await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "JS test" }),
  })
).json();
console.log("Session:", sessionId);

// Send message and listen via WebSocket
await fetch(`${BASE}/sessions/${sessionId}/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({ message: "List TODO items in the codebase" }),
});

const ws = new WebSocket(
  `ws://localhost:3456/api/ws/${sessionId}?token=${TOKEN}`
);
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "agent_event" && data.event === "turn_complete") {
    console.log("Agent finished.");
    ws.close();
  } else if (data.type === "agent_event" && data.event === "text_delta") {
    process.stdout.write(data.data.content);
  }
};
```

### Quick Start Script

A complete end-to-end example: create a token, create a session, send a message, and listen for events.

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3456/api"

# Step 1: Create a token (using existing admin token)
echo "=== Creating token ==="
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
if [ -z "$ADMIN_TOKEN" ] && [ -z "${FAN_NO_AUTH:-}" ]; then
  echo "Set ADMIN_TOKEN or FAN_NO_AUTH=1 to run this script."
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $ADMIN_TOKEN"
TOKEN_RESP=$(curl -s -X POST "$BASE/tokens" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"name": "quick-start-script"}')
TOKEN=$(echo "$TOKEN_RESP" | jq -r '.token.token')
echo "Token created: $(echo "$TOKEN" | head -c 16)..."
echo "Save this token — it won't be shown again!"

# Step 2: Create a session
echo ""
echo "=== Creating session ==="
SESSION_RESP=$(curl -s -X POST "$BASE/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Quick start session"}')
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.id')
echo "Session created: $SESSION_ID"

# Step 3: Send a message
echo ""
echo "=== Sending message ==="
curl -s -X POST "$BASE/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Say hello and describe what you can do in one sentence."}'
echo "Message sent."

# Step 4: Listen for events (requires wscat or websocat)
echo ""
echo "=== Listening for events ==="
echo "Connect with: wscat -c \"ws://localhost:3456/api/ws/$SESSION_ID?token=$TOKEN\""
echo "Press Ctrl+C to stop."
echo ""

if command -v wscat &>/dev/null; then
  wscat -c "ws://localhost:3456/api/ws/$SESSION_ID?token=$TOKEN"
elif command -v websocat &>/dev/null; then
  websocat "ws://localhost:3456/api/ws/$SESSION_ID?token=$TOKEN"
else
  echo "Install wscat to listen: npm install -g wscat"
fi
```

Run with:

```bash
chmod +x quick-start.sh
FAN_NO_AUTH=1 ./quick-start.sh
```
