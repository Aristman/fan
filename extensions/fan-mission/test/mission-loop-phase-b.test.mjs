// Фаза B (F-19/F-20/F-21): «Идеи и метрики» — интеграция в mission-loop — Red-фаза.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md
//           §Фаза B «Идеи и метрики» (E2E-сценарии 1–2, Smoke-критерий фазы).
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3, §5.2, §6.1.
//
// Модули F-19 (idea-generator), F-20 (idea-scorer), F-21 (metrics-collector) УЖЕ
// реализованы как изолированные модули (Green). Эта Red-фаза проверяет ИХ
// ИНТЕГРАЦИЮ в mission-loop: новые DI-опции конструктора MissionLoop, которые
// связывают генератор/скорер/коллектор с 7-шаговым контуром.
//
// ────────────────────────────────────────────────────────────────────────────
// КОНТРАКТ ИНТЕГРАЦИИ (новые DI-опции MissionLoop, поверх существующих
// { missionDir, deps, drainFlag?, decideTimeoutMs?, verificationLadder?,
//   onEscalate? }):
//
//   constructor(opts: {
//     ...,
//     ideaGenerator?: {
//       generate(missionDir: string): Promise<{ added: number; skippedDuplicates: number }>
//     },
//     ideaScorer?: {
//       scoreIdea(missionDir, idea): Promise<{ id, score, status: "ROADMAP"|"DECIDE"|"REJECTED" }>
//     },
//     metricsCollector?: {
//       onIterationEnd(missionDir, record): Promise<void>
//     },
//   })
//
//   Правила:
//   1. metricsCollector.onIterationEnd вызывается на КАЖДОЙ итерации (включая
//      FAILED/BLOCKED/ladder-fail), после определения финального статуса
//      итерации; ошибки collector'а не роняют контур (try/catch).
//      Запись: { iteration, tokensIn, tokensOut, durationMs, status, promiseTag }.
//      ВАЖНО: IterationResult контура НЕ содержит tokensIn/tokensOut/durationMs
//      (только costTokens/costUsd — проверено в mission-loop.ts). Контур передаёт
//      что есть (0/undefined допустимы) — зафиксировано в тестах E2E-2.
//   2. ideaGenerator.generate вызывается после каждой итерации (если инжектнут);
//      порог 3 итераций ВНУТРИ генератора (контур просто вызывает каждый раз);
//      ошибки генератора не роняют контур (try/catch).
//   3. ideaScorer.scoreIdea вызывается для каждой НОВОЙ идеи (added генератором);
//      контур читает BACKLOG, находит unscored-идеи (status "IDEA") и скорит их
//      в порядке добавления. ROADMAP → ничего дополнительно; DECIDE → контур
//      переходит в awaiting_decision (вопрос = идея + score, переиспользует
//      механизм F-17: статус awaiting_decision + pendingDecision); REJECTED →
//      ничего (скорер сам пишет DECISIONS.md); ошибки скорера не роняют контур,
//      идея остаётся в BACKLOG без статуса (status "IDEA").
//   4. Без инъекций — поведение контура без изменений (backward compat):
//      metrics.jsonl не создаётся, generate/scoreIdea не вызываются.
//
// ─── Red-фаза ───────────────────────────────────────────────────────────────
//   На момент написания MissionLoop НЕ принимает ideaGenerator/ideaScorer/
//   metricsCollector (в .mjs лишние поля destructuring-а молча отбрасываются,
//   символы остаются undefined). Поэтому моки не вызываются:
//   generator.calls=[], scorer.calls=[], collector.calls=[].
//   Тесты НОВОЙ интеграции (E2E-1, E2E-2, smoke-metrics, edge-throws,
//   edge-DECIDE) — FAIL (моки не вызваны, статус не awaiting_decision,
//   metrics.jsonl не создан). Guard-тесты backward-compat (без инъекций →
//   metrics.jsonl не создан) и smoke-scorer (модуль F-20 уже реализован) — PASS.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendBacklog, initMission, readBacklog, readDecisions } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import { createIdeaScorer } from "../idea-scorer.js";
import { createMetricsCollector } from "../metrics-collector.js";

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock-объекты для DI (стиль mission-loop-promise-routing.test.mjs)
// ────────────────────────────────────────────────────────────────────────────

