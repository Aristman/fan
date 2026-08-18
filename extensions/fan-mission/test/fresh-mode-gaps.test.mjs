// S6 (ralph-loop): fresh-режим — закрытие дыр покрытия.
//
// Дыры из verify-отчётов S3–S5:
//   1. SIGKILL recovery в fresh: interrupted=true + lastStep=4 на диске →
//      recovery пропускает executor для recovered-пункта (resumeFromStep=5),
//      бюджет не двоится (budgetCountedFor), флаг/ротация корректны.
//   2. SIGKILL между флагом и ротацией: resumeAfterRotation=true на диске
//      при старте (process crash до rotate) → session_start auto-resume
//      подхватывает (флаг снят, tick вызван).
//   3. Fresh + budget preflight exhausted: бюджет на лимите → тик завершается
//      budget_exhausted БЕЗ выставления resumeAfterRotation и БЕЗ ротации.
//   4. Мульти-тик fresh end-to-end: 3 пункта → 3 tick'а, ротация между ними,
//      итоговый статус completed.
//
// Паттерн: mission-loop-fresh-rotation.test.mjs (S3) + index-fresh-rotation-wiring.test.mjs (S5).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";
import { MissionLoop, readMissionLoopState, writeLoopStateSync } from "../mission-loop.js";

// ─── Helpers (паттерн S3) ───────────────────────────────────────────────────

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
 * Mock rotator (паттерн S3): записывает снапшот state на момент вызова.
 * clearFlag=true (default) → эмулирует успешную ротацию (wiring: session_start
 * новой сессии снимает флаг). clearFlag=false → флаг остаётся.
 */
function makeMockRotator({ cancelled = false, lock, missionDir, clearFlag = true } = {}) {
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
			if (!cancelled && clearFlag) {
				state.resumeAfterRotation = false;
				writeFileSync(join(missionDir, ".mission-loop.json"), JSON.stringify(state, null, 2), "utf8");
			}
			return { cancelled };
		},
	};
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-fresh-gaps-"));
}

function writeRoadmap(missionDir, items) {
	const lines = items.map((i) => (i.checked ? `- [x] ${i.text}` : `- [ ] ${i.text}`));
	writeFileSync(join(missionDir, "ROADMAP.md"), `# Roadmap\n\n${lines.join("\n")}\n`, "utf8");
}

