import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@seaagents/fan-coding-agent";
import type { AnalyticsConfig } from "./types.js";
import type { ExtensionState, AutoSummary } from "./state.js";
import { loadState, saveState } from "./state.js";
import { parseSessionFile, isGarbageSession, containsSessionAnalyze } from "./parser.js";
import { buildTrajectory } from "./normalizer.js";
import { ALL_DETECTORS } from "./detectors/index.js";
import { trySqliteTokens } from "./detectors/d9-tokens-cost.js";
import { calculateScore } from "./score.js";
import { generateReport } from "./report.js";

/**
 * Format the F9 one-liner notification from an AutoSummary.
 * Example: "Аналитика прошлой сессии: 87/100, петель: 0, ошибок: 2, overhead: 45% — отчёт: .fan/reports/…"
 */
export function formatAutoSummaryLine(summary: AutoSummary): string {
	const loopCount = summary.loopCount ?? 0;
	const errorCount = summary.errorCount ?? 0;
	const overhead = summary.overheadPercent !== undefined ? `, overhead: ${summary.overheadPercent}%` : "";
	return (
		`Аналитика прошлой сессии: ${summary.score}/100, ` +
		`петель: ${loopCount}, ` +
		`ошибок: ${errorCount}${overhead}` +
		` — отчёт: ${summary.reportPath}`
	);
}

// ============================================================================
// session_shutdown handler (F9)
// ============================================================================

/**
 * Auto-analyze the current session on shutdown.
 * Runs pipeline in metrics mode, saves result to state.lastAutoSummary.
 * Never throws — all errors are silently caught.
 */
export async function handleSessionShutdown(
	_event: SessionShutdownEvent,
	ctx: ExtensionContext,
	extensionDir: string,
	cfg: AnalyticsConfig,
): Promise<void> {
	if (!cfg.autoAnalyze.enabled) return;

	// Get current session file
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return; // in-memory session, nothing to analyze

	// Self-reference check (BR3): skip sessions containing session_analyze calls
	// Reuse parser logic. We need to parse first anyway for garbage check.
	const parsed = await parseSessionFile(sessionFile);

	// Garbage session check (minEntries)
	if (isGarbageSession(parsed.entries, cfg)) return;

	// BR3: self-reference
	if (containsSessionAnalyze(parsed.entries)) return;

	// Build trajectory
	const trajectory = buildTrajectory(parsed, cfg.detectors?.idleThresholdMin);

	// Pre-fetch token data (best-effort)
	trajectory.dbTokensInfo = await trySqliteTokens(trajectory.sessionId);

	// Run detectors
	const allFindings = [];
	for (const detector of ALL_DETECTORS) {
		try {
			const findings = await detector.fn(trajectory, cfg);
			allFindings.push(...findings);
		} catch {
			// Never fail on a single detector
		}
	}

	const score = calculateScore(allFindings, trajectory.truncated);

	// Generate report
	const reportPath = await generateReport(trajectory, score, cfg, ctx.cwd, "metrics");

	// Extract key metrics for one-liner
	const loopCount = extractLoopCount(allFindings);
	const errorCount = extractErrorCount(allFindings);
	const overheadPercent = extractOverheadPercent(trajectory);

	// Save to state
	const state = await loadState(extensionDir);
	state.lastAutoSummary = {
		sessionId: trajectory.sessionId,
		score: score.total,
		findingsHigh: score.metrics["findingsHigh"] as number,
		findingsMedium: score.metrics["findingsMedium"] as number,
		findingsLow: score.metrics["findingsLow"] as number,
		reportPath,
		analyzedAt: new Date().toISOString(),
		loopCount,
		errorCount,
		overheadPercent,
	};
	await saveState(extensionDir, state);
}

// ============================================================================
// session_start handler (F9 — display)
// ============================================================================

/**
 * Show auto-analysis summary from the previous session if not yet shown.
 * Called on session_start. Uses ctx.ui.notify for display.
 */
export async function handleSessionStartAuto(
	_event: SessionStartEvent,
	ctx: ExtensionContext,
	extensionDir: string,
): Promise<void> {
	if (!ctx.hasUI) return;

	const state = await loadState(extensionDir);
	if (!state.lastAutoSummary) return;

	const summary = state.lastAutoSummary;

	// Already shown?
	if (summary.shownAt && summary.shownAt >= summary.analyzedAt) return;

	// Format one-liner
	const line = formatAutoSummaryLine(summary);
	ctx.ui.notify(line, "info");

	// Mark as shown
	summary.shownAt = new Date().toISOString();
	await saveState(extensionDir, state);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract loop count from D2 findings.
 */
function extractLoopCount(findings: Array<{ detectorId: string; metrics?: Record<string, number> }>): number {
	let count = 0;
	for (const f of findings) {
		if (f.detectorId === "D2" && f.metrics?.loopCount !== undefined) {
			count += f.metrics.loopCount;
		}
	}
	return count;
}

/**
 * Extract tool error count from D1 findings.
 */
function extractErrorCount(findings: Array<{ detectorId: string; metrics?: Record<string, number> }>): number {
	let count = 0;
	for (const f of findings) {
		if (f.detectorId === "D1" && f.metrics?.errorCount !== undefined) {
			count += f.metrics.errorCount;
		}
	}
	return count;
}

/**
 * Extract overhead percentage from trajectory metadata or D11 findings.
 */
function extractOverheadPercent(trajectory: { steps: Array<{ kind: string; toolName?: string }> }): number | undefined {
	const coordinationTools = new Set([
		"assess_task", "classify_task", "TaskCreate", "TaskUpdate",
		"list_tasks", "question", "questionnaire", "delegate_task",
	]);
	const totalCalls = trajectory.steps.filter((s) => s.kind === "tool_call").length;
	if (totalCalls === 0) return undefined;
	const coordCalls = trajectory.steps.filter(
		(s) => s.kind === "tool_call" && s.toolName && coordinationTools.has(s.toolName),
	).length;
	return Math.round((coordCalls / totalCalls) * 100);
}
