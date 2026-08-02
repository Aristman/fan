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
			title: `Skill activated: "${skill}" (${totalToolCalls} total tool calls in session)`,
			evidence: {
				entryIds: [],
				excerpt: `Skills activated in session: ${t.skillsActivated.join(", ")}\nTotal tool calls: ${totalToolCalls}`,
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
				title: `Heavy skill "${skill}" activated but session has only ${totalToolCalls} tool calls`,
				evidence: {
					entryIds: [],
					excerpt: `Skill: ${skill}\nTool calls: ${totalToolCalls}`,
				},
				recommendation: `Heavy skill "${skill}" may not have been fully executed. Check if the skill's instructions were followed.`,
			});
		}
	}

	return findings;
};
