// S5 (ralph-loop): wiring fresh-ротации в fan-mission/index.ts.
//
// Дизайн: docs/research/ralph-loop-mission-mode.md §4.2 (поток ротации).
//
// Контракты (S5):
//   1. deps.sessionRotator.rotate() → rotatingGuard=true → fan.newSession({
//      parentSession: <текущий sessionFile из opts.getSessionFile / ctx> }) →
//      вернуть {cancelled} как есть. Хост без биндинга newSession →
//      {cancelled:true} (fail-safe, как loader default).
//   2. session_shutdown с rotatingGuard → лёгкая очистка (unsubTick,
//      bridge.dispose) БЕЗ detach/abort — миссия НЕ aborted, loop не очищен.
//      Без guard — прежнее поведение (shutdown → abort → status aborted).
//   3. session_start после attach: .mission-loop.json.resumeAfterRotation ===
//      true → сброс флага ДО tick (writeLoopStateSync false) → setTimeout(
//      loop.tick, 0). Без флага — auto-tick нет.
//
// Паттерн — index-wiring.test.mjs (makeMockFan + реальная initMission-миссия);
// успешные tick'и требуют git init в tempdir (wireMission использует
// production createGitAdapter — commit бросает вне git-репо).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readMission } from "../file-state-manager.js";
import { readMissionLoopState } from "../mission-loop.js";

let wireMission;
let factory;

beforeAll(async () => {
	const mod = await import("../index.js");
	wireMission = mod.wireMission;
	factory = mod.default;
});

// ─── Helpers (паттерн index-wiring.test.mjs) ────────────────────────────────

function makeMockFan(overrides = {}) {
	const hooks = new Map();
	const on = vi.fn((event, handler) => {
		hooks.set(event, handler);
	});

	const commands = new Map();
	const registerCommand = vi.fn((name, def) => {
		commands.set(name, def);
	});

	const shortcuts = new Map();
	const registerShortcut = vi.fn((key, def) => {
		shortcuts.set(key, def);
	});

	const sendUserMessage = vi.fn();
	const eventsOn = vi.fn();
	const eventsOff = vi.fn();
	const appendEntry = vi.fn();
	const getCustomEntries = vi.fn(() => []);
	// S5: fail-safe default — как loader default ({cancelled:true}).
	const newSession = vi.fn().mockResolvedValue({ cancelled: true });
	const setSessionName = vi.fn();

	return {
		on,
		registerCommand,
		registerShortcut,
		sendUserMessage,
		events: { on: eventsOn, off: eventsOff },
		appendEntry,
		getCustomEntries,
		newSession,
		setSessionName,
		_hooks: hooks,
		_commands: commands,
		_shortcuts: shortcuts,
		async _emit(event, ...args) {
			const handler = hooks.get(event);
			if (handler) {
				await handler(...args);
			}
		},
		...overrides,
	};
}

function makeMockRunAgent() {
	return vi.fn().mockResolvedValue({
		response: "<promise>COMPLETE</promise>",
		costTokens: 10,
		costUsd: 0.01,
	});
}

/**
 * Реальная миссия (default template → session_mode: fresh, S2) с roadmap из
 * `items` unchecked-пунктов. gitInit=true → git-репо в baseDir (production
 * git-adapter в wireMission делает реальный commit на шаге 6).
 */
async function makeTempMission(slug, { items = ["step one", "step two"], gitInit = false } = {}) {
	const baseDir = mkdtempSync(join(tmpdir(), "fan-mission-s5-"));
	const missionDir = await initMission(slug, { baseDir: join(baseDir, "docs", "missions") });
	writeFileSync(
		join(missionDir, "ROADMAP.md"),
		`# Roadmap\n\n${items.map((i) => `- [ ] ${i}`).join("\n")}\n`,
		"utf8",
	);
	if (gitInit) {
		execFileSync("git", ["init"], { cwd: baseDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "s5@test.local"], { cwd: baseDir });
		execFileSync("git", ["config", "user.name", "S5 Test"], { cwd: baseDir });
	}
	return { baseDir, missionDir };
}

/** Записать .mission-loop.json (мерж с текущим состоянием на диске). */
async function writeLoopState(missionDir, patch) {
	const state = await readMissionLoopState(missionDir);
	Object.assign(state, patch);
	writeFileSync(join(missionDir, ".mission-loop.json"), JSON.stringify(state, null, 2), "utf8");
}

