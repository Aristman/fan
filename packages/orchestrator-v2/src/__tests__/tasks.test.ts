/**
 * Tests for tasks.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createTask,
  updateTask,
  listTasks,
  formatTaskList,
  taskCount,
  clearTasks,
  parseVerdict,
  __resetTaskRegistry,
} from "../tasks.js";

describe("Task Registry", () => {
  beforeEach(() => {
    __resetTaskRegistry();
  });

  describe("createTask", () => {
    it("should create a task with generated ID", () => {
      const task = createTask({ subject: "Test task" });
      expect(task.id).toMatch(/^task-/);
      expect(task.subject).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
      expect(task.createdAt).toBeGreaterThan(0);
    });

    it("should create a task with description and owner", () => {
      const task = createTask({ subject: "Test", description: "Details", owner: "worker-1" });
      expect(task.description).toBe("Details");
      expect(task.owner).toBe("worker-1");
    });

    it("should increment task count", () => {
      createTask({ subject: "Task 1" });
      createTask({ subject: "Task 2" });
      expect(taskCount()).toBe(2);
    });
  });

  describe("updateTask", () => {
    it("should update status", () => {
      const task = createTask({ subject: "Test" });
      const updated = updateTask(task.id, { status: "in_progress" });
      expect(updated?.status).toBe("in_progress");
    });

    it("should return null for non-existent task", () => {
      const updated = updateTask("nonexistent", { status: "completed" });
      expect(updated).toBeNull();
    });

    it("should update subject and description", () => {
      const task = createTask({ subject: "Old", description: "Old desc" });
      const updated = updateTask(task.id, { subject: "New", description: "New desc" });
      expect(updated?.subject).toBe("New");
      expect(updated?.description).toBe("New desc");
    });
  });

  describe("dependency management", () => {
    it("should link blockedBy when creating with blocks[]", () => {
      const task1 = createTask({ subject: "Task 1" });
      const task2 = createTask({ subject: "Task 2", blocks: [task1.id] });
      // task2 blocks task1 → task1 is blocked by task2
      expect(task2.blocks).toEqual([task1.id]);
      expect(task1.blockedBy).toEqual([task2.id]);
      expect(task1.status).toBe("blocked");
      expect(task2.status).toBe("pending"); // task2 is the blocker, not blocked
    });

    it("should auto-unblock when blocker completes", () => {
      const task1 = createTask({ subject: "Task 1" });
      const task2 = createTask({ subject: "Task 2", blocks: [task1.id] });
      // task2 blocks task1 → task1 is blocked
      expect(task1.status).toBe("blocked");

      // When the blocker (task2) completes, task1 should unblock
      updateTask(task2.id, { status: "completed" });
      const tasks = listTasks();
      const updated1 = tasks.find(t => t.id === task1.id);
      expect(updated1?.status).toBe("pending");
    });

    it("should NOT unblock if other blockers still pending", () => {
      const t1 = createTask({ subject: "T1" });
      const t2 = createTask({ subject: "T2" });
      // t3 blocks both t1 and t2 — so t1 and t2 are blocked by t3
      const t3 = createTask({ subject: "T3", blocks: [t1.id, t2.id] });
      expect(t1.status).toBe("blocked");
      expect(t2.status).toBe("blocked");
      expect(t3.status).toBe("pending");

      // Completing t3 should unblock both t1 and t2
      updateTask(t3.id, { status: "completed" });
      const tasks = listTasks();
      const updated1 = tasks.find(t => t.id === t1.id);
      const updated2 = tasks.find(t => t.id === t2.id);
      expect(updated1?.status).toBe("pending");
      expect(updated2?.status).toBe("pending");
    });

    it("should handle lazy linking (blocker created after blocked)", () => {
      const task2 = createTask({ subject: "Task 2", blocks: ["task-future"] });
      // task-future doesn't exist yet, so no reverse link
      expect(task2.blockedBy).toEqual([]);

      // Create the future task — should NOT auto-link (it wasn't created yet)
      const future = createTask({ subject: "Future task" });
      // But the blocks reference is still there
      expect(task2.blocks).toEqual(["task-future"]);
    });
  });

  describe("listTasks", () => {
    it("should list all tasks", () => {
      createTask({ subject: "A" });
      createTask({ subject: "B" });
      createTask({ subject: "C" });
      expect(listTasks()).toHaveLength(3);
    });

    it("should filter by status", () => {
      const t1 = createTask({ subject: "A" });
      createTask({ subject: "B" });
      updateTask(t1.id, { status: "completed" });
      expect(listTasks({ status: "completed" })).toHaveLength(1);
      expect(listTasks({ status: "pending" })).toHaveLength(1);
    });

    it("should filter by owner", () => {
      createTask({ subject: "A", owner: "w1" });
      createTask({ subject: "B", owner: "w2" });
      expect(listTasks({ owner: "w1" })).toHaveLength(1);
    });

    it("should sort by creation time (oldest first)", () => {
      const t1 = createTask({ subject: "First" });
      const t2 = createTask({ subject: "Second" });
      const tasks = listTasks();
      expect(tasks[0].id).toBe(t1.id);
      expect(tasks[1].id).toBe(t2.id);
    });
  });

  describe("formatTaskList", () => {
    it("should return 'No tasks.' for empty list", () => {
      expect(formatTaskList([])).toBe("No tasks.");
    });

    it("should format tasks with status icons", () => {
      const t1 = createTask({ subject: "Pending task" });
      updateTask(t1.id, { status: "completed" });
      const t2 = createTask({ subject: "Active task" });
      updateTask(t2.id, { status: "in_progress" });
      const t3 = createTask({ subject: "Failed task" });
      updateTask(t3.id, { status: "failed" });

      const text = formatTaskList(listTasks());
      expect(text).toContain("✅");
      expect(text).toContain("🔄");
      expect(text).toContain("❌");
      expect(text).toContain("Pending task");
      expect(text).toContain("Active task");
      expect(text).toContain("Failed task");
    });
  });

  describe("clearTasks", () => {
    it("should clear all tasks", () => {
      createTask({ subject: "A" });
      createTask({ subject: "B" });
      expect(taskCount()).toBe(2);
      clearTasks();
      expect(taskCount()).toBe(0);
    });
  });

  describe("parseVerdict", () => {
    it("should parse VERDICT: PASS", () => {
      expect(parseVerdict("Some output\nVERDICT: PASS")).toBe("PASS");
      expect(parseVerdict("VERDICT: pass")).toBe("PASS");
    });

    it("should parse VERDICT: FAIL", () => {
      expect(parseVerdict("VERDICT: FAIL")).toBe("FAIL");
      expect(parseVerdict("VERDICT: fail")).toBe("FAIL");
    });

    it("should parse VERDICT: PARTIAL", () => {
      expect(parseVerdict("VERDICT: PARTIAL")).toBe("PARTIAL");
    });

    it("should return null for no verdict", () => {
      expect(parseVerdict("No verdict here")).toBeNull();
      expect(parseVerdict("")).toBeNull();
    });
  });
});
