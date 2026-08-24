// F-17: DECIDE-прерывание (блокировка контура) — Red-фаза
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-17
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.2.4
//
// Все тесты ожидают реализацию F-17 в `extensions/fan-mission/mission-loop.ts`.
// На момент Red-фазы:
//   - MissionLoop не вызывает parsePromise(response) — тег DECIDE игнорируется
//   - resolveDecision(answer) — метод отсутствует (TypeError)
//   - decideTimeoutMs — опция отсутствует (молча игнорируется)
//   - awaiting_decision — статус не существует в FSM
//
// Контракт API (по карточке F-17 + спека §3.2.4):
//
//   class MissionLoop (расширение F-09/F-15)
//
//     constructor(opts: {
//       missionDir: string,
//       deps: MissionLoopDeps,
//       drainFlag?: () => boolean,
//       decideTimeoutMs?: number   // дефолт 3600000 (1 час)
//     })
//
//     async tick(): Promise<TickResult>
//       — После executor.runIteration() вызывает parsePromise(iterResult.response)
//       — Если результат парсера { tag: "DECIDE", reason? }:
//           * Статус миссии → "awaiting_decision"
//           * В DECISIONS.md записывается вопрос (append-only ADR-формат)
//           * Регистрируется setTimeout(decideTimeoutMs) — таймаут → abort
//           * tick() возвращается со status: "awaiting_decision"
//           * Новые tick() — no-op пока миссия в awaiting_decision (executor НЕ вызывается)
//
//     async resolveDecision(answer: string): Promise<void>
//       — Валидирует: миссия в "awaiting_decision" (иначе InvalidTransitionError)
//       — Идемпотентность: повторный вызов → ошибка (не дублирует запись)
//       — Записывает ответ в DECISIONS.md (ADR-формат: дата, вопрос, ответ, результат)
//       — Очищает таймер таймаута
//       — Статус → "active"
//       — Следующий tick() запускает executor с prompt, содержащим ответ оператора
//
//   Таймаут:
//     decideTimeoutMs (default 3600000) — при DECIDE-итерации запускается setTimeout.
//     По истечении: статус → "aborted", в STATE.md (Блокеры) — маркер "decide_timeout".
//     resolveDecision() после таймаута → InvalidTransitionError (миссия уже aborted).
//
//   Поведение для других тегов (по контракту F-17):
//     COMPLETE → обычное продолжение (как в F-09)
//     BLOCKED  → блокер в STATE.md (если реализовано в F-09 — уже есть), иначе
//                обычное продолжение
//     FAILED   → продолжение с пометкой блокера в STATE.md

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initMission,
	readDecisions,
} from "../file-state-manager.js";

import { MissionLoop, readMissionLoopState } from "../mission-loop.js";

import { parsePromise } from "../promise-parser.js";

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock-объекты для DI (как в mission-loop.test.mjs / mission-loop-deep.test.mjs)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт in-memory записывающий мок executor'а.
 * iterationResults — массив IterationResult; по исчерпании возвращает последний.
 *
 * Для F-17 контракт: executor возвращает `response` (raw LLM-вывод),
 * loop вызывает parsePromise(response) и роутит по тегу.
 * Поле `response` обязательно для DECIDE-сценариев; status — fallback.
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

