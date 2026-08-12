// F-15: Интеграционные тесты и фикстуры контура — Green-фаза (интеграция работает).
//
// Карточка: docs/features/super-orchestrator/mission-loop-0/roadmap.md §F-15
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md
//
// Цель: проверить сквозной контур миссии через единый mock-окружение
// (см. test/mock-mission-env.mjs). Интеграция объединяет:
//   - MissionLoop (fan-mission)       — 7-шаговый цикл
//   - file-state-manager (fan-mission) — файловое хранилище (MISSION/STATE/ROADMAP/BACKLOG/DECISIONS)
//   - startScheduler (fan-scheduler)   — периодические тики I4
//   - startWebhookServer (fan-webhook) — HTTP listener для steer/followUp
//   - slash-commands (fan-mission)    — I0 abort, I1 drain
//
// ────────────────────────────────────────────────────────────────────────────
// Контракт (по карточке F-15 + roadmap §F-15 + спека §3.2.x):
//
// TC-F15-1: End-to-end — миссия выполняет 3 итерации
//   - MissionLoop инициализирован с фикстурной миссией
//   - 3 tick() подряд → currentIteration = 3
//   - STATE.md «Сделано» содержит 3 пункта
//   - 3 git commit'а
//   - BACKLOG.md получил 3 записи
//
// TC-F15-2: Steer → меняет поведение агента
//   - Mock executor, принимающий steer-сообщения (через opts.steer)
//   - «Отправка» steer (вызов actions.sendMessage c streamingBehavior="steer")
//   - Следующая итерация executor получает prompt + steer
//   - Проверка: executor.calls[N].steer содержит текст steer'а
//
// TC-F15-3: Фикстуры валидны
//   - Каталог test/fixtures/mission/sample/ содержит 5 файлов
//   - readState/readMission/readBacklog/readDecisions/readRoadmap
//     парсят без ошибок и возвращают ожидаемые данные
//
// Edge cases:
//   - drain → текущий ход завершается, новая итерация НЕ стартует
//   - abort → следующие tick() no-op (missionLoop.status() = "aborted")
//   - scheduler + missionLoop: scheduler.tick() → missionLoop.tick()
//   - webhook + executor: webhook POST /webhook {type:"steer"} →
//     executor получает steer-текст в prompt
//
// ────────────────────────────────────────────────────────────────────────────
// TDD Red: контур НЕ интегрирован (модули существуют, но steer/drain
// не проходят через MissionLoop → executor; scheduler не дёргает
// missionLoop.tick напрямую). Тесты падают на assertions, которые
// проверяют сквозное поведение. Существующие unit-тесты
// (mission-loop.test.mjs, scheduler.test.mjs, file-state-manager.test.mjs)
// НЕ затрагиваются — изолированные тесты по-прежнему зелёные.
// ────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readState, readMission, readRoadmap, readBacklog, readDecisions } from "../file-state-manager.js";

import {
	createMockMissionEnvironment,
	freshBaseDir,
	safeCleanup,
} from "./mock-mission-env.mjs";

// ────────────────────────────────────────────────────────────────────────────
// Helpers (test-local)
// ────────────────────────────────────────────────────────────────────────────

/** Путь к фикстуре (для TC-F15-3). */
const FIXTURE_DIR = join(import.meta.dirname, "fixtures/mission/sample");

/** MockExecutor вызывает runIteration с opts.steer (TDD Red: mission-loop
 * пока не пробрасывает steer; контракт executor расширен в helper). */
function makeSteerableExecutor(initialResults) {
	const calls = [];
	const steerMessages = [];
	let idx = 0;
	return {
		calls,
		steerMessages,
		async runIteration(opts) {
			calls.push({
				missionDir: opts.missionDir,
				prompt: opts.prompt,
				cwd: opts.cwd,
				steer: opts.steer ?? null,
			});
			if (opts.steer) {
				steerMessages.push(opts.steer);
			}
			const r = initialResults[Math.min(idx, initialResults.length - 1)];
			idx++;
			return { ...r };
		},
	};
}

