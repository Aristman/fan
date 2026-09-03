# Development Plan: security-worker

> **Инициализирован:** 2026-08-31
> **Ветка:** FAN/feature/new-worker-security-guard
> **Roadmap (источник истины):** docs/features/security-worker/roadmap.md
> **Спека:** docs/specs/spec_security-worker_2026-08-31.md (v1.1)
> **Стратегия коммитов:** per-function (`feat(phase-N/F-X.Y): <summary>`)
> **TDD:** Red → Green → Verify → Refactor (при зелёных тестах) → Commit

## Фазы

### Phase 0 — Динамические списки агентных типов
- **Цель:** WORKER_TYPES / AGENT_TYPES / agentTypes читаются из getAgentTypes() реестра
- **Функции:** F-0.1
- **Критерии:** тест «фиктивный агент из реестра появляется во всех трёх источниках»; /orchestrator models показывает те же 8 built-in типов; npm run build зелёный

### Phase 1 — Agent type `security` в fan-orchestrator
- **Цель:** координатор делегирует security-задачи воркеру security, человек видит его в /agents
- **Функции:** F-1.1 (определение+методология), F-1.2 (регистрация), F-1.3 (routing fix), F-1.4 (граница verify)
- **Критерии:** vitest: реестр содержит security (readOnly, tools), classify('security...') → security, 6 эталонных маршрутов не сломаны

### Phase 2 — Extension `fan-security`
- **Цель:** самостоятельный пакет: 3 CLI-сканера (JSON+text), гибрид gitleaks/semgrep, /security-scan, SKILL.md, упаковка FAN Store
- **Функции:** F-2.1 (схема отчёта) → F-2.2/F-2.3/F-2.4 (сканеры) → F-2.5 (гибрид), F-2.6 (/security-scan), F-2.7 (SKILL.md) → F-2.8 (упаковка)
- **Критерии:** fixture-сканы дают корректные exit-codes и валидный JSON по схеме §6.1 спеки, секреты маскируются

### Phase 3 — Финал
- Полная верификация (verify), smoke (fixtures + extension load), docs (roadmap-статусы, CHANGELOG, README)

## Контрольные точки
- Reporting: только в конце (решение оператора, CP#1)
- Вопросы координатору: только при verify FAIL с исчерпанными попытками (max 3)
- Phase-gate: запускается технически на границах, без вопроса пользователю (final-only)