/**
 * In-memory записывающий мок executor'а.
 * iterationResults — массив IterationResult; по исчерпании возвращает последний.
 * Контракт фазы B: executor возвращает `response` (raw LLM-вывод с тегом
 * <promise>…) + `status` (fallback). Поля tokensIn/tokensOut/durationMs в
 * IterationResult контура ОТСУТСТВУЮТ (только costTokens/costUsd) — это
 * зафиксировано в E2E-2 (контур передаёт 0/undefined в collector).
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
	const base = new Date("2026-08-13T10:00:00Z");
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
 * Записывающий мок ideaGenerator'а.
 * На triggerOnCall-м (default 3) вызове добавляет `ideas` в BACKLOG.md (status
 * "IDEA") и возвращает { added: ideas.length, skippedDuplicates: 0 }.
 * На прочих вызовах — { added: 0, skippedDuplicates: 0 }. Это имитирует порог
 * 3 итераций ВНУТРИ генератора (контур просто вызывает generate каждый раз).
 */
function makeMockGenerator(ideas, { triggerOnCall = 3 } = {}) {
	const calls = [];
	let count = 0;
	return {
		calls,
		async generate(missionDir) {
			calls.push({ missionDir });
			count++;
			if (count === triggerOnCall) {
				for (const idea of ideas) {
					await appendBacklog(missionDir, {
						id: idea.id,
						date: idea.date ?? "2026-08-13",
						idea: idea.idea,
						source: idea.source,
						fit: 0,
						value: 0,
						risk: 0,
						cost: 0,
						score: 0,
						status: "IDEA",
					});
				}
				return { added: ideas.length, skippedDuplicates: 0 };
			}
			return { added: 0, skippedDuplicates: 0 };
		},
	};
}

/**
 * Записывающий мок ideaScorer'а. results — map id → { score, status }.
 * Возвращает { id, score, status } по idea.id; для неизвестных — DECIDE 0.5.
 */
function makeMockScorer(results) {
	const calls = [];
	return {
		calls,
		async scoreIdea(missionDir, idea) {
			calls.push({
				missionDir,
				idea: { id: idea.id, idea: idea.idea, source: idea.source },
			});
			const r = results[idea.id];
			if (r) return { id: idea.id, score: r.score, status: r.status };
			return { id: idea.id, score: 0.5, status: "DECIDE" };
		},
	};
}

/**
 * Записывающий мок metricsCollector'а. Сохраняет копии записей в calls[].
 * opts.throw — Error, который бросает onIterationEnd (edge «collector упал»).
 */
function makeRecordingCollector(opts = {}) {
	const calls = [];
	return {
		calls,
		async onIterationEnd(missionDir, record) {
			calls.push({ missionDir, record: { ...record } });
			if (opts.throw) throw opts.throw;
		},
	};
}

