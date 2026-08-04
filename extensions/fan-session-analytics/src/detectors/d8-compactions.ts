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
			title: "Нет компакций в сессии",
			evidence: {
				entryIds: [],
				excerpt: `Шагов сессии: ${t.steps.length}\nКомпакции: 0`,
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
		title: `${t.compactions} компакци(й/и) на позициях шагов: ${positionPct}`,
		evidence: {
			entryIds: compactionPositions.map((p) => t.steps[p].entryId),
			excerpt: `Всего компакций: ${t.compactions}\nПозиции: ${positionPct}\nВсего шагов: ${t.steps.length}`,
		},
		recommendation:
			t.compactions > 5
				? "Частые компакции указывают на приближение к лимитам контекста. Рассмотрите разбивку на более мелкие сессии."
				: undefined,
	});

	return findings;
};
