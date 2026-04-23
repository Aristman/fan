/**
 * FAN Orchestrator v2 — Worker Registry & Slot Pool
 *
 * Manages worker lifecycle (register, update, list) and the parallel
 * execution pool with FIFO queue. Only one write worker at a time;
 * explore/plan/verify can run in parallel up to `parallelWorkers`.
 */

import type { AgentType, WorkerHandle, Waiter } from "./types.js";
import { AGENT_REGISTRY } from "./agents/index.js";

function isWriteAgent(agentType: string): boolean {
  const def = AGENT_REGISTRY[agentType];
  return def ? !def.readOnly : false;
}

const workerRegistry = new Map<string, WorkerHandle>();
let workerIdCounter = 0;

/** Generate a unique worker ID */
export function genWorkerId(): string {
  return `worker-${Date.now()}-${++workerIdCounter}`;
}

/** Register a new worker handle */
export function registerWorker(handle: WorkerHandle): void {
  workerRegistry.set(handle.id, handle);
}

/** Get a worker by ID */
export function getWorker(id: string): WorkerHandle | undefined {
  return workerRegistry.get(id);
}

/** List all workers (any status) */
export function listWorkers(): WorkerHandle[] {
  return Array.from(workerRegistry.values());
}

/** List only active (running or spawning) workers */
export function activeWorkers(): WorkerHandle[] {
  return listWorkers().filter((w) => w.status === "running" || w.status === "spawning");
}

/** Check if any write-capable worker is currently running */
export function hasActiveWriteWorker(): boolean {
  return listWorkers().some((w) => w.status === "running" && isWriteAgent(w.agentType));
}

/** Update fields on an existing worker */
export function updateWorker(id: string, updates: Partial<WorkerHandle>): void {
  const w = workerRegistry.get(id);
  if (w) Object.assign(w, updates);
}

// ── Slot Pool with Queue ───────────────────────────────────────────────────

let activeSlotCount = 0;
let activeWriteSlots = 0;
const waitQueue: Waiter[] = [];

/**
 * Acquire an execution slot. If pool is full, the caller waits in queue.
 */
export function acquireSlot(agentType: AgentType, maxParallel: number): Promise<void> {
  return new Promise((resolve) => {
    if (activeSlotCount < maxParallel) {
      if (isWriteAgent(agentType) && activeWriteSlots >= 1) {
        waitQueue.push({ agentType, resolve });
        return;
      }
      activeSlotCount++;
      if (isWriteAgent(agentType)) activeWriteSlots++;
      resolve();
      return;
    }
    waitQueue.push({ agentType, resolve });
  });
}

/**
 * Release an execution slot and start the next queued worker if possible.
 */
export function releaseSlot(agentType: AgentType, maxParallel: number): void {
  activeSlotCount = Math.max(0, activeSlotCount - 1);
  if (isWriteAgent(agentType)) activeWriteSlots = Math.max(0, activeWriteSlots - 1);
  while (waitQueue.length > 0 && activeSlotCount < maxParallel) {
    const next = waitQueue.shift()!;
    if (isWriteAgent(next.agentType) && activeWriteSlots >= 1) {
      waitQueue.unshift(next);
      break;
    }
    activeSlotCount++;
    if (isWriteAgent(next.agentType)) activeWriteSlots++;
    next.resolve();
  }
}

/** Get current queue depth */
export function getQueueLength(): number {
  return waitQueue.length;
}

// ── Status display helpers ─────────────────────────────────────────────────

/** Status icon for worker/task display */
export function statusIcon(status: string): string {
  switch (status) {
    case "completed": return "✅";
    case "running": return "🔄";
    case "spawning": return "⏳";
    case "failed": return "❌";
    default: return "⏹️";
  }
}

/** Color a status string using TUI theme */
export function statusColor(status: string, text: string, theme: any): string {
  switch (status) {
    case "completed": return theme.fg("success", text);
    case "running":
    case "spawning": return theme.fg("warning", text);
    case "failed": return theme.fg("error", text);
    default: return theme.fg("muted", text);
  }
}

// ── Test Helpers ───────────────────────────────────────────────────────────

/** Reset slot pool state (for test isolation) */
export function __resetSlotPool(): void {
  activeSlotCount = 0;
  activeWriteSlots = 0;
  waitQueue.length = 0;
}

/** Reset worker registry (for test isolation) */
export function __resetWorkerRegistry(): void {
  workerRegistry.clear();
  workerIdCounter = 0;
}
