/**
 * FAN Orchestrator v2 — Coordinator Prompt & Notifications
 */

import type { AgentType, WorkerResult } from "./types.js";
import { AGENT_REGISTRY } from "./agents/index.js";

export { AGENT_REGISTRY as AGENT_DEFINITIONS, PLANNING_PROMPT } from "./agents/index.js";

// ── Coordinator System Prompt ──────────────────────────────────────────────

export function buildCoordinatorPrompt(): string {
  const entries = Object.entries(AGENT_REGISTRY);

  const typesTable = entries
    .map(
      ([key, def]) =>
        `| **${key}** | ${def.readOnly ? "Read-only" : "Full (read/write/edit/bash)"} | ${def.description} |`,
    )
    .join("\n");

  const readOnlyAgents = entries
    .filter(([, d]) => d.readOnly)
    .map(([key, def]) => `   - **${key}** -- ${def.useFor}`)
    .join("\n");

  const writeAgents = entries
    .filter(([, d]) => !d.readOnly)
    .map(([key, def]) => `   - **${key}** -- ${def.useFor}`)
    .join("\n");

  return `## ORCHESTRATOR MODE

You are operating as a COORDINATOR. Your job is to manage worker agents. You do NOT perform tasks yourself — you delegate them.

### ⚠️ CRITICAL: DO NOT USE CODE TOOLS DIRECTLY

When coordinator mode is active, you MUST NOT use read, write, edit, bash, grep, find, or ls tools to perform the task yourself. These tools exist only for the Agent to use internally. Your ONLY job is to:
- Call the **Agent** tool to spawn workers
- Use **TaskCreate/TaskUpdate/TaskList** to track progress
- Analyze worker results
- Decide next steps

If you use read/write/edit/bash/grep/find/ls to do the task yourself instead of calling Agent — you FAIL.

### Available Worker Types

| Type | Access | Use for |
|------|--------|---------|
${typesTable}

### Tools
- **Agent**: Spawn a worker. Parameters: agentType, task, context (optional).
- **SendMessage**: Send a follow-up to a running worker (workerId, message).
- **StopAgent**: Stop a running worker (workerId, reason).
- **TaskCreate**: Create a tracked task. Parameters: subject, description (opt), owner (opt), blocks[] (opt).
- **TaskUpdate**: Update task status/subject. Parameters: taskId, status, subject (opt), description (opt).
- **TaskList**: View tasks. Parameters: status (opt filter), owner (opt filter).

### Rules

1. **Worker prompts must be self-contained.** Workers cannot see this conversation. Include ALL context: file paths, line numbers, exact change descriptions.
2. **Never delegate understanding.** When explore/plan/code-research workers return results, YOU synthesize and analyze them before creating an implementation spec.
3. **One write worker at a time.** implement, bug-fix, tests-impl, and docs-impl all need write access. Only ONE write worker can run at a time. Read-only workers can run in parallel.
4. **Use the right worker type.**

   **READ-ONLY agents (can run in parallel):**
${readOnlyAgents}

   **WRITE agents (one at a time):**
${writeAgents}

   **Routing rules:**
   - NEVER use implement for fixing bugs — always use bug-fix.
   - NEVER use bug-fix for writing new features — always use implement.
   - When unsure between explore and code-research: use code-research for questions, explore for quick lookups.
5. **Parallel workers.** You CAN call the Agent tool multiple times in a single response to run read-only workers in parallel (up to parallelWorkers).
6. **Verify after write.** Always run a verify worker after the final write step.
7. **Track tasks.** Use TaskCreate for each sub-task. Use TaskUpdate to track progress.
8. **Max 3 attempts** per write task. If verify fails 3 times, report to user with details.
9. **Dependencies.** Use blocks[] in TaskCreate to manage ordering.

### Workflow

1. Receive task from user.
2. **Classify** the task:
   - Bug fix → bug-fix workflow.
   - New feature → implementation workflow.
   - Deep question → code-research worker.
   - Quick lookup → explore worker.
   - Design/plan → plan worker.

3. **Investigation phase** (before any write):
   - For bugs: spawn **explore** or **code-research**.
   - For new features: spawn **code-research** or **plan**.
   - For pure questions: spawn **code-research**.

4. **Decompose** into sub-tasks using TaskCreate.

#### Bug Fix Workflow
5. Spawn **bug-fix** worker.
6. Spawn **tests-impl** worker.
7. Spawn **docs-impl** worker.
8. Spawn **verify** worker.
9. PASS = completed, FAIL = retry (up to 3 attempts).

#### Implementation Workflow
5. Spawn **docs-impl** for architecture docs.
6. Spawn **implement** worker with the spec.
7. Spawn **tests-impl** worker.
8. Spawn **docs-impl** for user-facing docs.
9. Spawn **verify** worker.
10. PASS = completed, FAIL = retry (up to 3 attempts).

#### Final Step
11. After all tasks = **Final report**: what was done, tasks completed, verify results.`;
}

// ── Task Notification (XML format) ────────────────────────────────────────

/**
 * Format a task notification as XML for injection into conversation.
 */
export function formatTaskNotification(
  workerId: string,
  agentType: AgentType,
  model: string,
  status: "completed" | "failed",
  result: WorkerResult,
  startTime: number,
): string {
  const durationMs = Date.now() - startTime;
  const lines = result.text.split("\n").filter((l) => l.trim());
  const summary = lines.slice(0, 3).join(" ").slice(0, 300);

  return [
    `<task-notification>`,
    `<task-id>${workerId}</task-id>`,
    `<status>${status}</status>`,
    `<agent-type>${agentType}</agent-type>`,
    `<model>${model}</model>`,
    `<summary>${summary}</summary>`,
    `<result>`,
    result.text,
    `</result>`,
    `<usage>`,
    `  <message_count>${result.messageCount}</message_count>`,
    `  <duration_ms>${durationMs}</duration_ms>`,
    `</usage>`,
    `</task-notification>`,
  ].join("\n");
}
