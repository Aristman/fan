// session-executor — Red-фаза (TDD)
//
// Модуль `extensions/fan-mission/session-executor.ts` (компилируемый в
// `session-executor.js`) — реализация интерфейса MissionExecutor поверх
// инъективного `runAgent` (DI для тестируемости: никаких реальных LLM/сети).
//
// Все тесты ожидают экспорт `createSessionExecutor` из `../session-executor.js`.
// На момент Red-фазы модуль не существует — динамический import в beforeAll
// выбрасывает ERR_MODULE_NOT_FOUND, try/catch глушит его, символ остаётся
// undefined, и каждый `it` падает индивидуально на `createSessionExecutor is
// not a function` (правильный TDD Red: тесты запускаются и падаются, а не
// «файл не загрузился»). После реализации модуля по контракту ниже тесты
// должны проходить.
//
// Контракт API (для Green-фазы):
//
//   createSessionExecutor(opts: {
//     runAgent: (prompt: string, opts?: { cwd?: string; steer?: string })
//       => Promise<{ response: string; costTokens?: number; costUsd?: number }>,
//   }): MissionExecutor
//
//   executor.runIteration(opts: {
//     missionDir: string;
//     prompt: string;
//     cwd: string;
//     steer?: string;
//   }): Promise<IterationResult>
//
// Поведение runIteration:
//   1. Вызывает runAgent(prompt, { cwd, steer }).
//   2. Мапит результат в IterationResult, выводя status из parsePromise(response):
//        tag COMPLETE  → status "COMPLETE"
//        tag BLOCKED   → status "BLOCKED",   reason = reason тега
//        tag DECIDE    → status "DECIDE",    question = reason тега
//        tag FAILED    → status "FAILED",    reason = reason тега
//        null (нет тега) → status "COMPLETE" (fallback; mission-loop сам
//                          обработает эскалацию I3 по response без тега)
//   3. costTokens / costUsd пробрасываются как есть из результата runAgent.
//   4. response пробрасывается как есть (raw текст с тегом).
//   5. Ошибку runAgent пробрасывает (не глотает).
//
// Точные интерфейсы (прочитаны из mission-loop.ts):
//   export interface MissionExecutor {
//     runIteration(opts: {
//       missionDir: string; prompt: string; cwd: string; steer?: string;
//     }): Promise<IterationResult>;
//   }
//   export interface IterationResult {
//     status: "COMPLETE" | "BLOCKED" | "DECIDE" | "FAILED";
//     reason?: string;
//     question?: string;
//     commitMessage?: string;
//     costTokens?: number;
//     costUsd?: number;
//     response?: string;
//   }
// parsePromise (promise-parser.ts) →
//   { tag: "COMPLETE"|"BLOCKED"|"DECIDE"|"FAILED"; reason?: string } | null

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Импорт SUT. На Red-фазе модуля нет — динамический import выбрасывает
// ERR_MODULE_NOT_FOUND, try/catch глушит, символ остаётся undefined. Файл
// при этом ЗАГРУЖАЕТСЯ, все it-блоки собираются и падают ИНДИВИДУАЛЬНО на
// вызове undefined-символа. На Green-фазе модуль появится — import подтянет
// символ, тесты пройдут.
// ────────────────────────────────────────────────────────────────────────────

let createSessionExecutor;