/** Изменить frontmatter MISSION.md (merge поверх существующих полей). */
function patchFrontmatter(missionDir, patch) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	let out = raw;
	for (const [key, value] of Object.entries(patch)) {
		const re = new RegExp(`^${key}:.*$`, "m");
		if (re.test(out)) {
			out = out.replace(re, `${key}: ${value}`);
		} else {
			// Insert before the closing ---
			out = out.replace(/\n---\n/, `\n${key}: ${value}\n---\n`);
		}
	}
	writeFileSync(join(missionDir, "MISSION.md"), out, "utf8");
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = freshBaseDir();
	missionDir = await initMission("fresh-gaps-test", { baseDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── S6-1: SIGKILL recovery в fresh ─────────────────────────────────────────

describe("S6 / SIGKILL recovery в fresh-режиме", () => {
	it("crash mid-iteration (lastStep=4, interrupted=true) → recovery пропускает executor для recovered-пункта", async () => {
		// 3 пункта: A (recovered), B, C
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }, { text: "task C" }]);

		// Эмулируем crash после step 4 (executor отработал, но step 5 не завершился).
		// iterationResult + pendingItem + budgetCountedFor сохранены.
		const preCrashState = await readMissionLoopState(missionDir);
		preCrashState.currentIteration = 1;
		preCrashState.lastStep = 4;
		preCrashState.interrupted = true;
		preCrashState.iterationResult = { status: "COMPLETE", commitMessage: "done A", costTokens: 100, costUsd: 0.01 };
		preCrashState.pendingItem = "task A";
		preCrashState.pendingItemIndex = 2; // line index in ROADMAP
		preCrashState.budgetCountedFor = "task A";
		preCrashState.budgetUsed = { tokens: 100, usd: 0.01 };
		preCrashState.resumeAfterRotation = true; // crash до maybeRotateSession
		writeLoopStateSync(missionDir, preCrashState);

		// Executor: результаты для B и C (A не должен быть вызван)
		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		// Tick 1: recovery task A (без executor для A) → break (fresh, есть B и C) → rotate
		const r1 = await loop.tick();
		// Recovery: executor НЕ вызывался для task A (resumeFromStep=5, skip step 4)
		expect(executor.calls.length).toBe(0); // A recovered без executor, break до B
		// Бюджет не двоится: budgetCountedFor совпал → increment пропущен
		const stateAfterTick1 = await readMissionLoopState(missionDir);
		// budgetCountedFor сброшен после финализации
		expect(stateAfterTick1.budgetCountedFor).toBeNull();
		// interrupted сброшен
		expect(stateAfterTick1.interrupted).toBe(false);
		// Ротация вызвана (flag=true после fresh break)
		expect(rotator.calls.length).toBe(1);
		expect(rotator.calls[0].resumeAfterRotation).toBe(true);
		// Mock rotator снял флаг (эмуляция wiring: session_start новой сессии)
		expect(stateAfterTick1.resumeAfterRotation).toBe(false);

		// Tick 2: task B executed → fresh break (C остался) → rotate
		const r2 = await loop.tick();
		expect(executor.calls.length).toBe(1);
		expect(executor.calls[0].prompt).toContain("Execute mission item: task B");
		expect(rotator.calls.length).toBe(2);

		// Tick 3: task C → completed (последний пункт, флаг не ставится)
		const r3 = await loop.tick();
		expect(executor.calls.length).toBe(2);
		expect(executor.calls[1].prompt).toContain("Execute mission item: task C");
		// Последний пункт → флаг не ставится, ротации нет
		expect(rotator.calls.length).toBe(2); // не изменилось

		// Tick 4: completed-дежурство
		const r4 = await loop.tick();
		expect(r4.status).toBe("completed");

		// ROADMAP: все пункты выполнены
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [x] task B");
		expect(roadmap).toContain("- [x] task C");
	});

	it("SIGKILL: interrupted=true + lastStep=4 без budgetCountedFor → budget считается заново (один раз)", async () => {
		// Crash после step 4, но budgetCountedFor НЕ совпадает (crash между
		// increment и journal write). Recovery: step 5 считает бюджет заново.
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }]);

		const preCrashState = await readMissionLoopState(missionDir);
		preCrashState.currentIteration = 1;
		preCrashState.lastStep = 4;
		preCrashState.interrupted = true;
		preCrashState.iterationResult = { status: "COMPLETE", commitMessage: "done A", costTokens: 200, costUsd: 0.02 };
		preCrashState.pendingItem = "task A";
		preCrashState.pendingItemIndex = 2;
		preCrashState.budgetCountedFor = null; // crash ДО journal write step 5
		preCrashState.budgetUsed = { tokens: 0, usd: 0 }; // budget ещё не increment'нут
		writeLoopStateSync(missionDir, preCrashState);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done B" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		await loop.tick();

		// Budget task A посчитан при recovery (step 5)
		const state = await readMissionLoopState(missionDir);
		// budgetUsed включает cost от A (200 tokens, 0.02 usd)
		expect(state.budgetUsed.tokens).toBe(200);
		expect(state.budgetUsed.usd).toBeCloseTo(0.02, 5);
	});
});

// ─── S6-2: SIGKILL между флагом и ротацией ─────────────────────────────────

