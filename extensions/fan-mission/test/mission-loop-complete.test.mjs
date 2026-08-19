// gmail-watch incident fix: выход из карусели «планирование ↔ awaiting_decision».
//
// Root cause: step 3 — ROADMAP полностью [x] + непустой Goal → синтетический
// planning-item каждый тик; completed выставлялся только при пустом Goal.
// Миссия с живым RECURRING.md (дежурство) крутила планирование бесконечно,
// а ответ оператора «миссия выполнена» через resolveDecision не пробивался
// (active → тик → планирование → streak 2 → awaiting_decision).
//
// Фикс:
//   1. step 3: all-[x] + live RECURRING.md → completed (дежурство в recur-phase);
//      bootstrap-planning только для миссий БЕЗ recurring.
//   2. FSM: awaiting_decision → completed разрешён.
//   3. MissionLoop.completeMission(reason?) — операторное завершение из
//      awaiting_decision (DECISIONS.md + очистка pendingDecision).
//   4. /mission:complete — slash-команда поверх completeMission.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initMission,
	InvalidTransitionError,
	readDecisions,
	readMission,
} from "../file-state-manager.js";
import { MissionLoop, readMissionLoopState } from "../mission-loop.js";
import { PLANNING_ITEM_TEXT } from "../prompt-builder.js";
import { registerMissionSlashCommands } from "../slash-commands.js";

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
	const result = {
		executor,
		git,
		clock: makeMockClock(),
		lock: makeMockLock(),
		commits: git.commits,
		...overrides,
	};
	result.executorCalls = result.executor.calls;
	return result;
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-complete-"));
}

function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

function writeRecurring(missionDir, lines) {
	writeFileSync(join(missionDir, "RECURRING.md"), lines.join("\n"), "utf8");
}

async function missionStatus(missionDir) {
	const mission = await readMission(missionDir);
	return String(mission.frontmatter.status);
}

