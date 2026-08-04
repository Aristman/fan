import type { DetectFn, Finding } from "../types.js";

/**
 * D2: Loops — ≥ 3 repeated toolCall with same name + canonical arguments
 * in a row or within a window of 10 steps.
 */
export const detectLoops: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];
	const toolCalls = t.steps.filter((s) => s.kind === "tool_call");

	if (toolCalls.length < 3) return findings;

	// Canonicalize arguments (sort keys, remove volatile fields)
	function canonArgs(args: Record<string, unknown> | undefined): string {
		if (!args) return "";
		try {
			const cleaned = { ...args };
			// Remove volatile fields that change each call
			delete (cleaned as any).timestamp;
			delete (cleaned as any).signal;
			const sorted = Object.keys(cleaned)
				.sort()
				.reduce((acc: Record<string, unknown>, k) => {
					acc[k] = cleaned[k];
					return acc;
				}, {});
			return JSON.stringify(sorted);
		} catch {
			return "";
		}
	}

	// Check consecutive runs
	let runStart = 0;
	let runCount = 1;

	for (let i = 1; i < toolCalls.length; i++) {
		const prev = toolCalls[i - 1];
		const curr = toolCalls[i];

		const sameName = prev.toolName === curr.toolName;
		const sameArgs = canonArgs(prev.args) === canonArgs(curr.args);

		if (sameName && sameArgs) {
			runCount++;
		} else {
			if (runCount >= 3) {
				const ids = toolCalls.slice(runStart, runStart + runCount).map((s) => s.entryId);
				findings.push({
					detectorId: "D2",
					severity: runCount >= 5 ? "high" : "medium",
					title: `Обнаружен цикл: ${runCount}× подряд "${prev.toolName}" с идентичными аргументами`,
					evidence: {
						entryIds: ids,
						excerpt: `Инструмент "${prev.toolName}" вызван ${runCount} раз подряд с одинаковыми аргументами`,
					},
					metrics: { loopCount: 1, loopLength: runCount },
					recommendation: "Повторяющиеся вызовы инструментов указывают на застревание агента. Проверьте, не выполняется ли операция с ошибкой без уведомления.",
				});
			}
			runStart = i;
			runCount = 1;
		}
	}

	// Check final run
	if (runCount >= 3) {
		const last = toolCalls[toolCalls.length - 1];
		const ids = toolCalls.slice(runStart, runStart + runCount).map((s) => s.entryId);
		findings.push({
			detectorId: "D2",
			severity: runCount >= 5 ? "high" : "medium",
			title: `Обнаружен цикл: ${runCount}× подряд "${last.toolName}" с идентичными аргументами`,
			evidence: {
				entryIds: ids,
				excerpt: `Инструмент "${last.toolName}" вызван ${runCount} раз подряд с одинаковыми аргументами`,
			},
			metrics: { loopCount: 1, loopLength: runCount },
			recommendation: "Повторяющиеся вызовы инструментов указывают на застревание агента.",
		});
	}

	// Check windowed duplicates (within 10 steps)
	const windowSize = 10;
	const windowDupes = new Map<string, number[]>();

	for (let i = 0; i < toolCalls.length; i++) {
		const key = `${toolCalls[i].toolName}::${canonArgs(toolCalls[i].args)}`;
		if (!windowDupes.has(key)) windowDupes.set(key, []);
		windowDupes.get(key)!.push(i);
	}

	for (const [key, indices] of windowDupes) {
		if (indices.length < 3) continue;
		// Check if any cluster of indices falls within windowSize
		for (let i = 0; i < indices.length - 2; i++) {
			const cluster = [indices[i]];
			for (let j = i + 1; j < indices.length; j++) {
				if (indices[j] - indices[i] <= windowSize) {
					cluster.push(indices[j]);
				}
			}
			if (cluster.length >= 3) {
				// Only report if not already caught by consecutive run check
				const toolName = key.split("::")[0];
				const ids = cluster.map((idx) => toolCalls[idx].entryId);
				const alreadyReported = findings.some(
					(f) => f.detectorId === "D2" && f.evidence.entryIds.some((id) => ids.includes(id))
				);
				if (!alreadyReported) {
					findings.push({
						detectorId: "D2",
						severity: "low",
						title: `Почти цикл: "${toolName}" вызван ${cluster.length}× в окне ${windowSize} шагов`,
						evidence: {
							entryIds: ids,
							excerpt: `Инструмент "${toolName}" вызван ${cluster.length} раз с похожими аргументами в окне ${windowSize} шагов (паттерн: ${toolCalls[indices[0]].toolName} чередуется с другими вызовами)`,
						},
						metrics: { loopCount: 1, loopLength: cluster.length },
					});
				}
				break; // One finding per key
			}
		}
	}

	return findings;
};
