// Фаза A (F-16/F-17/F-18): Маршрутизация тегов обещаний в mission-loop — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md
//           §F-16 (парсер), §F-17 (DECIDE), §F-18 (лестница) — E2E-сценарии
//           фазы A (1–3) и Smoke-критерий фазы («4 тега»).
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.4, §3.1.3.
//
// Контракт интеграции (новые DI-опции MissionLoop, поверх существующих
// { missionDir, deps, drainFlag?, decideTimeoutMs? }):
//
//   constructor(opts: {
//     ...,
//     verificationLadder?: { run(missionDir: string): Promise<{
//       passed: boolean; failedStep: string | null; diagnosis: string | null }> },
//     onEscalate?: (level: string, payload: {
//       tag: string | null; reason?: string; iteration: number }) => void,
//   })
//
// Правила маршрутизации (после итерации, до шага 5 verify):
//   1. parsePromise(iterResult.response) вызывается на raw-ответе executor'а.
//   2. Тег найден (COMPLETE/BLOCKED/FAILED) → определяет исход итерации
//      (приоритет над iterResult.status); reason из тега → iterResult.reason.
//   3. Тега нет → onEscalate("I3", { tag: null, ... }) + fallback на status.
//   4. BLOCKED → блокер в STATE.md + onEscalate("I3", { tag:"BLOCKED", reason })
//      + контур продолжает следующую итерацию.
//   5. FAILED → диагноз в STATE.md (блокеры) + контур продолжает (повтор).
//   6. COMPLETE + verificationLadder → шаг 5 вызывает ladder.run(missionDir):
//        { passed:true }  → commit (шаг 6 как обычно)
//        { passed:false } → итерация НЕ коммитится, статус итерации FAILED,
//                           диагноз в STATE.md (блокеры), контур продолжает.
//   7. COMPLETE без verificationLadder → поведение как сейчас (backward compat).
//
// На момент Red-фазы:
//   - parsePromise вызывается только для DECIDE (F-17 уже реализован);
//     COMPLETE/BLOCKED/FAILED теги парсятся, но игнорируются — исход берётся
//     из iterResult.status, reason тега не подставляется в iterResult.reason.
//   - Конструктор НЕ принимает verificationLadder / onEscalate (в .mjs лишние
//     поля destructuring-а молча отбрасываются — символы остаются undefined).
//   - Лестница не подключена к шагу 5; эскалации нет.
//
// Поэтому часть тестов — guards/smoke по УЖЕ реализованному поведению —
// проходят (DECIDE-smoke как повтор F-17; backward-compat COMPLETE без
// лестницы; «контур продолжает» после BLOCKED). Все тесты НОВОЙ маршрутизации
// (BLOCKED/FAILED по тегу с reason из тега, лестница на COMPLETE, эскалация
// I3, приоритет тега над status, no-tag fallback) — FAIL (Red).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readState } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import { parsePromise } from "../promise-parser.js";

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock-объекты для DI (стиль mission-loop-decide.test.mjs)
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-memory записывающий мок executor'а.
 * iterationResults — массив IterationResult; по исчерпании возвращает последний.
 * Контракт фазы A: executor возвращает `response` (raw LLM-вывод с тегом
 * <promise>…) + `status` (fallback, если тег не определит исход).
 * ВАЖНО: reason intentionally НЕ кладётся в IterationResult — он должен
 * приехать из тега (это и проверяет маршрутизация).
 */
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
		async log({ cwd, maxCount = 10 }) {
			return commits.slice(-maxCount).map((c) => ({
				hash: c.hash,
				subject: c.message,
				date: new Date().toISOString(),
			}));
		},
		async status({ cwd }) {
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
	result.executorCalls = result.executor.calls;
	return result;
}

/**
 * Mock verification-ladder: записывает вызовы run() и возвращает фиксированный
 * результат. opts.throw — Error, который бросает run() (edge «лестница упала»).
 */
