/**
 * F-48 Red-phase tests: TaskManager persistence & lifecycle validation.
 *
 * CONTRACT (drives Green-phase implementation in task-manager.js):
 *
 * 1. serialize() — full per-task snapshot. Each entry MUST include:
 *    { id, type, status, description, agentType, parentTaskId, owner,
 *      blocks, blockedBy, createdAt, updatedAt, result?, error?, metadata? }
 *    (Current impl only emits {id,status,description,agentType,result,error} —
 *     loses blocks/blockedBy/owner/createdAt. TC-F48-5 drives the fix.)
 *
 * 2. deserialize(entries: unknown[]): void — instance method that REPLACES
 *    the current task board (does not append):
 *    - entries missing id or status, or with a status outside ALL_STATUSES,
 *      are SKIPPED (never throws).
 *    - a task whose snapshot status is "in_progress" is restored as
 *      status="pending" with metadata.recovered = true (interrupted worker
 *      must be re-started, not silently assumed running).
 *    - bidirectional blocks/blockedBy links are rebuilt: if a snapshot only
 *      carries `blocks`, the reverse `blockedBy` is reconstructed.
 *    - after deserialize, getTasks()/getTask() work as usual.
 *
 * 3. validateTransition(from, to) — currently UNDEFINED, causing startTask /
 *    completeTask / failTask / blockTask to throw TypeError. Must be
 *    implemented. Allowed transitions:
 *      pending    → in_progress | blocked | failed
 *      in_progress → completed | failed | blocked | pending
 *      blocked    → pending | in_progress | failed
 *      completed / failed — terminal
 *    An invalid transition throws an Error with a clear message naming the
 *    from→to statuses. updateTask() must NOT call validateTransition (it
 *    stays a direct field setter).
 *
 * These tests are RED until the above is implemented. They MUST NOT modify
 * production code — only this test file.
 */
import { describe, expect, it } from "vitest";
import { TaskManager } from "../task-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal but fully-specified snapshot entry (manual, does not rely on serialize()). */
function snap(overrides = {}) {
	return {
		id: overrides.id ?? "t-1",
		type: "coding",
		status: overrides.status ?? "pending",
		description: overrides.description ?? "a task",
		agentType: "implement",
		parentTaskId: undefined,
		owner: overrides.owner ?? "w1",
		blocks: overrides.blocks ?? [],
		blockedBy: overrides.blockedBy ?? [],
		createdAt: overrides.createdAt ?? "2026-08-13T10:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-08-13T10:01:00.000Z",
		...(overrides.result !== undefined ? { result: overrides.result } : {}),
		...(overrides.error !== undefined ? { error: overrides.error } : {}),
		...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
	};
}

// ---------------------------------------------------------------------------
// TC-F48-1: Roundtrip serialize → deserialize preserves tasks & links
// ---------------------------------------------------------------------------

describe("TC-F48-1: serialize/deserialize roundtrip preserves tasks and links", () => {
	it("restores all tasks with correct ids, descriptions and links", () => {
		const tm = new TaskManager();
		const a = tm.createTask({ description: "Task A", agentType: "implement", owner: "w1" });
		// B depends on A (B.blocks=[A]); createTask auto-blocks B because A is
		// incomplete. Force in_progress via updateTask to bypass the
		// validateTransition bug (fix is TC-F48-4 / Green phase).
		const b = tm.createTask({ description: "Task B", agentType: "implement", blocks: [a.id], owner: "w2" });
		tm.updateTask(b.id, { status: "in_progress" });
		// C depends on B; force completed via updateTask.
		const c = tm.createTask({ description: "Task C", agentType: "explore", blocks: [b.id] });
		tm.updateTask(c.id, { status: "completed" });

		// Expected pre-serialize state:
		//   A: pending      | blockedBy=[B]
		//   B: in_progress  | blocks=[A], blockedBy=[C]
		//   C: completed    | blocks=[B]

		const json = JSON.parse(JSON.stringify(tm.serialize()));

		const tm2 = new TaskManager();
		expect(() => tm2.deserialize(json)).not.toThrow();

		const restored = tm2.getTasks();
		expect(restored).toHaveLength(3);

		const a2 = tm2.getTask(a.id);
		const b2 = tm2.getTask(b.id);
		const c2 = tm2.getTask(c.id);
		expect(a2).toBeDefined();
		expect(b2).toBeDefined();
		expect(c2).toBeDefined();

		// descriptions preserved
		expect(a2.description).toBe("Task A");
		expect(b2.description).toBe("Task B");
		expect(c2.description).toBe("Task C");

		// statuses: A pending, C completed survive verbatim.
		// B (was in_progress) → pending + recovered (F-48 contract: interrupted
		// in_progress workers are reset on restore).
		expect(a2.status).toBe("pending");
		expect(c2.status).toBe("completed");
		expect(b2.status).toBe("pending");
		expect(b2.metadata?.recovered).toBe(true);

		// bidirectional links identical
		expect(b2.blocks).toEqual([a.id]);
		expect(c2.blocks).toEqual([b.id]);
		expect(a2.blockedBy).toEqual([b.id]);
		expect(b2.blockedBy).toEqual([c.id]);
	});
});

