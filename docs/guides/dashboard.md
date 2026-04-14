# Dashboard Guide

Web-based UI for interacting with the FAN runtime — chat, sessions, models, budget, and tokens.

## Overview

The FAN dashboard is a Lit-based web UI that connects to the FAN server via HTTP REST API and WebSocket. It provides a visual interface for chatting with the AI, managing sessions, configuring models, tracking token usage, and administering API tokens.

- **Disk is truth.** Sessions live as JSONL files — same source as the TUI and other clients.
- **One active session.** The runtime executes one session at a time. Switching loads a different file.
- **Real-time.** WebSocket provides streaming, status changes, and live tool output without polling.

## Starting the Dashboard

### Server Mode (Integrated)

```bash
fna --mode server
```

Dashboard available at **http://localhost:3456**. This is the recommended way — the FAN server hosts both the API and the dashboard frontend.

### Dev Mode (Separate)

```bash
cd packages/dashboard && npm run dev
```

Dashboard available at **http://localhost:5174**. Requires a running FAN server (`fna --mode server`) for the API backend. Use this during development to get HMR and Vite tooling.

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

## Session Management

All sessions are stored as JSONL files on disk. The dashboard provides CRUD operations over them.

- **Create** — Click **New Session** in the sidebar. A fresh session is created and activated immediately.
- **Switch** — Click any session in the sidebar. The runtime loads it and re-establishes WebSocket subscriptions.
- **Search** — Use the search field to filter sessions by name (case-insensitive).
- **Delete** — Right-click a session and select **Delete**. Removes the session file from disk permanently.
- **History** — Each session shows its creation date and message count. Most recently active appears first.

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
