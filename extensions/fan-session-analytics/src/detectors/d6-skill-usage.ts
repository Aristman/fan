import type { DetectFn, Finding } from "../types.js";

/**
 * D6: Skill Usage — detect skill activations and potential non-usage.
 * Signals: <skill name="..."> in user messages + read of SKILL.md files.
 */
export const detectSkillUsage: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	if (t.skillsActivated.length === 0) return findings;

	// Check if any tool calls followed the skill activation
	// (heuristic: after a skill is activated, there should be meaningful tool activity)
	const totalToolCalls = t.steps.filter((s) => s.kind === "tool_call").length;

	for (const skill of t.skillsActivated) {
		// Heuristic: check if skill was "activated" but the session had very few tool calls after
		// This is a rough proxy — real semantic analysis requires LLM judge (Phase B)
		findings.push({
			detectorId: "D6",
			severity: "low",
			title: `Скилл активирован: "${skill}" (${totalToolCalls} всего вызовов инструментов в сессии)`,
			evidence: {
				entryIds: [],
				excerpt: `Скиллы активированные в сессии: ${t.skillsActivated.join(", ")}\nВсего вызовов инструментов: ${totalToolCalls}`,
			},
		});
	}

	// Check for heavy skills activated in short sessions
	const heavySkillNames = [
		"feature-pipeline",
		"feature-roadmap",
		"dev-docs-pack",
		"research-spec-generator",
		"auto-tests",
		"deep-dive",
		"repo-explorer",
	];

	for (const skill of t.skillsActivated) {
		if (heavySkillNames.includes(skill) && totalToolCalls < 5) {
			findings.push({
				detectorId: "D6",
				severity: "medium",
				title: `Тяжёлый скилл "${skill}" активирован, но сессия содержит лишь ${totalToolCalls} вызовов инструментов`,
				evidence: {
					entryIds: [],
					excerpt: `Скилл: ${skill}\nВызовов инструментов: ${totalToolCalls}`,
				},
				recommendation: `Тяжёлый скилл "${skill}" мог не выполниться полностью. Проверьте, были ли выполнены инструкции скилла.`,
			});
		}
	}

	return findings;
};