function freshBaseDir(prefix = "fan-f17-red-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

/**
 * Прямая запись status в MISSION.md (bypass FSM).
 * Нужно для подготовки состояния "awaiting_decision" в Red-фазе —
 * FSM пока не знает этот статус, writeMissionStatus() бы кинул InvalidTransitionError.
 */
function setMissionStatusDirect(missionDir, newStatus) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	const updated = raw.replace(/^(status:\s*).*$/m, `$1${newStatus}`);
	writeFileSync(join(missionDir, "MISSION.md"), updated, "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F17-1: DECIDE блокирует контур до ответа оператора
// ────────────────────────────────────────────────────────────────────────────

describe("F-17 / TC-F17-1: DECIDE блокирует контур до ответа оператора", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("decide-block", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: decide-block",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F17-1.happy: executor вернул DECIDE → tick() ставит статус awaiting_decision", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Статус должен стать "awaiting_decision"
		expect(result.status).toBe("awaiting_decision");

		// MISSION.md frontmatter обновлён
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*awaiting_decision/);

		// Executor был вызван один раз (на этой итерации, которая вернула DECIDE)
		expect(deps.executorCalls.length).toBe(1);
	});

	it("TC-F17-1.happy: вопрос записан в DECISIONS.md (ADR-формат)", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const decisions = await readDecisions(missionDir);
		expect(decisions.length).toBeGreaterThan(0);

		// ADR должен содержать вопрос оператора
		const last = decisions[decisions.length - 1];
		expect(last.context).toMatch(/JWT или session\?/);
		// На момент DECIDE — ответа ещё нет (decision/answer будет пустой или pending)
		expect(last.decision === "" || last.status === "pending").toBeTruthy();
	});

	it("TC-F17-1.happy: повторный tick() НЕ вызывает executor (блокировка)", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
				// Если блокировка не работает — executor будет вызван второй раз
				// и вернёт COMPLETE. Этого не должно произойти.
				{ status: "COMPLETE", commitMessage: "second" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });

		// Первый tick — DECIDE → awaiting_decision
		const r1 = await loop.tick();
		expect(r1.status).toBe("awaiting_decision");
		expect(deps.executorCalls.length).toBe(1);

		// Второй tick — должен быть no-op (executor НЕ вызван)
		const r2 = await loop.tick();
		expect(r2.status).toBe("awaiting_decision");
		expect(deps.executorCalls.length).toBe(1); // всё ещё 1
	});

	it("TC-F17-1.happy: DECIDE с пустой причиной → reason='не указана'", async () => {
		// По аналогии с BLOCKED (F-16 EDGE): <promise>DECIDE</promise>
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE</promise>",
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("awaiting_decision");

		const decisions = await readDecisions(missionDir);
		expect(decisions.length).toBeGreaterThan(0);
		const last = decisions[decisions.length - 1];
		// Вопрос "не указан" / "не указана" (по аналогии с BLOCKED)
		expect(last.context).toMatch(/не указан/i);
	});

	it("TC-F17-1.happy: parsePromise должен быть вызван с raw response executor'а", async () => {
		// Spy на parsePromise — это синхронная функция, проверяем через spy.
		// Так как parsePromise экспортируется напрямую, используем vi.spyOn на модуль.
		const parseSpy = vi.spyOn(await import("../promise-parser.js"), "parsePromise");

		const rawResponse = "<promise>DECIDE:JWT или session?</promise>";
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "DECIDE", response: rawResponse },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// parsePromise был вызван хотя бы один раз с raw response
		const calls = parseSpy.mock.calls;
		const calledWithResponse = calls.some((args) => args[0] === rawResponse);
		expect(calledWithResponse).toBe(true);

		parseSpy.mockRestore();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F17-2: Ответ оператора возобновляет работу
// ────────────────────────────────────────────────────────────────────────────

describe("F-17 / TC-F17-2: resolveDecision() возобновляет работу", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("decide-resolve", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: decide-resolve",
			"- [ ] implement feature A",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F17-2.happy: resolveDecision('JWT') → статус active", async () => {
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

		// 1) Первый tick → DECIDE → awaiting_decision
		const r1 = await loop.tick();
		expect(r1.status).toBe("awaiting_decision");

		// 2) Оператор даёт ответ через resolveDecision()
		await loop.resolveDecision("JWT");

		// 3) Статус → active
		const status = await loop.status();
		expect(status).toBe("active");

		// MISSION.md обновлён
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*active/);
	});

	it("TC-F17-2.happy: ответ записан в DECISIONS.md (вопрос + ответ)", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick(); // DECIDE → awaiting_decision

		// Проверяем, что вопрос уже в DECISIONS.md (после tick)
		const beforeResolve = await readDecisions(missionDir);
		expect(beforeResolve.length).toBeGreaterThan(0);
		const questionEntry = beforeResolve[beforeResolve.length - 1];
		expect(questionEntry.context).toMatch(/JWT или session\?/);

		// resolveDecision добавляет запись с ответом
		await loop.resolveDecision("JWT");

		const afterResolve = await readDecisions(missionDir);
		expect(afterResolve.length).toBeGreaterThan(beforeResolve.length);

		// Последняя запись содержит ответ оператора
		const answerEntry = afterResolve[afterResolve.length - 1];
		expect(answerEntry.decision).toBe("JWT");
	});

	it("TC-F17-2.happy: следующий tick() вызывает executor, prompt содержит ответ", async () => {
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

		await loop.tick(); // DECIDE
		await loop.resolveDecision("JWT");

		// 0.8.0: tick after resolve processes DECIDE item + continues to second item
		await loop.tick();

		// 3 executor calls: DECIDE + 2 COMPLETE (continuous loop)
		expect(deps.executorCalls.length).toBe(3);

		// Второй вызов executor'а содержит ответ оператора в prompt
		const secondCall = deps.executorCalls[1];
		expect(secondCall.prompt).toMatch(/JWT/);
	});

	it("TC-F17-2.happy: answer передан в steer-формате (operator_answer)", async () => {
		// Контракт: ответ оператора передаётся в следующую итерацию
		// через prompt или через отдельное поле (steer-style).
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

		await loop.tick(); // DECIDE
		await loop.resolveDecision("JWT");
		await loop.tick(); // следующая итерация

		// Ответ должен быть как-то передан executor'у — либо в prompt,
		// либо в opts.steer (по аналогии с F-15 steer).
		const secondCall = deps.executorCalls[1];
		const promptHasAnswer = typeof secondCall.prompt === "string" && secondCall.prompt.includes("JWT");
		const steerHasAnswer = typeof secondCall.steer === "string" && secondCall.steer.includes("JWT");
		expect(promptHasAnswer || steerHasAnswer).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F17-3: Таймаут DECIDE вызывает abort
// ────────────────────────────────────────────────────────────────────────────

describe("F-17 / TC-F17-3: таймаут DECIDE → aborted", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("decide-timeout", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: decide-timeout",
			"",
		]);
	});

	afterEach(() => {
		// Сначала возвращаем реальные таймеры, потом чистим файлы
		vi.useRealTimers();
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F17-3.happy: decideTimeoutMs=50, ожидание >50мс → статус aborted, в STATE.md маркер decide_timeout", async () => {
		// Fake timers ДО создания MissionLoop (иначе setTimeout внутри tick()
		// зарегистрируется на реальном таймере)
		vi.useFakeTimers();

		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({
			missionDir,
			deps,
			decideTimeoutMs: 50, // 50 мс — тестовое значение
		});

		// 1) DECIDE → awaiting_decision
		const r1 = await loop.tick();
		expect(r1.status).toBe("awaiting_decision");

		// 2) Оператор НЕ отвечает, время истекает
		await vi.advanceTimersByTimeAsync(75);

		// 3) Статус → aborted
		const status = await loop.status();
		expect(status).toBe("aborted");

		// MISSION.md обновлён
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*aborted/);

		// В STATE.md (Блокеры) — маркер decide_timeout
		const stateRaw = readFileSync(join(missionDir, "STATE.md"), "utf8");
		expect(stateRaw).toMatch(/decide_timeout/);
	});

	it("TC-F17-3.happy: дефолтный decideTimeoutMs (3600000) НЕ срабатывает при коротком ожидании", async () => {
		// Если используется дефолт 1 час, то при ожидании <1 часа таймаут не должен сработать.
		// Для теста: используем реальные таймеры (дефолт большой) + короткое ожидание.
		// Это гарантирует, что без явного decideTimeoutMs — поведение "ждать долго".
		vi.useFakeTimers();

		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps }); // без decideTimeoutMs — дефолт

		const r1 = await loop.tick();
		expect(r1.status).toBe("awaiting_decision");

		// Ждём 100 мс — это меньше дефолтного часа
		await vi.advanceTimersByTimeAsync(100);

		// Статус всё ещё awaiting_decision
		const status = await loop.status();
		expect(status).toBe("awaiting_decision");
	});

	it("TC-F17-3.happy: после abort по таймауту — resolveDecision() уже не resurrect", async () => {
		// Контракт: aborted — терминальное состояние (или active — после resolve),
		// НЕ awaiting_decision. resolveDecision на aborted → ошибка.
		vi.useFakeTimers();

		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({
			missionDir,
			deps,
			decideTimeoutMs: 50,
		});

		await loop.tick(); // awaiting_decision
		await vi.advanceTimersByTimeAsync(75); // таймаут → aborted

		const statusAfterTimeout = await loop.status();
		expect(statusAfterTimeout).toBe("aborted");

		// Попытка resolveDecision после abort — ошибка (миссия не в awaiting_decision)
		await expect(loop.resolveDecision("JWT")).rejects.toThrow();
	});

	it("TC-F17-3.happy: таймер очищается при resolveDecision (нет ложного abort после resume)", async () => {
		// После resolveDecision таймаут НЕ должен сработать (clearTimeout)
		vi.useFakeTimers();

		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
				{ status: "COMPLETE", commitMessage: "after resolve" },
			]),
		});
		const loop = new MissionLoop({
			missionDir,
			deps,
			decideTimeoutMs: 50,
		});

		await loop.tick(); // awaiting_decision
		await loop.resolveDecision("JWT"); // оператор ответил вовремя

		// Ждём больше таймаута — aborted НЕ должен сработать
		await vi.advanceTimersByTimeAsync(200);

		// Статус остаётся active (не aborted)
		const status = await loop.status();
		expect(status).toBe("active");

		// Следующий tick работает нормально
		const r = await loop.tick();
		// 0.8.0: continuous loop processes remaining items after DECIDE resolution
		expect(r.status).toBe("completed");
		expect(deps.executorCalls.length).toBeGreaterThanOrEqual(2); // at least DECIDE + 1 COMPLETE
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: resolveDecision() валидация состояния и идемпотентность
// ────────────────────────────────────────────────────────────────────────────

