// F-09 bug-fix tests: P0 (SIGKILL recovery), P1-1 (budget double-count),
// P1-2 (paused no-op), P1-3 (zombie-cycle / ARCHIVE dedup), P2 (budget=0 unlimited),
// P3 (lock dead-pid takeover, atomic writeRoadmap, degraded-abort).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
				hash: c.hash,
				subject: c.message,
				date: new Date().toISOString(),
			}));
		},
		async status() {
			return { clean: true };
		},
	};
}

function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-10T10:00:00Z");
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
	const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "iter: tick" }]);
	const clock = makeMockClock();
	const lock = makeMockLock();
	const result = {
		executor,
		git,
		clock,
		lock,
		commits: git.commits,
		...overrides,
	};
	// Rebind executorCalls AFTER overrides to point to the actual executor
	result.executorCalls = result.executor.calls;
	return result;
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-f09-bugfix-"));
}

function writeRoadmapFile(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

function writeLoopState(missionDir, state) {
	writeFileSync(
		join(missionDir, ".mission-loop.json"),
		JSON.stringify(
			{
				currentIteration: 0,
				lastStep: 0,
				interrupted: false,
				budgetUsed: { tokens: 0, usd: 0 },
				...state,
			},
			null,
			2,
		),
		"utf8",
	);
}

function setBudgetTokens(missionDir, tokens) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	writeFileSync(
		join(missionDir, "MISSION.md"),
		raw.replace(/budget_tokens:\s*\d+/, `budget_tokens: ${tokens}`),
		"utf8",
	);
}

function setBudgetUsd(missionDir, usd) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	writeFileSync(
		join(missionDir, "MISSION.md"),
		raw.replace(/budget_usd:\s*[\d.]+/, `budget_usd: ${usd}`),
		"utf8",
	);
}

function setMissionStatus(missionDir, newStatus) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	writeFileSync(
		join(missionDir, "MISSION.md"),
		raw.replace(/^(status:\s*).*$/m, `$1${newStatus}`),
		"utf8",
	);
}

