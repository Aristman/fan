/**
 * Рубрики LLM-судьи и построение промптов.
 */

import type { JudgeBatch } from "../types.js";

/** All rubric keys. */
export type RubricKey =
	| "skillAppropriateness"
	| "completeness"
	| "decomposition"
	| "economy"
	| "compliance"
	| "orchestrationQuality";

export const ALL_RUBRIC_KEYS: RubricKey[] = [
	"skillAppropriateness",
	"completeness",
	"decomposition",
	"economy",
	"compliance",
	"orchestrationQuality",
];

/** Rubric definition with Russian name and score criteria. */
export interface RubricDef {
	key: RubricKey;
	nameRu: string;
	criteria: Record<0 | 1 | 2 | 3, string>;
}

export const RUBRICS: Record<RubricKey, RubricDef> = {
	skillAppropriateness: {
		key: "skillAppropriateness",
		nameRu: "Уместность скилла",
		criteria: {
			0: "Skill was activated but completely irrelevant to the task, or a skill was clearly needed but never invoked.",
			1: "Skill was partially relevant — activated for a loosely related task, or a clearly needed skill was missed but work proceeded.",
			2: "Skill was relevant and applied, but there was a better-suited skill available, or minor gaps in skill usage.",
			3: "Skill choice was optimal — the right skill for the right task, invoked at the right time, with full utilization of its capabilities.",
		},
	},
	completeness: {
		key: "completeness",
		nameRu: "Полнота результата",
		criteria: {
			0: "The user's original request was largely unaddressed. Critical parts remain undone with no acknowledgment.",
			1: "Some parts of the request were addressed, but significant gaps remain. Promised work was left incomplete.",
			2: "Most of the request was fulfilled. Minor items remain or were deferred with acknowledgment. Edge cases may be unhandled.",
			3: "The request was fully addressed. All stated requirements are met, edge cases handled, and the user can proceed without follow-up.",
		},
	},
	decomposition: {
		key: "decomposition",
		nameRu: "Качество декомпозиции",
		criteria: {
			0: "Task breakdown was absent or nonsensical. Single monolithic task where decomposition was needed, or tasks had no logical ordering.",
			1: "Decomposition existed but was poor — tasks too coarse, missing dependencies, or workers assigned unrelated subtasks.",
			2: "Reasonable decomposition with mostly correct granularity. Some tasks could be split further or dependencies improved.",
			3: "Clean, logical decomposition with appropriate granularity. Dependencies are correct, tasks are self-contained, and parallel work is maximized.",
		},
	},
	economy: {
		key: "economy",
		nameRu: "Экономность",
		criteria: {
			0: "Massive waste — repeated file reads, redundant investigations, or a heavy pipeline (many workers/skill steps) for a trivial change.",
			1: "Notable inefficiency — some redundant steps, or a disproportionate flow (e.g., 20+ coordination calls for a 2-file edit).",
			2: "Reasonably efficient. Minor redundancies exist but the overall flow is proportional to the task size.",
			3: "Highly efficient. No wasted steps, the chosen flow (skill, number of workers) is proportional to the task complexity.",
		},
	},
	compliance: {
		key: "compliance",
		nameRu: "Соответствие регламенту",
		criteria: {
			0: "Major violations of stated conventions — wrong report format, no verification after implementation, ignored CLAUDE.md rules.",
			1: "Some compliance issues — partial adherence to conventions, missing some required steps (e.g., no build check after changes).",
			2: "Mostly compliant. Minor deviations from stated conventions, but the overall process follows the guidelines.",
			3: "Full compliance with all stated conventions — correct formats, verification after implementation, all CLAUDE.md/SOUL.md rules followed.",
		},
	},
	orchestrationQuality: {
		key: "orchestrationQuality",
		nameRu: "Качество оркестрации",
		criteria: {
			0: "Worker prompts lack context (no file paths, no task IDs). Coordinator merely relays results without synthesis. Failed verify verdicts are retried with identical prompts.",
			1: "Worker prompts have some context but are incomplete. Coordinator does minimal synthesis. Verify failures lead to weak strategy changes.",
			2: "Worker prompts are mostly self-contained. Coordinator synthesizes results adequately. Verify verdicts are acted upon with reasonable adjustments.",
			3: "Worker prompts are fully self-contained (context, file paths, task IDs). Coordinator actively synthesizes results into decisions. PASS verdicts advance work, FAIL verdicts lead to meaningfully changed prompts.",
		},
	},
};

/**
 * Build the judge prompt for a batch.
 * @param batch The compressed trajectory batch
 * @param rubricKeys Which rubrics to evaluate (may exclude n/a ones)
 * @returns systemPrompt and userText for the LLM call
 */
export function buildJudgePrompt(
	batch: JudgeBatch,
	rubricKeys: RubricKey[],
): { systemPrompt: string; userText: string } {
	const rubricDefs = rubricKeys.map((k) => RUBRICS[k]);

	const rubricSection = rubricDefs
		.map((r) => {
			const criteria = [0, 1, 2, 3]
				.map((s) => `    ${s}: ${r.criteria[s as 0 | 1 | 2 | 3]}`)
				.join("\n");
			return `  - **${r.key}** (${r.nameRu}):\n${criteria}`;
		})
		.join("\n");

	const systemPrompt = `You are an expert evaluator (judge) for an AI coding agent's session quality.
You receive a compressed trajectory of an agent session in batches.
Your task is to evaluate the session against specific rubrics.

## Rubrics (score 0-3 each)
${rubricSection}

## Output format
You MUST respond with valid JSON only. No markdown, no explanation outside JSON.

Required JSON structure:
\`\`\`
{
  "rubrics": {
    "<rubricKey>": {
      "score": 0-3,
      "justification": "обоснование на русском языке, со ссылками на номера шагов (например: 'шаги #5-#8 показывают...')",
      "stepRefs": [5, 8]
    }
  },
  "recommendations": [
    {
      "target": "skill" | "prompt" | "config" | "worker",
      "suggestion": "конкретное предложение на русском",
      "reason": "почему это поможет"
    }
  ]
}
\`\`\`

IMPORTANT:
- Justification MUST be in Russian (на русском языке).
- stepRefs are 1-based step numbers from the trajectory (e.g., #5 means step 5).
- Only include rubric keys listed above. Do not add extra keys.
- Recommendations should be actionable and specific.`;

	// Build user text: header + steps
	const recommendationsNote = batch.isLast
		? "\n\nThis is the LAST batch. Include 'recommendations' in your response with actionable suggestions."
		: "\n\nThis is NOT the last batch. Set 'recommendations' to an empty array [].";

	const userText = `${batch.header}\n\nCompressed trajectory steps:\n${batch.steps.join("\n")}${recommendationsNote}`;

	return { systemPrompt, userText };
}

/**
 * Determine which rubrics are applicable for a trajectory.
 * decomposition and orchestrationQuality are n/a when no delegate_task exists.
 */
export function getActiveRubricKeys(trajectory: { steps: Array<{ kind: string; toolName?: string }> }): RubricKey[] {
	const hasDelegateTask = trajectory.steps.some(
		(s) => s.kind === "tool_call" && s.toolName === "delegate_task",
	);

	if (hasDelegateTask) {
		return [...ALL_RUBRIC_KEYS];
	}

	return ALL_RUBRIC_KEYS.filter(
		(k) => k !== "decomposition" && k !== "orchestrationQuality",
	);
}