// ---------------------------------------------------------------------------
// TC-F48-2: in_progress snapshot → pending + recovered
// ---------------------------------------------------------------------------

describe("TC-F48-2: in_progress tasks recover as pending + recovered", () => {
	it("restores an in_progress task as pending with metadata.recovered=true", () => {
		const tm = new TaskManager();
		tm.deserialize([snap({ id: "t-run", status: "in_progress" })]);

		const t = tm.getTask("t-run");
		expect(t).toBeDefined();
		expect(t.status).toBe("pending");
		expect(t.metadata).toBeDefined();
		expect(t.metadata.recovered).toBe(true);
	});

	it("does not flag already-pending tasks as recovered", () => {
		const tm = new TaskManager();
		tm.deserialize([snap({ id: "t-pending", status: "pending" })]);

		const t = tm.getTask("t-pending");
		expect(t.status).toBe("pending");
		expect(t.metadata?.recovered).not.toBe(true);
	});

	it("preserves completed/failed/blocked statuses without recovery flag", () => {
		const tm = new TaskManager();
		tm.deserialize([
			snap({ id: "t-done", status: "completed", result: "ok" }),
			snap({ id: "t-fail", status: "failed", error: "boom" }),
			snap({ id: "t-block", status: "blocked" }),
		]);

		expect(tm.getTask("t-done").status).toBe("completed");
		expect(tm.getTask("t-fail").status).toBe("failed");
		expect(tm.getTask("t-block").status).toBe("blocked");
		expect(tm.getTask("t-done").metadata?.recovered).not.toBe(true);
	});
});

// ---------------------------------------------------------------------------
// TC-F48-3: validation & robustness of deserialize
// ---------------------------------------------------------------------------

describe("TC-F48-3: deserialize robustness", () => {
	it("skips garbage entries without throwing and yields an empty board", () => {
		const tm = new TaskManager();
		expect(() =>
			tm.deserialize([{ id: 1 }, { status: "weird" }, null, "str", {}, [], 42, { id: "x" }]),
		).not.toThrow();
		expect(tm.size).toBe(0);
		expect(tm.getTasks()).toHaveLength(0);
	});

	it("skips entries with an invalid status", () => {
		const tm = new TaskManager();
		tm.deserialize([
			snap({ id: "good", status: "pending" }),
			snap({ id: "bad", status: "weird" }),
		]);
		expect(tm.size).toBe(1);
		expect(tm.getTask("good")).toBeDefined();
		expect(tm.getTask("bad")).toBeUndefined();
	});

	it("skips entries missing id or status", () => {
		const tm = new TaskManager();
		tm.deserialize([
			{ status: "pending", description: "no id" },
			{ id: "no-status", description: "no status" },
			snap({ id: "ok", status: "pending" }),
		]);
		expect(tm.size).toBe(1);
		expect(tm.getTask("ok")).toBeDefined();
	});

	it("deserialize([]) yields an empty board without error", () => {
		const tm = new TaskManager();
		tm.createTask({ description: "pre-existing", agentType: "implement" });
		expect(tm.size).toBe(1);
		expect(() => tm.deserialize([])).not.toThrow();
		expect(tm.size).toBe(0);
	});

	it("deserialize REPLACES state instead of appending", () => {
		const tm = new TaskManager();
		tm.deserialize([snap({ id: "t1", status: "pending" })]);
		expect(tm.size).toBe(1);

		tm.deserialize([snap({ id: "t2", status: "pending" })]);
		expect(tm.size).toBe(1); // not 2
		expect(tm.getTask("t1")).toBeUndefined();
		expect(tm.getTask("t2")).toBeDefined();
	});

	it("rebuilds blockedBy from blocks when the snapshot only carries blocks", () => {
		const tm = new TaskManager();
		tm.deserialize([
			snap({ id: "A", status: "completed", blocks: [] }), // no blockedBy field
			snap({ id: "B", status: "pending", blocks: ["A"] }), // no blockedBy field
		]);
		const a = tm.getTask("A");
		const b = tm.getTask("B");
		expect(b.blocks).toEqual(["A"]);
		expect(a.blockedBy).toEqual(["B"]); // reconstructed reverse link
	});
});

