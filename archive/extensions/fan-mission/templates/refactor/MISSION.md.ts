// Refactor MISSION.md template — tailored for code refactoring missions.
// Fields {{slug}}, {{mission_id}}, {{now}} are replaced at init time.

export const MISSION_MD = `---
mission_id: {{mission_id}}
created: {{now}}
status: active
metric_type: code_complexity_reduction
metric_command: npx complexity-report --format json
budget_tokens: 300000
budget_usd: 5.00
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
