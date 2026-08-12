// Default MISSION.md template for fan-mission init.
// Fields {{slug}}, {{mission_id}}, {{now}} are replaced at init time.

export const MISSION_MD = `---
mission_id: {{mission_id}}
created: {{now}}
status: active
metric_type: test_pass_rate
metric_command: npm test
budget_tokens: 500000
budget_usd: 10.00
max_depth: 4
max_width: 4
---

# Mission: {{slug}}

## Goal

## Scope

## Unbreakable Metric

## Constraints
`;
