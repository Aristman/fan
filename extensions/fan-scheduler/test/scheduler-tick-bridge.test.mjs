// F-14 (ТИКЕТ-14): auto-tick мост — сторона fan-scheduler.
//
// Контракт:
//   1. startScheduler с actions.onTick → onTick вызван с {missionDir, date,
//      prompt}, sendMessage НЕ вызван (программный мост приоритетнее).
//   2. startScheduler БЕЗ onTick → sendMessage вызван (старое поведение).
//   3. wireScheduler: opts.onTick пробрасывается в actions.
//   4. Фабрика с fan.events (прод) → тик эмитит "mission_tick" с
//      { missionDir (детектор), ts, tickId }; sendUserMessage НЕ вызван.
//   5. Фабрика с mock fan БЕЗ events → legacy-путь (sendUserMessage).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let startScheduler;
let wireScheduler;
let factory;

beforeAll(async () => {
	const sched = await import("../scheduler.js");
	startScheduler = sched.startScheduler;
	const idx = await import("../index.js");
	wireScheduler = idx.wireScheduler;
	factory = idx.default;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ─── Хелперы ────────────────────────────────────────────────────────────────

/** Tempdir с активной миссией docs/missions/m1 (для детектора фабрики). */
function makeActiveMissionTmp() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-scheduler-bridge-"));
	const missionDir = join(tmp, "docs", "missions", "m1");
	mkdirSync(missionDir, { recursive: true });
	writeFileSync(join(missionDir, "MISSION.md"), "---\nstatus: active\n---\n", "utf8");
	return { tmp, missionDir };
}

/** Mock fan: хуки fan.on + sendUserMessage; withEvents → добавляет events. */
function makeMockFan(withEvents = false) {
	const hooks = new Map();
	const fan = {
		on: vi.fn((event, handler) => {
			hooks.set(event, handler);
		}),
		sendUserMessage: vi.fn(),
		async _emit(event, ...args) {
			const handler = hooks.get(event);
			if (handler) {
				await handler(...args);
			}
		},
	};
	if (withEvents) {
		fan.events = {
			emit: vi.fn(),
			on: vi.fn(() => () => {}),
		};
	}
	return fan;
}

// ─── 1. startScheduler: actions.onTick приоритетнее sendMessage ─────────────

describe("F-14 / scheduler-tick-bridge: startScheduler onTick", () => {
	it("TC-B1: actions.onTick задан → onTick вызван с {missionDir,date,prompt}, sendMessage НЕ вызван", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		const onTick = vi.fn();
		const sendMessage = vi.fn();
		const handle = startScheduler({
			actions: { sendMessage, onTick },
			getStatus: () => "active",
			getMissionDir: () => "/tmp/bridge-m1",
			tickPrompt: "Тик в {missionDir}, дата: {date}",
			intervalMs: 1000,
		});
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(onTick).toHaveBeenCalledTimes(1);
			expect(sendMessage).not.toHaveBeenCalled();
			const payload = onTick.mock.calls[0][0];
			expect(payload.missionDir).toBe("/tmp/bridge-m1");
			expect(payload.date).toMatch(/2026-08-12/);
			expect(payload.prompt).toContain("/tmp/bridge-m1");
			expect(payload.prompt).not.toMatch(/\{missionDir\}/);
			expect(payload.prompt).not.toMatch(/\{date\}/);
		} finally {
			handle.stop();
		}
	});

	it("TC-B2: actions БЕЗ onTick → sendMessage вызван (старое поведение)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		const sendMessage = vi.fn();
		const handle = startScheduler({
			actions: { sendMessage },
			getStatus: () => "active",
			getMissionDir: () => "/tmp/bridge-m2",
			tickPrompt: "tick {date}",
			intervalMs: 1000,
		});
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("2026-08-12"), "followUp");
		} finally {
			handle.stop();
		}
	});

	it("TC-B3: status !== active → ни onTick, ни sendMessage не вызываются", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		const onTick = vi.fn();
		const sendMessage = vi.fn();
		const handle = startScheduler({
			actions: { sendMessage, onTick },
			getStatus: () => "paused",
			getMissionDir: () => "/tmp/bridge-m3",
			tickPrompt: "tick {date}",
			intervalMs: 1000,
		});
		try {
			await vi.advanceTimersByTimeAsync(1100);
			expect(onTick).not.toHaveBeenCalled();
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			handle.stop();
		}
	});
});

// ─── 2. wireScheduler: проброс opts.onTick ──────────────────────────────────

describe("F-14 / scheduler-tick-bridge: wireScheduler onTick pass-through", () => {
	it("TC-B4: opts.onTick → вызывается вместо fan.sendUserMessage", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		const fan = makeMockFan();
		const onTick = vi.fn();
		const wiring = wireScheduler(fan, {
			intervalMs: 5,
			getMissionDir: () => "/missions/wire",
			onTick,
		});
		try {
			wiring.start();
			await vi.advanceTimersByTimeAsync(20);
			expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(1);
			expect(onTick.mock.calls[0][0].missionDir).toBe("/missions/wire");
			expect(fan.sendUserMessage).not.toHaveBeenCalled();
		} finally {
			wiring.stop();
		}
	});
});

// ─── 3. Фабрика: feature-detected EventBus-мост vs legacy ───────────────────

describe("F-14 / scheduler-tick-bridge: фабрика (mission_tick / legacy)", () => {
	it("TC-B5: fan С events → emit('mission_tick') с missionDir детектора + ts + tickId; sendUserMessage НЕ вызван", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		const { tmp, missionDir } = makeActiveMissionTmp();
		try {
			const fan = makeMockFan(true);
			factory(fan);
			await fan._emit("session_start", { type: "session_start" }, { cwd: tmp });

			await vi.advanceTimersByTimeAsync(65_000); // 1 тик на дефолтном интервале (60s)

			expect(fan.events.emit).toHaveBeenCalledTimes(1);
			const [channel, payload] = fan.events.emit.mock.calls[0];
			expect(channel).toBe("mission_tick");
			expect(payload.missionDir).toBe(missionDir);
			expect(typeof payload.ts).toBe("number");
			expect(typeof payload.tickId).toBe("string");
			expect(payload.tickId.length).toBeGreaterThan(0);
			expect(fan.sendUserMessage).not.toHaveBeenCalled();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
			vi.useRealTimers();
		}
	});

	it("TC-B6: fan БЕЗ events → legacy-путь (sendUserMessage), падения нет", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-12T10:00:00Z"));
		const { tmp } = makeActiveMissionTmp();
		try {
			const fan = makeMockFan(false); // без events — как в index-wiring.test.mjs
			factory(fan);
			await fan._emit("session_start", { type: "session_start" }, { cwd: tmp });

			await vi.advanceTimersByTimeAsync(310_000);

			expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
			expect(fan.sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "followUp" });
		} finally {
			rmSync(tmp, { recursive: true, force: true });
			vi.useRealTimers();
		}
	});
});
