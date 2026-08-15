// F-09: Mission loop — Red-фаза
//
// Детерминированный 7-шаговый цикл миссии, работающий поверх `file-state-manager`
// (F-08). Контракт API (по карточке F-09 + спека §3.1.1, §3.1.2, §3.2.4):
//
//   class MissionLoop
//     constructor(opts: { missionDir: string; deps: MissionLoopDeps })
//     async tick(): Promise<TickResult>        // один полный проход 1→7
//     async abort(): Promise<void>             // I0 — немаскируемый стоп
//     async status(): Promise<MissionStatus>   // активный статус из MISSION.md
//
//   MissionLoopDeps (DI для тестов):
//     executor: MissionExecutor                // шаг 4: запуск итерации
//     git: MissionGit                          // шаг 6: commit + log
//     clock: MissionClock                      // инжектируемое время
//     lock: MissionLock                        // предотвращает двойной старт
//
//   MissionExecutor:
//     runIteration({ missionDir, prompt, cwd }) -> Promise<IterationResult>
//     IterationResult = { status: "COMPLETE"|"BLOCKED"|"DECIDE"|"FAILED",
//                         reason?, question?, commitMessage?, costTokens?, costUsd? }
//
//   MissionGit:
//     commit({ cwd, message, files }) -> { hash }
//     log({ cwd, maxCount? }) -> [{ hash, subject, date }]
//     status({ cwd }) -> { clean: boolean }
//
//   MissionClock: { now(): Date }
//   MissionLock:  { acquire(): Promise<boolean>, release(): Promise<void> }
//
//   TickResult = {
//     iteration: number,                       // currentIteration после тика
//     steps: { wake, read, decide, iterate, verify, commit, backlog: boolean },
//     status: MissionStatus,                   // active | completed | aborted | failed | budget_exhausted
//     interrupted?: boolean,                   // true если resume после crash
//     item?: string,                           // id пункта ROADMAP, с которым работали
//   }
//
//   MissionStatus: "active" | "paused" | "completed" | "aborted" | "failed" | "budget_exhausted"
//
//   Внутреннее состояние цикла между тиками хранится в `.mission-loop.json`
//   рядом с STATE.md (5 KB лимит STATE.md делает невозможным хранение метаданных
//   в STATE.md — спека §3.1.2 требует «ровно три секции»). Файл содержит:
//     { currentIteration: number, lastStep: 1..7, interrupted: boolean,
//       budgetUsed: { tokens: number, usd: number } }
//
//   Теггирование обещаний (парсинг тегов <promise>COMPLETE</promise> и т.п.)
//   выполняется внутри executor.runIteration (mock), здесь мы напрямую
//   возвращаем IterationResult — это даёт детерминированность для тестов.
//
// Этап 0 (базовый): skip PromiseTags (mock возвращает status напрямую),
// skip verification ladder, skip fork() checkpoint (всё это — следующие этапы).
// Здесь базовая обработка завершения итерации и FSM-переходы (см. карточку).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readState } from "../file-state-manager.js";

// ────────────────────────────────────────────────────────────────────────────
// Импорт модуля, который ещё не существует → ERR_MODULE_NOT_FOUND.
// Все it-блоки должны падать на отсутствии API.
// ────────────────────────────────────────────────────────────────────────────

import {
	MissionLoop,
	readMissionLoopState,
} from "../mission-loop.js";

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock-объекты для DI (executor, git, clock, lock)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт in-memory записывающий мок executor'а.
 * iterationResults — массив IterationResult, который будет возвращаться
 * по очереди при каждом вызове runIteration. По исчерпании — последний
 * элемент (как «default»).
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

/**
 * Создаёт mock для git. Каждый commit возвращает уникальный hash,
 * log возвращает список зафиксированных коммитов.
 * По умолчанию cwd пустой (clean: true).
 */
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
			// симуляция чистого дерева (для теста crash — см. отдельный mock)
			return { clean: true };
		},
	};
}

