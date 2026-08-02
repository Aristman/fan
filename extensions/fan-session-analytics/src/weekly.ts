import type { ExtensionContext, SessionStartEvent } from "@seaagents/fan-coding-agent";
import { writeFile, mkdir, stat as fsStat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AnalyticsConfig, SessionScore, Finding, PatternCandidate } from "./types.js";
import { formatPatternsSection } from "./patterns.js";
import type { ExtensionState, BatchStats } from "./state.js";
import { loadState, saveState } from "./state.js";
import { runPipeline } from "./pipeline.js";
import type { AnalyzeResult } from "./pipeline.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Guard against parallel weekly runs
let weeklyRunning = false;

/**
 * Check if a weekly batch is due based on lastBatchRun and weeklyDeferredUntil.
 */
export function isWeeklyDue(state: ExtensionState, now: Date = new Date()): boolean {
	// Deferred after user declined?
	if (state.weeklyDeferredUntil) {
		const deferred = new Date(state.weeklyDeferredUntil).getTime();
		if (now.getTime() < deferred) return false;
	}

	if (!state.lastBatchRun) return true;

	const lastRun = new Date(state.lastBatchRun).getTime();
	return (now.getTime() - lastRun) >= SEVEN_DAYS_MS;
}

/**
 * Handle session_start for F10 weekly batch analysis.
 * Checks if weekly is due, prompts user (if not silent), runs analysis.
 */
export async function handleSessionStartWeekly(
	_event: SessionStartEvent,
	ctx: ExtensionContext,
	extensionDir: string,
	cfg: AnalyticsConfig,
): Promise<void> {
	if (!cfg.weeklyBatch.enabled) return;
	if (weeklyRunning) return; // prevent parallel

	const state = await loadState(extensionDir);

	if (!isWeeklyDue(state)) return;

	const now = new Date();

	// Prompt user if not silent
	if (!cfg.weeklyBatch.silent && ctx.hasUI) {
		// Estimate session count for prompt
		const sessionCount = await estimateSessionCount(ctx.cwd, state, cfg);
		const confirmed = await ctx.ui.confirm(
			"Еженедельный анализ сессий",
			`Запустить еженедельный анализ сессий? (~${sessionCount} файлов)`,
		);
		if (!confirmed) {
			// Defer for 1 day so we don't ask on every start
			state.weeklyDeferredUntil = new Date(now.getTime() + ONE_DAY_MS).toISOString();
			await saveState(extensionDir, state);
			return;
		}
	}

	// Run weekly batch
	weeklyRunning = true;
	try {
		await runWeeklyBatch(ctx, extensionDir, cfg, state);
	} finally {
		weeklyRunning = false;
	}
}

/**
 * Run the weekly batch analysis and save results.
 */
async function runWeeklyBatch(
	ctx: ExtensionContext,
	extensionDir: string,
	cfg: AnalyticsConfig,
	state: ExtensionState,
): Promise<void> {
	const now = new Date();
	const since = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();

	// Run pipeline in dir mode, metrics only
	const pipelineResult = await runPipeline({
		target: "dir",
		mode: "metrics",
		since,
		batchSize: 20,
		cwd: ctx.cwd,
		cfg,
	});
	const { results } = pipelineResult;
	const patterns = pipelineResult.patterns;

	// Calculate current batch stats
	const currentStats = calculateBatchStats(results, since, now.toISOString());

	// Build trend comparison
	const trend = state.previousBatchStats
		? compareTrends(state.previousBatchStats, currentStats)
		: null;

	// Generate weekly report
	const reportPath = await generateWeeklyReport(results, currentStats, trend, ctx.cwd, cfg, patterns);

	// Update state
	state.lastBatchRun = now.toISOString();
	state.previousBatchStats = currentStats;
	// Clear deferral since we just ran
	delete state.weeklyDeferredUntil;

	// Track mtimes
	for (const result of results) {
		try {
			const s = await fsStat(result.sessionPath);
			state.analyzedMtimes[result.sessionPath] = s.mtimeMs;
		} catch {
			// ignore
		}
	}

	const saved = await saveState(extensionDir, state);
	if (!saved) {
		if (ctx.hasUI) {
			ctx.ui.notify("⚠️ Не удалось сохранить состояние еженедельного анализа (ошибка записи state.json).", "warning");
		}
	}

	// Notify user
	if (ctx.hasUI) {
		const trendLine = trend
			? ` (Δ: ${trend.avgScoreDelta >= 0 ? "+" : ""}${trend.avgScoreDelta} к среднему баллу)`
			: "";
		ctx.ui.notify(
			`✅ Еженедельный анализ завершён: ${results.length} сессий${trendLine}. Отчёт: ${reportPath}`,
			"info",
		);
	}
}

