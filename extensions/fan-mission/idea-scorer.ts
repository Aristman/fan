// F-20: Скорер идей — гибридный LLM + арифметика (спека §3.1.3).
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-20
// Контракт:  зафиксирован в header-комментарии test/idea-scorer.test.mjs.
//
// Формула и пороги — scorer-config.ts (refactor-цель карточки). Формат записи
// BACKLOG.md — общая утилита backlog-format.ts (F-19); файловый IO записей —
// readBacklog/appendBacklog/updateBacklogEntry из file-state-manager.ts.
//
// Контраст с idea-generator (F-19): скорер ПРОБРАСЫВАЕТ ошибки LLM (скоринг —
// терминальная операция; тихий fallback «оценил как 0» опаснее явной ошибки).
// Невалидный ответ LLM → Error("invalid scorer response"), BACKLOG не трогается.

import type { BacklogEntry } from "./file-state-manager.js";
import { appendDecision, updateBacklogEntry } from "./file-state-manager.js";
import { SCORER_WEIGHTS, THRESHOLDS } from "./scorer-config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IdeaScores {
	relevance: number;
	value: number;
	risk: number;
	cost: number;
}

export type IdeaStatus = "ROADMAP" | "DECIDE" | "REJECTED";

export interface IdeaInput {
	id: string;
	idea: string;
	source: string;
}

export interface ScoreResult {
	id: string;
	score: number;
	status: IdeaStatus;
}

export interface IdeaScorerOptions {
	/** DI LLM: промпт → raw-ответ (JSON-объект с 4 оценками внутри). */
	llm?: (prompt: string) => Promise<string>;
	/** DI callback DECIDE-прерывания оператора. */
	requestDecision?: (question: string) => void;
	/** DI clock; default () => new Date(). */
	now?: () => Date | Promise<Date>;
}

