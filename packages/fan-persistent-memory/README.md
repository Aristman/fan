# fan-persistent-memory

Persistent memory extension for [FAN](https://github.com/itone/fan-mono) coding agent with hybrid RAG retrieval.

## Features

- **Hybrid RAG Search** — FTS5 full-text + semantic vector search + composite scoring (recency, frequency, confidence)
- **Ollama Embeddings** — Semantic search via local Ollama server (nomic-embed-text, 768d)
- **HNSW ANN Index** — In-memory approximate nearest neighbor index for fast vector search at scale
- **Auto-Extraction** — Passive learning from dialogue: heuristic extraction of preferences, decisions, instructions
- **Maintenance Pipeline** — Confidence decay, deduplication, clustering, embedding migration, archive cleanup
- **Russian + English** — Stemming, stop words, and synonym expansion for both languages
- **Incremental RAG** — Topic-shift detection to avoid redundant retrieval calls within a conversation
- **Project + Global Scope** — Separate databases per project and user-global memories
- **Bun Native** — Uses `bun:sqlite` (zero native dependencies, no compilation needed)
- **Zero Runtime Deps** — No npm dependencies to install, pure Bun runtime

## Install

```bash
# Local install (extract archive to global node_modules)
tar xzf fan-persistent-memory-2.0.0.tar.gz -C ~/.nvm/versions/node/<version>/lib/node_modules/

# Then add to ~/.fan/agent/settings.json:
# { "packages": ["/absolute/path/to/fan-persistent-memory"] }
```

## Requirements

- FAN runtime (Bun-based)
- **Optional:** [Ollama](https://ollama.com) for semantic search
  ```bash
  ollama serve
  ollama pull nomic-embed-text
  ```

Without Ollama, the extension works in FTS-only mode (keyword search still works).

## Tools

| Tool | Description |
|------|-------------|
| `memory_remember` | Save information to persistent memory |
| `memory_search` | Hybrid search (FTS5 + semantic + scoring) |
| `memory_update` | Update an existing memory entry |
| `memory_forget` | Archive (soft-delete) a memory |
| `memory_promote` | Move project memory → global |
| `memory_demote` | Move global memory → project |

## Commands

| Command | Description |
|---------|-------------|
| `/memory help` | Show available commands |
| `/memory stats` | Memory statistics |
| `/memory list` | List active memories |
| `/memory search <query>` | Search memories |
| `/memory show <id>` | Show memory details |
| `/memory archive <id>` | Archive a memory |
| `/memory restore <id>` | Restore archived memory |
| `/memory review` | Review auto-extracted drafts |
| `/memory-maintain` | Run maintenance pipeline |

## Configuration

Config is stored at `~/.fan/agent/memory/config.json` and created automatically on first run.

```json
{
  "embeddings": {
    "provider": "ollama",
    "ollama": {
      "model": "nomic-embed-text",
      "baseUrl": "http://localhost:11434",
      "dimension": 768
    }
  }
}
```

## Architecture

```
src/
├── index.ts              # Extension entry point
├── config.ts             # Configuration loader
├── types.ts              # Type definitions + embedding helpers
├── storage/
│   ├── database.ts       # SQLite schema + migrations (bun:sqlite)
│   └── repositories.ts   # CRUD operations (Memory, Draft, Cluster)
├── rag/
│   ├── retriever.ts      # RAG orchestrator (FTS + vector + scoring)
│   ├── embeddings.ts     # Embedding router (Ollama + LRU cache)
│   ├── fts-engine.ts     # FTS5 search with stemming + expansion
│   ├── vector-store.ts   # Vector search (ANN + brute-force fallback)
│   ├── ann-index.ts      # HNSW in-memory index
│   ├── expander.ts       # Synonym dictionary (RU + EN)
│   ├── stemmer.ts        # Snowball-lite stemmer (RU + EN)
│   ├── reranker.ts       # LLM re-ranking via Ollama
│   └── migration.ts      # Embedding model migration
├── intelligence/
│   └── auto-extract.ts   # Passive dialogue learning
├── maintenance/
│   └── pipeline.ts       # Maintenance pipeline
├── tools/
│   └── memory-tools.ts   # Tool registration
└── commands/
    └── memory.ts         # /memory slash command
```

## Status Bar

- `🧠 Memory: active (Ollama)` — Ollama embeddings working
- `🧠 Memory: FTS-only` — No Ollama available (FTS5 still works)

## Memory Categories

| Category | Description |
|----------|-------------|
| `operator` | Facts about the user |
| `preference` | User preferences and habits |
| `project` | Project-specific knowledge |
| `event` | Notable events |
| `instruction` | Rules and instructions |
| `decision` | Architecture and design decisions |
