# Documentation Manifest
> Last updated: 2026-08-24 (bundle fan-mission 1.0.0 testing docs added)
> Comprehensive index of all project documentation.
> Maintainer: docs-impl agent

## User-Facing Documentation
| File | Status | Description |
|------|--------|-------------|
| `README.md` | ✅ | Project overview, key features, quick start |
| `QUICK-START.md` | ✅ | Быстрый старт (русский) |
| `INSTALL.md` | ✅ | Detailed installation guide (Windows/Linux/macOS) |
| `SETUP.md` | ✅ | Полное руководство по настройке |
| `MIGRATION.md` | ✅ | Migration from upstream fan/pi |
| `CONTRIBUTING.md` | ✅ | Contribution guidelines |
| `CHANGELOG.md` | ✅ | FAN changelog — [Unreleased]: сверх-оркестратор этапы 0+1; релизы 0.2.0 → 2.5.1 |
| `docs/guides/quick-start.md` | ✅ | Quick start stub — redirects to QUICK-START.md |
| `docs/guides/configuration.md` | ✅ | Full settings reference |
| `docs/guides/orchestrator.md` | ✅ | Orchestrator user guide (v7.10.0: `/orchestrator models`, named presets, permission approval, slot pools, Pipeline Mode v3.1.0) |
| `docs/guides/missions.md` | ✅ | Mission guide: миссионный контур, EPIC-делегирование, дерево узлов, бюджеты, наблюдаемость, troubleshooting |
| `docs/guides/examples/mission-refactor.md` | ✅ | Пример миссии рефакторинга с EPIC-делегированием |
| `docs/guides/examples/mission-tree-hierarchy.md` | ✅ | Пример иерархии дерева L0 → 3×L1 с манифестами |
| `docs/guides/dashboard.md` | ✅ | Dashboard user guide |
| `docs/guides/api-reference.md` | ✅ | REST API + WebSocket protocol reference |
| `docs/guides/mcp.md` | ✅ | MCP integration guide (Russian) — transports, config, OAuth, Worker Proxy, security |
| `docs/mcp.md` | ✅ | MCP in FAN — comprehensive English reference (TOC, config, widget, commands, filtering, examples, troubleshooting, architecture, security) |
| `docs/mcp.ru.md` | ✅ | MCP в FAN — полный русский перевод (содержание, конфигурация, виджет, команды, фильтрация, примеры, решение проблем, архитектура, безопасность) |
| `packages/mcp-extension/README.md` | ✅ | @fan/mcp-extension — MCP client extension (241 tests, Phases 1–3) |

## Architecture & Specifications
| File | Status | Description |
|------|--------|-------------|
| `ARCHITECTURE.md` | ✅ | System architecture, packages, data flow |
| `CLAUDE.md` | ✅ | AI assistant context for LLM sessions |
| `docs/specs/spec_runtime-agent_2026-04-10.md` | ✅ | Current runtime-agent specification |
| `docs/specs/spec_idea-plugin-integration_2026-04-24.md` | ✅ | IntelliJ Platform Plugin integration |
| `docs/specs/spec_idea-plugin-tui-styling_2026-04-24.md` | ✅ | IDEA Plugin JCEF chat rendering in TUI style |
| `docs/specs/spec_filin-lightllm-provider_2026-04-27.md` | ✅ | Filin-LightLLM provider specification |
| `docs/specs/spec_feature-roadmap_2026-05-28.md` | ✅ | Feature-roadmap skill specification |
| `docs/specs/spec_feature-pipeline_2026-05-29.md` | ✅ | Feature-pipeline skill specification |
| `docs/specs/migrate-store-url-2026-05-11.md` | ✅ | FAN Store server URL migration spec |
| `docs/specs/MVP-SPEC.md` | ⚠️ | Archived (superseded by runtime-agent spec, web SaaS concept) |
| `docs/orchestrator-comparison.md` | ⚠️ | Pi Sample vs FAN Copy comparison — содержит удалённые фичи (parallel/chain), исправлено частично |

