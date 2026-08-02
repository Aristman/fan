import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./src/config.js";
import { runPipeline } from "./src/pipeline.js";
import type { AnalyzeOptions } from "./src/pipeline.js";

export default function sessionAnalyticsExtension(fan: ExtensionAPI) {
	// --- Tool: session_analyze ---
	fan.registerTool({
		name: "session_analyze",
		label: "Session Analyze",
		description:
			"Analyze completed session(s) and generate a quality report with metrics and findings. " +
			"Reads JSONL session files (read-only), runs deterministic detectors, and produces a markdown report.",
		parameters: Type.Object({
			target: Type.String({
				description:
					'Analysis target: "last" (most recent session for current cwd), ' +
					'"dir" (all sessions in cwd directory, respecting since/batchSize), ' +
					"or an explicit path to a .jsonl session file.",
			}),
			mode: Type.Union([Type.Literal("metrics"), Type.Literal("full")], {
				description:
					'"metrics" = deterministic metrics only; "full" = metrics + note about Phase B LLM-judge.',
				default: "metrics" as any,
			}),
			since: Type.Optional(
				Type.String({
					description: "ISO date — only analyze sessions modified after this date (dir mode).",
				})
			),
			batchSize: Type.Optional(
				Type.Number({
					description: "Max sessions to analyze in dir mode. Default: 20.",
				})
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const cwd = (ctx as any).cwd || process.cwd();
				const cfg = await loadConfig(__dirname, cwd);

				const opts: AnalyzeOptions = {
					target: params.target as "last" | "dir" | string,
					mode: (params.mode as "metrics" | "full") || "metrics",
					since: params.since,
					batchSize: params.batchSize,
					cwd,
					cfg,
				};

				const { results, summary } = await runPipeline(opts);

				// Build chat-friendly summary
				const chatLines: string[] = [];
				chatLines.push("### Session Analytics");
				chatLines.push("");

				for (const result of results) {
					const emoji =
						result.score.total >= 80
							? "✅"
							: result.score.total >= 50
								? "⚠️"
								: "❌";
					chatLines.push(
						`${emoji} **${result.slug}**: ${result.score.total}/100`
					);
					chatLines.push(
						`  Findings: ${result.score.metrics["findingsHigh"]}H / ${result.score.metrics["findingsMedium"]}M / ${result.score.metrics["findingsLow"]}L`
					);
					chatLines.push(`  Report: \`${result.reportPath}\``);

					// Top findings
					const top = result.score.findings
						.filter((f) => f.severity === "high" || f.severity === "medium")
						.slice(0, 5);

					for (const f of top) {
						const icon = f.severity === "high" ? "🔴" : "🟡";
						chatLines.push(`  ${icon} [${f.detectorId}] ${f.title}`);
					}

					if (result.skipped) {
						chatLines.push(`  ⚠️ ${result.skipped}`);
					}

					chatLines.push("");
				}

				if (results.length === 0) {
					chatLines.push("No sessions analyzed.");
				}

				return {
					content: [{ type: "text", text: chatLines.join("\n") }],
					details: { reportCount: results.length },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Session analytics error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { error: true },
				};
			}
		},
	});

	// --- Command: /session-analytics ---
	fan.registerCommand("session-analytics", {
		description: "Analyze session quality — /session-analytics [last|dir|<path>]",
		getArgumentCompletions(prefix: string) {
			const completions = ["last", "dir"];
			const filtered = completions.filter((c) => c.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((c) => ({ value: c, label: c }))
				: null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			try {
				const cwd = (ctx as any).cwd || process.cwd();
				const cfg = await loadConfig(__dirname, cwd);

				const parts = args.trim().split(/\s+/);
				let target = parts[0] || "last";
				const mode = parts[1] === "full" ? "full" : "metrics";

				// Validate target
				if (target !== "last" && target !== "dir" && !target.endsWith(".jsonl")) {
					ctx.ui.notify(
						`Usage: /session-analytics [last|dir|<path-to-jsonl>] [metrics|full]`,
						"warning"
					);
					return;
				}

				const opts: AnalyzeOptions = {
					target,
					mode: mode as "metrics" | "full",
					cwd,
					cfg,
				};

				ctx.ui.notify("Running session analytics...", "info");

				const { results, summary } = await runPipeline(opts);

				// Print summary to UI
				const lines: string[] = [];
				lines.push(`--- Session Analytics ---`);
				lines.push(`Sessions analyzed: ${results.length}`);
				lines.push("");

				for (const result of results) {
					const emoji =
						result.score.total >= 80
							? "✅"
							: result.score.total >= 50
								? "⚠️"
								: "❌";
					lines.push(
						`${emoji} ${result.slug}: ${result.score.total}/100`
					);
					lines.push(
						`  Findings: ${result.score.metrics["findingsHigh"]}H / ${result.score.metrics["findingsMedium"]}M / ${result.score.metrics["findingsLow"]}L`
					);
					lines.push(`  Report: ${result.reportPath}`);

					const top = result.score.findings
						.filter((f) => f.severity === "high")
						.slice(0, 3);
					for (const f of top) {
						lines.push(`  🔴 [${f.detectorId}] ${f.title}`);
					}

					lines.push("");
				}

				if (results.length === 0) {
					lines.push("No sessions found or all sessions were filtered.");
				}

				lines.push("-------------------------");

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(
					`Session analytics error: ${err instanceof Error ? err.message : String(err)}`,
					"error"
				);
			}
		},
	});
}
