// F-14 (ТИКЕТ-14): auto-tick мост — сторона fan-mission (tick-bridge.ts).
//
// Контракт createMissionTickHandler(deps) → { handler, dispose }:
//   1. Replay-guard: ev.ts <= armedAt (момент создания) → игнор
//      (EventBus реплеит последнее событие новому подписчику).
//   2. Dedupe: повторный ev.tickId → игнор.
//   3. getLoop() === null → игнор (+ log).
//   4. ev.missionDir задан и !== getMissionDir() → игнор.
//   5. tick() вызывается DETACHED: handler сразу возвращает undefined;
//      "Lock is busy" в reject → log (штатно), иное → console.error.
//   6. dispose() → handler игнорирует события.

import { beforeAll, describe, expect, it, vi } from "vitest";

let createMissionTickHandler;

beforeAll(async () => {
	const mod = await import("../tick-bridge.js");
	createMissionTickHandler = mod.createMissionTickHandler;
});

/** Ожидание микрозадач + macrotask — для settle detached promise-ов. */
function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Stub MissionLoop: только tick(). */
function makeLoop(tickImpl) {
	return { tick: vi.fn(tickImpl ?? (() => Promise.resolve({ status: "active" }))) };
}

/** Deps с инжектированными часами (clock стартует с 1000). */
function makeDeps(overrides = {}) {
	const state = { clock: 1000 };
	const deps = {
		state,
		getLoop: overrides.getLoop ?? (() => overrides.loop ?? null),
		getMissionDir: overrides.getMissionDir ?? (() => overrides.missionDir),
		now: () => state.clock,
		log: overrides.log ?? vi.fn(),
	};
	return deps;
}

describe("F-14 / tick-bridge: guards", () => {
	it("TC-T1: replay — ev.ts <= armedAt → tick НЕ вызван", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/m" });
		const { handler } = createMissionTickHandler(deps); // armedAt = 1000
		handler({ missionDir: "/m", ts: 999, tickId: "t-old-1" });
		handler({ missionDir: "/m", ts: 1000, tickId: "t-old-2" }); // граница включительно
		expect(loop.tick).not.toHaveBeenCalled();
	});

	it("TC-T2: ev.ts > armedAt → tick вызван; событие без ts тоже проходит", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/m" });
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "t-new" });
		expect(loop.tick).toHaveBeenCalledTimes(1);
		handler({ missionDir: "/m" }); // без ts — replay-guard не применяется
		expect(loop.tick).toHaveBeenCalledTimes(2);
	});

	it("TC-T3: dedupe — повторный tickId игнорируется, новый проходит", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/m" });
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "dup" });
		handler({ missionDir: "/m", ts: 1002, tickId: "dup" }); // дубль
		expect(loop.tick).toHaveBeenCalledTimes(1);
		handler({ missionDir: "/m", ts: 1003, tickId: "other" });
		expect(loop.tick).toHaveBeenCalledTimes(2);
	});

	it("TC-T4: loop null → tick не вызван, log записан", () => {
		const deps = makeDeps({ getLoop: () => null, missionDir: "/m" });
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "t-null" });
		expect(deps.log).toHaveBeenCalled();
	});

	it("TC-T5: чужой missionDir → tick НЕ вызван", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/mine" });
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/foreign", ts: 1001, tickId: "t-x" });
		expect(loop.tick).not.toHaveBeenCalled();
	});

	it("TC-T6: свой missionDir → tick вызван", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/mine" });
		const { handler } = createMissionTickHandler(deps);
		handler({ missionDir: "/mine", ts: 1001, tickId: "t-own" });
		expect(loop.tick).toHaveBeenCalledTimes(1);
	});

	it("TC-T7: missionDir не задан в событии → tick вызван (broadcast)", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/mine" });
		const { handler } = createMissionTickHandler(deps);
		handler({ ts: 1001, tickId: "t-broadcast" });
		expect(loop.tick).toHaveBeenCalledTimes(1);
	});

	it("TC-T8: мусорный пейлоад (не объект) → тихий игнор", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/m" });
		const { handler } = createMissionTickHandler(deps);
		expect(() => handler(null)).not.toThrow();
		expect(() => handler("str")).not.toThrow();
		expect(loop.tick).not.toHaveBeenCalled();
	});
});

describe("F-14 / tick-bridge: detached tick + error handling", () => {
	it("TC-T9: handler возвращает undefined сразу (detached), tick вызван синхронно", async () => {
		let resolveTick;
		const loop = makeLoop(() => new Promise((r) => (resolveTick = r)));
		const deps = makeDeps({ loop, missionDir: "/m" });
		const { handler } = createMissionTickHandler(deps);
		const ret = handler({ missionDir: "/m", ts: 1001, tickId: "t-detached" });
		expect(ret).toBeUndefined(); // не promise — handler синхронный
		expect(loop.tick).toHaveBeenCalledTimes(1);
		resolveTick({ status: "active" }); // разблокировать pending promise
		await flush();
	});

	it("TC-T10: reject 'Lock is busy' → log (штатно), НЕ console.error", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const loop = makeLoop(() => Promise.reject(new Error("Lock is busy — concurrent tick not allowed")));
			const deps = makeDeps({ loop, missionDir: "/m" });
			const { handler } = createMissionTickHandler(deps);
			handler({ missionDir: "/m", ts: 1001, tickId: "t-busy" });
			await flush();
			expect(errSpy).not.toHaveBeenCalled();
			expect(deps.log).toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});

	it("TC-T11: reject с иной ошибкой → console.error", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const loop = makeLoop(() => Promise.reject(new Error("executor exploded")));
			const deps = makeDeps({ loop, missionDir: "/m" });
			const { handler } = createMissionTickHandler(deps);
			handler({ missionDir: "/m", ts: 1001, tickId: "t-err" });
			await flush();
			expect(errSpy).toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});

	it("TC-T12: dispose() → последующие события игнорируются", () => {
		const loop = makeLoop();
		const deps = makeDeps({ loop, missionDir: "/m" });
		const { handler, dispose } = createMissionTickHandler(deps);
		handler({ missionDir: "/m", ts: 1001, tickId: "t-pre" });
		expect(loop.tick).toHaveBeenCalledTimes(1);
		dispose();
		handler({ missionDir: "/m", ts: 1002, tickId: "t-post" });
		expect(loop.tick).toHaveBeenCalledTimes(1); // без изменений
	});
});
