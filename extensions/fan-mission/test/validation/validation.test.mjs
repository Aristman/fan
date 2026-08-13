// F-22: Интеграционные тесты валидации — сквозные сценарии с реальными
// модулями (парсер, генератор, скорер, метрики, лестница) и mock executor.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md
//           §F-22 (TC-F22-1..4 + фикстуры).
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3, §3.2.4.
//
// Контраст с фазами A/B (mission-loop-promise-routing / mission-loop-phase-b):
//   - Фаза A: mock-лестница (makeMockLadder), проверка маршрутизации тегов.
//   - Фаза B: mock-генератор/скорер, проверка DI-опций конструктора.
//   - F-22 (эта фаза): РЕАЛЬНЫЕ createVerificationLadder / createIdeaGenerator /
//     createIdeaScorer / createMetricsCollector в сквозном контуре; mock только
//     на границах (executor-ответы, llm, runCommand). Фикстуры валидны и
//     используются. Детерминированно, без реального git/spawn/LLM, <30s.
//
// Хелпер createMockValidationEnvironment (test/validation/mock-validation-env.mjs)
// собирает MissionLoop со смешанной DI и возвращает { missionDir, loop, cleanup,
// escalations, decideRequests, executorCalls, commits, ... }.

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initMission, readBacklog, readDecisions, readState } from "../../file-state-manager.js";
import { parsePromise } from "../../promise-parser.js";
import {
	createMockValidationEnvironment,
	makeTestsFailOnceRunCommand,
	freshBaseDir,
	safeCleanup,
} from "./mock-validation-env.mjs";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "mission-validation");

// ─── Ответы executor'а с promise-тегами ────────────────────────────────────

