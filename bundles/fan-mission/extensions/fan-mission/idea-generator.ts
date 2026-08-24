// F-19: Генератор идей — протокол «5 вопросов» (спека §3.1.3, генерация идей).
//
// Карточка:  docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-19
// Контракт:  зафиксирован в header-комментарии test/idea-generator.test.mjs.
//
// Порог: минимум 3 завершённые итерации с последней генерации. Источник —
// `.mission-loop.json` (currentIteration, fallback: длина «Сделано» в STATE.md);
// маркер последней генерации персистентен на диске в `.mission-ideas.json`
// (процессы смертны по спеке — состояние переживает рестарт).
//
// Формат записи BACKLOG.md — общая утилита backlog-format.ts (refactor-цель
// карточки); файловый IO записей — readBacklog/appendBacklog из
// file-state-manager.ts (переиспользуются как есть).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatIdeaEntry, formatIdeaId, maxIdeaNumber, normalizeIdea } from "./backlog-format.js";
import type { BacklogEntry } from "./file-state-manager.js";
import { appendBacklog, readBacklog, readRoadmap, readState, stripCurrentItemMarker } from "./file-state-manager.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const LOOP_STATE_FILE = ".mission-loop.json";
const IDEAS_MARKER_FILE = ".mission-ideas.json";
/** Минимум завершённых итераций с последней генерации. */
const GENERATION_INTERVAL = 3;
const DEFAULT_SOURCE = "idea-generator";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IdeaGeneratorOptions {
	/** DI LLM: промпт → raw-ответ (JSON-массив идей внутри). */
	llm?: (prompt: string) => Promise<string>;
	/** DI clock; default () => new Date(). */
	now?: () => Date | Promise<Date>;
}

export interface GenerateResult {
	added: number;
	skippedDuplicates: number;
}

export interface IdeaGenerator {
	buildPrompt(missionDir: string): Promise<string>;
	generate(missionDir: string): Promise<GenerateResult>;
}

