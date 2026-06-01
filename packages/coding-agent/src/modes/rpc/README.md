# RPC Mode — Headless Agent Integration

FAN can run in **RPC mode** (`--mode rpc`) — a headless mode designed for embedding the AI agent into other applications. Communication happens via JSON lines over stdin/stdout.

---

## Quick Start

```bash
# Basic usage (requires configured API key and model)
fan --mode rpc

# With explicit model
ANTHROPIC_API_KEY=sk-ant-... fan --mode rpc --model anthropic/claude-sonnet-4-20250514

# Without a session file (for short-lived worker processes)
fan --mode rpc --no-session
```

**Requirements:** API key configured (via env var or `~/.fan/agent/.env`) and model registered in `~/.fan/agent/models.json`.

---

## Protocol

### Transport

| Direction | Format | Description |
|-----------|--------|-------------|
| **stdin** | JSON lines (NDJSON) | Commands from host app to agent |
| **stdout** | JSON lines (NDJSON) | Responses + streaming events from agent |
| **stderr** | Plain text | Logs, diagnostics, debugging output |

### Message Format

Each line is a complete JSON object terminated by `\n`. Multiple objects may be sent, one per line.

```
{"id":"req_1","type":"prompt","message":"Hello"}\n
{"id":"req_1","type":"response","command":"prompt","success":true}\n
{"type":"text_delta","content":"Hello! "}\n
{"type":"agent_end","tokens":150,"cost":0.003}\n
```

### Request IDs

Each command can include an optional `id` field for correlation. If provided, the response will include the same `id`. Useful for matching responses to requests in a multi-threaded reader.

```json
{"id":"my-request-1","type":"get_state"}
→ {"id":"my-request-1","type":"response","command":"get_state","success":true,"data":{...}}
```

---

## Commands (stdin → agent)

### Prompting

#### `prompt` — Send a message to the agent

```json
{"id":"1","type":"prompt","message":"Explain the project structure"}
```