// ============================================================================
// Stats calculation
// ============================================================================

function calculateBatchStats(
	results: AnalyzeResult[],
	periodStart: string,
	periodEnd: string,
): BatchStats {
	if (results.length === 0) {
		return {
			avgScore: 0,
			sessionCount: 0,
			findingsBySeverity: { high: 0, medium: 0, low: 0 },
			topDetectors: [],
			periodStart,
			periodEnd,
		};
	}

	const totalScore = results.reduce((sum, r) => sum + r.score.total, 0);
	const avgScore = Math.round(totalScore / results.length);

	const findingsBySeverity = { high: 0, medium: 0, low: 0 };
	const detectorCounts = new Map<string, number>();

	for (const result of results) {
		for (const finding of result.score.findings) {
			findingsBySeverity[finding.severity]++;
			detectorCounts.set(finding.detectorId, (detectorCounts.get(finding.detectorId) || 0) + 1);
		}
	}

	const topDetectors = [...detectorCounts.entries()]
		.map(([detectorId, count]) => ({ detectorId, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 3);

	return {
		avgScore,
		sessionCount: results.length,
		findingsBySeverity,
		topDetectors,
		periodStart,
		periodEnd,
	};
}

// ============================================================================
// Trend comparison
// ============================================================================

export interface TrendDelta {
	avgScoreDelta: number;
	findingsHighDelta: number;
	findingsMediumDelta: number;
	findingsLowDelta: number;
	topDetectors: Array<{ detectorId: string; count: number }>;
}

export function compareTrends(prev: BatchStats, curr: BatchStats): TrendDelta {
	return {
		avgScoreDelta: curr.avgScore - prev.avgScore,
		findingsHighDelta: curr.findingsBySeverity.high - prev.findingsBySeverity.high,
		findingsMediumDelta: curr.findingsBySeverity.medium - prev.findingsBySeverity.medium,
		findingsLowDelta: curr.findingsBySeverity.low - prev.findingsBySeverity.low,
		topDetectors: curr.topDetectors,
	};
}

/**
 * Format trend delta as a readable block.
 */
export function formatTrendBlock(trend: TrendDelta): string {
	const arrow = (delta: number) => delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
	const sign = (delta: number) => delta > 0 ? `+${delta}` : String(delta);

	const lines: string[] = [];
	lines.push(`Средний балл: ${arrow(trend.avgScoreDelta)} ${sign(trend.avgScoreDelta)}`);
	lines.push(`Находки выс.: ${arrow(trend.findingsHighDelta)} ${sign(trend.findingsHighDelta)}`);
	lines.push(`Находки ср.:  ${arrow(trend.findingsMediumDelta)} ${sign(trend.findingsMediumDelta)}`);
	lines.push(`Находки низ.: ${arrow(trend.findingsLowDelta)} ${sign(trend.findingsLowDelta)}`);

	if (trend.topDetectors.length > 0) {
		lines.push(`Топ-детекторы: ${trend.topDetectors.map((d) => `${d.detectorId} (${d.count})`).join(", ")}`);
	}

	return lines.join("\n");
}

// ============================================================================
// Weekly report generation
// ============================================================================

async function generateWeeklyReport(
	results: AnalyzeResult[],
	stats: BatchStats,
	trend: TrendDelta | null,
	cwd: string,
	cfg: AnalyticsConfig,
	patterns?: PatternCandidate[],
): Promise<string> {
	const reportDir = join(cwd, cfg.reports.dir);
	await mkdir(reportDir, { recursive: true });

	const dateStr = new Date().toISOString().slice(0, 10);
	const fileName = `weekly_${dateStr}.md`;
	const filePath = join(reportDir, fileName);

	const md = buildWeeklyMarkdown(results, stats, trend, patterns, cfg);

	// Atomic write
	const tmpPath = filePath + ".tmp";
	await writeFile(tmpPath, md, "utf-8");
	const { rename } = await import("node:fs/promises");
	await rename(tmpPath, filePath);

	return filePath;
}

function buildWeeklyMarkdown(
	results: AnalyzeResult[],
	stats: BatchStats,
	trend: TrendDelta | null,
	patterns?: PatternCandidate[],
	cfg?: AnalyticsConfig,
): string {
	const lines: string[] = [];

	lines.push("# Еженедельный отчёт аналитики сессий");
	lines.push("");
	lines.push(`**Период:** ${stats.periodStart.slice(0, 10)} — ${stats.periodEnd.slice(0, 10)}`);
	lines.push(`**Сессий проанализировано:** ${stats.sessionCount}`);
	lines.push(`**Средний балл:** ${stats.avgScore}/100`);
	lines.push("");

	// Trend block
	if (trend) {
		lines.push("## Тренд (сравнение с прошлым периодом)");
		lines.push("");
		lines.push("| Метрика | Δ | Направление |");
		lines.push("|---------|---|-------------|");
		lines.push(`| Средний балл | ${formatDelta(trend.avgScoreDelta)} | ${trendArrow(trend.avgScoreDelta, true)} |`);
		lines.push(`| Находки выс. | ${formatDelta(trend.findingsHighDelta)} | ${trendArrow(trend.findingsHighDelta, false)} |`);
		lines.push(`| Находки ср.  | ${formatDelta(trend.findingsMediumDelta)} | ${trendArrow(trend.findingsMediumDelta, false)} |`);
		lines.push(`| Находки низ. | ${formatDelta(trend.findingsLowDelta)} | ${trendArrow(trend.findingsLowDelta, false)} |`);
		lines.push("");

		if (trend.topDetectors.length > 0) {
			lines.push("**Топ-детекторы:**");
			lines.push("");
			for (const d of trend.topDetectors) {
				lines.push(`- \`${d.detectorId}\`: ${d.count} находок`);
			}
			lines.push("");
		}
	} else {
		lines.push("> Первый еженедельный отчёт — тренд появится после следующего запуска.");
		lines.push("");
	}

	// Session table
	lines.push("## Сессии");
	lines.push("");
	lines.push("| Сессия | Балл | Находки (В/С/Н) | Отчёт |");
	lines.push("|--------|------|-----------------|-------|");

	for (const result of results) {
		const emoji = result.score.total >= 80 ? "✅" : result.score.total >= 50 ? "⚠️" : "❌";
		const h = result.score.metrics["findingsHigh"] || 0;
		const m = result.score.metrics["findingsMedium"] || 0;
		const l = result.score.metrics["findingsLow"] || 0;
		lines.push(`| ${emoji} ${result.slug} | ${result.score.total}/100 | ${h}/${m}/${l} | [отчёт](${result.reportPath}) |`);
	}

	lines.push("");

	// Summary stats
	lines.push("## Сводка по severity");
	lines.push("");
	lines.push(`- 🔴 Высокая: ${stats.findingsBySeverity.high}`);
	lines.push(`- 🟡 Средняя: ${stats.findingsBySeverity.medium}`);
	lines.push(`- 🔵 Низкая: ${stats.findingsBySeverity.low}`);
	lines.push("");

	if (stats.topDetectors.length > 0) {
		lines.push("## Топ-3 детектора");
		lines.push("");
		for (const d of stats.topDetectors) {
			lines.push(`1. \`${d.detectorId}\` — ${d.count} находок`);
		}
		lines.push("");
	}

	// F13: Pattern mining section
	if (patterns !== undefined && patterns.length > 0) {
		const minSessions = cfg?.orchestration.patternMinSessions ?? 3;
		lines.push("");
		lines.push(formatPatternsSection(patterns, minSessions));
	}

	lines.push("---");
	lines.push(`*Сгенерировано: ${new Date().toISOString().slice(0, 19)}*`);

	return lines.join("\n");
}

function formatDelta(delta: number): string {
	return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * Arrow indicator. If higherIsBetter is true, positive = ↑ good.
 * If higherIsBetter is false (findings), positive = ↑ bad.
 */
function trendArrow(delta: number, higherIsBetter: boolean): string {
	if (delta === 0) return "→ без изменений";
	const up = higherIsBetter ? "↑ улучшение" : "↑ ухудшение";
	const down = higherIsBetter ? "↓ ухудшение" : "↓ улучшение";
	return delta > 0 ? up : down;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Estimate session count for the prompt message.
 */
async function estimateSessionCount(
	cwd: string,
	_state: ExtensionState,
	_cfg: AnalyticsConfig,
): Promise<number> {
	try {
		const { findAllSessions, getSessionsDir } = await import("./parser.js");
		const dir = getSessionsDir(cwd);
		const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
		const sessions = await findAllSessions(dir, since);
		return sessions.length;
	} catch {
		return 0;
	}
}
