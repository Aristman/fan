# FAN — Общая архитектура

Локальный AI runtime-agent для разработчиков. Монорепозиторий: Bun · TypeScript strict · npm workspaces · Hono REST+WS · Prisma+SQLite · Lit+Vite.

## 1. Общая схема — 6 слоёв, один хаб

Все пути ведут через `fan-coding-agent` — центральный хаб, импортирующий все остальные пакеты. Клиенты подключаются двумя путями: in-process (TUI) или через API Gateway (HTTP REST + WebSocket).

```mermaid
flowchart TD
  subgraph UI["1 · UI-клиенты"]
    TUI["TUI (fan-tui)<br/>in-process"]
    DASH["Dashboard (Lit+Vite)<br/>HTTP REST + WS"]
    IDE["IDE plugin<br/>stdio RPC / HTTP"]
    PRINT["Print mode<br/>stdout"]
  end

  subgraph ENTRY["2 · Точки входа"]
    CLI["main.ts — CLI dispatcher<br/>modes: interactive · print · rpc · server"]
    RUNTIME["createAgentSessionRuntime()<br/>один активный AgentSession"]
  end

  subgraph CORE["3 · Ядро — fan-coding-agent (хаб)"]
    SESSION["AgentSession · agentLoop()"]
    SM["SessionManager<br/>JSONL на диске = source of truth"]
    TOOLS["Built-in tools<br/>read · write · edit · bash · grep · find · ls"]
    EXTR["ExtensionRunner<br/>lifecycle hooks"]
  end

  subgraph EXT["4 · Расширения (11 bundled)"]
    ORCH["fan-orchestrator<br/>coordinator + workers"]
    STORE["fan-store"]
    MCPX["fan-mcp"]
    MORE["+8: soul, memory,<br/>web-search, analytics…"]
  end

  subgraph MODELS["5 · Model Management"]
    MM["ProviderRouter · FallbackChain<br/>BudgetTracker"]
    DB[("@fan/db<br/>Prisma + SQLite")]
  end

  subgraph LLM["6 · LLM transport — fan-ai"]
    STREAM["streamSimple()<br/>унифицированный стриминг"]
  end

  subgraph EXTERNAL["Внешние системы"]
    CLOUD["20+ облачных LLM<br/>Anthropic · OpenAI · Google · Groq…"]
    LOCAL["Локальные LLM<br/>Ollama · vLLM · LM Studio"]
    MCPSRV["MCP-серверы<br/>stdio / HTTP"]
    FSTORE["FAN Store server<br/>fan.sea-agents.ru"]
  end

  TUI --> CLI
  PRINT --> CLI
  DASH -->|"REST localhost:3456 + WS"| APIGW["API Gateway (Hono)<br/>token auth"]
  IDE -->|"stdio RPC"| CLI
  IDE -->|"HTTP+WS"| APIGW
  CLI --> RUNTIME
  APIGW -->|"SessionAdapter"| RUNTIME
  RUNTIME --> SESSION
  SESSION --> SM
  SESSION --> TOOLS
  SESSION --> EXTR
  EXTR --> ORCH
  EXTR --> STORE
  EXTR --> MCPX
  EXTR --> MORE
  ORCH -.->|"spawn: fan --mode rpc --no-session<br/>JSON-over-stdio"| CLI
  SESSION --> MM
  MM --> DB
  MM --> STREAM
  SESSION --> STREAM
  STREAM -->|"HTTPS + SSE"| CLOUD
  STREAM -->|"HTTP localhost"| LOCAL
  MCPX -->|"MCP protocol"| MCPSRV
  STORE -->|"HTTPS"| FSTORE
```

## 2. Поток данных end-to-end

Один и тот же путь `AgentSession.prompt()` используется всеми клиентами — TUI напрямую, Dashboard и IDE через API Gateway.

```mermaid
flowchart TD
  IN["Ввод пользователя<br/>TUI · Dashboard · IDE"]
  PROMPT["AgentSession.prompt()"]
  HOOK["ExtensionRunner.emit(input)<br/>расширения могут модифицировать"]
  APPEND["SessionManager.append()<br/>запись user message в JSONL"]
  LOOP["Agent.agentLoop()<br/>fan-agent-core"]
  LLM["fan-ai streamSimple()<br/>HTTPS + SSE → провайдер"]
  TOOL{"tool_call?"}
  PERM["ExtensionRunner<br/>permissions check"]
  EXEC["executeTool()<br/>read/write/edit/bash…"]
  CTX["результат → контекст<br/>следующая итерация"]
  DONE["turn_end"]
  SAVE["append assistant message → JSONL<br/>ModelManager.trackUsage() → Budget"]
  RENDER["Рендер: TUI markdown<br/>или WS broadcast → Dashboard"]

  IN --> PROMPT --> HOOK --> APPEND --> LOOP --> LLM
  LLM -->|"text_delta"| RENDER
  LLM --> TOOL
  TOOL -->|"да"| PERM --> EXEC --> CTX --> LOOP
  TOOL -->|"нет, agent_end"| DONE --> SAVE --> RENDER
```