function makeMockLadder(
	result = { passed: true, failedStep: null, diagnosis: null },
	opts = {},
) {
	const calls = [];
	return {
		calls,
		async run(missionDir) {
			calls.push({ missionDir });
			if (opts.throw) throw opts.throw;
			return {
				passed: result.passed,
				failedStep: result.failedStep ?? null,
				diagnosis: result.diagnosis ?? null,
			};
		},
	};
}

function freshBaseDir(prefix = "fan-phaseA-red-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// E2E-сценарий 1 (BLOCKED): тег → блокер + эскалация I3 + продолжение
// ────────────────────────────────────────────────────────────────────────────

describe("Phase A / E2E-1: BLOCKED-tag → блокер + эскалация I3 + продолжение", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseA-e2e1-");
		missionDir = await initMission("e2e-blocked", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] risky thing",
			"- [ ] follow-up item",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("E2E-1: STATE.md «Блокеры» содержит причину ИЗ ТЕГА", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "BLOCKED",
					response: "<promise>BLOCKED:нет доступа к БД</promise>",
				},
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		expect(state.blockers.some((b) => /нет доступа к БД/.test(b))).toBe(true);

		// Git commit НЕ создан (BLOCKED — не фиксируем)
		expect(deps.commits.length).toBe(0);
	});

	it("E2E-1: onEscalate вызван с («I3», { tag:\"BLOCKED\", reason, iteration })", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "BLOCKED",
					response: "<promise>BLOCKED:нет доступа к БД</promise>",
				},
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });
		await loop.tick();

		expect(onEscalate).toHaveBeenCalledWith(
			"I3",
			expect.objectContaining({
				tag: "BLOCKED",
				reason: "нет доступа к БД",
				iteration: 1,
			}),
		);
	});

	it("E2E-1: следующий tick() запускает новую итерацию (контур не остановился)", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "BLOCKED",
					response: "<promise>BLOCKED:нет доступа к БД</promise>",
				},
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });

		await loop.tick(); // BLOCKED
		expect(deps.executorCalls.length).toBe(1);

		await loop.tick(); // следующая итерация
		expect(deps.executorCalls.length).toBe(2); // контур продолжил

		// Статус остаётся active (BLOCKED — не терминальный статус миссии)
		const status = await loop.status();
		expect(status).toBe("active");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-сценарий 2 (DECIDE) — smoke повтор существующего F-17
// ────────────────────────────────────────────────────────────────────────────

