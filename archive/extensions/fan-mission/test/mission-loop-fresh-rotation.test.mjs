// S3 (ralph-loop): MissionLoop fresh-режим и ротация сессии.
//
// session_mode: fresh (frontmatter) + deps.sessionRotator → одна итерация за
// tick, LoopState.resumeAfterRotation после полного персиста (lastStep=7,
// interrupted=false), rotator вызывается ПОСЛЕ release lock'а.
// cancelled-ротация → флаг снят + warn + persistent-fallback до конца процесса.
// Без sessionRotator fresh деградирует в persistent с одноразовым warn.
// Миссия без session_mode → поведение 0.9.0 идентично.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";
import { MissionLoop, readMissionLoopState } from "../mission-loop.js";

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

/**
 * Mock session rotator: записывает снапшот loop-state и состояние lock'а на
 * момент вызова. По умолчанию эмулирует S5 wiring: успешная ротация →
 * session_start новой сессии снимает resumeAfterRotation перед автопродолжением.
 */
function makeMockRotator({ cancelled = false, lock, missionDir, clearFlagOnRotate = true } = {}) {
	const calls = [];
	return {
		calls,
		async rotate() {
			const state = await readMissionLoopState(missionDir);
			calls.push({
				lockHeld: lock ? lock.held() : null,
				resumeAfterRotation: state.resumeAfterRotation,
				lastStep: state.lastStep,
				interrupted: state.interrupted,
			});
			if (!cancelled && clearFlagOnRotate) {
				state.resumeAfterRotation = false;
				writeFileSync(join(missionDir, ".mission-loop.json"), JSON.stringify(state, null, 2), "utf8");
			}
			return { cancelled };
		},
	};
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-fresh-rotation-"));
}

