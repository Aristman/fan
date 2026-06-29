/**
 * FAN Orchestrator — shared type declarations (JS runtime shapes)
 *
 * This module contains no runtime logic. It re-exports type-like constants
 * so that the extension can import from "./types.js" consistently.
 */

/** Valid worker/agent types */
export const WORKER_TYPES = [
  "explore",
  "plan",
  "implement",
  "verify",
  "bug-fix",
  "code-research",
  "tests-impl",
  "docs-impl",
];

export const PROVIDER_MODES = ["auto", "cloud", "local"];

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "blocked",
];

// This file intentionally contains no runtime logic beyond constants.
