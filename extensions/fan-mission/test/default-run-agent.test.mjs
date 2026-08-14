// F-MISSION-DEFAULT-RUN-AGENT: production runAgent с захватом реального
// результата итерации и usage (ТИКЕТ-12).
//
// Контракт (реализация: extensions/fan-mission/default-run-agent.ts):
//
//   createDefaultRunAgent(fan, opts?: { timeoutMs?; now? }):
//     { runAgent: RunAgent, settle(reason): void }
//
// Поведение:
//   • ОДИН персистентный handler fan.on("agent_end", ...) при создании
//     (unsubscribe нет — handler читает mutable state.pending; null → no-op).
//   • runAgent(prompt): pending устанавливается ДО
//     fan.sendUserMessage(prompt, {deliverAs:"followUp"}) (race-guard).
//   • Корреляция: ПОСЛЕДНИЙ user в messages с текстом === prompt
//     (content string → как есть; array → concat TextContent.text).
//     Не найден → игнор (чужой turn).
//   • Результат из assistant ПОСЛЕ найденного индекса: response = текст
//     последнего assistant с непустым текстом; costTokens = Σ usage.totalTokens;
//     costUsd = Σ usage.cost.total.
//   • stopReason "error"/"aborted" без валидного <promise>-тега →
//     <promise>FAILED: agent <stopReason>: <reason одной строкой без "<"></promise>.
//   • Single-flight: повторный runAgent при активном pending → немедленный
//     FAILED "runAgent already in flight".
//   • timeout/settle всегда возвращают <promise>FAILED:...</promise> —
//     НИКОГДА пустую строку (пустая → ложный COMPLETE).
//
// Mock fan: on(event, handler) сохраняет handler в Map; sendUserMessage —
// vi.fn(); _emit("agent_end", payload) вызывает handler.
// Формат сообщений: user {role:"user", content}, assistant {role:"assistant",
// content:[{type:"text",text}], usage:{totalTokens, cost:{total}}, stopReason,
// errorMessage?}.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let createDefaultRunAgent;

beforeAll(async () => {
	const mod = await import("../default-run-agent.js");
	createDefaultRunAgent = mod.createDefaultRunAgent;
});

// ─── Mock fan + фабрики сообщений ───────────────────────────────────────────

function makeMockFan(overrides = {}) {
	const hooks = new Map();
	const on = vi.fn((event, handler) => {
		hooks.set(event, handler);
	});
	const sendUserMessage = vi.fn();

	return {
		on,
		sendUserMessage,
		_hooks: hooks,
		/** Эмит события: вызывает зарегистрированный handler и await-ит его. */
		async _emit(event, payload, ctx = {}) {
			const handler = hooks.get(event);
			if (handler) {
				await handler(payload, ctx);
			}
		},
		...overrides,
	};
}

const userMsg = (content) => ({ role: "user", content });

const assistantMsg = ({ text = "", totalTokens = 0, total = 0, stopReason = "stop", errorMessage } = {}) => {
	const msg = {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { totalTokens, cost: { total } },
		stopReason,
	};
	if (errorMessage !== undefined) {
		msg.errorMessage = errorMessage;
	}
	return msg;
};

const agentEnd = (messages) => ({ type: "agent_end", messages });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ─── TC-1: idle-корреляция (messages[0] = наш prompt) ───────────────────────

describe("DEFAULT-RUN-AGENT / TC-1: idle-корреляция и доставка prompt", () => {
	it("TC-1: prompt → sendUserMessage(followUp) → agent_end → response + usage собраны", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("do the thing");

		expect(fan.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fan.sendUserMessage).toHaveBeenCalledWith("do the thing", { deliverAs: "followUp" });

		await fan._emit(
			"agent_end",
			agentEnd([
				userMsg("do the thing"),
				assistantMsg({ text: "done <promise>COMPLETE</promise>", totalTokens: 100, total: 0.5 }),
			]),
		);

		const result = await promise;
		expect(result.response).toBe("done <promise>COMPLETE</promise>");
		expect(result.costTokens).toBe(100);
		expect(result.costUsd).toBe(0.5);
	});

	it("TC-1: при создании регистрируется ровно один agent_end handler", () => {
		const fan = makeMockFan();
		createDefaultRunAgent(fan);

		const agentEndCalls = fan.on.mock.calls.filter((c) => c[0] === "agent_end");
		expect(agentEndCalls.length).toBe(1);
		expect(typeof agentEndCalls[0][1]).toBe("function");
	});
});

