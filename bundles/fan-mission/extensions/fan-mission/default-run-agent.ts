// F-MISSION-DEFAULT-RUN-AGENT: production runAgent — реальный захват результата
// итерации и usage (ТИКЕТ-12).
//
// Контракт:
//   createDefaultRunAgent(fan, opts?): DefaultRunAgentHandle
//     { runAgent: RunAgent, settle(reason): void }
//
// Механика:
//   1. ОДИН персистентный handler fan.on("agent_end", ...) регистрируется при
//      создании (fan.on возвращает void — unsubscribe нет, поэтому handler
//      читает mutable state.pending; null → no-op).
//   2. Single-flight: повторный runAgent при активном pending → немедленный
//      FAILED "runAgent already in flight" (costTokens/costUsd = 0).
//   3. runAgent(prompt) устанавливает state.pending ДО
//      fan.sendUserMessage(prompt, {deliverAs:"followUp"}) — race-guard.
//   4. Корреляция в handler: ПОСЛЕДНИЙ user с текстом === pending.prompt
//      (content: string → как есть; array → concat TextContent.text).
//      Не найден → игнор (чужой turn).
//   5. Результат из assistant-сообщений ПОСЛЕ найденного индекса:
//      response = текст последнего assistant с непустым текстом;
//      costTokens = Σ usage.totalTokens; costUsd = Σ usage.cost.total.
//      stopReason "error"/"aborted" без валидного <promise>-тега → FAILED-тег.
//   6. timeout/settle всегда возвращают <promise>FAILED:...</promise>,
//      НИКОГДА пустую строку (пустая → ложный COMPLETE → коммит
//      невыполненного item).

import type { AgentEndEvent, ExtensionAPI, IterationBudgetExceededEvent } from "@seaagents/fan-coding-agent";
import { parsePromise } from "./promise-parser.js";
import type { RunAgent } from "./session-executor.js";

/** Дефолтный таймаут ожидания agent_end: 0 = бесконечно (таймер не ставится). */
export const DEFAULT_TIMEOUT_MS = 0;

/** Минимальный таймаут (1 минута). */
const MIN_TIMEOUT_MS = 60_000;

/** Максимальный таймаут (8 часов). */
const MAX_TIMEOUT_MS = 480 * 60_000;

/**
 * Вычислить таймаут runAgent из frontmatter MISSION.md.
 * Читает поле `runagent_timeout_min` (минуты); валидирует границы 1–480.
 * При отсутствии или невалидном значении — возвращает дефолт (0 = бесконечно).
 *
 * Используется в index.ts (wireMission) для проброса таймаута в
 * createDefaultRunAgent при создании runAgent для каждой конкретной миссии.
 */
export function resolveRunAgentTimeoutMs(frontmatter: Record<string, unknown>): number {
	const raw = frontmatter.runagent_timeout_min;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		const ms = raw * 60_000;
		if (ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS) {
			return ms;
		}
	}
	return DEFAULT_TIMEOUT_MS;
}

export interface DefaultRunAgentOptions {
	/** Таймаут ожидания завершения turn (по умолчанию 0 = бесконечно). */
	timeoutMs?: number;
	/** DI часов (для тестов); по умолчанию Date.now. */
	now?: () => number;
}

export interface RunAgentResult {
	response: string;
	costTokens: number;
	costUsd: number;
}

export interface DefaultRunAgentHandle {
	runAgent: RunAgent;
	/** Идемпотентно: settle активного waiter FAILED-тегом + снять таймер. */
	settle(reason: string): void;
}

/** Активный waiter (single-flight). */
interface Pending {
	prompt: string;
	resolve: (result: RunAgentResult) => void;
	timer: ReturnType<typeof setTimeout> | null;
	sentAt: number;
}

/** Нормализация user-content: string → как есть; array → concat TextContent.text. */
function extractUserText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	return extractTextParts(content);
}

/** Concat TextContent.text из content-массива (thinking/toolCall/image игнорируются). */
function extractTextParts(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	let out = "";
	for (const part of content) {
		if (
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			out += (part as { text: string }).text;
		}
	}
	return out;
}

/** reason → однострочный без `<` (для встраивания в <promise>FAILED:...</promise>). */
function sanitizeReason(reason: unknown): string {
	const flat = String(reason ?? "")
		.replace(/\s+/g, " ")
		.replaceAll("<", "")
		.trim();
	return flat === "" ? "unknown" : flat;
}

/** Единообразный FAILED-результат (НИКОГДА пустая строка). */
function failed(reason: string, costTokens = 0, costUsd = 0): RunAgentResult {
	return { response: `<promise>FAILED: ${reason}</promise>`, costTokens, costUsd };
}

function isAssistantLike(msg: unknown): msg is {
	role: "assistant";
	content: unknown;
	usage?: { totalTokens?: unknown; cost?: { total?: unknown } };
	stopReason?: unknown;
	errorMessage?: unknown;
} {
	return typeof msg === "object" && msg !== null && (msg as { role?: unknown }).role === "assistant";
}

/**
 * Production runAgent: prompt → fan.sendUserMessage(deliverAs:"followUp") →
 * ожидание agent_end с нашим prompt в messages → последний assistant-текст +
 * Σ usage. Single-flight; timeout/settle → FAILED-тег.
 */
