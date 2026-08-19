// ralph-loop incident fix: resilience of the mission loop against an oversized
// STATE.md and visibility of the persistent-mode degradation.
//
// Инцидент: живая fresh-миссия раздула STATE.md до 5266 байт → readState
// бросил StateFileTooLarge → тик умер (finalise / step 2) → maybeRotateSession
// не выполнился → миссия застряла в persistent, каждый scheduler-тик падал,
// оператор видел только tick-bridge ошибку.
//
// Покрытие:
//   1. Executor раздувает STATE.md >5KB в середине тика → finalise НЕ падает
//      (readState truncate+warn), тик завершается успешно.
//   2. _tickInner бросает при выставленном resumeAfterRotation (флаг с прошлой
//      итерации на диске) → rotator ВСЁ РАВНО вызван (rotation = recovery
//      path), ошибка проброшена дальше.
//   3. Observability: deps.notify вызывается при cancelled-ротации и при
//      degrade «rotator missing».
//
// Паттерн: mission-loop-fresh-rotation.test.mjs (S3) / fresh-mode-gaps (S6).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, MAX_STATE_BYTES, MissionNotFound, readState } from "../file-state-manager.js";
import { MissionLoop, readMissionLoopState, writeLoopStateSync } from "../mission-loop.js";

// ─── Helpers (паттерн S3/S6) ────────────────────────────────────────────────

function makeMockExecutor(results, { onRun } = {}) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		async runIteration(opts) {
			calls.push({ ...opts });
			if (onRun) await onRun(opts);
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
	const base = new Date("2026-08-19T10:00:00Z");
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

function makeMockRotator({ cancelled = false, missionDir, clearFlag = true } = {}) {
	const calls = [];
	return {
		calls,
		async rotate() {
			const state = await readMissionLoopState(missionDir);
			calls.push({ resumeAfterRotation: state.resumeAfterRotation });
			if (!cancelled && clearFlag) {
				state.resumeAfterRotation = false;
				writeFileSync(join(missionDir, ".mission-loop.json"), JSON.stringify(state, null, 2), "utf8");
			}
			return { cancelled };
		},
	};
}

function writeRoadmap(missionDir, items) {
	const lines = items.map((i) => (i.checked ? `- [x] ${i.text}` : `- [ ] ${i.text}`));
	writeFileSync(join(missionDir, "ROADMAP.md"), `# Roadmap\n\n${lines.join("\n")}\n`, "utf8");
}

/** STATE.md >6KB: заголовки секций первыми, bloat — последней строкой. */
function bloatedStateContent() {
	const header = "## Сделано\n- a\n\n## Блокеры\n\n## Следующие шаги\n";
	const padding = "x".repeat(MAX_STATE_BYTES + 1024); // ~6KB total
	return header + padding;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = mkdtempSync(join(tmpdir(), "fan-rotation-resilience-"));
	// Default template ships session_mode: fresh (S2)
	missionDir = await initMission("resilience-test", { baseDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── 1. readState resilience интеграционно: bloat mid-tick ─────────────────

describe("ralph-loop incident / readState resilience", () => {
	it("executor раздувает STATE.md >5KB mid-tick → тик НЕ падает (truncate+warn в finalise)", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }]);

		const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "done A" }], {
			// Инцидент: агент раздул STATE.md во время итерации (после preflight
			// step 2, до finalise). Раньше finalise readState бросал
			// StateFileTooLarge и тик умирал.
			onRun: () => {
				writeFileSync(join(missionDir, "STATE.md"), bloatedStateContent(), "utf8");
			},
		});
		const rotator = makeMockRotator({ missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock(), sessionRotator: rotator },
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await loop.tick();

		// Тик прошёл (шаг 2 + finalise без throw); единственный пункт выполнен.
		// NB: fresh-режим помечает миссию completed на СЛЕДУЮЩЕМ тике — здесь
		// достаточно, что тик завершился штатно.
		expect(executor.calls.length).toBe(1);
		expect(result.steps.read).toBe(true);
		expect(["active", "completed"]).toContain(result.status);
		// Warn о truncation был выдан с фактическим размером.
		const truncateWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes("truncating"));
		expect(truncateWarn).toBeDefined();
		expect(String(truncateWarn[0])).toContain(String(MAX_STATE_BYTES));
		// STATE.md после тика — валидный и под лимитом (finalise переписал).
		const state = await readState(missionDir);
		expect(state.done).toContain("task A");
	});

	it("readState: 6KB STATE.md → не бросает, возвращает обрезанный контент + warn", async () => {
		writeFileSync(join(missionDir, "STATE.md"), bloatedStateContent(), "utf8");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const state = await readState(missionDir);
		expect(state.done).toEqual(["a"]);
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(String(warnSpy.mock.calls[0][0])).toContain("truncating");
	});
});

