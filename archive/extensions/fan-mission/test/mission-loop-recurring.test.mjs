// R2: recurring-пункты переехали из ROADMAP (legacy (recur)) в RECURRING.md.
//
// Legacy (recur) в ROADMAP → авто-миграция в RECURRING.md + [x] в ROADMAP.
// RECURRING.md пункты исполняются в recur-фазе после one-shot прохода.
// Completed-миссия продолжает исполнять подоспевшие recurring (дежурство).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initMission,
	isRecurringItem,
	parseFirstUnchecked,
	RECUR_MARKER,
	readRecurring,
	readState,
} from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import { buildExecutionPrompt, RECUR_GUIDANCE } from "../prompt-builder.js";

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

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-recurring-"));
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = freshBaseDir();
	missionDir = await initMission("recur-test", { baseDir });
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── Tests: isRecurringItem / RECUR_MARKER (unchanged) ─────────────────────

describe("file-state-manager: isRecurringItem / RECUR_MARKER", () => {
	it("RECUR_MARKER is '(recur)'", () => {
		expect(RECUR_MARKER).toBe("(recur)");
	});

	it("isRecurringItem: text with (recur) → true", () => {
		expect(isRecurringItem("Check email (recur)")).toBe(true);
	});

	it("isRecurringItem: case-insensitive", () => {
		expect(isRecurringItem("Check email (RECUR)")).toBe(true);
		expect(isRecurringItem("Check email (Recur)")).toBe(true);
	});

	it("isRecurringItem: text without (recur) → false", () => {
		expect(isRecurringItem("Check email")).toBe(false);
		expect(isRecurringItem("Implement feature")).toBe(false);
	});

	it("parseFirstUnchecked: recur-пункт возвращается (он [ ])", () => {
		const raw = "# Roadmap\n\n- [ ] Check email (recur)\n";
		const result = parseFirstUnchecked(raw);
		expect(result).not.toBeNull();
		expect(result.text).toBe("Check email (recur)");
		expect(result.index).toBe(2);
	});
});

// ─── Tests: R2 — legacy (recur) migration ──────────────────────────────────

describe("mission-loop: R2 legacy (recur) migration", () => {
	it("legacy (recur) в ROADMAP → мигрирует в RECURRING.md + [x] + commit", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "checked email" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Migration commit happened
		const migrationCommit = git.commits.find((c) => c.message.includes("migrate recurring items"));
		expect(migrationCommit).toBeTruthy();
		expect(migrationCommit.files).toContain("ROADMAP.md");
		expect(migrationCommit.files).toContain("RECURRING.md");

		// ROADMAP: item is now [x]
		const updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Check email (recur)");

		// RECURRING.md: item was added (without (recur) marker, with interval)
		const recurItems = readRecurring(missionDir);
		expect(recurItems.length).toBeGreaterThanOrEqual(1);
		const migrated = recurItems.find((i) => i.text === "Check email");
		expect(migrated).toBeTruthy();
		expect(migrated.intervalMs).toBe(300_000); // 5m default

		// Executor was called (in recur-phase)
		expect(executor.calls.length).toBe(1);

		// Status is completed (all one-shots done, recur ran as дежурство)
		expect(result.status).toBe("completed");
	});

	it("обычный+legacy recur: обычный [x], recur мигрирует + исполняется", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Implement feature A\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done feature A" },
			{ status: "COMPLETE", commitMessage: "checked email" },
		]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Both items executed
		expect(executor.calls.length).toBe(2);

		// ROADMAP: feature A is [x], legacy recur is also [x] (migrated)
		const updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Implement feature A");
		expect(updatedRoadmap).toContain("- [x] Check email (recur)");

		// RECURRING.md has the migrated item
		const recurItems = readRecurring(missionDir);
		const migrated = recurItems.find((i) => i.text === "Check email");
		expect(migrated).toBeTruthy();

		// Status is completed
		expect(result.status).toBe("completed");
	});
});

// ─── Tests: R2 — recur-phase from RECURRING.md ─────────────────────────────

