/**
 * FAN Orchestrator — Stack Detection (F-3, code-review worker)
 *
 * Detects the project stack by the mere presence of a build manifest in the
 * given directory (roadmap: docs/features/code-review-worker/roadmap.md → F-3;
 * spec: docs/specs/spec_code-review-worker_2026-09-03.md, STEP 1 of the worker).
 *
 * Manifest → stack mapping:
 *   package.json     → "typescript"
 *   pyproject.toml   → "python"
 *   Cargo.toml       → "rust"
 *   build.gradle.kts → "kotlin"
 *   pom.xml          → "kotlin"
 *
 * When several manifests coexist, the highest-priority stack wins:
 * typescript > python > rust > kotlin (see STACK_DETECTION_ORDER —
 * single source of truth, reused by F-4 loadRules and F-8 runReview).
 *
 * Detection is existence-only: manifest contents are never parsed.
 * If no known manifest is found, returns "unknown" and NEVER throws —
 * the code-review worker falls back to common-only rules (roadmap TC-F-3-3).
 *
 * Edge case (not covered by tests, documented choice): a non-existent `dir`,
 * or `dir` pointing to a file, also degrades gracefully to "unknown" —
 * detection never enumerates the directory, it only probes fixed paths, so
 * a missing/inaccessible directory is indistinguishable from "no manifests".
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

// ─── SINGLE SOURCE OF TRUTH — stack priority (highest first) ───
export const STACK_DETECTION_ORDER = ["typescript", "python", "rust", "kotlin"];

// ─── KNOWN MANIFESTS per stack (checked in order, existence-only) ───
const STACK_MANIFESTS = {
    typescript: ["package.json"],
    python: ["pyproject.toml"],
    rust: ["Cargo.toml"],
    kotlin: ["build.gradle.kts", "pom.xml"],
};

/**
 * Detect the project stack by manifest presence in `dir`.
 *
 * @param {string} dir - Project directory to probe (fixed manifest paths only).
 * @returns {"typescript"|"python"|"rust"|"kotlin"|"unknown"} Detected stack;
 *   "unknown" when no known manifest exists (graceful fallback, never throws).
 */
export function detectStack(dir) {
    for (const stack of STACK_DETECTION_ORDER) {
        for (const manifest of STACK_MANIFESTS[stack]) {
            if (existsSync(path.join(dir, manifest))) {
                return stack;
            }
        }
    }
    return "unknown";
}
