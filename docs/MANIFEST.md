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
| `CHANGELOG.md` | ✅ | FAN changelog (0.2.0 → [2.7.0] фаза 4 autonomy 2026-07-26) |
| `docs/guides/quick-start.md` | ✅ | Quick start stub — redirects to QUICK-START.md |
| `docs/guides/configuration.md` | ✅ | Full settings reference |
| `docs/guides/orchestrator.md` | ✅ | Orchestrator user guide (v7.10.0: `/orchestrator models`, named presets, permission approval, slot pools, Pipeline Mode v3.1.0) |
| `docs/guides/dashboard.md` | ✅ | Dashboard user guide (project switcher, workspace type icons, create project dialog, slash autocomplete, type editor, session tree, queue indicator) |
| `docs/guides/api-reference.md` | ✅ | REST API + WebSocket protocol reference (health readiness, project filter, GET /api/projects, cwd whitelist 403) |
| `docs/guides/scheduler.md` | ✅ | FAN Scheduler — полный гайд (фаза 4): архитектура, установка/compose (FAN_SCHEDULER_TOKEN), config.yaml справочник, budget per-task delta, control server, activity monitor, persistent queue, Git/PR политика, DB backup, troubleshooting, production checklist, backlog |
| `docs/guides/deployment.md` | ✅ | Деплой FAN на VPS: Docker, nginx + TLS, certbot, healthcheck, workspaces /data/repos (фаза 1) |
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

## Deployment (Phase 0 — Network Contour)
| File | Status | Description |
|------|--------|-------------|
| `Dockerfile` | ✅ | Мультистейдж сборка (slim runtime image) |
| `docker-compose.yml` | ✅ | Продакшен compose: сервисы `fan` + `fan-scheduler` (фаза 4), порт на loopback, volume `/data` |
| `.dockerignore` | ✅ | Исключения из build-контекста |
| `deploy/nginx/agent.sea-agents.ru.conf` | ✅ | nginx reverse proxy: TLS termination, WS upgrade → 127.0.0.1:3456 |
| `deploy/scripts/setup-tls.sh` | ✅ | Идемпотентный certbot setup-скрипт |
| `deploy/scripts/e2e-local.sh` | ✅ | Локальная E2E-проверка цепочки деплоя (build → health → auth → WS; секции 8–11: фазы 1–3; секция 12: фаза 4 scheduler, 103 проверки) |
| `deploy/scripts/backup-db.sh` | ✅ | Daily SQLite backup (sqlite3 .backup + cp-fallback, ротация 7, chmod 600/700) — F-4.15 |
| `deploy/scheduler/config.yaml` | ✅ | Default scheduler task config (read-only mount в fan-scheduler, override FAN_SCHEDULER_CONFIG) — F-4.16 |

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
| `tools/fan-scheduler/README.md` | ✅ | @fan/scheduler — autonomous cron-based task runner (persistent queue, chat interruption, budget per-task delta, control server) |
| `extensions/fan-orchestrator/README.md` | ✅ | FAN Orchestrator v7.10.0 — `/orchestrator models`, named presets, multi-provider lists, permission approval, broker-handler |

## Roadmaps & Research
| File | Status | Description |
|------|--------|-------------|
| `docs/roadmaps/orchestrator-ui-upgrade.md` | ✅ | Orchestrator UI upgrade roadmap |
| `docs/roadmaps/roadmap-idea-plugin-v2-unified.md` | ✅ | IDEA plugin v2 unified roadmap (current) |
| `docs/roadmaps/roadmap-idea-plugin-v2-from-orf.md` | ⚠️ | IDEA plugin v2 1st edition (superseded) |
| `docs/roadmaps/roadmap-idea-plugin-v2-from-orf-ed2.md` | ⚠️ | IDEA plugin v2 2nd edition (superseded) |
| `docs/features/phase0-network-contour/roadmap.md` | ✅ | TDD roadmap: фаза 0 — Сетевой контур (TLS/auth/Docker/nginx), 11 фич, 4 этапа + 1 E2E |
| `docs/features/phase0-network-contour/pipeline-report.md` | ✅ | Отчёт пайплайна фазы 0: 11 фич + fix, 10 коммитов (`684de18..006ef96`) |
| `docs/features/phase1-workspace-api/roadmap.md` | ✅ | TDD roadmap: фаза 1 — Workspace-aware API (cwd/project/whitelist), 14 фич ✅, 6 этапов + 1 E2E ✅ |
| `docs/features/phase1-workspace-api/pipeline-report.md` | ✅ | Отчёт пайплайна фазы 1: 14 фич + fix, 15 коммитов (`5b0b944..ee49635`) |
| `docs/features/phase2-workspace-ux/roadmap.md` | ✅ | TDD roadmap: фаза 2 — Workspace UX (Service Registry/queue/dashboard switcher), 15 фич ✅, 5 этапов + 1 E2E ✅ |
| `docs/features/phase2-workspace-ux/pipeline-report.md` | ✅ | Отчёт пайплайна фазы 2: 15 фич + 2 fix, 17 коммитов (`fba7f65..96bdbb0`) |
| `docs/features/phase3-universal-tasks/roadmap.md` | ✅ | TDD roadmap: фаза 3 — Universal Tasks (templates/detection/prompts/skills), 12 фич ✅, 4 этапа + 2 E2E ✅ |
| `docs/features/phase3-universal-tasks/pipeline-report.md` | ✅ | Отчёт пайплайна фазы 3: 12 фич + fix, 12 коммитов (`f29eb35..a1bbbd4`) |
| `docs/features/phase4-autonomy/roadmap.md` | ✅ | TDD roadmap: фаза 4 — Автономность (scheduler/git-PR/budget caps), 16 фич ✅, 6 этапов + 1 E2E ✅ (все TC-чекбоксы отмечены) |
| `docs/features/phase4-autonomy/pipeline-report.md` | ✅ | Отчёт пайплайна фазы 4: 16 фич + 2 fix, 18 коммитов (`f114f07..11f270b`); находки: F-4.15 backup security, F-4.16 PASS (103/103 ×2), финальная P1 budget per-task delta + 4 P2; backlog |
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

