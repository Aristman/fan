/**
 * Run pattern mining on real session data and display results.
 *
 * Usage: bun run extensions/fan-session-analytics/scripts/run-real-mining.ts
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { parseSessionFile, findAllSessions, isGarbagePath, isGarbageSession, containsSessionAnalyze } from "../src/parser.js";
import { buildTrajectory } from "../src/normalizer.js";
import { minePatterns } from "../src/patterns.js";
import { formatPatternsSection } from "../src/patterns.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { AnalyticsConfig, Trajectory } from "../src/types.js";

async function main() {
	const sessionsDir = join(homedir(), ".fan", "agent", "sessions", "--C--Users-User-projects-agents-fan--");
	const cfg = DEFAULT_CONFIG;

	console.log(`=== Pattern Mining on Real Sessions ===`);
	console.log(`Directory: ${sessionsDir}`);
	console.log(`patternMinSessions: ${cfg.orchestration.patternMinSessions}`);
	console.log("");

	const sessionPaths = await findAllSessions(sessionsDir);
	console.log(`Total session files found: ${sessionPaths.length}`);
	console.log("");

	const trajectories: Trajectory[] = [];
	let skipped = 0;
	let errors = 0;

	for (const path of sessionPaths) {
		try {
			if (isGarbagePath(path, cfg)) {
				skipped++;
				continue;
			}

			const parsed = await parseSessionFile(path);

			if (isGarbageSession(parsed.entries, cfg)) {
				skipped++;
				continue;
			}

			if (containsSessionAnalyze(parsed.entries)) {
				skipped++;
				continue;
			}

			const trajectory = buildTrajectory(parsed, cfg.detectors?.idleThresholdMin);
			trajectories.push(trajectory);

			// Log basic info
			const workers = trajectory.workersSpawned.map((w) => w.type).join(", ");
			const toolCalls = trajectory.steps.filter((s) => s.kind === "tool_call").length;
			console.log(`  📄 ${trajectory.sessionId.slice(0, 12)}… — ${trajectory.steps.length} шагов, ${toolCalls} tool calls, воркеры: [${workers || "нет"}]`);
		} catch (err) {
			errors++;
			console.log(`  ⚠️ Error: ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	console.log("");
	console.log(`Parsed: ${trajectories.length}, Skipped: ${skipped}, Errors: ${errors}`);
	console.log("");

	if (trajectories.length < cfg.orchestration.patternMinSessions) {
		console.log(`Недостаточно сессий для майнинга (нужно ≥ ${cfg.orchestration.patternMinSessions})`);
		return;
	}

	// Run pattern mining
	console.log("=== Запуск майнинга паттернов ===");
	console.log("");

	const patterns = minePatterns(trajectories, cfg);

	console.log(`Найдено паттернов: ${patterns.length}`);
	console.log("");

	if (patterns.length > 0) {
		// Display each pattern
		for (let i = 0; i < patterns.length; i++) {
			const p = patterns[i];
			const kindLabel = p.kind === "worker_chain" ? "🔗 Цепочка воркеров"
				: p.kind === "tool_sequence" ? "🔧 Последовательность инструментов"
				: "📝 Шаблон промпта";
			const artifactLabel = p.suggestedArtifact === "worker" ? "👷 Воркер"
				: p.suggestedArtifact === "skill" ? "🔧 Скилл"
				: "📋 Правило";

			console.log(`${i + 1}. ${kindLabel}: \`${p.signature}\``);
			console.log(`   Сессий: ${p.sessionsCount}`);
			console.log(`   Примеры: ${p.exampleSessionIds.map((id) => id.slice(0, 12)).join(", ")}`);
			console.log(`   Артефакт: ${artifactLabel}`);
			console.log(`   Предложение: ${p.draftProposal.slice(0, 200)}${p.draftProposal.length > 200 ? "…" : ""}`);
			console.log("");
		}

		// Full section
		console.log("=== Секция для сводного отчёта ===");
		console.log("");
		console.log(formatPatternsSection(patterns, cfg.orchestration.patternMinSessions));
	} else {
		console.log(formatPatternsSection([], cfg.orchestration.patternMinSessions));
	}

	// Summary stats
	console.log("");
	console.log("=== Статистика по траекториям ===");
	const workerChains = trajectories.map((t) => t.workersSpawned.map((w) => w.type).join("→")).filter((c) => c.length > 0);
	const totalToolCalls = trajectories.reduce((sum, t) => sum + t.steps.filter((s) => s.kind === "tool_call").length, 0);
	const totalWorkers = trajectories.reduce((sum, t) => sum + t.workersSpawned.length, 0);
	console.log(`Всего шагов: ${trajectories.reduce((sum, t) => sum + t.steps.length, 0)}`);
	console.log(`Всего tool calls: ${totalToolCalls}`);
	console.log(`Всего воркеров: ${totalWorkers}`);
	console.log(`Сессий с воркерами: ${workerChains.length}`);

	// Show worker chain distribution
	if (workerChains.length > 0) {
		console.log("");
		console.log("Цепочки воркеров:");
		const chainCounts = new Map<string, number>();
		for (const chain of workerChains) {
			chainCounts.set(chain, (chainCounts.get(chain) || 0) + 1);
		}
		for (const [chain, count] of [...chainCounts.entries()].sort((a, b) => b[1] - a[1])) {
			console.log(`  ${chain}: ${count} сессий`);
		}
	}
}

main().catch((err) => {
	console.error("Mining error:", err);
	process.exit(1);
});
