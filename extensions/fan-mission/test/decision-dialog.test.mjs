// F-MISSION-DIALOG: опросник решений миссии — unit-тесты decision-dialog.ts.
//
// Контракт createOperatorDecisionPrompter(opts?) → { maybePrompt(loop, missionDir, ui) }:
//   1. pendingDecision на диске + ui → notify("⏸ Миссия <slug> ждёт решения
//      оператора", "warning") ВСЕГДА, затем select(вопрос, 3 опции):
//        «Ответить текстом» / «Миссия выполнена — завершить (completed)» /
//        «Оставить на паузе (ответить позже через /mission:decide)».
//   2. «Ответить текстом» → input(question) → непустой ответ →
//      loop.resolveDecision(answer) + notify-подтверждение.
//   3. «Миссия выполнена…» → loop.completeMission(MISSION_COMPLETE_ANSWER)
//      (прямой FSM-переход awaiting_decision→completed, дежурство продолжается).
//   4. «Оставить на паузе» / Esc (undefined) → resolveDecision НЕ вызывается.
//   5. Anti-spam: повторный maybePrompt с тем же pendingDecision.date —
//      только notify, select повторно НЕ вызывается.
//   6. ui === undefined (RPC/headless) → только headlessNotify (если есть
//      pendingDecision), диалога нет.
//
// readState — DI (без диска); loop — stub с resolveDecision/completeMission.

import { describe, expect, it, vi } from "vitest";

import {
	createOperatorDecisionPrompter,
	DECISION_OPTION_ANSWER,
	DECISION_OPTION_COMPLETE,
	DECISION_OPTION_LATER,
	MISSION_COMPLETE_ANSWER,
} from "../decision-dialog.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const QUESTION = "Куда двигаться дальше?";
const DATE = "2026-08-19T10:00:00.000Z";
const MISSION_DIR = "/tmp/missions/demo-mission"; // basename → slug "demo-mission"
const THREE_OPTIONS = [DECISION_OPTION_ANSWER, DECISION_OPTION_COMPLETE, DECISION_OPTION_LATER];

function makeUi(overrides = {}) {
	return {
		select: vi.fn().mockResolvedValue(DECISION_OPTION_LATER),
		input: vi.fn().mockResolvedValue("ответ оператора"),
		notify: vi.fn(),
		...overrides,
	};
}

function makeLoop() {
	return {
		resolveDecision: vi.fn().mockResolvedValue(undefined),
		completeMission: vi.fn().mockResolvedValue(undefined),
	};
}

function makePrompter(pendingDecision, opts = {}) {
	const readState = vi.fn().mockResolvedValue({ pendingDecision });
	const headlessNotify = vi.fn();
	const prompter = createOperatorDecisionPrompter({ readState, headlessNotify, ...opts });
	return { prompter, readState, headlessNotify };
}

// ─── 1. Диалог: notify + select с вопросом и 3 опциями ──────────────────────

describe("F-MISSION-DIALOG / диалог при pendingDecision", () => {
	it("pendingDecision + ui → warning-notify и select с вопросом и 3 опциями", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi();
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(ui.notify).toHaveBeenCalledWith("⏸ Миссия demo-mission ждёт решения оператора", "warning");
		expect(ui.select).toHaveBeenCalledTimes(1);
		expect(ui.select).toHaveBeenCalledWith(QUESTION, THREE_OPTIONS);
		// «Оставить на паузе» (дефолт mock) → решение не применяется
		expect(loop.resolveDecision).not.toHaveBeenCalled();
	});

	it("нет pendingDecision → только notify, select НЕ вызывается", async () => {
		const { prompter } = makePrompter(undefined);
		const ui = makeUi();

		await prompter.maybePrompt(makeLoop(), MISSION_DIR, ui);

		expect(ui.notify).toHaveBeenCalledWith("⏸ Миссия demo-mission ждёт решения оператора", "warning");
		expect(ui.select).not.toHaveBeenCalled();
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("readState бросает → тихий выход: без notify/select/resolve", async () => {
		const readState = vi.fn().mockRejectedValue(new Error("STATE.md unreadable"));
		const prompter = createOperatorDecisionPrompter({ readState });
		const ui = makeUi();
		const loop = makeLoop();

		await expect(prompter.maybePrompt(loop, MISSION_DIR, ui)).resolves.toBeUndefined();
		expect(ui.notify).not.toHaveBeenCalled();
		expect(ui.select).not.toHaveBeenCalled();
		expect(loop.resolveDecision).not.toHaveBeenCalled();
	});
});

// ─── 2. Опция «Ответить текстом» ────────────────────────────────────────────

describe("F-MISSION-DIALOG / «Ответить текстом»", () => {
	it("выбор опции → input(вопрос) → ответ → resolveDecision(ответ) + подтверждение", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({ select: vi.fn().mockResolvedValue(DECISION_OPTION_ANSWER) });
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(ui.input).toHaveBeenCalledTimes(1);
		expect(ui.input).toHaveBeenCalledWith(QUESTION, expect.any(String));
		expect(loop.resolveDecision).toHaveBeenCalledTimes(1);
		expect(loop.resolveDecision).toHaveBeenCalledWith("ответ оператора");
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Решение записано"),
			"info",
		);
	});

	it("пустой ответ в input → resolveDecision НЕ вызывается (миссия остаётся awaiting)", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({
			select: vi.fn().mockResolvedValue(DECISION_OPTION_ANSWER),
			input: vi.fn().mockResolvedValue("   "),
		});
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(ui.input).toHaveBeenCalled();
		expect(loop.resolveDecision).not.toHaveBeenCalled();
	});

	it("Esc в input (undefined) → resolveDecision НЕ вызывается", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({
			select: vi.fn().mockResolvedValue(DECISION_OPTION_ANSWER),
			input: vi.fn().mockResolvedValue(undefined),
		});
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(loop.resolveDecision).not.toHaveBeenCalled();
	});
});

