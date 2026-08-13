/**
 * F-48 Red-phase tests: orchestrator task-snapshot persistence hooks.
 *
 * CONTRACT (drives Green-phase implementation):
 *
 * A new standalone module `extensions/fan-orchestrator/task-persistence.js`
 * exports TWO pure functions (no dependency on the full orchestrator-extension
 * wiring, so they are unit-testable in isolation):
 *
 *   writeTaskSnapshot(fan, taskManager): void
 *     - Calls fan.appendEntry("orchestrator-task-snapshot", taskManager.serialize())
 *       — i.e. persists the current board as a custom JSONL entry.
 *
 *   restoreTasks(fan, taskManager): void
 *     - Calls fan.getCustomEntries("orchestrator-task-snapshot") (the new core
 *       read-API) to read all snapshot entries of this session, in insertion
 *       order.
 *     - If at least one snapshot exists, takes the LAST one and calls
 *       taskManager.deserialize(snapshot.data) to replace the board.
 *     - If no snapshot exists (empty array), the board stays empty and NO error
 *       is thrown (backward compatibility with sessions created before F-48).
 *
 * These functions are wired into orchestrator-extension.js:
 *   - tool_result hook (already reacts to TaskCreate/TaskUpdate/TaskClear) →
 *     calls writeTaskSnapshot(...) after each task mutation.
 *   - session_start hook → calls restoreTasks(...) to rebuild the board.
 *
 * The `fan` object here is a minimal mock exposing only appendEntry &
 * getCustomEntries (plus vi.fn stubs the rest). This keeps the test free of the
 * heavy orchestrator-extension.js dependency graph.
 *
 * RED until task-persistence.js + the core getCustomEntries read-API exist.
 */
import { describe, expect, it, vi } from "vitest";
import { TaskManager } from "../task-manager.js";
import { restoreTasks, writeTaskSnapshot } from "../task-persistence.js";

// ---------------------------------------------------------------------------
// Minimal fan-API mock
// ---------------------------------------------------------------------------

/**
 * Builds a mock `fan` extension API object. `getEntries` controls what
 * fan.getCustomEntries("orchestrator-task-snapshot") returns.
 */
function makeFanMock(entries = []) {
	const calls = { append: [] };
	const fan = {
		appendEntry: vi.fn((customType, data) => {
			calls.append.push({ customType, data });
		}),
		getCustomEntries: vi.fn((_customType) => entries),
		// Unused by persistence but kept as no-op stubs for realism:
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
	};
	return { fan, calls };
}

// ---------------------------------------------------------------------------
// writeTaskSnapshot
// ---------------------------------------------------------------------------

describe("writeTaskSnapshot", () => {
	it("appends one custom entry with customType 'orchestrator-task-snapshot'", () => {
		const tm = new TaskManager();
		const { fan } = makeFanMock();
		writeTaskSnapshot(fan, tm);

		expect(fan.appendEntry).toHaveBeenCalledTimes(1);
		const [customType, data] = fan.appendEntry.mock.calls[0];
		expect(customType).toBe("orchestrator-task-snapshot");
		expect(Array.isArray(data)).toBe(true);
	});

	it("the snapshot payload equals taskManager.serialize()", () => {
		const tm = new TaskManager();
		tm.createTask({ description: "A", agentType: "implement", owner: "w1" });
		const { fan } = makeFanMock();
		writeTaskSnapshot(fan, tm);

		const [, data] = fan.appendEntry.mock.calls[0];
		expect(data).toEqual(tm.serialize());
	});

	it("appends a fresh snapshot reflecting the latest board after each call", () => {
		const tm = new TaskManager();
		const { fan } = makeFanMock();
		writeTaskSnapshot(fan, tm); // empty board
		tm.createTask({ description: "A", agentType: "implement" });
		writeTaskSnapshot(fan, tm); // 1 task

		expect(fan.appendEntry).toHaveBeenCalledTimes(2);
		const secondCall = fan.appendEntry.mock.calls[1];
		expect(secondCall[0]).toBe("orchestrator-task-snapshot");
		expect(secondCall[1]).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// restoreTasks
// ---------------------------------------------------------------------------

describe("restoreTasks", () => {
	it("reads snapshots via fan.getCustomEntries('orchestrator-task-snapshot')", () => {
		const { fan } = makeFanMock([]);
		const tm = new TaskManager();
		restoreTasks(fan, tm);

		expect(fan.getCustomEntries).toHaveBeenCalledTimes(1);
		expect(fan.getCustomEntries).toHaveBeenCalledWith("orchestrator-task-snapshot");
	});

	it("restores the board from the snapshot produced by serialize()", () => {
		// Source manager with one persisted task.
		const src = new TaskManager();
		const t = src.createTask({ description: "persisted", agentType: "implement", owner: "w1" });
		const snapshotData = src.serialize();

		const { fan } = makeFanMock([
			{ customType: "orchestrator-task-snapshot", data: snapshotData, timestamp: "2026-08-13T10:00:00.000Z" },
		]);
		const tm = new TaskManager();
		expect(tm.size).toBe(0);

		restoreTasks(fan, tm);

		expect(tm.size).toBe(1);
		const restored = tm.getTask(t.id);
		expect(restored).toBeDefined();
		expect(restored.description).toBe("persisted");
	});

	it("yields an empty board without throwing when no snapshot exists (backward compat)", () => {
		const { fan } = makeFanMock([]);
		const tm = new TaskManager();
		expect(() => restoreTasks(fan, tm)).not.toThrow();
		expect(tm.size).toBe(0);
		expect(tm.getTasks()).toHaveLength(0);
	});

	it("uses the LAST snapshot when multiple are present", () => {
		const old = [
			{
				id: "old",
				type: "coding",
				status: "pending",
				description: "old",
				agentType: "implement",
				createdAt: "2026-08-13T09:00:00.000Z",
				updatedAt: "2026-08-13T09:00:00.000Z",
			},
		];
		const latest = [
			{
				id: "new",
				type: "coding",
				status: "completed",
				description: "new",
				agentType: "implement",
				createdAt: "2026-08-13T10:00:00.000Z",
				updatedAt: "2026-08-13T10:00:00.000Z",
			},
		];
		const { fan } = makeFanMock([
			{ customType: "orchestrator-task-snapshot", data: old, timestamp: "1" },
			{ customType: "orchestrator-task-snapshot", data: latest, timestamp: "2" },
		]);
		const tm = new TaskManager();

		restoreTasks(fan, tm);

		expect(tm.size).toBe(1);
		expect(tm.getTask("new")).toBeDefined();
		expect(tm.getTask("old")).toBeUndefined();
	});

	it("does not throw when a snapshot's data is malformed (defensive)", () => {
		const { fan } = makeFanMock([
			{ customType: "orchestrator-task-snapshot", data: "not-an-array", timestamp: "1" },
		]);
		const tm = new TaskManager();
		expect(() => restoreTasks(fan, tm)).not.toThrow();
		expect(tm.size).toBe(0);
	});
});
