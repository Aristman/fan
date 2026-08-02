import type { DetectFn, Finding } from "../types.js";

/**
 * D3: Step Duration — p50/p95 per step, total session duration.
 * Reports findings for unusually slow steps or sessions.
 */
export const detectDuration: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	const durations = t.steps
		.map((s) => s.durationMs)
		.filter((d): d is number => d !== undefined && d > 0);

	if (durations.length === 0) return findings;

	durations.sort((a, b) => a - b);

	const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
	const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
	const maxDuration = durations[durations.length - 1] || 0;

	const totalMs = t.endedAt - t.startedAt;
	const totalSec = Math.round(totalMs / 1000);
	const totalMin = Math.round(totalSec / 60 * 10) / 10;

	// Report slow steps (p95 > 5 minutes)
	if (p95 > 5 * 60 * 1000) {
		const slowSteps = t.steps.filter((s) => (s.durationMs || 0) > 5 * 60 * 1000);
		findings.push({
			detectorId: "D3",
			severity: p95 > 10 * 60 * 1000 ? "high" : "medium",
			title: `Slow steps: p95 = ${formatDuration(p95)}, ${slowSteps.length} step(s) over 5 minutes`,
			evidence: {
				entryIds: slowSteps.slice(0, 5).map((s) => s.entryId),
				excerpt: `p50: ${formatDuration(p50)}, p95: ${formatDuration(p95)}, max: ${formatDuration(maxDuration)}\nSession total: ${totalMin} min`,
			},
			recommendation: "Consider breaking long operations into smaller steps.",
		});
	}

	// Always add metrics (not a finding, stored in metrics by caller)
	// We push a low finding just to carry the metrics
	findings.push({
		detectorId: "D3",
		severity: "low",
		title: `Duration metrics: p50=${formatDuration(p50)}, p95=${formatDuration(p95)}, total=${totalMin}min`,
		evidence: {
			entryIds: [],
			excerpt: `Steps with timing: ${durations.length}\np50: ${formatDuration(p50)}\np95: ${formatDuration(p95)}\nMax step: ${formatDuration(maxDuration)}\nSession total: ${totalMin} min (${totalSec}s)`,
		},
	});

	return findings;
};

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}min`;
}
