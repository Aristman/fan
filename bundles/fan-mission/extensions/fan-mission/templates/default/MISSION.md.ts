// Default MISSION.md template for fan-mission init.
// Fields {{slug}}, {{mission_id}}, {{now}}, {{description}} are replaced at
// init time ({{description}} → operator-provided mission Goal; empty string
// when init runs without a description — backward compatible).
//
// budget_tokens/budget_usd — ИНФОРМАЦИОННЫЕ поля (обязательные по схеме
// frontmatter, backward compat): L0 (главный процесс миссии) бюджетом НЕ
// ограничен. Лимит дочерних узлов — конфиг fan-super-orchestrator
// (childBudgetTokens, default 1_000_000).
//
// runagent_timeout_min УСТАРЕЛ и удалён из шаблона: per-step таймаут runAgent
// убран (ключ в старых MISSION.md игнорируется — см. README fan-mission).

export const MISSION_MD = `---
mission_id: {{mission_id}}
created: {{now}}
status: active
metric_type: test_pass_rate
metric_command: npm test
# Информационные поля: L0 бюджетом не ограничен; лимит детей — childBudgetTokens (fan-super-orchestrator)
budget_tokens: 500000
budget_usd: 10.00
max_depth: 4
max_width: 4
session_mode: fresh
---

# Mission: {{slug}}

## Goal
{{description}}

## Scope

## Unbreakable Metric

## Constraints
- Keep ROADMAP items atomic: one focused change per item, completable and verifiable in a single iteration (~20–30 minutes each).
`;
