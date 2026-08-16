// 0.7.3: recurring-пункты (recur) для миссий-вахт.
//
// Маркер (recur) в тексте пункта ROADMAP:
// - parseFirstUnchecked возвращает такой пункт (он остаётся [ ])
// - markRoadmapDone — no-op (строка НЕ меняется на [x])
// - Миссия с recur-пунктами живёт вечно (тики исполняют recur каждый раз)
// - Обычные пункты выполняются и помечаются [x] как раньше
// - Planning-ветка не срабатывает, пока recur unchecked
// - Guidance в промпте для recur-пунктов

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initMission,
	isRecurringItem,
	parseFirstUnchecked,
	RECUR_MARKER,
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

// ─── Tests: isRecurringItem / RECUR_MARKER ──────────────────────────────────

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

// ─── Tests: mission-loop with recur items ───────────────────────────────────

describe("mission-loop: recurring items (0.7.3)", () => {
	it("recur-пункт исполняется, но НЕ помечается [x]", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "checked email" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Tick completed successfully
		expect(result.status).toBe("active");
		expect(result.iteration).toBe(1);
		expect(result.steps.iterate).toBe(true);

		// ROADMAP: recur item is STILL unchecked
		const updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [ ] Check email (recur)");
		expect(updatedRoadmap).not.toContain("- [x] Check email (recur)");

		// Executor was called
		expect(executor.calls.length).toBe(1);
	});

	it("два тика подряд — оба исполнили recur", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "checked email 1" },
			{ status: "COMPLETE", commitMessage: "checked email 2" },
		]);
		const git = makeMockGit();
		const lock = makeMockLock();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock },
		});

		// Tick 1
		const result1 = await loop.tick();
		expect(result1.status).toBe("active");
		expect(result1.iteration).toBe(1);
		lock.held = false; // release lock for next tick

		// Tick 2
		const result2 = await loop.tick();
		expect(result2.status).toBe("active");
		expect(result2.iteration).toBe(2);

		// Both ticks executed the recur item
		expect(executor.calls.length).toBe(2);

		// ROADMAP: recur item is STILL unchecked after both ticks
		const updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [ ] Check email (recur)");
		expect(updatedRoadmap).not.toContain("- [x]");
	});

	it("обычный+recur: обычный [x], recur [ ]", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Implement feature A\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done feature A" },
			{ status: "COMPLETE", commitMessage: "checked email" },
		]);
		const git = makeMockGit();
		const lock = makeMockLock();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock },
		});

		// Tick 1: should process "Implement feature A" (first unchecked)
		const result1 = await loop.tick();
		expect(result1.status).toBe("active");
		expect(result1.item).toBe("Implement feature A");
		lock.held = false;

		// ROADMAP after tick 1: feature A is [x], recur is still [ ]
		let updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Implement feature A");
		expect(updatedRoadmap).toContain("- [ ] Check email (recur)");

		// Tick 2: should process "Check email (recur)"
		const result2 = await loop.tick();
		expect(result2.status).toBe("active");
		expect(result2.item).toBe("Check email (recur)");

		// ROADMAP after tick 2: feature A still [x], recur still [ ]
		updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Implement feature A");
		expect(updatedRoadmap).toContain("- [ ] Check email (recur)");
	});

	it("только-recur roadmap → не completed после итерации", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "checked" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// Mission is NOT completed — recur item keeps it alive
		expect(result.status).toBe("active");
		expect(result.status).not.toBe("completed");
	});

	it("git commit происходит для recur (STATE.md изменился)", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "checked" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		await loop.tick();

		// Git commit happened (STATE.md was updated)
		expect(git.commits.length).toBe(1);
		expect(git.commits[0].message).toContain("Check email (recur)");
		// Only STATE.md in commit files (ROADMAP.md didn't change)
		expect(git.commits[0].files).toContain("STATE.md");
	});

	it("STATE.md: recur-пункт добавляется в done", async () => {
		const roadmap = "# Roadmap\n\n- [ ] Check email (recur)\n";
		writeFileSync(join(missionDir, "ROADMAP.md"), roadmap, "utf8");

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "checked" }]);
		const git = makeMockGit();
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock: makeMockLock() },
		});

		await loop.tick();

		const state = await readState(missionDir);
		expect(state.done).toContain("Check email (recur)");
	});
});

// ─── Tests: prompt-builder guidance for recur ───────────────────────────────

describe("prompt-builder: recur guidance (0.7.3)", () => {
	it("guidance в промпте для recur-пункта", async () => {
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
		expect(prompt).toContain("RECURRING task (recur)");
		expect(prompt).toContain("do NOT mark or remove the item");
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

describe("mission-loop: regression — ordinary items (0.7.3)", () => {
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

		// Tick 1: feature A
		await loop.tick();
		lock.held = false;

		let updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Implement feature A");
		expect(updatedRoadmap).toContain("- [ ] Implement feature B");

		// Tick 2: feature B
		await loop.tick();

		updatedRoadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(updatedRoadmap).toContain("- [x] Implement feature A");
		expect(updatedRoadmap).toContain("- [x] Implement feature B");
	});
});
