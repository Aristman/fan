---
stack: common
version: 1.0
---

# Review Rules: Common (cross-stack)

Universal rules for the code-review worker. Loaded first, before any stack file.

## Severity Model

Every finding carries exactly one severity.

Severity: CRITICAL — data loss, security hole, crash, or broken build. The change must not ship.
Example: SQL injection via string concatenation; unhandled rejection that kills the process; deleted migration.

Severity: MAJOR — a bug users will hit, a broken contract, or a real performance/resource problem. Must be fixed before merge.
Example: off-by-one in pagination; N+1 query in a hot loop; missing await on a result that is then used.

Severity: MINOR — maintainability issue with no behavioral impact. Fix now or file a follow-up.
Example: duplicated 10-line block; commented-out dead code; magic number without a named constant.

Severity: INFO — style, naming, or educational note. Never blocks merge.
Example: prefer `const` over `let`; import ordering; docstring typo.

## Severity → Verdict Mapping

- CRITICAL or MAJOR present → CHANGES_REQUESTED
- only MINOR/INFO present → APPROVED (with optional non-blocking notes)
- mixed/ambiguous case (MAJOR without a clear fix, architectural call needed, team disagreement) → NEEDS_DISCUSSION

Verdicts:
- APPROVED — diff is safe to merge.
- CHANGES_REQUESTED — blocking findings exist; list them first.
- NEEDS_DISCUSSION — explain the trade-off and formulate the open question.

## Cross-Stack Review Rules

Every finding needs: file:line, category, problem, concrete suggestion. Review the diff only. Verify error handling on every I/O boundary and input validation at public entry points. Flag resource leaks (files, connections, sockets, listeners). Check idempotency of retries and repeated calls. Reject dead code and duplication. Question magic numbers and unexplained complexity. Verify edge cases: empty, null, huge, concurrent. Security issues are never described in exploit detail — emit a security-note handoff to the user instead.

## Typical Cross-Stack Bugs

1. Async result ignored: unawaited promise, detached task, floating future.
2. Off-by-one in loops, slicing, and pagination boundaries.
3. Wrong null/None/Optional handling or float equality checks.
4. Check-then-act race on shared state without lock or atomic.
5. Swallowed errors: empty catch, error mapped to a success value.
