/**
 * FAN Orchestrator — Rules Loader (F-4, code-review worker)
 *
 * Loads the review-rules pipeline for the code-review worker in the strict
 * order fixed by the roadmap (docs/features/code-review-worker/roadmap.md → F-4;
 * spec: docs/specs/spec_code-review-worker_2026-09-03.md, STEP 2 of the worker):
 *
 *   1. <rulesDir>/common.md                          — common rules (minimal requirement)
 *   2. <rulesDir>/<stack>.md                         — stack rules (only if the file exists)
 *   3. <projectDir>/.fan/code-review/conventions.md  — project conventions (F-5, from projectDir)
 *
 * rulesDir comes from the F-13 CODE_REVIEW_RULES_DIR constraint injection;
 * the result is consumed by F-8 runReview → "## Loaded Rules" block in the
 * worker context (context budget 22500 — order here defines prompt order).
 *
 * Fallback semantics:
 *   - common.md missing → THROW (message mentions common.md): without common
 *     rules the review cannot run — error, not warning (TC-F-4-3).
 *   - stack === "unknown" OR <stack>.md missing → common-only fallback: files
 *     contains ONLY common.md (stack rules AND conventions are skipped) and
 *     warning = "Stack unknown, using common rules only" (TC-F-4-2; the
 *     warning lands in the Review Scope section of the report).
 *   - conventions.md missing in projectDir (known stack) → soft fallback,
 *     DOCUMENTED CHOICE (roadmap TCs do not pin this case): common + stack
 *     rules load without conventions and warning = "no conventions found".
 *     A hard throw here would break reviews of brand-new projects that have
 *     not run the F-6 conventions lifecycle yet.
 *
 * The function is SYNCHRONOUS (TC-F-4-3 asserts with expect(() => ...).toThrow)
 * and returns { files, warning? } — warning is present only on fallback paths.
 * All paths are absolute, built via path.join (Windows-safe).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

// ─── SINGLE SOURCE OF TRUTH — warning messages (consumed by F-8 Review Scope) ───
export const STACK_UNKNOWN_WARNING = "Stack unknown, using common rules only";
export const NO_CONVENTIONS_WARNING = "no conventions found";

/**
 * Load review rules for the code-review worker: common → stack → conventions.
 *
 * @param {string} projectDir - Project directory; conventions are read from
 *   `<projectDir>/.fan/code-review/conventions.md` (F-5), never from rulesDir.
 * @param {"typescript"|"python"|"rust"|"kotlin"|"unknown"} stack - Stack from
 *   F-3 detectStack (or the worker's stack constraint).
 * @param {string} rulesDir - Directory with the review-rules corpus (F-1),
 *   injected via CODE_REVIEW_RULES_DIR (F-13).
 * @returns {{files: string[], warning?: string}} Ordered absolute rule paths
 *   (common → stack → conventions) plus an optional fallback warning.
 * @throws {Error} When `<rulesDir>/common.md` does not exist (message contains
 *   "common.md" — minimal requirement, review cannot start without it).
 */
export function loadRules(projectDir, stack, rulesDir) {
    const files = [];

    // Step 1: common.md — mandatory, error when absent (TC-F-4-3).
    const commonPath = path.join(rulesDir, "common.md");
    if (!existsSync(commonPath)) {
        throw new Error(
            `Rules loading failed: common.md not found in rulesDir "${rulesDir}" — common.md is the minimal requirement, review cannot start`,
        );
    }
    files.push(commonPath);

    // Step 2: <stack>.md — skipped on unknown stack or missing file;
    // both degrade to common-only (conventions are NOT loaded either, TC-F-4-2).
    const stackPath = path.join(rulesDir, `${stack}.md`);
    if (stack === "unknown" || !existsSync(stackPath)) {
        return { files, warning: STACK_UNKNOWN_WARNING };
    }
    files.push(stackPath);

    // Step 3: project conventions — soft fallback when absent (documented above).
    const conventionsPath = path.join(projectDir, ".fan", "code-review", "conventions.md");
    if (!existsSync(conventionsPath)) {
        return { files, warning: NO_CONVENTIONS_WARNING };
    }
    files.push(conventionsPath);

    return { files };
}