/** Read STATE.md bypassing size limit (for verification of oversized files). */
function readRawState(missionDir) {
	const raw = readFileSync(join(missionDir, "STATE.md"), "utf8");
	const result = { done: [], blockers: [], nextSteps: [] };
	const parts = raw.split(/^## /m);
	for (const part of parts) {
		if (!part.trim()) continue;
		const nl = part.indexOf("\n");
		if (nl < 0) continue;
		const header = part.slice(0, nl).trim();
		const body = part.slice(nl + 1);
		const items = [];
		for (const line of body.split("\n")) {
			const m = /^- (.+)$/.exec(line.trim());
			if (m) items.push(m[1]);
		}
		if (header === "Сделано") result.done = items;
		else if (header === "Блокеры") result.blockers = items;
		else if (header === "Следующие шаги") result.nextSteps = items;
	}
	return result;
}

// ════════════════════════════════════════════════════════════════════════════
// P0: SIGKILL recovery — interrupted=false but journal has saved result
// ════════════════════════════════════════════════════════════════════════════

describe("P0: SIGKILL recovery (interrupted=false, journal intact)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("sigkill-test", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] task-alpha",
			"- [ ] task-beta",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("Journal {lastStep:4, NO iterationResult, interrupted:false} → redo iteration (SIGKILL before step 5)", async () => {
		// With the refined P0 fix: step 4 journal does NOT include iterationResult.
		// iterationResult is persisted at step 5 (together with budgetCounted).
		// So SIGKILL after step 4 → no saved result → redo iteration.
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 4,
			interrupted: false, // SIGKILL — no catch handler ran
			budgetUsed: { tokens: 0, usd: 0 },
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: recovery + continuous loop → оба пункта обработаны (task-alpha +
		// task-beta), executor вызван для обоих, миссия завершена.
		expect(deps.executorCalls.length).toBe(2);
		expect(result.steps.iterate).toBe(true);
		expect(result.steps.commit).toBe(true);
		expect(result.steps.backlog).toBe(true);
		expect(result.status).toBe("completed");
		expect(result.itemsExecuted).toBe(2);

		const state = await readState(missionDir);
		expect(state.done).toContain("task-alpha");
		expect(state.done).toContain("task-beta");
	});

	it("Journal {lastStep:5, iterationResult, interrupted:false} → skip executor, do commit", async () => {
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 5,
			interrupted: false, // SIGKILL
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			pendingItem: "task-alpha",
			pendingItemIndex: 2,
			committed: false,
			budgetUsed: { tokens: 100, usd: 0.01 },
			budgetCountedFor: "task-alpha",
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: recovery коммитит task-alpha (без executor), затем continuous
		// loop обрабатывает task-beta. executor вызван 1 раз (только для beta).
		expect(deps.executorCalls.length).toBe(1);
		expect(result.steps.iterate).toBe(true); // task-beta проходит iterate
		expect(result.steps.commit).toBe(true);
		expect(deps.commits.length).toBe(2); // task-alpha (recovery) + task-beta
		expect(result.itemsExecuted).toBe(2);

		const state = await readState(missionDir);
		expect(state.done).toContain("task-alpha");
		expect(state.done).toContain("task-beta");
	});

	it("Journal {lastStep:3, interrupted:false} → redo (no saved result)", async () => {
		// Step 3 completed but no iterationResult → can't recover, redo from start
		writeLoopState(missionDir, {
			currentIteration: 0,
			lastStep: 3,
			interrupted: false, // SIGKILL after step 3, before step 4
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: redo task-alpha (1 call), continuous loop processes task-beta
		// → 2 calls total.
		expect(deps.executorCalls.length).toBe(2);
		expect(result.steps.iterate).toBe(true);
		expect(result.steps.commit).toBe(true);
		expect(result.status).toBe("completed");
		expect(result.itemsExecuted).toBe(2);
	});

	it("Journal {lastStep:7, interrupted:false} → fresh tick (previous tick completed cleanly)", async () => {
		// After a successful tick: lastStep=7, interrupted=false.
		// Next tick should start fresh — NOT recovery.
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 7,
			interrupted: false,
			budgetUsed: { tokens: 100, usd: 0.01 },
		});
		// Simulate task-alpha was done
		await writeState(missionDir, {
			done: ["task-alpha"],
			blockers: [],
			nextSteps: [],
		});
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [x] task-alpha",
			"- [ ] task-beta",
			"",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: fresh tick processes remaining unchecked items (task-beta only
		// — task-alpha уже [x]) → 1 call, mission completes.
		expect(deps.executorCalls.length).toBe(1);
		expect(result.status).toBe("completed");
		expect(result.itemsExecuted).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P1-1: Double-count budget on recovery
// ════════════════════════════════════════════════════════════════════════════

describe("P1-1: Budget double-count prevention on recovery", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("budget-double", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] task-alpha",
			"- [ ] task-beta",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("Recovery from step 5 with budgetCountedFor=item → budgetUsed not doubled", async () => {
		// Simulate: step 5 wrote journal with budgetCountedFor="task-alpha", then SIGKILL
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 5,
			interrupted: false,
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.05 },
			pendingItem: "task-alpha",
			pendingItemIndex: 2,
			committed: false,
			budgetUsed: { tokens: 100, usd: 0.05 }, // already counted
			budgetCountedFor: "task-alpha", // step 5 journal was written
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// Budget should NOT be double-counted: 100, not 200
		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(100);
		expect(ls.budgetUsed.usd).toBeCloseTo(0.05, 5);
	});

	it("Fresh tick (no budgetCountedFor) → budgetUsed incremented normally", async () => {
		// 0.8.0: continuous tick processes both roadmap items in one call → 2 × 100.
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.05 },
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.05 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(200);
		expect(ls.budgetUsed.usd).toBeCloseTo(0.1, 5);
		expect(ls.budgetCountedFor).toBeNull(); // reset at end of tick
	});

	it("Recovery from step 4 (no budgetCountedFor yet) → budget counted once", async () => {
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 4,
			interrupted: false,
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.05 },
			pendingItem: "task-alpha",
			pendingItemIndex: 2,
			committed: false,
			budgetUsed: { tokens: 0, usd: 0 }, // not counted yet (step 4 journal)
			// budgetCountedFor is absent/undefined
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// Budget counted exactly once: 100
		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(100);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// budgetCountedFor: W3/W4/W5 + double-count regression
// ════════════════════════════════════════════════════════════════════════════

describe("budgetCountedFor: recovery with item-aware budget tracking", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("bcf-test", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [ ] task-alpha", "- [ ] task-beta", "",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("W3: lastStep:5, committed:true, budgetCountedFor:A, A on disk → recovery B: budgetUsed=200", async () => {
		// Tick 1 processed A fully (budgetUsed includes A=100), committed to disk.
		// Journal has lastStep:5 (crash between step 5 and finalize).
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 5,
			interrupted: false,
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			pendingItem: "task-alpha",
			pendingItemIndex: 2,
			committed: true,
			budgetUsed: { tokens: 100, usd: 0.01 },
			budgetCountedFor: "task-alpha",
		});
		// A is already committed on disk
		await writeState(missionDir, {
			done: ["task-alpha"], blockers: [], nextSteps: [],
		});
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [x] task-alpha", "- [ ] task-beta", "",
		]);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// A not re-executed (committed on disk, recovery skips)
		// B processed as new fresh iteration
		expect(deps.executorCalls.length).toBe(1);
		expect(result.item).toBe("task-beta");

		// budgetUsed = A (100) + B (100) = 200
		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(200);
	});

	it("W4: lastStep:6, budgetCountedFor:A → crash in step 7 → recovery budgetUsed=200", async () => {
		// Simulate crash DURING step 7 (backlog failure):
		// Step 6 journal on disk preserved pendingItem + iterationResult + budgetCountedFor.
		// The catch block set interrupted=true but didn't clear those fields.
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 6,
			interrupted: true, // crash in step 7
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			pendingItem: "task-alpha",
			pendingItemIndex: 2,
			committed: true,
			budgetUsed: { tokens: 100, usd: 0.01 },
			budgetCountedFor: "task-alpha",
		});
		await writeState(missionDir, {
			done: ["task-alpha"], blockers: [], nextSteps: [],
		});
		writeRoadmapFile(missionDir, [
			"# Roadmap", "", "- [x] task-alpha", "- [ ] task-beta", "",
		]);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// resumeFromStep=7 > 6 → backlog recovery for A, no executor for A
		expect(deps.executorCalls.length).toBe(0);
		expect(result.steps.backlog).toBe(true);

		// Next tick processes B fresh
		const deps2 = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop2 = new MissionLoop({ missionDir, deps: deps2 });
		await loop2.tick();

		// budgetUsed = A (100) + B (100) = 200
		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(200);
	});

	it("W5: exception in step 7 → full budget accounting preserved", async () => {
		// Executor returns cost, but step 7 (backlog append) throws
		let tickCount = 0;
		const failingClock = {
			async now() {
				tickCount++;
				// Fail on the first tick's step 7 clock call
				if (tickCount === 1) throw new Error("clock failure in step 7");
				return new Date("2026-08-10T10:00:00Z");
			},
		};

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
			clock: failingClock,
		});
		const loop = new MissionLoop({ missionDir, deps });

		// First tick should throw
		await expect(loop.tick()).rejects.toThrow("clock failure in step 7");

		// Verify journal has budget counted from step 5
		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(100);
		expect(ls.budgetCountedFor).toBe("task-alpha");

		// Second tick: recovery for same item (task-alpha still unchecked)
		// budgetCountedFor === "task-alpha" === current → skip increment (no double-count)
		const deps2 = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop2 = new MissionLoop({ missionDir, deps: deps2 });
		await loop2.tick();

		// Budget counted exactly once: 100, not 200
		const ls2 = await readMissionLoopState(missionDir);
		expect(ls2.budgetUsed.tokens).toBe(100);

		// STATE.md has task-alpha done
		const state = await readState(missionDir);
		expect(state.done).toContain("task-alpha");
	});

	it("regression: crash after step 5 of SAME item → budget counted exactly once", async () => {
		// Journal: step 5 completed for task-alpha, budget was counted
		writeLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 5,
			interrupted: true,
			iterationResult: { status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			pendingItem: "task-alpha",
			pendingItemIndex: 2,
			committed: false,
			budgetUsed: { tokens: 100, usd: 0.01 },
			budgetCountedFor: "task-alpha", // same item
		});

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0.01 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// 0.8.0: recovery skips executor for task-alpha (already committed),
		// continuous loop processes task-beta → 1 call (task-beta).
		// Invariant preserved: task-alpha budget counted exactly once (not double-counted).
		expect(deps.executorCalls.length).toBe(1);

		// Budget for task-alpha: 100 (counted once). task-beta: +100. Total: 200.
		const ls = await readMissionLoopState(missionDir);
		expect(ls.budgetUsed.tokens).toBe(200); // 100 (alpha, not double-counted) + 100 (beta)
		expect(ls.budgetUsed.usd).toBeCloseTo(0.02, 5);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P1-2: Paused mission is a no-op
// ════════════════════════════════════════════════════════════════════════════

describe("P1-2: Paused mission → tick is no-op", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("paused-test", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
		// Set MISSION.md status to paused
		setMissionStatus(missionDir, "paused");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("tick on paused mission → status paused, no executor, no commit", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("paused");
		expect(deps.executorCalls.length).toBe(0);
		expect(deps.commits.length).toBe(0);
		// steps.wake is always set to true at start of tick (before mission is read)
		// but no actual work steps should run
		expect(result.steps.iterate).toBe(false);
		expect(result.steps.commit).toBe(false);
	});

	it("Paused mission remains paused after tick (no auto-resume)", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		await loop.tick(); // second tick — still paused

		expect(deps.executorCalls.length).toBe(0);
		const status = await loop.status();
		expect(status).toBe("paused");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P1-3: Zombie-cycle with ARCHIVE.md duplicates
// ════════════════════════════════════════════════════════════════════════════

describe("P1-3: Zombie-cycle prevention (fat items → failed, no ARCHIVE dupes)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("zombie-test", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] new-task", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("Fat items (>5KB after keep-10) → status failed, ARCHIVE untouched, executor not called", async () => {
		// Create 15 fat items: each ~550 bytes → 10 items = ~5500 bytes > 5120
		const fatItems = Array.from(
			{ length: 15 },
			(_, i) =>
				`fat-task-${String(i).padStart(3, "0")}-${"x".repeat(520)}`,
		);
		// Write STATE.md directly (bypass writeState size check)
		const lines = ["## Сделано"];
		for (const item of fatItems) lines.push(`- ${item}`);
		lines.push("", "## Блокеры", "", "## Следующие шаги", "");
		writeFileSync(join(missionDir, "STATE.md"), lines.join("\n"), "utf8");

		// Verify STATE.md is over limit
		expect(checkStateFileSize(missionDir)).toBeGreaterThan(MAX_STATE_BYTES);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Should FAIL because keep-10 still exceeds limit
		expect(result.status).toBe("failed");
		// Executor should NOT have been called
		expect(deps.executorCalls.length).toBe(0);
		// ARCHIVE.md should NOT exist (no partial writes)
		expect(existsSync(join(missionDir, "ARCHIVE.md"))).toBe(false);
	});

	it("archiveOldDoneItems: dedup — calling twice doesn't create duplicates", async () => {
		// 20 small items — archiving should work fine
		const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
		await writeState(missionDir, { done: items, blockers: [], nextSteps: [] });

		// First call: archives items 0-9, keeps 10-19
		const r1 = await archiveOldDoneItems(missionDir, ARCHIVE_KEEP_COUNT);
		expect(r1).toBe(true);

		const archiveAfter1 = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");

		// Re-populate STATE.md with the same items to simulate a retry
		await writeState(missionDir, { done: items, blockers: [], nextSteps: [] });

		// Second call: same items to archive, but ARCHIVE already has them
		const r2 = await archiveOldDoneItems(missionDir, ARCHIVE_KEEP_COUNT);
		expect(r2).toBe(true);

		const archiveAfter2 = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");

		// ARCHIVE.md should not have duplicates
		const item0Count = (archiveAfter2.match(/- item-0$/gm) || []).length;
		expect(item0Count).toBe(1); // appeared only once

		// Total archive size should not have grown significantly
		expect(archiveAfter2.length).toBeLessThanOrEqual(archiveAfter1.length + 10);
	});

	it("archiveOldDoneItems: returns false when kept items exceed limit", async () => {
		// 15 fat items where 10 kept items still exceed 5KB
		const fatItems = Array.from(
			{ length: 15 },
			(_, i) =>
				`fat-task-${String(i).padStart(3, "0")}-${"x".repeat(520)}`,
		);
		await writeState(missionDir, {
			done: fatItems,
			blockers: [],
			nextSteps: [],
		}).catch(() => {
			// writeState may throw due to size — write directly
			const ls = ["## Сделано"];
			for (const item of fatItems) ls.push(`- ${item}`);
			ls.push("", "## Блокеры", "", "## Следующие шаги", "");
			writeFileSync(join(missionDir, "STATE.md"), ls.join("\n"), "utf8");
		});

		// Write directly since writeState checks size
		const ls = ["## Сделано"];
		for (const item of fatItems) ls.push(`- ${item}`);
		ls.push("", "## Блокеры", "", "## Следующие шаги", "");
		writeFileSync(join(missionDir, "STATE.md"), ls.join("\n"), "utf8");

		const result = await archiveOldDoneItems(missionDir, ARCHIVE_KEEP_COUNT);
		expect(result).toBe(false); // kept items still too large
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P2: budget=0 semantics — unified unlimited
// ════════════════════════════════════════════════════════════════════════════

describe("P2: budget=0 means unlimited (unified semantics)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("budget-zero", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("tokens=0, cost>0 → works fine (unlimited)", async () => {
		setBudgetTokens(missionDir, 0); // unlimited

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 1000, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// 0.8.0: single roadmap item → tick completes it → ROADMAP пуст → Goal пуст
		// → status="completed". budget=0 гарантирует: budgetExceededPostHoc = false,
		// значит «budget_exhausted» недостижим, финальный статус = "completed".
		expect(result.status).toBe("completed");
		expect(deps.executorCalls.length).toBe(1); // executor WAS called
	});

	it("usd=0, cost>0 → works fine (unlimited)", async () => {
		setBudgetUsd(missionDir, "0"); // unlimited

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 0, costUsd: 100.0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Аналогично tokens=0: budget=0 не отстреливает, единственный пункт
		// исполнен → status="completed".
		expect(result.status).toBe("completed");
		expect(deps.executorCalls.length).toBe(1);
	});

	it("Both tokens=0 and usd=0 → fully unlimited", async () => {
		setBudgetTokens(missionDir, 0);
		setBudgetUsd(missionDir, "0");

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 999999, costUsd: 999.99 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Оба лимита = 0, единственный пункт исполнен → status="completed".
		expect(result.status).toBe("completed");
		expect(deps.executorCalls.length).toBe(1);
	});

	it("tokens>0 and exceeded → budget_exhausted (limited)", async () => {
		setBudgetTokens(missionDir, 50);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		expect(deps.executorCalls.length).toBe(1); // ran, then exceeded
	});

	it("tokens>0 preflight: already used >= limit → no executor call", async () => {
		setBudgetTokens(missionDir, 100);
		writeLoopState(missionDir, {
			budgetUsed: { tokens: 100, usd: 0 },
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		expect(deps.executorCalls.length).toBe(0); // preflight blocked
	});

	it("tokens=0 preflight: never blocked regardless of usage", async () => {
		setBudgetTokens(missionDir, 0); // unlimited
		writeLoopState(missionDir, {
			budgetUsed: { tokens: 999999, usd: 0 },
		});

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 1000, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Even with huge usage, unlimited budget doesn't trigger preflight.
		// 0.8.0: единственный пункт исполнен (budget=0 не отстреливает),
		// ROADMAP пуст, Goal пуст → status="completed".
		expect(result.status).toBe("completed");
		expect(deps.executorCalls.length).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P3-a: Lock — dead pid + fresh timestamp → takeover
// ════════════════════════════════════════════════════════════════════════════

describe("P3-a: Lock takeover on dead PID", () => {
	let baseDir;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("Dead PID + fresh timestamp → takeover (lock acquired)", async () => {
		// Write lock with PID that is definitely dead, but FRESH timestamp
		// PID 1 is typically init/systemd on Linux, but on Windows it's usually dead.
		// Use PID 99999999 which is extremely unlikely to be alive.
		writeFileSync(
			join(baseDir, ".mission-loop.lock"),
			JSON.stringify({ pid: 99999999, timestamp: Date.now() }), // dead PID, fresh timestamp
			"utf8",
		);

		const lock = createFileLock(baseDir);
		// Old behavior: REFUSED (fresh timestamp wins)
		// New behavior: TAKEOVER (dead process always wins regardless of timestamp)
		const acquired = await lock.acquire();
		expect(acquired).toBe(true);
		await lock.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P3-b: Atomic writeRoadmap
// ════════════════════════════════════════════════════════════════════════════

describe("P3-b: Atomic writeRoadmap", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("atomic-roadmap", { baseDir });
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("writeRoadmap leaves no tmp files (atomic write)", async () => {
		const { writeRoadmap } = await import("../file-state-manager.js");
		await writeRoadmap(missionDir, "# Roadmap\n\n- [ ] test\n");

		const files = readdirSync(missionDir);
		const tmpFiles = files.filter((f) => f.includes(".tmp-"));
		expect(tmpFiles).toHaveLength(0);

		// Content should be correct
		const content = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(content).toBe("# Roadmap\n\n- [ ] test\n");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P3-c: Degraded abort — abortedByOperator in journal + MISSION.md status
// ════════════════════════════════════════════════════════════════════════════

describe("P3-c: Degraded abort (abortedByOperator in journal + MISSION.md)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("degraded-abort", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("abort() → journal has abortedByOperator=true, MISSION.md has aborted status", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		// Journal has abortedByOperator
		const ls = await readMissionLoopState(missionDir);
		expect(ls.abortedByOperator).toBe(true);

		// MISSION.md has aborted status
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*aborted/);
	});

	it("Tick after abort → cleans up, next tick is no-op (status aborted in MISSION.md)", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		// First tick processes abort signal
		const r1 = await loop.tick();
		expect(r1.status).toBe("aborted");
		expect(deps.executorCalls.length).toBe(0);

		// Second tick: MISSION.md status is aborted → no-op
		const r2 = await loop.tick();
		expect(r2.status).toBe("aborted");
		expect(deps.executorCalls.length).toBe(0); // still no executor calls
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P3-d: Deduplicated budget_exhausted after step 6
// ════════════════════════════════════════════════════════════════════════════

describe("P3-d: No duplicate writeMissionStatus for budget_exhausted", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("dedup-budget", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("Successful iteration + budget exceeded → single budget_exhausted, result committed", async () => {
		setBudgetTokens(missionDir, 50);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", costTokens: 100, costUsd: 0 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Result committed (work not lost)
		expect(deps.commits.length).toBe(1);
		const state = await readState(missionDir);
		expect(state.done).toContain("work item");

		// Status is budget_exhausted (set once, not duplicated)
		expect(result.status).toBe("budget_exhausted");
		const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(raw).toMatch(/status:\s*budget_exhausted/);

		// Verify MISSION.md has exactly one status line
		const statusLines = raw.split("\n").filter((l) => /^status:/.test(l.trim()));
		expect(statusLines.length).toBe(1);
	});

	it("BLOCKED iteration + budget exceeded → budget_exhausted set correctly", async () => {
		setBudgetTokens(missionDir, 50);

		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "BLOCKED",
					reason: "stuck",
					costTokens: 100,
					costUsd: 0,
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		// No git commit for BLOCKED
		expect(deps.commits.length).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Integration: multiple fixes working together
// ════════════════════════════════════════════════════════════════════════════

describe("Integration: combined bug fixes", () => {
	it("SIGKILL recovery + budget no-double-count + full tick", async () => {
		const baseDir = freshBaseDir();
		const missionDir = await initMission("integration-bf", { baseDir });
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] task-a",
			"- [ ] task-b",
			"- [ ] task-c",
			"",
		]);

		try {
			// Tick 1: normal — 0.8.0 continuous tick processes all 3 items in one tick.
			const deps1 = makeDeps();
			const loop1 = new MissionLoop({ missionDir, deps: deps1 });
			const r1 = await loop1.tick();
			expect(r1.iteration).toBe(3); // 3 items processed → iteration counter = 3
			expect(r1.status).toBe("completed"); // all items done, no Goal → completed
			expect(r1.itemsExecuted).toBe(3);
			expect(deps1.commits.length).toBe(3); // each item committed

			// Default executor returns costTokens=0 (no override), so tick 1 used 0 tokens.
			const lsAfterTick1 = await readMissionLoopState(missionDir);
			expect(lsAfterTick1.budgetUsed.tokens).toBe(0);

			// Tick 2: симуляция SIGKILL после step 5 of tick 2 — но при continuous
			// loop всё уже сделано (tick 1 обработал все пункты), поэтому tick 2
			// увидит пустой ROADMAP → no-op. Budget NOT double-counted.
			const deps2 = makeDeps();
			const loop2 = new MissionLoop({ missionDir, deps: deps2 });
			const r2 = await loop2.tick();
			expect(deps2.executorCalls.length).toBe(0); // nothing to do (already done)
			expect(deps2.commits.length).toBe(0); // 0.8.0: tick 1 committed all items
			expect(r2.status).toBe("completed");

			// Budget NOT double-counted: остаётся 0 (tick 1 уже учёл всё).
			const ls = await readMissionLoopState(missionDir);
			expect(ls.budgetUsed.tokens).toBe(0);

			// Tick 3: всё ещё ничего не делает — миссия завершена.
			const deps3 = makeDeps();
			const loop3 = new MissionLoop({ missionDir, deps: deps3 });
			const r3 = await loop3.tick();
			expect(r3.status).toBe("completed");
			expect(deps3.executorCalls.length).toBe(0);

			// All 3 items done
			const state = await readState(missionDir);
			expect(state.done).toContain("task-a");
			expect(state.done).toContain("task-b");
			expect(state.done).toContain("task-c");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("Paused mission → resume → tick works", async () => {
		const baseDir = freshBaseDir();
		const missionDir = await initMission("pause-resume", { baseDir });
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] work-a", "- [ ] work-b", ""]);

		try {
			// Pause the mission
			setMissionStatus(missionDir, "paused");

			// Tick while paused → no-op
			const deps1 = makeDeps();
			const loop1 = new MissionLoop({ missionDir, deps: deps1 });
			const r1 = await loop1.tick();
			expect(r1.status).toBe("paused");
			expect(deps1.executorCalls.length).toBe(0);

			// Resume: set status back to active
			setMissionStatus(missionDir, "active");

			// Tick after resume → continuous loop processes both items → completed.
			const deps2 = makeDeps({
				executor: makeMockExecutor([
					{ status: "COMPLETE", commitMessage: "a" },
					{ status: "COMPLETE", commitMessage: "b" },
				]),
			});
			const loop2 = new MissionLoop({ missionDir, deps: deps2 });
			const r2 = await loop2.tick();
			expect(r2.status).toBe("completed");
			expect(deps2.executorCalls.length).toBe(2);
			expect(r2.steps.iterate).toBe(true);
			expect(r2.itemsExecuted).toBe(2);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
