import { afterEach, describe, expect, it } from "vitest";
import {
	_resetRegistry,
	finalizeWorker,
	genWorkerId,
	getWorker,
	listWorkers,
	pruneOldWorkers,
	registerWorker,
	resetSlots,
	updateWorker,
} from "../workers.js";

afterEach(() => _resetRegistry());

describe("workers.js: registerWorker / updateWorker / getWorker", () => {
	it("registerWorker adds a worker retrievable by id", () => {
		const id = genWorkerId();
		registerWorker({ id, agentType: "explore", status: "spawning", startTime: 1000 });
		const w = getWorker(id);
		expect(w).toBeDefined();
		expect(w.agentType).toBe("explore");
		expect(w.status).toBe("spawning");
	});

	it("updateWorker merges fields without losing existing ones", () => {
		const id = genWorkerId();
		registerWorker({ id, agentType: "implement", status: "spawning" });
		updateWorker(id, { status: "running", model: "gpt-4o" });
		const w = getWorker(id);
		expect(w.status).toBe("running");
		expect(w.model).toBe("gpt-4o");
		expect(w.agentType).toBe("implement"); // preserved
	});

	it("getWorker returns undefined for unknown id", () => {
		expect(getWorker("nonexistent-id")).toBeUndefined();
	});

	it("listWorkers returns all registered workers", () => {
		registerWorker({ id: "w1", status: "running" });
		registerWorker({ id: "w2", status: "completed" });
		registerWorker({ id: "w3", status: "failed" });
		expect(listWorkers()).toHaveLength(3);
	});
});

describe("workers.js: resetSlots preserves workers Map", () => {
	it("resetSlots clears slot pool and queue but keeps workers", () => {
		registerWorker({ id: "w1", status: "running", agentType: "implement" });
		registerWorker({ id: "w2", status: "completed", agentType: "explore" });

		resetSlots();

		// Workers should still be there
		expect(listWorkers()).toHaveLength(2);
		expect(getWorker("w1")).toBeDefined();
		expect(getWorker("w2")).toBeDefined();
	});
});

describe("workers.js: pruneOldWorkers", () => {
	it("removes old terminated workers beyond maxAgeMs", () => {
		const now = Date.now();
		registerWorker({ id: "old-done", status: "completed", endTime: now - 20 * 60 * 1000 });
		registerWorker({ id: "old-failed", status: "failed", endTime: now - 15 * 60 * 1000 });
		registerWorker({ id: "old-aborted", status: "aborted", endTime: now - 12 * 60 * 1000 });

		pruneOldWorkers(10 * 60 * 1000);

		const ids = listWorkers().map((w) => w.id);
		expect(ids).not.toContain("old-done");
		expect(ids).not.toContain("old-failed");
		expect(ids).not.toContain("old-aborted");
	});

	it("keeps recently terminated workers within maxAgeMs", () => {
		const now = Date.now();
		registerWorker({ id: "recent-done", status: "completed", endTime: now - 5 * 60 * 1000 });
		registerWorker({ id: "recent-failed", status: "failed", endTime: now - 2 * 60 * 1000 });

		pruneOldWorkers(10 * 60 * 1000);

		const ids = listWorkers().map((w) => w.id);
		expect(ids).toContain("recent-done");
		expect(ids).toContain("recent-failed");
	});

	it("keeps active workers regardless of age", () => {
		registerWorker({ id: "active-1", status: "running", startTime: Date.now() - 60 * 60 * 1000 });
		registerWorker({ id: "active-2", status: "spawning", startTime: Date.now() - 60 * 60 * 1000 });

		pruneOldWorkers(10 * 60 * 1000);

		expect(listWorkers()).toHaveLength(2);
	});

	it("keeps workers without endTime even if terminated", () => {
		registerWorker({ id: "no-end", status: "completed" });

		pruneOldWorkers(10 * 60 * 1000);

		expect(getWorker("no-end")).toBeDefined();
	});
});

describe("workers.js: finalizeWorker", () => {
	it("sets status to completed on success", () => {
		const id = genWorkerId();
		registerWorker({ id, status: "running" });
		finalizeWorker(id, true, null);
		const w = getWorker(id);
		expect(w.status).toBe("completed");
		expect(w.endTime).toBeTypeOf("number");
	});

	it("sets status to failed on failure with error info", () => {
		const id = genWorkerId();
		registerWorker({ id, status: "running" });
		finalizeWorker(id, false, { errorMessage: "boom", stderr: "" });
		const w = getWorker(id);
		expect(w.status).toBe("failed");
		expect(w.error).toBe("boom");
	});

	it("preserves stopReason from result", () => {
		const id = genWorkerId();
		registerWorker({ id, status: "running" });
		finalizeWorker(id, false, { stopReason: "aborted" });
		const w = getWorker(id);
		expect(w.status).toBe("failed");
		expect(w.stopReason).toBe("aborted");
	});

	it("guard: does not overwrite aborted worker", () => {
		const id = genWorkerId();
		registerWorker({ id, status: "aborted", endTime: 12345 });

		// Simulate onWorkerStop arriving after abort
		finalizeWorker(id, false, { errorMessage: "late error" });

		const w = getWorker(id);
		expect(w.status).toBe("aborted"); // not "failed"
		expect(w.endTime).toBe(12345); // not overwritten
		expect(w.error).toBeUndefined();
	});

	it("no-op for unknown worker id", () => {
		// Should not throw
		finalizeWorker("unknown-id", true, null);
	});
});
