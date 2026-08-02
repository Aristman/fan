import type { DetectFn, Finding } from "../types.js";

/**
 * D8: Compactions — number and position of compaction entries.
 */
export const detectCompactions: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	if (t.compactions === 0) {
		findings.push({
			detectorId: "D8",
			severity: "low",
			title: "No compactions in session",
			evidence: {
				entryIds: [],
				excerpt: `Session steps: ${t.steps.length}\nCompactions: 0`,
			},
		});
		return findings;
	}

	// Find positions of compactions
	const compactionPositions: number[] = [];
	for (let i = 0; i < t.steps.length; i++) {
		if (t.steps[i].kind === "compaction") {
			compactionPositions.push(i);
		}
	}

	const positionPct = compactionPositions
		.map((p) => `${p} (${((p / t.steps.length) * 100).toFixed(0)}%)`)
		.join(", ");

	findings.push({
		detectorId: "D8",
		severity: t.compactions > 5 ? "medium" : "low",
		title: `${t.compactions} compaction(s) at step positions: ${positionPct}`,
		evidence: {
			entryIds: compactionPositions.map((p) => t.steps[p].entryId),
			excerpt: `Total compactions: ${t.compactions}\nPositions: ${positionPct}\nTotal steps: ${t.steps.length}`,
		},
		recommendation:
			t.compactions > 5
				? "Frequent compactions suggest the session is hitting context limits. Consider breaking into smaller sessions."
				: undefined,
	});

	return findings;
};
