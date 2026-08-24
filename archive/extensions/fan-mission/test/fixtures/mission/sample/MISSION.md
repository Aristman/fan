---
mission_id: mission-fixture-001
created: 2026-08-10T10:00:00.000Z
status: active
metric_type: test_pass_rate
metric_command: npm test
budget_tokens: 500000
budget_usd: 10.00
max_depth: 4
max_width: 4
---

# Mission: sample

## Goal

Verify that integration test fixtures can be parsed by file-state-manager.

## Scope

Read all 5 mission files via `readState`, `readMission`, `readRoadmap`,
`readBacklog`, `readDecisions`. Each file should produce structured data
without throwing.

## Unbreakable Metric

Fixtures are valid → `readState` returns `{done, blockers, nextSteps}` arrays
that match the expected literals.

## Constraints