## Release & Process
| File | Status | Description |
|------|--------|-------------|
| `docs/RELEASE.md` | ✅ | Release process FAN 1.0.0+ (independent versioning) |
| `docs/pi-changelogs/pi-changelog-0.68.0.md` | ✅ | Upstream pi 0.68.0 changelog (reference) |

## Package Documentation
| File | Status | Description |
|------|--------|-------------|
| `packages/ai/README.md` | ✅ | @seaagents/fan-ai — Unified LLM API |
| `packages/agent/README.md` | ✅ | @seaagents/fan-agent-core — Stateful agent |
| `packages/coding-agent/README.md` | ✅ | @seaagents/fan-coding-agent — CLI & Runtime |
| `packages/coding-agent/docs/models.md` | ✅ | Custom models configuration guide (providers, envVar, auth resolution) |
| `packages/coding-agent/docs/` (other) | ✅ | Extensions, RPC, SDK, TUI, etc. (22 files) |
| `packages/tui/README.md` | ✅ | @seaagents/fan-tui — Terminal UI framework |
| `packages/web-ui/README.md` | ✅ | @seaagents/fan-web-ui — Web components |
| `packages/api-gateway/README.md` | ✅ | @fan/api-gateway — HTTP/WS server |
| `packages/db/README.md` | ✅ | @fan/db — Prisma + SQLite |
| `packages/model-manager/README.md` | ✅ | @fan/model-manager — Model routing & budget |
| `packages/store/README.md` | ✅ | @fan/store — Package manager |
| `packages/dashboard/README.md` | ✅ | @fan/dashboard — Web UI |
| `tools/fan-store-server/GUIDE.md` | ✅ | FAN Store server guide |
| `extensions/fan-orchestrator/README.md` | ✅ | FAN Orchestrator v7.10.0 — `/orchestrator models`, named presets, multi-provider lists, permission approval, broker-handler; + task list persistence (F-48: `TaskManager` serialize/deserialize via session JSONL, доска переживает рестарт) |
| `extensions/fan-mission/` | ✅ | Mission loop extension (F-08..F-22) — file-state-manager, mission-loop, slash-commands, mission-widget, templates/{default,refactor}; + promise-parser, verification-ladder/config, idea-generator, idea-scorer, metrics-collector |
| `extensions/fan-scheduler/` | ✅ | Cron tick scheduler (F-13) — 5-field cron со строгой валидацией, I4 тики |
| `extensions/fan-webhook/` | ✅ | Hono webhook server (F-14) — steer/followUp dispatch на порту 9090 |

## Roadmaps & Research
| File | Status | Description |
|------|--------|-------------|
| `docs/roadmaps/orchestrator-ui-upgrade.md` | ✅ | Orchestrator UI upgrade roadmap |
| `docs/roadmaps/roadmap-idea-plugin-v2-unified.md` | ✅ | IDEA plugin v2 unified roadmap (current) |
| `docs/roadmaps/roadmap-idea-plugin-v2-from-orf.md` | ⚠️ | IDEA plugin v2 1st edition (superseded) |
| `docs/roadmaps/roadmap-idea-plugin-v2-from-orf-ed2.md` | ⚠️ | IDEA plugin v2 2nd edition (superseded) |
| `docs/research/orchestrator-v4.1-analysis.md` | ✅ | Orchestrator v4.1.0 architecture analysis |
| `docs/research/idea-lab/confluence-extension/` | ✅ | fan-confluence extension research (русский) |
| `docs/research/idea-lab/loop-extension/` | ✅ | fan-loop extension research (русский) |
| `docs/features/fan-confluence/` | ✅ | fan-confluence extension package (6 files, 4 stages) |

