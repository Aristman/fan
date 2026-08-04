import type { AnalyticsConfig, Trajectory, SessionScore, JudgeDeps, GoldenComparison, PatternCandidate } from "./types.js";
import {
	parseSessionFile,
	isGarbagePath,
	isGarbageSession,
	containsSessionAnalyze,
	findLastSession,
	findAllSessions,
	getSessionsDir,
	sessionSlug,
} from "./parser.js";
import type { ParsedSession } from "./parser.js";
import { buildTrajectory } from "./normalizer.js";
import { ALL_DETECTORS } from "./detectors/index.js";
import { trySqliteTokens } from "./detectors/d9-tokens-cost.js";
import { calculateScore } from "./score.js";
import { generateReport } from "./report.js";
import { resolveReportsDir } from "./paths.js";
import { mkdir, rename, writeFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { compressTrajectory, runJudge } from "./judge/index.js";
import { findGoldenForTrajectory, compareWithGolden } from "./golden.js";
import { loadState, saveState, getAnalyzedEntry, markAnalyzed } from "./state.js";
import { minePatterns, formatPatternsSection } from "./patterns.js";

export interface AnalyzeOptions {
	target: "last" | "dir" | string; // "last" | path to jsonl | "dir"
	mode: "metrics" | "full";
	since?: string;
	batchSize?: number;
	cwd: string;
	cfg: AnalyticsConfig;
	/** Optional judge dependencies (injected for full mode). */
	judgeDeps?: JudgeDeps;
	/** Extension directory for loading state (golden entries, incremental). */
	extensionDir?: string;
	/** Force analysis even if session was already analyzed (dir mode). */
	force?: boolean;
}

export interface AnalyzeResult {
	sessionPath: string;
	slug: string;
	score: SessionScore;
	trajectory: Trajectory;
	reportPath: string;
	skipped?: string; // reason if skipped
	goldenComparison?: GoldenComparison; // F12
}

export interface PipelineOutput {
	results: AnalyzeResult[];
	summary: string;
	patterns?: PatternCandidate[]; // F13 — only in dir/weekly modes
	/** Path to the persisted dir-summary report (dir mode only). */
	summaryPath?: string;
	/** Number of sessions skipped (already analyzed, dir mode). */
	skippedCount: number;
}

/**
 * Run the analytics pipeline on one or more sessions.
 */
export async function runPipeline(opts: AnalyzeOptions): Promise<PipelineOutput> {
	const results: AnalyzeResult[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const allTrajectories: Trajectory[] = []; // for F13 pattern mining

	// Resolve reports directory once
	const reportDir = resolveReportsDir(opts.cfg, opts.cwd);

	// Load state for incremental skip
	const extensionDir = opts.extensionDir || "";
	const state = extensionDir ? await loadState(extensionDir) : null;
	let skippedCount = 0;

	let sessionPaths: string[] = [];

	if (opts.target === "last") {
		const dir = getSessionsDir(opts.cwd);
		const last = await findLastSession(dir);
		if (!last) {
			return {
				results: [],
				summary: "Сессии для текущего каталога не найдены.",
				skippedCount: 0,
			};
		}
		sessionPaths = [last];
	} else if (opts.target === "dir") {
		const dir = getSessionsDir(opts.cwd);
		sessionPaths = await findAllSessions(dir, opts.since);
	} else {
		// Explicit path
		sessionPaths = [opts.target];
	}

	// Apply batch size limit
	const batchSize = opts.batchSize || 20;
	if (opts.target === "dir" && sessionPaths.length > batchSize) {
		sessionPaths = sessionPaths.slice(-batchSize); // Most recent
	}

	for (const path of sessionPaths) {
		try {
			// Garbage path filter (only in dir mode)
			if (opts.target === "dir" && isGarbagePath(path, opts.cfg)) {
				continue;
			}

			// Incremental skip: dir mode — skip if already analyzed with same mtime
			if (opts.target === "dir" && state && !opts.force) {
				try {
					const fileStat = await fsStat(path);
					const existing = getAnalyzedEntry(state, path, fileStat.mtimeMs);
					if (existing) {
						skippedCount++;
						continue;
					}
				} catch {
					// Can't stat — proceed with analysis
				}
			}

			const parsed = await parseSessionFile(path);

			// Garbage session filter (only in dir mode)
			if (opts.target === "dir" && isGarbageSession(parsed.entries, opts.cfg)) {
				continue;
			}

			// BR3: Skip sessions with session_analyze in dir mode
			if (opts.target === "dir" && containsSessionAnalyze(parsed.entries)) {
				continue;
			}

			// Warning for explicit path with self-reference
			const isSelfReferencing = opts.target !== "dir" && containsSessionAnalyze(parsed.entries);

			// Check if already analyzed (for explicit target — add info note)
			let alreadyAnalyzedNote: string | undefined;
			if (opts.target !== "dir" && state) {
				try {
					const fileStat = await fsStat(path);
					const existing = state.analyzed?.[path];
					if (existing && existing.analyzedAt) {
						alreadyAnalyzedNote = `ℹ️ Эта сессия уже анализировалась ${existing.analyzedAt}`;
					}
				} catch {
					// Can't stat — proceed
				}
			}

			const trajectory = buildTrajectory(parsed, opts.cfg.detectors?.idleThresholdMin);

			// Pre-fetch token data from SQLite (async, best-effort) for D9
			trajectory.dbTokensInfo = await trySqliteTokens(trajectory.sessionId);

			const findings = await runDetectors(trajectory, opts.cfg);
			const score = calculateScore(findings, trajectory.truncated);

			// Run LLM judge in full mode
			if (opts.mode === "full" && opts.judgeDeps) {
				const batches = compressTrajectory(trajectory, opts.cfg);
				const judgeResult = await runJudge(batches, opts.judgeDeps, opts.cfg, trajectory);
				score.judge = judgeResult;
				score.combinedScore = calculateCombinedScore(score.total, judgeResult.judgeScore, judgeResult.unavailable);
				score.total = score.combinedScore;
			}

			// F12: Golden comparison (only in full mode)
			let goldenComparison: GoldenComparison | undefined;
			if (opts.mode === "full" && opts.judgeDeps) {
				const goldenState = await loadState(extensionDir);
				const goldenEntry = findGoldenForTrajectory(goldenState, trajectory);
				if (goldenEntry) {
					goldenComparison = await compareWithGolden(
						trajectory,
						goldenEntry,
						opts.judgeDeps,
						opts.cfg,
					);
				}
			}

			const reportPath = await generateReport(
				trajectory,
				score,
				reportDir,
				opts.mode,
				goldenComparison
			);

			// Mark as analyzed in state
			if (state) {
				try {
					const fileStat = await fsStat(path);
					markAnalyzed(state, path, fileStat.mtimeMs, reportPath);
				} catch {
					// Can't stat — still mark with 0 mtime
					markAnalyzed(state, path, 0, reportPath);
				}
			}

			// Track trajectory for F13 pattern mining
			allTrajectories.push(trajectory);

			// Build skipped message
			let skippedMsg: string | undefined;
			if (isSelfReferencing) {
				skippedMsg = "ПРЕДУПРЕЖДЕНИЕ: Сессия содержит вызовы session_analyze (самоссылание). Анализ может включать шум.";
			}
			if (alreadyAnalyzedNote) {
				skippedMsg = skippedMsg ? `${skippedMsg}\n   ${alreadyAnalyzedNote}` : alreadyAnalyzedNote;
			}

			results.push({
				sessionPath: path,
				slug: sessionSlug(path),
				score,
				trajectory,
				reportPath,
				skipped: skippedMsg,
				goldenComparison,
			});
		} catch (err) {
			errors.push({
				path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Save state with updated analyzed entries
	if (state && extensionDir) {
		await saveState(extensionDir, state);
	}

	// F13: Pattern mining (only in dir mode with multiple sessions)
	let patterns: PatternCandidate[] | undefined;
	if (opts.target === "dir" && allTrajectories.length >= (opts.cfg.orchestration.patternMinSessions || 3)) {
		patterns = minePatterns(allTrajectories, opts.cfg);
	}

	const summary = buildSummary(results, errors, patterns, opts.cfg, skippedCount);

	// Persist dir summary so the patterns section (F13) survives the chat
	let summaryPath: string | undefined;
	if (opts.target === "dir" && (results.length > 0 || skippedCount > 0)) {
		summaryPath = await writeSummaryReport(summary, reportDir);
	}

	return { results, summary, patterns, summaryPath, skippedCount };
}

/**
 * Write the dir-mode summary (incl. patterns section) atomically.
 */
async function writeSummaryReport(summary: string, reportDir: string): Promise<string> {
	await mkdir(reportDir, { recursive: true });
	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10);
	const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "-");
	const filePath = join(reportDir, `summary_${dateStr}_${timeStr}.md`);
	const tmpPath = filePath + ".tmp";
	await writeFile(tmpPath, summary, "utf-8");
	await rename(tmpPath, filePath);
	return filePath;
}

async function runDetectors(trajectory: Trajectory, cfg: AnalyticsConfig) {
	const allFindings = [];

	for (const detector of ALL_DETECTORS) {
		try {
			const findings = await detector.fn(trajectory, cfg);
			allFindings.push(...findings);
		} catch (err) {
			// Never fail on a single detector
			allFindings.push({
				detectorId: detector.id,
				severity: "low" as const,
				title: `Детектор ${detector.id} ошибка: ${err instanceof Error ? err.message : String(err)}`,
				evidence: { entryIds: [], excerpt: "" },
			});
		}
	}

	return allFindings;
}

/**
 * Calculate combined score: deterministic × 0.6 + judgeScore × 0.4.
 * If judge unavailable, use deterministic score only.
 */
function calculateCombinedScore(
	deterministicScore: number,
	judgeScore: number,
	judgeUnavailable?: boolean,
): number {
	if (judgeUnavailable || judgeScore === 0) {
		return deterministicScore;
	}
	return Math.round(deterministicScore * 0.6 + judgeScore * 0.4);
}

function buildSummary(
	results: AnalyzeResult[],
	errors: Array<{ path: string; error: string }>,
	patterns?: PatternCandidate[],
	cfg?: AnalyticsConfig,
	skippedCount: number = 0,
): string {
	const lines: string[] = [];

	if (results.length === 0 && errors.length === 0 && skippedCount === 0) {
		return "Сессии не проанализированы.";
	}

	lines.push(`## Сводка аналитики сессий`);
	lines.push("");
	lines.push(`Проанализировано сессий: ${results.length}`);
	if (skippedCount > 0) {
		lines.push(`Пропущено (уже проанализированы): ${skippedCount}`);
	}
	if (errors.length > 0) {
		lines.push(`Ошибок: ${errors.length}`);
	}
	lines.push("");

	for (const result of results) {
		const emoji = result.score.total >= 80 ? "✅" : result.score.total >= 50 ? "⚠️" : "❌";
		lines.push(`${emoji} **${result.slug}**: ${result.score.total}/100`);
		lines.push(`   Находки: ${result.score.metrics["findingsHigh"]} выс. / ${result.score.metrics["findingsMedium"]} ср. / ${result.score.metrics["findingsLow"]} низ.`);
		lines.push(`   Отчёт: ${result.reportPath}`);

		if (result.skipped) {
			lines.push(`   ⚠️ ${result.skipped}`);
		}

		// Top 5 findings
		const topFindings = result.score.findings
			.filter((f) => f.severity !== "low")
			.sort((a, b) => (a.severity === "high" ? -1 : 1))
			.slice(0, 5);

		if (topFindings.length > 0) {
			lines.push(`   Главные находки:`);
			for (const f of topFindings) {
				const icon = f.severity === "high" ? "🔴" : "🟡";
				lines.push(`     ${icon} [${f.detectorId}] ${f.title}`);
			}
		}

		lines.push("");
	}

	if (errors.length > 0) {
		lines.push(`### Ошибки`);
		for (const e of errors) {
			lines.push(`- ${e.path}: ${e.error}`);
		}
	}

	// F13: Pattern mining section in summary
	if (patterns !== undefined) {
		const minSessions = cfg?.orchestration.patternMinSessions ?? 3;
		lines.push("");
		lines.push(formatPatternsSection(patterns, minSessions));
	}

	return lines.join("\n");
}