// ─── TC-2: busy-корреляция (чужие сообщения до нашего prompt) ───────────────

describe("DEFAULT-RUN-AGENT / TC-2: busy-корреляция", () => {
	it("TC-2: usage суммируется только ПОСЛЕ нашего prompt (чужие assistant игнорируются)", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("our prompt");
		await fan._emit(
			"agent_end",
			agentEnd([
				userMsg("someone else's prompt"),
				assistantMsg({ text: "foreign answer", totalTokens: 999, total: 9 }),
				userMsg("our prompt"),
				assistantMsg({ text: "our answer", totalTokens: 50, total: 0.25 }),
			]),
		);

		const result = await promise;
		expect(result.response).toBe("our answer");
		expect(result.costTokens).toBe(50);
		expect(result.costUsd).toBe(0.25);
	});
});

// ─── TC-3: чужой agent_end (нет нашего prompt) → waiter НЕ резолвится ──────

describe("DEFAULT-RUN-AGENT / TC-3: чужой agent_end игнорируется", () => {
	it("TC-3: agent_end без нашего prompt не резолвит waiter; handler персистентен", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("our prompt");

		// Чужой turn — нашего prompt нет в messages → игнор
		await fan._emit(
			"agent_end",
			agentEnd([userMsg("other prompt"), assistantMsg({ text: "other answer" })]),
		);

		const winner = await Promise.race([
			promise.then(() => "resolved"),
			delay(20).then(() => "pending"),
		]);
		expect(winner).toBe("pending");

		// Handler персистентен: следующий (наш) agent_end резолвит waiter
		await fan._emit(
			"agent_end",
			agentEnd([userMsg("our prompt"), assistantMsg({ text: "our answer", totalTokens: 7, total: 0.07 })]),
		);
		const result = await promise;
		expect(result.response).toBe("our answer");
		expect(result.costTokens).toBe(7);
	});
});

// ─── TC-4: timeout → FAILED-тег ─────────────────────────────────────────────

describe("DEFAULT-RUN-AGENT / TC-4: timeout", () => {
	it("TC-4: timeout (timeoutMs:100) → FAILED-тег, costTokens/costUsd 0, console.warn", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan, { timeoutMs: 100 });

		const promise = runAgent("p");
		await vi.advanceTimersByTimeAsync(100);

		const result = await promise;
		expect(result.response).toBe("<promise>FAILED: runAgent timeout after 100ms</promise>");
		expect(result.costTokens).toBe(0);
		expect(result.costUsd).toBe(0);
		expect(warn).toHaveBeenCalled();
	});

	it("TC-4: agent_end после timeout — no-op (pending очищен, не падает)", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan, { timeoutMs: 100 });

		const promise = runAgent("p");
		await vi.advanceTimersByTimeAsync(100);
		await promise;

		// Поздний agent_end не должен ронять или что-то резолвить
		await fan._emit("agent_end", agentEnd([userMsg("p"), assistantMsg({ text: "late" })]));
	});
});

// ─── TC-5: stopReason error/aborted без <promise>-тега → FAILED ────────────

describe("DEFAULT-RUN-AGENT / TC-5: stopReason error/aborted без promise-тега", () => {
	it("TC-5: stopReason 'error' + errorMessage → FAILED-тег (reason однострочный без '<'); usage сохраняется", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("p");
		await fan._emit(
			"agent_end",
			agentEnd([
				userMsg("p"),
				assistantMsg({
					text: "boom happened",
					stopReason: "error",
					errorMessage: "Provider <500> error\nsecond line",
					totalTokens: 42,
					total: 0.42,
				}),
			]),
		);

		const result = await promise;
		expect(result.response).toBe("<promise>FAILED: agent error: Provider 500> error second line</promise>");
		// Токены были фактически потрачены — usage сохраняется
		expect(result.costTokens).toBe(42);
		expect(result.costUsd).toBe(0.42);
	});

	it("TC-5: stopReason 'aborted' без errorMessage → FAILED-тег с 'unknown'", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("p");
		await fan._emit(
			"agent_end",
			agentEnd([userMsg("p"), assistantMsg({ text: "", stopReason: "aborted" })]),
		);

		const result = await promise;
		expect(result.response).toBe("<promise>FAILED: agent aborted: unknown</promise>");
	});
});