/** Ждать, пока условие станет true (poll 10ms, до ~2с). */
async function waitFor(cond) {
	for (let i = 0; i < 200 && !cond(); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * Довести tick с дефолтным runAgent до COMPLETE: дождаться prompt'а через
 * sendUserMessage и ответить agent_end с валидным <promise>COMPLETE</promise>.
 */
async function completeDefaultRunAgentTurn(fan) {
	await waitFor(() => fan.sendUserMessage.mock.calls.length > 0);
	expect(fan.sendUserMessage.mock.calls.length).toBeGreaterThan(0);
	const prompt = fan.sendUserMessage.mock.calls[0][0];
	await fan._emit("agent_end", {
		type: "agent_end",
		messages: [
			{ role: "user", content: prompt },
			{
				role: "assistant",
				content: [{ type: "text", text: "<promise>COMPLETE</promise>" }],
				usage: { totalTokens: 10, cost: { total: 0.01 } },
			},
		],
	});
}

const liveWirings = [];
const liveTempDirs = [];

afterEach(async () => {
	while (liveWirings.length > 0) {
		const w = liveWirings.pop();
		try {
			await w.shutdown();
		} catch {
			// ignore
		}
	}
	while (liveTempDirs.length > 0) {
		const d = liveTempDirs.pop();
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

// ─── S5: sessionRotator в deps (wireMission) ────────────────────────────────

describe("S5 / rotator wiring: rotate() → fan.newSession", () => {
	it("rotate вызывает fan.newSession с parentSession из opts.getSessionFile; guard снят после", async () => {
		const { baseDir, missionDir } = await makeTempMission("s5-rotator", { gitInit: true });
		liveTempDirs.push(baseDir);

		const newSession = vi.fn().mockResolvedValue({ cancelled: false });
		const fan = makeMockFan({ newSession });
		const wiring = wireMission(fan, {
			runAgent: makeMockRunAgent(),
			getSessionFile: () => "/sessions/s0.jsonl",
		});
		liveWirings.push(wiring);

		const loop = wiring.attachMission(missionDir);
		const result = await loop.tick();

		// fresh: одна итерация за tick, затем ротация (осталась работа)
		expect(result.itemsExecuted).toBe(1);
		expect(newSession).toHaveBeenCalledTimes(1);
		expect(newSession).toHaveBeenCalledWith({ parentSession: "/sessions/s0.jsonl" });
		// guard снят после завершения rotate (finally)
		expect(wiring.isRotating()).toBe(false);
		// S3-контракт: при успехе loop флаг НЕ снимает — это зона session_start
		// новой сессии (в этом тесте не эмулируется).
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBe(true);
		// Миссия не пострадала от ротации
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");
	});

	it("cancelled → loop сам снимает флаг и деградирует в persistent (S3-контракт, интеграция)", async () => {
		const { baseDir, missionDir } = await makeTempMission("s5-cancelled", {
			items: ["task A", "task B", "task C"],
			gitInit: true,
		});
		liveTempDirs.push(baseDir);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const newSession = vi.fn().mockResolvedValue({ cancelled: true });
		const fan = makeMockFan({ newSession });
		const wiring = wireMission(fan, { runAgent: makeMockRunAgent() });
		liveWirings.push(wiring);

		const loop = wiring.attachMission(missionDir);

		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		expect(newSession).toHaveBeenCalledTimes(1);
		// loop снял флаг при cancelled
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
		expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("session rotation cancelled"))).toBe(true);
		expect(wiring.isRotating()).toBe(false);

		// Persistent-fallback: оставшиеся 2 пункта за один tick, ротация не ретраится
		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(2);
		expect(newSession).toHaveBeenCalledTimes(1);
	});

	it("хост без newSession (mock/старый runner) → fail-safe cancelled, без throw", async () => {
		const { baseDir, missionDir } = await makeTempMission("s5-no-binding", { gitInit: true });
		liveTempDirs.push(baseDir);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const fan = makeMockFan({ newSession: undefined });
		const wiring = wireMission(fan, { runAgent: makeMockRunAgent() });
		liveWirings.push(wiring);

		const loop = wiring.attachMission(missionDir);
		const r1 = await loop.tick();
		expect(r1.itemsExecuted).toBe(1);
		// {cancelled:true} → fallback: флаг снят, warn, дальше persistent
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBeFalsy();
		expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("session rotation cancelled"))).toBe(true);

		const r2 = await loop.tick();
		expect(r2.itemsExecuted).toBe(1);
		expect(r2.status).toBe("completed");
	});
});

// ─── S5: rotatingGuard в session_shutdown (factory) ─────────────────────────

describe("S5 / session_shutdown guard", () => {
	it("shutdown во время ротации → лёгкая очистка БЕЗ abort: миссия active, loop жив", async () => {
		const { baseDir, missionDir } = await makeTempMission("s5-guard", { gitInit: true });
		liveTempDirs.push(baseDir);

		let fan;
		const newSession = vi.fn(async () => {
			// teardown СТАРОЙ сессии внутри newSession → session_shutdown с guard
			await fan._emit("session_shutdown", { type: "session_shutdown" });
			return { cancelled: false };
		});
		fan = makeMockFan({ newSession });
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{
				cwd: baseDir,
				hasUI: true,
				ui: {},
				sessionManager: { getSessionFile: () => "/sessions/s0.jsonl" },
			},
		);
		const loop = handle.getMissionLoop();
		expect(loop).not.toBeNull();

		// Полный tick с дефолтным runAgent → COMPLETE → finalise → ротация
		const tickPromise = loop.tick();
		await completeDefaultRunAgentTurn(fan);
		await tickPromise;

		// Ротация запрошена с parentSession из session_start ctx
		expect(newSession).toHaveBeenCalledTimes(1);
		expect(newSession).toHaveBeenCalledWith({ parentSession: "/sessions/s0.jsonl" });

		// КРИТИЧНО: guard-ветка НЕ вызвала detach/abort — миссия НЕ aborted
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");
		expect((await readMissionLoopState(missionDir)).abortedByOperator).toBeFalsy();
		// wiring.handle не очищен (detach не выполнялся)
		expect(handle.getMissionLoop()).toBe(loop);
		// guard снят (guard-веткой и/или finally rotator'а)
		expect(handle.isRotating()).toBe(false);
	});

	it("shutdown БЕЗ ротации → прежнее поведение: abort → status aborted, handle очищен", async () => {
		const { baseDir, missionDir } = await makeTempMission("s5-plain-shutdown");
		liveTempDirs.push(baseDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		// НЕ в liveWirings — shutdown через session_shutdown hook

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);
		expect(handle.getMissionLoop()).not.toBeNull();

		await fan._emit("session_shutdown", { type: "session_shutdown" });

		expect(handle.getMissionLoop()).toBeNull();
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("aborted");
	});
});

