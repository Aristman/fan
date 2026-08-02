import type { DetectFn, Finding } from "../types.js";

/**
 * D4: Path Efficiency — number of steps vs heuristic minimum;
 * repeated reads of the same file (no progress).
 */
export const detectPathEfficiency: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	const toolCalls = t.steps.filter((s) => s.kind === "tool_call");
	const userMessages = t.steps.filter((s) => s.kind === "user");

	if (toolCalls.length === 0) return findings;

	// Count repeated reads of the same file
	const readCounts = new Map<string, { count: number; entryIds: string[] }>();
	for (const step of toolCalls) {
		if (step.toolName === "read" && step.args?.path) {
			const path = String(step.args.path);
			const existing = readCounts.get(path) || { count: 0, entryIds: [] };
			existing.count++;
			existing.entryIds.push(step.entryId);
			readCounts.set(path, existing);
		}
	}

	// Find files read 3+ times
	const repeatedReads: Array<{ path: string; count: number; entryIds: string[] }> = [];
	for (const [path, data] of readCounts) {
		if (data.count >= 3) {
			repeatedReads.push({ path, count: data.count, entryIds: data.entryIds });
		}
	}

	if (repeatedReads.length > 0) {
		const totalWasted = repeatedReads.reduce((s, r) => s + r.count - 1, 0);
		findings.push({
			detectorId: "D4",
			severity: totalWasted > 10 ? "high" : totalWasted > 5 ? "medium" : "low",
			title: `${totalWasted} избыточных чтений файлов: ${repeatedReads.length} файл(ов) прочитаны 3+ раз`,
			evidence: {
				entryIds: repeatedReads.flatMap((r) => r.entryIds.slice(1)).slice(0, 10),
				excerpt: repeatedReads
					.map((r) => `  ${r.path}: ${r.count}×`)
					.join("\n"),
			},
			recommendation: "Повторное чтение одного и того же файла указывает на то, что агент не сохраняет информацию между чтениями.",
		});
	}

	// Heuristic path length check
	// Minimum steps: 1 user message + N tool calls + 1 final text
	// If tool calls > 3× the number of user messages, flag as potentially inefficient
	if (userMessages.length > 0 && toolCalls.length > userMessages.length * 15) {
		const ratio = (toolCalls.length / userMessages.length).toFixed(1);
		findings.push({
			detectorId: "D4",
			severity: "medium",
			title: `Высокое соотношение шагов к запросам: ${toolCalls.length} вызовов инструментов на ${userMessages.length} запрос(ов) пользователя (${ratio}×)`,
			evidence: {
				entryIds: [],
				excerpt: `Всего вызовов инструментов: ${toolCalls.length}\nВсего сообщений пользователя: ${userMessages.length}\nСоотношение: ${ratio}×`,
			},
			recommendation: "Сессия может быть избыточной по сложности относительно количества запросов пользователя.",
		});
	}

	return findings;
};
