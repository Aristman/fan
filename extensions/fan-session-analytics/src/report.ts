import { writeFile, mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, GoldenComparison, JudgeResult, RubricEvaluation, SessionScore, Trajectory } from "./types.js";
import { RUBRICS, type RubricKey } from "./judge/rubrics.js";
import { escapeMd } from "./patterns.js";

/**
 * Read extension version from package.json (sync, best-effort).
 */
function getExtensionVersion(): string {
	try {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return typeof pkg.version === "string" ? pkg.version : "dev";
	} catch {
		return "dev";
	}
}

/**
 * Generate markdown report for a session and save atomically (tmp + rename).
 * @param reportDir Resolved absolute directory for report output.
 */
export async function generateReport(
	trajectory: Trajectory,
	score: SessionScore,
	reportDir: string,
	mode: "metrics" | "full",
	goldenComparison?: GoldenComparison,
): Promise<string> {
	await mkdir(reportDir, { recursive: true });

	const dateStr = new Date().toISOString().slice(0, 10);
	const slug = sanitizeSlug(trajectory.sessionId);
	const fileName = `${slug}_${dateStr}.md`;
	const filePath = join(reportDir, fileName);

	const md = buildMarkdown(trajectory, score, mode, goldenComparison);

	// Atomic write: tmp file then rename
	const tmpPath = filePath + ".tmp";
	await writeFile(tmpPath, md, "utf-8");
	await rename(tmpPath, filePath);

	return filePath;
}

