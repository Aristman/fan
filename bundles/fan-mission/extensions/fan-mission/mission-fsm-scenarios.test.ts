// FSM scenario matrix S1–S28 for fan-mission (model: .fan/reports/fsm-model-mission.md).
//
// Each scenario encodes one row of the formal FSM model against the REAL code:
// real MissionLoop + real file-state-manager on temp directories; ONLY executor /
// sessionRotator / LLM-hooks (scorer/promoter) are mocked (pattern borrowed from
// mission-loop-pause-fix.test.ts). No real LLM / sessions — unit simulation only.
//
// Writers under test (model numbering): W1 completion, W4 drainTick, W7 IDEA-reactivation,
// W11 abort-defence, W13 pause(), W16 decide-timeout, W24 auto-resume (approximated —
// lives in index.ts session_start, outside MissionLoop), W25 re-read skip (fix 1.5.5).
//
// Run: npx vitest run bundles/fan-mission/extensions/fan-mission/mission-fsm-scenarios.test.ts

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendBacklog,
	canTransition,
	type BacklogEntry,
	initMission,
	InvalidTransitionError,
	readBacklog,
	readDecisions,
	readMission,
	readRecurring,
	readRecurringState,
	readRoadmap,
	readState,
	writeMissionStatus,
	writeRoadmap,
} from "./file-state-manager.js";
import { findAttachableMission } from "./index.js";
import { promoteAcceptedIdeas } from "./idea-promoter.js";
import { clearMissionAbortArtifacts, MissionLoop, readMissionLoopState, writeLoopStateSync } from "./mission-loop.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

const tmpRoot = join(tmpdir(), `fan-mission-fsm-scenarios-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let missionDir: string;

const MISSION_TEMPLATE = `---
mission_id: test-fsm-scenarios
created: 2026-08-27T00:00:00.000Z
status: active
metric_type: checklist
metric_command: echo done
budget_tokens: 1000000
budget_usd: 10
max_depth: 3
max_width: 5
session_mode: persistent
---

# Test Mission
`;

interface MissionDirOpts {
	roadmap?: string;
	sessionMode?: "fresh" | "persistent";
	status?: string;
}

/** Write the 5 mission files into an existing directory (no mkdir). */
function createMissionFiles(dir: string, opts?: MissionDirOpts): void {
	let mission = MISSION_TEMPLATE;
	if (opts?.sessionMode) mission = mission.replace("session_mode: persistent", `session_mode: ${opts.sessionMode}`);
	if (opts?.status) mission = mission.replace("status: active", `status: ${opts.status}`);
	writeFileSync(join(dir, "MISSION.md"), mission, "utf8");
	writeFileSync(join(dir, "ROADMAP.md"), opts?.roadmap ?? "- [ ] Do the thing", "utf8");
	writeFileSync(join(dir, "STATE.md"), "## Сделано\n\n## Блокеры\n\n## Следующие шаги\n", "utf8");
	writeFileSync(join(dir, "BACKLOG.md"), "", "utf8");
	writeFileSync(join(dir, "DECISIONS.md"), "", "utf8");
}

function createMissionDir(opts?: MissionDirOpts): string {
	const dir = join(tmpRoot, `mission-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createMissionFiles(dir, opts);
	return dir;
}

