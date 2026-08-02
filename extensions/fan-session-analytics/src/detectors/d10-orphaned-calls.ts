import type { DetectFn, Finding } from "../types.js";

/**
 * D10: Orphaned Calls — toolCall without a matching toolResult by toolCallId.
 */
export const detectOrphanedCalls: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	// Collect all toolCall IDs
	const callIds = new Map<string, { toolName: string; entryId: string }>();
	const resultIds = new Set<string>();

	for (const step of t.steps) {
		if (step.kind === "tool_call" && step.toolCallId) {
			callIds.set(step.toolCallId, {
				toolName: step.toolName || "unknown",
				entryId: step.entryId,
			});
		}
		if (step.kind === "tool_result" && step.toolCallId) {
			resultIds.add(step.toolCallId);
		}
	}

	const orphans: Array<{ toolCallId: string; toolName: string; entryId: string }> = [];
	for (const [callId, info] of callIds) {
		if (!resultIds.has(callId)) {
			orphans.push({ toolCallId: callId, ...info });
		}
	}

	if (orphans.length === 0) return findings;

	const byTool = new Map<string, number>();
	for (const o of orphans) {
		byTool.set(o.toolName, (byTool.get(o.toolName) || 0) + 1);
	}

	const summary = [...byTool.entries()]
		.map(([name, count]) => `  - ${name}: ${count}`)
		.join("\n");

	findings.push({
		detectorId: "D10",
		severity: orphans.length > 5 ? "high" : orphans.length > 2 ? "medium" : "low",
		title: `${orphans.length} «осиротевших» вызовов инструментов — нет соответствующего toolResult`,
		evidence: {
			entryIds: orphans.map((o) => o.entryId).slice(0, 10),
			excerpt: `«Осиротевшие» вызовы по инструментам:\n${summary}`,
		},
		recommendation:
			orphans.length > 2
				? "Множественные «осиротевшие» вызовы могут указывать на прерванное выполнение или усечение сессии."
				: undefined,
	});

	return findings;
};