function buildMarkdown(t: Trajectory, score: SessionScore, mode: "metrics" | "full", goldenComparison?: GoldenComparison): string {
	const lines: string[] = [];
	const durationMs = t.endedAt - t.startedAt;
	const durationMin = durationMs > 0 ? (durationMs / 60000).toFixed(1) : "n/a";

	// Header
	lines.push(`# Отчёт аналитики сессий`);
	lines.push("");
	lines.push(`| Поле | Значение |`);
	lines.push(`|------|----------|`);
	lines.push(`| **ID сессии** | \`${t.sessionId}\` |`);
	lines.push(`| **Дата** | ${new Date(t.startedAt).toISOString().slice(0, 19)} |`);
	lines.push(`| **Длительность** | ${durationMin} мин |`);
	lines.push(`| **CWD** | \`${t.cwd}\` |`);
	lines.push(`| **Шагов** | ${t.steps.length} |`);
	lines.push(`| **Скилы** | ${t.skillsActivated.length > 0 ? t.skillsActivated.join(", ") : "нет"} |`);
	lines.push(`| **Воркеры** | ${t.workersSpawned.length > 0 ? t.workersSpawned.map((w) => w.type).join(", ") : "нет"} |`);
	lines.push(`| **Уплотнения** | ${t.compactions} |`);
	lines.push(`| **Усечено** | ${t.truncated ? "да" : "нет"} |`);
	lines.push(`| **Режим** | ${mode} |`);
	lines.push("");

	// Score
	lines.push(`## Общий балл: ${score.total}/100`);
	lines.push("");

	const severityEmoji: Record<string, string> = {
		high: "🔴",
		medium: "🟡",
		low: "🔵",
	};

	lines.push(`| Серьёзность | Кол-во |`);
	lines.push(`|-------------|--------|`);
	lines.push(`| 🔴 Высокая | ${score.metrics["findingsHigh"] || 0} |`);
	lines.push(`| 🟡 Средняя | ${score.metrics["findingsMedium"] || 0} |`);
	lines.push(`| 🔵 Низкая | ${score.metrics["findingsLow"] || 0} |`);
	lines.push("");

	// Metrics table
	lines.push(`## Метрики`);
	lines.push("");
	lines.push(`| Метрика | Значение |`);
	lines.push(`|---------|----------|`);
	for (const [key, value] of Object.entries(score.metrics)) {
		if (key.startsWith("findings")) continue;
		lines.push(`| ${key} | ${value} |`);
	}
	lines.push("");

	// Findings
	const highFindings = score.findings.filter((f) => f.severity === "high");
	const mediumFindings = score.findings.filter((f) => f.severity === "medium");
	const lowFindings = score.findings.filter((f) => f.severity === "low");

	lines.push(`## Находки`);
	lines.push("");

	if (highFindings.length > 0) {
		lines.push(`### 🔴 Высокая серьёзность`);
		lines.push("");
		for (const f of highFindings) {
			lines.push(formatFinding(f, severityEmoji));
		}
	}

	if (mediumFindings.length > 0) {
		lines.push(`### 🟡 Средняя серьёзность`);
		lines.push("");
		for (const f of mediumFindings) {
			lines.push(formatFinding(f, severityEmoji));
		}
	}

	if (lowFindings.length > 0) {
		lines.push(`### 🔵 Низкая серьёзность`);
		lines.push("");
		for (const f of lowFindings) {
			lines.push(formatFinding(f, severityEmoji));
		}
	}

	if (score.findings.length === 0) {
		lines.push(`Находок нет — чистая сессия!`);
		lines.push("");
	}

	// Full mode — Judge section
	if (mode === "full" && score.judge) {
		lines.push(formatJudgeSection(score.judge));
	} else if (mode === "full") {
		lines.push(`---`);
		lines.push("");
		lines.push(`> **Примечание:** LLM-судья недоступен (модель не найдена или не настроена).`);
		lines.push(`> Балл основан только на детерминированных метриках.`);
		lines.push("");
	}

	// F12: Golden comparison section (only in full mode)
	if (mode === "full" && goldenComparison) {
		lines.push(formatGoldenSection(goldenComparison));
	} else if (mode === "full" && goldenComparison === undefined && score.judge && !score.judge.unavailable) {
		// No golden entry found — no section needed
	}

	// Tool call graph (text summary)
	lines.push(`## Сводка вызовов инструментов`);
	lines.push("");

	const toolCounts = new Map<string, number>();
	for (const step of t.steps) {
		if (step.kind === "tool_call" && step.toolName) {
			toolCounts.set(step.toolName, (toolCounts.get(step.toolName) || 0) + 1);
		}
	}

	if (toolCounts.size > 0) {
		lines.push(`| Инструмент | Вызовов |`);
		lines.push(`|------------|---------|`);
		const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
		for (const [name, count] of sorted) {
			lines.push(`| \`${name}\` | ${count} |`);
		}
		lines.push("");
	}

	// Footer
	lines.push(`---`);
	lines.push(`*Сгенерировано fan-session-analytics v${getExtensionVersion()}*`);
	lines.push(`*Дата отчёта: ${new Date().toISOString().slice(0, 19)}*`);

	return lines.join("\n");
}

function formatFinding(f: Finding, emoji: Record<string, string>): string {
	const lines: string[] = [];
	lines.push(`#### ${emoji[f.severity]} \`${f.detectorId}\` ${f.title}`);
	lines.push("");
	if (f.evidence.excerpt) {
		lines.push("```");
		lines.push(f.evidence.excerpt);
		lines.push("```");
		lines.push("");
	}
	if (f.recommendation) {
		lines.push(`**Рекомендация:** ${f.recommendation}`);
		lines.push("");
	}
	return lines.join("\n");
}

// ============================================================================
// Golden comparison report section (F12)
// ============================================================================

