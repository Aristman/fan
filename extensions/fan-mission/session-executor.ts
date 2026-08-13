// Session executor — реализация MissionExecutor поверх инъективного runAgent.
//
// DI для тестируемости: сам модуль не трогает LLM/сеть — runAgent приходит
// извне. Модуль лишь пробрасывает prompt/steer в агента и мапит ответ в
// IterationResult по тегу <promise> (parsePromise); ошибки runAgent не
// глотаются — их обрабатывает mission-loop.

import type { IterationResult, MissionExecutor } from "./mission-loop.js";
import { parsePromise } from "./promise-parser.js";

/** Инъективный драйвер агент-сессии. Ошибки пробрасываются наверх. */
export type RunAgent = (
	prompt: string,
	opts?: { cwd?: string; steer?: string },
) => Promise<{ response: string; costTokens?: number; costUsd?: number }>;

export interface SessionExecutorOptions {
	runAgent: RunAgent;
}

/**
 * Создаёт MissionExecutor поверх runAgent. Поведение runIteration:
 *  1. runAgent(prompt, { cwd, steer }) — ошибки пробрасываются как есть;
 *  2. parsePromise(response): тег → status (BLOCKED/FAILED → reason,
 *     DECIDE → question), нет тега → fallback status "COMPLETE"
 *     (эскалацию I3 по нетегированному ответу делает сам mission-loop);
 *  3. costTokens/costUsd пробрасываются как есть (undefined допустим);
 *  4. response пробрасывается как есть (raw текст с тегом).
 */
export function createSessionExecutor(opts: SessionExecutorOptions): MissionExecutor {
	return {
		async runIteration({ prompt, cwd, steer }): Promise<IterationResult> {
			const result = await opts.runAgent(prompt, { cwd, steer });
			const parsed = parsePromise(result.response);

			const out: IterationResult = {
				status: parsed?.tag ?? "COMPLETE",
				costTokens: result.costTokens,
				costUsd: result.costUsd,
				response: result.response,
			};
			if (parsed?.tag === "BLOCKED" || parsed?.tag === "FAILED") {
				out.reason = parsed.reason;
			} else if (parsed?.tag === "DECIDE") {
				out.question = parsed.reason;
			}
			return out;
		},
	};
}
