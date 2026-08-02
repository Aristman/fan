/**
 * F12 — Золотые траектории: пометка, управление и сравнение с эталоном.
 */

import { dirname } from "node:path";
import type {
	AnalyticsConfig,
	GoldenComparison,
	GoldenEntry,
	JudgeDeps,
	Trajectory,
} from "./types.js";
import type { ExtensionState } from "./state.js";
import { parseSessionFile } from "./parser.js";
import { buildTrajectory } from "./normalizer.js";
import { compressTrajectory } from "./judge/batcher.js";

// ============================================================================
// CRUD operations on golden entries
// ============================================================================

/**
 * Пометить сессию как эталонную.
 * Парсит файл для извлечения sessionId и первого user-запроса.
 * Дедупликация по sessionId — повторная пометка обновляет label.
 */
export async function markGolden(
	state: ExtensionState,
	sessionPath: string,
	label: string,
): Promise<GoldenEntry> {
	const parsed = await parseSessionFile(sessionPath);
	const trajectory = buildTrajectory(parsed);

	// Extract first user request (first 300 chars)
	const firstUserStep = trajectory.steps.find((s) => s.kind === "user");
	let firstRequest = "";
	if (firstUserStep?.args) {
		const text =
			(firstUserStep.args.text as string) ||
			(firstUserStep.args.content as string) ||
			(firstUserStep.args.message as string) ||
			"";
		firstRequest = text.slice(0, 300);
	}

	// Also try extracting from raw entries (user messages don't have args in trajectory)
	if (!firstRequest) {
		for (const e of parsed.entries) {
			if ((e as any).type !== "message") continue;
			const msg = (e as any).message;
			if (msg?.role !== "user") continue;
			const content = msg.content;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				text = content.map((b: any) => b.text || (b.type === "text" ? b.text : "")).join("");
			}
			if (text.trim()) {
				firstRequest = text.trim().slice(0, 300);
				break;
			}
		}
	}

	const entry: GoldenEntry = {
		sessionId: trajectory.sessionId,
		path: sessionPath,
		label,
		markedAt: new Date().toISOString(),
		firstRequest,
	};

	// Dedup by sessionId — remove ALL existing entries with same sessionId, then add
	if (!state.golden) state.golden = [];
	state.golden = state.golden.filter((g) => g.sessionId !== trajectory.sessionId);
	state.golden.push(entry);

	return entry;
}

/**
 * Удалить эталонную сессию по sessionId.
 * @returns true если удалена, false если не найдена.
 */
export function unmarkGolden(state: ExtensionState, sessionId: string): boolean {
	if (!state.golden) return false;
	const idx = state.golden.findIndex((g) => g.sessionId === sessionId);
	if (idx < 0) return false;
	state.golden.splice(idx, 1);
	return true;
}

/**
 * Получить список всех эталонных сессий.
 */
export function listGolden(state: ExtensionState): GoldenEntry[] {
	return state.golden || [];
}

/**
 * Найти эталон для текущей траектории.
 * Совпадение = тот же каталог сессий (parent directory jsonl-файла).
 * Исключает текущую сессию (по sessionId и path).
 * При нескольких эталонах — детерминированный выбор: самый свежий markedAt.
 */
export function findGoldenForTrajectory(
	state: ExtensionState,
	trajectory: Trajectory,
): GoldenEntry | undefined {
	if (!state.golden || state.golden.length === 0) return undefined;
	const currentDir = dirname(trajectory.path);
	const candidates = state.golden.filter(
		(g) => dirname(g.path) === currentDir
			&& g.sessionId !== trajectory.sessionId
			&& g.path !== trajectory.path,
	);
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	// Deterministic: pick the most recently marked
	candidates.sort((a, b) => (b.markedAt > a.markedAt ? 1 : b.markedAt < a.markedAt ? -1 : 0));
	return candidates[0];
}

// ============================================================================
// Golden comparison via judge
// ============================================================================

/**
 * Сравнить текущую траекторию с эталонной через LLM-судью.
 * Переиспользует batcher: по 1 батчу на каждую траекторию.
 * При провале валидации — retry 1 раз, затем n/a.
 */