describe("Phase A / E2E-2: DECIDE-tag → awaiting_decision (smoke повтор F-17)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseA-e2e2-");
		missionDir = await initMission("e2e-decide", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: e2e-decide",
			"- [ ] follow-up item",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("E2E-2: DECIDE-tag → awaiting_decision (тег приоритетнее status=COMPLETE)", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					// status не DECIDE — тег должен победить (точка контракта 2)
					status: "COMPLETE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
				{ status: "COMPLETE", commitMessage: "after resolve" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const r = await loop.tick();
		expect(r.status).toBe("awaiting_decision");
	});

	it("E2E-2: resolveDecision('JWT') → active, следующий tick продолжается", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
				{ status: "COMPLETE", commitMessage: "after resolve" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });

		await loop.tick(); // DECIDE → awaiting_decision
		await loop.resolveDecision("JWT");
		expect(await loop.status()).toBe("active");

		await loop.tick(); // продолжение
		expect(deps.executorCalls.length).toBe(2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-сценарий 3 (лестница): COMPLETE + verificationLadder
// ────────────────────────────────────────────────────────────────────────────

describe("Phase A / E2E-3: COMPLETE + verification ladder", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseA-e2e3-");
		missionDir = await initMission("e2e-ladder", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] build feature X",
			"- [ ] follow-up item",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("E2E-3: COMPLETE + ladder {passed:false} → ladder.run вызван, commit НЕ создан, диагноз в STATE.md", async () => {
		const ladder = makeMockLadder({
			passed: false,
			failedStep: "tests",
			diagnosis: "tests: test auth.test.ts:42 failed",
		});
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>", commitMessage: "next" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps, verificationLadder: ladder });
		await loop.tick();

		// Лестница вызвана с missionDir
		expect(ladder.calls.length).toBe(1);
		expect(ladder.calls[0].missionDir).toBe(missionDir);

		// Git commit НЕ создан (лестница провалилась → итерация не фиксируется)
		expect(deps.commits.length).toBe(0);

		// Диагноз в STATE.md (блокеры)
		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		expect(state.blockers.some((b) => /auth\.test\.ts:42|tests/.test(b))).toBe(true);
	});

	it("E2E-3: COMPLETE + ladder {passed:false} → контур продолжает (следующий tick)", async () => {
		const ladder = makeMockLadder({
			passed: false,
			failedStep: "tests",
			diagnosis: "tests: test auth.test.ts:42 failed",
		});
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>", commitMessage: "next" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps, verificationLadder: ladder });

		await loop.tick(); // ladder провалена, итерация не зафиксирована
		expect(deps.executorCalls.length).toBe(1);

		// Контур продолжает — следующий tick запускает новую итерацию
		await loop.tick();
		expect(deps.executorCalls.length).toBe(2);

		// Статус миссии остаётся active (провал ступени — не терминальный)
		expect(await loop.status()).toBe("active");
	});

	it("E2E-3: COMPLETE + ladder {passed:true} → ladder.run вызван, commit создан", async () => {
		const ladder = makeMockLadder({ passed: true, failedStep: null, diagnosis: null });
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps, verificationLadder: ladder });
		const r = await loop.tick();

		// Лестница вызвана
		expect(ladder.calls.length).toBe(1);

		// Git commit создан (верификация прошла → фиксируем)
		expect(deps.commits.length).toBe(1);

		// Запись в «Сделано»
		const state = await readState(missionDir);
		expect(state.done.length).toBeGreaterThan(0);

		// Статус остаётся active (есть ещё пункты ROADMAP)
		expect(r.status).toBe("active");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Smoke-критерий фазы A: 4 тега (COMPLETE/BLOCKED/DECIDE/FAILED)
// ────────────────────────────────────────────────────────────────────────────

describe("Phase A / Smoke: 4 promise tags routing", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseA-smoke-");
		missionDir = await initMission("smoke-tags", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] smoke item",
			"- [ ] follow-up",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("smoke COMPLETE + ladder: ladder.run вызван (верификация запущена)", async () => {
		const ladder = makeMockLadder({ passed: true, failedStep: null, diagnosis: null });
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps, verificationLadder: ladder });
		await loop.tick();
		expect(ladder.calls.length).toBe(1);
	});

	it("smoke BLOCKED: блокер в STATE.md + эскалация I3", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "BLOCKED", response: "<promise>BLOCKED:нет доступа</promise>" },
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.some((b) => /нет доступа/.test(b))).toBe(true);
		expect(onEscalate).toHaveBeenCalledWith("I3", expect.objectContaining({ tag: "BLOCKED" }));
	});

	it("smoke DECIDE: awaiting_decision", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "DECIDE", response: "<promise>DECIDE:вопрос?</promise>" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const r = await loop.tick();
		expect(r.status).toBe("awaiting_decision");
	});

	it("smoke FAILED: диагноз в STATE.md, контур продолжает", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", response: "<promise>FAILED:tests red</promise>" },
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.some((b) => /tests red/.test(b))).toBe(true);

		// контур продолжает
		await loop.tick();
		expect(deps.executorCalls.length).toBe(2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: routing edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("Phase A / EDGE: routing edge cases", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseA-edge-");
		missionDir = await initMission("edge-tags", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] edge item",
			"- [ ] follow-up",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	// EDGE: Ответ БЕЗ тега → onEscalate("I3", { tag: null }) + fallback на status
	it("EDGE: ответ без тега → onEscalate(«I3», { tag: null }), fallback на iterResult.status", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "обычный ответ без promise-тегов" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });
		const r = await loop.tick();

		// Эскалация I3 с tag:null (нет обещания — оператор должен знать)
		expect(onEscalate).toHaveBeenCalledWith(
			"I3",
			expect.objectContaining({ tag: null, iteration: 1 }),
		);

		// Fallback на iterResult.status=COMPLETE → commit создан (поведение «как сейчас»)
		expect(deps.commits.length).toBe(1);
		expect(r.status).toBe("active");
	});

	// EDGE: Тег приоритетнее iterResult.status
	it("EDGE: тег приоритетнее status — status=COMPLETE + <promise>BLOCKED:x</promise> → обработка как BLOCKED", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "COMPLETE",
					response: "<promise>BLOCKED:нет прав</promise>",
				},
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });
		await loop.tick();

		// Обработано как BLOCKED: блокер в STATE.md
		const state = await readState(missionDir);
		expect(state.blockers.some((b) => /нет прав/.test(b))).toBe(true);

		// Git commit НЕ создан (BLOCKED — не фиксируем, несмотря на status=COMPLETE)
		expect(deps.commits.length).toBe(0);

		// Эскалация с tag BLOCKED
		expect(onEscalate).toHaveBeenCalledWith(
			"I3",
			expect.objectContaining({ tag: "BLOCKED", reason: "нет прав" }),
		);
	});

	// EDGE: Без verificationLadder → backward compat (COMPLETE как сейчас)
	it("EDGE: без verificationLadder → COMPLETE обрабатывается как раньше (backward compat)", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			]),
		});
		// ladder НЕ инжектируется — поведение должно остаться «как сейчас»
		const loop = new MissionLoop({ missionDir, deps });
		const r = await loop.tick();

		// Commit создан (поведение как сейчас — без лестницы)
		expect(deps.commits.length).toBe(1);
		const state = await readState(missionDir);
		expect(state.done.length).toBeGreaterThan(0);
		expect(r.status).toBe("active");
	});

	// EDGE: Ladder бросает ошибку → итерация FAILED с диагнозом, контур не падает
	it("EDGE: ladder.run бросает ошибку → итерация FAILED, диагноз в STATE.md, контур продолжает", async () => {
		const ladder = makeMockLadder(
			{ passed: true, failedStep: null, diagnosis: null },
			{ throw: new Error("ladder crashed: spawn EACCES") },
		);
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
				{ status: "COMPLETE", response: "<promise>COMPLETE</promise>", commitMessage: "next" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps, verificationLadder: ladder });

		// tick НЕ должен выбросить (контур не падает)
		const r = await loop.tick();
		expect(r.status).toBe("active"); // контур продолжается (не терминальный)

		// Git commit НЕ создан (лестница упала → итерация не фиксируется)
		expect(deps.commits.length).toBe(0);

		// Диагноз ошибки в STATE.md (блокеры)
		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		expect(state.blockers.some((b) => /ladder crashed|EACCES|spawn/i.test(b))).toBe(true);

		// Контур продолжает: следующий tick запускает новую итерацию
		await loop.tick();
		expect(deps.executorCalls.length).toBe(2);
	});

	// EDGE: BLOCKED без причины в теге → «не указана» в STATE.md
	it("EDGE: BLOCKED без причины в теге → «не указана» в STATE.md + эскалация", async () => {
		// sanity: parsePromise даёт reason «не указана» для BLOCKED без причины
		expect(parsePromise("<promise>BLOCKED</promise>")).toEqual({
			tag: "BLOCKED",
			reason: "не указана",
		});

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "BLOCKED", response: "<promise>BLOCKED</promise>" },
				{ status: "COMPLETE", commitMessage: "next" },
			]),
		});
		const onEscalate = vi.fn();
		const loop = new MissionLoop({ missionDir, deps, onEscalate });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		expect(state.blockers.some((b) => /не указана/.test(b))).toBe(true);

		// Эскалация с reason «не указана»
		expect(onEscalate).toHaveBeenCalledWith(
			"I3",
			expect.objectContaining({ tag: "BLOCKED", reason: "не указана" }),
		);
	});
});
