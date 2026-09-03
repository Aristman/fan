// Тесты: per-step timeout runAgent УБРАН (hard-remove runagent_timeout_min).
// Гарантии:
//   1. runAgent НИКОГДА не ставит setTimeout (нет таймера на прогон).
//   2. settle() (shutdown/pause) по-прежнему осаждает активный waiter
//      FAILED-тегом — контракт сохранён.
//
// Запуск: npx vitest run bundles/fan-mission/extensions/fan-mission/runagent-no-timeout.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultRunAgent } from "./default-run-agent.js";

/** Минимальный mock ExtensionAPI: перехват followUp-промптов, без таймеров. */
function makeFan(): { fan: any; sent: string[] } {
	const sent: string[] = [];
	const fan = {
		on: () => {},
		sendUserMessage: (prompt: string) => {
			sent.push(prompt);
		},
	} as any;
	return { fan, sent };
}

describe("runAgent has no per-step timeout", () => {
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});
	afterEach(() => {
		setTimeoutSpy.mockRestore();
	});

	it("runAgent never schedules setTimeout", async () => {
		const { fan } = makeFan();
		const handle = createDefaultRunAgent(fan);

		const resultPromise = handle.runAgent("test prompt");

		// Ни один таймер не должен ставиться — per-step timeout удалён.
		expect(setTimeoutSpy).not.toHaveBeenCalled();

		handle.settle("test cleanup");
		const result = await resultPromise;
		expect(result.response).toBe("<promise>FAILED: test cleanup</promise>");
	});

	it("settle resolves the active pending waiter with FAILED tag (shutdown contract)", async () => {
		const { fan, sent } = makeFan();
		const handle = createDefaultRunAgent(fan);

		const resultPromise = handle.runAgent("iteration prompt");
		expect(sent).toEqual(["iteration prompt"]); // followUp ушёл ДО settle

		handle.settle("mission shutdown");
		const result = await resultPromise;
		expect(result.response).toBe("<promise>FAILED: mission shutdown</promise>");
		expect(result.costTokens).toBe(0);
		expect(result.costUsd).toBe(0);
	});

	it("settle is idempotent; a fresh runAgent works after settle", async () => {
		const { fan } = makeFan();
		const handle = createDefaultRunAgent(fan);

		const first = handle.runAgent("first");
		handle.settle("first settle");
		await first;

		// Повторный settle без активного waiter — no-op (идемпотентность).
		expect(() => handle.settle("no pending")).not.toThrow();

		// Новый прогон после settle работоспособен.
		const second = handle.runAgent("second");
		handle.settle("second settle");
		const result = await second;
		expect(result.response).toBe("<promise>FAILED: second settle</promise>");
	});
});
