// F-09 deep-fix tests: P0-1..P2-9
//
// Coverage:
//   P0-1: Recovery probes for EACH crash point (after step 3, 4, 5, mid-6)
//   P0-2: Abort mid-tick (no commit, status aborted)
//   P0-3: Step 6 ordering (commit contains [x]), dedup done-entries
//   P1-4: budget_usd enforcement
//   P1-5: STATE.md auto-archiving, failed when archiving impossible
//   P1-6: File-lock (second process denied, stale lock taken over)
//   P2-7: Budget preflight (executor not called), post-hoc fix preserves result
//   P2-8: writeMissionStatus CRLF preservation
//   P2-9: Refactor (covered by all tests passing)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ARCHIVE_KEEP_COUNT,
	archiveOldDoneItems,
	checkStateFileSize,
	initMission,
	MAX_STATE_BYTES,
	readState,
	writeState,
} from "../file-state-manager.js";

import {
	MissionLoop,
	createFileLock,
	readMissionLoopState,
} from "../mission-loop.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockExecutor(iterationResults) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		async runIteration(opts) {
			calls.push({ ...opts });
			const result = iterationResults[Math.min(idx, iterationResults.length - 1)];
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
			const hash = `hash-${commits.length + 1}-${Date.now().toString(36)}`;
			commits.push({ cwd, message, files, hash });
			return { hash };
		},
		async log() {
			return commits.map((c) => ({
				hash: c.hash, subject: c.message, date: new Date().toISOString(),
			}));
		},
		async status() { return { clean: true }; },
	};
}

function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-10T10:00:00Z");
	return { async now() { return new Date(base.getTime() + n++ * 60_000); } };
}

function makeMockLock() {
	let held = false;
	return {
		held: () => held,
		async acquire() { if (held) return false; held = true; return true; },
		async release() { held = false; },
	};
}

function makeDeps(overrides = {}) {
	const git = makeMockGit();
	const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "iter: tick" }]);
	const clock = makeMockClock();
	const lock = makeMockLock();
	return {
		executor, git, clock, lock,
		commits: git.commits,
		executorCalls: executor.calls,
		...overrides,
	};
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-f09-deep-"));
}

function writeRoadmapFile(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

function writeLoopState(missionDir, state) {
	writeFileSync(
		join(missionDir, ".mission-loop.json"),
		JSON.stringify({
			currentIteration: 0, lastStep: 0, interrupted: false,
			budgetUsed: { tokens: 0, usd: 0 }, ...state,
		}, null, 2), "utf8",
	);
}

function setBudgetTokens(missionDir, tokens) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	writeFileSync(join(missionDir, "MISSION.md"),
		raw.replace(/budget_tokens:\s*\d+/, `budget_tokens: ${tokens}`), "utf8");
}

function setBudgetUsd(missionDir, usd) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	writeFileSync(join(missionDir, "MISSION.md"),
		raw.replace(/budget_usd:\s*[\d.]+/, `budget_usd: ${usd}`), "utf8");
}

// ════════════════════════════════════════════════════════════════════════════
// P0-1: Recovery probes for EACH crash point
// ════════════════════════════════════════════════════════════════════════════