interface CandidateIdea {
	idea: string;
	source: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createIdeaGenerator(opts: IdeaGeneratorOptions = {}): IdeaGenerator {
	const now = opts.now ?? (() => new Date());
	const llm = opts.llm;

	async function buildPrompt(missionDir: string): Promise<string> {
		const state = await readStateContext(missionDir);
		const pendingRoadmap = await readPendingRoadmapItems(missionDir);

		const lines: string[] = [];
		lines.push("Ты — генератор идей миссии. Изучи контекст и предложи идеи улучшения миссии.");
		lines.push("");
		lines.push("Для каждой идеи ответь на 5 вопросов (протокол «5 вопросов»):");
		lines.push("1. Какая цель у этой идеи?");
		lines.push("2. Какой критерий успеха?");
		lines.push("3. Какие риски?");
		lines.push("4. Какая оценка стоимости реализации?");
		lines.push("5. Есть ли метрика для измерения эффекта?");
		lines.push("");
		lines.push("## Контекст — сделано (STATE.md)");
		appendContextList(lines, state.done);
		lines.push("");
		lines.push("## Контекст — блокеры (STATE.md)");
		appendContextList(lines, state.blockers);
		lines.push("");
		lines.push("## Контекст — незавершённые пункты (ROADMAP.md)");
		appendContextList(lines, pendingRoadmap);
		lines.push("");
		lines.push("Верни ответ СТРОГО как JSON-массив объектов без пояснений:");
		lines.push("```json");
		lines.push('[{ "idea": "<текст идеи>", "source": "<источник>" }]');
		lines.push("```");
		return lines.join("\n");
	}

	async function generate(missionDir: string): Promise<GenerateResult> {
		const currentIteration = await readCurrentIteration(missionDir);
		const lastGenerationIteration = readLastGenerationIteration(missionDir);
		if (currentIteration - lastGenerationIteration < GENERATION_INTERVAL || !llm) {
			return { added: 0, skippedDuplicates: 0 };
		}

		let raw: string;
		try {
			raw = await llm(await buildPrompt(missionDir));
		} catch {
			// Контур не должен умирать из-за генерации идей. Маркер не обновляем —
			// следующая попытка повторится (маркер обновляется только после ответа LLM).
			return { added: 0, skippedDuplicates: 0 };
		}

		// LLM ответил — итерации обработаны независимо от результата парсинга.
		writeLastGenerationIteration(missionDir, currentIteration);

		const candidates = extractCandidateIdeas(raw);
		if (!candidates || candidates.length === 0) {
			return { added: 0, skippedDuplicates: 0 };
		}

		const existing = await readBacklogSafe(missionDir);
		const known = new Set(existing.map((entry) => normalizeIdea(entry.idea)));
		let added = 0;
		let skippedDuplicates = 0;
		let nextNum = maxIdeaNumber(existing) + 1;
		for (const candidate of candidates) {
			const key = normalizeIdea(candidate.idea);
			if (known.has(key)) {
				skippedDuplicates++;
				continue;
			}
			known.add(key);
			const date = (await now()).toISOString();
			await appendBacklog(
				missionDir,
				formatIdeaEntry({ id: formatIdeaId(nextNum), date, idea: candidate.idea, source: candidate.source }),
			);
			nextNum++;
			added++;
		}
		return { added, skippedDuplicates };
	}

	return { buildPrompt, generate };
}

// ─── Context readers (robust: отсутствие/битый файл → пустой контекст) ──────

async function readStateContext(missionDir: string): Promise<{ done: string[]; blockers: string[] }> {
	try {
		const state = await readState(missionDir);
		return { done: state.done, blockers: state.blockers };
	} catch {
		return { done: [], blockers: [] };
	}
}

async function readPendingRoadmapItems(missionDir: string): Promise<string[]> {
	let raw: string;
	try {
		raw = await readRoadmap(missionDir);
	} catch {
		return [];
	}
	const items: string[] = [];
	for (const line of raw.split("\n")) {
		const match = /^\s*- \[ \]\s+(.+)$/.exec(stripCurrentItemMarker(line));
		if (match) items.push(stripCurrentItemMarker(match[1].trim()));
	}
	return items;
}

function appendContextList(lines: string[], items: string[]): void {
	if (items.length === 0) {
		lines.push("- (нет записей)");
		return;
	}
	for (const item of items) {
		lines.push(`- ${item}`);
	}
}

// ─── Iteration counter & persistent generation marker ───────────────────────

/** currentIteration из `.mission-loop.json`; fallback — длина «Сделано» STATE.md. */
async function readCurrentIteration(missionDir: string): Promise<number> {
	const loopPath = join(missionDir, LOOP_STATE_FILE);
	if (existsSync(loopPath)) {
		try {
			const parsed = JSON.parse(readFileSync(loopPath, "utf8")) as { currentIteration?: unknown };
			if (typeof parsed.currentIteration === "number") {
				return parsed.currentIteration;
			}
		} catch {
			// битый файл → fallback ниже
		}
	}
	const state = await readStateContext(missionDir);
	return state.done.length;
}

/** Итерация последней генерации (`{ "lastGenerationIteration": <n> }`, default 0). */
function readLastGenerationIteration(missionDir: string): number {
	const markerPath = join(missionDir, IDEAS_MARKER_FILE);
	if (!existsSync(markerPath)) return 0;
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { lastGenerationIteration?: unknown };
		if (typeof parsed.lastGenerationIteration === "number") {
			return parsed.lastGenerationIteration;
		}
	} catch {
		// битый файл → default 0
	}
	return 0;
}

function writeLastGenerationIteration(missionDir: string, iteration: number): void {
	const content = JSON.stringify({ lastGenerationIteration: iteration }, null, 2);
	writeFileSync(join(missionDir, IDEAS_MARKER_FILE), content, "utf8");
}

// ─── LLM response parsing ───────────────────────────────────────────────────

/**
 * Извлекает JSON-массив из raw-ответа LLM: сначала fenced-блоки (```json ... ```),
 * затем проза. Невалидный JSON → null (генератор не падает, BACKLOG не трогается).
 */
function extractJsonArray(raw: string): unknown[] | null {
	const candidates: string[] = [];
	const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
	for (const match of raw.matchAll(fenceRe)) {
		candidates.push(match[1]);
	}
	if (candidates.length === 0) {
		candidates.push(raw);
	}
	for (const candidate of candidates) {
		const start = candidate.indexOf("[");
		const end = candidate.lastIndexOf("]");
		if (start < 0 || end <= start) continue;
		try {
			const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// битый JSON → пробуем следующий кандидат
		}
	}
	return null;
}

/** Валидные кандидаты из распаренного массива; источник по умолчанию — "idea-generator". */
function extractCandidateIdeas(raw: string): CandidateIdea[] | null {
	const parsed = extractJsonArray(raw);
	if (!parsed) return null;
	const candidates: CandidateIdea[] = [];
	for (const item of parsed) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.idea !== "string" || record.idea.trim() === "") continue;
		const source = typeof record.source === "string" && record.source.trim() !== "" ? record.source : DEFAULT_SOURCE;
		candidates.push({ idea: record.idea, source });
	}
	return candidates;
}

// ─── BACKLOG IO wrapper ─────────────────────────────────────────────────────

async function readBacklogSafe(missionDir: string): Promise<BacklogEntry[]> {
	try {
		return await readBacklog(missionDir);
	} catch {
		return [];
	}
}