// ─── TC-6: stopReason error, НО есть валидный <promise>-тег → как есть ─────

describe("DEFAULT-RUN-AGENT / TC-6: валидный promise-тег не перезаписывается", () => {
	it("TC-6: stopReason 'error' + response с валидным <promise> тегом → response без изменений", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const original = "partial work <promise>BLOCKED: need access</promise>";
		const promise = runAgent("p");
		await fan._emit(
			"agent_end",
			agentEnd([
				userMsg("p"),
				assistantMsg({ text: original, stopReason: "error", errorMessage: "some failure" }),
			]),
		);

		const result = await promise;
		expect(result.response).toBe(original);
	});
});

// ─── TC-7: single-flight ────────────────────────────────────────────────────

describe("DEFAULT-RUN-AGENT / TC-7: single-flight", () => {
	it("TC-7: второй runAgent при активном pending → немедленный FAILED 'already in flight'", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const first = runAgent("first prompt");
		const second = await runAgent("second prompt");

		expect(second.response).toBe("<promise>FAILED: runAgent already in flight</promise>");
		expect(second.costTokens).toBe(0);
		expect(second.costUsd).toBe(0);
		// Второй prompt НЕ доставлялся в сессию
		expect(fan.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fan.sendUserMessage).toHaveBeenCalledWith("first prompt", { deliverAs: "followUp" });
		expect(warn).toHaveBeenCalled();

		// Завершаем первый waiter, чтобы не оставлять pending
		await fan._emit("agent_end", agentEnd([userMsg("first prompt"), assistantMsg({ text: "ok" })]));
		await first;
	});
});

// ─── TC-8: settle() ─────────────────────────────────────────────────────────

describe("DEFAULT-RUN-AGENT / TC-8: settle", () => {
	it("TC-8: settle резолвит активный pending FAILED-тегом; идемпотентен", async () => {
		const fan = makeMockFan();
		const handle = createDefaultRunAgent(fan);

		const promise = handle.runAgent("p");
		handle.settle("mission shutdown");

		const result = await promise;
		expect(result.response).toBe("<promise>FAILED: mission shutdown</promise>");
		expect(result.costTokens).toBe(0);
		expect(result.costUsd).toBe(0);

		// Повторный settle без pending — no-op, не падает
		expect(() => handle.settle("mission shutdown")).not.toThrow();

		// Поздний agent_end — no-op (pending очищен)
		await fan._emit("agent_end", agentEnd([userMsg("p"), assistantMsg({ text: "late" })]));

		// Следующий runAgent работоспособен (pending снят)
		const next = handle.runAgent("p2");
		expect(fan.sendUserMessage).toHaveBeenCalledTimes(2);
		await fan._emit("agent_end", agentEnd([userMsg("p2"), assistantMsg({ text: "next ok" })]));
		expect((await next).response).toBe("next ok");
	});
});

// ─── TC-9: Σ usage по нескольким assistant ──────────────────────────────────

describe("DEFAULT-RUN-AGENT / TC-9: агрегация usage", () => {
	it("TC-9: 2 assistant-сообщения → Σ totalTokens и Σ cost.total; response = последний непустой текст", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("p");
		await fan._emit(
			"agent_end",
			agentEnd([
				userMsg("p"),
				assistantMsg({ text: "step 1", totalTokens: 100, total: 0.1 }),
				{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false },
				assistantMsg({ text: "step 2 <promise>COMPLETE</promise>", totalTokens: 250, total: 0.4 }),
			]),
		);

		const result = await promise;
		expect(result.response).toBe("step 2 <promise>COMPLETE</promise>");
		expect(result.costTokens).toBe(350);
		expect(result.costUsd).toBeCloseTo(0.5, 10);
	});
});

// ─── TC-10: content как array TextContent ───────────────────────────────────

describe("DEFAULT-RUN-AGENT / TC-10: нормализация content-массивов", () => {
	it("TC-10: user content array (join TextContent) матчит prompt; assistant TextContent конкатенируются", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("part1 part2");
		await fan._emit(
			"agent_end",
			agentEnd([
				{ role: "user", content: [{ type: "text", text: "part1 " }, { type: "text", text: "part2" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden reasoning" },
						{ type: "text", text: "a" },
						{ type: "toolCall", id: "c1", name: "read", arguments: {} },
						{ type: "text", text: "b" },
					],
					usage: { totalTokens: 11, cost: { total: 0.11 } },
					stopReason: "stop",
				},
			]),
		);

		const result = await promise;
		expect(result.response).toBe("ab");
		expect(result.costTokens).toBe(11);
	});
});