## 3. Многоагентный оркестратор

Оркестратор — standalone-расширение, не зашито в ядро. Каждый воркер — полноценный fan-процесс в RPC-режиме с JSON-over-stdio. Координатор владеет таск-бордом, воркеры — чистые исполнители.

```mermaid
flowchart LR
  USER["Оператор"] --> COORD["Coordinator<br/>главная сессия fan"]
  COORD -->|"TaskCreate / TaskUpdate"| BOARD["Task board<br/>pending → in_progress → completed"]
  COORD -->|"delegate_task"| RUNNER["Subagent Runner"]
  RUNNER -->|"spawn"| W1["Worker 1<br/>fan --mode rpc<br/>--no-session"]
  RUNNER -->|"spawn"| W2["Worker 2<br/>explore · plan · verify"]
  RUNNER -->|"spawn"| W3["Worker 3<br/>implement · bug-fix"]
  W1 -->|"JSON-over-stdio"| RUNNER
  W2 -->|"JSON-over-stdio"| RUNNER
  W3 -->|"JSON-over-stdio"| RUNNER
```

Spawn воркера:

```js
spawn("fan", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills"])
```

## 4. Пакеты монорепозитория

| Пакет | npm-имя | Роль |
|-------|---------|------|
| `packages/coding-agent` | `@seaagents/fan-coding-agent` | **Хаб**: CLI, сессии JSONL, built-in tools, расширения, скиллы |
| `packages/agent` | `@seaagents/fan-agent-core` | Agent runtime: `Agent`, `agentLoop()`, tool calling |
| `packages/ai` | `@seaagents/fan-ai` | LLM-абстракция: `streamSimple()`, 20+ провайдеров |
| `packages/tui` | `@seaagents/fan-tui` | Terminal UI: markdown-рендеринг, editor |
| `packages/web-ui` | `@seaagents/fan-web-ui` | Lit-компоненты чата (ChatPanel, Messages) |
| `packages/api-gateway` | `@fan/api-gateway` | Hono REST (14 endpoints) + WebSocket, token auth |
| `packages/dashboard` | `@fan/dashboard` | Lit+Vite веб-клиент (тонкий фронтенд) |
| `packages/model-manager` | `@fan/model-manager` | ProviderRouter, FallbackChain, BudgetTracker |
| `packages/db` | `@fan/db` | Prisma+SQLite: метаданные, модели, бюджеты, токены |
| `packages/store` | `@fan/store` | FAN Store пакетный менеджер |
| `packages/mcp` | `@fan/mcp` | MCP-клиент: внешние tool-серверы |

Порядок сборки отражает граф зависимостей: `db → tui → ai → agent → model-manager → api-gateway → web-ui → store → coding-agent → mcp`.

## 5. Где что хранится

| Данные | Расположение | Формат |
|--------|--------------|--------|
| **Сообщения сессий** — source of truth | `~/.fan/sessions/*.jsonl` или `.fan/sessions/` | JSONL на диске |
| Метаданные сессий, модели, бюджеты, токены | `~/.fan/agent/fan.db` | SQLite (Prisma) |
| API-ключи LLM-провайдеров | `~/.fan/agent/auth.json` | JSON |
| Кастомные модели (2000+) | `~/.fan/agent/models.json` | JSON, только global |
| Настройки | `~/.fan/agent/settings.json` + `.fan/settings.json` | JSON, 2 уровня |
| Расширения | project > user > builtin | директории с приоритетом |
| Скиллы | `skills/` (8 bundled) + `~/.fan/agent/skills/` | SKILL.md |

## 6. Ключевые архитектурные решения

1. **Disk-first.** JSONL на диске — единственный источник истины для сообщений. Runtime — stateless execution engine, одна активная сессия, `switchSession()` пересоздаёт AgentSession.
2. **Два пути к ядру.** In-process (TUI, Print) и API Gateway (Dashboard, IDE). Оба сходятся в `AgentSession.prompt()`.
3. **Оркестратор = расширение.** Воркеры — отдельные fan-процессы с JSON-over-stdio, полная изоляция от координатора.
4. **Двойная аутентификация.** ClientToken (SQLite) для HTTP/WS-клиентов + auth.json для LLM-провайдеров. `FAN_NO_AUTH=1` для dev.
5. **SessionAdapter pattern.** Интерфейс полностью отвязывает HTTP-сервер от coding-agent.
6. **Детерминированная сборка.** Порядок пакетов в build pipeline отражает граф зависимостей.

---

*Источник: code-research по ARCHITECTURE.md, package.json, packages/ · Интерактивная версия: [index.html](./index.html)*