export async function compareWithGolden(
	currentTrajectory: Trajectory,
	goldenEntry: GoldenEntry,
	deps: JudgeDeps,
	cfg: AnalyticsConfig,
): Promise<GoldenComparison> {
	try {
		// Parse golden session and build trajectory
		const goldenParsed = await parseSessionFile(goldenEntry.path);
		const goldenTrajectory = buildTrajectory(goldenParsed, cfg.detectors?.idleThresholdMin);

		// Compress both trajectories — take first batch of each
		const currentBatches = compressTrajectory(currentTrajectory, cfg);
		const goldenBatches = compressTrajectory(goldenTrajectory, cfg);

		const currentSummary = currentBatches.length > 0
			? currentBatches[0].steps.join("\n")
			: "(пустая траектория)";
		const goldenSummary = goldenBatches.length > 0
			? goldenBatches[0].steps.join("\n")
			: "(пустая траектория)";

		// Also include last batch if golden has multiple batches
		let goldenExtendedSummary = goldenSummary;
		if (goldenBatches.length > 1) {
			const lastBatch = goldenBatches[goldenBatches.length - 1].steps.join("\n");
			goldenExtendedSummary = goldenSummary + "\n... (промежуточные шаги опущены) ...\n" + lastBatch;
		}

		let currentExtendedSummary = currentSummary;
		if (currentBatches.length > 1) {
			const lastBatch = currentBatches[currentBatches.length - 1].steps.join("\n");
			currentExtendedSummary = currentSummary + "\n... (промежуточные шаги опущены) ...\n" + lastBatch;
		}

		// Truncate summaries to prevent unbounded prompt size (max 2000 chars each)
		const MAX_SUMMARY_CHARS = 2000;
		if (currentExtendedSummary.length > MAX_SUMMARY_CHARS) {
			currentExtendedSummary = currentExtendedSummary.slice(0, MAX_SUMMARY_CHARS) + "\n...(обрезано)";
		}
		if (goldenExtendedSummary.length > MAX_SUMMARY_CHARS) {
			goldenExtendedSummary = goldenExtendedSummary.slice(0, MAX_SUMMARY_CHARS) + "\n...(обрезано)";
		}

		// Select model
		const model = selectModelForComparison(cfg, deps);
		if (!model) {
			return {
				alignment: 0,
				deviations: [],
				verdict: "Судья недоступен (модель не найдена)",
				unavailable: true,
			};
		}

		// Build comparison prompt
		const systemPrompt = buildComparisonSystemPrompt();
		const userText = buildComparisonUserText(
			currentTrajectory,
			goldenEntry,
			currentExtendedSummary,
			goldenExtendedSummary,
		);

		// Try with retry
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const context = {
					systemPrompt: attempt === 0 ? systemPrompt : systemPrompt + STRICT_REMINDER,
					messages: [{ role: "user", content: userText }],
				};

				const result = await deps.complete(model, context);
				const text = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("") || "";

				const comparison = parseComparisonResponse(text);
				if (comparison) {
					return comparison;
				}

				// Invalid response — retry if first attempt
				if (attempt === 0) continue;

				// Second attempt also failed
				return {
					alignment: 0,
					deviations: [],
					verdict: "n/a (невалидный ответ судьи)",
					unavailable: true,
				};
			} catch {
				if (attempt === 1) {
					return {
						alignment: 0,
						deviations: [],
						verdict: "n/a (ошибка вызова судьи)",
						unavailable: true,
					};
				}
			}
		}

		return {
			alignment: 0,
			deviations: [],
			verdict: "n/a",
			unavailable: true,
		};
	} catch {
		return {
			alignment: 0,
			deviations: [],
			verdict: "n/a (ошибка сравнения)",
			unavailable: true,
		};
	}
}

// ============================================================================
// Prompt building
// ============================================================================

function buildComparisonSystemPrompt(): string {
	return `You are an expert evaluator comparing two AI coding agent session trajectories.
You receive a COMPRESSED summary of a CURRENT session and a GOLDEN (reference) session.
Both sessions are from the same project area.

Your task is to compare the two trajectories and assess how well the current session aligns with the golden reference.

## Output format
You MUST respond with valid JSON only. No markdown, no explanation outside JSON.

Required JSON structure:
\`\`\`
{
  "alignment": 0-3,
  "deviations": [
    {
      "aspect": "название аспекта сравнения",
      "current": "описание текущего поведения",
      "golden": "описание эталонного поведения",
      "assessment": "оценка отклонения"
    }
  ],
  "verdict": "краткий вердикт на русском языке"
}
\`\`\`

## Alignment scale
- 0: Completely different approach or outcome
- 1: Partial alignment — significant deviations in approach or quality
- 2: Good alignment — minor deviations, overall approach similar
- 3: Excellent alignment — very similar approach and quality

IMPORTANT:
- All text fields (aspect, current, golden, assessment, verdict) MUST be in Russian.
- deviations array can be empty if alignment is 3.
- Include up to 5 deviations.`;
}