describe("mission-loop: R2 recur-phase (RECURRING.md)", () => {
	it("due recur в RECURRING.md → исполняется, state обновлён, ROADMAP не тронут", async () => {
		// Set up RECURRING.md directly (no migration needed)
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1m)\n",
			"utf8",
		);
		// ROADMAP with one completed item (so hasAnyChecklistItem is true)
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] Setup done\n", "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "health ok" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Executor called for the recurring item
		expect(executor.calls.length).toBe(1);
		expect(result.status).toBe("completed");
		expect(result.itemsExecuted).toBe(1);

		// ROADMAP not touched
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] Setup done");
	});

	it("not-due recur → executor НЕ вызывается", async () => {
		// Set up RECURRING.md with an item
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1h)\n",
			"utf8",
		);
		// Mark it as recently run
		const { recurringItemHash } = await import("../file-state-manager.js");
		const hash = recurringItemHash("Check health");
		const nowMs = new Date("2026-08-16T10:00:00Z").getTime();
		writeFileSync(
			join(missionDir, ".recurring-state.json"),
			JSON.stringify({ [hash]: nowMs }),
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] Setup done\n", "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "health ok" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Executor NOT called (item not due)
		expect(executor.calls.length).toBe(0);
		expect(result.status).toBe("completed");
	});

	it("completed миссия + due recur → исполняется, статус остаётся completed", async () => {
		// Set mission to completed
		const mission = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		writeFileSync(
			join(missionDir, "MISSION.md"),
			mission.replace("status: active", "status: completed"),
			"utf8",
		);
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1m)\n",
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] All done\n", "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "health ok" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Executor called for recurring item
		expect(executor.calls.length).toBe(1);
		// Status stays completed
		expect(result.status).toBe("completed");
	});

	it("completed + ничего не подоспело → 0 вызовов executor", async () => {
		// Set mission to completed
		const mission = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		writeFileSync(
			join(missionDir, "MISSION.md"),
			mission.replace("status: active", "status: completed"),
			"utf8",
		);
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1h)\n",
			"utf8",
		);
		// Mark as recently run
		const { recurringItemHash } = await import("../file-state-manager.js");
		const hash = recurringItemHash("Check health");
		const nowMs = new Date("2026-08-16T10:00:00Z").getTime();
		writeFileSync(
			join(missionDir, ".recurring-state.json"),
			JSON.stringify({ [hash]: nowMs }),
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] All done\n", "utf8");

		const executor = makeMockExecutor([]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		expect(executor.calls.length).toBe(0);
		expect(result.status).toBe("completed");
	});

	it("recur исчерпал бюджет → статус budget_exhausted (из completed)", async () => {
		// Set mission to completed with tiny budget
		const missionContent = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		writeFileSync(
			join(missionDir, "MISSION.md"),
			missionContent.replace("status: active", "status: completed").replace("budget_usd: 10.00", "budget_usd: 0.001"),
			"utf8",
		);
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1m)\n",
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] All done\n", "utf8");

		// Pre-fill budget to exhaust
		const loopState = {
			currentIteration: 0,
			lastStep: 7,
			interrupted: false,
			budgetUsed: { tokens: 0, usd: 0.001 }, // already at limit
		};
		writeFileSync(join(missionDir, ".mission-loop.json"), JSON.stringify(loopState), "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "health ok" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Budget exhausted → status changes
		expect(result.status).toBe("budget_exhausted");
		// Executor was NOT called (budget preflight failed)
		expect(executor.calls.length).toBe(0);
	});

	it("FAILED recur → state помечен (немедленного повтора нет)", async () => {
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1m)\n",
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] Setup done\n", "utf8");

		const executor = makeMockExecutor([{ status: "FAILED", reason: "health check failed", commitMessage: "" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Executor was called
		expect(executor.calls.length).toBe(1);
		// Status is completed (mission was completed, recur ran as дежурство)
		expect(result.status).toBe("completed");

		// .recurring-state.json has the run recorded (prevents immediate retry)
		const { readRecurringState, recurringItemHash } = await import("../file-state-manager.js");
		const state = readRecurringState(missionDir);
		const hash = recurringItemHash("Check health");
		expect(state[hash]).toBeTruthy();
	});

	it("два recur с разными интервалами → подоспел только один", async () => {
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Fast task (interval: 1m)\n- [ ] Slow task (interval: 1h)\n",
			"utf8",
		);
		// Mark slow task as recently run
		const { recurringItemHash } = await import("../file-state-manager.js");
		const slowHash = recurringItemHash("Slow task");
		const nowMs = new Date("2026-08-16T10:00:00Z").getTime();
		writeFileSync(
			join(missionDir, ".recurring-state.json"),
			JSON.stringify({ [slowHash]: nowMs }),
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] Setup done\n", "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "fast done" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Only fast task executed
		expect(executor.calls.length).toBe(1);
		expect(result.itemsExecuted).toBe(1);
	});
});