export interface IdeaScorer {
	/** Чистая формула (БЕЗ clamp): 0.3×relevance + 0.2×value + 0.2×(1−risk) + 0.3×(1−cost). */
	computeScore(scores: IdeaScores): number;
	/** Полный цикл скоринга одной идеи: LLM → clamp → формула → пороги → BACKLOG/DECISIONS. */
	scoreIdea(missionDir: string, idea: IdeaInput): Promise<ScoreResult>;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createIdeaScorer(opts: IdeaScorerOptions = {}): IdeaScorer {
	const now = opts.now ?? (() => new Date());

	function computeScore(scores: IdeaScores): number {
		return (
			SCORER_WEIGHTS.relevance * scores.relevance +
			SCORER_WEIGHTS.value * scores.value +
			SCORER_WEIGHTS.riskInverse * (1 - scores.risk) +
			SCORER_WEIGHTS.costInverse * (1 - scores.cost)
		);
	}

	async function scoreIdea(missionDir: string, idea: IdeaInput): Promise<ScoreResult> {
		if (!opts.llm) throw new Error("llm is not configured");

		// Ошибки LLM пробрасываем (контраст с idea-generator), BACKLOG не трогаем.
		const raw = await opts.llm(buildPrompt(idea.idea));
		const scores = extractScores(raw); // невалидный ответ → "invalid scorer response"

		const clamped: IdeaScores = {
			relevance: clamp01(scores.relevance),
			value: clamp01(scores.value),
			risk: clamp01(scores.risk),
			cost: clamp01(scores.cost),
		};
		// Нормализация FP перед сравнением порогов (Math.round на 5 знаков).
		const score = Math.round(computeScore(clamped) * 1e5) / 1e5;
		const status: IdeaStatus =
			score >= THRESHOLDS.roadmap ? "ROADMAP" : score >= THRESHOLDS.decide ? "DECIDE" : "REJECTED";

		await updateBacklogEntry(missionDir, idea.id, {
			fit: clamped.relevance,
			value: clamped.value,
			risk: clamped.risk,
			cost: clamped.cost,
			score,
			status,
		} satisfies Partial<Omit<BacklogEntry, "id">>);

		if (status === "DECIDE") {
			// DECIDE не пишется в DECISIONS.md — ответ оператора запишется позже (F-17).
			opts.requestDecision?.(
				`Идея «${idea.idea}» получила оценку ${score} (диапазон DECIDE: ${THRESHOLDS.decide}–${THRESHOLDS.roadmap}). Принять идею в план?`,
			);
		} else if (status === "REJECTED") {
			const date = (await now()).toISOString();
			await appendDecision(missionDir, {
				id: `decision-${idea.id}`,
				date,
				status: "REJECTED",
				context: `Скорер отклонил идею «${idea.idea}»: fit=${clamped.relevance}, value=${clamped.value}, risk=${clamped.risk}, cost=${clamped.cost}, score=${score}.`,
				decision: `Отклонить идею: score ${score} ниже порога DECIDE (${THRESHOLDS.decide}).`,
				consequences: "Идея остаётся в BACKLOG.md со статусом REJECTED; в работу не берётся.",
			});
		}
		// ROADMAP: только обновление BACKLOG (запись в ROADMAP.md — отдельная интеграция).

		return { id: idea.id, score, status };
	}

	return { computeScore, scoreIdea };
}

// ─── Prompt (рубрика, русский стиль проекта — как idea-generator) ───────────

function buildPrompt(ideaText: string): string {
	const lines: string[] = [];
	lines.push("Ты — скорер идей миссии. Оцени идею по 4 критериям рубрики.");
	lines.push("");
	lines.push("## Идея");
	lines.push(ideaText);
	lines.push("");
	lines.push("## Рубрика (каждый критерий — число от 0.0 до 1.0)");
	lines.push("- relevance — соответствие целям миссии (0.0 = не соответствует, 1.0 = полностью соответствует);");
	lines.push("- value — ценность идеи для миссии (0.0 = бесполезна, 1.0 = максимальная ценность);");
	lines.push("- risk — уровень риска (0.0 = риска нет, 1.0 = максимальный риск);");
	lines.push("- cost — стоимость реализации (0.0 = бесплатно, 1.0 = максимальная стоимость).");
	lines.push("");
	lines.push("Верни ответ СТРОГО как JSON-объект без пояснений:");
	lines.push("```json");
	lines.push('{ "relevance": <0.0–1.0>, "value": <0.0–1.0>, "risk": <0.0–1.0>, "cost": <0.0–1.0> }');
	lines.push("```");
	return lines.join("\n");
}

// ─── LLM response parsing ───────────────────────────────────────────────────

/**
 * Извлекает JSON-объект из raw-ответа LLM (fenced-блок или проза — как в
 * idea-generator) и валидирует 4 числовых поля. Любой невалидный ответ
 * (мусор / битый JSON / не-объект / нет полей / не-числа) → бросает
 * Error("invalid scorer response"): скоринг не должен угадывать.
 */
function extractScores(raw: string): IdeaScores {
	const obj = extractJsonObject(raw);
	if (!obj) throw new Error("invalid scorer response");
	const scores: Partial<IdeaScores> = {};
	for (const key of ["relevance", "value", "risk", "cost"] as const) {
		const value = obj[key];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error("invalid scorer response");
		}
		scores[key] = value;
	}
	return scores as IdeaScores;
}

/** JSON-объект из ответа LLM; null, если распарсить объект не удалось. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
	const candidates: string[] = [];
	const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
	for (const match of raw.matchAll(fenceRe)) {
		candidates.push(match[1]);
	}
	if (candidates.length === 0) {
		candidates.push(raw);
	}
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		try {
			// Полное содержимое: массив/скаляр — не объект (без fallback на {...}).
			const parsed: unknown = JSON.parse(trimmed);
			if (isPlainObject(parsed)) return parsed;
			return null;
		} catch {
			// Про́за вокруг JSON — выделяем {...}.
		}
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
			if (isPlainObject(parsed)) return parsed;
		} catch {
			// битый JSON → пробуем следующий кандидат
		}
	}
	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}