With images and streaming behavior:
```json
{"id":"1","type":"prompt","message":"What's in this image?","images":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}],"streamingBehavior":"steer"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | `string` | Yes | The user message |
| `images` | `ImageContent[]` | No | Attached images (base64) |
| `streamingBehavior` | `"steer" \| "followUp"` | No | Queue behavior |

**Response:** `{"id":"1","type":"response","command":"prompt","success":true}`  
→ The actual reply comes as streaming events (see [Events](#events-stdout--agent))

#### `steer` — Interrupt and re-route mid-stream

```json
{"id":"2","type":"steer","message":"Actually, focus on the database part"}
```

Queues a steering message that interrupts the current agent run. The agent will process this as a new instruction immediately.

#### `follow_up` — Queue a message for after completion

```json
{"id":"3","type":"follow_up","message":"Also check the test files"}
```

Queues a message that will be processed after the current agent run completes.

#### `abort` — Cancel current operation

```json
{"id":"4","type":"abort"}
```

Stops any in-progress agent activity immediately.

#### `new_session` — Create a new session

```json
{"id":"5","type":"new_session","parentSession":"sess_abc123"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parentSession` | `string` | No | Parent session path for lineage tracking |

**Response:**
```json
{"id":"5","type":"response","command":"new_session","success":true,"data":{"cancelled":false}}
```

`cancelled: true` means an extension blocked session creation.

---

### Session State

#### `get_state` — Current session info

```json
{"id":"6","type":"get_state"}
```

**Response:**
```json
{
  "id": "6",
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {"provider":"anthropic","id":"claude-sonnet-4-20250514"},
    "thinkingLevel": "high",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "all",
    "sessionFile": "/home/user/.fan/sessions/sess_abc123.jsonl",
    "sessionId": "sess_abc123",
    "sessionName": "My Session",
    "autoCompactionEnabled": true,
    "messageCount": 12,
    "pendingMessageCount": 0
  }
}
```

#### `get_session_stats` — Session statistics

```json
{"id":"7","type":"get_session_stats"}
```

---

### Model Management

#### `get_available_models` — List registered models

```json
{"id":"8","type":"get_available_models"}
```

**Response:**
```json
{
  "id": "8",
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [
      {"provider":"anthropic","id":"claude-sonnet-4-20250514","name":"Claude Sonnet 4","contextWindow":200000,"reasoning":true},
      {"provider":"openai","id":"gpt-4o","name":"GPT-4o","contextWindow":128000,"reasoning":false}
    ]
  }
}
```

#### `set_model` — Switch to a specific model

```json
{"id":"9","type":"set_model","provider":"openai","modelId":"gpt-4o"}
```

The model must be registered in the model registry (from `models.json`).

#### `cycle_model` — Cycle to the next model

```json
{"id":"10","type":"cycle_model"}
```

**Response:** `null` if no other models are available.

---

### Thinking Level

#### `set_thinking_level` — Set thinking mode

```json
{"id":"11","type":"set_thinking_level","level":"high"}
```

Levels: `"off"` | `"low"` | `"high"` | `"xhigh"`

#### `cycle_thinking_level` — Cycle through levels

```json
{"id":"12","type":"cycle_thinking_level"}
```

**Response:** `null` if model doesn't support thinking.

---

### Queue Modes

```json
{"id":"13","type":"set_steering_mode","mode":"one-at-a-time"}
{"id":"14","type":"set_follow_up_mode","mode":"all"}
```

Modes: `"all"` — process all queued messages / `"one-at-a-time"` — process one at a time

---

### Compaction

```json
{"id":"15","type":"compact","customInstructions":"Summarize the discussion about database design"}
{"id":"16","type":"set_auto_compaction","enabled":true}
```

---

### Retry

```json
{"id":"17","type":"set_auto_retry","enabled":true}
{"id":"18","type":"abort_retry"}
```

---

### Bash Execution

```json
{"id":"19","type":"bash","command":"ls -la"}
```

**Response:**
```json
{
  "id": "19",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "exitCode": 0,
    "stdout": "total 24\n...",
    "stderr": ""
  }
}
```

#### `abort_bash`

```json
{"id":"20","type":"abort_bash"}
```

Kills the currently running bash process.

---

### Session Navigation

#### `switch_session` — Switch to another session file

```json
{"id":"21","type":"switch_session","sessionPath":"/home/user/.fan/sessions/other_session.jsonl"}
```

#### `fork` — Fork from a specific message

```json
{"id":"22","type":"fork","entryId":"entry_5"}
```

Creates a new session branching from the specified entry.

#### `get_fork_messages` — Messages available for forking

```json
{"id":"23","type":"get_fork_messages"}
```

#### `get_last_assistant_text` — Last assistant response text

```json
{"id":"24","type":"get_last_assistant_text"}
```

#### `set_session_name` — Rename current session

```json
{"id":"25","type":"set_session_name","name":"Code Review Session"}
```

#### `export_html` — Export session to HTML

```json
{"id":"26","type":"export_html","outputPath":"/tmp/session.html"}
```

#### `get_messages` — Full message history

```json
{"id":"27","type":"get_messages"}
```

**Response:**
```json
{
  "id": "27",
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {
    "messages": [
      {"role":"user","content":"Hello","timestamp":"2026-04-13T10:00:00Z"},
      {"role":"assistant","content":[{"type":"text","text":"Hi there!"}],"timestamp":"2026-04-13T10:00:05Z"}
    ]
  }
}
```

#### `get_commands` — Available slash commands

```json
{"id":"28","type":"get_commands"}
```

Returns extension commands, prompt templates, and skills that can be invoked via prompt.

---

### FAN Model Management

#### `get_routing_rules` — Routing rules

```json
{"id":"29","type":"get_routing_rules"}
```

#### `get_budget_status` — Budget status

```json
{"id":"30","type":"get_budget_status"}
```

#### `get_model_settings` — Per-model settings

```json
{"id":"31","type":"get_model_settings"}
```

#### `generate_token` — Create API token

```json
{"id":"32","type":"generate_token","name":"My App Token"}
```

**Response:**
```json
{
  "id": "32",
  "type": "response",
  "command": "generate_token",
  "success": true,
  "data": {
    "token": {
      "id": "tok_abc",
      "name": "My App Token",
      "token": "fan_tk_a1b2c3d4e5f6g7h8i9j0",
      "createdAt": "2026-04-13T10:00:00.000Z",
      "lastUsed": null
    }
  }
}
```

⚠️ **The full token is returned only once.** Save it.

#### `list_tokens` — List existing tokens

```json
{"id":"33","type":"list_tokens"}
```

#### `revoke_token` — Revoke a token

```json
{"id":"34","type":"revoke_token","tokenId":"tok_abc"}
```

---

## Events (stdout ← agent)

After you send a `prompt` command, the agent streams events in real-time. Each event is a JSON object on its own line.

### Agent Lifecycle Events

```json
{"type":"text_delta","content":"Let me look at the code..."}
{"type":"tool_start","name":"read","input":{"path":"/src/main.rs"}}
{"type":"tool_result","name":"read","output":"fn main() {\n  println!(\"Hello\");\n}"}
{"type":"text_delta","content":"I found the main function."}
{"type":"agent_end","tokens":150,"cost":0.003}
```

| Event | Description |
|-------|-------------|
| `text_delta` | Streaming text output from the agent |
| `tool_start` | Agent started using a tool (with input) |
| `tool_result` | Result of a tool call |
| `turn_complete` | Agent finished a complete turn |
| `agent_end` | Agent finished the entire prompt (includes token/cost stats) |
| `error` | An error occurred |

### Connection Event

Sent immediately when RPC mode starts, before any commands:

```json
{"type":"ready","timestamp":"2026-04-13T10:00:00.000Z"}
```

---

## Extension UI Events (stdout)

Extensions can request user interaction via these events. The host app must respond on stdin using `extension_ui_response`.

### Requests from agent

```json
{"type":"extension_ui_request","id":"ext_1","method":"select","title":"Choose a file","options":["src/main.rs","src/lib.rs","tests/test.rs"],"timeout":30000}
{"type":"extension_ui_request","id":"ext_2","method":"confirm","title":"Delete file?","message":"Are you sure you want to delete main.rs?","timeout":30000}
{"type":"extension_ui_request","id":"ext_3","method":"input","title":"Enter commit message","placeholder":"feat: ...","timeout":30000}
{"type":"extension_ui_request","id":"ext_4","method":"editor","title":"Edit the function","prefill":"fn hello() {\n  println!(\"Hello\");\n}"}
{"type":"extension_ui_request","id":"ext_5","method":"notify","message":"Build completed","notifyType":"info"}
{"type":"extension_ui_request","id":"ext_6","method":"setStatus","statusKey":"build","statusText":"Running..."}
{"type":"extension_ui_request","id":"ext_7","method":"setWidget","widgetKey":"progress","widgetLines":["Step 1/5: Building...","Step 2/5: Testing..."],"widgetPlacement":"belowEditor"}
{"type":"extension_ui_request","id":"ext_8","method":"setTitle","title":"Project Analysis"}
{"type":"extension_ui_request","id":"ext_9","method":"set_editor_text","text":"fn main() {}"}
```

### Responses from host

```json
{"type":"extension_ui_response","id":"ext_1","value":"src/main.rs"}
{"type":"extension_ui_response","id":"ext_2","confirmed":true}
{"type":"extension_ui_response","id":"ext_3","value":"feat: add new feature"}
{"type":"extension_ui_response","id":"ext_4","value":"fn hello() {\n  println!(\"Updated\");\n}"}
{"type":"extension_ui_response","id":"ext_5","cancelled":true}
```

| Method | Response Type | Notes |
|--------|---------------|-------|
| `select` | `{ value: string }` or `{ cancelled: true }` | Returns selected option string |
| `confirm` | `{ confirmed: boolean }` | True = yes, false = no |
| `input` | `{ value: string }` or `{ cancelled: true }` | Returns user input text |
| `editor` | `{ value: string }` or `{ cancelled: true }` | Returns edited text |
| `notify` | No response needed | Fire-and-forget notification |
| `setStatus` | No response needed | Updates status bar |
| `setWidget` | No response needed | Updates widget panel |
| `setTitle` | No response needed | Updates window title |
| `set_editor_text` | No response needed | Sets editor content |

---

## Error Responses

Any command can fail. The error format:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: anthropic/non-existent-model"
}
```

