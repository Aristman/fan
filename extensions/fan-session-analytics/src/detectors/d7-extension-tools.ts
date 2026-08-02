import type { DetectFn, Finding } from "../types.js";
import { isBuiltinTool, getDynamicExtensionTools } from "../registry.js";

/**
 * D7: Extension Tool Usage — frequency of tool calls from extension tools
 * (i.e., tools not in the builtin registry).
 */
export const detectExtensionTools: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	const dynamicExtTools = getDynamicExtensionTools();
	const extensionToolCounts = new Map<string, number>();
	const builtinCounts = new Map<string, number>();

	for (const step of t.steps) {
		if (step.kind !== "tool_call" || !step.toolName) continue;

		if (isBuiltinTool(step.toolName) || dynamicExtTools.has(step.toolName)) {
			builtinCounts.set(step.toolName, (builtinCounts.get(step.toolName) || 0) + 1);
		} else {
			extensionToolCounts.set(step.toolName, (extensionToolCounts.get(step.toolName) || 0) + 1);
		}
	}

	if (extensionToolCounts.size === 0) return findings;

	const totalExtension = [...extensionToolCounts.values()].reduce((s, n) => s + n, 0);
	const totalBuiltin = [...builtinCounts.values()].reduce((s, n) => s + n, 0);
	const total = totalExtension + totalBuiltin;

	const summary = [...extensionToolCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name, count]) => `  - ${name}: ${count} вызов(ов)`)
		.join("\n");

	findings.push({
		detectorId: "D7",
		severity: "low",
		title: `Инструменты расширений: ${totalExtension} вызов(ов) по ${extensionToolCounts.size} инструмент(ам) (${total > 0 ? ((totalExtension / total) * 100).toFixed(1) : 0}% от всех вызовов)`,
		evidence: {
			entryIds: [],
			excerpt: `Распределение инструментов расширений:\n${summary}\n\nВстроенные инструменты: ${totalBuiltin}\nДинамический реестр: ${dynamicExtTools.size > 0 ? [...dynamicExtTools].join(", ") : "не сканировался"}`,
		},
	});

	return findings;
};
