# Documentation Manifest
> Last updated: 2026-04-23

## User-Facing Documentation

| File | Status | Description |
|------|--------|-------------|
| `CLAUDE.md` | ✅ | Quick context for LLM sessions, orchestrator rules, CLI commands, test instructions, available skills |
| `ARCHITECTURE.md` | ✅ | Comprehensive architecture reference, packages, data flow, API, DB schema, skills catalog |
| `INSTALL.md` | ✅ | Installation guide (Windows/Linux/macOS) |
| `CONTRIBUTING.md` | ✅ | Contribution guide |
| `MIGRATION.md` | ✅ | Migration from upstream fan/pi |
| `docs/guides/orchestrator.md` | ✅ | Orchestrator v2 guide — tools, agent types, workflows, configuration |
| `docs/guides/dashboard.md` | ✅ | Dashboard client guide |
| `docs/guides/configuration.md` | ✅ | Settings reference (includes pre-installed skills note) |
| `docs/guides/api-reference.md` | ✅ | API documentation |
| `README.md` | ✅ | Project overview — features, quick start, CLI, orchestrator, skills, architecture, development |
| `.env.example` | ✅ | Environment variable template |

## AI/Developer Documentation

| File | Status | Description |
|------|--------|-------------|
| `packages/orchestrator/README.md` | ✅ | Orchestrator package overview — v2 features, configuration, installation |
| `skills/*/SKILL.md` (11 skills) | ✅ | Skill specifications — ask-answer, auto-tests, bug-fix, code-research, deep-dive, fan-forge, idea-lab, repo-explorer, research-spec-generator, skill-improver, smoke-tester |
| `docs/specs/spec_runtime-agent_2026-04-10.md` | ✅ | Current runtime-agent specification |
| `docs/specs/MVP-SPEC.md` | ✅ | Archived (superseded web SaaS concept) |
| `docs/develop/tests/dashboard-phase6.md` | ⚠️ | Dashboard test report (26/30 passed) — may need update after changes |
| `docs/develop/tests/orchestrator-phase4.md` | ⚠️ | Orchestrator v1 test report — references old tools (delegate_task, /tasks, /agents, /delegate) |
| `docs/develop/tests/orchestrator-phase5.md` | ⚠️ | Orchestrator v1 test report — references old tools and modes |
| `docs/orchestrator-comparison.md` | ⚠️ | Upstream vs FAN comparison — references removed v1 features (classify_task, chain, /agents, /delegate) |
| `docs/roadmaps/orchestrator-ui-upgrade.md` | ⚠️ | Roadmap — references old v1 API (delegate_task) |
| `docs/backlogs/package-fork-backlog.md` | ✅ | Package fork backlog |
| `docs/backlogs/setup-wizard-backlog.md` | ✅ | Setup wizard backlog |
| `docs/pi-changelogs/pi-changelog-0.68.0.md` | ✅ | Upstream pi changelog (historical) |

## Status Legend
- ✅ — up to date
- ⚠️ — needs update (references orchestrator v1 API)
- ❌ — missing
