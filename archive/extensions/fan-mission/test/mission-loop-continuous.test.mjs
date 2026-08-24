// 0.8.0: непрерывное исполнение roadmap в одном тике.
//
// tick() исполняет все one-shot пункты подряд, затем recur-пункты по одному разу.
// Останов: все пункты исполнены → yield/complete; BLOCKED/FAILED → break;
// статус миссии изменился → break.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readState } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";

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
	const base = new Date("2026-08-18T10:00:00Z");
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
	return mkdtempSync(join(tmpdir(), "fan-continuous-"));
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = freshBaseDir();
	missionDir = await initMission("continuous-test", { baseDir });
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("0.8.0: continuous tick loop", () => {
	it("3 one-shot → один tick: все исполнены, itemsExecuted=3, completed", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] task A\n- [ ] task B\n- [ ] task C\n",
			"utf8",
		);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		expect(result.itemsExecuted).toBe(3);
		expect(result.status).toBe("completed");
		expect(executor.calls.length).toBe(3);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [x] task B");
		expect(roadmap).toContain("- [x] task C");
	});

	it("[one-shot, recur, one-shot] → оба one-shot + recur мигрирует + исполняется", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] task A\n- [ ] check email (recur)\n- [ ] task B\n",
			"utf8",
		);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "checked email" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// One-shots (A, B) + migrated recur (email) = 3 items
		expect(result.itemsExecuted).toBe(3);
		expect(result.status).toBe("completed"); // R2: all one-shots done → completed
		expect(executor.calls.length).toBe(3);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [x] task B");
		expect(roadmap).toContain("- [x] check email (recur)"); // R2: migrated → [x]
	});

	it("только legacy recur → мигрирует, исполняется в recur-фазе, статус completed", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] check email (recur)\n",
			"utf8",
		);

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "checked" }]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		expect(result.itemsExecuted).toBe(1);
		expect(result.status).toBe("completed"); // R2: migrated → completed, recur ran as дежурство
		expect(executor.calls.length).toBe(1);

		// R2: recur item migrated → [x] in ROADMAP
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] check email (recur)");
	});

	it("два разных legacy recur → оба мигрируют + исполняются за тик", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] check email (recur)\n- [ ] check slack (recur)\n",
			"utf8",
		);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "checked email" },
			{ status: "COMPLETE", commitMessage: "checked slack" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		expect(result.itemsExecuted).toBe(2);
		expect(result.status).toBe("completed"); // R2: all one-shots done → completed
		expect(executor.calls.length).toBe(2);

		// R2: both recurs migrated → [x] in ROADMAP
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] check email (recur)");
		expect(roadmap).toContain("- [x] check slack (recur)");
	});

	it("FAILED на 2-м пункте → тик остановился, itemsExecuted=2", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] task A\n- [ ] task B\n- [ ] task C\n",
			"utf8",
		);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "FAILED", reason: "tests broken", commitMessage: "failed B" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// First item succeeded, second failed → break
		expect(result.itemsExecuted).toBe(2); // A succeeded + B attempted
		expect(result.status).toBe("active");
		expect(executor.calls.length).toBe(2);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [ ] task B"); // FAILED → not checked
		expect(roadmap).toContain("- [ ] task C"); // not reached
	});

	it("pause между пунктами: статус меняется → тик останавливается", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] task A\n- [ ] task B\n- [ ] task C\n",
			"utf8",
		);

		let callCount = 0;
		const executor = {
			calls: [],
			async runIteration(opts) {
				callCount++;
				this.calls.push({ ...opts });
				if (callCount === 1) {
					// After first item, pause the mission
					const missionRaw = readFileSync(join(opts.missionDir, "MISSION.md"), "utf8");
					const updated = missionRaw.replace(/^(status:\s*).*$/m, "$1paused");
					writeFileSync(join(opts.missionDir, "MISSION.md"), updated, "utf8");
				}
				return { status: "COMPLETE", commitMessage: `done ${callCount}` };
			},
		};

		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		// First item done, then status check finds paused → break
		expect(result.itemsExecuted).toBe(1);
		expect(result.status).toBe("paused");
		expect(executor.calls.length).toBe(1);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [ ] task B");
	});

	it("BLOCKED на 2-м пункте → тик остановился", async () => {
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] task A\n- [ ] task B\n",
			"utf8",
		);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "BLOCKED", reason: "need API key", commitMessage: "blocked B" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		expect(result.itemsExecuted).toBe(2);
		expect(executor.calls.length).toBe(2);

		const state = await readState(missionDir);
		expect(state.done).toContain("task A");
		expect(state.done).not.toContain("task B");
		expect(state.blockers.some((b) => b.includes("API key"))).toBe(true);
	});
});
