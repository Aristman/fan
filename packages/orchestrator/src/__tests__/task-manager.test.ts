import { describe, it, expect, beforeEach } from "vitest";
import { TaskManager } from "../task-manager.js";

describe("TaskManager", () => {
	let tm: TaskManager;

	beforeEach(() => {
		tm = new TaskManager();
	});

	describe("createTask", () => {
		it("creates a task with defaults", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			expect(task.id).toBeTruthy();
			expect(task.description).toBe("test");
			expect(task.agentType).toBe("implement");
			expect(task.status).toBe("pending");
			expect(task.type).toBe("coding");
			expect(task.createdAt).toBeInstanceOf(Date);
		});

		it("creates a task with custom type", () => {
			const task = tm.createTask({ description: "quick task", agentType: "explore", type: "quick" });
			expect(task.type).toBe("quick");
		});

		it("creates a task with parent and blocks", () => {
			const parent = tm.createTask({ description: "parent", agentType: "plan" });
			const child = tm.createTask({ description: "child", agentType: "implement", parentTaskId: parent.id, blocks: [parent.id] });
			expect(child.parentTaskId).toBe(parent.id);
			expect(child.blocks).toEqual([parent.id]);
		});
	});

	describe("status transitions", () => {
		it("pending → in_progress", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			tm.startTask(task.id);
			expect(tm.getTask(task.id)!.status).toBe("in_progress");
		});

		it("in_progress → completed", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			tm.startTask(task.id);
			tm.completeTask(task.id, "done");
			expect(tm.getTask(task.id)!.status).toBe("completed");
			expect(tm.getTask(task.id)!.result).toBe("done");
		});

		it("in_progress → failed", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			tm.startTask(task.id);
			tm.failTask(task.id, "error");
			expect(tm.getTask(task.id)!.status).toBe("failed");
			expect(tm.getTask(task.id)!.error).toBe("error");
		});

		it("rejects invalid transitions", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			expect(() => tm.completeTask(task.id, "done")).toThrow("Invalid task transition");
			expect(() => tm.failTask(task.id, "err")).toThrow("Invalid task transition");
		});

		it("rejects transition from completed", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			tm.startTask(task.id);
			tm.completeTask(task.id, "done");
			expect(() => tm.startTask(task.id)).toThrow("Invalid task transition");
		});
	});

	describe("cancelTask", () => {
		it("cancels a pending task", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			tm.cancelTask(task.id);
			expect(tm.getTask(task.id)!.status).toBe("failed");
			expect(tm.getTask(task.id)!.error).toBe("Cancelled");
		});

		it("cancels an in_progress task", () => {
			const task = tm.createTask({ description: "test", agentType: "implement" });
			tm.startTask(task.id);
			tm.cancelTask(task.id);
			expect(tm.getTask(task.id)!.status).toBe("failed");
		});
	});

	describe("getTasks", () => {
		it("filters by status", () => {
			tm.createTask({ description: "t1", agentType: "implement" });
			const t2 = tm.createTask({ description: "t2", agentType: "explore" });
			tm.startTask(t2.id);
			const inProgress = tm.getTasks({ status: "in_progress" });
			expect(inProgress).toHaveLength(1);
			expect(inProgress[0].id).toBe(t2.id);
		});

		it("returns all tasks sorted by createdAt desc", () => {
			tm.createTask({ description: "t1", agentType: "implement" });
			tm.createTask({ description: "t2", agentType: "explore" });
			const all = tm.getTasks();
			expect(all).toHaveLength(2);
			// Newest first
			expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[1].createdAt.getTime());
		});
	});

	describe("getStatusCounts", () => {
		it("counts correctly", () => {
			const t1 = tm.createTask({ description: "t1", agentType: "implement" });
			const t2 = tm.createTask({ description: "t2", agentType: "explore" });
			tm.startTask(t1.id);
			tm.completeTask(t1.id, "done");
			const counts = tm.getStatusCounts();
			expect(counts.pending).toBe(1);
			expect(counts.in_progress).toBe(0);
			expect(counts.completed).toBe(1);
		});
	});

	describe("clearCompleted", () => {
		it("removes completed and failed tasks", () => {
			const t1 = tm.createTask({ description: "t1", agentType: "implement" });
			const t2 = tm.createTask({ description: "t2", agentType: "explore" });
			tm.startTask(t1.id);
			tm.completeTask(t1.id, "done");
			tm.startTask(t2.id);
			tm.failTask(t2.id, "err");
			const removed = tm.clearCompleted();
			expect(removed).toBe(2);
			expect(tm.size).toBe(0);
		});
	});

	describe("blocking/unblocking", () => {
		it("blocks and unblocks dependent tasks", () => {
			const parent = tm.createTask({ description: "parent", agentType: "plan" });
			const child = tm.createTask({ description: "child", agentType: "implement" });
			tm.startTask(parent.id);
			tm.blockTask(child.id, "waiting for parent");
			expect(tm.getTask(child.id)!.status).toBe("blocked");

			// Complete parent → child should unblock
			tm.completeTask(parent.id, "plan done");
			// Note: child needs blocks[] pointing to parent for auto-unblock
		});

		it("auto-unblocks when all blockers complete", () => {
			const parent = tm.createTask({ description: "parent", agentType: "plan" });
			const child = tm.createTask({ description: "child", agentType: "implement", blocks: [parent.id] });
			tm.startTask(parent.id);
			tm.blockTask(child.id, "waiting");
			tm.completeTask(parent.id, "done");
			expect(tm.getTask(child.id)!.status).toBe("pending");
		});
	});

	describe("serialize", () => {
		it("serializes tasks for persistence", () => {
			tm.createTask({ description: "t1", agentType: "implement" });
			const t2 = tm.createTask({ description: "t2", agentType: "explore" });
			tm.startTask(t2.id);
			const serialized = tm.serialize();
			expect(serialized).toHaveLength(2);
			expect(serialized[0]).toHaveProperty("id");
			expect(serialized[0]).toHaveProperty("status");
			expect(serialized[0]).toHaveProperty("description");
		});
	});
});