function writeRoadmap(items) {
	const lines = items.map((i) => (i.checked ? `- [x] ${i.text}` : `- [ ] ${i.text}`));
	writeFileSync(join(missionDir, "ROADMAP.md"), `# Roadmap\n\n${lines.join("\n")}\n`, "utf8");
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = freshBaseDir();
	// Default template ships session_mode: fresh (S2)
	missionDir = await initMission("fresh-rotation-test", { baseDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("S3: fresh session mode — one-shot loop", () => {
	it("3 unchecked → 1 итерация за tick; флаг до rotate; rotator после release lock", async () => {
		writeRoadmap([{ text: "task A" }, { text: "task B" }, { text: "task C" }]);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(r1.status).toBe("active");
		expect(executor.calls.length).toBe(1);
		expect(rotator.calls.length).toBe(1);
		// rotator вызван ПОСЛЕ release lock'а
		expect(rotator.calls[0].lockHeld).toBe(false);
		// флаг выставлен до rotate, строго после полного персиста (lastStep=7)
		expect(rotator.calls[0].resumeAfterRotation).toBe(true);
		expect(rotator.calls[0].lastStep).toBe(7);
		expect(rotator.calls[0].interrupted).toBe(false);

		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(1);
		expect(executor.calls.length).toBe(2);
		expect(rotator.calls.length).toBe(2);

		// Последняя итерация: unchecked не осталось → флаг не ставится, ротации нет
		const r3 = await loop.tick();
		expect(r3.itemsExecuted).toBe(1);
		expect(executor.calls.length).toBe(3);
		expect(rotator.calls.length).toBe(2);
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();

		// Завершение миссии фиксируется следующим тиком (fresh: decide-проход без итерации)
		const r4 = await loop.tick();
		expect(r4.status).toBe("completed");
		expect(executor.calls.length).toBe(3);
		expect(rotator.calls.length).toBe(2);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [x] task B");
		expect(roadmap).toContain("- [x] task C");
	});

	it("cancelled rotation → флаг снят + warn; следующий tick persistent (без повторной ротации)", async () => {
		writeRoadmap([{ text: "task A" }, { text: "task B" }, { text: "task C" }]);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ cancelled: true, lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(rotator.calls.length).toBe(1);
		// loop сам снимает флаг при cancelled
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
		expect(
			warnSpy.mock.calls.some((c) => String(c[0]).includes("session rotation cancelled")),
		).toBe(true);

		// Persistent-fallback до конца процесса: оставшиеся 2 пункта в одном тике,
		// rotator больше не вызывается.
		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(2);
		expect(r2.status).toBe("completed");
		expect(executor.calls.length).toBe(3);
		expect(rotator.calls.length).toBe(1);
	});

	it("fresh без sessionRotator → деградация в persistent с одноразовым warn", async () => {
		writeRoadmap([{ text: "task A" }, { text: "task B" }, { text: "task C" }]);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		// 0.9.0-поведение: все 3 итерации в одном тике
		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(3);
		expect(r1.status).toBe("completed");
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();

		// Второй tick (completed-дежурство) — warn не повторяется
		await loop.tick();
		const degradeWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("no sessionRotator injected"));
		expect(degradeWarns.length).toBe(1);
	});

	it("persistent-миссия (без session_mode) → поведение 0.9.0, rotator не вызывается", async () => {
		// Убираем session_mode из MISSION.md (миссия старого формата)
		const missionPath = join(missionDir, "MISSION.md");
		const content = readFileSync(missionPath, "utf8");
		expect(content).toContain("session_mode: fresh");
		writeFileSync(missionPath, content.replace(/^session_mode: fresh\n/m, ""), "utf8");
		writeRoadmap([{ text: "task A" }, { text: "task B" }, { text: "task C" }]);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		const result = await loop.tick();
		expect(result.itemsExecuted).toBe(3);
		expect(result.status).toBe("completed");
		expect(executor.calls.length).toBe(3);
		expect(rotator.calls.length).toBe(0);
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
	});
});

describe("S3: fresh session mode — recur-phase", () => {
	it("ротация между двумя due-айтемами; ре-вход пропускает выполненный", async () => {
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Task one (interval: 1h)\n- [ ] Task two (interval: 1h)\n",
			"utf8",
		);
		// Все one-shot выполнены, Goal пуст → completed-break, затем recur-фаза
		writeRoadmap([{ text: "Setup done", checked: true }]);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "one ok" },
			{ status: "COMPLETE", commitMessage: "two ok" },
		]);
		const git = makeMockGit();
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		// Tick 1: первый due-айтем, флаг (второй ещё due), break, ротация
		const r1 = await loop.tick();
		expect(executor.calls.length).toBe(1);
		expect(rotator.calls.length).toBe(1);
		expect(rotator.calls[0].lockHeld).toBe(false);
		expect(rotator.calls[0].resumeAfterRotation).toBe(true);
		expect(git.commits.some((c) => c.message === "mission: recurring: Task one")).toBe(true);

		// Tick 2: Task one не due (markRecurringRun), исполняется Task two;
		// due больше нет → флаг не ставится, ротации нет
		const r2 = await loop.tick();
		expect(executor.calls.length).toBe(2);
		expect(git.commits.some((c) => c.message === "mission: recurring: Task two")).toBe(true);
		expect(rotator.calls.length).toBe(1);
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
	});

	it("completed-дежурство + fresh: ротация между due-айтемами", async () => {
		const missionPath = join(missionDir, "MISSION.md");
		const content = readFileSync(missionPath, "utf8");
		writeFileSync(missionPath, content.replace("status: active", "status: completed"), "utf8");
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"# Recurring tasks\n- [ ] Task one (interval: 1h)\n- [ ] Task two (interval: 1h)\n",
			"utf8",
		);
		writeRoadmap([{ text: "All done", checked: true }]);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "one ok" },
			{ status: "COMPLETE", commitMessage: "two ok" },
		]);
		const git = makeMockGit();
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git, clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		const r1 = await loop.tick();
		expect(r1.status).toBe("completed");
		expect(executor.calls.length).toBe(1);
		expect(rotator.calls.length).toBe(1);
		expect(rotator.calls[0].lockHeld).toBe(false);
		expect(rotator.calls[0].resumeAfterRotation).toBe(true);
		expect(git.commits.some((c) => c.message === "mission: recurring: Task one")).toBe(true);

		const r2 = await loop.tick();
		expect(r2.status).toBe("completed");
		expect(executor.calls.length).toBe(2);
		expect(git.commits.some((c) => c.message === "mission: recurring: Task two")).toBe(true);
		expect(rotator.calls.length).toBe(1);
	});
});