### Common Errors

| HTTP Equivalent | When |
|-----------------|------|
| `Model not found` | Unknown provider/model combination |
| `Session not found` | Invalid session path |
| `Timeout` | Agent took too long to respond |
| `Extension cancelled` | An extension blocked the operation |

---

## Integration Examples

### Rust (with Tauri/desktop app)

```rust
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

struct FanClient {
    stdin: Box<dyn Write + Send>,
    stdout: BufReader<Box<dyn Read + Send>>,
}

impl FanClient {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let mut child = Command::new("fan")
            .arg("--mode")
            .arg("rpc")
            .arg("--no-session")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        Ok(Self {
            stdin: Box::new(child.stdin.take().unwrap()),
            stdout: BufReader::new(Box::new(child.stdout.take().unwrap())),
        })
    }

    fn send(&mut self, command: &str) -> Result<String, Box<dyn std::error::Error>> {
        writeln!(self.stdin, "{}", command)?;
        let mut response = String::new();
        self.stdout.read_line(&mut response)?;
        Ok(response.trim().to_string())
    }

    fn prompt(&mut self, message: &str) -> Result<(), Box<dyn std::error::Error>> {
        let cmd = format!(r#"{{"id":"1","type":"prompt","message":"{}"}}"#, message);
        self.send(&cmd)?;
        Ok(())
    }

    fn read_events<F>(&mut self, mut callback: F) -> Result<(), Box<dyn std::error::Error>>
    where
        F: FnMut(serde_json::Value),
    {
        let mut line = String::new();
        loop {
            line.clear();
            if self.stdout.read_line(&mut line)? == 0 {
                break; // EOF
            }
            let value: serde_json::Value = serde_json::from_str(line.trim())?;
            if value.get("type") == Some(&serde_json::Value::String("agent_end".into())) {
                callback(value);
                break;
            }
            callback(value);
        }
        Ok(())
    }
}

// Usage
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut fan = FanClient::new()?;

    fan.prompt("List all Rust files in the current directory")?;
    fan.read_events(|event| {
        if let Some(content) = event.get("content").and_then(|c| c.as_str()) {
            print!("{}", content);
        }
    })?;

    Ok(())
}
```

