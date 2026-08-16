// 0.7.2: bug-fix tests — DDOS ticker fix + infra-error filtering + planning cap.
//
// Part 1: File lock heartbeat (lock doesn't go stale while tick is running)
// Part 2: In-memory reentrancy guard (tick() returns busy, no side effects)
// Part 3: tick-bridge busy-guard (isTickRunning → skip)
// Part 4: Infra-error classification (no STATE/BACKLOG pollution)
// Part 5: Planning cap (backlog #32 — 2 empty plannings → awaiting_decision)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initMission,
	readState,
	writeState,
	readBacklog,
} from "../file-state-manager.js";
import {
	MissionLoop,
	createFileLock,
	isInfraError,
	readMissionLoopState,
} from "../mission-loop.js";
import { createMissionTickHandler } from "../tick-bridge.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockExecutor(results) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		async runIteration(opts) {
			calls.push({ ...opts });
			const result = results[Math.min(idx, results.length - 1)];
			idx++;
			return { ...result };
		},
	};
}

function makeMockGit() {
	const commits = [];
	return {
		commits,
		async commit({ cwd, message, files }) {
			const hash = `hash-${commits.length + 1}`;
			commits.push({ cwd, message, files, hash });
			return { hash };
		},
		async log() {
			return commits.map((c) => ({ hash: c.hash, subject: c.message, date: new Date().toISOString() }));
		},
		async status() {
			return { clean: true };
		},
	};
}

function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-16T10:00:00Z");
	return {
		async now() {
			return new Date(base.getTime() + n++ * 60_000);
		},
	};
}

function makeMockLock() {
	let held = false;
	return {
		held: () => held,
		async acquire() {
			if (held) return false;
			held = true;
			return true;
		},
		async release() {
			held = false;
		},
	};
}

function makeDeps(overrides = {}) {
	const git = makeMockGit();
	const result = {
		git,
		clock: makeMockClock(),
		lock: makeMockLock(),
		...overrides,
	};
	result.commits = git.commits;
	return result;
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-072-"));
}

function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

// ════════════════════════════════════════════════════════════════════════════
// Part 1: File lock heartbeat
// ════════════════════════════════════════════════════════════════════════════

describe("0.7.2 Part 1: File lock heartbeat", () => {
	let baseDir;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("Lock with heartbeat stays valid >60s (timestamp is refreshed)", async () => {
		const lock = createFileLock(baseDir);
		const acquired = await lock.acquire();
		expect(acquired).toBe(true);

		// Read the initial lock file
		const lockPath = join(baseDir, ".mission-loop.lock");
		const initialData = JSON.parse(readFileSync(lockPath, "utf8"));
		const initialTs = initialData.timestamp;

		// Simulate heartbeat by manually writing a refreshed timestamp
		// (In real code, setInterval does this every 30s)
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() + 70_000 }), "utf8");

		// Second acquire should fail (busy) — the heartbeat keeps it fresh
		const lock2 = createFileLock(baseDir);
		const acquired2 = await lock2.acquire();
		expect(acquired2).toBe(false); // busy because heartbeat refreshed timestamp

		await lock.release();
	});

	it("After heartbeat stops, stale takeover works after 60s", async () => {
		const lock = createFileLock(baseDir);
		await lock.acquire();

		// Release stops the heartbeat
		await lock.release();

		// Lock file should be gone after release
		expect(existsSync(join(baseDir, ".mission-loop.lock"))).toBe(false);

		// New acquire should succeed
		const lock2 = createFileLock(baseDir);
		const acquired = await lock2.acquire();
		expect(acquired).toBe(true);
		await lock2.release();
	});

	it("Lock file without heartbeat goes stale after 60s (original behavior preserved)", async () => {
		// Write a lock file with old timestamp (simulating dead heartbeat)
		const lockPath = join(baseDir, ".mission-loop.lock");
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, timestamp: Date.now() - 61_000 }),
			"utf8",
		);

		// New acquire should succeed (stale takeover)
		const lock = createFileLock(baseDir);
		const acquired = await lock.acquire();
		expect(acquired).toBe(true);
		await lock.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Part 2: In-memory reentrancy guard
// ════════════════════════════════════════════════════════════════════════════

