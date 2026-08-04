/**
 * LLM-судья клиент: вызывает LLM для каждого батча, агрегирует результаты.
 */

import type {
	AnalyticsConfig,
	JudgeBatch,
	JudgeDeps,
	JudgeRecommendation,
	JudgeResult,
	JudgeUsage,
	RubricEvaluation,
} from "../types.js";
import { buildJudgePrompt, getActiveRubricKeys, ALL_RUBRIC_KEYS, type RubricKey } from "./rubrics.js";
import { parseJudgeResponse } from "./validate.js";

/**
 * Run the judge over all batches and aggregate results.
 */
export async function runJudge(
	batches: JudgeBatch[],
	deps: JudgeDeps,
	cfg: AnalyticsConfig,
	trajectory: { steps: Array<{ kind: string; toolName?: string }> },
): Promise<JudgeResult> {
	const activeKeys = getActiveRubricKeys(trajectory);

	// Model selection
	const model = selectJudgeModel(cfg, deps);
	if (!model) {
		return {
			rubrics: buildAllNA(),
			judgeScore: 0,
			recommendations: [],
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 },
			model: "unavailable",
			unavailable: true,
			batchCount: batches.length,
		};
	}

	const modelLabel = `${model.provider}/${model.id}`;

	// Accumulators
	const usage: JudgeUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
	const rubricScores: Record<string, number[]> = {};
	const rubricJustifications: Record<string, string[]> = {};
	const rubricStepRefs: Record<string, number[]> = {};
	for (const key of activeKeys) {
		rubricScores[key] = [];
		rubricJustifications[key] = [];
		rubricStepRefs[key] = [];
	}
	const allRecommendations: JudgeRecommendation[] = [];

	// Process each batch
	for (const batch of batches) {
		const { systemPrompt, userText } = buildJudgePrompt(batch, activeKeys);

		const result = await callJudgeForBatch(
			model,
			systemPrompt,
			userText,
			deps,
			activeKeys,
		);

		// Accumulate usage
		if (result.usage) {
			usage.inputTokens += result.usage.inputTokens;
			usage.outputTokens += result.usage.outputTokens;
			usage.cost += result.usage.cost;
			usage.calls += result.usage.calls;
		}

		// Accumulate rubrics
		if (result.rubrics) {
			for (const [key, val] of Object.entries(result.rubrics)) {
				if (val !== "n/a" && rubricScores[key]) {
					rubricScores[key].push(val.score);
					if (val.justification && !rubricJustifications[key].includes(val.justification)) {
						rubricJustifications[key].push(val.justification);
					}
					if (val.stepRefs) {
						for (const ref of val.stepRefs) {
							if (!rubricStepRefs[key].includes(ref)) {
								rubricStepRefs[key].push(ref);
							}
						}
					}
				}
			}
		}

		// Accumulate recommendations
		if (result.recommendations) {
			allRecommendations.push(...result.recommendations);
		}
	}

	// Aggregate rubrics
	const rubrics: Record<string, RubricEvaluation | "n/a"> = {};
	const validRubricScores: number[] = [];

	for (const key of ALL_RUBRIC_KEYS) {
		if (!activeKeys.includes(key)) {
			rubrics[key] = "n/a";
			continue;
		}

		const scores = rubricScores[key] || [];
		if (scores.length === 0) {
			rubrics[key] = "n/a";
			continue;
		}

		const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
		const rounded = Math.round(avg * 2) / 2; // Round to 0.5
		validRubricScores.push(rounded);

		const justifications = rubricJustifications[key];
		const justification =
			justifications.length === 0
				? `Средний балл по ${scores.length} батчам.`
				: justifications.length === 1
					? justifications[0]
					: justifications
							.map((j, i) => `[батч ${i + 1}] ${j}`)
							.join(" ")
							.slice(0, 1000);

		rubrics[key] = {
			score: rounded,
			justification,
			stepRefs: rubricStepRefs[key].sort((a, b) => a - b),
		};
	}

	// Judge score: average of valid rubric scores / 3 * 100
	const judgeScore =
		validRubricScores.length > 0
			? Math.round(
					(validRubricScores.reduce((a, b) => a + b, 0) /
						validRubricScores.length /
						3) *
						100,
				)
			: 0;

	return {
		rubrics,
		judgeScore,
		recommendations: allRecommendations,
		usage,
		model: modelLabel,
		batchCount: batches.length,
	};
}

/**
 * Call the judge LLM for a single batch, with retry on invalid response.
 */
async function callJudgeForBatch(
	model: any,
	systemPrompt: string,
	userText: string,
	deps: JudgeDeps,
	activeKeys: RubricKey[],
): Promise<{
	rubrics?: Record<string, RubricEvaluation | "n/a">;
	recommendations?: JudgeRecommendation[];
	usage?: { inputTokens: number; outputTokens: number; cost: number; calls: number };
}> {
	const emptyUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 1 };

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const context = {
				systemPrompt: attempt === 0 ? systemPrompt : systemPrompt + STRICT_REMINDER,
				messages: [{ role: "user", content: userText }],
			};

			const result = await deps.complete(model, context);

			// Extract text from response
			const text = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("") || "";

			// Extract usage
			const usageData = extractUsage(result);

			// Parse response
			const parsed = parseJudgeResponse(text, activeKeys);

			if (parsed.ok && parsed.rubrics) {
				return {
					rubrics: parsed.rubrics,
					recommendations: parsed.recommendations || [],
					usage: { ...emptyUsage, ...usageData },
				};
			}

			// Invalid response — retry if first attempt
			if (attempt === 0) {
				continue;
			}

			// Second attempt also failed — mark all as n/a
			return { usage: { ...emptyUsage, ...usageData } };
		} catch (err) {
			// Exception in LLM call — this batch becomes n/a
			if (attempt === 1) {
				return { usage: emptyUsage };
			}
			// Retry on exception too
			continue;
		}
	}

	return { usage: emptyUsage };
}

/**
 * Select the model to use for the judge.
 * Priority:
 *   1. Configured provider+model from cfg → modelRegistry.find()
 *   2. Cheapest from getAvailable() (by cost.input)
 *   3. currentModel
 *   4. undefined (unavailable)
 */
function selectJudgeModel(cfg: AnalyticsConfig, deps: JudgeDeps): any | undefined {
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
	if (deps.currentModel) {
		return deps.currentModel;
	}

	// 4. Unavailable
	return undefined;
}

function extractUsage(result: any): { inputTokens: number; outputTokens: number; cost: number } {
	const usage = result.usage;
	if (!usage) return { inputTokens: 0, outputTokens: 0, cost: 0 };

	return {
		inputTokens: usage.input || 0,
		outputTokens: usage.output || 0,
		cost: usage.cost?.total || 0,
	};
}

function buildAllNA(): Record<string, RubricEvaluation | "n/a"> {
	const result: Record<string, RubricEvaluation | "n/a"> = {};
	for (const key of ALL_RUBRIC_KEYS) {
		result[key] = "n/a";
	}
	return result;
}

const STRICT_REMINDER = `

CRITICAL: Your previous response was not valid JSON. You MUST respond with ONLY valid JSON matching this exact template:
{
  "rubrics": {
    "<rubricKey>": {"score": 0, "justification": "...", "stepRefs": []}
  },
  "recommendations": []
}
Do not include any text before or after the JSON object.`;