### Node.js / TypeScript (using built-in RpcClient)

```typescript
import { RpcClient } from "./modes/rpc/rpc-client.js";

const client = new RpcClient({
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
});

await client.start();

// Subscribe to streaming events
client.onEvent((event) => {
  if (event.type === "text_delta") {
    process.stdout.write(event.content);
  }
});

// Send prompt and wait for completion
const events = await client.promptAndWait("Explain the architecture");
console.log(`Used ${events.length} events`);

await client.stop();
```

### Python

```python
import subprocess
import json

class FanClient:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["fan", "--mode", "rpc"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        self.req_id = 0

    def send(self, command: dict) -> dict:
        self.req_id += 1
        command["id"] = str(self.req_id)
        self.proc.stdin.write(json.dumps(command) + "\n")
        self.proc.stdin.flush()

        # Read responses until we get a response matching our id
        while True:
            line = self.proc.stdout.readline()
            data = json.loads(line)
            if data.get("type") == "response" and data.get("id") == str(self.req_id):
                return data
            # Non-response lines are events — print them
            if data.get("type") not in ("response",):
                print(f"[event] {data}")

    def prompt(self, message: str):
        return self.send({"type": "prompt", "message": message})

    def get_state(self) -> dict:
        return self.send({"type": "get_state"})

    def close(self):
        self.proc.terminate()
        self.proc.wait()

# Usage
client = FanClient()
state = client.get_state()
print(f"Model: {state['data']['model']}")
client.prompt("Hello! What can you do?")
client.close()
```

---

## Comparison: RPC vs WebSocket

| Aspect | RPC (`--mode rpc`) | WebSocket (server mode) |
|--------|---------------------|------------------------|
| **Transport** | stdin/stdout (pipe) | TCP (HTTP upgrade) |
| **Latency** | Minimal (same process) | + network overhead |
| **Multiple clients** | ❌ One process = one client | ✅ Many concurrent clients |
| **Auth** | Not needed (local IPC) | Required (tokens) |
| **Complexity** | Low — just read/write lines | Medium — HTTP + WS handshake |
| **Lifetime** | Tied to host process | Runs as daemon |
| **Dashboard/WebUI** | ❌ Not supported | ✅ Built-in dashboard |
| **IDE integration** | ✅ Excellent (VS Code, JetBrains) | ✅ Also possible via HTTP |

### When to use RPC

- **Desktop apps** (Electron, Tauri, Qt, native) — spawn as child process
- **IDE plugins** — process is embedded in the editor
- **CLI tools / scripts** — simple headless automation
- **Single-session** usage — one dialog with the agent at a time
- **Bundled** deployment — FAN ships with your app

### When to use WebSocket

- **Web applications** with a browser frontend
- **Multi-client** scenarios (several users or processes)
- **Background daemon** — start once, use forever
- **Dashboard** — FAN's built-in WebUI

---

## CLI Options for RPC Mode

| Flag | Description |
|------|-------------|
| `--mode rpc` | Enable RPC mode |
| `--model <provider/model>` | Specify model (e.g., `anthropic/claude-sonnet-4-20250514`) |
| `--provider <name>` | Specify provider |
| `--no-session` | Don't persist to disk (in-memory only) |
| `--no-tools` | Start without built-in tools |
| `--tools <name>` | Explicit tool list |
| `--cwd <path>` | Working directory |
| `FAN_NO_AUTH=1` | Disable auth (server mode only, not relevant for RPC) |

### Configuration Files

- **Models:** `~/.fan/agent/models.json`
- **API keys:** `~/.fan/agent/.env` or environment variables
- **Settings:** `~/.fan/agent/settings.json`

All configuration is read automatically from standard locations. Explicit flags override file settings.