describe("F-17 / EDGE: resolveDecision() валидация и идемпотентность", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("decide-edge", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: decide-edge",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("EDGE: resolveDecision() когда миссия в active (НЕ awaiting_decision) → ошибка", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });

		// Миссия в active (по умолчанию) — resolveDecision должен бросить
		await expect(loop.resolveDecision("JWT")).rejects.toThrow();
	});

	it("EDGE: resolveDecision() идемпотентность — повторный вызов после успешного → ошибка", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{
					status: "DECIDE",
					response: "<promise>DECIDE:JWT или session?</promise>",
				},
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });

		await loop.tick(); // DECIDE → awaiting_decision
		await loop.resolveDecision("JWT"); // первый вызов — ok

		// Второй вызов — должен бросить (миссия уже active)
		await expect(loop.resolveDecision("JWT-again")).rejects.toThrow();

		// DECISIONS.md содержит только одну запись с ответом "JWT"
		const decisions = await readDecisions(missionDir);
		const answerEntries = decisions.filter((d) => d.decision === "JWT");
		// Должна быть ровно одна запись с ответом JWT (без дубликатов)
		expect(answerEntries.length).toBe(1);
	});

	it("EDGE: resolveDecision() когда миссия в completed/aborted/failed → ошибка", async () => {
		// Подготовка: установить mission в completed напрямую
		setMissionStatusDirect(missionDir, "completed");
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });

		await expect(loop.resolveDecision("JWT")).rejects.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: parsePromise корректно работает в связке с mission-loop
