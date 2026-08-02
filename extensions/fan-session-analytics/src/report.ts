import { writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AnalyticsConfig, Finding, SessionScore, Trajectory } from "./types.js";

/**
 * Generate markdown report for a session and save atomically (tmp + rename).
 */
export async function generateReport(
	trajectory: Trajectory,
	score: SessionScore,
	cfg: AnalyticsConfig,
	cwd: string,
	mode: "metrics" | "full"
): Promise<string> {
	const reportDir = join(cwd, cfg.reports.dir);
	await mkdir(reportDir, { recursive: true });

	const dateStr = new Date().toISOString().slice(0, 10);
	const slug = sanitizeSlug(trajectory.sessionId);
	const fileName = `${slug}_${dateStr}.md`;
	const filePath = join(reportDir, fileName);

	const md = buildMarkdown(trajectory, score, mode);

	// Atomic write: tmp file then rename
	const tmpPath = filePath + ".tmp";
	await writeFile(tmpPath, md, "utf-8");
	await rename(tmpPath, filePath);

	return filePath;
}

function buildMarkdown(t: Trajectory, score: SessionScore, mode: "metrics" | "full"): string {
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

	// Full mode notice
	if (mode === "full") {
		lines.push(`---`);
		lines.push("");
		lines.push(`> **Примечание (этап A):** Семантическая оценка LLM-судьи пока недоступна.`);
		lines.push(`> Будет добавлена в этапе B: оценка по рубрикам —`);
		lines.push(`> уместность скила, полнота результата, качество декомпозиции,`);
		lines.push(`> экономичность, compliance и качество оркестрации.`);
		lines.push("");
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
	lines.push(`*Сгенерировано fan-session-analytics v1.0.0 (этап A MVP)*`);
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

function sanitizeSlug(id: string): string {
	return id.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 40);
}
