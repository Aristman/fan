// F-22: MockValidationEnvironment — helper для интеграционных тестов валидации.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-22
// Контракт: зафиксирован в header-комментарии test/validation/validation.test.mjs.
//
// Хелпер собирает сквозной контур MissionLoop со СМЕШАННОЙ DI:
//   - mock executor (очередь ответов с promise-тегами) + mock git/clock/lock
//   - РЕАЛЬНЫЕ модули: createIdeaGenerator, createIdeaScorer, createMetricsCollector,
//     createVerificationLadder (mock только на границах: llm, runCommand,
//     requestDecision).
//
// Паттерн — копия test/mission-loop-phase-b.test.mjs (DI-опции конструктора
// MissionLoop: ideaGenerator/ideaScorer/metricsCollector/verificationLadder/
// onEscalate). Реальный git/spawn/LLM НЕ используется — детерминированно и <30s.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../../file-state-manager.js";
import { MissionLoop } from "../../mission-loop.js";
import { createIdeaGenerator } from "../../idea-generator.js";
import { createIdeaScorer } from "../../idea-scorer.js";
import { createMetricsCollector } from "../../metrics-collector.js";
import { createVerificationLadder } from "../../verification-ladder.js";

// ─── Mock DI (стиль mission-loop-phase-b.test.mjs) ───────────────────────────

/**
 * In-memory записывающий мок executor'а. iterationResults — очередь; по
 * исчерпанию возвращает последний. Каждый результат — { status, response,
 * commitMessage?, costTokens? } (response содержит <promise>…</promise>).
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
	const executor = overrides.executor ?? makeMockExecutor([]);
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

// ─── Лестница верификации (детерминированные ступени) ──────────────────────

/**
 * 4 ступени с короткими «командами» (= имя ступени) — mock runCommand матчит
 * по command. Все required: true (провал «tests» останавливает лестницу).
 */
export const DEFAULT_LADDER_STEPS = [
	{ name: "typecheck", command: "typecheck", timeoutMs: 1_000, required: true },
	{ name: "linters", command: "linters", timeoutMs: 1_000, required: true },
	{ name: "build", command: "build", timeoutMs: 1_000, required: true },
	{ name: "tests", command: "tests", timeoutMs: 1_000, required: true },
];

/** runCommand, который успешно проходит все ступени. */
export const PASS_ALL_RUN_COMMAND = async (_command, _opts) => ({
	exitCode: 0,
	output: "ok",
});

/**
 * runCommand, который проваливает ступень «tests» при ПЕРВОМ вызове (exit 1,
 * output «test auth.test.ts:42 failed»), далее — exit 0. Эмулирует провал
 * тестов на первой итерации и успех на последующих.
 */
export function makeTestsFailOnceRunCommand() {
	let testsFailed = false;
	return async (command, _opts) => {
		if (command === "tests" && !testsFailed) {
			testsFailed = true;
			return { exitCode: 1, output: "test auth.test.ts:42 failed" };
		}
		return { exitCode: 0, output: "ok" };
	};
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Создать полное мок-окружение для интеграционных тестов валидации (F-22).
 *
 * @param opts
 *   - slug?: string               — slug миссии (default "validation-test")
 *   - responses?: object[]        — очередь ответов executor'а (с promise-тегами)
 *   - roadmapItems?: number       — число пунктов ROADMAP (default 6)
 *   - generatorLlm?: async fn    — mock LLM генератора → JSON-массив идей
 *   - scorerLlm?: async fn       — mock LLM скорера → JSON {relevance,value,risk,cost}
 *   - runCommand?: async fn       — mock runCommand для лестницы (default pass-all)
 *   - ladderSteps?: array        — кастомные ступени (default DEFAULT_LADDER_STEPS)
 *   - withLadder?: boolean        — инжектить ли verificationLadder (default true)
 *
 * @returns {
 *   missionDir, baseDir, loop, deps, metricsCollector, verificationLadder,
 *   ideaGenerator, ideaScorer, escalations[], decideRequests[],
 *   executorCalls, commits, cleanup,
 * }
 */
export async function createMockValidationEnvironment(opts = {}) {
	const slug = opts.slug ?? "validation-test";
	const baseDir = opts.baseDir ?? mkdtempSync(join(tmpdir(), "fan-f22-"));
	const responses = opts.responses ?? [];
	const roadmapItems = opts.roadmapItems ?? 6;

	// 1. Mission dir на диске + ROADMAP с N пунктами (миссия остаётся active
	//    после нескольких COMPLETE-итераций — иначе контур завершится).
	const missionDir = await initMission(slug, { baseDir });
	const lines = ["# Roadmap", ""];
	for (let i = 1; i <= roadmapItems; i++) lines.push(`- [ ] validation item ${i}`);
	lines.push("");
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");

	// 2. Сборщики эскалаций и DECIDE-запросов (для assertions).
	const escalations = [];
	const onEscalate = (level, payload) => {
		escalations.push({ level, ...payload });
	};
	const decideRequests = [];
	const requestDecision = (question) => {
		decideRequests.push(question);
	};

	// 3. Mock DI deps (executor с очередью ответов).
	const deps = makeDeps({
		executor: makeMockExecutor(responses),
	});

	// 4. РЕАЛЬНЫЕ модули (mock только на границах).
	const fixedNow = () => new Date("2026-08-13T10:00:00Z");

	const metricsCollector = createMetricsCollector({ now: fixedNow });

	const verificationLadder = createVerificationLadder({
		steps: opts.ladderSteps ?? DEFAULT_LADDER_STEPS,
		runCommand: opts.runCommand ?? PASS_ALL_RUN_COMMAND,
	});

	// Генератор/скорер инжектятся только если предоставлен соответствующий LLM.
	const ideaGenerator = opts.generatorLlm
		? createIdeaGenerator({ llm: opts.generatorLlm, now: fixedNow })
		: undefined;
	const ideaScorer = opts.scorerLlm
		? createIdeaScorer({ llm: opts.scorerLlm, requestDecision, now: fixedNow })
		: undefined;

	// 5. MissionLoop со всеми инъекциями.
	const loop = new MissionLoop({
		missionDir,
		deps,
		onEscalate,
		metricsCollector,
		verificationLadder: opts.withLadder === false ? undefined : verificationLadder,
		ideaGenerator,
		ideaScorer,
	});

	// 6. Idempotent cleanup.
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// best-effort — tmp-каталог мог быть уже удалён
		}
	};

	return {
		missionDir,
		baseDir,
		loop,
		deps,
		metricsCollector,
		verificationLadder,
		ideaGenerator,
		ideaScorer,
		escalations,
		decideRequests,
		executorCalls: deps.executorCalls,
		commits: deps.commits,
		cleanup,
	};
}

// ─── Stand-alone helpers ─────────────────────────────────────────────────────

/** Свежий tmp-каталог для теста (cleaned вручную через rmSync). */
export function freshBaseDir(prefix = "fan-f22-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Recursive safe-cleanup каталога. */
export function safeCleanup(dir) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}
