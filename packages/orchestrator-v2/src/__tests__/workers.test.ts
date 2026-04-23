/**
 * Tests for workers.ts — Worker Registry & Slot Pool
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  genWorkerId,
  registerWorker,
  getWorker,
  listWorkers,
  activeWorkers,
  updateWorker,
  acquireSlot,
  releaseSlot,
  getQueueLength,
  statusIcon,
  statusColor,
  __resetWorkerRegistry,
  __resetSlotPool,
} from "../workers.js";

const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bold: (text: string) => `*${text}*`,
  strikethrough: (text: string) => `~~${text}~~`,
};

describe("Worker Registry", () => {
  beforeEach(() => {
    __resetWorkerRegistry();
    __resetSlotPool();
  });

  describe("genWorkerId", () => {
    it("should generate unique IDs", () => {
      const id1 = genWorkerId();
      const id2 = genWorkerId();
      expect(id1).toMatch(/^worker-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("registerWorker / getWorker", () => {
    it("should register and retrieve a worker", () => {
      const id = genWorkerId();
      registerWorker({
        id,
        agentType: "explore",
        model: "test-model",
        status: "running",
        startTime: Date.now(),
      });
      const w = getWorker(id);
      expect(w).toBeDefined();
      expect(w?.agentType).toBe("explore");
      expect(w?.status).toBe("running");
    });

    it("should return undefined for non-existent worker", () => {
      expect(getWorker("nonexistent")).toBeUndefined();
    });
  });

  describe("listWorkers / activeWorkers", () => {
    it("should list all workers", () => {
      registerWorker({ id: "w1", agentType: "explore", model: "m1", status: "running", startTime: Date.now() });
      registerWorker({ id: "w2", agentType: "plan", model: "m2", status: "completed", startTime: Date.now() });
      expect(listWorkers()).toHaveLength(2);
    });

    it("should filter active workers", () => {
      registerWorker({ id: "w1", agentType: "explore", model: "m1", status: "running", startTime: Date.now() });
      registerWorker({ id: "w2", agentType: "plan", model: "m2", status: "completed", startTime: Date.now() });
      registerWorker({ id: "w3", agentType: "verify", model: "m3", status: "spawning", startTime: Date.now() });
      expect(activeWorkers()).toHaveLength(2); // running + spawning
    });
  });

  describe("updateWorker", () => {
    it("should update worker fields", () => {
      registerWorker({ id: "w1", agentType: "explore", model: "m1", status: "running", startTime: Date.now() });
      updateWorker("w1", { status: "completed", endTime: Date.now(), result: "done" });
      const w = getWorker("w1");
      expect(w?.status).toBe("completed");
      expect(w?.result).toBe("done");
    });
  });

  describe("statusIcon", () => {
    it("should return correct icon for each state", () => {
      expect(statusIcon("completed")).toBe("✅");
      expect(statusIcon("running")).toBe("🔄");
      expect(statusIcon("spawning")).toBe("⏳");
      expect(statusIcon("failed")).toBe("❌");
      expect(statusIcon("aborted")).toBe("⏹️");
      expect(statusIcon("unknown")).toBe("⏹️");
    });
  });
});

describe("Slot Pool", () => {
  beforeEach(() => {
    __resetSlotPool();
    __resetWorkerRegistry();
  });

  it("should acquire and release a read-only slot", async () => {
    await acquireSlot("explore", 3);
    expect(getQueueLength()).toBe(0);
    releaseSlot("explore", 3);
  });

  it("should queue when pool is full", async () => {
    const p1 = acquireSlot("explore", 2);
    const p2 = acquireSlot("explore", 2);
    // Third should queue
    const p3Started = new Promise<void>((resolve) => {
      acquireSlot("explore", 2).then(resolve);
    });

    await p1;
    await p2;
    expect(getQueueLength()).toBe(1);

    // Release one — should unqueue
    releaseSlot("explore", 2);
    await p3Started;
    expect(getQueueLength()).toBe(0);

    // Cleanup
    releaseSlot("explore", 2);
  });

  it("should allow only one write worker at a time", async () => {
    const p1 = acquireSlot("implement", 3); // Write worker
    await p1;

    // Second write worker should queue even though pool has room
    const p2Started = new Promise<void>((resolve) => {
      acquireSlot("implement", 3).then(resolve);
    });

    await new Promise(r => setTimeout(r, 10)); // Let microtask settle
    expect(getQueueLength()).toBe(1);

    // But a read-only worker should be allowed
    await acquireSlot("explore", 3);
    expect(getQueueLength()).toBe(1); // Only write worker is queued

    // Release write slot
    releaseSlot("implement", 3);
    await p2Started;
    expect(getQueueLength()).toBe(0);

    // Cleanup
    releaseSlot("explore", 3);
    releaseSlot("implement", 3);
  });
});