Total: **74 tracked documents** (68 ✅, 6 ⚠️, 0 ❌)

*Фаза 4 autonomy финализирована (2026-07-26):* pipeline-report.md заполнен (16 ✅, 18 коммитов `f114f07..11f270b`), roadmap — все 16 фич ✅ и все TDD-чекбоксы отмечены; scheduler.md дополнен до полного гайда (архитектура, compose/FAN_SCHEDULER_TOKEN, config.yaml справочник, budget per-task delta, control server, activity monitor, persistent queue, Git/PR, backup, troubleshooting, production checklist); обновлены api-reference.md (enforcement note → per-task delta; budget + scheduler/health уже были от F-4.9/F-4.14), deployment.md (секция 8.4 — fan-scheduler + backup cron, файлы §2, filin.db), README.md (autonomous tasks feature + docs-таблица + Docker-абзац), CHANGELOG.md [2.7.0]. Верификации: F-4.15 backup security (chmod 600/700), F-4.16 E2E PASS (103/103 ×2), финальная P1 budget delta + 4 P2. Backlog: gateway budget enforcement, in-flight abort, prompt-level branch policy, gh-client не в прод-пути, orphan pending-задачи

*Фаза 3 universal-tasks финализирована (2026-07-26):* pipeline-report.md заполнен (12 ✅, 12 коммитов `f29eb35..a1bbbd4`), roadmap — все 12 фич ✅ и все TDD-чекбоксы отмечены (синхронизирована рассинхронизация F-3.5/F-3.11); обновлены api-reference.md (POST /api/projects — полный контракт 201/200/400/403/501, name-валидация, таблица шаблонов; PUT уже был от F-3.10), dashboard.md (иконки типов, диалог создания, slash autocomplete, смена типа; кнопка «+» теперь открывает диалог), deployment.md (секция 8.3 — типы/шаблоны workspaces), CHANGELOG.md [2.6.0]. Backlog: ServiceRegistry/McpSwitcher/prompt-loader standalone (интеграция в runtime — будущая фаза), `.git` нюанс code-шаблона (fallback на имя шаблона), LLM-шаги E2E — manual чеклисты

*Фаза 2 workspace-ux финализирована (2026-07-26):* pipeline-report.md заполнен (15 ✅, 17 коммитов `fba7f65..96bdbb0`), roadmap — все 15 фич ✅ и все TDD-чекбоксы отмечены; обновлены api-reference.md (WS `sendMessage`, `queued`/`queue_full`, секция Message Queueing; GET/DELETE /api/projects уже были от F-2.13), dashboard.md (project switcher, tree grouping по cwd, queue indicator), deployment.md (секция 8.2 — очередь при busy), CHANGELOG.md [2.5.0]. Backlog: ServiceRegistry/McpSwitcher standalone (интеграция в runtime — следующая фаза), mutexes Map растёт неограниченно (documented)

*Фаза 1 workspace-api финализирована (2026-07-26):* pipeline-report.md заполнен (14 ✅, 15 коммитов `5b0b944..ee49635`), roadmap F-1.14-E2E ☐→✅ (все 14 фич ✅); обновлены api-reference.md (`?project=` фильтр, `cwd` в POST/ответах, DELETE 204/403, `GET /api/projects`, коды 400/403), configuration.md (`FAN_WORKSPACE_ROOT`), deployment.md (секция 8.1 workspaces + whitelist в security notes), README.md (multi-project в features и Docker), CHANGELOG.md [2.4.0]

*Фаза 0 network-contour финализирована (2026-07-25):* Dockerfile, docker-compose.yml, .dockerignore, deploy/nginx/, deploy/scripts/ (setup-tls.sh, e2e-local.sh), docs/guides/deployment.md, pipeline-report.md; обновлены README.md, configuration.md (env vars), api-reference.md (health readiness), CHANGELOG.md [2.3.6]

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