/** Создать env с steerable executor (нужно для TC-F15-2). */
async function createSteerEnv(opts = {}) {
	const env = await createMockMissionEnvironment({
		...opts,
	});
	// Перезаписываем executor на steerable (после initMission)
	const steerable = makeSteerableExecutor(
		opts.executorResults ?? [
			{ status: "COMPLETE", commitMessage: "iter: 1" },
			{ status: "COMPLETE", commitMessage: "iter: 2" },
			{ status: "COMPLETE", commitMessage: "iter: 3" },
		],
	);
	const { MissionLoop } = await import("../mission-loop.js");
	env.missionLoop = new MissionLoop({
		missionDir: env.missionDir,
		deps: {
			executor: steerable,
			git: env.git,
			clock: env.clock,
			lock: env.lock,
		},
	});
	env.executor = steerable;
	return env;
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F15-1: End-to-end — миссия выполняет 3 итерации
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / TC-F15-1: end-to-end — 3 итерации миссии", () => {
	let env;
	let baseDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f15-tc1-");
		env = await createMockMissionEnvironment({
			slug: "tc15-iter",
			baseDir,
			executorResults: [
				{ status: "COMPLETE", commitMessage: "iter 1" },
				{ status: "COMPLETE", commitMessage: "iter 2" },
				{ status: "COMPLETE", commitMessage: "iter 3" },
			],
		});
		// Расширяем ROADMAP до 3 пунктов, иначе второй tick переведёт миссию в completed
		// (дефолтный шаблон содержит только 1 пункт).
		writeFileSync(
			join(env.missionDir, "ROADMAP.md"),
			"# Roadmap\n\n- [ ] item a\n- [ ] item b\n- [ ] item c\n",
			"utf8",
		);
	});

	afterEach(async () => {
		if (env) await env.cleanup();
		else safeCleanup(baseDir);
	});

	it("TC-F15-1.happy: 3 tick() → currentIteration = 3, 3 commit'а, STATE.md обновлён", async () => {
		// 3 последовательных тика
		const r1 = await env.missionLoop.tick();
		const r2 = await env.missionLoop.tick();
		const r3 = await env.missionLoop.tick();

		expect(r1.iteration).toBe(1);
		expect(r2.iteration).toBe(2);
		expect(r3.iteration).toBe(3);

		// STATE.md «Сделано» содержит 3 пункта (по одному на итерацию)
		const state = await readState(env.missionDir);
		expect(state.done).toHaveLength(3);

		// 3 git commit'а
		expect(env.git.commits).toHaveLength(3);

		// BACKLOG.md получил 3 записи (шаг 7 каждого тика)
		const backlogRaw = readFileSync(join(env.missionDir, "BACKLOG.md"), "utf8");
		const backlogLines = backlogRaw.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| id"));
		expect(backlogLines.length).toBeGreaterThanOrEqual(3);

		// currentIteration = 3 в .mission-loop.json
		const loopState = await env.readLoopState();
		expect(loopState.currentIteration).toBe(3);
	});

	it("TC-F15-1.happy: ROADMAP.md — каждый tick передвигает чекбокс [ ] → [x]", async () => {
		// Расширим ROADMAP для 3 итераций
		const roadmapPath = join(env.missionDir, "ROADMAP.md");
		readFileSync(roadmapPath, "utf8"); // sanity
		const fs = await import("node:fs");
		fs.writeFileSync(
			roadmapPath,
			"# Roadmap\n\n- [ ] item a\n- [ ] item b\n- [ ] item c\n",
			"utf8",
		);

		await env.missionLoop.tick();
		await env.missionLoop.tick();
		await env.missionLoop.tick();

		const roadmap = readFileSync(roadmapPath, "utf8");
		const checked = roadmap.match(/- \[x\]/g) || [];
		expect(checked).toHaveLength(3);
	});

	it("TC-F15-1.happy: 3 итерации → scheduler+missionLoop в унисон (Red: scheduler не дёргает loop)", async () => {
		// Создаём env с scheduler. Fake timers должны быть активированы
		// ДО создания env (иначе setInterval зарегистрирован без mock'а).
		await env.cleanup();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		baseDir = freshBaseDir("fan-f15-tc1-sched-");
		try {
			env = await createMockMissionEnvironment({
				slug: "tc15-sched",
				baseDir,
				withScheduler: true,
				schedulerIntervalMs: 100,
				executorResults: [
					{ status: "COMPLETE", commitMessage: "sched 1" },
					{ status: "COMPLETE", commitMessage: "sched 2" },
					{ status: "COMPLETE", commitMessage: "sched 3" },
				],
			});
			await vi.advanceTimersByTimeAsync(350);
		} finally {
			vi.useRealTimers();
		}

		// Scheduler тикает → actions.sendMessage(...) вызывается
		expect(env.actions.sendCalls.length).toBeGreaterThanOrEqual(3);

		// Интеграционная проверка: scheduler должен дёргать missionLoop.tick().
		// В текущей реализации scheduler НЕ интегрирован с missionLoop,
		// поэтому iterations = 0, хотя scheduler отправил 3 followUp.
		// Это документирует требование к интеграции (Green-фаза).
		const loopState = await env.readLoopState();
		expect(loopState.currentIteration).toBe(3); // ← FAIL в Red-фазе
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F15-2: Steer → меняет поведение агента
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / TC-F15-2: steer меняет поведение агента", () => {
	let env;
	let baseDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f15-tc2-");
	});

	afterEach(async () => {
		if (env) await env.cleanup();
		else safeCleanup(baseDir);
	});

	it("TC-F15-2: webhook POST steer → executor получает steer в prompt", async () => {
		env = await createSteerEnv({
			slug: "tc15-steer-webhook",
			baseDir,
			withWebhook: true,
		});

		// POST /webhook с steer
		const steerText = "CI failed: fix the integration test";
		const res = await fetch(`http://127.0.0.1:${env.webhook.port}/webhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "steer", message: steerText }),
		});
		expect(res.status).toBe(200);

		// Действие дошло до actions.sendMessage
		expect(env.actions.sendCalls.length).toBeGreaterThanOrEqual(1);
		const steerCall = env.actions.sendCalls.find(
			(c) =>
				(c.opts && c.opts.streamingBehavior === "steer") ||
				(typeof c.streamingBehavior === "string" && c.streamingBehavior === "steer"),
		);
		expect(steerCall).toBeDefined();

		// Следующая итерация → executor получает steer
		await env.missionLoop.tick();

		// Интеграционная проверка: executor.calls[N].steer === steerText.
		// Текущий MissionLoop не пробрасывает steer в executor.runIteration,
		// поэтому calls[0].steer === null → FAIL.
		const lastCall = env.executor.calls[env.executor.calls.length - 1];
		expect(lastCall).toBeDefined();
		expect(lastCall.steer).toBe(steerText); // ← FAIL в Red-фазе
	});

	it("TC-F15-2: actions.sendMessage({streamingBehavior:'steer'}) → следующая итерация получает steer", async () => {
		env = await createSteerEnv({
			slug: "tc15-steer-actions",
			baseDir,
		});

		// Симулируем steer через actions.sendMessage
		const steerText = "Focus on auth refactor next";
		await env.actions.sendMessage(steerText, { streamingBehavior: "steer" });

		// Запускаем итерацию — она должна учесть steer
		await env.missionLoop.tick();

		// executor.calls[0].steer должен содержать steerText
		expect(env.executor.calls.length).toBeGreaterThanOrEqual(1);
		// Интеграционная проверка: текущий MissionLoop не пробрасывает steer в opts.steer
		expect(env.executor.calls[0].steer).toBe(steerText); // ← FAIL в Red-фазе
	});

	it("TC-F15-2: prompt executor'а содержит steer-текст (для LLM-контекста)", async () => {
		env = await createSteerEnv({
			slug: "tc15-steer-prompt",
			baseDir,
		});

		const steerText = "STOP — debug this first, do not commit";
		await env.actions.sendMessage(steerText, { streamingBehavior: "steer" });
		await env.missionLoop.tick();

		const lastCall = env.executor.calls[env.executor.calls.length - 1];
		expect(lastCall.prompt).toContain(steerText); // ← FAIL в Red-фазе
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F15-3: Фикстуры валидны и парсятся
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / TC-F15-3: фикстуры валидны и парсятся", () => {
	it("TC-F15-3.pre: каталог фикстуры содержит все 5 файлов", () => {
		expect(existsSync(join(FIXTURE_DIR, "MISSION.md"))).toBe(true);
		expect(existsSync(join(FIXTURE_DIR, "STATE.md"))).toBe(true);
		expect(existsSync(join(FIXTURE_DIR, "ROADMAP.md"))).toBe(true);
		expect(existsSync(join(FIXTURE_DIR, "BACKLOG.md"))).toBe(true);
		expect(existsSync(join(FIXTURE_DIR, "DECISIONS.md"))).toBe(true);
	});

	it("TC-F15-3: readMission → frontmatter корректный", async () => {
		const { frontmatter, body } = await readMission(FIXTURE_DIR);
		expect(frontmatter.mission_id).toBe("mission-fixture-001");
		expect(frontmatter.status).toBe("active");
		expect(frontmatter.budget_tokens).toBe(500000);
		expect(frontmatter.budget_usd).toBe(10);
		expect(frontmatter.max_depth).toBe(4);
		expect(frontmatter.max_width).toBe(4);
		expect(body).toContain("Mission: sample");
	});

	it("TC-F15-3: readState → 3 секции с ожидаемыми данными", async () => {
		const state = await readState(FIXTURE_DIR);
		expect(state.done).toHaveLength(3);
		expect(state.done[0]).toMatch(/bootstrap fixture/);
		expect(state.done[1]).toMatch(/read all 5 mission files/);
		expect(state.done[2]).toMatch(/validate parser output/);
		expect(state.blockers).toHaveLength(0);
		expect(state.nextSteps).toHaveLength(2);
		expect(state.nextSteps[0]).toMatch(/run integration suite/);
	});

	it("TC-F15-3: readRoadmap → содержит ожидаемые пункты", async () => {
		const roadmap = await readRoadmap(FIXTURE_DIR);
		expect(roadmap).toContain("# Roadmap");
		expect(roadmap).toContain("- [x] bootstrap mission dir");
		expect(roadmap).toContain("- [ ] run integration test suite");
	});

	it("TC-F15-3: readBacklog → 3 записи с правильными полями", async () => {
		const backlog = await readBacklog(FIXTURE_DIR);
		expect(backlog).toHaveLength(3);
		expect(backlog.map((e) => e.id)).toEqual(["idea-f01", "idea-f02", "idea-f03"]);
		expect(backlog[0].source).toBe("fixtures");
		expect(backlog[0].status).toBe("ROADMAP");
		expect(backlog[2].status).toBe("IDEA");
		// Все fit/value/risk/cost/score — числа
		for (const entry of backlog) {
			expect(typeof entry.fit).toBe("number");
			expect(typeof entry.value).toBe("number");
			expect(typeof entry.risk).toBe("number");
			expect(typeof entry.cost).toBe("number");
			expect(typeof entry.score).toBe("number");
		}
	});

	it("TC-F15-3: readDecisions → 2 ADR с правильными полями", async () => {
		const decisions = await readDecisions(FIXTURE_DIR);
		expect(decisions).toHaveLength(2);
		expect(decisions.map((d) => d.id)).toEqual(["ADR-F-001", "ADR-F-002"]);
		expect(decisions[0].status).toBe("accepted");
		expect(decisions[0].context).toContain("F-15");
		expect(decisions[0].decision).toContain("fixtures");
		expect(decisions[1].decision).toContain("MockMissionEnvironment");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case: drain → завершает текущий ход без новой итерации
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / Edge: drain → текущий ход завершается, новая итерация НЕ стартует", () => {
	let env;
	let baseDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f15-drain-");
		env = await createMockMissionEnvironment({
			slug: "tc15-drain",
			baseDir,
		});
	});

	afterEach(async () => {
		if (env) await env.cleanup();
	});

	it("Edge-drain: setDrainAfterCurrentTurn(true) → следующий tick() НЕ стартует executor", async () => {
		// Выставляем drain
		env.actions.setDrainAfterCurrentTurn(true);

		// Следующий тик не должен вызывать executor
		await env.missionLoop.tick();

		// Интеграционная проверка: текущий MissionLoop не наблюдает drain-флаг,
		// поэтому executor всё равно вызывается.
		expect(env.executor.calls).toHaveLength(0); // ← FAIL в Red-фазе
	});

	it("Edge-drain: drain + tick → MISSION.md status = paused (drain → pause transition)", async () => {
		env.actions.setDrainAfterCurrentTurn(true);
		await env.missionLoop.tick();

		// Интеграционная проверка: после drain+tick MISSION.md должен быть paused.
		// В текущей реализации MissionLoop не переводит status → paused
		// по drain-сигналу → FAIL.
		const { frontmatter } = await readMission(env.missionDir);
		expect(frontmatter.status).toBe("paused"); // ← FAIL в Red-фазе
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case: abort → останавливает missionLoop, следующие тики no-op
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / Edge: abort → останавливает missionLoop, тики no-op", () => {
	let env;
	let baseDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f15-abort-");
		env = await createMockMissionEnvironment({
			slug: "tc15-abort",
			baseDir,
		});
	});

	afterEach(async () => {
		if (env) await env.cleanup();
	});

	it("Edge-abort: abort() → status=aborted, executor НЕ вызывается на следующих тиках", async () => {
		await env.missionLoop.abort();
		expect(await env.missionLoop.status()).toBe("aborted");

		// 3 тика после abort → executor не должен вызываться
		await env.missionLoop.tick();
		await env.missionLoop.tick();
		await env.missionLoop.tick();

		expect(env.executor.calls).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case: scheduler + missionLoop — scheduler.tick → missionLoop.tick
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / Edge: scheduler + missionLoop интеграция", () => {
	let env;
	let baseDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f15-sched-");
	});

	afterEach(async () => {
		if (env) await env.cleanup();
		else safeCleanup(baseDir);
	});

	it("Edge-scheduler: scheduler тикает → missionLoop.tick() вызывается (Red: не интегрировано)", async () => {
		// Fake timers активируем ДО создания env, чтобы setInterval был замокан.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		try {
			env = await createMockMissionEnvironment({
				slug: "tc15-sched-loop",
				baseDir,
				withScheduler: true,
				schedulerIntervalMs: 100,
				executorResults: [
					{ status: "COMPLETE", commitMessage: "s1" },
					{ status: "COMPLETE", commitMessage: "s2" },
					{ status: "COMPLETE", commitMessage: "s3" },
				],
			});

			await vi.advanceTimersByTimeAsync(350);
		} finally {
			vi.useRealTimers();
		}

		// Scheduler отправил ≥3 followUp через actions.sendMessage
		expect(env.actions.sendCalls.length).toBeGreaterThanOrEqual(3);

		// Интеграционная проверка: scheduler должен дёргать missionLoop.tick() напрямую,
		// а не только отправлять followUp. В текущей реализации scheduler
		// вызывает только actions.sendMessage → missionLoop НЕ тикает → FAIL.
		const loopState = await env.readLoopState();
		expect(loopState.currentIteration).toBeGreaterThanOrEqual(3); // ← FAIL в Red-фазе
	});

	it("Edge-scheduler: scheduler.stop() → missionLoop.tick() больше не вызывается", async () => {
		// Fake timers активируем ДО создания env.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		try {
			env = await createMockMissionEnvironment({
				slug: "tc15-sched-stop",
				baseDir,
				withScheduler: true,
				schedulerIntervalMs: 100,
			});

			await vi.advanceTimersByTimeAsync(350);
			expect(env.actions.sendCalls.length).toBeGreaterThanOrEqual(2);

			env.scheduler.stop();

			const beforeStop = env.actions.sendCalls.length;
			await vi.advanceTimersByTimeAsync(500);
			const afterStop = env.actions.sendCalls.length;

			expect(afterStop).toBe(beforeStop);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Edge case: webhook → executor — POST /webhook steer доходит до executor
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / Edge: webhook + executor — steer через HTTP", () => {
	let env;
	let baseDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f15-webhook-");
	});

	afterEach(async () => {
		if (env) await env.cleanup();
		else safeCleanup(baseDir);
	});

	it("Edge-webhook: POST /webhook steer → next iteration executor получает steer", async () => {
		env = await createSteerEnv({
			slug: "tc15-webhook-iter",
			baseDir,
			withWebhook: true,
		});

		// POST steer
		const steerText = "STOP — focus on auth";
		const res = await fetch(`http://127.0.0.1:${env.webhook.port}/webhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "steer", message: steerText }),
		});
		expect(res.status).toBe(200);

		// Запускаем итерацию
		await env.missionLoop.tick();

		// Интеграционная проверка: executor.calls[0].steer === steerText.
		// Текущий MissionLoop не пробрасывает steer в runIteration → FAIL.
		expect(env.executor.calls.length).toBeGreaterThanOrEqual(1);
		expect(env.executor.calls[0].steer).toBe(steerText); // ← FAIL в Red-фазе
	});

	it("Edge-webhook: GET /health → 200 ok", async () => {
		env = await createMockMissionEnvironment({
			slug: "tc15-webhook-health",
			baseDir,
			withWebhook: true,
		});

		const res = await fetch(`http://127.0.0.1:${env.webhook.port}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	it("Edge-webhook: POST /webhook unknown type → 400, executor НЕ вызван", async () => {
		env = await createMockMissionEnvironment({
			slug: "tc15-webhook-400",
			baseDir,
			withWebhook: true,
		});

		const callsBefore = env.executor.calls.length;
		const res = await fetch(`http://127.0.0.1:${env.webhook.port}/webhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "unknown", message: "x" }),
		});
		expect(res.status).toBe(400);

		// Executor не должен получать unknown event
		expect(env.executor.calls.length).toBe(callsBefore);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Smoke: mock-mission-env импортируется и базовый контракт работает
// ────────────────────────────────────────────────────────────────────────────

describe("F-15 / Smoke: MockMissionEnvironment contract", () => {
	it("Smoke: createMockMissionEnvironment возвращает ожидаемый shape", async () => {
		const baseDir = freshBaseDir("fan-f15-smoke-");
		let env;
		try {
			env = await createMockMissionEnvironment({
				slug: "smoke",
				baseDir,
			});

			expect(env.missionLoop).toBeDefined();
			expect(env.actions).toBeDefined();
			expect(env.executor).toBeDefined();
			expect(env.git).toBeDefined();
			expect(env.clock).toBeDefined();
			expect(env.lock).toBeDefined();
			expect(typeof env.cleanup).toBe("function");
			expect(env.missionDir).toContain(baseDir);
			expect(env.scheduler).toBeNull(); // without withScheduler
			expect(env.webhook).toBeNull(); // without withWebhook
		} finally {
			if (env) await env.cleanup();
			else safeCleanup(baseDir);
		}
	});

	it("Smoke: cleanup() идемпотентен (повторный вызов — без ошибок)", async () => {
		const baseDir = freshBaseDir("fan-f15-smoke-cleanup-");
		let env;
		try {
			env = await createMockMissionEnvironment({
				slug: "smoke-cleanup",
				baseDir,
				withScheduler: true,
				withWebhook: true,
				schedulerIntervalMs: 100,
			});

			await env.cleanup();
			await env.cleanup(); // повторно — без падения
		} finally {
			if (env) await env.cleanup();
			else safeCleanup(baseDir);
		}
	});
});