// ─── S5: автопродолжение в session_start (factory) ──────────────────────────

describe("S5 / session_start auto-resume после ротации", () => {
	it("resumeAfterRotation=true → флаг снят ДО tick, tick запланирован (setTimeout), setSessionName", async () => {
		const { baseDir, missionDir } = await makeTempMission("s5-resume");
		liveTempDirs.push(baseDir);
		// Эмулируем состояние после ротации итерации 1: флаг на диске
		await writeLoopState(missionDir, { resumeAfterRotation: true, currentIteration: 1, lastStep: 7 });

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);

		expect(handle.getMissionLoop()).not.toBeNull();
		// Флаг снят ДО tick — в рамках session_start handler'а
		expect((await readMissionLoopState(missionDir)).resumeAfterRotation).toBe(false);
		// tick запланирован через setTimeout(0) — ещё не стартовал
		expect(fan.sendUserMessage).not.toHaveBeenCalled();
		// Наблюдаемость: имя итерационной сессии (§4.5)
		expect(fan.setSessionName).toHaveBeenCalledWith("mission/s5-resume/iter-2");

		// tick запускается на следующем macrotask (default runAgent → sendUserMessage)
		await waitFor(() => fan.sendUserMessage.mock.calls.length > 0);
		expect(fan.sendUserMessage).toHaveBeenCalled();

		// cleanup: shutdown settle-ит waiter (FAILED-тег), tick разворачивается
		await handle.shutdown();
	});

	it("без флага → auto-tick НЕ запускается, setSessionName не вызывается", async () => {
		const { baseDir } = await makeTempMission("s5-no-resume");
		liveTempDirs.push(baseDir);

		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: {} },
		);
		expect(handle.getMissionLoop()).not.toBeNull();
		expect(fan.setSessionName).not.toHaveBeenCalled();

		// Несколько macrotask'ов — auto-tick не должен запуститься
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fan.sendUserMessage).not.toHaveBeenCalled();
	});
});