// ────────────────────────────────────────────────────────────────────────────

describe("F-17 / EDGE: parsePromise + mission-loop взаимодействие", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("decide-parser", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: decide-parser",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("EDGE: parsePromise корректно парсит DECIDE в code block (игнорируется)", async () => {
		// Тег DECIDE внутри ``` ``` блока должен быть проигнорирован parsePromise'ом.
		// Реальный DECIDE снаружи — должен триггерить awaiting_decision.
		const response = [
			"Анализ:",
			"```",
			"<promise>DECIDE:в коде</promise>",
			"```",
			"<promise>DECIDE:реальный вопрос</promise>",
		].join("\n");

		// Sanity-check: parsePromise даёт последний DECIDE
		const parsed = parsePromise(response);
		expect(parsed).toEqual({ tag: "DECIDE", reason: "реальный вопрос" });

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "DECIDE", response }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const r = await loop.tick();
		expect(r.status).toBe("awaiting_decision");
	});

	it("EDGE: parsePromise корректно парсит DECIDE с многословным вопросом (Unicode)", async () => {
		const response = "<promise>DECIDE:Использовать Redis, или Memcached? 🚨</promise>";
		const parsed = parsePromise(response);
		expect(parsed).toEqual({
			tag: "DECIDE",
			reason: "Использовать Redis, или Memcached? 🚨",
		});

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "DECIDE", response }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const decisions = await readDecisions(missionDir);
		const last = decisions[decisions.length - 1];
		expect(last.context).toMatch(/Redis/);
		expect(last.context).toMatch(/Memcached/);
	});

	it("EDGE: несколько DECIDE в ответе — побеждает последний (последний валидный)", async () => {
		const response = [
			"Сначала подумал:",
			"<promise>DECIDE:первый вопрос</promise>",
			"Потом передумал:",
			"<promise>DECIDE:второй вопрос</promise>",
		].join("\n");

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "DECIDE", response }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const decisions = await readDecisions(missionDir);
		const last = decisions[decisions.length - 1];
		// Последний DECIDE выигрывает
		expect(last.context).toMatch(/второй вопрос/);
	});
});