export function formatGoldenSection(comparison: GoldenComparison): string {
	const lines: string[] = [];

	lines.push(`---`);
	lines.push("");
	lines.push(`## Сравнение с эталоном (golden)`);
	lines.push("");

	if (comparison.unavailable) {
		lines.push(`> ⚠️ Сравнение с эталоном недоступно: ${comparison.verdict}`);
		lines.push("");
		return lines.join("\n");
	}

	const alignmentEmoji = comparison.alignment >= 3 ? "✅" : comparison.alignment >= 2 ? "🟡" : comparison.alignment >= 1 ? "🟠" : "❌";
	lines.push(`**Выравнивание:** ${alignmentEmoji} ${comparison.alignment}/3`);
	lines.push("");

	if (comparison.deviations.length > 0) {
		lines.push(`### Отклонения`);
		lines.push("");
		lines.push(`| Аспект | Текущая сессия | Эталонная сессия | Оценка |`);
		lines.push(`|--------|----------------|-------------------|--------|`);
		for (const d of comparison.deviations) {
			lines.push(`| ${escapeMd(d.aspect)} | ${escapeMd(d.current)} | ${escapeMd(d.golden)} | ${escapeMd(d.assessment)} |`);
		}
		lines.push("");
	}

	lines.push(`**Вердикт:** ${escapeMd(comparison.verdict)}`);
	lines.push("");

	return lines.join("\n");
}

function sanitizeSlug(id: string): string {
	return id.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 40);
}

// ============================================================================
// Judge report sections
// ============================================================================

function formatJudgeSection(judge: JudgeResult): string {
	const lines: string[] = [];

	lines.push(`---`);
	lines.push("");
	lines.push(`## Оценки судьи`);
	lines.push("");

	if (judge.unavailable) {
		lines.push(`> ⚠️ Судья недоступен. Балл основан только на детерминированных метриках.`);
		lines.push("");
		return lines.join("\n");
	}

	lines.push(`**Балл судьи:** ${judge.judgeScore}/100`);
	lines.push(`**Модель:** ${judge.model}`);
	lines.push(`**Батчей:** ${judge.batchCount}`);
	lines.push("");

	// Rubrics table
	lines.push(`| Рубрика | Балл | Обоснование | Шаги |`);
	lines.push(`|---------|------|-------------|------|`);

	for (const key of Object.keys(judge.rubrics) as RubricKey[]) {
		const rubricDef = RUBRICS[key];
		const nameRu = rubricDef ? rubricDef.nameRu : key;
		const val = judge.rubrics[key];

		if (val === "n/a") {
			lines.push(`| ${nameRu} | n/a | — | — |`);
		} else {
			const eval_ = val as RubricEvaluation;
			const scoreEmoji = eval_.score === 3 ? "✅" : eval_.score === 2 ? "🟡" : eval_.score === 1 ? "🟠" : "❌";
			const refs = eval_.stepRefs.length > 0 ? eval_.stepRefs.map((r) => `#${r}`).join(", ") : "—";
			const justification = eval_.justification.length > 120
				? eval_.justification.slice(0, 120) + "…"
				: eval_.justification;
			lines.push(`| ${scoreEmoji} ${nameRu} | ${eval_.score}/3 | ${justification} | ${refs} |`);
		}
	}
	lines.push("");

	// Recommendations
	if (judge.recommendations.length > 0) {
		lines.push(`## Рекомендации судьи`);
		lines.push("");

		for (const rec of judge.recommendations) {
			const targetEmoji: Record<string, string> = {
				skill: "🔧",
				prompt: "📝",
				config: "⚙️",
				worker: "👷",
			};
			const emoji = targetEmoji[rec.target] || "💡";
			lines.push(`- ${emoji} **[${rec.target}]** ${rec.suggestion}`);
			lines.push(`  *Причина:* ${rec.reason}`);
		}
		lines.push("");
	}

	// Usage
	lines.push(`### Расход на судью`);
	lines.push("");
	lines.push(`- Токенов: ${judge.usage.inputTokens + judge.usage.outputTokens} (вход: ${judge.usage.inputTokens}, выход: ${judge.usage.outputTokens})`);
	lines.push(`- Стоимость: ~$${judge.usage.cost.toFixed(4)}`);
	lines.push(`- Вызовов: ${judge.usage.calls}`);
	lines.push(`- Модель: ${judge.model}`);
	lines.push("");

	return lines.join("\n");
}
