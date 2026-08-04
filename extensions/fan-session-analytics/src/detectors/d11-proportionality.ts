import type { AnalyticsConfig, DetectFn, Finding } from "../types.js";
import { isOrchestratorTool } from "../registry.js";

/**
 * D11: Flow Proportionality — ratio of coordination calls to total tool calls,
 * and heavy-skill-on-small-task detection.
 */
export const detectProportionality: DetectFn = (t, cfg) => {
	const findings: Finding[] = [];

	const toolCalls = t.steps.filter((s) => s.kind === "tool_call");
	if (toolCalls.length === 0) return findings;

	// Count coordination (orchestrator) calls
	const coordCalls = toolCalls.filter((s) => s.toolName && isOrchestratorTool(s.toolName));
	const coordRatio = coordCalls.length / toolCalls.length;

	if (coordCalls.length > 0 && coordRatio > cfg.orchestration.overheadRatioWarn) {
		findings.push({
			detectorId: "D11",
			severity: coordRatio > 0.6 ? "high" : "medium",
			title: `Высокие накладные расходы координации: ${(coordRatio * 100).toFixed(0)}% вызовов инструментов — оркестратор (${coordCalls.length}/${toolCalls.length})`,
			evidence: {
				entryIds: coordCalls.slice(0, 10).map((s) => s.entryId),
				excerpt: [
					`Всего вызовов инструментов: ${toolCalls.length}`,
					`Вызовы оркестратора: ${coordCalls.length} (${(coordRatio * 100).toFixed(0)}%)`,
					`Порог: ${(cfg.orchestration.overheadRatioWarn * 100).toFixed(0)}%`,
					`Инструменты координации: ${[...new Set(coordCalls.map((s) => s.toolName!))].join(", ")}`,
				].join("\n"),
			},
			recommendation: "Высокие накладные расходы координации указывают на возможное переусложнение задачи. Рассмотрите более простой подход.",
		});
	}

	// Heavy skill on small task
	const heavySkills = cfg.orchestration.heavySkills;
	const activatedHeavySkills = t.skillsActivated.filter((s) => heavySkills.includes(s));

	if (activatedHeavySkills.length > 0) {
		// Check output volume: count write/edit tool results to estimate diff size
		let totalLinesWritten = 0;
		let totalFilesWritten = 0;
		const filesWritten = new Set<string>();

		for (const step of t.steps) {
			if (step.kind === "tool_call") {
				if (step.toolName === "write" && step.args?.path) {
					filesWritten.add(String(step.args.path));
					totalFilesWritten++;
					// FIX MINOR 9: use real content length
					const content = step.args.content;
					if (typeof content === "string") {
						totalLinesWritten += content.split("\n").length;
					} else {
						totalLinesWritten += 10; // fallback heuristic
					}
				}
				if (step.toolName === "edit" && step.args?.path) {
					filesWritten.add(String(step.args.path));
					totalFilesWritten++;
					// FIX MINOR 9: sum lengths of newText from edits array
					const edits = step.args.edits;
					if (Array.isArray(edits)) {
						for (const e of edits) {
							if (e && typeof e.newText === "string") {
								totalLinesWritten += e.newText.split("\n").length;
							}
						}
					} else {
						totalLinesWritten += 10; // fallback heuristic
					}
				}
			}
		}

		const isSmallChange =
			totalLinesWritten < cfg.orchestration.smallChangeLines &&
			filesWritten.size < cfg.orchestration.smallChangeFiles;

		if (isSmallChange && totalFilesWritten > 0) {
			for (const skill of activatedHeavySkills) {
				findings.push({
					detectorId: "D11",
					severity: "high",
					title: `Тяжёлый скилл "${skill}" использован для мелкого изменения: ~${totalLinesWritten} строк в ${filesWritten.size} файл(ах)`,
					evidence: {
						entryIds: [],
						excerpt: [
							`Скилл: ${skill}`,
							`Файлы изменены: ${[...filesWritten].join(", ")}`,
							`Оценочно строк записано: ${totalLinesWritten}`,
							`Порог: < ${cfg.orchestration.smallChangeLines} строк в < ${cfg.orchestration.smallChangeFiles} файлах`,
							`Всего вызовов инструментов: ${toolCalls.length}`,
							`Вызовы координации: ${coordCalls.length}`,
						].join("\n"),
					},
					recommendation: `Тяжёлый пайплайн-скилл "${skill}" несоразмерен объёму изменения. Рассмотрите более лёгкий подход для мелких задач.`,
				});
			}
		}
	}

	return findings;
};
