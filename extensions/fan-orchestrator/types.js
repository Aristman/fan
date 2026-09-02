/**
 * FAN Orchestrator — shared type declarations (JS runtime shapes)
 *
 * This module contains no runtime logic beyond constants and registry-backed
 * accessors so that the extension can import from "./types.js" consistently.
 */

import { getAgentTypes } from "./agents/index.js";

/** Valid worker/agent types — accessor over the agent registry (single source of truth). */
export function WORKER_TYPES() {
  return getAgentTypes();
}

export const PROVIDER_MODES = ["auto", "cloud", "local"];

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "blocked",
];

// This file intentionally contains no runtime logic beyond constants.