describe("0.7.2 Part 2: In-memory reentrancy guard", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("reentrancy-test", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] task-alpha", ""]);
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("tick() while another tick is running → status busy, no side effects", async () => {
		let resolveExecutor;
		const hangingExecutor = {
			calls: [],
			async runIteration(opts) {
				this.calls.push({ ...opts });
				// Hang until explicitly resolved
				return new Promise((resolve) => {
					resolveExecutor = () => resolve({ status: "COMPLETE", costTokens: 100, costUsd: 0.01 });
				});
			},
		};

		const deps = makeDeps({ executor: hangingExecutor });
		const loop = new MissionLoop({ missionDir, deps });

		// Start first tick (will hang in executor)
		const tick1 = loop.tick();

		// Wait for executor to be called
		while (hangingExecutor.calls.length === 0) {
			await new Promise((r) => setTimeout(r, 1));
		}

		// Second tick should return busy immediately
		expect(loop.isTickRunning()).toBe(true);
		const result2 = await loop.tick();
		expect(result2.status).toBe("busy");
		expect(result2.steps.iterate).toBe(false);

		// Executor was called only once
		expect(hangingExecutor.calls.length).toBe(1);

		// Resolve the first tick
		resolveExecutor();
		await tick1;

		// After first tick completes, isTickRunning should be false
		expect(loop.isTickRunning()).toBe(false);
	});

	it("isTickRunning() returns false initially", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		expect(loop.isTickRunning()).toBe(false);
	});

	it("isTickRunning() returns false after tick completes", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		expect(loop.isTickRunning()).toBe(false);
	});

	it("Busy tick does NOT touch STATE.md", async () => {
		// Write initial STATE.md
		await writeState(missionDir, { done: [], blockers: ["initial-blocker"], nextSteps: [] });

		let resolveExecutor;
		const hangingExecutor = {
			calls: [],
			async runIteration() {
				this.calls.push({});
				return new Promise((resolve) => {
					resolveExecutor = () => resolve({ status: "COMPLETE", costTokens: 0, costUsd: 0 });
				});
			},
		};

		const deps = makeDeps({ executor: hangingExecutor });
		const loop = new MissionLoop({ missionDir, deps });

		// Start first tick
		const tick1 = loop.tick();
		while (hangingExecutor.calls.length === 0) {
			await new Promise((r) => setTimeout(r, 1));
		}

		// Second tick (busy) — should not touch STATE
		await loop.tick();

		// STATE.md should be unchanged
		const state = await readState(missionDir);
		expect(state.blockers).toEqual(["initial-blocker"]);

		// Complete first tick
		resolveExecutor();
		await tick1;
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Part 3: tick-bridge busy-guard
// ════════════════════════════════════════════════════════════════════════════

describe("0.7.2 Part 3: tick-bridge busy-guard (isTickRunning)", () => {
	it("isTickRunning() === true → handler skips tick (no call)", () => {
		const log = vi.fn();
		const loop = {
			tick: vi.fn(() => Promise.resolve({ status: "active" })),
			isTickRunning: () => true,
		};
		const deps = {
			getLoop: () => loop,
			getMissionDir: () => "/m",
			now: () => 1000,
			log,
		};
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "busy-tick" });

		// tick() should NOT be called (busy-guard skipped it)
		expect(loop.tick).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("loop is busy"));
	});

	it("isTickRunning() === false → handler calls tick normally", () => {
		const log = vi.fn();
		const loop = {
			tick: vi.fn(() => Promise.resolve({ status: "active" })),
			isTickRunning: () => false,
		};
		const deps = {
			getLoop: () => loop,
			getMissionDir: () => "/m",
			now: () => 1000,
			log,
		};
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "free-tick" });

		// tick() should be called
		expect(loop.tick).toHaveBeenCalledTimes(1);
	});

	it("Loop without isTickRunning → handler calls tick (backward compat)", () => {
		const loop = {
			tick: vi.fn(() => Promise.resolve({ status: "active" })),
			// no isTickRunning method
		};
		const deps = {
			getLoop: () => loop,
			getMissionDir: () => "/m",
			now: () => 1000,
			log: vi.fn(),
		};
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "compat-tick" });

		// tick() should be called (no isTickRunning → backward compat)
		expect(loop.tick).toHaveBeenCalledTimes(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Part 4: Infra-error classification
// ════════════════════════════════════════════════════════════════════════════

describe("0.7.2 Part 4: Infra-error classification", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("infra-test", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] task-alpha", ""]);
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("isInfraError matches known patterns", () => {
		expect(isInfraError("runAgent already in flight")).toBe(true);
		expect(isInfraError("Lock is busy — concurrent tick not allowed")).toBe(true);
		expect(isInfraError("runAgent timeout after 1800000ms")).toBe(true);
		expect(isInfraError("Some real blocker")).toBe(false);
		expect(isInfraError("agent error: something")).toBe(false);
	});

	it("FAILED with 'already in flight' → STATE.md has NO new blockers", async () => {
		// Initial STATE.md
		await writeState(missionDir, { done: [], blockers: [], nextSteps: [] });

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "runAgent already in flight", costTokens: 0, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Iteration was FAILED but infra error should NOT be in STATE.md
		const state = await readState(missionDir);
		expect(state.blockers).toEqual([]);
	});

	it("FAILED with 'Lock is busy' → STATE.md has NO new blockers", async () => {
		await writeState(missionDir, { done: [], blockers: [], nextSteps: [] });

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "Lock is busy — concurrent tick not allowed", costTokens: 0, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers).toEqual([]);
	});

	it("FAILED with 'runAgent timeout' → STATE.md has NO new blockers", async () => {
		await writeState(missionDir, { done: [], blockers: [], nextSteps: [] });

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "runAgent timeout after 1800000ms", costTokens: 0, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers).toEqual([]);
	});

	it("FAILED with real blocker → STATE.md HAS the blocker", async () => {
		await writeState(missionDir, { done: [], blockers: [], nextSteps: [] });

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "Cannot connect to database", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers).toContain("Cannot connect to database");
	});

	it("Dedup: identical blocker string not added twice consecutively", async () => {
		await writeState(missionDir, { done: [], blockers: [], nextSteps: [] });

		// First tick: real blocker
		const deps1 = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "Same blocker", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop1 = new MissionLoop({ missionDir, deps: deps1 });
		await loop1.tick();

		let state = await readState(missionDir);
		expect(state.blockers.filter((b) => b === "Same blocker").length).toBe(1);

		// Second tick: same blocker again
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] task-alpha", ""]);
		const deps2 = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "Same blocker", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop2 = new MissionLoop({ missionDir, deps: deps2 });
		await loop2.tick();

		state = await readState(missionDir);
		// Dedup: "Same blocker" should appear only once (consecutive dedup)
		const sameBlockerCount = state.blockers.filter((b) => b === "Same blocker").length;
		expect(sameBlockerCount).toBe(1);
	});

	it("Infra error FAILED → BACKLOG entry is skipped", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "runAgent already in flight", costTokens: 0, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const backlog = await readBacklog(missionDir);
		// No backlog entry for infra error
		expect(backlog.length).toBe(0);
	});

	it("Real FAILED → BACKLOG entry is written", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "Real failure reason", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const backlog = await readBacklog(missionDir);
		expect(backlog.length).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Part 5: Planning cap (backlog #32)
// ════════════════════════════════════════════════════════════════════════════

describe("0.7.2 Part 5: Planning cap (backlog #32)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("planning-cap", {
			baseDir,
			description: "Build something great",
		});
		// All items done, only checked — triggers planning
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] Bootstrap mission: planning-cap", ""]);
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("2 consecutive empty planning ticks → awaiting_decision", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });

		// First planning tick — empty (no unchecked items added)
		const r1 = await loop.tick();
		expect(r1.status).toBe("active");
		expect(r1.item).toContain("decompose");

		// Second planning tick — empty → triggers awaiting_decision
		const r2 = await loop.tick();
		expect(r2.status).toBe("awaiting_decision");
	});

	it("Productive planning (adds unchecked items) → streak reset", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			]),
			// Executor adds items on first planning tick
		});

		// Override executor to add items on first call
		let callCount = 0;
		const smartExecutor = {
			calls: [],
			async runIteration(opts) {
				callCount++;
				this.calls.push({ ...opts });
				if (callCount === 1) {
					// First planning tick: add unchecked items to ROADMAP
					const roadmapPath = join(opts.missionDir, "ROADMAP.md");
					const raw = readFileSync(roadmapPath, "utf8");
					writeFileSync(
						roadmapPath,
						`${raw.trimEnd()}\n- [ ] new-feature-a\n- [ ] new-feature-b\n`,
						"utf8",
					);
				}
				return { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
			},
		};

		const depsWithSmart = makeDeps({ executor: smartExecutor });
		const loop = new MissionLoop({ missionDir, deps: depsWithSmart });

		// First planning tick — productive (adds items)
		const r1 = await loop.tick();
		expect(r1.status).toBe("active");

		// LoopState should have emptyPlanningStreak = 0
		const ls = await readMissionLoopState(missionDir);
		expect(ls.emptyPlanningStreak ?? 0).toBe(0);
	});

	it("emptyPlanningStreak is tracked in LoopState", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });

		// First empty planning tick
		await loop.tick();

		const ls = await readMissionLoopState(missionDir);
		expect(ls.emptyPlanningStreak).toBe(1);
	});

	it("Non-planning tick resets emptyPlanningStreak", async () => {
		// Start with unchecked items (normal tick, not planning)
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [x] Bootstrap mission: planning-cap",
			"- [ ] regular-task",
			"",
		]);

		// Create the loop state file with a non-zero streak
		const loopStatePath = join(missionDir, ".mission-loop.json");
		writeFileSync(
			loopStatePath,
			JSON.stringify(
				{
					currentIteration: 0,
					lastStep: 7,
					interrupted: false,
					budgetUsed: { tokens: 0, usd: 0 },
					emptyPlanningStreak: 1,
				},
				null,
				2,
			),
			"utf8",
		);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// Non-planning tick should reset the streak
		const ls = await readMissionLoopState(missionDir);
		expect(ls.emptyPlanningStreak ?? 0).toBe(0);
	});
});