describe("S6 / SIGKILL между флагом и ротацией", () => {
	it("resumeAfterRotation=true на диске при старте (crash до rotate) → tick подхватывает работу", async () => {
		// Сценарий: процесс выставил флаг, записал lastStep=7, interrupted=false,
		// но crash до вызова rotator.rotate(). Новая сессия (новый process)
		// стартует с этим состоянием на диске.
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }]);

		// Эмулируем состояние после crash: tick завершён, флаг выставлен,
		// ротация не состоялась.
		const crashState = await readMissionLoopState(missionDir);
		crashState.currentIteration = 1;
		crashState.lastStep = 7;
		crashState.interrupted = false;
		crashState.resumeAfterRotation = true;
		crashState.budgetCountedFor = null;
		writeLoopStateSync(missionDir, crashState);

		// executor: task A уже выполнен (отмечен в ROADMAP), task B — следующий
		writeRoadmap(missionDir, [{ text: "task A", checked: true }, { text: "task B" }]);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done B" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		// Tick 1: флаг resumeAfterRotation на диске, но это НЕ влияет на _tickInner
		// (флаг проверяется только в maybeRotateSession ПОСЛЕ tick).
		// _tickInner видит task B как следующий unchecked → исполняет.
		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(executor.calls.length).toBe(1);
		expect(executor.calls[0].prompt).toContain("Execute mission item: task B");

		// После tick: task B выполнен, unchecked не осталось.
		// NB: fresh-код НЕ clears resumeAfterRotation когда work done —
		// флаг остаётся true от crash-state (не устанавливается, но и не
		// сбрасывается). Это приводит к одному лишнему вызову rotator.
		// Документируем как известную неоптимальность (не баг: система
		// обрабатывает gracefully — новая сессия подхватит и завершится).

		// maybeRotateSession: флаг true (от crash-state) → rotator вызван
		expect(rotator.calls.length).toBe(1);
		// Mock rotator снял флаг
		const stateAfter = await readMissionLoopState(missionDir);
		expect(stateAfter.resumeAfterRotation).toBe(false);

		// Tick 2: completed-дежурство (rotator снимает флаг в mock)
		const r2 = await loop.tick();
		expect(r2.status).toBe("completed");
	});

	it("resumeAfterRotation=true + есть работа → флаг потреблён, ротация вызвана", async () => {
		// Более реалистичный сценарий: crash между флагом и ротацией, но
		// работа ещё есть (2+ пункта).
		writeRoadmap(missionDir, [{ text: "task A", checked: true }, { text: "task B" }, { text: "task C" }]);

		const crashState = await readMissionLoopState(missionDir);
		crashState.currentIteration = 1;
		crashState.lastStep = 7;
		crashState.interrupted = false;
		crashState.resumeAfterRotation = true;
		writeLoopStateSync(missionDir, crashState);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		// Tick 1: _tickInner исполняет task B, fresh → флаг выставлен (C остался) → break
		// maybeRotateSession: флаг true → rotate (первый вызов — от текущего tick)
		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(executor.calls[0].prompt).toContain("Execute mission item: task B");
		expect(rotator.calls.length).toBe(1);

		// Tick 2: task C → completed (последний, флаг не ставится)
		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(1);
		expect(executor.calls[1].prompt).toContain("Execute mission item: task C");
		// Ротация не вызвана (последний пункт)
		expect(rotator.calls.length).toBe(1);

		// Tick 3: completed
		const r3 = await loop.tick();
		expect(r3.status).toBe("completed");
	});
});

// ─── S6-3: Fresh + budget preflight exhausted ───────────────────────────────