// ─── 3. Опция «Миссия выполнена — завершить» ────────────────────────────────

describe("F-MISSION-DIALOG / «Миссия выполнена — завершить»", () => {
	it("выбор опции → completeMission(MISSION_COMPLETE_ANSWER)", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({ select: vi.fn().mockResolvedValue(DECISION_OPTION_COMPLETE) });
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(ui.input).not.toHaveBeenCalled();
		expect(loop.completeMission).toHaveBeenCalledTimes(1);
		expect(loop.completeMission).toHaveBeenCalledWith(MISSION_COMPLETE_ANSWER);
		expect(loop.resolveDecision).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("завершена"), "info");
	});
});

// ─── 4. «Оставить на паузе» и Esc ───────────────────────────────────────────

describe("F-MISSION-DIALOG / пауза и отмена", () => {
	it("«Оставить на паузе» → resolveDecision НЕ вызывается, input не показывается", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({ select: vi.fn().mockResolvedValue(DECISION_OPTION_LATER) });
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(loop.resolveDecision).not.toHaveBeenCalled();
		expect(ui.input).not.toHaveBeenCalled();
	});

	it("Esc (select → undefined) → resolveDecision НЕ вызывается", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({ select: vi.fn().mockResolvedValue(undefined) });
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(loop.resolveDecision).not.toHaveBeenCalled();
	});

	it("completeMission бросает (статус сменился) → notify с ошибкой, без throw", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi({ select: vi.fn().mockResolvedValue(DECISION_OPTION_COMPLETE) });
		const loop = { completeMission: vi.fn().mockRejectedValue(new Error("Invalid transition")) };

		await expect(prompter.maybePrompt(loop, MISSION_DIR, ui)).resolves.toBeUndefined();
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid transition"), "error");
	});
});

// ─── 5. Anti-spam ───────────────────────────────────────────────────────────

describe("F-MISSION-DIALOG / anti-spam по pendingDecision.date", () => {
	it("второй maybePrompt с тем же date → notify снова, select НЕ вызван повторно", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi();
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, ui);
		await prompter.maybePrompt(loop, MISSION_DIR, ui);

		expect(ui.notify).toHaveBeenCalledTimes(2); // warning каждый раз
		expect(ui.select).toHaveBeenCalledTimes(1); // диалог один раз на вопрос
	});

	it("новый pendingDecision.date → диалог показывается снова", async () => {
		const { prompter, readState } = makePrompter({ question: QUESTION, date: DATE });
		const ui = makeUi();

		await prompter.maybePrompt(makeLoop(), MISSION_DIR, ui);
		// Миссия ответила, позже возник новый вопрос (новая date)
		readState.mockResolvedValue({ pendingDecision: { question: "Новый вопрос?", date: "2026-08-20T00:00:00Z" } });
		await prompter.maybePrompt(makeLoop(), MISSION_DIR, ui);

		expect(ui.select).toHaveBeenCalledTimes(2);
		expect(ui.select.mock.calls[1][0]).toBe("Новый вопрос?");
	});

	it("select уже открыт (параллельный вход с тем же date) → второй диалог не открывается", async () => {
		const { prompter } = makePrompter({ question: QUESTION, date: DATE });
		let resolveSelect;
		const selectPending = new Promise((r) => (resolveSelect = r));
		const ui = makeUi({ select: vi.fn().mockReturnValue(selectPending) });

		const first = prompter.maybePrompt(makeLoop(), MISSION_DIR, ui);
		// Повторный вход пока первый select ещё висит (например, scheduler tick)
		await prompter.maybePrompt(makeLoop(), MISSION_DIR, ui);

		expect(ui.select).toHaveBeenCalledTimes(1);
		resolveSelect(DECISION_OPTION_LATER);
		await first;
	});
});

// ─── 6. Headless (ui === undefined) ─────────────────────────────────────────

describe("F-MISSION-DIALOG / headless-ветка", () => {
	it("ui=undefined + pendingDecision → headlessNotify с вопросом, диалога нет", async () => {
		const { prompter, headlessNotify } = makePrompter({ question: QUESTION, date: DATE });
		const loop = makeLoop();

		await prompter.maybePrompt(loop, MISSION_DIR, undefined);

		expect(headlessNotify).toHaveBeenCalledTimes(1);
		expect(headlessNotify).toHaveBeenCalledWith(expect.stringContaining(QUESTION));
		expect(headlessNotify).toHaveBeenCalledWith(expect.stringContaining("demo-mission"));
		expect(loop.resolveDecision).not.toHaveBeenCalled();
	});

	it("ui=undefined без pendingDecision → headlessNotify НЕ вызывается", async () => {
		const { prompter, headlessNotify } = makePrompter(undefined);

		await prompter.maybePrompt(makeLoop(), MISSION_DIR, undefined);

		expect(headlessNotify).not.toHaveBeenCalled();
	});
});
