# Dashboard Guide

Web-based UI for interacting with the FAN runtime — chat, sessions, models, budget, and tokens.

## Overview

The FAN dashboard is a Lit-based web UI that connects to the FAN server via HTTP REST API and WebSocket. It provides a visual interface for chatting with the AI, managing sessions, configuring models, tracking token usage, and administering API tokens.

- **Disk is truth.** Sessions live as JSONL files — same source as the TUI and other clients.
- **One active session.** The runtime executes one session at a time. Switching loads a different file.
- **Real-time.** WebSocket provides streaming, status changes, and live tool output without polling.

## Starting the Dashboard

### `fan --web` (Recommended)

```bash
fan --web
```

Dashboard available at **http://localhost:3456**. This is the easiest way — starts both the API server and the dashboard frontend in one command, and auto-opens the browser.

### `fan server` (Foreground)

```bash
fan server
```

Starts the API server with the integrated dashboard in the foreground. Equivalent to `fan --web`.

### `fan --mode server` (API-Only, No Browser)

```bash
fan --mode server
```

Starts the API server at **http://localhost:3456** without auto-opening the browser. Useful for headless or IDE-only usage.

### `fan server start` (Background Daemon)

```bash
fan server start
```

Starts the server as a background daemon for IDE plugins and long-running sessions. Use `fan server stop` to stop and `fan server status` to check.

### Dev Mode (Separate)

```bash
cd packages/dashboard && npm run dev
```

Dashboard available at **http://localhost:5174**. Requires a running FAN server (`fan --web` or `fan --mode server`) for the API backend. Use this during development to get HMR and Vite tooling.

## First Launch

