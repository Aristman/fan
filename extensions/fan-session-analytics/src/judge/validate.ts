/**
 * Парсинг и валидация ответа LLM-судьи.
 */

import type { JudgeRecommendation, RubricEvaluation } from "../types.js";
import { ALL_RUBRIC_KEYS, type RubricKey } from "./rubrics.js";

export interface JudgeParseResult {
	ok: boolean;
	rubrics?: Record<string, RubricEvaluation | "n/a">;
	recommendations?: JudgeRecommendation[];
	error?: string;
}

/**
 * Parse and validate a judge response from the LLM.
 * Handles:
 *   - Clean JSON
 *   - ```json fenced blocks
 *   - JSON with text prefix/suffix
 */
export function parseJudgeResponse(
	text: string,
	activeRubricKeys?: RubricKey[],
): JudgeParseResult {
	const keys = activeRubricKeys || ALL_RUBRIC_KEYS;

	// Extract JSON from the response
	const jsonStr = extractJson(text);
	if (!jsonStr) {
		return { ok: false, error: "No JSON found in judge response" };
	}

	let parsed: any;
	try {
		parsed = JSON.parse(jsonStr);
	} catch (e) {
		return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
	}

	// Validate structure
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: "Response is not a JSON object" };
	}

	// Parse rubrics
	const rubrics: Record<string, RubricEvaluation | "n/a"> = {};
	const validKeys = new Set(keys.map((k) => k));

	if (parsed.rubrics && typeof parsed.rubrics === "object") {
		for (const key of validKeys) {
			const val = parsed.rubrics[key];
			if (val === undefined || val === null) {
				rubrics[key] = "n/a";
				continue;
			}

			const evalResult = validateRubricEvaluation(val);
			if (evalResult) {
				rubrics[key] = evalResult;
			} else {
				rubrics[key] = "n/a";
			}
		}
	} else {
		// No rubrics object — all n/a
		for (const key of validKeys) {
			rubrics[key] = "n/a";
		}
	}

	// Parse recommendations (ignore unknown targets, keep valid ones)
	const recommendations: JudgeRecommendation[] = [];
	const validTargets = new Set(["skill", "prompt", "config", "worker"]);

	if (Array.isArray(parsed.recommendations)) {
		for (const rec of parsed.recommendations) {
			if (
				typeof rec === "object" &&
				rec !== null &&
				typeof rec.target === "string" &&
				validTargets.has(rec.target) &&
				typeof rec.suggestion === "string" &&
				typeof rec.reason === "string"
			) {
				recommendations.push({
					target: rec.target as JudgeRecommendation["target"],
					suggestion: rec.suggestion,
					reason: rec.reason,
				});
			}
		}
	}

	return { ok: true, rubrics, recommendations };
}

function validateRubricEvaluation(val: any): RubricEvaluation | null {
	if (typeof val !== "object" || val === null) return null;

	const score = val.score;
	if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 3) {
		return null;
	}

	const justification = typeof val.justification === "string" ? val.justification : "";
	const stepRefs = Array.isArray(val.stepRefs)
		? val.stepRefs.filter((n: any) => typeof n === "number" && Number.isInteger(n))
		: [];

	return { score, justification, stepRefs };
}

/**
 * Extract JSON string from a response that may contain:
 *   - Pure JSON
 *   - ```json ... ``` fenced block
 *   - Text prefix before JSON
 *   - Text after JSON
 */
function extractJson(text: string): string | null {
	const trimmed = text.trim();

	// Try direct parse first
	if (trimmed.startsWith("{")) {
		return trimmed;
	}

	// Try ```json fence
	const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i.exec(trimmed);
	if (fenceMatch) {
		return fenceMatch[1].trim();
	}

	// Try to find JSON object in the text
	const braceStart = trimmed.indexOf("{");
	const braceEnd = trimmed.lastIndexOf("}");
	if (braceStart !== -1 && braceEnd > braceStart) {
		return trimmed.slice(braceStart, braceEnd + 1);
	}

	return null;
}
