# FAN Orchestrator — Multi-Agent Task Decomposition & Coordination

## Overview

Standalone FAN extension that adds multi-agent orchestration to the FAN runtime. Enables the `Agent` tool for spawning specialized subagents, task management (`TaskCreate`/`TaskUpdate`/`TaskList`), and coordinator mode.

## Features

- **8 worker types**: explore, plan, implement, verify, bug-fix, code-research, tests-impl, docs-impl
- **6 tools**: Agent, SendMessage, StopAgent, TaskCreate, TaskUpdate, TaskList
- **RPC worker spawning**: workers run as `fan --mode rpc` processes (JSON-over-stdio)
- **Task management**: lifecycle tracking, dependencies, status updates
- **Coordinator mode** (Alt+O): automatic task decomposition and delegation
- **Slash commands**: `/orchestrator`, `/plan`
- **Configurable**: parallelism, timeouts, per-agent model overrides, stallTimeout, dangerous commands blacklist
- **Permissions system**: per-worker tool access control

## Installation

Ships bundled with FAN. Auto-discovered by the extension loader. No manual setup required.

## Configuration

Copy `config.example.json` to `~/.fan/agent/orchestrator/config.json` and customize.

### Per-Agent Model Overrides

Override the default model for specific agent types:

```json
{
  "agentModels": {
    "explore": { "provider": "local", "model": "ollama/qwen3:32b" },
    "verify": { "provider": "cloud", "model": "zai/glm-4.5-air" }
  }
}
```

## Version

2.0.0 — Orchestrator v2 (Agent/SendMessage/StopAgent tools, RPC spawning, 8 agent types)