const COMPLETE_RESP = (msg = "feat: item", tokens = 1000) => ({
	status: "COMPLETE",
	response: "<promise>COMPLETE</promise>",
	commitMessage: msg,
	costTokens: tokens,
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-1: 4 тега сквозной прогон (реальные парсер + контур + лестница)
//
// Ответы по очереди: COMPLETE → BLOCKED:… → DECIDE:… → FAILED:…
// Лестница все ступени pass. Проверки на каждой итерации.
// ────────────────────────────────────────────────────────────────────────────

describe("TC-F22-1: 4 promise tags end-to-end (real parser + loop + ladder)", () => {
	it("COMPLETE→commit; BLOCKED→STATE.md+I3; DECIDE→awaiting→resolve; FAILED→STATE.md", async () => {
		const env = await createMockValidationEnvironment({
			slug: "f22-tags",
			roadmapItems: 6,
			responses: [
				COMPLETE_RESP("feat: item 1"),
				{ status: "BLOCKED", response: "<promise>BLOCKED:нет доступа к БД</promise>" },
				{ status: "DECIDE", response: "<promise>DECIDE:JWT или session?</promise>" },
				{ status: "FAILED", response: "<promise>FAILED:тесты красные</promise>" },
			],
		});
		try {
			const { loop, missionDir, escalations, executorCalls, commits } = env;

			// ── Итерация 1: COMPLETE + лестница pass → commit ─────────────
			await loop.tick();
			expect(commits.length).toBe(1);
			const state1 = await readState(missionDir);
			expect(state1.done.length).toBeGreaterThanOrEqual(1);

			// ── Итерация 2: BLOCKED → блокер в STATE.md + эскалация I3 ────
			await loop.tick();
			const state2 = await readState(missionDir);
			expect(state2.blockers.some((b) => /нет доступа к БД/.test(b))).toBe(true);
			expect(escalations.some((e) => e.level === "I3" && e.tag === "BLOCKED")).toBe(true);
			const blockedEsc = escalations.find((e) => e.tag === "BLOCKED");
			expect(blockedEsc.reason).toBe("нет доступа к БД");
			// Git commit НЕ создан для BLOCKED
			expect(commits.length).toBe(1);

			// ── Итерация 3: DECIDE → awaiting_decision ────────────────────
			await loop.tick();
			expect(await loop.status()).toBe("awaiting_decision");

			// resolveDecision возобновляет контур: статус → active
			await loop.resolveDecision("JWT");
			expect(await loop.status()).toBe("active");

			// ── Итерация 4: FAILED → «тесты красные» в STATE.md ───────────
			await loop.tick();
			const state4 = await readState(missionDir);
			expect(state4.blockers.some((b) => /тесты красные/.test(b))).toBe(true);
			// Контур отработал все 4 итерации
			expect(executorCalls.length).toBe(4);
		} finally {
			env.cleanup();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-2: генерация идей → реальный скоринг → маршрутизация
//
// 3 итерации COMPLETE; mock LLM генератора: 3 идеи (на 3-й итерации — порог 3);
// mock LLM скорера по вызовам: [0.9,0.8,0.3,0.4]→0.75 ROADMAP;
// [0.6,0.6,0.5,0.6]→0.52 DECIDE; [0.2,0.3,0.8,0.9]→0.19 REJECTED.
// ────────────────────────────────────────────────────────────────────────────

describe("TC-F22-2: idea generation → real scoring → routing", () => {
	it("3 идеи распределены: ROADMAP(0.75) / DECIDE(0.52) / REJECTED(0.19); DECISIONS ADR; awaiting", async () => {
		// Очередь LLM-ответов скорера: по одному набору оценок на идею.
		const scorerScoreSets = [
			[0.9, 0.8, 0.3, 0.4], // idea-001 → 0.75 ROADMAP
			[0.6, 0.6, 0.5, 0.6], // idea-002 → 0.52 DECIDE
			[0.2, 0.3, 0.8, 0.9], // idea-003 → 0.19 REJECTED
		];
		let scorerIdx = 0;
		const scorerLlm = async () => {
			const s = scorerScoreSets[Math.min(scorerIdx, scorerScoreSets.length - 1)];
			scorerIdx++;
			return JSON.stringify({ relevance: s[0], value: s[1], risk: s[2], cost: s[3] });
		};

		// LLM генератора: 3 идеи (JSON-массив в ```json fence — как реальный LLM).
		const generatorLlm = async () =>
			"Вот новые идеи для миссии:\n```json\n" +
			JSON.stringify(
				[
					{ idea: "Кэширование Redis", source: "итерация #3" },
					{ idea: "Вынести логирование в сервис", source: "итерация #3" },
					{ idea: "Переписать всё на Rust", source: "итерация #3" },
				],
				null,
				2,
			) +
			"\n```\n";

		const env = await createMockValidationEnvironment({
			slug: "f22-ideas",
			roadmapItems: 6,
			responses: [COMPLETE_RESP("iter 1"), COMPLETE_RESP("iter 2"), COMPLETE_RESP("iter 3")],
			generatorLlm,
			scorerLlm,
		});
		try {
			const { loop, missionDir, decideRequests } = env;

			// 3 COMPLETE-итерации: на 3-й генератор добавляет 3 идеи, скорер их оценивает.
			await loop.tick();
			await loop.tick();
			await loop.tick();

			// BACKLOG содержит записи итераций (source "mission-loop", random id) и
			// идеи (id idea-NNN). Фильтруем только идеи — их должно быть 3.
			const backlog = await readBacklog(missionDir);
			const ideaEntries = backlog.filter((e) => /^idea-\d{3}$/.test(e.id));
			expect(ideaEntries.length).toBe(3);
			const byId = Object.fromEntries(ideaEntries.map((e) => [e.id, e]));
			expect(byId["idea-001"].status).toBe("ROADMAP");
			expect(byId["idea-001"].score).toBeCloseTo(0.75, 5);
			expect(byId["idea-002"].status).toBe("DECIDE");
			expect(byId["idea-002"].score).toBeCloseTo(0.52, 5);
			expect(byId["idea-003"].status).toBe("REJECTED");
			expect(byId["idea-003"].score).toBeCloseTo(0.19, 5);

			// DECISIONS.md содержит ADR отклонённой идеи (idea-003 / Rust).
			const decisions = await readDecisions(missionDir);
			const rejectedAdr = decisions.find(
				(d) => d.status === "REJECTED" && /Переписать всё на Rust|Rust/.test(d.context),
			);
			expect(rejectedAdr).toBeTruthy();

			// После DECIDE-идеи миссия в awaiting_decision; скорер вызвал requestDecision.
			expect(await loop.status()).toBe("awaiting_decision");
			expect(decideRequests.length).toBeGreaterThanOrEqual(1);
		} finally {
			env.cleanup();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-3: реальные метрики после 6 итераций (5 COMPLETE + 1 FAILED)
//
// metrics.jsonl существует, ≥6 строк, валидный JSONL; getMetrics →
// totalIterations ≥ 6, failureRate ≈ 1/6 (< 0.2 — MAST порог), totalTokensIn ≥ 0.
// ────────────────────────────────────────────────────────────────────────────

describe("TC-F22-3: real metrics across iterations", () => {
	it("6 итераций → metrics.jsonl ≥6 строк; failureRate ≈ 1/6 < 0.2; totalTokensIn ≥ 0", async () => {
		const responses = [
			COMPLETE_RESP("iter 1", 1000),
			COMPLETE_RESP("iter 2", 1000),
			COMPLETE_RESP("iter 3", 1000),
			COMPLETE_RESP("iter 4", 1000),
			COMPLETE_RESP("iter 5", 1000),
			{ status: "FAILED", response: "<promise>FAILED:тесты красные</promise>", costTokens: 500 },
		];
		const env = await createMockValidationEnvironment({
			slug: "f22-metrics",
			roadmapItems: 8,
			responses,
		});
		try {
			const { loop, missionDir, metricsCollector } = env;

			for (let i = 0; i < 6; i++) {
				await loop.tick();
			}

			// metrics.jsonl существует и содержит ≥6 валидных JSON-строк.
			const metricsPath = join(missionDir, "metrics.jsonl");
			const content = readFileSync(metricsPath, "utf8");
			const lines = content.split("\n").filter((l) => l.trim().length > 0);
			expect(lines.length).toBeGreaterThanOrEqual(6);
			for (const line of lines) {
				const parsed = JSON.parse(line); // не бросает → валидный JSONL
				expect(parsed).toHaveProperty("iteration");
				expect(parsed).toHaveProperty("status");
			}

			// getMetrics → агрегаты.
			const metrics = await metricsCollector.getMetrics(missionDir);
			expect(metrics.totalIterations).toBeGreaterThanOrEqual(6);
			// 1 FAILED из 6 → failureRate ≈ 0.167 < 0.2 (MAST порог проходит).
			expect(metrics.failureRate).toBeLessThan(0.2);
			expect(metrics.failureRate).toBeCloseTo(1 / 6, 1);
			expect(metrics.totalTokensIn).toBeGreaterThanOrEqual(0);
		} finally {
			env.cleanup();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-4: лестница верификации — провал сквозной
//
// COMPLETE + runCommand: ступени 1-3 exit 0, «tests» exit 1 с output
// «test auth.test.ts:42 failed» → итерация НЕ коммитится, диагноз в STATE.md,
// следующая итерация запускается (лестница проходит → commit).
// ────────────────────────────────────────────────────────────────────────────

describe("TC-F22-4: verification ladder failure end-to-end", () => {
	it("ladder-fail → no commit + diagnosis в STATE.md; next iter runs + commits", async () => {
		const env = await createMockValidationEnvironment({
			slug: "f22-ladder-fail",
			roadmapItems: 4,
			responses: [COMPLETE_RESP("iter 1"), COMPLETE_RESP("iter 2")],
			runCommand: makeTestsFailOnceRunCommand(),
		});
		try {
			const { loop, missionDir, executorCalls, commits } = env;

			// ── Итерация 1: COMPLETE, но tests-ступень провалена → no commit ─
			await loop.tick();
			expect(commits.length).toBe(0); // лестница провалена → не фиксируем
			const state1 = await readState(missionDir);
			expect(state1.blockers.some((b) => /test auth\.test\.ts:42/.test(b))).toBe(true);

			// ── Итерация 2: контур продолжает — лестница проходит → commit ───
			await loop.tick();
			expect(executorCalls.length).toBe(2); // следующая итерация запустилась
			expect(commits.length).toBe(1); // лестница прошла → фиксируем
			expect(await loop.status()).toBe("active");
		} finally {
			env.cleanup();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Фикстуры: валидность (parsePromise на каждом ответе; JSONL парсится; BACKLOG)
// ────────────────────────────────────────────────────────────────────────────

describe("Fixtures: validity", () => {
	it("agent-responses.json: parsePromise извлекает ожидаемый тег из каждого ответа", () => {
		const raw = readFileSync(join(FIXTURES_DIR, "agent-responses.json"), "utf8");
		const responses = JSON.parse(raw);
		expect(responses.length).toBe(4);

		const expected = {
			complete: { tag: "COMPLETE" },
			blocked: { tag: "BLOCKED", reason: "нет доступа к БД" },
			decide: { tag: "DECIDE", reason: "JWT или session?" },
			failed: { tag: "FAILED", reason: "тесты красные" },
		};

		for (const item of responses) {
			const parsed = parsePromise(item.response);
			expect(parsed, `тег для «${item.id}» должен распознаваться`).not.toBeNull();
			const exp = expected[item.id];
			expect(parsed.tag).toBe(exp.tag);
			if (exp.reason !== undefined) {
				expect(parsed.reason).toBe(exp.reason);
			}
		}
	});

	it("metrics.jsonl: 5 строк, каждая парсится как JSON с нужными полями", () => {
		const content = readFileSync(join(FIXTURES_DIR, "metrics.jsonl"), "utf8");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		expect(lines.length).toBe(5);
		for (const line of lines) {
			const rec = JSON.parse(line);
			expect(rec).toHaveProperty("iteration");
			expect(rec).toHaveProperty("status");
			expect(rec).toHaveProperty("promiseTag");
		}
	});

	it("backlog-scored.md: readBacklog → 3 записи ROADMAP/DECIDE/REJECTED + score", async () => {
		const baseDir = freshBaseDir("fan-f22-fixture-backlog-");
		const missionDir = await initMission("fixture-backlog", { baseDir });
		try {
			const fixtureContent = readFileSync(join(FIXTURES_DIR, "backlog-scored.md"), "utf8");
			writeFileSync(join(missionDir, "BACKLOG.md"), fixtureContent, "utf8");

			const backlog = await readBacklog(missionDir);
			expect(backlog.length).toBe(3);

			const byStatus = Object.fromEntries(backlog.map((e) => [e.status, e]));
			expect(byStatus.ROADMAP).toBeTruthy();
			expect(byStatus.ROADMAP.score).toBeCloseTo(0.75, 2);
			expect(byStatus.DECIDE).toBeTruthy();
			expect(byStatus.DECIDE.score).toBeCloseTo(0.52, 2);
			expect(byStatus.REJECTED).toBeTruthy();
			expect(byStatus.REJECTED.score).toBeCloseTo(0.19, 2);
		} finally {
			safeCleanup(baseDir);
		}
	});
});