// ---------------------------------------------------------------------------
// TC-F48-4: validateTransition fix (startTask/completeTask/failTask/blockTask)
// ---------------------------------------------------------------------------

describe("TC-F48-4: validateTransition fix — lifecycle methods work", () => {
	it("startTask transitions pending → in_progress without TypeError", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		const started = tm.startTask(t.id);
		expect(started.status).toBe("in_progress");
	});

	it("startTask transitions blocked → in_progress", () => {
		const tm = new TaskManager();
		const a = tm.createTask({ description: "A", agentType: "implement" });
		const b = tm.createTask({ description: "B", agentType: "implement", blocks: [a.id] });
		expect(b.status).toBe("blocked"); // auto-blocked by incomplete A
		const started = tm.startTask(b.id);
		expect(started.status).toBe("in_progress");
	});

	it("completeTask transitions in_progress → completed", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		tm.startTask(t.id);
		const done = tm.completeTask(t.id, "result-text");
		expect(done.status).toBe("completed");
		expect(done.result).toBe("result-text");
	});

	it("failTask transitions in_progress → failed", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		tm.startTask(t.id);
		const failed = tm.failTask(t.id, "boom");
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("boom");
	});

	it("blockTask transitions in_progress → blocked", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		tm.startTask(t.id);
		const blocked = tm.blockTask(t.id, "waiting on dep");
		expect(blocked.status).toBe("blocked");
	});

	it("invalid transition completed → in_progress throws a clear Error", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		// Reach a terminal state WITHOUT going through validateTransition
		// (updateTask is the bypass that already works):
		tm.updateTask(t.id, { status: "completed" });
		expect(t.status).toBe("completed");

		// Now an invalid completed → in_progress must throw a clear Error
		// (NOT a bare TypeError from a missing validateTransition).
		let caught;
		try {
			tm.startTask(t.id);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught.message).toMatch(/completed/i);
		expect(caught.message).toMatch(/in_progress/i);
	});

	it("invalid transition pending → completed throws a clear Error", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		expect(t.status).toBe("pending");

		let caught;
		try {
			tm.completeTask(t.id, "skip");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught.message).toMatch(/pending/i);
		expect(caught.message).toMatch(/completed/i);
	});

	it("updateTask continues to work (does not call validateTransition)", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		const upd = tm.updateTask(t.id, { status: "in_progress", owner: "w-1" });
		expect(upd.status).toBe("in_progress");
		expect(upd.owner).toBe("w-1");
	});
});

// ---------------------------------------------------------------------------
// TC-F48-5: serialize() completeness
// ---------------------------------------------------------------------------

describe("TC-F48-5: serialize() emits a complete task snapshot", () => {
	it("includes blocks, blockedBy, owner, createdAt, updatedAt, type", () => {
		const tm = new TaskManager();
		const a = tm.createTask({ description: "A", agentType: "implement", owner: "w1" });
		const b = tm.createTask({ description: "B", agentType: "implement", blocks: [a.id], owner: "w2" });
		// state: A.blockedBy=[B], B.blocks=[A]

		const snap = tm.serialize();
		const aEntry = snap.find((e) => e.id === a.id);
		const bEntry = snap.find((e) => e.id === b.id);
		expect(aEntry).toBeDefined();
		expect(bEntry).toBeDefined();

		// forward link
		expect(bEntry.blocks).toEqual([a.id]);
		// reverse link (was lost by old serialize)
		expect(aEntry.blockedBy).toEqual([b.id]);

		// owner (was lost)
		expect(aEntry.owner).toBe("w1");
		expect(bEntry.owner).toBe("w2");

		// timestamps (were lost)
		expect(aEntry.createdAt).toBeDefined();
		expect(bEntry.createdAt).toBeDefined();
		expect(aEntry.updatedAt).toBeDefined();
		expect(bEntry.updatedAt).toBeDefined();

		// type (was lost)
		expect(aEntry.type).toBe("coding");
		expect(bEntry.type).toBe("coding");
	});

	it("includes result/error/metadata when present", () => {
		const tm = new TaskManager();
		const t = tm.createTask({ description: "A", agentType: "implement" });
		tm.updateTask(t.id, { status: "completed" });
		// emulate completed task with result
		const before = tm.getTask(t.id);
		before.result = "done-result";
		before.usage = { input: 1, output: 1 };

		const [entry] = tm.serialize();
		expect(entry.result).toBe("done-result");
	});
});
