import type { DetectFn, Finding } from "../types.js";

/**
 * D1: Tool Errors — ratio of toolResult.isError == true, grouped by toolName.
 */
export const detectToolErrors: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];
	const totalResults: Record<string, number> = {};
	const errorResults: Record<string, string[]> = {};

	for (const step of t.steps) {
		if (step.kind === "tool_result" && step.toolName) {
			totalResults[step.toolName] = (totalResults[step.toolName] || 0) + 1;
			if (step.isError) {
				if (!errorResults[step.toolName]) errorResults[step.toolName] = [];
				errorResults[step.toolName].push(step.entryId);
			}
		}
	}

	const totalCalls = Object.values(totalResults).reduce((s, n) => s + n, 0);
	const totalErrors = Object.values(errorResults).reduce((s, ids) => s + ids.length, 0);

	if (totalCalls === 0) return findings;

	const errorRate = totalErrors / totalCalls;

	if (totalErrors > 0) {
		const byTool = Object.entries(errorResults)
			.map(([name, ids]) => `  - ${name}: ${ids.length} error(s)`)
			.join("\n");

		findings.push({
			detectorId: "D1",
			severity: errorRate > 0.3 ? "high" : errorRate > 0.1 ? "medium" : "low",
			title: `${totalErrors} tool error(s) out of ${totalCalls} calls (${(errorRate * 100).toFixed(1)}%)`,
			evidence: {
				entryIds: Object.values(errorResults).flat().slice(0, 10),
				excerpt: `Error rate: ${(errorRate * 100).toFixed(1)}%\nBreakdown by tool:\n${byTool}`,
			},
			recommendation:
				errorRate > 0.2
					? "High tool error rate suggests issues with tool usage patterns. Review error contexts."
					: undefined,
		});
	}

	return findings;
};
