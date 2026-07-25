# Documentation Manifest
> Last updated: 2026-07-29
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
| `CHANGELOG.md` | ✅ | FAN changelog (0.2.0 → MCP Integration 2026-07-16) |
| `docs/guides/quick-start.md` | ✅ | Quick start stub — redirects to QUICK-START.md |
| `docs/guides/configuration.md` | ✅ | Full settings reference |
| `docs/guides/orchestrator.md` | ✅ | Orchestrator user guide (v7.10.0: `/orchestrator models`, named presets, permission approval, slot pools, Pipeline Mode v3.1.0) |
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
| `docs/specs/spec_fan-network-agent_2026-07-25.md` | ✅ | Родительская спецификация пакета «FAN Network Agent» (фазы 0–5) |
| `docs/specs/spec_fan-network-agent_phase0-network-contour_2026-07-25.md` | ✅ | Фаза 0 — Сетевой контур (TLS, auth, Docker, nginx) |
| `docs/specs/spec_fan-network-agent_phase1-workspace-api_2026-07-25.md` | ✅ | Фаза 1 — Workspace-aware API (Prisma cwd, project endpoints, whitelist validation) |
| `docs/specs/spec_fan-network-agent_phase2-workspace-ux_2026-07-25.md` | ✅ | Фаза 2 — Workspace UX (Service Registry, queue, dashboard switcher) |
| `docs/specs/spec_fan-network-agent_phase3-universal-tasks_2026-07-25.md` | ✅ | Фаза 3 — Универсальные задачи (type templates, prompts, non-code scenarios) |
| `docs/specs/spec_fan-network-agent_phase4-autonomy_2026-07-25.md` | ✅ | Фаза 4 — Автономность (scheduler, git/PR policy, budget caps) |
| `docs/specs/spec_fan-network-agent_phase5-concurrency_2026-07-25.md` | ✅ | Фаза 5 — Конкурентность (опционально, chdir removal, persistent queue) |
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
| `extensions/fan-orchestrator/README.md` | ✅ | FAN Orchestrator v7.10.0 — `/orchestrator models`, named presets, multi-provider lists, permission approval, broker-handler |

## Roadmaps & Research
| File | Status | Description |
|------|--------|-------------|
| `docs/roadmaps/orchestrator-ui-upgrade.md` | ✅ | Orchestrator UI upgrade roadmap |
| `docs/roadmaps/roadmap-idea-plugin-v2-unified.md` | ✅ | IDEA plugin v2 unified roadmap (current) |
| `docs/roadmaps/roadmap-idea-plugin-v2-from-orf.md` | ⚠️ | IDEA plugin v2 1st edition (superseded) |
| `docs/roadmaps/roadmap-idea-plugin-v2-from-orf-ed2.md` | ⚠️ | IDEA plugin v2 2nd edition (superseded) |
| `docs/features/phase0-network-contour/roadmap.md` | ✅ | TDD roadmap: фаза 0 — Сетевой контур (TLS/auth/Docker/nginx), 11 фич, 4 этапа + 1 E2E |
| `docs/features/phase1-workspace-api/roadmap.md` | ✅ | TDD roadmap: фаза 1 — Workspace-aware API (cwd/project/whitelist), 14 фич, 6 этапов + 1 E2E |
| `docs/features/phase2-workspace-ux/roadmap.md` | ✅ | TDD roadmap: фаза 2 — Workspace UX (Service Registry/queue/dashboard switcher), 15 фич, 5 этапов + 1 E2E |
| `docs/features/phase3-universal-tasks/roadmap.md` | ✅ | TDD roadmap: фаза 3 — Universal Tasks (templates/detection/prompts/skills), 12 фич, 4 этапа + 2 E2E |
| `docs/features/phase4-autonomy/roadmap.md` | ✅ | TDD roadmap: фаза 4 — Автономность (scheduler/git-PR/budget caps), 16 фич, 6 этапов + 1 E2E |
| `docs/features/phase5-concurrency/roadmap.md` | ✅ | ⚠️ Опциональная фаза: конкурентность (chdir removal/persistent queue/per-project tokens), 8 фич, 5 этапов + 1 E2E |
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

## Backlogs
| File | Status | Description |
|------|--------|-------------|
| `docs/backlogs/package-fork-backlog.md` | ✅ | Fork backlog @mariozechner/* → @seaagents/* |
| `docs/backlogs/setup-wizard-backlog.md` | ✅ | fan init setup wizard backlog |

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
| `skills/feature-roadmap/` | ✅ | TDD roadmap generator |
| `skills/idea-lab/` | ✅ | Idea research (technical/business/creative) |
| `skills/repo-explorer/` | ✅ | Git repo analysis (GitHub & local) |
| `skills/research-spec-generator/` | ✅ | Research + specification generation |

## Status Legend
- ✅ — Up to date
- ⚠️ — Needs update / superseded
- ❌ — Missing

---

## Missing Docs (To Do) — *(resolved)*

All 5 package READMEs have been created — status updated to ✅.

Total: **58 tracked documents** (56 ✅, 6 ⚠️, 0 ❌)

*TDD roadmaps (phase 0, 1, 2, 3) — 2026-07-25*
*Новые roadmaps:* `phase2-workspace-ux` (15 фич, 5 этапов, 1 E2E), `phase3-universal-tasks` (12 фич, 4 этапа, 2 E2E)
*Новые roadmaps:* `phase4-autonomy` (16 фич, 6 этапов, 1 E2E), `phase5-concurrency` (8 фич, 5 этапов, 1 E2E, опциональная фаза)

### Новый пакет спецификаций (2026-07-25)
| Документ | Статус |
|----------|--------|
| `spec_fan-network-agent_2026-07-25.md` + 6 дочерних | Родительская + фазы 0–5 пакета «FAN Network Agent» |
| Исходные материалы в `docs/research/idea-lab/fan-remote-vps/` | v1 и v2 исследования идеи |
| Code research отчёт `.fan/reports/research-fan-workspace-mode.md` | Аудит workspace-модели |
| Server audit `.fan/reports/explore-fan-server-vps-audit.md` | Аудит server mode для VPS |