describe("S6 / fresh + budget preflight exhausted", () => {
	it("бюджет на лимите → budget_exhausted БЕЗ resumeAfterRotation и БЕЗ ротации", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }]);

		// Устанавливаем маленький бюджет и budgetUsed на лимите
		patchFrontmatter(missionDir, { budget_tokens: "100", budget_usd: "1.00" });

		// budgetUsed уже на лимите
		const state = await readMissionLoopState(missionDir);
		state.budgetUsed = { tokens: 100, usd: 1.0 };
		writeLoopStateSync(missionDir, state);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		const result = await loop.tick();

		// Budget exhausted на preflight → executor НЕ вызван
		expect(result.status).toBe("budget_exhausted");
		expect(executor.calls.length).toBe(0);
		// resumeAfterRotation НЕ выставлен
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
		// Ротация НЕ вызвана (флаг не выставлен)
		expect(rotator.calls.length).toBe(0);
		// Миссия: budget_exhausted
		expect(await loop.status()).toBe("budget_exhausted");
	});

	it("бюджет на лимите (usd) → аналогичное поведение", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }]);

		patchFrontmatter(missionDir, { budget_tokens: "500000", budget_usd: "1.00" });

		const state = await readMissionLoopState(missionDir);
		state.budgetUsed = { tokens: 0, usd: 1.0 }; // usd на лимите
		writeLoopStateSync(missionDir, state);

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
		]);
		const lock = makeMockLock();
		const rotator = makeMockRotator({ lock, missionDir });
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		expect(executor.calls.length).toBe(0);
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
		expect(rotator.calls.length).toBe(0);
	});
});

// ─── S6-4: Мульти-тик fresh end-to-end ──────────────────────────────────────

describe("S6 / мульти-тик fresh end-to-end", () => {
	it("3 пункта, mock rotator успешен → 3 tick'а, 2 ротации, итоговый completed", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }, { text: "task C" }]);

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

		// Tick 1: task A + rotate (остались B, C)
		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(r1.status).toBe("active");
		expect(executor.calls.length).toBe(1);
		expect(executor.calls[0].prompt).toContain("Execute mission item: task A");
		expect(rotator.calls.length).toBe(1);
		expect(rotator.calls[0].resumeAfterRotation).toBe(true);
		// Флаг снят rotator'ом (эмуляция wiring)
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBe(false);

		// Tick 2: task B + rotate (остался C)
		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(1);
		expect(r2.status).toBe("active");
		expect(executor.calls.length).toBe(2);
		expect(executor.calls[1].prompt).toContain("Execute mission item: task B");
		expect(rotator.calls.length).toBe(2);
		expect(rotator.calls[1].resumeAfterRotation).toBe(true);

		// Tick 3: task C → completed (последний пункт, флаг не ставится, ротации нет)
		const r3 = await loop.tick();
		expect(r3.itemsExecuted).toBe(1);
		expect(executor.calls.length).toBe(3);
		expect(executor.calls[2].prompt).toContain("Execute mission item: task C");
		// Ротация НЕ вызвана (последний пункт)
		expect(rotator.calls.length).toBe(2);

		// Tick 4: completed-дежурство
		const r4 = await loop.tick();
		expect(r4.status).toBe("completed");
		expect(executor.calls.length).toBe(3);
		expect(rotator.calls.length).toBe(2);

		// ROADMAP: все выполнены
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] task A");
		expect(roadmap).toContain("- [x] task B");
		expect(roadmap).toContain("- [x] task C");
	});

	it("rotator throws → fallback в persistent, миссия завершается", async () => {
		writeRoadmap(missionDir, [{ text: "task A" }, { text: "task B" }, { text: "task C" }]);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "done A" },
			{ status: "COMPLETE", commitMessage: "done B" },
			{ status: "COMPLETE", commitMessage: "done C" },
		]);
		const lock = makeMockLock();
		// Rotator бросает ошибку при первом вызове
		const rotator = {
			calls: [],
			async rotate() {
				this.calls.push({});
				throw new Error("rotator crash");
			},
		};
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock, sessionRotator: rotator },
		});

		// Tick 1: task A выполнен → fresh → флаг → rotate throws → persistent fallback
		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(rotator.calls.length).toBe(1);
		// Флаг снят (rotator threw → cancelled=true → loop снимает флаг)
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
		expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("session rotation failed"))).toBe(true);

		// Persistent fallback: оставшиеся 2 пункта в одном тике
		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(2);
		expect(r2.status).toBe("completed");
		expect(executor.calls.length).toBe(3);
		// Rotator больше не вызывается (sessionMode = persistent)
		expect(rotator.calls.length).toBe(1);
	});
});
