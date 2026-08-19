// F-MISSION-DIALOG: wiring опросника решений в index.ts / tick-bridge.ts.
//
// Точки вызова (спека инцидент-фикса):
//   1. onTickResult tick-bridge: тик завершился со status ===
//      "awaiting_decision" → prompter.maybePrompt (detached, не блокирует тик).
//   2. session_start: attach миссии в статусе awaiting_decision →
//      maybePrompt (recovery после рестарта/ротации).
//   3. Headless (без select/input в ctx.ui) → только warning через
//      operatorNotify-канал (headlessNotify prompter'а).
//
// Паттерн — index-fresh-rotation-wiring.test.mjs (makeMockFan + реальная
// initMission-миссия; DECIDE-тик через дефолтный runAgent: sendUserMessage →
// agent_end с <promise>DECIDE:…</promise>).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DECISION_OPTION_ANSWER,
	DECISION_OPTION_COMPLETE,
	DECISION_OPTION_LATER,
} from "../decision-dialog.js";
import { initMission, readMission, writeMissionStatus } from "../file-state-manager.js";
import { readMissionLoopState } from "../mission-loop.js";

let factory;

beforeAll(async () => {
	const mod = await import("../index.js");
	factory = mod.default;
});

// ─── Helpers (паттерн index-fresh-rotation-wiring.test.mjs) ─────────────────

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

async function makeTempMission(slug) {
	const baseDir = mkdtempSync(join(tmpdir(), "fan-mission-dlg-"));
	const missionDir = await initMission(slug, { baseDir: join(baseDir, "docs", "missions") });
	writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] step one\n- [ ] step two\n", "utf8");
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