/** Recreate the fixture dir mid-test (afterEach still cleans up the final one). */
function resetMissionDir(opts?: MissionDirOpts): void {
	try {
		rmSync(missionDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
	missionDir = createMissionDir(opts);
}

function createMockDeps(overrides?: { executorResult?: { status: string; response?: string } }): {
	executor: { runIteration: ReturnType<typeof vi.fn> };
	git: { commit: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
	clock: { now: () => Date };
	lock: { acquire: () => Promise<boolean>; release: () => Promise<void> };
} {
	const result = overrides?.executorResult ?? { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
	return {
		executor: { runIteration: vi.fn().mockResolvedValue(result) },
		git: {
			commit: vi.fn().mockResolvedValue({ hash: "abc123" }),
			log: vi.fn().mockResolvedValue([]),
			status: vi.fn().mockResolvedValue({ clean: true }),
		},
		clock: { now: () => new Date("2026-08-27T12:00:00.000Z") },
		lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
	};
}

/** deps whose executor runs `action` mid-tick (pause()/abort()/status-writer simulation). */
function createMidTickActionDeps(
	loopRef: { current?: MissionLoop },
	action: (loop: MissionLoop) => Promise<void>,
): ReturnType<typeof createMockDeps> {
	const deps = createMockDeps();
	deps.executor.runIteration.mockImplementation(async () => {
		await action(loopRef.current as MissionLoop);
		return { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
	});
	return deps;
}

function ideaEntry(id: string, text: string, overrides?: Partial<BacklogEntry>): BacklogEntry {
	return {
		id,
		date: "2026-08-27T12:00:00.000Z",
		idea: text,
		source: "operator",
		fit: 0,
		value: 0,
		risk: 0,
		cost: 0,
		score: 0,
		status: "IDEA",
		...overrides,
	};
}

async function currentStatus(dir: string = missionDir): Promise<string> {
	const mission = await readMission(dir);
	return String(mission.frontmatter.status);
}

const COMPLETE_RESULT = { status: "COMPLETE", response: "<promise>COMPLETE</promise>" } as const;

/**
 * Модель session_start (index.ts:590-605), проход 2 — «completed-дежурство»:
 * completed-миссия аттачится только при наличии RECURRING-пунктов или строк
 * ожидающих идей (IDEA/ROADMAP) в BACKLOG.
 * (Локальная копия предиката: NON_TERMINAL_STATUSES и сам предикат не экспортируются из index.ts.)
 */
const COMPLETED_DUTY_ACCEPT = (status: string, dir: string): boolean => {
	if (status !== "completed") return false;
	if (readRecurring(dir).length > 0) return true;
	try {
		const raw = readFileSync(join(dir, "BACKLOG.md"), "utf8");
		return /\|.*\|\s*(IDEA|ROADMAP)\s*\|/.test(raw);
	} catch {
		return false;
	}
};

beforeEach(() => {
	missionDir = createMissionDir();
});

afterEach(() => {
	try {
		rmSync(missionDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

beforeAll(() => {
	mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ─── Scenario matrix ───────────────────────────────────────────────────────

describe("fan-mission FSM scenario matrix (S1–S28, модель .fan/reports/fsm-model-mission.md)", () => {
	it("S1: init → bootstrap-планирование → итерации → completed (recurring пуст)", async () => {
		// Реальный initMission (шаблон default): ROADMAP = bootstrap-пункт.
		const dir = await initMission("fsm-s1", { baseDir: tmpRoot, description: "Scenario S1 goal" });
		try {
			// init даёт session_mode: fresh — для детерминизма гоним persistent.
			writeFileSync(
				join(dir, "MISSION.md"),
				readFileSync(join(dir, "MISSION.md"), "utf8").replace("session_mode: fresh", "session_mode: persistent"),
				"utf8",
			);

			const deps = createMockDeps();
			let calls = 0;
			deps.executor.runIteration.mockImplementation(async () => {
				calls++;
				if (calls === 1) {
					// Bootstrap-итерация: планировщик дописывает конкретные пункты (как реальный executor).
					const raw = readFileSync(join(dir, "ROADMAP.md"), "utf8");
					writeFileSync(
						join(dir, "ROADMAP.md"),
						`${raw}- [ ] Implement feature A\n- [ ] Implement feature B\n`,
						"utf8",
					);
				}
				return COMPLETE_RESULT;
			});
			const loop = new MissionLoop({ missionDir: dir, deps });
			const result = await loop.tick();

			// (1) итоговый статус
			expect(result.status).toBe("completed");
			expect(await currentStatus(dir)).toBe("completed");
			// (2) побочные артефакты: ROADMAP все [x], backlog 3 COMPLETE-записи
			const roadmap = await readRoadmap(dir);
			expect(roadmap).toContain("- [x] Bootstrap mission: fsm-s1");
			expect(roadmap).toContain("- [x] Implement feature A");
			expect(roadmap).toContain("- [x] Implement feature B");
			expect((await readBacklog(dir)).filter((e) => e.status === "COMPLETE")).toHaveLength(3);
			expect(deps.executor.runIteration).toHaveBeenCalledTimes(3);
			// (3) аномалий нет; recurring пуст (init создаёт RECURRING.md-шаблон без пунктов)
			expect(existsSync(join(dir, ".mission-abort-signal"))).toBe(false);
			expect(readRecurring(dir)).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("S2: completed + recurring → дежурство: recur-пункт исполняется, статус остаётся completed", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		writeFileSync(join(missionDir, "RECURRING.md"), "# Recurring\n\n- [ ] Check the perimeter (interval: 5m)\n", "utf8");
		await writeMissionStatus(missionDir, "completed");

		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(await currentStatus(missionDir)).toBe("completed");
		expect(result.itemsExecuted).toBe(1);
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1);
		// STATE.md: recur-результат записан в done
		expect((await readState(missionDir)).done).toContain("Check the perimeter");
		// .recurring-state.json обновлён (интервал-гейт работает)
		expect(Object.keys(readRecurringState(missionDir))).toHaveLength(1);
		// ROADMAP recur-фазой не трогается
		expect(await readRoadmap(missionDir)).toBe("- [x] Done thing\n");
	});

	it("S3: completed + IDEA → active (W7) → промоушен → исполнение → completed", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		await writeMissionStatus(missionDir, "completed");
		await appendBacklog(missionDir, ideaEntry("idea-s3", "Operator idea for S3"));

		const deps = createMockDeps();
		const observed: string[] = [];
		deps.executor.runIteration.mockImplementation(async () => {
			// Executor запускается ПОСЛЕ реактивации — должен видеть active, не completed.
			observed.push(await currentStatus(missionDir));
			return COMPLETE_RESULT;
		});
		const loop = new MissionLoop({
			missionDir,
			deps,
			ideaPromoter: { promote: (d) => promoteAcceptedIdeas(d) },
		});
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(await currentStatus(missionDir)).toBe("completed");
		expect(observed).toEqual(["active"]); // промежуточный active зафиксирован
		// IDEA не потеряна: статусы IDEA → ROADMAP → PROMOTED
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s3")?.status).toBe("PROMOTED");
		expect(await readRoadmap(missionDir)).toContain("- [x] Operator idea for S3 (idea:idea-s3)");
	});

	it("S4: fresh-mode (итерация+ротация) vs persistent (непрерывное исполнение)", async () => {
		// (a) fresh + rotator: одна итерация за тик, resumeAfterRotation
		resetMissionDir({ roadmap: "- [ ] First\n- [ ] Second\n", sessionMode: "fresh" });
		const rotator = { rotate: vi.fn().mockResolvedValue({ cancelled: false }) };
		const freshDeps = createMockDeps();
		const freshLoop = new MissionLoop({ missionDir, deps: { ...freshDeps, sessionRotator: rotator } });
		const freshResult = await freshLoop.tick();

		expect(freshResult.status).toBe("active");
		expect(freshDeps.executor.runIteration).toHaveBeenCalledTimes(1);
		expect(rotator.rotate).toHaveBeenCalledTimes(1);
		const freshRoadmap = await readRoadmap(missionDir);
		expect(freshRoadmap).toContain("- [x] First");
		expect(freshRoadmap).toContain("- [ ] Second");
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBe(true);

		// (b) persistent: оба пункта за один тик
		resetMissionDir({ roadmap: "- [ ] First\n- [ ] Second\n" });
		const persistentDeps = createMockDeps();
		const persistentLoop = new MissionLoop({ missionDir, deps: persistentDeps });
		const persistentResult = await persistentLoop.tick();

		expect(persistentResult.status).toBe("completed");
		expect(persistentDeps.executor.runIteration).toHaveBeenCalledTimes(2);
		const persistentRoadmap = await readRoadmap(missionDir);
		expect(persistentRoadmap).toContain("- [x] First");
		expect(persistentRoadmap).toContain("- [x] Second");
	});

	it("S5: active + /mission:pause → paused → tick no-op → resume → active → тик работает", async () => {
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });

		// W13/W17: active → paused
		await loop.pause();
		expect(await currentStatus(missionDir)).toBe("paused");
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
		expect((await readMissionLoopState(missionDir)).abortedByOperator).not.toBe(true);

		// P1-2: tick на paused — no-op, executor не вызывается
		const pausedResult = await loop.tick();
		expect(pausedResult.status).toBe("paused");
		expect(deps.executor.runIteration).not.toHaveBeenCalled();

		// resume (модель /mission:resume): paused → active + очистка протухших артефактов
		await writeMissionStatus(missionDir, "active");
		await clearMissionAbortArtifacts(missionDir);

		const resumed = await loop.tick();
		expect(resumed.status).toBe("completed");
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1);
		expect(await readRoadmap(missionDir)).toContain("- [x] Do the thing");
	});

	it("S6: shutdown mid-tick, работа осталась → paused (исполнение останавливается)", async () => {
		resetMissionDir({ roadmap: "- [ ] First\n- [ ] Second\n" });
		const loopRef: { current?: MissionLoop } = {};
		const deps = createMidTickActionDeps(loopRef, (loop) => loop.pause());
		const loop = new MissionLoop({ missionDir, deps });
		loopRef.current = loop;
		const result = await loop.tick();

		expect(result.status).toBe("paused");
		expect(await currentStatus(missionDir)).toBe("paused");
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1);
		// завершённый пункт зафиксирован, оставшийся — нет (статус НЕ completed)
		const roadmap = await readRoadmap(missionDir);
		expect(roadmap).toContain("- [x] First");
		expect(roadmap).toContain("- [ ] Second");
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
	});

	it("S7: shutdown mid-tick, последний пункт, работы нет → completed (фикс 1.5.5, fresh)", async () => {
		resetMissionDir({ sessionMode: "fresh" }); // один unchecked-пункт
		const rotator = { rotate: vi.fn().mockResolvedValue({ cancelled: false }) };
		const loopRef: { current?: MissionLoop } = {};
		const deps = createMidTickActionDeps(loopRef, (loop) => loop.pause());
		const loop = new MissionLoop({ missionDir, deps: { ...deps, sessionRotator: rotator } });
		loopRef.current = loop;
		const result = await loop.tick();

		// W25: re-read при paused + работы нет → fall-through в completion (не замирает в paused)
		expect(result.status).toBe("completed");
		expect(await currentStatus(missionDir)).toBe("completed");
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
		expect((await readBacklog(missionDir)).some((e) => e.idea === "Completed: Do the thing")).toBe(true);
	});

	it("S8: shutdown mid-tick + IDEA в бэклоге → paused, IDEA не потеряна", async () => {
		await appendBacklog(missionDir, ideaEntry("idea-s8", "Future idea"));
		const loopRef: { current?: MissionLoop } = {};
		const deps = createMidTickActionDeps(loopRef, (loop) => loop.pause());
		const loop = new MissionLoop({ missionDir, deps });
		loopRef.current = loop;
		const result = await loop.tick();

		// isMissionWorkDone() = false (IDEA в бэклоге) → W25 НЕ завершает, пауза сохраняется
		expect(result.status).toBe("paused");
		expect(await currentStatus(missionDir)).toBe("paused");
		expect(await readRoadmap(missionDir)).toContain("- [x] Do the thing"); // пункт доработан
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s8")?.status).toBe("IDEA"); // не потеряна
	});

	it("S9: paused + session_start auto-resume → active → тик работает (аппроксимация W24)", async () => {
		// W24 живёт в index.ts session_start — вне MissionLoop. Аппроксимация: ручной
		// writeMissionStatus(paused→active) + сброс interrupted (index.ts:613-625), затем тик.
		await writeMissionStatus(missionDir, "paused");
		writeLoopStateSync(missionDir, {
			currentIteration: 2,
			lastStep: 4,
			interrupted: true,
			budgetUsed: { tokens: 0, usd: 0 },
		});

		// До resume: tick — no-op (P1-2)
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		expect((await loop.tick()).status).toBe("paused");
		expect(deps.executor.runIteration).not.toHaveBeenCalled();

		// Аппроксимация session_start
		await writeMissionStatus(missionDir, "active");
		const ls = await readMissionLoopState(missionDir);
		if (ls.interrupted) {
			ls.interrupted = false;
			writeLoopStateSync(missionDir, ls);
		}

		const result = await loop.tick();
		expect(result.status).toBe("completed");
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1);
		expect((await readMissionLoopState(missionDir)).interrupted).toBe(false);
	});

	it("S10a: R3 — tick уже записал completed → последующий pause игнорируется, статус не меняется", async () => {
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		expect(await currentStatus(missionDir)).toBe("completed");

		// pause() читает статус, видит terminal → early return: InvalidTransitionError
		// не возникает вовсе (гвард в pause(), а не на FSM-слое).
		await expect(loop.pause()).resolves.toBeUndefined();
		expect(await currentStatus(missionDir)).toBe("completed");
		// Сырой FSM-слой тем не менее запрещает completed → paused
		expect(canTransition("completed", "paused")).toBe(false);
	});

	it("S10b: R3 — pause записан первым → тик дорабатывает → W25 решает: completed (работы нет)", async () => {
		// Последовательная аппроксимация интерливинга: pause-запись посреди тика
		// (в реальности /mission:pause и tick completion конкурируют на ФС).
		const loopRef: { current?: MissionLoop } = {};
		const deps = createMidTickActionDeps(loopRef, (loop) => loop.pause());
		const loop = new MissionLoop({ missionDir, deps });
		loopRef.current = loop;
		const result = await loop.tick();

		// W25 + FSM paused→completed (фикс 1.5.5): миссия финализируется честно
		expect(result.status).toBe("completed");
		expect(await currentStatus(missionDir)).toBe("completed");
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1);
		// Нет аномалии: abort-артефакты не появились, статус «не прыгнул» в aborted
		expect((await readMissionLoopState(missionDir)).abortedByOperator).not.toBe(true);
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
	});

	it("S11: /idea на completed → appendBacklog + writeStatus(active) (обработчик) → tick промоутит и завершает", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		await writeMissionStatus(missionDir, "completed");

		// Модель обработчика /idea (slash-commands.ts:303-334):
		// appendBacklog → completed+IDEA → canTransition разрешает → writeStatus(active).
		await appendBacklog(missionDir, ideaEntry("idea-s11", "Operator idea for S11"));
		await writeMissionStatus(missionDir, "active");
		await clearMissionAbortArtifacts(missionDir);

		const deps = createMockDeps();
		const loop = new MissionLoop({
			missionDir,
			deps,
			ideaPromoter: { promote: (d) => promoteAcceptedIdeas(d) },
		});
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s11")?.status).toBe("PROMOTED");
		expect(await readRoadmap(missionDir)).toContain("- [x] Operator idea for S11 (idea:idea-s11)");
	});

	it("S12: /idea на active → запись в бэклог, подхват fallback-промоушеном в том же тике", async () => {
		// /idea при активной миссии: только appendBacklog (статус не меняется)
		await appendBacklog(missionDir, ideaEntry("idea-s12", "Operator idea during active mission"));

		const deps = createMockDeps();
		const loop = new MissionLoop({
			missionDir,
			deps,
			ideaPromoter: { promote: (d) => promoteAcceptedIdeas(d) },
		});
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		// «Подхват следующей итерацией»: pre-completion fallback IDEA→ROADMAP→промоушен→исполнение
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(2);
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s12")?.status).toBe("PROMOTED");
		expect(await readRoadmap(missionDir)).toContain("- [x] Operator idea during active mission (idea:idea-s12)");
	});

	it("S13: промоушен fallback без скорера → pre-scored ROADMAP-идея исполняется", async () => {
		await appendBacklog(
			missionDir,
			ideaEntry("idea-s13", "Scored idea", { source: "scorer", status: "ROADMAP" }),
		);

		const deps = createMockDeps();
		const loop = new MissionLoop({
			missionDir,
			deps,
			ideaPromoter: { promote: (d) => promoteAcceptedIdeas(d) },
		});
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		// Пост-шаг-7 хук (scoreExistingIdeas=false) промоутит ROADMAP-запись → вторая итерация
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(2);
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s13")?.status).toBe("PROMOTED");
		expect(await readRoadmap(missionDir)).toContain("- [x] Scored idea (idea:idea-s13)");
	});

	it("S14: DECIDE-скоринг → awaiting_decision → resolveDecision(accept) → промоушен → исполнение → completed", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		await appendBacklog(missionDir, ideaEntry("idea-s14", "Risky idea needing decision"));

		const deps = createMockDeps();
		const loop = new MissionLoop({
			missionDir,
			deps,
			ideaScorer: { scoreIdea: vi.fn().mockResolvedValue({ id: "idea-s14", score: 0.4, status: "DECIDE" as const }) },
			ideaPromoter: { promote: (d) => promoteAcceptedIdeas(d) },
		});
		const result = await loop.tick();

		// W5/W9: скоринг дал DECIDE → awaiting_decision (completion блокирован)
		expect(result.status).toBe("awaiting_decision");
		expect(await currentStatus(missionDir)).toBe("awaiting_decision");
		const pending = (await readDecisions(missionDir)).find((d) => d.status === "pending");
		expect(pending?.context).toContain("Risky idea needing decision");
		expect(pending?.context).toContain("0.4");
		// IDEA не потеряна: статус не менялся до вердикта оператора
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s14")?.status).toBe("IDEA");
		expect((await readMissionLoopState(missionDir)).pendingDecisionIdeaId).toBe("idea-s14");

		// W14: resolveDecision(accept) → active, идея → ROADMAP, ADR accepted
		await loop.resolveDecision("accept");
		expect(await currentStatus(missionDir)).toBe("active");
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s14")?.status).toBe("ROADMAP");
		expect((await readDecisions(missionDir)).some((d) => d.status === "accepted")).toBe(true);

		// Принятая идея (BACKLOG status ROADMAP) — работа: pre-completion ветка
		// следующего тика промоутит её в ROADMAP.md → итерация исполняет → completed.
		const second = await loop.tick();
		expect(second.status).toBe("completed");
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1); // промоученная идея исполнена
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s14")?.status).toBe("PROMOTED");
		expect(await readRoadmap(missionDir)).toContain("- [x] Risky idea needing decision (idea:idea-s14)");
	});

	it("S15: исчерпанное планирование → completed (мёртвая planning-cap ветка удалена)", async () => {
		// Модель (W9) предполагала: 2 planning-итерации без новых пунктов →
		// awaiting_decision (emptyPlanningStreak, условие nextItem.index === -1).
		// Но index === -1 недостижим: parseAllUnchecked возвращает индексы >= 0,
		// nextItem = allUnchecked[0] ?? null. Мёртвая ветка удалена — исчерпанный
		// планировщик честно завершает миссию как completed.
		resetMissionDir({ roadmap: "- [ ] Bootstrap: plan everything\n" });

		const deps = createMockDeps();
		let calls = 0;
		deps.executor.runIteration.mockImplementation(async () => {
			calls++;
			if (calls <= 2) {
				const raw = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
				writeFileSync(join(missionDir, "ROADMAP.md"), `${raw}- [ ] Planning artifact ${calls}\n`, "utf8");
			}
			return COMPLETE_RESULT;
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Честное поведение: ROADMAP исчерпана → completed (не awaiting_decision)
		expect(result.status).toBe("completed");
		expect(await currentStatus(missionDir)).toBe("completed");
		expect(calls).toBe(3); // bootstrap + 2 артефакта планирования, затем ROADMAP исчерпан
	});

	it("S16: /mission:stop при незавершённой работе → aborted, пункт остаётся unchecked", async () => {
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		expect(await currentStatus(missionDir)).toBe("aborted");
		// работа не потеряна: пункт остался unchecked
		expect(await readRoadmap(missionDir)).toContain("- [ ] Do the thing");
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.abortedByOperator).toBe(true);
		// сигнал очищен сразу (тик не запущен) — на терминальной миссии артефактов нет
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
	});

	it("S17: /mission:stop при исчерпанном ROADMAP → completed (W11 abort-defence)", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		// Ложный abort предотвращён: работы нет → честный completed
		expect(await currentStatus(missionDir)).toBe("completed");
		expect((await readMissionLoopState(missionDir)).abortedByOperator).toBe(false);
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
		expect(deps.executor.runIteration).not.toHaveBeenCalled();
	});

	it("S18: abort-сигнал mid-tick → тик сгорает aborted, пункт НЕ коммитится", async () => {
		const loopRef: { current?: MissionLoop } = {};
		const deps = createMidTickActionDeps(loopRef, (loop) => loop.abort());
		const loop = new MissionLoop({ missionDir, deps });
		loopRef.current = loop;
		const result = await loop.tick();

		expect(result.status).toBe("aborted");
		expect(result.interrupted).toBe(true);
		expect(await currentStatus(missionDir)).toBe("aborted");
		// (2) артефакты: пункт не закрыт, STATE.md без done, BACKLOG без записи шага 7
		expect(await readRoadmap(missionDir)).toContain("- [ ] Do the thing");
		expect((await readState(missionDir)).done).toHaveLength(0);
		expect(await readBacklog(missionDir)).toHaveLength(0);
		// (3) аномалий нет: сигнал погашен abortTick'ом, журнал помечен
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
		expect((await readMissionLoopState(missionDir)).abortedByOperator).toBe(true);
	});

	it("S19: ROADMAP без чеклиста → failed (защита от ложного completion)", async () => {
		resetMissionDir({ roadmap: "# ROADMAP\n\nProse only, no checklist items.\n" });
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("failed");
		expect(result.item).toContain("no parseable checklist");
		expect(await currentStatus(missionDir)).toBe("failed");
		expect(deps.executor.runIteration).not.toHaveBeenCalled();
		expect((await readState(missionDir)).done).toHaveLength(0);
	});

	it("S20: aborted + /mission:start → active → тик дорабатывает → completed", async () => {
		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();
		expect(await currentStatus(missionDir)).toBe("aborted");

		// Модель lazyAttachForStart (slash-commands.ts:154-160): FSM-переход + очистка abort-артефактов
		expect(canTransition("aborted", "active")).toBe(true);
		await writeMissionStatus(missionDir, "active");
		await clearMissionAbortArtifacts(missionDir);

		const result = await loop.tick();
		expect(result.status).toBe("completed");
		expect(await readRoadmap(missionDir)).toContain("- [x] Do the thing");
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.abortedByOperator).toBe(false);
		expect(loopState.interrupted).toBe(false);
	});

	it("S21: decide timeout → aborted (W16; таймаут ускорен decideTimeoutMs)", async () => {
		const deps = createMockDeps({
			executorResult: { status: "DECIDE", response: "<promise>DECIDE: Approve deploy window</promise>" },
		});
		const loop = new MissionLoop({ missionDir, deps, decideTimeoutMs: 50 });
		const result = await loop.tick();

		expect(result.status).toBe("awaiting_decision");
		expect(await currentStatus(missionDir)).toBe("awaiting_decision");
		expect((await readDecisions(missionDir)).some((d) => d.status === "pending")).toBe(true);

		// W16: по таймауту — STATE.md blocker decide_timeout + aborted
		await vi.waitFor(
			async () => {
				expect(await currentStatus(missionDir)).toBe("aborted");
			},
			{ timeout: 3000, interval: 50 },
		);
		expect((await readState(missionDir)).blockers).toContain("decide_timeout");
		expect(existsSync(join(missionDir, ".mission-abort-signal"))).toBe(false);
	});

	it("S22: crash mid-tick (interrupted=true, lastStep=4) → recovery: executor пропущен, итерация НЕ инкрементируется", async () => {
		// Симуляция SIGKILL между шагами 4 и 5: результат iterationResult уже в журнале.
		writeLoopStateSync(missionDir, {
			currentIteration: 5,
			lastStep: 4,
			interrupted: true,
			budgetUsed: { tokens: 120, usd: 0.5 },
			iterationResult: { status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			pendingItem: "Do the thing",
			pendingItemIndex: 0,
			committed: false,
		});

		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(result.iteration).toBe(5); // ключ: повторного инкремента нет
		expect(deps.executor.runIteration).not.toHaveBeenCalled(); // восстановлено из журнала
		expect(await readRoadmap(missionDir)).toContain("- [x] Do the thing");
		expect((await readBacklog(missionDir)).some((e) => e.idea === "Completed: Do the thing")).toBe(true);
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.interrupted).toBe(false);
		expect(loopState.iterationResult).toBeUndefined();
	});

	it("S23: completed без recurring/IDEA не аттачится в session_start (логика фильтра)", async () => {
		// Только фильтр: findAttachableMission + предикаты session_start (без полного хука).
		const cwd = join(tmpRoot, `s23-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const alpha = join(cwd, "docs", "missions", "alpha");
		mkdirSync(alpha, { recursive: true });
		createMissionFiles(alpha, { roadmap: "- [x] Done thing\n" });
		await writeMissionStatus(alpha, "completed");

		const acceptNonTerminal = (status: string): boolean =>
			["active", "paused", "awaiting_decision"].includes(status);

		// Проход 1 (не-терминальные) → null; проход 2 (completed-дежурство) → null
		expect(await findAttachableMission(cwd, (s) => acceptNonTerminal(s))).toBeNull();
		expect(await findAttachableMission(cwd, COMPLETED_DUTY_ACCEPT)).toBeNull();

		// Контраст 1: RECURRING.md с parseable-пунктом → дежурный аттач
		writeFileSync(join(alpha, "RECURRING.md"), "# Recurring\n\n- [ ] Watch (interval: 5m)\n", "utf8");
		expect((await findAttachableMission(cwd, COMPLETED_DUTY_ACCEPT))?.missionDir).toBe(alpha);
		expect((await findAttachableMission(cwd, (s) => acceptNonTerminal(s)))).toBeNull();

		// Контраст 2: ожидающая идея в бэклоге → дежурный аттач.
		// (2a) только ROADMAP-строка: идея принята оператором (DECIDE→accept),
		// ждёт промоушена — для session_start это тоже работа.
		rmSync(join(alpha, "RECURRING.md"));
		writeFileSync(join(alpha, "BACKLOG.md"), "", "utf8");
		await appendBacklog(alpha, ideaEntry("idea-s23a", "Duty idea accepted", { status: "ROADMAP" }));
		expect((await findAttachableMission(cwd, COMPLETED_DUTY_ACCEPT))?.missionDir).toBe(alpha);

		// (2b) классическая IDEA-строка
		writeFileSync(join(alpha, "BACKLOG.md"), "", "utf8");
		await appendBacklog(alpha, ideaEntry("idea-s23", "Duty idea"));
		expect((await findAttachableMission(cwd, COMPLETED_DUTY_ACCEPT))?.missionDir).toBe(alpha);

		// Контраст 3: рядом active-миссия → не-терминальный проход находит её
		const beta = join(cwd, "docs", "missions", "beta");
		mkdirSync(beta, { recursive: true });
		createMissionFiles(beta, {});
		expect((await findAttachableMission(cwd, (s) => acceptNonTerminal(s)))?.missionDir).toBe(beta);
	});

	it("S24: /mission:pause на completed → no-op без throw, статус не меняется (FSM запрещает)", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		await writeMissionStatus(missionDir, "completed");

		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		// pause() гвардится чтением статуса: терминальный → ранний return, throw нет
		await expect(loop.pause()).resolves.toBeUndefined();
		expect(await currentStatus(missionDir)).toBe("completed");
		expect(deps.executor.runIteration).not.toHaveBeenCalled();

		// Сырой FSM-слой отклонил бы запись — потому гвард и нужен
		expect(canTransition("completed", "paused")).toBe(false);
		await expect(writeMissionStatus(missionDir, "paused")).rejects.toThrow(InvalidTransitionError);
		expect(await currentStatus(missionDir)).toBe("completed"); // статус не «прыгнул»
	});

	it("S25: budget_exhausted — документированная ловушка: tick no-op, FSM разрешает →active, писателя нет", async () => {
		// FSM: active → budget_exhausted разрешён (запись возможна — legacy-миссии)
		await writeMissionStatus(missionDir, "budget_exhausted");
		expect(await currentStatus(missionDir)).toBe("budget_exhausted");

		const deps = createMockDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// tick — no-op: терминальный статус, executor не вызывается, статус не меняется
		expect(result.status).toBe("budget_exhausted");
		expect(await currentStatus(missionDir)).toBe("budget_exhausted");
		expect(deps.executor.runIteration).not.toHaveBeenCalled();

		// FSM реактивацию разрешает — но в MissionLoop нет ни одного писателя
		// budget_exhausted → active (L0: бюджет неограничен, статус — рудимент).
		expect(canTransition("budget_exhausted", "active")).toBe(true);
	});

	// ─── ROADMAP-статус = работа (фикс потери принятых идей) ────────────────

	it("S26: completed + ROADMAP-запись (принятая идея) → реактивация → промоушен → исполнение → completed", async () => {
		resetMissionDir({ roadmap: "- [x] Done thing\n" });
		await writeMissionStatus(missionDir, "completed");
		await appendBacklog(
			missionDir,
			ideaEntry("idea-s26", "Accepted but unpromoted idea", { status: "ROADMAP" }),
		);

		const deps = createMockDeps();
		const loop = new MissionLoop({
			missionDir,
			deps,
			ideaPromoter: { promote: (d) => promoteAcceptedIdeas(d) },
		});
		const result = await loop.tick();

		// ROADMAP-запись будит completed-миссию: тик идёт в основной цикл (не recur-фазу)
		expect(deps.executor.runIteration).toHaveBeenCalledTimes(1);
		// Pre-completion fallback промоутит запись → итерация исполняет → completed
		expect(result.status).toBe("completed");
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s26")?.status).toBe("PROMOTED");
		expect(await readRoadmap(missionDir)).toContain("- [x] Accepted but unpromoted idea (idea:idea-s26)");
	});

	it("S27: shutdown mid-tick + ROADMAP-запись в бэклоге → paused (isMissionWorkDone = false)", async () => {
		await appendBacklog(
			missionDir,
			ideaEntry("idea-s27", "Accepted idea awaiting promotion", { status: "ROADMAP" }),
		);
		const loopRef: { current?: MissionLoop } = {};
		const deps = createMidTickActionDeps(loopRef, (loop) => loop.pause());
		const loop = new MissionLoop({ missionDir, deps });
		loopRef.current = loop;
		const result = await loop.tick();

		// isMissionWorkDone() = false (ROADMAP-запись тоже работа) → W25 НЕ завершает
		expect(result.status).toBe("paused");
		expect(await currentStatus(missionDir)).toBe("paused");
		expect((await readBacklog(missionDir)).find((e) => e.id === "idea-s27")?.status).toBe("ROADMAP");
	});

	it("S28: session_start-regex матчит | ROADMAP | строку бэклога (дежурный аттач)", () => {
		// Модель дежурного прохода 2: regex по сырому BACKLOG.md без полного парсинга.
		const row = (status: string, idea: string): string =>
			`| idea-001 | 2026-08-27 | ${idea} | operator | 0 | 0 | 0 | 0 | 0 | ${status} |\n`;
		const regex = /\|.*\|\s*(IDEA|ROADMAP)\s*\|/;

		expect(regex.test(row("IDEA", "Fresh operator idea"))).toBe(true);
		expect(regex.test(row("ROADMAP", "Accepted idea awaiting promotion"))).toBe(true);
		// Не-pending статусы не матчатся
		expect(regex.test(row("COMPLETE", "Done work"))).toBe(false);
		expect(regex.test(row("PROMOTED", "Already in ROADMAP"))).toBe(false);
		expect(regex.test(row("REJECTED", "Rejected idea"))).toBe(false);
		// Заголовок таблицы без статус-строк — нет совпадения
		expect(regex.test("| id | date | idea | source | fit | value | risk | cost | score | status |\n")).toBe(false);
	});
});
