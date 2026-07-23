# fan-lavish

> Visual review of HTML artifacts with human-in-the-loop feedback via [Lavish Editor](https://www.npmjs.com/package/lavish-axi).

**fan-lavish** integrates Lavish Editor into FAN — agents generate HTML artifacts (plans, diagrams, comparisons, reports), open them in the Lavish Editor browser, and the user annotates elements and sends feedback. The agent iterates until the result is approved.

**Bundle contents:**

| Component | What it provides |
|-----------|-----------------|
| **Extension** | `lavish` tool (7 commands) + lifecycle hooks (ambient context on session start, graceful stop on shutdown) |
| **Skill** | `SKILL.md` — playbook guidance, workflow rules, visual design patterns |

---

## Requirements

| Requirement | Details |
|-------------|---------|
| FAN | Phase 7+ (current version) |
| Node.js | ≥ 18 (for `lavish-axi` CLI via `npx`) |
| OS | Windows, macOS, Linux |

---

## Installation

### Option 1: FAN Store (recommended)

```bash
fan store install fan-lavish
```

### Option 2: Manual installation

```bash
# Copy to user-level extensions directory
cp -r fan-lavish/ ~/.fan/agent/extensions/fan-lavish/

# Or copy to project-level extensions
cp -r fan-lavish/ .fan/extensions/fan-lavish/

# Restart FAN to load the extension
```

---

## Quick Start

```
# In FAN TUI — invoke via slash command:
/lavish plan for REST API authentication

# Or ask the agent directly:
Make a visual comparison of PostgreSQL vs MySQL
```

**Workflow:**

1. Agent fetches playbook guidance → writes HTML artifact → opens it in Lavish Editor
2. User reviews in the browser, annotates elements, sends feedback
3. Agent applies changes → polls again → iterates until the user ends the session

---

## Configuration

Optional `config.json` in the extension directory:

```json
{
  "port": 4387,
  "noOpen": false
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | number | `4387` | Lavish Editor server port |
| `noOpen` | boolean | `false` | Skip automatic browser open on `open` command |

**Environment variables** (override config.json):

| Variable | Description |
|----------|-------------|
| `LAVISH_AXI_PORT` | Server port |
| `LAVISH_AXI_NO_OPEN` | Set to `1` to disable browser auto-open |

---

## Commands (`lavish` tool)

| Command | Parameters | Description |
|---------|-----------|-------------|
| `open` | `file` (required), `reopen?`, `no_gate?` | Open HTML artifact in Lavish Editor browser |
| `poll` | `file` (required), `agent_reply?` | Long-poll for user feedback (blocking) |
| `end` | `file` (required) | End the review session |
| `playbook` | `playbook_id?` | Get playbook guidance (diagram, plan, comparison, etc.) |
| `design` | — | Get design guidance and CDN snippets |
| `export` | `file` (required), `out?` | Export standalone HTML with inlined assets |
| `info` | — | Show open sessions and usage |

**Available playbooks:** `diagram`, `plan`, `comparison`, `table`, `code`, `input`, `slides`

---

## Troubleshooting

### lavish-axi not found

```bash
# Verify Node.js is installed (≥ 18)
node --version

# Install lavish-axi globally
npm install -g lavish-axi

# Verify installation
lavish-axi --version
```

If global install is not possible, the extension falls back to `npx -y lavish-axi` automatically.

### Port 4387 is already in use

```bash
# Change port in config.json
{ "port": 5000 }

# Or find and stop the process on the port
# Linux/macOS:
lsof -i :4387
# Windows:
netstat -ano | findstr :4387
```

### Poll hangs indefinitely

- Open the browser manually using the URL from the `open` command response
- Press `Ctrl+C` to interrupt — feedback is preserved server-side
- The Lavish server auto-stops after 30 minutes of inactivity

### Browser does not open automatically

- Set `"noOpen": false` in `config.json` (or remove the `LAVISH_AXI_NO_OPEN` env var)
- Open the URL manually from the `open` command response

### layout_warnings in poll response

- These indicate proven severe layout failures detected by Lavish Editor
- Fix the HTML issues before asking the user to review again
- Common causes: missing viewport meta tag, broken flex/grid layouts, zero-size containers
