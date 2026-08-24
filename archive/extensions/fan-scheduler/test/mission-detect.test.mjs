// Фикс fan-scheduler: самодостаточный детектор активной миссии.
//
// Контракт (index.ts):
//   export readMissionStatus(missionDir) — status из frontmatter MISSION.md.
//   export findActiveMission(cwd) — первая не-терминальная миссия в
//     <cwd>/docs/missions/ (терминальные: completed/aborted/failed/…).
//   default factory(fan) — дефолтный getStatus/getMissionDir через детектор:
//     нет миссии → "completed" → холостые тики НЕ отправляются; есть active →
//     тик с реальным {missionDir}.
//
// Фабрика тестируется через mock fan (on/sendUserMessage) как в
// index-wiring.test.mjs: emit session_start с ctx {cwd}, реальный startScheduler
// под vi.useFakeTimers() (дефолт intervalMs 60000 → advance 310000 мс = 5 тиков).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let readMissionStatus;
let findActiveMission;
let factory;

beforeAll(async () => {
	const mod = await import("../index.js");
	readMissionStatus = mod.readMissionStatus;
	findActiveMission = mod.findActiveMission;
	factory = mod.default;
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers: tempdir с MISSION.md (frontmatter status) + mock fan.
// ────────────────────────────────────────────────────────────────────────────

const tempDirs = [];

function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "fan-scheduler-detect-"));
	tempDirs.push(dir);
	return dir;
}

/** Создаёт <base>/docs/missions/<name>/MISSION.md с frontmatter status. */
function writeMission(base, name, status) {
	const missionDir = join(base, "docs", "missions", name);
	mkdirSync(missionDir, { recursive: true });
	writeFileSync(
		join(missionDir, "MISSION.md"),
		`---\nstatus: ${status}\ntitle: Mission ${name}\n---\n\n# Mission ${name}\n`,
		"utf8",
	);
	return missionDir;
}

function makeMockFan() {
	const hooks = new Map();
	const on = vi.fn((event, handler) => {
		hooks.set(event, handler);
	});
	const sendUserMessage = vi.fn();
	return {
		on,
		sendUserMessage,
		_hooks: hooks,
		async _emit(event, ...args) {
			const handler = hooks.get(event);
			if (handler) {
				await handler(...args);
			}
		},
	};
}

afterEach(async () => {
	vi.useRealTimers();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore — tempdir cleanup best-effort
		}
	}
});

// ────────────────────────────────────────────────────────────────────────────
// 1. readMissionStatus
// ────────────────────────────────────────────────────────────────────────────

