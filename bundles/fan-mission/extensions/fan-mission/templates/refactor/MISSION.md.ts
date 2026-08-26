// Refactor MISSION.md template — tailored for code refactoring missions.
// Fields {{slug}}, {{mission_id}}, {{now}} are replaced at init time.
//
// budget_tokens/budget_usd — ИНФОРМАЦИОННЫЕ поля (обязательные по схеме
// frontmatter, backward compat): L0 бюджетом НЕ ограничен. Лимит дочерних
// узлов — конфиг fan-super-orchestrator (childBudgetTokens, default 1_000_000).
//
// runagent_timeout_min — per-mission таймаут одного запуска runAgent (минуты).
// Диапазон: 1–480, дефолт: 30 (когда поле отсутствует или невалидно).
// Поле читается regex'ом из сырого MISSION.md при attach (index.ts).

export const MISSION_MD = `---
mission_id: {{mission_id}}
created: {{now}}
status: active
metric_type: code_complexity_reduction
metric_command: npx complexity-report --format json
# Информационные поля: L0 бюджетом не ограничен; лимит детей — childBudgetTokens (fan-super-orchestrator)
budget_tokens: 300000
budget_usd: 5.00
runagent_timeout_min: 30
max_depth: 3
max_width: 3
session_mode: fresh
template: refactor
---

# Refactor Mission: {{slug}}

## Goal
Reduce code complexity and improve maintainability.

## Scope
Refactoring only — no new features, no behaviour changes.

## Unbreakable Metric
All existing tests must continue to pass (green-to-green).

## Constraints
- No public API changes without explicit approval.
- Each refactoring step must be atomic and reversible.
`;