function buildComparisonUserText(
	current: Trajectory,
	golden: GoldenEntry,
	currentSummary: string,
	goldenSummary: string,
): string {
	return `## Текущая сессия
- **ID:** ${current.sessionId}
- **Первый запрос:** ${current.steps.find((s) => s.kind === "user")?.args?.text || current.steps.find((s) => s.kind === "user")?.args?.content || "(нет)"}
- **Шагов:** ${current.steps.length}
- **Воркеров:** ${current.workersSpawned.length > 0 ? current.workersSpawned.map((w) => w.type).join(", ") : "нет"}
- **Скилов:** ${current.skillsActivated.length > 0 ? current.skillsActivated.join(", ") : "нет"}

### Сжатая траектория (текущая):
${currentSummary}

---

## Эталонная сессия (golden)
- **Метка:** ${golden.label}
- **Первый запрос:** ${golden.firstRequest || "(нет)"}
- **ID:** ${golden.sessionId}

### Сжатая траектория (эталонная):
${goldenSummary}

---

Сравни два прогона одной задачной области. Верни JSON с alignment (0-3), таблицей отклонений и verdict.`;
}

const STRICT_REMINDER = `

CRITICAL: Your previous response was not valid JSON. You MUST respond with ONLY valid JSON matching this exact template:
{
  "alignment": 0-3,
  "deviations": [{"aspect": "...", "current": "...", "golden": "...", "assessment": "..."}],
  "verdict": "..."
}
Do not include any text before or after the JSON object.`;

// ============================================================================
// Response parsing
// ============================================================================

/**
 * Parse and validate a golden comparison response from the judge.
 */
export function parseComparisonResponse(text: string): GoldenComparison | null {
	const jsonStr = extractJson(text);
	if (!jsonStr) return null;

	let parsed: any;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;

	// Validate alignment
	const alignment = parsed.alignment;
	if (typeof alignment !== "number" || !Number.isInteger(alignment) || alignment < 0 || alignment > 3) {
		return null;
	}

	// Validate deviations — must be an array
	if (!Array.isArray(parsed.deviations)) {
		return null;
	}

	const deviations: GoldenComparison["deviations"] = [];
	for (const d of parsed.deviations) {
		if (
			typeof d === "object" &&
			d !== null &&
			typeof d.aspect === "string" &&
			typeof d.current === "string" &&
			typeof d.golden === "string" &&
			typeof d.assessment === "string"
		) {
			deviations.push({
				aspect: d.aspect,
				current: d.current,
				golden: d.golden,
				assessment: d.assessment,
			});
		}
	}

	// Limit deviations to 5 in output
	const limitedDeviations = deviations.slice(0, 5);

	// Validate verdict — must be a non-empty string
	if (typeof parsed.verdict !== "string" || parsed.verdict.trim() === "") {
		return null;
	}
	const verdict = parsed.verdict;

	return { alignment, deviations: limitedDeviations, verdict };
}

function extractJson(text: string): string | null {
	const trimmed = text.trim();

	if (trimmed.startsWith("{")) return trimmed;

	const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i.exec(trimmed);
	if (fenceMatch) return fenceMatch[1].trim();

	const braceStart = trimmed.indexOf("{");
	const braceEnd = trimmed.lastIndexOf("}");
	if (braceStart !== -1 && braceEnd > braceStart) {
		return trimmed.slice(braceStart, braceEnd + 1);
	}

	return null;
}

// ============================================================================
// Model selection (simplified version of judge client's selectJudgeModel)
// ============================================================================

function selectModelForComparison(cfg: AnalyticsConfig, deps: JudgeDeps): any | undefined {
	// 1. Configured model
	if (cfg.judge.provider && cfg.judge.model) {
		const found = deps.modelRegistry.find(cfg.judge.provider, cfg.judge.model);
		if (found) return found;
	}

	// 2. Cheapest available
	try {
		const available = deps.modelRegistry.getAvailable();
		if (available.length > 0) {
			const sorted = [...available].sort((a, b) => {
				const costA = a.cost?.input ?? Infinity;
				const costB = b.cost?.input ?? Infinity;
				return costA - costB;
			});
			return sorted[0];
		}
	} catch {
		// registry error
	}

	// 3. Current model
	if (deps.currentModel) return deps.currentModel;

	return undefined;
}
