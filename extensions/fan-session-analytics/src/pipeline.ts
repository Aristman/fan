import type { AnalyticsConfig, Trajectory, SessionScore } from "./types.js";
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

export interface AnalyzeOptions {
	target: "last" | "dir" | string; // "last" | path to jsonl | "dir"
	mode: "metrics" | "full";
	since?: string;
	batchSize?: number;
	cwd: string;
	cfg: AnalyticsConfig;
}

export interface AnalyzeResult {
	sessionPath: string;
	slug: string;
	score: SessionScore;
	trajectory: Trajectory;
	reportPath: string;
	skipped?: string; // reason if skipped
}

/**
 * Run the analytics pipeline on one or more sessions.
 */
export async function runPipeline(opts: AnalyzeOptions): Promise<{
	results: AnalyzeResult[];
	summary: string;
}> {
	const results: AnalyzeResult[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	let sessionPaths: string[] = [];

	if (opts.target === "last") {
		const dir = getSessionsDir(opts.cwd);
		const last = await findLastSession(dir);
		if (!last) {
			return {
				results: [],
				summary: "No sessions found for current working directory.",
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

			const trajectory = buildTrajectory(parsed);

			// Pre-fetch token data from SQLite (async, best-effort) for D9
			trajectory.dbTokensInfo = await trySqliteTokens(trajectory.sessionId);

			const findings = await runDetectors(trajectory, opts.cfg);
			const score = calculateScore(findings, trajectory.truncated);
			const reportPath = await generateReport(
				trajectory,
				score,
				opts.cfg,
				opts.cwd,
				opts.mode
			);

			results.push({
				sessionPath: path,
				slug: sessionSlug(path),
				score,
				trajectory,
				reportPath,
				skipped: isSelfReferencing
					? "WARNING: This session contains session_analyze calls (self-reference). Analysis may include noise."
					: undefined,
			});
		} catch (err) {
			errors.push({
				path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const summary = buildSummary(results, errors);
	return { results, summary };
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
				title: `Detector ${detector.id} failed: ${err instanceof Error ? err.message : String(err)}`,
				evidence: { entryIds: [], excerpt: "" },
			});
		}
	}

	return allFindings;
}

function buildSummary(results: AnalyzeResult[], errors: Array<{ path: string; error: string }>): string {
	const lines: string[] = [];

	if (results.length === 0 && errors.length === 0) {
		return "No sessions analyzed.";
	}

	lines.push(`## Session Analytics Summary`);
	lines.push("");
	lines.push(`Sessions analyzed: ${results.length}`);
	if (errors.length > 0) {
		lines.push(`Errors: ${errors.length}`);
	}
	lines.push("");

	for (const result of results) {
		const emoji = result.score.total >= 80 ? "✅" : result.score.total >= 50 ? "⚠️" : "❌";
		lines.push(`${emoji} **${result.slug}**: ${result.score.total}/100`);
		lines.push(`   Findings: ${result.score.metrics["findingsHigh"]}H / ${result.score.metrics["findingsMedium"]}M / ${result.score.metrics["findingsLow"]}L`);
		lines.push(`   Report: ${result.reportPath}`);

		if (result.skipped) {
			lines.push(`   ⚠️ ${result.skipped}`);
		}

		// Top 5 findings
		const topFindings = result.score.findings
			.filter((f) => f.severity !== "low")
			.sort((a, b) => (a.severity === "high" ? -1 : 1))
			.slice(0, 5);

		if (topFindings.length > 0) {
			lines.push(`   Top findings:`);
			for (const f of topFindings) {
				const icon = f.severity === "high" ? "🔴" : "🟡";
				lines.push(`     ${icon} [${f.detectorId}] ${f.title}`);
			}
		}

		lines.push("");
	}

	if (errors.length > 0) {
		lines.push(`### Errors`);
		for (const e of errors) {
			lines.push(`- ${e.path}: ${e.error}`);
		}
	}

	return lines.join("\n");
}