export function createDefaultRunAgent(fan: ExtensionAPI, opts?: DefaultRunAgentOptions): DefaultRunAgentHandle {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = opts?.now ?? Date.now;

	const state: { pending: Pending | null; budgetExceeded: { tokensUsed: number; costUsed: number } | null } = {
		pending: null,
		budgetExceeded: null,
	};

	const clearPending = (pending: Pending): void => {
		if (state.pending === pending) {
			state.pending = null;
		}
		if (pending.timer !== null) {
			clearTimeout(pending.timer);
			pending.timer = null;
		}
	};

	// ── agent_end handler (персистентный, без unsubscribe) ────────────────────
	const onAgentEnd = (event: AgentEndEvent): void => {
		const pending = state.pending;
		if (!pending) {
			return; // нет активного waiter — чужой turn
		}
		const messages = Array.isArray(event?.messages) ? event.messages : [];

		// Корреляция: ПОСЛЕДНИЙ user с текстом === prompt (user-prompt, запустивший
		// run, включён в messages; follow-up во время turn дрейнится в тот же run).
		let promptIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as { role?: unknown; content?: unknown } | undefined;
			if (msg && msg.role === "user" && extractUserText(msg.content) === pending.prompt) {
				promptIndex = i;
				break;
			}
		}
		if (promptIndex === -1) {
			return; // чужой turn — нашего prompt нет в messages
		}

		// Сбор результата из assistant-сообщений ПОСЛЕ promptIndex.
		let costTokens = 0;
		let costUsd = 0;
		let lastText = "";
		let lastAssistant: { stopReason?: unknown; errorMessage?: unknown } | null = null;
		for (let i = promptIndex + 1; i < messages.length; i++) {
			const msg = messages[i];
			if (!isAssistantLike(msg)) {
				continue;
			}
			lastAssistant = msg;
			const totalTokens = Number(msg.usage?.totalTokens);
			if (Number.isFinite(totalTokens)) {
				costTokens += totalTokens;
			}
			const total = Number(msg.usage?.cost?.total);
			if (Number.isFinite(total)) {
				costUsd += total;
			}
			const text = extractTextParts(msg.content);
			if (text !== "") {
				lastText = text;
			}
		}

		let response = lastText;

		// stopReason error/aborted без валидного <promise>-тега → FAILED-тег.
		const stopReason = lastAssistant?.stopReason;
		if ((stopReason === "error" || stopReason === "aborted") && parsePromise(response) === null) {
			const budget = state.budgetExceeded;
			if (budget !== null) {
				// F-46: abort вызван превышением iteration-бюджета — отдельная
				// диагностика (иначе кейс неотличим от generic abort).
				state.budgetExceeded = null;
				response = `<promise>FAILED: iteration budget exceeded (tokensUsed=${budget.tokensUsed}, costUsed=$${budget.costUsed})</promise>`;
			} else {
				response = `<promise>FAILED: agent ${stopReason}: ${sanitizeReason(lastAssistant?.errorMessage)}</promise>`;
			}
		}

		// Пустой ответ (нет assistant-текста) → FAILED, не ложный COMPLETE.
		if (response === "") {
			response = "<promise>FAILED: agent returned empty response</promise>";
		}

		clearPending(pending);
		pending.resolve({ response, costTokens, costUsd });
	};
	fan.on("agent_end", onAgentEnd);

	// ── iteration_budget_exceeded handler (F-46, персистентный) ─────────────
	// Событие приходит ДО agent_end того же прогона; флаг потребляется в
	// onAgentEnd и сбрасывается на новый прогон (runAgent).
	const onIterationBudgetExceeded = (event: IterationBudgetExceededEvent): void => {
		if (state.pending === null) {
			return; // нет активного waiter — чужой прогон
		}
		const tokensUsed = Number(event?.tokensUsed);
		const costUsed = Number(event?.costUsed);
		state.budgetExceeded = {
			tokensUsed: Number.isFinite(tokensUsed) ? tokensUsed : 0,
			costUsed: Number.isFinite(costUsed) ? costUsed : 0,
		};
	};
	fan.on("iteration_budget_exceeded", onIterationBudgetExceeded);

	// ── runAgent (single-flight) ──────────────────────────────────────────────
	const runAgent: RunAgent = (prompt) => {
		if (state.pending !== null) {
			console.warn("[fan-mission] runAgent rejected: another run is already in flight");
			return Promise.resolve(failed("runAgent already in flight"));
		}
		return new Promise<RunAgentResult>((resolve) => {
			const pending: Pending = { prompt, resolve, timer: null, sentAt: now() };
			if (timeoutMs > 0) {
				const timer = setTimeout(() => {
					if (state.pending !== pending) {
						return;
					}
					clearPending(pending);
					console.warn(`[fan-mission] runAgent timeout after ${timeoutMs}ms`);
					resolve(failed(`runAgent timeout after ${timeoutMs}ms`));
				}, timeoutMs);
				if (typeof timer.unref === "function") {
					timer.unref();
				}
				pending.timer = timer;
			}
			// pending устанавливается ДО sendUserMessage (race-guard: agent_end
			// может прийти синхронно/мгновенно в некоторых runtime-конфигурациях).
			// Флаг iteration_budget_exceeded сбрасывается на новый прогон.
			state.budgetExceeded = null;
			state.pending = pending;
			try {
				fan.sendUserMessage(prompt, { deliverAs: "followUp" });
			} catch (err) {
				// сессия недоступна: снимаем pending (следующий вызов работоспособен)
				clearPending(pending);
				resolve(failed(`sendUserMessage failed: ${sanitizeReason(err instanceof Error ? err.message : err)}`));
			}
		});
	};

	// ── settle (shutdown) ─────────────────────────────────────────────────────
	const settle = (reason: string): void => {
		const pending = state.pending;
		if (!pending) {
			return; // идемпотентно
		}
		clearPending(pending);
		pending.resolve(failed(sanitizeReason(reason)));
	};

	return { runAgent, settle };
}