## Test Reports
| File | Status | Description |
|------|--------|-------------|
| `docs/develop/tests/orchestrator-phase4.md` | ✅ | Orchestrator Phase 4 (18 ✅) |
| `docs/develop/tests/orchestrator-phase5.md` | ✅ | Orchestrator Phase 5 — Hardening |
| `docs/develop/tests/dashboard-phase6.md` | ✅ | Dashboard Phase 6 (26/30 ✅) |
| `docs/features/super-orchestrator/pipeline-report.md` | ✅ | Pipeline отчёт сверх-оркестратора FAN — все 4 этапа завершены (48/48 + F-48.5, phase-gates A3/B3/C3 PASS, 716 тестов super-orch, точка: бэклог/мерж/релиз) |
| `docs/features/super-orchestrator/mission-loop-0/roadmap.md` | ✅ | Этап 0 roadmap — все 15 фич ✅, добавлена секция «Этап 0 завершён» (2026-08-12) |
| `docs/features/super-orchestrator/mission-validation-1/roadmap.md` | ✅ | Этап 1 roadmap — все 8 фич (F-16..F-22, F-48) ✅, добавлена секция «Этап 1 завершён» (2026-08-13) |
| `docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md` | ✅ | Этап 3 roadmap — все 12 фич (F-36..F-47) ✅, + F-48.5 EPIC-делегирование (2026-08-15) |
| `extensions/fan-super-orchestrator/README.md` | ✅ | Этап 3 ✅: 17 модулей, 716 тестов, EPIC-делегирование, phase-gates A3/B3/C3 |
| `docs/features/super-orchestrator-v2/architecture.md` | ✅ | Depth-4 архитектура: 15 секций, port allocation (§12), transport pre-requisite (§13), diagnostics (§14), fail-fast (§15), Phase 0 gate |

## Backlogs
| File | Status | Description |
|------|--------|-------------|
| `docs/backlogs/package-fork-backlog.md` | ✅ | Fork backlog @mariozechner/* → @seaagents/* |
| `docs/backlogs/setup-wizard-backlog.md` | ✅ | fan init setup wizard backlog |
| `docs/backlogs/tasklist-persistence-backlog.md` | ✅ | TaskList persistence (P1..P3) — ✅ реализовано F-48 (коммит `db133a2`, этап 1 `mission-validation-1`); открытый follow-up: compaction survival custom entries |

## Skills (11 встроенных)
| File | Status | Description |
|------|--------|-------------|
| `skills/auto-tests/` | ✅ | Autonomous test generation (8 languages) |
| `skills/bug-fix/` | ✅ | Autonomous bug-fix agent |
| `skills/code-research/` | ✅ | READ-ONLY deep code analysis |
| `skills/deep-dive/` | ✅ | Deep-dive analysis |
| `skills/dev-docs-pack/` | ✅ | Documentation pack generator |
| `skills/fan-forge/` | ✅ | Extension & skill factory |
| `skills/feature-pipeline/` | ✅ | TDD feature development pipeline |
| `skills/feature-roadmap/` | ✅ | TDD roadmap generator (v1.3.0: RGR TDD, e2e/smoke, references/) |
| `skills/idea-lab/` | ✅ | Idea research (technical/business/creative) |
| `skills/repo-explorer/` | ✅ | Git repo analysis (GitHub & local) |
| `skills/research-spec-generator/` | ✅ | Research + specification generation |

## Testing Documentation
| File | Status | Description |
|------|--------|-------------|
| `docs/testing/manual-bundle-test-scenario.md` | ✅ | Ручной сценарий полного прогона bundle fan-mission 1.0.0 (EPIC-delegation, spawn, HTTP delegate, диагностика 4-сек смерти) |
| `docs/testing/automated-test-proposal.md` | ✅ | Предложение по автоматизированному тестированию миссий + super-orchestrator (5 уровней: L1-L5, приоритеты, инфраструктура) |

## Status Legend
- ✅ — Up to date
- ⚠️ — Needs update / superseded
- ❌ — Missing

---

## Missing Docs (To Do) — *(resolved)*

All 5 package READMEs have been created — status updated to ✅.

Total: **64 tracked documents** (60 ✅, 4 ⚠️, 0 ❌)