describe("mission-detect: readMissionStatus", () => {
	it("MISSION.md со status: active → \"active\"", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "MISSION.md"), "---\nstatus: active\ntitle: X\n---\nbody\n", "utf8");
		expect(readMissionStatus(dir)).toBe("active");
	});

	it("MISSION.md без frontmatter → null", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "MISSION.md"), "просто текст без frontmatter\n", "utf8");
		expect(readMissionStatus(dir)).toBeNull();
	});

	it("нет файла MISSION.md → null", () => {
		const dir = makeTempDir();
		expect(readMissionStatus(dir)).toBeNull();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 2. findActiveMission
// ────────────────────────────────────────────────────────────────────────────

describe("mission-detect: findActiveMission", () => {
	it("docs/missions/foo/MISSION.md (status: active) → { dir, status: \"active\" }", () => {
		const cwd = makeTempDir();
		const missionDir = writeMission(cwd, "foo", "active");
		expect(findActiveMission(cwd)).toEqual({ dir: missionDir, status: "active" });
	});

	it("пустой tempdir (нет docs/missions) → null", () => {
		const cwd = makeTempDir();
		expect(findActiveMission(cwd)).toBeNull();
	});

	it("миссия со status: completed (терминальная) → null", () => {
		const cwd = makeTempDir();
		writeMission(cwd, "done", "completed");
		expect(findActiveMission(cwd)).toBeNull();
	});

	it("R3: completed + RECURRING.md с unchecked-пунктами → возвращается (дежурство)", () => {
		const cwd = makeTempDir();
		const missionDir = writeMission(cwd, "duty", "completed");
		writeFileSync(join(missionDir, "RECURRING.md"), "- [ ] Check feed (interval: 30m)\n", "utf8");
		expect(findActiveMission(cwd)).toEqual({ dir: missionDir, status: "completed" });
	});

	it("R3: completed + пустой RECURRING.md → null", () => {
		const cwd = makeTempDir();
		const missionDir = writeMission(cwd, "duty", "completed");
		writeFileSync(join(missionDir, "RECURRING.md"), "# Recurring\n\n(empty)\n", "utf8");
		expect(findActiveMission(cwd)).toBeNull();
	});

	it("R3: completed + header-only RECURRING.md ('## Text (interval: 15m)') → возвращается (дежурство)", () => {
		const cwd = makeTempDir();
		const missionDir = writeMission(cwd, "duty", "completed");
		writeFileSync(
			join(missionDir, "RECURRING.md"),
			"## Прогон gmail-watch (interval: 15m)\n\nПроцедура: прочитай почту и ответь.\n",
			"utf8",
		);
		expect(findActiveMission(cwd)).toEqual({ dir: missionDir, status: "completed" });
	});

	it("R3: active-миссия приоритетнее completed-дежурной", () => {
		const cwd = makeTempDir();
		const dutyDir = writeMission(cwd, "aaa-duty", "completed");
		writeFileSync(join(dutyDir, "RECURRING.md"), "- [ ] Duty\n", "utf8");
		const activeDir = writeMission(cwd, "zzz-active", "active");
		expect(findActiveMission(cwd)).toEqual({ dir: activeDir, status: "active" });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 3-4. factory: getStatus / getMissionDir через поведение тиков.
// Реальный startScheduler под fake timers; дефолт intervalMs 60000 →
// advance 310000 мс даёт 5 возможностей тика.
// ────────────────────────────────────────────────────────────────────────────

describe("mission-detect: фабрика (getStatus/getMissionDir через тики)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-14T10:00:00Z"));
	});

	it("3a: session_start ctx.cwd БЕЗ миссии → getStatus \"completed\" → тиков нет", async () => {
		const fan = makeMockFan();
		const cwd = makeTempDir(); // пустой каталог, миссий нет
		try {
			factory(fan);
			await fan._emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

			await vi.advanceTimersByTimeAsync(310_000);
			expect(fan.sendUserMessage).not.toHaveBeenCalled();
		} finally {
			await fan._emit("session_shutdown", { type: "session_shutdown" });
		}
	});

	it("3b: session_start ctx.cwd с активной миссией → getStatus \"active\" → тик доставлен", async () => {
		const fan = makeMockFan();
		const cwd = makeTempDir();
		writeMission(cwd, "foo", "active");
		try {
			factory(fan);
			await fan._emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

			await vi.advanceTimersByTimeAsync(310_000);
			expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
			expect(fan.sendUserMessage).toHaveBeenCalledWith(
				expect.any(String),
				{ deliverAs: "followUp" },
			);
		} finally {
			await fan._emit("session_shutdown", { type: "session_shutdown" });
		}
	});

	it("4a: с миссией → {missionDir} в тике = путь к каталогу миссии", async () => {
		const fan = makeMockFan();
		const cwd = makeTempDir();
		const missionDir = writeMission(cwd, "foo", "active");
		try {
			factory(fan);
			await fan._emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

			await vi.advanceTimersByTimeAsync(310_000);
			expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
			const text = fan.sendUserMessage.mock.calls[0][0];
			expect(text).toContain(missionDir);
			expect(text).not.toMatch(/\{missionDir\}/);
		} finally {
			await fan._emit("session_shutdown", { type: "session_shutdown" });
		}
	});

	it("4b: без миссии → getMissionDir пустой (тик не доставляется вообще)", async () => {
		// Без миссии getStatus возвращает "completed" ДО вызова getMissionDir,
		// поэтому наблюдаемое поведение — отсутствие тика ("" не доставляется).
		const fan = makeMockFan();
		const cwd = makeTempDir();
		try {
			factory(fan);
			await fan._emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

			await vi.advanceTimersByTimeAsync(620_000); // 2 интервала — тиков нет вовсе
			expect(fan.sendUserMessage).not.toHaveBeenCalled();
		} finally {
			await fan._emit("session_shutdown", { type: "session_shutdown" });
		}
	});

	it("R3: session_start с completed-миссией на дежурстве (RECURRING.md) → тик доставлен", async () => {
		const fan = makeMockFan();
		const cwd = makeTempDir();
		const missionDir = writeMission(cwd, "duty", "completed");
		writeFileSync(join(missionDir, "RECURRING.md"), "- [ ] Duty item (interval: 30m)\n", "utf8");
		try {
			factory(fan);
			await fan._emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

			await vi.advanceTimersByTimeAsync(65_000); // 1 тик на дефолтном интервале (60s)
			expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
			expect(fan.sendUserMessage.mock.calls[0][0]).toContain(missionDir);
		} finally {
			await fan._emit("session_shutdown", { type: "session_shutdown" });
		}
	});

	it("R3: session_start с completed-миссией БЕЗ RECURRING.md → тиков нет", async () => {
		const fan = makeMockFan();
		const cwd = makeTempDir();
		writeMission(cwd, "done", "completed");
		try {
			factory(fan);
			await fan._emit("session_start", { type: "session_start", reason: "startup" }, { cwd });

			await vi.advanceTimersByTimeAsync(310_000);
			expect(fan.sendUserMessage).not.toHaveBeenCalled();
		} finally {
			await fan._emit("session_shutdown", { type: "session_shutdown" });
		}
	});
});
