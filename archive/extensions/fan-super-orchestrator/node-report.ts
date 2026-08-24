// F-28: Протокол «отчёт узла» (L1 → L0).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-28
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.3
//
// Финальное сообщение дочернего узла парсится в структурированный отчёт
// NodeReport. Наличие маркера "VERDICT: X" означает, что отчёт доставлен
// по протоколу (status "completed"), при этом сам verdict — это ОЦЕНКА
// результата: FAIL/PARTIAL не меняют status на "failed" ("failed" — только
// при ошибке выполнения). Без маркера отчёт считается "unknown", и
// координатор уведомляется через callbacks.onUnknownReport(raw).

/** Потреблённые ресурсы узла. */
export interface NodeUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	turns?: number;
	durationMs?: number;
}

/** Результат работы узла (raw-текст финального сообщения + артефакты). */
export interface NodeResult {
	text: string;
	filesModified?: string[];
	filesCreated?: string[];
	commitsMade?: string[];
}

/** Отчёт узла (рекурсивная структура: children — отчёты дочерних узлов). */
export interface NodeReport {
	nodeId: string;
	/** Формат: <mission-id>/L<N>/node-<M>. */
	correlationId: string;
	status: "completed" | "failed" | "aborted" | "timeout" | "unknown";
	verdict: "PASS" | "FAIL" | "PARTIAL" | null;
	result: NodeResult;
	usage: NodeUsage;
	children?: NodeReport[];
	completionReason?: "task_completed" | "budget_exhausted" | "deadline_reached" | "aborted";
	/** true при аварийном завершении (crash/timeout). */
	interrupted?: boolean;
}

/** Метаданные финального сообщения узла. */
export interface NodeReportMeta {
	nodeId: string;
	correlationId: string;
	usage?: Partial<NodeUsage>;
}

/** Колбэки парсинга отчёта. */
export interface ParseCallbacks {
	onUnknownReport?: (raw: string) => void;
}

/** Маркер VERDICT: регистронезависимый, допустимо без пробела после ":".
 *  Флаг "g" — чтобы из нескольких маркеров выбрать последний. */
const VERDICT_PATTERN = /\bVERDICT:\s*(PASS|FAIL|PARTIAL)\b/gi;

/** Извлекает verdict из текста: последний маркер "VERDICT: X" или null. */
export function parseVerdict(text: string): "PASS" | "FAIL" | "PARTIAL" | null {
	let verdict: "PASS" | "FAIL" | "PARTIAL" | null = null;
	for (const match of text.matchAll(VERDICT_PATTERN)) {
		verdict = match[1].toUpperCase() as "PASS" | "FAIL" | "PARTIAL";
	}
	return verdict;
}

/** Нормализует usage: незаданные inputTokens/outputTokens/costUsd → 0. */
function normalizeUsage(usage: Partial<NodeUsage> | undefined): NodeUsage {
	const normalized: NodeUsage = {
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
		costUsd: usage?.costUsd ?? 0,
	};
	if (usage?.turns !== undefined) {
		normalized.turns = usage.turns;
	}
	if (usage?.durationMs !== undefined) {
		normalized.durationMs = usage.durationMs;
	}
	return normalized;
}

/** Парсит финальное сообщение узла в NodeReport.
 *
 *  Есть VERDICT → status "completed" (даже при verdict FAIL/PARTIAL —
 *  отчёт доставлен), иначе status "unknown", verdict null и вызывается
 *  callbacks.onUnknownReport(assistantText) ровно один раз. */
export function parseNodeReport(assistantText: string, meta: NodeReportMeta, callbacks?: ParseCallbacks): NodeReport {
	const verdict = parseVerdict(assistantText);
	if (verdict === null) {
		callbacks?.onUnknownReport?.(assistantText);
	}
	return {
		nodeId: meta.nodeId,
		correlationId: meta.correlationId,
		status: verdict === null ? "unknown" : "completed",
		verdict,
		result: { text: assistantText },
		usage: normalizeUsage(meta.usage),
	};
}

/** Рекурсивная агрегация usage: свой usage + Σ детей всех уровней. */
export function totalUsage(report: NodeReport): NodeUsage {
	const total: NodeUsage = {
		inputTokens: report.usage.inputTokens,
		outputTokens: report.usage.outputTokens,
		costUsd: report.usage.costUsd,
	};
	for (const child of report.children ?? []) {
		const childTotal = totalUsage(child);
		total.inputTokens += childTotal.inputTokens;
		total.outputTokens += childTotal.outputTokens;
		total.costUsd += childTotal.costUsd;
	}
	return total;
}

/** Отчёт узла, убитого по deadline: статус "timeout", interrupted: true. */
export function makeTimeoutReport(meta: NodeReportMeta, usage?: Partial<NodeUsage>): NodeReport {
	return {
		nodeId: meta.nodeId,
		correlationId: meta.correlationId,
		status: "timeout",
		verdict: null,
		result: { text: "" },
		usage: normalizeUsage(usage),
		completionReason: "deadline_reached",
		interrupted: true,
	};
}

/** Отчёт узла, остановленного координатором: статус "aborted". */
export function makeAbortedReport(meta: NodeReportMeta, usage?: Partial<NodeUsage>): NodeReport {
	return {
		nodeId: meta.nodeId,
		correlationId: meta.correlationId,
		status: "aborted",
		verdict: null,
		result: { text: "" },
		usage: normalizeUsage(usage),
		completionReason: "aborted",
	};
}