// ─── Tests: F1 — recurring budget persistence across ticks ────────────────

describe("mission-loop: F1 recurring budget persistence", () => {
	function readPersistedBudget(dir) {
		const raw = readFileSync(join(dir, ".mission-loop.json"), "utf8");
		return JSON.parse(raw).budgetUsed;
	}

	it("completed-дежурство: recur-бюджет персистится и накапливается между тиками", async () => {
		// Completed mission with budget 1.00; each recur run costs 0.6
		const missionContent = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		writeFileSync(
			join(missionDir, "MISSION.md"),
			missionContent.replace("status: active", "status: completed").replace("budget_usd: 10.00", "budget_usd: 1.00"),
			"utf8",
		);
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1m)\n",
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [x] All done\n", "utf8");

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "health ok", costTokens: 0, costUsd: 0.6 },
			{ status: "COMPLETE", commitMessage: "health ok", costTokens: 0, costUsd: 0.6 },
		]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		// Tick 1: executed, 0.6 persisted to .mission-loop.json
		const r1 = await loop.tick();
		expect(r1.status).toBe("completed");
		expect(executor.calls.length).toBe(1);
		expect(readPersistedBudget(missionDir).usd).toBeCloseTo(0.6, 6);

		// Tick 2: accumulated 0.6 + 0.6 = 1.2 > 1.00 → budget_exhausted, persisted
		const r2 = await loop.tick();
		expect(r2.status).toBe("budget_exhausted");
		expect(executor.calls.length).toBe(2);
		expect(readPersistedBudget(missionDir).usd).toBeCloseTo(1.2, 6);
	});

	it("active-путь: one-shot + recur в одном тике → на диске сумма обоих", async () => {
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Check health (interval: 1m)\n",
			"utf8",
		);
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] Implement feature A\n", "utf8");

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A", costTokens: 0, costUsd: 0.3 },
			{ status: "COMPLETE", commitMessage: "health ok", costTokens: 0, costUsd: 0.4 },
		]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();
		expect(result.status).toBe("completed");
		expect(executor.calls.length).toBe(2);
		expect(readPersistedBudget(missionDir).usd).toBeCloseTo(0.7, 6);
	});
});

// ─── Tests: prompt-builder guidance for recurring ───────────────────────────

describe("prompt-builder: recurring guidance (R2)", () => {
	it("recurring: true → RECUR_GUIDANCE в промпте", async () => {
		const roadmap = "# Roadmap\n\n- [x] Done\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "Check health",
			index: -1,
			roadmapRaw: roadmap,
			state: { done: [], blockers: [], nextSteps: [] },
			recurring: true,
		});

		expect(prompt).toContain(RECUR_GUIDANCE);
		expect(prompt).toContain("RECURRING task");
	});

	it("legacy (recur) marker → RECUR_GUIDANCE (backward compat)", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "Check email (recur)",
			index: 2,
			roadmapRaw: roadmap,
			state: { done: [], blockers: [], nextSteps: [] },
		});

		expect(prompt).toContain(RECUR_GUIDANCE);
	});

	it("guidance НЕТ для обычного пункта", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Implement feature A\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "Implement feature A",
			index: 2,
			roadmapRaw: roadmap,
			state: { done: [], blockers: [], nextSteps: [] },
		});

		expect(prompt).not.toContain(RECUR_GUIDANCE);
		expect(prompt).not.toContain("RECURRING task");
	});
});

// ─── Tests: regression — ordinary items without marker ──────────────────────

describe("mission-loop: regression — ordinary items (R2)", () => {
	it("обычные пункты без маркера — прежнее поведение ([x] после исполнения)", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Implement feature A\n- [ ] Implement feature B\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
		]);
		const git = makeMockGit();
		const lock = makeMockLock();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock },
		});

		const result = await loop.tick();
		expect(result.itemsExecuted).toBe(2);
		expect(result.status).toBe("completed");

		const updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Implement feature A");
		expect(updatedRoadmap).toContain("- [x] Implement feature B");
	});
});
