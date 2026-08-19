// F-MISSION-DIALOG: Опросник для решений миссии (awaiting_decision).
//
// Инцидент: миссия вставала в awaiting_decision, а оператор видел только
// молчаливый статус в виджете и не понимал, что от него ждут ответа.
// Теперь при входе в awaiting_decision оператору немедленно показывается
// стандартный диалог ExtensionUIContext (notify + select + input); ответ из
// диалога → loop.resolveDecision(answer). /mission:decide остаётся fallback
// («Оставить на паузе» / Esc).
//
// Поведение promptOperatorDecision (через createOperatorDecisionPrompter):
//   - !ui (RPC/headless) → только headlessNotify warning, диалога нет
//     (поведение как раньше: degradation-алерт из инцидент-фикса).
//   - ui.notify("⏸ Миссия <slug> ждёт решения оператора", "warning") — всегда.
//   - pendingDecision отсутствует на диске → только notify, без select.
//   - Anti-spam: диалог показывается один раз на pendingDecision.date
//     (in-memory set живёт вместе с фабрикой расширения, т.е. на весь
//     процесс: после fresh-ротации с тем же pendingDecision.date диалог
//     повторно НЕ покажется — только warning-notify; fallback /mission:decide).
//   - select options:
//       «Ответить текстом» → ui.input(question) → непустой ответ →
//           await loop.resolveDecision(answer) + notify-подтверждение;
//       «Миссия выполнена — завершить (completed)» →
//           resolveDecision(MISSION_COMPLETE_ANSWER) — НЕ прямая правка
//           статуса: FSM-перехода awaiting_decision→completed нет, идём
//           через resolveDecision → active → следующий тик сам детектит
//           completed по закрытому ROADMAP;
//       «Оставить на паузе (ответить позже через /mission:decide)» → ничего;
//     select отменён (Esc/undefined) → ничего (миссия остаётся
//     awaiting_decision).
//
// Точки вызова (index.ts):
//   - onTickResult из tick-bridge: status === "awaiting_decision" → maybePrompt
//     (async, не блокирует тик);
//   - session_start: attach с статусом awaiting_decision + pendingDecision
//     на диске → maybePrompt (recovery после рестарта/ротации).

import { basename } from "node:path";

import { type LoopState, type MissionLoop, readMissionLoopState } from "./mission-loop.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Минимальный UI-контракт диалога (подмножество ExtensionUIContext). */
export interface OperatorDecisionUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface OperatorDecisionPrompter {
	/** Показывает диалог решения, если есть pendingDecision и он ещё не показывался. */
	maybePrompt(loop: MissionLoop, missionDir: string, ui: OperatorDecisionUI | undefined): Promise<void>;
}

export interface OperatorDecisionPrompterOptions {
	/** DI: чтение loop state (в тестах — mock; дефолт — readMissionLoopState). */
	readState?: (missionDir: string) => Promise<LoopState>;
	/** Headless-канал (operatorNotify из инцидент-фикса): warning без диалога. */
	headlessNotify?: (msg: string) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const DECISION_OPTION_ANSWER = "Ответить текстом";
export const DECISION_OPTION_COMPLETE = "Миссия выполнена — завершить (completed)";
export const DECISION_OPTION_LATER = "Оставить на паузе (ответить позже через /mission:decide)";

/** Ответ-заглушка для опции «Миссия выполнена»: через resolveDecision → active,
 * следующий тик сам детектит completed (прямой FSM-переход отсутствует). */
export const MISSION_COMPLETE_ANSWER = "Mission complete: roadmap fully closed by operator decision";

// ─── Factory ────────────────────────────────────────────────────────────────

export function createOperatorDecisionPrompter(opts?: OperatorDecisionPrompterOptions): OperatorDecisionPrompter {
	const readState = opts?.readState ?? readMissionLoopState;
	// Anti-spam: pendingDecision.date, для которых диалог уже показывался.
	// Scope — экземпляр prompter'а (создаётся один раз в missionExtension,
	// живёт весь процесс и переживает fresh-ротацию): повторный показ того
	// же вопроса не случится и после ротации — fallback /mission:decide.
	const shownDecisionDates = new Set<string>();

	const maybePrompt = async (
		loop: MissionLoop,
		missionDir: string,
		ui: OperatorDecisionUI | undefined,
	): Promise<void> => {
		const slug = basename(missionDir);
		let pending: LoopState["pendingDecision"];
		try {
			pending = (await readState(missionDir)).pendingDecision;
		} catch {
			return; // state нечитаем — молчим (loop сам алертит через notify-канал)
		}

		if (!ui) {
			// RPC/headless: диалог недоступен — только warning-канал (как раньше).
			if (pending) {
				opts?.headlessNotify?.(`⏸ Миссия ${slug} ждёт решения оператора: ${pending.question}`);
			}
			return;
		}

		ui.notify(`⏸ Миссия ${slug} ждёт решения оператора`, "warning");
		if (!pending) {
			return; // awaiting_decision без вопроса на диске — только notify
		}
		if (shownDecisionDates.has(pending.date)) {
			return; // anti-spam: этот вопрос уже показывали
		}
		// Помечаем ДО select: повторный вход во время открытого диалога
		// (scheduler tick) не откроет второй.
		shownDecisionDates.add(pending.date);

		let choice: string | undefined;
		try {
			choice = await ui.select(pending.question, [
				DECISION_OPTION_ANSWER,
				DECISION_OPTION_COMPLETE,
				DECISION_OPTION_LATER,
			]);
		} catch {
			return; // сбой UI — миссия остаётся awaiting_decision
		}

		const applyAnswer = async (answer: string): Promise<void> => {
			try {
				await loop.resolveDecision(answer);
				ui.notify(`✅ Решение записано — миссия ${slug} продолжает работу`, "info");
			} catch (err) {
				// Статус мог измениться между select и resolve (timeout, /mission:decide).
				ui.notify(`Не удалось применить решение: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		};

		if (choice === DECISION_OPTION_ANSWER) {
			let answer: string | undefined;
			try {
				answer = (await ui.input(pending.question, "Ваш ответ для миссии…"))?.trim();
			} catch {
				return;
			}
			if (answer) {
				await applyAnswer(answer);
			}
			// Пустой ответ / Esc в input → ничего (миссия остаётся awaiting_decision)
		} else if (choice === DECISION_OPTION_COMPLETE) {
			await applyAnswer(MISSION_COMPLETE_ANSWER);
		}
		// DECISION_OPTION_LATER / undefined (Esc) → ничего: fallback /mission:decide
	};

	return { maybePrompt };
}
