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

**Response `200`:**

```json
{
  "status": "ok",
  "version": "0.6.0",
  "uptime": 1847
}
```

| Field    | Type     | Description                       |
|----------|----------|-----------------------------------|
| status   | `string` | `"ok"` when server is operational |
| version  | `string` | FAN version number                |
| uptime   | `number` | Server uptime in seconds          |

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

**Example:**

```bash
curl -X POST http://localhost:3456/api/sessions \
  -H "Authorization: Bearer $FAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Refactor auth module"}'
```

**Response `201`:**

```json
{
  "id": "sess_a1b2c3d4",
  "title": "Refactor auth module",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "createdAt": "2026-04-13T10:30:00.000Z",
  "updatedAt": "2026-04-13T10:30:00.000Z"
}
```

#### List Sessions

```
GET /api/sessions
```

Returns all sessions with summary information.

**Example:**

```bash
curl http://localhost:3456/api/sessions \
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
      "updatedAt": "2026-04-13T10:45:00.000Z"
    },
    {
      "id": "sess_e5f6g7h8",
      "title": "Fix API rate limiter",
      "model": "gpt-4o",
      "provider": "openai",
      "createdAt": "2026-04-13T09:00:00.000Z",
      "updatedAt": "2026-04-13T09:20:00.000Z"
    }
  ]
}
```

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

**Example:**

```bash
curl -X DELETE http://localhost:3456/api/sessions/sess_a1b2c3d4 \
  -H "Authorization: Bearer $FAN_TOKEN"
```

**Response `200`:**

```json
{
  "success": true
}
```

**Error `404`:** Session not found.

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

### Models

#### List Models

```
GET /api/models
```

Returns all configured models and routing rules from `~/.fan/agent/models.json`.

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
| `FORBIDDEN`       | 403         | Token does not have permission for this action |
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