1. Open the dashboard URL in your browser.
2. The dashboard auto-connects to the local server on startup.
3. If authentication is required, an API token is created automatically for your session. See [API Token Management](#api-token-management) for details.
4. Your most recent session is loaded automatically (same as the TUI's `continueRecent` behavior).

## Chat Interface

The main interaction area. Messages stream in real-time as the AI generates them.

### Sending Messages

Type in the input field at the bottom and press **Enter** to send. Use **Shift+Enter** for a newline.

### Streaming Responses

Responses appear token-by-token as they're generated. A typing indicator shows while the AI is working.

### Markdown Rendering

AI responses are rendered as formatted Markdown — headers, lists, code blocks, tables, links, and inline formatting all display correctly.

### Thinking Blocks

When a model uses extended thinking, a collapsible block shows the reasoning. Click the block header to expand or collapse it.

### Tool Call Display

When the agent uses tools (read, write, edit, bash, etc.), each call is shown with:

- **Tool name** and arguments
- **Status** (running, completed, failed)
- **Result preview** (truncated for large outputs)

### Copy Message Content

Hover over any message to reveal a **copy** button. Click it to copy the raw message content to your clipboard.

### Slash Command Autocomplete

Typing `/` in the chat input opens an autocomplete dropdown (`chat-view.ts` + `lib/slash-commands.ts`, F-3.9):

- **Commands** — the 8 pre-installed skills as `/skill:<name>` (`idea-lab`, `research-spec-generator`, `repo-explorer`, `deep-dive`, `code-research`, `bug-fix`, `auto-tests`, `fan-forge`). This is the only slash syntax that works through the server path: `/skill:<name> <args>` is expanded to the skill's `SKILL.md` content by the runtime. Built-in TUI commands (`/model`, `/compact`, …) are interactive-mode only and intentionally not listed.
- **Type-aware ordering** — commands relevant to the active project's workspace type come first: `research` → idea-lab / research-spec-generator / deep-dive; `code` → bug-fix / auto-tests / code-research / repo-explorer; `automation` → repo-explorer / auto-tests.
- **Navigation** — ↑/↓ to move, Enter/Tab to insert, Esc to dismiss. The list filters as you type.

### Queue Indicator

The runtime executes one session at a time. If you send a message while the engine is busy with another session, your message is queued server-side (see [Message Queueing](api-reference.md#message-queueing-phase-2)):

- **"В очереди, позиция N"** — a yellow indicator above the input shows your 1-based queue position (server sent `queued`). It hides automatically when the engine picks up your message and streaming starts.
- **Queue overflow warning** — if the session's queue is full (50 messages), the message is rejected (`queue_full` / `QUEUE_OVERFLOW`) and a warning is shown instead; dismiss it manually.

## Project Switcher

The sidebar header contains the **project switcher** (`<fan-project-switcher>`) — a dropdown over the project registry (`GET /api/projects`):

- **Select project** — click a project to scope the session list to it. The active project is highlighted; its name is shown in the switcher button.
- **Search** — the filter input matches project name or path (case-insensitive).
- **Session counts** — each entry shows the number of sessions in that project.
- **Add project** — the **+** button opens the [create project dialog](#create-project-dialog) (F-3.8) to create a workspace from a template via `POST /api/projects`.
- **Unavailable projects** — projects whose directory was deleted from disk are marked with a "Not found on disk" indicator (`available: false` / `PROJECT_NOT_FOUND` from the API) and offer a **remove** button that calls `DELETE /api/projects?path=` to drop the entry from the registry. Sessions and files on disk are never touched.

### Workspace Type Icons (Phase 3)

Every project entry is prefixed with an icon reflecting its workspace type (`project.type` from the API; `lib/workspace-type.ts`, F-3.7):

| Type        | Icon (Lucide)    | CSS class         | Meaning                              |
|-------------|------------------|-------------------|--------------------------------------|
| `code`      | CodeXml (💻)     | `.type-code`      | Code repository (`.git` + `src/`/`package.json`) |
| `research`  | FlaskConical (🔬)| `.type-research`  | Research workspace (`docs/research/` or `.fan/prompts/`) |
| `automation`| Cog (⚙️)         | `.type-automation`| Scripts + config (`*.sh`/`*.py` + config files) |
| `unknown`   | CircleQuestionMark (❓) | `.type-unknown` | No criterion matched            |

The same icons appear on the cwd group headers in the session tree.

### Create Project Dialog

The **+** button in the switcher opens `<fan-create-project-dialog>` (F-3.8) — a modal that creates a workspace via `POST /api/projects` (F-3.5):

- **Project name** — required; path-traversal symbols (`/`, `\`, `..`, `.`) are rejected client-side (the server validates too).
- **Template radio group** — *Code Project* (`src/`, `tests/`, `docs/`, `package.json`), *Research Lab* (`docs/research/`, `data/`, `reports/`), *Automation Hub* (`scripts/`, `config/`, `output/`, `logs/`), or *Empty Folder* (no `template` field in the request).
- **Location** (`rootPath`) — optional; when empty the server applies its default (workspace root → `~/projects`).

On success the dialog emits `project-created`, the project list is re-fetched and the new project becomes active. Server errors (400/403) are shown inline; the dialog stays open.

### Manual Type Change

Each project row has a **type edit** button (F-3.10) that opens an inline type picker under the item. Picking a type sends `PUT /api/projects?path= { type }` and reloads the list — the icon refreshes immediately. Use this when auto-detection classified the project wrong (e.g. a code project without `.git` shows as `unknown`).

## Session Management

All sessions are stored as JSONL files on disk. The dashboard provides CRUD operations over them.

- **Create** — Click **New Session** in the sidebar. A fresh session is created and activated immediately.
- **Switch** — Click any session in the sidebar. The runtime loads it and re-establishes WebSocket subscriptions.
- **Search** — Use the search field to filter sessions by name (case-insensitive).
- **Delete** — Right-click a session and select **Delete**. Removes the session file from disk permanently.
- **History** — Each session shows its creation date and message count. Most recently active appears first.

### Grouping by Project (cwd)

The session list is rendered as a **tree grouped by project** (`cwd` of each session):

- Each unique `cwd` forms a collapsible group (toggle ▼/▶) labelled with the path basename and a session counter; the full path is available as a tooltip.
- When a project is selected in the [project switcher](#project-switcher), the list is additionally scoped to that project server-side (`?project=` filter).
- Legacy sessions without a `cwd` (created before workspace support) are collected into a **«Без проекта»** group, rendered last.
- **Status dots** colour-code each session: 🟢 active (currently open), 🔵 completed (has messages), 🟡 error/empty.

## Budget Visualization

Track token usage and spending across providers.

### Usage & Costs

A breakdown per provider shows input, output, and cache tokens. Estimated costs are calculated from pricing data in `models.json` or built-in defaults.

### Limits

Configure limits in `~/.fan/agent/settings.json`:

```json
{
  "budget": {
    "dailyTokenLimit": 500000,
    "dailyCostLimit": 10.0,
    "monthlyCostLimit": 100.0
  }
}
```

The dashboard shows your current usage relative to these limits with visual progress bars.

Usage charts per provider show token consumption over time. Hover for exact values.

## Model Settings

Configure per-model parameters. Settings are stored in the Prisma database (not in `models.json`).

### Temperature

Controls randomness. Range: **0–2**. Lower values (0–0.3) for deterministic output, higher values (0.7–1.0) for creative tasks.

### Max Tokens

Maximum output tokens the model can generate per response. Capped by the model's built-in limit.

### Thinking Budget

Sets the reasoning effort level. Options: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Higher values produce more thorough reasoning but consume more tokens. Only available for models that support extended thinking.

### Setting Defaults

The model settings page lets you configure any model listed in your `models.json` or built-in model catalog. Navigate to **Model Settings** in the sidebar to open the configuration panel.

## API Token Management

API tokens allow external clients (IDE plugins, custom scripts, other UIs) to connect to the FAN server.

- **Create** — Navigate to **API Tokens** → **Create Token**. Copy the token immediately — it's displayed once and stored as a hash (cannot be recovered).
- **Revoke** — Click revoke next to any token. The token is invalidated and the client disconnected.
- **Permissions** — All tokens have full API access. FAN is single-user and local, so granular permissions aren't needed.

## Theme

Toggle between light and dark themes using the switcher in the top-right corner. By default, the dashboard follows your OS preference — set it explicitly to override.

The custom FAN theme uses oklch colors at hue 260° (blue accent), defined in `packages/dashboard/src/app.css` with light/dark variants.
