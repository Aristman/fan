# FAN Orchestrator — Multi-Agent Task Decomposition & Coordination

## Overview

Standalone FAN extension that adds multi-agent orchestration to the FAN runtime. Enables the `delegate_task` tool for spawning specialized subagents (explore, plan, implement, verify), task management, and coordinator mode.

## Features

- **4 worker types**: explore (read-only recon), plan (architecture analysis), implement (code changes), verify (adversary checks)
- **delegate_task tool**: single, parallel, and chain execution modes
- **Task management**: lifecycle tracking, dependencies, status updates
- **Coordinator mode** (Alt+O): automatic task decomposition and delegation
- **Slash commands**: `/orchestrator`, `/plan`, `/tasks`, `/agents`, `/delegate`
- **Configurable**: parallelism, timeouts, per-agent models, dangerous commands blacklist
- **Permissions system**: per-worker tool access control

## Installation

Ships bundled with FAN. Auto-discovered by the extension loader. No manual setup required.

## Configuration

Copy `config.example.json` to `~/.fan/agent/orchestrator/config.json` and customize.

## Version

1.0.0 — Standalone FAN Store extension (extracted from core)