describe("P0-1: Recovery probes for each crash point", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("recovery-deep", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [ ] task-alpha", "- [ ] task-beta", "",
		]);
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("Crash after step 3 (decide done, iterate NOT run) → redo iteration", async () => {
		// Simulate: lastStep=3, interrupted=true, no iterationResult
		writeLoopState(missionDir, {
			currentIteration: 1, lastStep: 3, interrupted: true,
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: recovery + continuous loop → both items processed
		expect(deps.executorCalls.length).toBe(2);
		expect(result.steps.iterate).toBe(true);
		expect(result.steps.commit).toBe(true);
		expect(result.steps.backlog).toBe(true);
		expect(result.status).toBe("completed");
		expect(result.itemsExecuted).toBe(2);

		// Verify loop state
		const ls = await readMissionLoopState(missionDir);
		expect(ls.lastStep).toBe(3); // ended at "all done" decision
		expect(ls.interrupted).toBe(false);
	});

	it("Crash after step 4 with saved result → skip executor, continue from step 5", async () => {
		// Simulate: lastStep=4, interrupted=true, iterationResult saved
		writeLoopState(missionDir, {
			currentIteration: 1, lastStep: 4, interrupted: true,
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			pendingItem: "task-alpha", pendingItemIndex: 2, committed: false,
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: recovery skips executor for task-alpha, but continuous loop processes task-beta
		expect(deps.executorCalls.length).toBe(1);
		// iterate step is skipped for recovered item
		expect(result.steps.iterate).toBe(true); // true because task-beta runs iterate
		expect(result.steps.commit).toBe(true);
		expect(result.steps.backlog).toBe(true);
		expect(result.status).toBe("completed");
		expect(result.itemsExecuted).toBe(2);

		// STATE.md should have both done entries
		const state = await readState(missionDir);
		expect(state.done).toContain("task-alpha");
		expect(state.done).toContain("task-beta");

		// Git commits for both items
		expect(deps.commits.length).toBe(2);

		// Loop state
		const ls = await readMissionLoopState(missionDir);
		expect(ls.lastStep).toBe(3); // ended at "all done"
		expect(ls.interrupted).toBe(false);
		expect(ls.iterationResult).toBeUndefined();
	});

	it("Crash after step 5 (verify done, commit NOT done) → do commit", async () => {
		writeLoopState(missionDir, {
			currentIteration: 1, lastStep: 5, interrupted: true,
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			pendingItem: "task-alpha", pendingItemIndex: 2, committed: false,
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: recovery commits task-alpha, then continuous loop processes task-beta
		expect(deps.executorCalls.length).toBe(1);
		expect(result.steps.iterate).toBe(true); // task-beta runs iterate
		expect(result.steps.commit).toBe(true);
		expect(deps.commits.length).toBe(2);
		expect(result.itemsExecuted).toBe(2);

		const state = await readState(missionDir);
		expect(state.done).toContain("task-alpha");
		expect(state.done).toContain("task-beta");
	});

	it("Crash mid-step 6 (commit done, journal not advanced) → redo executor, idempotent commit", async () => {
		// Simulate: commit succeeded for task-alpha but journal didn't advance.
		// Step 6 clears iterationResult BEFORE advancing lastStep,
		// so the journal has no saved result. Next unchecked is task-beta.
		writeLoopState(missionDir, {
			currentIteration: 1, lastStep: 5, interrupted: true,
			budgetUsed: { tokens: 100, usd: 0.01 },
		});
		// Pre-write STATE.md and ROADMAP as if commit happened
		await writeState(missionDir, {
			done: ["task-alpha"], blockers: [], nextSteps: [],
		});
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [x] task-alpha", "- [ ] task-beta", "",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Executor IS called (no saved result) — processes task-beta
		expect(deps.executorCalls.length).toBe(1);
		expect(result.steps.iterate).toBe(true);
		// Step 6 runs — commits task-beta (different item, not a duplicate)
		expect(result.steps.commit).toBe(true);
		expect(deps.commits.length).toBe(1); // new commit for task-beta
		// Backlog runs
		expect(result.steps.backlog).toBe(true);

		// STATE.md: task-alpha not duplicated, task-beta added
		const state = await readState(missionDir);
		expect(state.done.filter((d) => d === "task-alpha")).toHaveLength(1);
		expect(state.done).toContain("task-beta");
	});

	it("Crash after step 7 (completed tick) → new iteration on next tick", async () => {
		writeLoopState(missionDir, {
			currentIteration: 1, lastStep: 7, interrupted: true,
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Since lastStep=7, recovery skips to backlog (resumeFromStep=8 > 6)
		// No executor call for the recovered iteration
		expect(deps.executorCalls.length).toBe(0);
		expect(result.steps.backlog).toBe(true);

		// Next tick should be a fresh iteration for task-beta
		const deps2 = makeDeps();
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [x] task-alpha", "- [ ] task-beta", "",
		]);
		await writeState(missionDir, {
			done: ["task-alpha"], blockers: [], nextSteps: [],
		});
		const loop2 = new MissionLoop({ missionDir, deps: deps2 });
		const result2 = await loop2.tick();
		expect(deps2.executorCalls.length).toBe(1);
		expect(result2.iteration).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P0-2: Abort mid-tick
// ════════════════════════════════════════════════════════════════════════════

describe("P0-2: Abort mid-tick", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("abort-deep", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("abort() before tick → tick returns aborted, no executor call", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		const result = await loop.tick();
		expect(result.status).toBe("aborted");
		expect(deps.executorCalls.length).toBe(0);
	});

	it("abort() during tick (executor checks abort signal) → no commit, status aborted", async () => {
		// Create an executor that triggers abort mid-execution
		const abortLoop = { ref: null };
		const executor = {
			calls: [],
			async runIteration(opts) {
				executor.calls.push(opts);
				// Trigger abort while "running"
				if (abortLoop.ref) await abortLoop.ref.abort();
				return { status: "COMPLETE", costTokens: 10 };
			},
		};

		const deps = {
			executor, git: makeMockGit(),
			clock: makeMockClock(), lock: makeMockLock(),
		};
		const loop = new MissionLoop({ missionDir, deps });
		abortLoop.ref = loop;

		const result = await loop.tick();

		// Status should be aborted
		expect(result.status).toBe("aborted");
		expect(result.interrupted).toBe(true);
		// No git commit (abort prevents commit)
		expect(deps.git.commits.length).toBe(0);
		// STATE.md should NOT have done-entry
		const state = await readState(missionDir);
		expect(state.done).not.toContain("work item");
	});

	it("abort signal file is cleaned up after abort tick", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		await loop.tick(); // processes abort

		// Signal file should be gone
		const signalPath = join(missionDir, ".mission-abort-signal");
		expect(existsSync(signalPath)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P0-3: Step 6 ordering + dedup
// ════════════════════════════════════════════════════════════════════════════

describe("P0-3: Step 6 ordering and dedup", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("step6-deep", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] feature-x", ""]);
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("Git commit includes both STATE.md and ROADMAP.md", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		expect(deps.commits.length).toBe(1);
		expect(deps.commits[0].files).toContain("STATE.md");
		expect(deps.commits[0].files).toContain("ROADMAP.md");
	});

	it("Roadmap [x] is set before git commit", async () => {
		// Use a git mock that captures roadmap content at commit time
		let roadmapAtCommit = "";
		const git = {
			commits: [],
			async commit({ cwd, message, files }) {
				roadmapAtCommit = readFileSync(join(cwd, "ROADMAP.md"), "utf8");
				const hash = `hash-${this.commits.length + 1}`;
				this.commits.push({ cwd, message, files, hash });
				return { hash };
			},
			async log() { return []; },
			async status() { return { clean: true }; },
		};

		const deps = {
			executor: makeMockExecutor([{ status: "COMPLETE" }]),
			git, clock: makeMockClock(), lock: makeMockLock(),
		};
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// At commit time, roadmap should already have [x]
		expect(roadmapAtCommit).toContain("- [x] feature-x");
	});

	it("Dedup: done-entry not added twice if already present", async () => {
		// Pre-populate STATE.md with the done entry
		await writeState(missionDir, {
			done: ["feature-x"], blockers: [], nextSteps: [],
		});
		// Mark roadmap as already checked
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [x] feature-x", "- [ ] next-thing", ""]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Should work on next-thing, not re-add feature-x
		const state = await readState(missionDir);
		expect(state.done.filter((d) => d === "feature-x")).toHaveLength(1);
		// next-thing should now be done
		expect(state.done).toContain("next-thing");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P1-4: budget_usd enforcement
// ════════════════════════════════════════════════════════════════════════════

describe("P1-4: budget_usd enforcement", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("budget-usd-deep", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work", ""]);
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("USD budget exceeded → budget_exhausted", async () => {
		setBudgetUsd(missionDir, "0.05");

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 10, costUsd: 0.10 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*budget_exhausted/);
	});

	it("Both tokens and USD checked — either exceeding triggers budget_exhausted", async () => {
		setBudgetTokens(missionDir, 1000);
		setBudgetUsd(missionDir, "1.00");

		// Tokens OK, USD exceeded
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 2.00 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P1-5: STATE.md auto-archiving
// ════════════════════════════════════════════════════════════════════════════

describe("P1-5: STATE.md overflow and auto-archiving", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("overflow-deep", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] new-task", ""]);
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("archiveOldDoneItems moves old items to ARCHIVE.md, keeps recent N", async () => {
		// Create STATE.md with more than ARCHIVE_KEEP_COUNT done items
		const items = Array.from({ length: 15 }, (_, i) => `item-${i}`);
		await writeState(missionDir, { done: items, blockers: [], nextSteps: [] });

		const archived = await archiveOldDoneItems(missionDir, ARCHIVE_KEEP_COUNT);
		expect(archived).toBe(true);

		// STATE.md should have only ARCHIVE_KEEP_COUNT items
		const state = await readState(missionDir);
		expect(state.done.length).toBe(ARCHIVE_KEEP_COUNT);
		// Kept items are the LAST N
		expect(state.done[0]).toBe(`item-${15 - ARCHIVE_KEEP_COUNT}`);
		expect(state.done[state.done.length - 1]).toBe("item-14");

		// ARCHIVE.md should exist with old items
		const archiveRaw = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");
		expect(archiveRaw).toContain("item-0");
		expect(archiveRaw).toContain(`item-${15 - ARCHIVE_KEEP_COUNT - 1}`);
		expect(archiveRaw).not.toContain(`item-${15 - ARCHIVE_KEEP_COUNT}`);
	});

	it("archiveOldDoneItems returns false when nothing to archive", async () => {
		await writeState(missionDir, { done: ["a", "b"], blockers: [], nextSteps: [] });
		const archived = await archiveOldDoneItems(missionDir, ARCHIVE_KEEP_COUNT);
		expect(archived).toBe(false);
	});

	it("Tick with oversized STATE.md → auto-archive and continue", async () => {
		// Make STATE.md over 5KB: 100 items × ~55 bytes each ≈ 5500 bytes + header
		// After archiving (keep 10): 10 × ~55 = ~600 bytes — well under limit
		const items = Array.from({ length: 100 }, (_, i) =>
			`task-${String(i).padStart(3, "0")}-with-sufficient-padding-data-to-reach-limit`,
		);
		// Write directly (bypassing writeState's size check — the file is INTENTIONALLY oversized)
		const lines = ["## Сделано"];
		for (const item of items) lines.push(`- ${item}`);
		lines.push("", "## Блокеры", "", "## Следующие шаги", "");
		writeFileSync(join(missionDir, "STATE.md"), lines.join("\n"), "utf8");

		// Verify STATE.md is over limit
		const sizeBefore = checkStateFileSize(missionDir);
		expect(sizeBefore).toBeGreaterThanOrEqual(MAX_STATE_BYTES);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Should succeed (archived old items, then continued)
		// 0.8.0: single item processed → completed
		expect(result.status).toBe("completed");
		expect(result.steps.iterate).toBe(true);
		expect(result.itemsExecuted).toBe(1);

		// STATE.md should now be under limit
		const sizeAfter = checkStateFileSize(missionDir);
		expect(sizeAfter).toBeLessThan(MAX_STATE_BYTES);

		// ARCHIVE.md should exist
		expect(existsSync(join(missionDir, "ARCHIVE.md"))).toBe(true);
	});

	it("Tick with oversized STATE.md and no done items → status failed", async () => {
		// Create STATE.md over 5KB with no list items to archive (just padding)
		const padding = "x".repeat(MAX_STATE_BYTES + 100);
		writeFileSync(join(missionDir, "STATE.md"),
			`## Сделано\n${padding}\n## Блокеры\n\n## Следующие шаги\n`, "utf8");

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Should fail because archiving is impossible (no done items)
		expect(result.status).toBe("failed");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P1-6: File-lock
// ════════════════════════════════════════════════════════════════════════════

describe("P1-6: File-lock (createFileLock)", () => {
	let baseDir;

	beforeEach(() => { baseDir = freshBaseDir(); });
	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("First acquire succeeds, second fails (same process)", async () => {
		const lock1 = createFileLock(baseDir);
		const lock2 = createFileLock(baseDir);

		expect(await lock1.acquire()).toBe(true);
		expect(await lock2.acquire()).toBe(false); // busy

		await lock1.release();
		expect(await lock2.acquire()).toBe(true); // now available
		await lock2.release();
	});

	it("Stale lock (old timestamp) is taken over", async () => {
		// Write a lock file with an old timestamp
		writeFileSync(join(baseDir, ".mission-loop.lock"),
			JSON.stringify({ pid: 99999, timestamp: Date.now() - 120_000 }), "utf8");

		const lock = createFileLock(baseDir);
		expect(await lock.acquire()).toBe(true); // took over stale lock
		await lock.release();
	});

	it("Release removes lock file", async () => {
		const lock = createFileLock(baseDir);
		await lock.acquire();
		expect(existsSync(join(baseDir, ".mission-loop.lock"))).toBe(true);

		await lock.release();
		expect(existsSync(join(baseDir, ".mission-loop.lock"))).toBe(false);
	});

	it("MissionLoop uses createFileLock by default when deps.lock is not provided", async () => {
		const missionDir = await initMission("lock-default", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work", ""]);

		// Create deps WITHOUT lock
		const deps = {
			executor: makeMockExecutor([{ status: "COMPLETE" }]),
			git: makeMockGit(),
			clock: makeMockClock(),
			// no lock!
		};

		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Should work fine with default file-lock
		expect(result.steps.iterate).toBe(true);
		// 0.8.0: single item → completed
		expect(result.status).toBe("completed");

		// Lock file should be cleaned up
		expect(existsSync(join(missionDir, ".mission-loop.lock"))).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P2-7: Budget preflight + post-hoc fix
// ════════════════════════════════════════════════════════════════════════════

describe("P2-7: Budget preflight and post-hoc result preservation", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("budget-preflight", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [ ] task-1", "- [ ] task-2", "",
		]);
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("Preflight: tokens already exhausted → no executor call", async () => {
		setBudgetTokens(missionDir, 100);

		// Pre-populate journal with 100 tokens used
		writeLoopState(missionDir, {
			budgetUsed: { tokens: 100, usd: 0 },
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		expect(deps.executorCalls.length).toBe(0);
	});

	it("Preflight: USD already exhausted → no executor call", async () => {
		setBudgetUsd(missionDir, "1.00");

		writeLoopState(missionDir, {
			budgetUsed: { tokens: 0, usd: 1.50 },
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		expect(deps.executorCalls.length).toBe(0);
	});

	it("Post-hoc: successful iteration + budget exceeded → result committed, then budget_exhausted", async () => {
		setBudgetTokens(missionDir, 100);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 150, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Result should be committed (work not lost)
		expect(deps.commits.length).toBe(1);
		const state = await readState(missionDir);
		expect(state.done).toContain("task-1");

		// But status is budget_exhausted
		expect(result.status).toBe("budget_exhausted");

		// MISSION.md updated
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*budget_exhausted/);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P2-8: writeMissionStatus CRLF preservation
// ════════════════════════════════════════════════════════════════════════════

describe("P2-8: writeMissionStatus CRLF preservation", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("crlf-test", { baseDir });
	});

	afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

	it("CRLF file → CRLF preserved after status change", async () => {
		// Rewrite MISSION.md with CRLF line endings
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const crlfContent = raw.replace(/\n/g, "\r\n");
		writeFileSync(join(missionDir, "MISSION.md"), crlfContent, "utf8");

		// Verify it has CRLF
		const beforeRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(beforeRaw).toContain("\r\n");

		// Import and call writeMissionStatus
		const { writeMissionStatus } = await import("../file-state-manager.js");
		await writeMissionStatus(missionDir, "completed");

		// CRLF should be preserved
		const afterRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(afterRaw).toContain("\r\n");
		expect(afterRaw).toMatch(/status:\s*completed/);
	});

	it("LF file → LF preserved after status change", async () => {
		// Ensure LF-only
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const lfContent = raw.replace(/\r\n/g, "\n");
		writeFileSync(join(missionDir, "MISSION.md"), lfContent, "utf8");

		const { writeMissionStatus } = await import("../file-state-manager.js");
		await writeMissionStatus(missionDir, "aborted");

		const afterRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(afterRaw).not.toContain("\r\n");
		expect(afterRaw).toMatch(/status:\s*aborted/);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Integration: multiple ticks with all features
// ════════════════════════════════════════════════════════════════════════════

describe("Integration: full scenario with deep-fix features", () => {
	it("3 ticks → recovery mid-way → completes", async () => {
		const baseDir = freshBaseDir();
		const missionDir = await initMission("integration", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [ ] task-a", "- [ ] task-b", "- [ ] task-c", "",
		]);

		try {
			// 0.8.0: Simulate crash after step 4 of tick 1 (task-a recovered from journal)
			writeLoopState(missionDir, {
				currentIteration: 1, lastStep: 4, interrupted: true,
				iterationResult: { status: "COMPLETE", costTokens: 50, costUsd: 0.005 },
				pendingItem: "task-a", pendingItemIndex: 2, committed: false,
				budgetUsed: { tokens: 50, usd: 0.005 },
			});

			// Tick 1: recovery skips executor for task-a, continuous loop processes task-b and task-c
			const deps1 = makeDeps();
			const loop1 = new MissionLoop({ missionDir, deps: deps1 });
			const r1 = await loop1.tick();
			expect(r1.itemsExecuted).toBe(3);
			expect(deps1.executorCalls.length).toBe(2); // task-b + task-c (task-a recovered)
			expect(r1.status).toBe("completed");

			// All 3 items done
			const state = await readState(missionDir);
			expect(state.done).toContain("task-a");
			expect(state.done).toContain("task-b");
			expect(state.done).toContain("task-c");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
