import type { DetectFn, Finding } from "../types.js";

/**
 * D3: Step Duration — p50/p95 per step, total session duration.
 * Only counts agent-controlled intervals (tool_exec, generation).
 * User-idle intervals (user thinking time, idle gaps > threshold) are excluded.
 */
export const detectDuration: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	// Separate agent-controlled steps from idle-excluded steps
	const agentSteps = t.steps.filter(
		(s) =>
			s.durationMs !== undefined &&
			s.durationMs > 0 &&
			(s.durationKind === "tool_exec" || s.durationKind === "generation"),
	);
	const idleExcluded = t.steps.filter(
		(s) =>
			s.durationMs !== undefined &&
			s.durationMs > 0 &&
			s.durationKind === "user_idle",
	).length;

	const durations = agentSteps
		.map((s) => s.durationMs!)
		.sort((a, b) => a - b);

	if (durations.length === 0) return findings;

	const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
	const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
	const maxDuration = durations[durations.length - 1] || 0;

	const totalMs = t.endedAt - t.startedAt;
	const totalSec = Math.round(totalMs / 1000);
	const totalMin = Math.round(totalSec / 60 * 10) / 10;

	// Report slow steps (p95 > 5 minutes) — only agent-controlled
	if (p95 > 5 * 60 * 1000) {
		const slowSteps = agentSteps.filter((s) => s.durationMs! > 5 * 60 * 1000);
		findings.push({
			detectorId: "D3",
			severity: p95 > 10 * 60 * 1000 ? "high" : "medium",
			title: `Медленные шаги: p95 = ${formatDuration(p95)}, ${slowSteps.length} шаг(ов) дольше 5 минут`,
			evidence: {
				entryIds: slowSteps.slice(0, 5).map((s) => s.entryId),
				excerpt: `p50: ${formatDuration(p50)}, p95: ${formatDuration(p95)}, макс: ${formatDuration(maxDuration)}\nСессия всего: ${totalMin} мин\nuser-idle исключён: ${idleExcluded} интервал(ов)`,
			},
			recommendation: "Рассмотрите возможность разбиения длительных операций на более мелкие шаги.",
			metrics: {
				p50Ms: p50,
				p95Ms: p95,
				maxMs: maxDuration,
				agentSteps: durations.length,
				idleExcluded,
				totalMin,
			},
		});
	}

	// Always add metrics finding (carries structured data for score extraction)
	findings.push({
		detectorId: "D3",
		severity: "low",
		title: `Метрики длительности (агент): p50=${formatDuration(p50)}, p95=${formatDuration(p95)}, всего=${totalMin}мин`,
		evidence: {
			entryIds: [],
			excerpt: `Шагов с таймингом (агентских): ${durations.length}\np50: ${formatDuration(p50)}\np95: ${formatDuration(p95)}\nМакс. шаг: ${formatDuration(maxDuration)}\nСессия всего: ${totalMin} мин (${totalSec}с)\nuser-idle исключён: ${idleExcluded} интервал(ов)`,
		},
		metrics: {
			durationP50Ms: p50,
			durationP95Ms: p95,
			durationMaxMs: maxDuration,
			durationMin: totalMin,
			agentSteps: durations.length,
			idleExcluded,
		},
	});

	return findings;
};

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}min`;
}