/** Миссия с непустым Goal и полностью закрытым ROADMAP (сценарий gmail-watch). */
async function initClosedMission(baseDir, slug = "gmail-watch") {
	const missionDir = await initMission(slug, {
		baseDir,
		description: "Watch gmail inbox\n\n## Goal\nKeep inbox watched",
	});
	writeRoadmap(missionDir, ["# ROADMAP", "", "- [x] item 1", "- [x] item 2", ""]);
	return missionDir;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Step 3: all-[x] + Goal + live RECURRING.md → completed (не planning)
// ════════════════════════════════════════════════════════════════════════════

describe("step 3: all-[x] + Goal + RECURRING.md → completed, дежурство продолжается", () => {
	let baseDir;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("тик завершается completed, синтетический planning-item НЕ диспетчится", async () => {
		const missionDir = await initClosedMission(baseDir);
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(await missionStatus(missionDir)).toBe("completed");

		// Planning-prompt не отправлялся (executor мог быть вызван только для
		// подоспевшего recurring-пункта в recur-phase).
		const planningCalls = deps.executorCalls.filter((c) => c.prompt.includes(PLANNING_ITEM_TEXT));
		expect(planningCalls.length).toBe(0);
	});

	it("после completed recur-дежурство доступно: следующий тик исполняет due recurring", async () => {
		const missionDir = await initClosedMission(baseDir);
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick(); // → completed (+ первый прогон due recurring)

		const r2 = await loop.tick();
		expect(r2.status).toBe("completed");
		expect(await missionStatus(missionDir)).toBe("completed");
		// Interval 30m ещё не прошёл (clock +1min/вызов) → executor на 2-м тике
		// не вызывается, но миссия остаётся completed-дежурной, не planning.
		const planningCalls = deps.executorCalls.filter((c) => c.prompt.includes(PLANNING_ITEM_TEXT));
		expect(planningCalls.length).toBe(0);
	});

	it("RECURRING.md существует, но без пунктов → bootstrap-planning как раньше", async () => {
		const missionDir = await initClosedMission(baseDir);
		writeRecurring(missionDir, ["# RECURRING", "", "(no items yet)", ""]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Пустой RECURRING.md = нет дежурства → легитимный 0.7.0 bootstrap-planning.
		expect(result.item).toBe(PLANNING_ITEM_TEXT);
		expect(await missionStatus(missionDir)).not.toBe("completed");
	});

	it("all-[x] + Goal + БЕЗ RECURRING.md → bootstrap-planning (контракт 0.7.0 не сломан)", async () => {
		const missionDir = await initClosedMission(baseDir);
		// RECURRING.md не создаём.

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.item).toBe(PLANNING_ITEM_TEXT);
		expect(deps.executorCalls.length).toBeGreaterThan(0);
		expect(deps.executorCalls[0].prompt).toContain(PLANNING_ITEM_TEXT);
		// Mock-executor не добавляет пунктов → streak 2 → awaiting_decision
		// (cap из backlog #32, контракт 0.7.2). Главное: НЕ completed.
		expect(await missionStatus(missionDir)).toBe("awaiting_decision");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 2. MissionLoop.completeMission(reason?)
// ════════════════════════════════════════════════════════════════════════════

describe("MissionLoop.completeMission", () => {
	let baseDir;
	let missionDir;
	let deps;
	let loop;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initClosedMission(baseDir, "decide-complete");
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] bootstrap mission: decide-complete", ""]);
		// Загоняем миссию в awaiting_decision через DECIDE-итерацию.
		deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "DECIDE", response: "<promise>DECIDE:Миссия выполнена?</promise>" },
			]),
		});
		loop = new MissionLoop({ missionDir, deps });
		const r1 = await loop.tick();
		expect(r1.status).toBe("awaiting_decision");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("awaiting_decision → completeMission → статус completed, pendingDecision снят", async () => {
		await loop.completeMission("operator: mission done");

		expect(await missionStatus(missionDir)).toBe("completed");

		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.pendingDecision).toBeUndefined();
		expect(loopState.pendingOperatorAnswer).toBeUndefined();
		expect(loopState.interrupted).toBe(false);
	});

	it("completeMission записывает reason в DECISIONS.md (ADR: вопрос + решение)", async () => {
		await loop.completeMission("operator: mission done");

		const decisions = await readDecisions(missionDir);
		expect(decisions.length).toBeGreaterThan(0);
		const last = decisions[decisions.length - 1];
		expect(last.context).toMatch(/Миссия выполнена\?/);
		expect(last.decision).toBe("operator: mission done");
		expect(last.status).toBe("accepted");
	});

	it("completeMission без reason → дефолтная формулировка в DECISIONS.md", async () => {
		await loop.completeMission();

		const decisions = await readDecisions(missionDir);
		const last = decisions[decisions.length - 1];
		expect(last.decision).toBe("Mission marked as completed by operator");
	});

	it("после completeMission дежурство работает: tick → completed recur-phase", async () => {
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);
		await loop.completeMission("operator: mission done");

		// Новый loop-инстанс (как после ротации) — tick идёт в recur-phase.
		const deps2 = makeDeps();
		const loop2 = new MissionLoop({ missionDir, deps: deps2 });
		const r = await loop2.tick();
		expect(r.status).toBe("completed");
		expect(await missionStatus(missionDir)).toBe("completed");
	});

	it("completeMission из active → InvalidTransitionError", async () => {
		// Свежая active-миссия (без awaiting_decision).
		const activeDir = await initClosedMission(baseDir, "active-mission");
		const loop2 = new MissionLoop({ missionDir: activeDir, deps: makeDeps() });

		await expect(loop2.completeMission("nope")).rejects.toBeInstanceOf(InvalidTransitionError);
		expect(await missionStatus(activeDir)).toBe("active");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 3. /mission:complete
// ════════════════════════════════════════════════════════════════════════════

describe("/mission:complete", () => {
	let baseDir;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function makeRegister() {
		const commands = new Map();
		const register = (name, opts) => {
			commands.set(name, opts);
		};
		return { register, commands };
	}

	it("из awaiting_decision → completed, вывод подтверждения", async () => {
		const missionDir = await initClosedMission(baseDir, "slash-complete");
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] bootstrap mission: slash-complete", ""]);
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "DECIDE", response: "<promise>DECIDE:Миссия выполнена?</promise>" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick(); // → awaiting_decision
		expect(await missionStatus(missionDir)).toBe("awaiting_decision");

		const { register, commands } = makeRegister();
		const lines = [];
		const ctx = { missionLoop: loop, output: (l) => lines.push(String(l)) };
		registerMissionSlashCommands(register, ctx);

		await commands.get("mission:complete").handler("", ctx);

		expect(await missionStatus(missionDir)).toBe("completed");
		expect(lines.join("\n")).toContain("completed");
	});

	it("из active → ошибка InvalidTransition, статус не меняется", async () => {
		const missionDir = await initClosedMission(baseDir, "slash-active");
		const loop = new MissionLoop({ missionDir, deps: makeDeps() });

		const { register, commands } = makeRegister();
		const lines = [];
		const ctx = { missionLoop: loop, output: (l) => lines.push(String(l)) };
		registerMissionSlashCommands(register, ctx);

		await commands.get("mission:complete").handler("", ctx);

		expect(await missionStatus(missionDir)).toBe("active");
		expect(lines.join("\n")).toMatch(/Error:.*Invalid status transition/);
	});

	it("без аттаченного loop → понятная ошибка, без throw", async () => {
		const { register, commands } = makeRegister();
		const lines = [];
		const ctx = { missionLoop: null, output: (l) => lines.push(String(l)) };
		registerMissionSlashCommands(register, ctx);

		await commands.get("mission:complete").handler("", ctx);

		expect(lines.join("\n")).toContain("no mission attached");
	});
});
