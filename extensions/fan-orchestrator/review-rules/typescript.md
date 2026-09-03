---
stack: typescript
version: 1.0
---

# Review Rules: TypeScript / JavaScript

## Stack Detection Hints

Manifests: `package.json`; TypeScript confirmed by `tsconfig.json` (check `strict: true`) or devDependency `typescript`.
File extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`.
Tooling: ESLint, Prettier, tsc, Vitest/Jest, pnpm/npm/yarn/bun workspaces.

## Reviewer Checklist

1. No `any` without a justified escape; prefer `unknown` plus narrowing at the boundary.
2. Every promise is awaited or explicitly voided (`void expr`); no floating promises in loops.
3. `catch` handles the error — rethrow, wrap, or log; never an empty catch block.
4. Strict null checks respected: no `!` non-null assertion without a proven invariant.
5. External data (HTTP, env, files) validated at the boundary (zod/valibot), never cast with `as`.
6. Independent async calls run via `Promise.all`/`allSettled`, not sequential awaits in a loop.
7. Listeners, intervals, subscriptions removed on teardown (`off`, `clearInterval`, effect cleanup).
8. `===` instead of `==`; `const` by default; no implicit globals.
9. No mutation of shared inputs/params (arrays, objects, function arguments) — copy or use readonly types.
10. Thrown values are `Error` instances with messages, not strings or bare objects.
11. `AbortSignal`/`AbortController` honored for cancellation of fetches, timers, and streams.
12. Exported public functions carry explicit return types; no inferred `any` leakage in `.d.ts`.
13. Money and precision: no float equality; integers in minor units; `BigInt` where required.
14. Streams/backpressure: large reads consumed chunked, not buffered whole into memory.
15. No new runtime dependency without justification (size, maintenance, license).

## Typical Severity Examples

- CRITICAL: unvalidated `req.body` interpolated into SQL or a shell command.
- MAJOR: `async` handler returns before its awaited fetch completes; listener leak in `useEffect` without cleanup.
- MINOR: `console.log` left in committed code; `let` never reassigned.
- INFO: type/import style inconsistent with the rest of the project.

Severity → verdict mapping: see common.md.