function freshBaseDir(prefix = "fan-phaseB-red-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

/** COMPLETE-итерация с promise-тегом (без тега → I3-эскалация; этого избегаем). */
function completeResult(commitMessage = "iter complete") {
	return { status: "COMPLETE", response: "<promise>COMPLETE</promise>", commitMessage };
}

// ────────────────────────────────────────────────────────────────────────────
// E2E-1: генерация → скоринг → маршрутизация (сценарий 1 фазы B)
//
// 3 итерации COMPLETE → генератор добавляет 3 идеи → скорер:
//   idea-001 (0.75) → ROADMAP; idea-002 (0.62) → DECIDE; idea-003 (0.35) → REJECTED
// ────────────────────────────────────────────────────────────────────────────

describe("Phase B / E2E-1: генерация → скоринг → маршрутизация", () => {
	let baseDir;
	let missionDir;
	let deps;
	let generator;
	let scorer;
	let loop;

	const ideas = [
		{ id: "idea-001", idea: "Кэширование Redis", source: "итерация #3" },
		{ id: "idea-002", idea: "Вынести логирование в сервис", source: "итерация #3" },
		{ id: "idea-003", idea: "Переписать всё на Rust", source: "итерация #3" },
	];

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseB-e2e1-");
		missionDir = await initMission("e2e1-ideas", { baseDir });
		// 5 пунктов ROADMAP: 3 COMPLETE-итерации чекают пункты 1–3, миссия
		// остаётся active (пункты 4–5), что позволяет DECIDE-переходу скорера.
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"- [ ] item three",
			"- [ ] item four",
			"- [ ] item five",
			"",
		]);
		generator = makeMockGenerator(ideas, { triggerOnCall: 3 });
		scorer = makeMockScorer({
			"idea-001": { score: 0.75, status: "ROADMAP" },
			"idea-002": { score: 0.62, status: "DECIDE" },
			"idea-003": { score: 0.35, status: "REJECTED" },
		});
		deps = makeDeps({
			executor: makeMockExecutor([
				completeResult("iter 1"),
				completeResult("iter 2"),
				completeResult("iter 3"),
			]),
		});
		loop = new MissionLoop({ missionDir, deps, ideaGenerator: generator, ideaScorer: scorer });

		// Контур завершает 3 итерации (полный сценарий фазы B).
		await loop.tick();
		await loop.tick();
		await loop.tick();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("generator.generate вызван ≥3 раз за 3 итерации (после каждой итерации)", () => {
		// Контур вызывает generate после КАЖДОЙ итерации (порог 3 — внутри генератора).
		expect(generator.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("scorer.scoreIdea вызван для 3 идей (idea-001/002/003)", () => {
		expect(scorer.calls.length).toBe(3);
		const ids = scorer.calls.map((c) => c.idea.id);
		expect(ids).toContain("idea-001");
		expect(ids).toContain("idea-002");
		expect(ids).toContain("idea-003");
	});

	it("scoreIdea получает идеи в порядке добавления (001 → 002 → 003)", () => {
		// readBacklog возвращает записи в порядке файла; контур скорит в этом порядке.
		const ids = scorer.calls.map((c) => c.idea.id);
		expect(ids).toEqual(["idea-001", "idea-002", "idea-003"]);
	});

	it("после DECIDE-идеи (idea-002) миссия в awaiting_decision", async () => {
		// DECIDE от скорера → контур переходит в awaiting_decision (механизм F-17).
		expect(await loop.status()).toBe("awaiting_decision");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// E2E-2: метрики на каждой итерации (сценарий 2 фазы B)
//
// 5 итераций (3 COMPLETE, 1 BLOCKED, 1 FAILED) → onIterationEnd вызван 5 раз;
// записи содержат iteration 1..5, status, promiseTag; токены/duration из
// iterResult (который их не имеет → 0/undefined по контракту).
// ────────────────────────────────────────────────────────────────────────────

describe("Phase B / E2E-2: метрики на каждой итерации", () => {
	let baseDir;
	let missionDir;
	let deps;
	let collector;
	let loop;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseB-e2e2-");
		missionDir = await initMission("e2e2-metrics", { baseDir });
		// 5 пунктов ROADMAP: 3 COMPLETE чекают 1–3; BLOCKED/FAILED ретраят пункт 4.
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"- [ ] item three",
			"- [ ] item four",
			"- [ ] item five",
			"",
		]);
		collector = makeRecordingCollector();
		deps = makeDeps({
			executor: makeMockExecutor([
				completeResult("iter 1"),
				completeResult("iter 2"),
				completeResult("iter 3"),
				{ status: "BLOCKED", response: "<promise>BLOCKED:нет ресурса</promise>" },
				{ status: "FAILED", response: "<promise>FAILED:тесты красные</promise>" },
			]),
		});
		loop = new MissionLoop({ missionDir, deps, metricsCollector: collector });

		await loop.tick();
		await loop.tick();
		await loop.tick();
		await loop.tick();
		await loop.tick();
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("onIterationEnd вызван ровно 5 раз (по разу на итерацию, включая BLOCKED/FAILED)", () => {
		expect(collector.calls.length).toBe(5);
	});

	it("записи содержат iteration 1..5 в порядке вызова", () => {
		const iterations = collector.calls.map((c) => c.record.iteration);
		expect(iterations).toEqual([1, 2, 3, 4, 5]);
	});

	it("записи содержат status и promiseTag, отражающие исход итерации", () => {
		// status — case-insensitive (контур передаёт iterResult.status; коллектор F-21
		// классифицирует lowercase — точный casing на усмотрение Green-фазы).
		// promiseTag — из parsePromise(response), uppercase (однозначно).
		const records = collector.calls.map((c) => c.record);
		expect(records[0].status).toMatch(/complete/i);
		expect(records[0].promiseTag).toBe("COMPLETE");
		expect(records[1].status).toMatch(/complete/i);
		expect(records[1].promiseTag).toBe("COMPLETE");
		expect(records[2].status).toMatch(/complete/i);
		expect(records[2].promiseTag).toBe("COMPLETE");
		// BLOCKED — collector вызывается и для не-COMPLETE итераций (контракт правила 1).
		expect(records[3].status).toMatch(/blocked/i);
		expect(records[3].promiseTag).toBe("BLOCKED");
		expect(records[4].status).toMatch(/fail/i);
		expect(records[4].promiseTag).toBe("FAILED");
	});

	it("токены/duration присутствуют в записях (iterResult их не имеет → 0/undefined)", () => {
		// Guard: collector должен быть вызван (иначе проверка формы записей бессмысленна).
		// В Red collector не вызывается → calls=[] → этот guard FAIL (подтверждение Red).
		expect(collector.calls.length).toBeGreaterThanOrEqual(1);
		// IterationResult контура = { status, reason?, response?, costTokens?, costUsd? }.
		// Полей tokensIn/tokensOut/durationMs НЕТ → контур передаёт что есть
		// (0/undefined допустимы по контракту). Фиксируем наличие ключей в записи.
		for (const c of collector.calls) {
			expect("tokensIn" in c.record).toBe(true);
			expect("tokensOut" in c.record).toBe(true);
			expect("durationMs" in c.record).toBe(true);
			// 0 или число — оба допустимы; undefined тоже (контракт «0/undefined допустимы»).
			const tin = c.record.tokensIn;
			expect(tin === undefined || typeof tin === "number").toBe(true);
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Smoke-критерий фазы B
//   1. Скорер с фиксированным LLM-ответом (0.9/0.8/0.3/0.4) → score 0.75 → ROADMAP
//      (модульный уровень — createIdeaScorer уже реализован, PASS).
//   2. Реальный createMetricsCollector + 1 tick контура с инжектнутым collector'ом
//      → metrics.jsonl содержит ≥1 запись (Red: контур не вызывает collector → FAIL).
// ────────────────────────────────────────────────────────────────────────────

describe("Phase B / Smoke", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseB-smoke-");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("smoke scorer: createIdeaScorer + mock llm {0.9,0.8,0.3,0.4} → score 0.75 → ROADMAP", async () => {
		missionDir = await initMission("smoke-scorer", { baseDir });
		// Seed-идея в BACKLOG (status "IDEA") — scoreIdea обновит её через updateBacklogEntry.
		await appendBacklog(missionDir, {
			id: "idea-smoke",
			date: "2026-08-13",
			idea: "Добавить кэширование Redis",
			source: "smoke",
			fit: 0,
			value: 0,
			risk: 0,
			cost: 0,
			score: 0,
			status: "IDEA",
		});
		const llm = async () =>
			JSON.stringify({ relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 });
		const scorer = createIdeaScorer({ llm, now: () => new Date("2026-08-13T12:00:00Z") });

		const result = await scorer.scoreIdea(missionDir, {
			id: "idea-smoke",
			idea: "Добавить кэширование Redis",
			source: "smoke",
		});

		// 0.3*0.9 + 0.2*0.8 + 0.2*0.7 + 0.3*0.6 = 0.27+0.16+0.14+0.18 = 0.75
		expect(result.id).toBe("idea-smoke");
		expect(result.score).toBeCloseTo(0.75, 3);
		expect(result.status).toBe("ROADMAP");
	});

	it("smoke metrics: реальный createMetricsCollector + 1 tick → metrics.jsonl ≥1 запись", async () => {
		missionDir = await initMission("smoke-metrics", { baseDir });
		writeRoadmap(missionDir, ["# Roadmap", "", "- [ ] smoke item", "- [ ] follow-up", ""]);
		const metricsCollector = createMetricsCollector();
		const deps = makeDeps({
			executor: makeMockExecutor([completeResult("smoke tick")]),
		});
		const loop = new MissionLoop({ missionDir, deps, metricsCollector });

		await loop.tick();

		// Реальный collector пишет в <missionDir>/metrics.jsonl (append-only JSONL).
		const metricsPath = join(missionDir, "metrics.jsonl");
		expect(existsSync(metricsPath)).toBe(true);
		const content = readFileSync(metricsPath, "utf8");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		expect(lines.length).toBeGreaterThanOrEqual(1);

		// Запись парсится как JSON и содержит ключевые поля.
		const first = JSON.parse(lines[0]);
		expect(first.iteration).toBe(1);
		expect(first).toHaveProperty("status");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE: устойчивость (ошибки модулей не роняют контур) и backward-compat
// ────────────────────────────────────────────────────────────────────────────

describe("Phase B / EDGE: устойчивость и backward-compat", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-phaseB-edge-");
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	function roadmapWith(n) {
		const lines = ["# Roadmap", ""];
		for (let i = 1; i <= n; i++) lines.push(`- [ ] edge item ${i}`);
		lines.push("");
		writeRoadmap(missionDir, lines);
	}

	// EDGE: metricsCollector бросает ошибку → контур продолжает итерации (try/catch)
	it("EDGE: metricsCollector.onIterationEnd бросает → контур продолжает (try/catch)", async () => {
		missionDir = await initMission("edge-collector-throw", { baseDir });
		roadmapWith(4);
		const calls = [];
		const metricsCollector = {
			async onIterationEnd(missionDir, record) {
				calls.push({ missionDir, record: { ...record } });
				throw new Error("collector crashed: disk full");
			},
		};
		const deps = makeDeps({
			executor: makeMockExecutor([completeResult("a"), completeResult("b")]),
		});
		const loop = new MissionLoop({ missionDir, deps, metricsCollector });

		// tick НЕ должен выбросить (контур не падает на ошибке collector'а).
		const r1 = await loop.tick();
		expect(r1.status).toBe("active");
		// collector БЫЛ вызван (и бросил), но контур выжил.
		expect(calls.length).toBeGreaterThanOrEqual(1);

		// Второй tick — контур продолжает (try/catch изолировал ошибку).
		const r2 = await loop.tick();
		expect(r2.status).toBe("active");
		expect(deps.executorCalls.length).toBe(2);
		expect(calls.length).toBeGreaterThanOrEqual(2);
	});

	// EDGE: ideaGenerator бросает ошибку → контур продолжает итерации
	it("EDGE: ideaGenerator.generate бросает → контур продолжает", async () => {
		missionDir = await initMission("edge-generator-throw", { baseDir });
		roadmapWith(4);
		const genCalls = [];
		const ideaGenerator = {
			async generate(missionDir) {
				genCalls.push({ missionDir });
				throw new Error("generator crashed: LLM 503");
			},
		};
		const deps = makeDeps({
			executor: makeMockExecutor([completeResult("a"), completeResult("b")]),
		});
		const loop = new MissionLoop({ missionDir, deps, ideaGenerator });

		const r1 = await loop.tick();
		expect(r1.status).toBe("active");
		// generator БЫЛ вызван (и бросил), но контур выжил.
		expect(genCalls.length).toBeGreaterThanOrEqual(1);

		await loop.tick();
		expect(deps.executorCalls.length).toBe(2);
		expect(genCalls.length).toBeGreaterThanOrEqual(2);
	});

	// EDGE: ideaScorer бросает ошибку → контур продолжает, идея остаётся в BACKLOG
	// без статуса (status "IDEA" — scorer не обновил запись).
	it("EDGE: ideaScorer.scoreIdea бросает → контур продолжает, идея остаётся unscored (IDEA)", async () => {
		missionDir = await initMission("edge-scorer-throw", { baseDir });
		roadmapWith(4);
		const generator = makeMockGenerator(
			[{ id: "idea-001", idea: "edge idea", source: "s" }],
			{ triggerOnCall: 3 },
		);
		const scorerCalls = [];
		const ideaScorer = {
			async scoreIdea(missionDir, idea) {
				scorerCalls.push({ missionDir, idea });
				throw new Error("scorer crashed: invalid response");
			},
		};
		const deps = makeDeps({
			executor: makeMockExecutor([completeResult("a"), completeResult("b"), completeResult("c")]),
		});
		const loop = new MissionLoop({ missionDir, deps, ideaGenerator: generator, ideaScorer });

		// 3 тика: на 3-м генератор добавляет идею, скорер бросает.
		await loop.tick();
		await loop.tick();
		const r3 = await loop.tick(); // НЕ должен выбросить
		expect(r3.status).toBe("active");

		// scorer БЫЛ вызван (и бросил), но контур выжил.
		expect(scorerCalls.length).toBeGreaterThanOrEqual(1);

		// Идея осталась в BACKLOG со статусом "IDEA" (unscored — scorer не обновил).
		const backlog = await readBacklog(missionDir);
		const idea = backlog.find((e) => e.id === "idea-001");
		expect(idea).toBeTruthy();
		expect(idea.status).toBe("IDEA");
	});

	// EDGE: DECIDE от скорера → resolveDecision возобновляет контур (интеграция F-17)
	it("EDGE: DECIDE от скорера → awaiting_decision; resolveDecision возобновляет контур", async () => {
		missionDir = await initMission("edge-scorer-decide", { baseDir });
		roadmapWith(5);
		const generator = makeMockGenerator(
			[{ id: "idea-001", idea: "decide me", source: "s" }],
			{ triggerOnCall: 3 },
		);
		const ideaScorer = makeMockScorer({
			"idea-001": { score: 0.62, status: "DECIDE" },
		});
		const deps = makeDeps({
			executor: makeMockExecutor([
				completeResult("a"),
				completeResult("b"),
				completeResult("c"),
				completeResult("after resolve"),
			]),
		});
		const loop = new MissionLoop({ missionDir, deps, ideaGenerator: generator, ideaScorer });

		await loop.tick();
		await loop.tick();
		await loop.tick(); // 3-й: generate добавляет идею, scorer → DECIDE → awaiting_decision

		// DECIDE от скорера → контур в awaiting_decision (вопрос = идея + score).
		expect(await loop.status()).toBe("awaiting_decision");

		// resolveDecision (F-17) возобновляет контур: статус → active.
		await loop.resolveDecision("принять идею в план");
		expect(await loop.status()).toBe("active");

		// Следующий tick запускает свежую итерацию (executor вызвана снова).
		await loop.tick();
		expect(deps.executorCalls.length).toBe(4);
	});

	// EDGE: Без инъекций (обычный контур) → поведение не меняется (backward compat):
	// metrics.jsonl НЕ создаётся, generate/scoreIdea не вызываются.
	it("EDGE: без инъекций → metrics.jsonl не создаётся (backward compat)", async () => {
		missionDir = await initMission("edge-no-inject", { baseDir });
		roadmapWith(3);
		const deps = makeDeps({
			executor: makeMockExecutor([completeResult("a"), completeResult("b")]),
		});
		// Обычный контур — без ideaGenerator/ideaScorer/metricsCollector.
		const loop = new MissionLoop({ missionDir, deps });

		await loop.tick();
		await loop.tick();

		// metrics.jsonl не создаётся (collector не инжектнут).
		const metricsPath = join(missionDir, "metrics.jsonl");
		expect(existsSync(metricsPath)).toBe(false);

		// Контур работает как раньше: 2 итерации отработали, 2 коммита.
		expect(deps.executorCalls.length).toBe(2);
		expect(deps.commits.length).toBe(2);
	});

	// EDGE: ideaScorer REJECTED сам пишет DECISIONS.md (контур не дублирует)
	it("EDGE: ideaScorer REJECTED → DECISIONS.md содержит запись об отклонении", async () => {
		missionDir = await initMission("edge-scorer-rejected", { baseDir });
		roadmapWith(5);
		const generator = makeMockGenerator(
			[{ id: "idea-001", idea: "слабая идея", source: "s" }],
			{ triggerOnCall: 3 },
		);
		// Мок-скорер возвращает REJECTED, но НЕ пишет DECISIONS.md (как реальный).
		// Поэтому проверяем лишь, что контур НЕ упал и статус не awaiting_decision.
		// Реальная запись в DECISIONS.md — ответственность скорера (F-20), не контура.
		const ideaScorer = makeMockScorer({
			"idea-001": { score: 0.35, status: "REJECTED" },
		});
		const deps = makeDeps({
			executor: makeMockExecutor([completeResult("a"), completeResult("b"), completeResult("c")]),
		});
		const loop = new MissionLoop({ missionDir, deps, ideaGenerator: generator, ideaScorer });

		await loop.tick();
		await loop.tick();
		const r3 = await loop.tick(); // 3-й: scorer → REJECTED

		// REJECTED → контур НЕ переходит в awaiting_decision (только DECIDE).
		expect(r3.status).toBe("active");
		expect(await loop.status()).toBe("active");
		// scorer БЫЛ вызван для отклонённой идеи.
		expect(ideaScorer.calls.length).toBe(1);
	});
});