/**
 * Возвращает фиксированные даты: 2026-08-10T10:00:00Z, +1 мин каждый вызов.
 */
function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-10T10:00:00Z");
	return {
		async now() {
			return new Date(base.getTime() + n * 60_000);
		},
	};
}

/**
 * In-memory lock: первый acquire возвращает true, recycle=false;
 * пока не release — повторный acquire возвращает false.
 */
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
 * Полный набор DI-зависимостей для теста. Любую можно переопределить
 * через второй аргумент.
 */
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
 * Временный корневой каталог для миссии (см. file-state-manager.test.mjs).
 */
function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-f09-red-"));
}

/**
 * Записать готовый ROADMAP.md (все галочки или одна пустая).
 */
function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

/**
 * Записать готовый `.mission-loop.json` (имитация crash между итерациями).
 */
function writeMissionLoopState(missionDir, state) {
	writeFileSync(
		join(missionDir, ".mission-loop.json"),
		JSON.stringify(
			{
				currentIteration: 0,
				lastStep: 0,
				interrupted: false,
				budgetUsed: { tokens: 0, usd: 0 },
				...state,
			},
			null,
			2,
		),
		"utf8",
	);
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-1: Полная итерация — happy path цикла 1→7
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-1: один полный тик цикла (7 шагов)", () => {
	let baseDir;
	let missionDir;
	let deps;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("happy-iter", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] bootstrap mission: happy-iter",
			"- [ ] implement feature A",
			"",
		]);
		deps = makeDeps();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-1.happy: один тик проходит шаги 1→7, STATE.md обновлён, git commit создан", async () => {
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Все 7 шагов отработали
		expect(result.steps.wake).toBe(true);
		expect(result.steps.read).toBe(true);
		expect(result.steps.decide).toBe(true);
		expect(result.steps.iterate).toBe(true);
		expect(result.steps.verify).toBe(true);
		expect(result.steps.commit).toBe(true);
		expect(result.steps.backlog).toBe(true);

		// Итерация продвинулась
		expect(result.iteration).toBe(1);
		// Статус — остаётся active (не терминальный)
		expect(result.status).toBe("active");
		// Не interrupted (нормальный тик)
		expect(result.interrupted).toBeFalsy();

		// STATE.md «Сделано» содержит новую запись
		const state = await readState(missionDir);
		expect(state.done.length).toBeGreaterThan(0);
		expect(state.done[0]).toMatch(/bootstrap|happy-iter/);

		// Git commit создан
		expect(deps.commits.length).toBe(1);
		expect(deps.commits[0].message).toMatch(/bootstrap|happy-iter/);

		// Executor вызван ровно один раз
		expect(deps.executorCalls.length).toBe(1);

		// .mission-loop.json обновлён
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.currentIteration).toBe(1);
		expect(loopState.lastStep).toBe(7);
		expect(loopState.interrupted).toBe(false);
	});

	it("TC-F09-1.happy: BACKLOG.md обновляется на шаге 7", async () => {
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		const raw = readFileSync(join(missionDir, "BACKLOG.md"), "utf8");
		// BACKLOG.md либо содержит новую строку таблицы, либо явный лог-апдейт
		// (контрактные детали на Уточнение → минимум: файлу был touch / append)
		expect(raw.length).toBeGreaterThan(0);
	});

	it("TC-F09-1.happy: prompt в executor содержит ссылку на missionDir", async () => {
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		expect(deps.executorCalls[0].missionDir).toBe(missionDir);
		// prompt либо содержит путь, либо инструкцию (контракт: не пустой)
		expect(typeof deps.executorCalls[0].prompt).toBe("string");
		expect(deps.executorCalls[0].prompt.length).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-2: Stateless recovery — новый экземпляр loop после crash
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-2: stateless recovery после kill между итерациями", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("recovery-iter", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] step 1",
			"- [ ] step 2",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-2: новый экземпляр loop читает .mission-loop.json с interrupted=true и продолжает с места", async () => {
		// Симулируем crash после шага 6 (commit), до шага 7 (backlog).
		writeMissionLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 6,
			interrupted: true,
			budgetUsed: { tokens: 1000, usd: 0.02 },
		});
		// Также симулируем что STATE.md уже содержит done-запись (от прошлого тика)
		await writeStateV1(missionDir, {
			done: ["step 1 done"],
			blockers: [],
			nextSteps: ["step 2"],
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Executor НЕ должен вызываться — мы на шаге 7, до шага 4 не возвращаемся
		expect(deps.executorCalls.length).toBe(0);
		// git commit тоже не дублируется
		expect(deps.commits.length).toBe(0);
		// Шаги 1-3 (read/decide/wake) выполнены, шаг 4 (iterate) — пропущен
		expect(result.steps.iterate).toBe(false);
		expect(result.steps.commit).toBe(false);
		// Шаг 7 (backlog) выполнен
		expect(result.steps.backlog).toBe(true);
		// interrupted флаг сброшен
		expect(result.interrupted).toBeFalsy();
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.interrupted).toBe(false);
	});

	it("TC-F09-2: новый экземпляр loop читает STATE.md (а не in-memory кэш)", async () => {
		// После crash STATE.md должен содержать маркер interrupted.
		// (В текущем дизайне — в `.mission-loop.json`, но STATE.md
		// также получает «interrupted» маркер в nextSteps / комментарии)
		writeMissionLoopState(missionDir, {
			currentIteration: 1,
			lastStep: 6,
			interrupted: true,
		});
		await writeStateV1(missionDir, {
			done: ["x"],
			blockers: [],
			nextSteps: ["[interrupted] continue step 2"],
		});

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		// tick должен пройти без падения — данные только с диска
		await expect(loop.tick()).resolves.toBeDefined();
	});

	it("TC-F09-2: tick() на «свежем» missionDir (без .mission-loop.json) начинает с шага 1", async () => {
		// Нет файла прогресса → стартуем с начала
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();
		// Все шаги пройдены
		expect(result.steps.iterate).toBe(true);
		expect(result.steps.commit).toBe(true);
		// currentIteration = 1
		expect(result.iteration).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-3: Abort — I0 немаскируемый стоп
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-3: abort() сохраняет состояние", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("abort-iter", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-3: abort() выставляет status=aborted в MISSION.md / .mission-loop.json", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		// Проверяем внутренний статус
		const status = await loop.status();
		expect(status).toBe("aborted");

		// MISSION.md frontmatter status → aborted (новый статус)
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*aborted/);

		// .mission-loop.json помечает iteration interrupted
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.interrupted).toBe(true);
	});

	it("TC-F09-3: tick() после abort() не выполняет итерацию", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.abort();

		const result = await loop.tick();
		// Итерация не запускается
		expect(deps.executorCalls.length).toBe(0);
		// Нет продвижения
		expect(result.iteration).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-4: BLOCKED — итерация вернула BLOCKED → запись в «Блокеры»
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-4: BLOCKED-итерация пишет в «Блокеры»", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("blocked-iter", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] risky thing", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-4: BLOCKED → STATE.md «Блокеры» содержит причину", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "BLOCKED", reason: "требуется ручное ревью PR #42" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		expect(state.blockers[0]).toMatch(/PR #42|ручное ревю/);

		// Git commit НЕ создан (BLOCKED — не фиксируем)
		expect(deps.commits.length).toBe(0);

		// Статус остаётся active (FAILED/BLOCKED — это не терминальный статус миссии)
		expect(result.status).toBe("active");

		// Цикл может продолжиться на следующем тике
		expect(result.steps.iterate).toBe(true);
	});

	it("TC-F09-4: FAILED → STATE.md «Блокеры» содержит диагноз", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "FAILED", reason: "verification ladder: E2E test red" },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		expect(state.blockers[0]).toMatch(/E2E|verification/);
	});

	it("TC-F09-4: BLOCKED без reason → дефолт «не указана»", async () => {
		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "BLOCKED" }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const state = await readState(missionDir);
		expect(state.blockers.length).toBeGreaterThan(0);
		// Причина не указана → либо в файле, либо «не указана» / default
		expect(state.blockers[0].length).toBeGreaterThan(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-5: ROADMAP пуст (все ✓) → миссия → completed
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-5: ROADMAP пуст → миссия → completed", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("done-mission", { baseDir });
		// Все галочки уже стоят
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [x] step 1",
			"- [x] step 2",
			"- [x] step 3",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-5: tick() → status = completed, executor НЕ вызван", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// Миссия завершена
		expect(result.status).toBe("completed");
		// Executor не запускал новых итераций
		expect(deps.executorCalls.length).toBe(0);
		// Git commit не создаётся (нечего фиксировать)
		expect(deps.commits.length).toBe(0);

		// MISSION.md frontmatter обновлён
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		expect(missionRaw).toMatch(/status:\s*completed/);
	});

	it("TC-F09-5: после completed tick() не запускает executor на пустой roadmap", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		await loop.tick(); // второй тик — ничего не делает
		expect(deps.executorCalls.length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-6: Lock — два конкурентных tick() не стартуют одновременно
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-6: lock предотвращает двойной конкурентный старт", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("lock-iter", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-6: два одновременных tick() — второй отказывается (lock занят)", async () => {
		// Делаем executor медленным, чтобы overlap был возможен
		let resolveIter;
		const slowExecutor = {
			calls: [],
			async runIteration(opts) {
				slowExecutor.calls.push({ ...opts });
				await new Promise((r) => {
					resolveIter = r;
				});
				return { status: "COMPLETE", commitMessage: "slow" };
			},
		};
		const lock = makeMockLock();
		const deps = {
			executor: slowExecutor,
			git: makeMockGit(),
			clock: makeMockClock(),
			lock,
		};

		const loop = new MissionLoop({ missionDir, deps });
		const t1 = loop.tick();
		// Пока t1 не завершён — lock занят, второй tick должен отказаться
		await expect(loop.tick()).rejects.toThrow(/lock|busy|concurrent/);

		// Дожидаемся, пока первый tick реально войдёт в executor (шаг 4):
		// сборка промпта (prompt-builder) асинхронна, поэтому вызов executor
		// происходит позже отказа второго tick. Без ожидания resolveIter ещё
		// не присвоен (гонка микротасков, а не semantics lock'а).
		while (slowExecutor.calls.length === 0) {
			await new Promise((r) => setTimeout(r, 1));
		}

		// Завершаем первую итерацию
		resolveIter();
		await t1;

		// После release — снова доступен
		expect(lock.held()).toBe(false);
	});

	it("TC-F09-6: tick() корректно отпускает lock после ошибки executor'а", async () => {
		const failingExecutor = {
			async runIteration() {
				throw new Error("executor crashed");
			},
		};
		const lock = makeMockLock();
		const deps = {
			executor: failingExecutor,
			git: makeMockGit(),
			clock: makeMockClock(),
			lock,
		};

		const loop = new MissionLoop({ missionDir, deps });
		await expect(loop.tick()).rejects.toThrow(/executor crashed/);
		// Lock отпущен даже при ошибке
		expect(lock.held()).toBe(false);
		// Следующий tick должен иметь возможность взять lock
		await expect(loop.tick()).rejects.toThrow(/executor crashed/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-7: Budget exhausted — бюджет исчерпан → mission status → budget_exhausted
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-7: budget exhausted → mission → budget_exhausted", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("budget-iter", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] work item", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-7: budget_tokens=0 means unlimited (P2 semantics) → status = active", async () => {
		// P2 fix: budget_tokens=0 means "no limit" (unlimited), not exhausted.
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const updated = missionRaw.replace(/budget_tokens:\s*\d+/, "budget_tokens: 0");
		writeFileSync(join(missionDir, "MISSION.md"), updated, "utf8");

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// budget=0 → unlimited → status stays active (iteration succeeded)
		expect(result.status).toBe("active");
		expect(deps.executorCalls.length).toBe(1); // executor WAS called
	});

	it("TC-F09-7: исчерпание budget во время итерации (costTokens > remaining) → budget_exhausted", async () => {
		// Бюджет большой, но executor возвращает costTokens, превышающий остаток
		const missionRaw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
		const updated = missionRaw.replace(/budget_tokens:\s*\d+/, "budget_tokens: 100");
		writeFileSync(join(missionDir, "MISSION.md"), updated, "utf8");

		const deps = makeDeps({
			executor: makeMockExecutor([
				{ status: "COMPLETE", commitMessage: "expensive", costTokens: 200 },
			]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("budget_exhausted");
		// Executor был вызван, но миссия перешла в budget_exhausted
		expect(deps.executorCalls.length).toBe(1);
		// .mission-loop.json отражает использование
		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.budgetUsed.tokens).toBe(200);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-8: Iteration accounting — каждый tick продвигает currentIteration
// независимо (stateless)
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-8: currentIteration увеличивается на каждый успешный тик", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("counter-iter", { baseDir });
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] a",
			"- [ ] b",
			"- [ ] c",
			"",
		]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-8: 3 последовательных tick() → currentIteration = 3, 3 commit'а", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		await loop.tick();
		const result = await loop.tick();

		expect(result.iteration).toBe(3);
		expect(deps.commits.length).toBe(3);
		expect(deps.executorCalls.length).toBe(3);

		const loopState = await readMissionLoopState(missionDir);
		expect(loopState.currentIteration).toBe(3);
	});

	it("TC-F09-8: каждый tick передвигает ROADMAP.md (чекбокс [ ] → [x])", async () => {
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		const checked = roadmap.match(/- \[x\]/g) || [];
		expect(checked.length).toBe(1);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-9: Read step — шаг 2 читает MISSION.md, ROADMAP.md, STATE.md, git log
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-9: шаг 2 (read) покрывает все 4 источника", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("read-step", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] step1", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-9: git.log() вызывается на шаге 2 (чтение предыдущего контекста)", async () => {
		let logCalled = false;
		const git = {
			async commit() {
				return { hash: "x" };
			},
			async log() {
				logCalled = true;
				return [];
			},
			async status() {
				return { clean: true };
			},
		};
		const deps = {
			executor: makeMockExecutor([{ status: "COMPLETE", commitMessage: "x" }]),
			git,
			clock: makeMockClock(),
			lock: makeMockLock(),
		};
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();
		expect(logCalled).toBe(true);
	});

	it("TC-F09-9: на mission без STATE.md → MissionNotFound", async () => {
		// Удаляем STATE.md
		rmSync(join(missionDir, "STATE.md"));
		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		// tick() должен сообщить об ошибке (readState выбросит)
		await expect(loop.tick()).rejects.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F09-10: Clock injection — временные метки в STATE.md детерминированы
// ────────────────────────────────────────────────────────────────────────────

describe("F-09 / TC-F09-10: clock инжектируется для детерминированных меток", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("clock-iter", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] work", ""]);
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("TC-F09-10: фиксированный clock → метка времени предсказуема", async () => {
		let n = 0;
		const fixedClock = {
			async now() {
				return new Date(`2026-08-10T10:0${n++}:00Z`);
			},
		};
		const deps = {
			executor: makeMockExecutor([{ status: "COMPLETE", commitMessage: "x" }]),
			git: makeMockGit(),
			clock: fixedClock,
			lock: makeMockLock(),
		};
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		// В BACKLOG.md должна быть дата 2026-08-10
		const backlog = readFileSync(join(missionDir, "BACKLOG.md"), "utf8");
		expect(backlog).toMatch(/2026-08-10/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Утилиты — обёртки для F-08 API, нужные для setup
// ────────────────────────────────────────────────────────────────────────────

import { writeState } from "../file-state-manager.js";

async function writeStateV1(missionDir, state) {
	await writeState(missionDir, state);
}