beforeAll(async () => {
	try {
		({ createSessionExecutor } = await import("../session-executor.js"));
	} catch {
		// Red: session-executor.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock runAgent (DI) с записью вызовов, временный missionDir
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт mock runAgent с записью вызовов (.calls[]).
 *
 * cfg:
 *   response     — текст ответа агента (по умолчанию "ok")
 *   costTokens   — если задано, добавляется в результат runAgent
 *   costUsd      — если задано, добавляется в результат runAgent
 *   throw        — если задано, mock бросает Error(throw) (имитация сбоя агента)
 *
 * Реальный LLM/сеть НЕ вызывается. .calls[] хранит { prompt, opts } для asserts.
 */
function makeRunAgent(cfg = {}) {
	const { response = "ok", costTokens, costUsd, throw: throwMsg } = cfg;
	const calls = [];
	const fn = async (prompt, opts) => {
		calls.push({ prompt, opts: opts ?? {} });
		if (throwMsg) throw new Error(throwMsg);
		const out = { response };
		if (costTokens !== undefined) out.costTokens = costTokens;
		if (costUsd !== undefined) out.costUsd = costUsd;
		return out;
	};
	fn.calls = calls;
	return fn;
}

// Временный missionDir для каждого теста. runAgent замокан и реальных команд
// не запускает, но настоящий каталог страховует от impl, который может
// stat()'нуть директорию перед вызовом агента.

let missionDir;

beforeEach(() => {
	missionDir = mkdtempSync(join(tmpdir(), "fan-se-red-"));
});

afterEach(() => {
	rmSync(missionDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// TC-1: runIteration вызывает runAgent с prompt и {cwd, steer}
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-1: runIteration вызывает runAgent с prompt и {cwd, steer}", () => {
	it("runAgent вызван ровно один раз с переданными prompt, cwd и steer", async () => {
		const runAgent = makeRunAgent({ response: "<promise>COMPLETE</promise>" });
		const executor = createSessionExecutor({ runAgent });

		await executor.runIteration({
			missionDir,
			prompt: "Реализуй F-16",
			cwd: "/repo",
			steer: "не трогай тесты",
		});

		expect(runAgent.calls.length).toBe(1);
		expect(runAgent.calls[0].prompt).toBe("Реализуй F-16");
		expect(runAgent.calls[0].opts.cwd).toBe("/repo");
		expect(runAgent.calls[0].opts.steer).toBe("не трогай тесты");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-2: <promise>COMPLETE</promise> → status "COMPLETE"
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-2: COMPLETE-тег → status COMPLETE", () => {
	it("ответ с <promise>COMPLETE</promise> → status 'COMPLETE'", async () => {
		const runAgent = makeRunAgent({ response: "<promise>COMPLETE</promise>" });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.status).toBe("COMPLETE");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-3: <promise>BLOCKED:нет БД</promise> → status "BLOCKED", reason "нет БД"
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-3: BLOCKED-тег → status BLOCKED + reason", () => {
	it("ответ с <promise>BLOCKED:нет БД</promise> → status 'BLOCKED', reason 'нет БД'", async () => {
		const runAgent = makeRunAgent({ response: "<promise>BLOCKED:нет БД</promise>" });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.status).toBe("BLOCKED");
		expect(result.reason).toBe("нет БД");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-4: <promise>DECIDE:JWT или session?</promise> → status "DECIDE", question
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-4: DECIDE-тег → status DECIDE + question", () => {
	it("ответ с <promise>DECIDE:JWT или session?</promise> → status 'DECIDE', question 'JWT или session?'", async () => {
		const runAgent = makeRunAgent({ response: "<promise>DECIDE:JWT или session?</promise>" });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.status).toBe("DECIDE");
		expect(result.question).toBe("JWT или session?");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-5: <promise>FAILED:тесты красные</promise> → status "FAILED", reason
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-5: FAILED-тег → status FAILED + reason", () => {
	it("ответ с <promise>FAILED:тесты красные</promise> → status 'FAILED', reason 'тесты красные'", async () => {
		const runAgent = makeRunAgent({ response: "<promise>FAILED:тесты красные</promise>" });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.status).toBe("FAILED");
		expect(result.reason).toBe("тесты красные");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-6: ответ БЕЗ тега → status "COMPLETE" (fallback)
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-6: ответ без тега → fallback status COMPLETE", () => {
	it("ответ без promise-тега → status 'COMPLETE' (mission-loop сам эскалирует I3)", async () => {
		const runAgent = makeRunAgent({ response: "Готово, всё работает корректно." });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.status).toBe("COMPLETE");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-7: costTokens / costUsd пробрасываются из результата runAgent
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-7: costTokens/costUsd пробрасываются из runAgent", () => {
	it("runAgent вернул costTokens=1234, costUsd=0.05 → IterationResult пробрасывает как есть", async () => {
		const runAgent = makeRunAgent({
			response: "<promise>COMPLETE</promise>",
			costTokens: 1234,
			costUsd: 0.05,
		});
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.costTokens).toBe(1234);
		expect(result.costUsd).toBe(0.05);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-8: response пробрасывается как есть (raw текст с тегом)
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-8: response пробрасывается как есть", () => {
	it("raw ответ с тегом и окружающим текстом → IterationResult.response === ответ 1:1", async () => {
		const response = "Анализ завершён.\n<promise>COMPLETE</promise>\nГотово.";
		const runAgent = makeRunAgent({ response });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.response).toBe(response);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-9: steer передаётся в runAgent opts
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-9: steer передаётся в runAgent opts", () => {
	it("steer из runIteration доходит до runAgent как opts.steer", async () => {
		const runAgent = makeRunAgent({ response: "<promise>COMPLETE</promise>" });
		const executor = createSessionExecutor({ runAgent });

		await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
			steer: "используй Redis для кэша",
		});

		expect(runAgent.calls[0].opts.steer).toBe("используй Redis для кэша");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-10: runAgent бросает ошибку → runIteration пробрасывает (не глотает)
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-10: ошибка runAgent пробрасывается", () => {
	it("runAgent бросает Error('agent crashed') → runIteration пробрасывает тот же throw", async () => {
		const runAgent = makeRunAgent({ throw: "agent crashed" });
		const executor = createSessionExecutor({ runAgent });

		await expect(
			executor.runIteration({ missionDir, prompt: "x", cwd: "/repo" }),
		).rejects.toThrow("agent crashed");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-11: runAgent вернул costTokens undefined → IterationResult.costTokens undefined (не NaN)
// ────────────────────────────────────────────────────────────────────────────

describe("session-executor / TC-11: costTokens undefined остаётся undefined (не NaN)", () => {
	it("runAgent без cost-полей → IterationResult.costTokens undefined, не NaN", async () => {
		const runAgent = makeRunAgent({ response: "<promise>COMPLETE</promise>" });
		const executor = createSessionExecutor({ runAgent });

		const result = await executor.runIteration({
			missionDir,
			prompt: "x",
			cwd: "/repo",
		});

		expect(result.costTokens).toBeUndefined();
		expect(result.costUsd).toBeUndefined();
		// Страховка: имплементация может сделать Number(undefined) → NaN.
		expect(Number.isNaN(result.costTokens)).toBe(false);
		expect(Number.isNaN(result.costUsd)).toBe(false);
	});
});