/** Ждать асинхронное условие (poll 10ms, до ~2с). */
async function waitForAsync(cond) {
	for (let i = 0; i < 200 && !(await cond()); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Полный UI-контекст (select/input/notify) для session_start. */
function makeUi(overrides = {}) {
	return {
		select: vi.fn().mockResolvedValue(DECISION_OPTION_LATER),
		input: vi.fn().mockResolvedValue("ответ оператора"),
		notify: vi.fn(),
		...overrides,
	};
}

/** mission_tick-хендлер, зарегистрированный фабрикой в fan.events.on. */
function getTickHandler(fan) {
	const call = fan.events.on.mock.calls.find((c) => c[0] === "mission_tick");
	return call ? call[1] : null;
}

/** Ответить дефолтному runAgent через agent_end (текст assistant'а). */
async function answerDefaultRunAgent(fan, text) {
	await waitFor(() => fan.sendUserMessage.mock.calls.length > 0);
	const prompt = fan.sendUserMessage.mock.calls[fan.sendUserMessage.mock.calls.length - 1][0];
	await fan._emit("agent_end", {
		type: "agent_end",
		messages: [
			{ role: "user", content: prompt },
			{
				role: "assistant",
				content: [{ type: "text", text }],
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

// ─── Точка 1: результат тика (tick-bridge onTickResult) ─────────────────────

describe("F-MISSION-DIALOG / точка 1: tick → awaiting_decision → диалог", () => {
	it("тик с DECIDE-ответом → ui.select с вопросом и 3 опциями; «Оставить на паузе» не меняет статус", async () => {
		const { baseDir, missionDir } = await makeTempMission("dlg-tick");
		liveTempDirs.push(baseDir);

		const ui = makeUi(); // select → LATER по умолчанию
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui },
		);
		expect(handle.getMissionLoop()).not.toBeNull();

		// Тик через мост scheduler-событий (detached handler).
		const tickHandler = getTickHandler(fan);
		expect(tickHandler).not.toBeNull();
		tickHandler({ missionDir, ts: Date.now() + 1000, tickId: "t-dlg-1" });

		// runAgent отвечает DECIDE-тегом → контур входит в awaiting_decision.
		await answerDefaultRunAgent(fan, "<promise>DECIDE:Куда двигаться дальше?</promise>");

		await waitFor(() => ui.select.mock.calls.length > 0);
		expect(ui.notify).toHaveBeenCalledWith("⏸ Миссия dlg-tick ждёт решения оператора", "warning");
		expect(ui.select).toHaveBeenCalledWith("Куда двигаться дальше?", [
			DECISION_OPTION_ANSWER,
			DECISION_OPTION_COMPLETE,
			DECISION_OPTION_LATER,
		]);

		// «Оставить на паузе» → миссия остаётся awaiting_decision (fallback /mission:decide)
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("awaiting_decision");
	});

	it("ответ текстом через диалог → resolveDecision → статус active, ответ в DECISIONS.md", async () => {
		const { baseDir, missionDir } = await makeTempMission("dlg-answer");
		liveTempDirs.push(baseDir);

		const ui = makeUi({
			select: vi.fn().mockResolvedValue(DECISION_OPTION_ANSWER),
			input: vi.fn().mockResolvedValue("делаем вариант Б"),
		});
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui },
		);

		const tickHandler = getTickHandler(fan);
		tickHandler({ missionDir, ts: Date.now() + 1000, tickId: "t-dlg-2" });
		await answerDefaultRunAgent(fan, "<promise>DECIDE:Какой вариант выбрать?</promise>");

		await waitFor(() => ui.input.mock.calls.length > 0);
		expect(ui.input).toHaveBeenCalledWith("Какой вариант выбрать?", expect.any(String));

		// resolveDecision применён (detached-диалог): статус возвращается в active
		await waitForAsync(async () => String((await readMission(missionDir)).frontmatter.status) === "active");
		expect(String((await readMission(missionDir)).frontmatter.status)).toBe("active");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Решение записано"), "info");

		// pendingDecision очищен, ответ сохранён для следующего тика
		const state = await readMissionLoopState(missionDir);
		expect(state.pendingDecision).toBeUndefined();
		expect(state.pendingOperatorAnswer).toBe("делаем вариант Б");
	});

	it("повторный тик в awaiting_decision → anti-spam: select не показывается повторно", async () => {
		const { baseDir, missionDir } = await makeTempMission("dlg-antispam");
		liveTempDirs.push(baseDir);

		const ui = makeUi(); // select → LATER
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui },
		);

		const tickHandler = getTickHandler(fan);
		tickHandler({ missionDir, ts: Date.now() + 1000, tickId: "t-dlg-3a" });
		await answerDefaultRunAgent(fan, "<promise>DECIDE:Вопрос один и тот же?</promise>");

		await waitFor(() => ui.select.mock.calls.length > 0);
		expect(ui.select).toHaveBeenCalledTimes(1);

		// Второй тик в том же awaiting_decision (scheduler пингует контур):
		// tick() рано возвращает status awaiting_decision → onTickResult снова.
		tickHandler({ missionDir, ts: Date.now() + 2000, tickId: "t-dlg-3b" });
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(ui.select).toHaveBeenCalledTimes(1); // диалог не дублируется
		expect(ui.notify.mock.calls.filter((c) => String(c[0]).includes("ждёт решения")).length)
			.toBeGreaterThanOrEqual(2); // warning приходит каждый раз
	});
});

// ─── Точка 2: session_start recovery ────────────────────────────────────────

describe("F-MISSION-DIALOG / точка 2: session_start с awaiting_decision на диске", () => {
	it("attach миссии в awaiting_decision → диалог показан немедленно", async () => {
		const { baseDir, missionDir } = await makeTempMission("dlg-recovery");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "awaiting_decision");
		await writeLoopState(missionDir, {
			pendingDecision: { question: "Продолжаем после рестарта?", date: "2026-08-19T09:00:00.000Z" },
		});

		const ui = makeUi();
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui },
		);
		expect(handle.getMissionLoop()).not.toBeNull();

		await waitFor(() => ui.select.mock.calls.length > 0);
		expect(ui.notify).toHaveBeenCalledWith("⏸ Миссия dlg-recovery ждёт решения оператора", "warning");
		expect(ui.select).toHaveBeenCalledWith("Продолжаем после рестарта?", [
			DECISION_OPTION_ANSWER,
			DECISION_OPTION_COMPLETE,
			DECISION_OPTION_LATER,
		]);
	});

	it("headless (ui без select/input) → только warning-notify с вопросом, без диалога", async () => {
		const { baseDir, missionDir } = await makeTempMission("dlg-headless");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "awaiting_decision");
		await writeLoopState(missionDir, {
			pendingDecision: { question: "Вопрос для headless?", date: "2026-08-19T09:30:00.000Z" },
		});

		// ui только с notify — как RPC-контекст без интерактивных диалогов.
		const notify = vi.fn();
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui: { notify } },
		);
		expect(handle.getMissionLoop()).not.toBeNull();

		await waitFor(() => notify.mock.calls.length > 0);
		const text = notify.mock.calls.map((c) => c.join(" ")).join("\n");
		expect(text).toContain("ждёт решения оператора");
		expect(text).toContain("Вопрос для headless?");
	});

	it("session_start с active-миссией → диалог НЕ показывается (нет awaiting_decision)", async () => {
		const { baseDir } = await makeTempMission("dlg-active");
		liveTempDirs.push(baseDir);

		const ui = makeUi();
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui },
		);
		expect(handle.getMissionLoop()).not.toBeNull();

		// Несколько macrotask'ов — диалог не должен открываться
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(ui.select).not.toHaveBeenCalled();
	});
});

// ─── Регрессия: prompter не мешает /mission:decide (fallback) ──────────────

describe("F-MISSION-DIALOG / совместимость с /mission:decide", () => {
	it("диалог «Оставить на паузе» → /mission:decide отвечает позже: resolveDecision через команду", async () => {
		const { baseDir, missionDir } = await makeTempMission("dlg-fallback");
		liveTempDirs.push(baseDir);
		await writeMissionStatus(missionDir, "awaiting_decision");
		await writeLoopState(missionDir, {
			pendingDecision: { question: "Пауза или ответ?", date: "2026-08-19T09:45:00.000Z" },
		});

		const ui = makeUi(); // «Оставить на паузе»
		const fan = makeMockFan();
		const handle = factory(fan);
		liveWirings.push(handle);

		await fan._emit(
			"session_start",
			{ type: "session_start", cwd: baseDir },
			{ cwd: baseDir, hasUI: true, ui },
		);
		await waitFor(() => ui.select.mock.calls.length > 0);

		// Оператор передумал и отвечает через slash-команду (fallback-путь).
		const decideCmd = fan._commands.get("mission:decide");
		expect(decideCmd).toBeDefined();
		await decideCmd.handler("отвечаю через команду", { ui: { notify: vi.fn() } });

		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");
		const state = await readMissionLoopState(missionDir);
		expect(state.pendingOperatorAnswer).toBe("отвечаю через команду");
	});
});