// ─── TC-11: sendUserMessage throw → не роняет, FAILED, pending снят ────────

describe("DEFAULT-RUN-AGENT / TC-11: sendUserMessage выбрасывает", () => {
	it("TC-11: throw в sendUserMessage → FAILED-тег; следующий runAgent работоспособен", async () => {
		const fan = makeMockFan({
			sendUserMessage: vi.fn(() => {
				throw new Error("session unavailable");
			}),
		});
		const { runAgent } = createDefaultRunAgent(fan);

		const result = await runAgent("p");
		expect(result.response).toBe("<promise>FAILED: sendUserMessage failed: session unavailable</promise>");
		expect(result.costTokens).toBe(0);
		expect(result.costUsd).toBe(0);

		// pending снят — следующий вызов доставляется и резолвится
		fan.sendUserMessage.mockImplementation(() => {});
		const next = runAgent("p2");
		await fan._emit("agent_end", agentEnd([userMsg("p2"), assistantMsg({ text: "recovered" })]));
		expect((await next).response).toBe("recovered");
	});
});

// ─── TC-12: корреляция по ПОСЛЕДНему вхождению prompt ──────────────────────

describe("DEFAULT-RUN-AGENT / TC-12: последнее вхождение prompt", () => {
	it("TC-12: при нескольких одинаковых user-сообщениях берётся ПОСЛЕДНИЙ индекс", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("p");
		await fan._emit(
			"agent_end",
			agentEnd([
				userMsg("p"),
				assistantMsg({ text: "old answer", totalTokens: 10, total: 0.01 }),
				userMsg("p"),
				assistantMsg({ text: "new answer", totalTokens: 20, total: 0.02 }),
			]),
		);

		const result = await promise;
		expect(result.response).toBe("new answer");
		expect(result.costTokens).toBe(20);
		expect(result.costUsd).toBe(0.02);
	});
});

// ─── TC-13: нет assistant-текста после prompt → FAILED (не пустая строка) ──

describe("DEFAULT-RUN-AGENT / TC-13: пустой результат невозможен", () => {
	it("TC-13: нет assistant-сообщений после prompt → FAILED-тег вместо пустой строки", async () => {
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan);

		const promise = runAgent("p");
		await fan._emit("agent_end", agentEnd([userMsg("p")]));

		const result = await promise;
		expect(result.response).toBe("<promise>FAILED: agent returned empty response</promise>");
		expect(result.costTokens).toBe(0);
	});
});

// ─── TC-14: agent_end без pending → no-op ───────────────────────────────────

describe("DEFAULT-RUN-AGENT / TC-14: agent_end без активного waiter", () => {
	it("TC-14: agent_end до/без runAgent не падает (handler читает pending === null)", async () => {
		const fan = makeMockFan();
		createDefaultRunAgent(fan);

		await fan._emit("agent_end", agentEnd([userMsg("x"), assistantMsg({ text: "y" })]));
		await fan._emit("agent_end", agentEnd([]));
		await fan._emit("agent_end", { type: "agent_end" }); // messages отсутствует
	});
});

// ─── TC-15: дефолтный timeout 30 мин; агент успевает раньше ────────────────

describe("DEFAULT-RUN-AGENT / TC-15: дефолтный таймаут", () => {
	it("TC-15: agent_end до истечения дефолтных 30 мин резолвит waiter (таймер снят)", async () => {
		vi.useFakeTimers();
		const fan = makeMockFan();
		const { runAgent } = createDefaultRunAgent(fan); // timeoutMs по умолчанию

		const promise = runAgent("p");
		await vi.advanceTimersByTimeAsync(1_799_999); // почти 30 мин

		await fan._emit(
			"agent_end",
			agentEnd([userMsg("p"), assistantMsg({ text: "made it", totalTokens: 5, total: 0.05 })]),
		);

		const result = await promise;
		expect(result.response).toBe("made it");
		expect(result.costTokens).toBe(5);

		// Дополнительное время после резолва не вызывает timeout-срабатывания
		await vi.advanceTimersByTimeAsync(1_000_000);
	});
});