// ─── 2. Ротация как путь восстановления при упавшем тике ────────────────────

describe("ralph-loop incident / rotation on failed tick", () => {
	it("_tickInner бросает при resumeAfterRotation на диске → rotator вызван, ошибка проброшена", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }]);

		// Предыдущий тик успешно выставил флаг (lastStep=7), но процесс умер до
		// maybeRotateSession — флаг остался на диске.
		const preState = await readMissionLoopState(missionDir);
		preState.currentIteration = 1;
		preState.lastStep = 7;
		preState.interrupted = false;
		preState.resumeAfterRotation = true;
		writeLoopStateSync(missionDir, preState);

		// Следующий тик падает на step 2: STATE.md отсутствует → MissionNotFound.
		unlinkSync(join(missionDir, "STATE.md"));

		const rotator = makeMockRotator({ missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor: makeMockExecutor([{ status: "COMPLETE", commitMessage: "x" }]),
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
				sessionRotator: rotator,
			},
		});

		await expect(loop.tick()).rejects.toBeInstanceOf(MissionNotFound);
		// Несмотря на упавший тик, ротация (recovery path) была попытана:
		// rotator увидел флаг на диске.
		expect(rotator.calls.length).toBe(1);
		expect(rotator.calls[0].resumeAfterRotation).toBe(true);
		// Mock-ротация успешна → флаг потреблён.
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBe(false);
	});
});

// ─── 3. Observability: notify при degradation ───────────────────────────────

describe("ralph-loop incident / operator notify on degradation", () => {
	it("cancelled-ротация → notify «rotation cancelled … persistent mode»", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }]);

		const notify = vi.fn();
		const rotator = makeMockRotator({ cancelled: true, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor: makeMockExecutor([{ status: "COMPLETE", commitMessage: "done A" }]),
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
				sessionRotator: rotator,
				notify,
			},
		});

		vi.spyOn(console, "warn").mockImplementation(() => {});
		// Tick: task A выполнен → fresh break (B остался) → флаг → cancelled-ротация.
		const result = await loop.tick();
		expect(rotator.calls.length).toBe(1);
		expect(result.status).toBe("active");
		const cancelNotify = notify.mock.calls.find((c) => String(c[0]).includes("session rotation cancelled"));
		expect(cancelNotify).toBeDefined();
		expect(String(cancelNotify[0])).toContain("persistent mode");
	});

	it("rotator отсутствует (fresh) → notify «no sessionRotator … degrades to persistent»", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }]);

		const notify = vi.fn();
		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor: makeMockExecutor([{ status: "COMPLETE", commitMessage: "done A" }]),
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
				notify,
				// sessionRotator НЕ инжектирован — degrade в persistent
			},
		});

		vi.spyOn(console, "warn").mockImplementation(() => {});
		await loop.tick();
		const missingNotify = notify.mock.calls.find((c) => String(c[0]).includes("no sessionRotator"));
		expect(missingNotify).toBeDefined();
		expect(String(missingNotify[0])).toContain("persistent");
	});

	it("rotator бросает → notify + fallback в persistent (флаг снят)", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }]);

		const notify = vi.fn();
		const throwingRotator = {
			calls: 0,
			async rotate() {
				this.calls++;
				throw new Error("newSession boom");
			},
		};
		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor: makeMockExecutor([{ status: "COMPLETE", commitMessage: "done A" }]),
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
				sessionRotator: throwingRotator,
				notify,
			},
		});

		vi.spyOn(console, "warn").mockImplementation(() => {});
		await loop.tick();
		expect(throwingRotator.calls).toBe(1);
		expect(notify.mock.calls.some((c) => String(c[0]).includes("session rotation cancelled"))).toBe(true);
		// Флаг снят, миссия деградировала в persistent (tick 2 без ротации).
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBe(false);
		await loop.tick();
		expect(throwingRotator.calls).toBe(1); // ротация не ретраится
	});
});
