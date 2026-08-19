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
	appendBacklog,
	readBacklog,
	parseAllUnchecked,
} from "../file-state-manager.js";
import { MissionLoop, readMissionLoopState } from "../mission-loop.js";
import { PLANNING_ITEM_TEXT } from "../prompt-builder.js";
import { registerMissionSlashCommands } from "../slash-commands.js";
import { promoteAcceptedIdeas } from "../idea-promoter.js";

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

// ════════════════════════════════════════════════════════════════════════════
// Part 3: pending IDEA evaluation before completed (closed ROADMAP + RECURRING)
// ════════════════════════════════════════════════════════════════════════════

describe("step 3: pending IDEA evaluation before completed", () => {
	let baseDir;

	beforeEach(() => {
		baseDir = freshBaseDir();
	});
	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function makeIdeaLoop(missionDir, { scorerResults, promoter = promoteAcceptedIdeas, executorResults = [{ status: "COMPLETE", commitMessage: "iter" }] } = {}) {
		const scorerCalls = [];
		const promoterCalls = [];
		const ideaScorer = {
			async scoreIdea(dir, idea) {
				scorerCalls.push({ dir, idea });
				const r = scorerResults?.[idea.id];
				if (r) return { id: idea.id, score: r.score ?? 0.5, status: r.status };
				return { id: idea.id, score: 0.5, status: "DECIDE" };
			},
		};
		const ideaPromoter = {
			async promote(dir) {
				promoterCalls.push({ dir });
				return promoter(dir);
			},
		};
		const deps = makeDeps({ executor: makeMockExecutor(executorResults) });
		const loop = new MissionLoop({ missionDir, deps, ideaScorer, ideaPromoter });
		return { loop, scorerCalls, promoterCalls };
	}

	it("completed + RECURRING + IDEA + scorer/promoter: ROADMAP → idea promoted, loop stays active", async () => {
		const missionDir = await initClosedMission(baseDir, "idea-promote");
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-19T10:00:00Z",
			idea: "Add dark mode",
			source: "operator",
			fit: 0,
			value: 0,
			risk: 0,
			cost: 0,
			score: 0,
			status: "IDEA",
		});

		const { loop, scorerCalls, promoterCalls } = makeIdeaLoop(missionDir, {
			scorerResults: { "idea-001": { score: 0.75, status: "ROADMAP" } },
		});

		// Scorer → ROADMAP; real promoter adds the idea to ROADMAP; the continuous
		// loop executes the new item in the same tick and then completes.
		const result = await loop.tick();

		expect(promoterCalls.length).toBeGreaterThanOrEqual(1);
		expect(scorerCalls.length).toBeGreaterThanOrEqual(1);
		// New ROADMAP item was executed by the mock executor.
		const roadmapRaw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(parseAllUnchecked(roadmapRaw).length).toBe(0);
		expect(result.itemsExecuted).toBeGreaterThanOrEqual(1);
		expect(await missionStatus(missionDir)).toBe("completed");
	});

	it("completed + RECURRING + IDEA + scorer/promoter: REJECTED → still completed", async () => {
		const missionDir = await initClosedMission(baseDir, "idea-reject");
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-19T10:00:00Z",
			idea: "Rewrite in Rust",
			source: "operator",
			fit: 0,
			value: 0,
			risk: 0,
			cost: 0,
			score: 0,
			status: "IDEA",
		});

		const { loop } = makeIdeaLoop(missionDir, {
			scorerResults: { "idea-001": { score: 0.35, status: "REJECTED" } },
		});

		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(await missionStatus(missionDir)).toBe("completed");
		// The mock scorer returned REJECTED; the loop completed without awaiting_decision.
		// The backlog entry stays as-is because the mock does not update it.
		const backlog = await readBacklog(missionDir);
		const entry = backlog.find((e) => e.id === "idea-001");
		expect(entry.status).toBe("IDEA");
	});

	it("completed + RECURRING + IDEA without scorer/promoter → completed (idea waits)", async () => {
		const missionDir = await initClosedMission(baseDir, "idea-waits");
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-19T10:00:00Z",
			idea: "Add dark mode",
			source: "operator",
			fit: 0,
			value: 0,
			risk: 0,
			cost: 0,
			score: 0,
			status: "IDEA",
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });

		const result = await loop.tick();

		expect(result.status).toBe("completed");
		const backlog = await readBacklog(missionDir);
		const entry = backlog.find((e) => e.id === "idea-001");
		expect(entry.status).toBe("IDEA");
	});

	it("completed + RECURRING + IDEA + scorer/promoter: DECIDE → awaiting_decision", async () => {
		const missionDir = await initClosedMission(baseDir, "idea-decide");
		writeRecurring(missionDir, ["- [ ] Check inbox (interval: 30m)", ""]);
		await appendBacklog(missionDir, {
			id: "idea-001",
			date: "2026-08-19T10:00:00Z",
			idea: "Refactor auth",
			source: "operator",
			fit: 0,
			value: 0,
			risk: 0,
			cost: 0,
			score: 0,
			status: "IDEA",
		});

		const { loop } = makeIdeaLoop(missionDir, {
			scorerResults: { "idea-001": { score: 0.55, status: "DECIDE" } },
		});

		const result = await loop.tick();

		expect(result.status).toBe("awaiting_decision");
		expect(await missionStatus(missionDir)).toBe("awaiting_decision");
	});
});
