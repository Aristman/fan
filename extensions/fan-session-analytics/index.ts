import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	loadConfig,
	configExists,
	saveConfig,
	loadConfigWithSources,
	getConfigPath,
	validateConfig,
	DEFAULT_CONFIG,
} from "./src/config.js";
import { runPipeline } from "./src/pipeline.js";
import type { AnalyzeOptions } from "./src/pipeline.js";
import type { AnalyticsConfig } from "./src/types.js";

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
				}),
			),
			batchSize: Type.Optional(
				Type.Number({
					description: "Max sessions to analyze in dir mode. Default: 20.",
				}),
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
						`${emoji} **${result.slug}**: ${result.score.total}/100`,
					);
					chatLines.push(
						`  Findings: ${result.score.metrics["findingsHigh"]}H / ${result.score.metrics["findingsMedium"]}M / ${result.score.metrics["findingsLow"]}L`,
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

				// Hint when config.json doesn't exist
				if (!configExists(__dirname)) {
					chatLines.push(
						"ℹ️ Расширение работает на дефолтах. Настройка: `/session-analytics init`",
					);
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
		description:
			"Session analytics — /session-analytics [last|dir|init|config|<path>]",
		getArgumentCompletions(prefix: string) {
			const completions = ["last", "dir", "init", "config"];
			const filtered = completions.filter((c) => c.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((c) => ({ value: c, label: c }))
				: null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			try {
				const cwd = (ctx as any).cwd || process.cwd();
				const parts = args.trim().split(/\s+/);
				const sub = parts[0]?.toLowerCase() || "";

				// --- Subcommand: init ---
				if (sub === "init") {
					await handleInitWizard(ctx, cwd);
					return;
				}

				// --- Subcommand: config ---
				if (sub === "config") {
					await handleConfigView(ctx, cwd);
					return;
				}

				// --- Existing analysis subcommands: last, dir, <path> ---
				const cfg = await loadConfig(__dirname, cwd);
				let target = sub || "last";
				const mode = parts[1] === "full" ? "full" : "metrics";

				// Validate target
				if (
					target !== "last" &&
					target !== "dir" &&
					!target.endsWith(".jsonl")
				) {
					ctx.ui.notify(
						"Usage: /session-analytics [last|dir|init|config|<path-to-jsonl>] [metrics|full]",
						"warning",
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
				lines.push("--- Session Analytics ---");
				lines.push(`Sessions analyzed: ${results.length}`);
				lines.push("");

				for (const result of results) {
					const emoji =
						result.score.total >= 80
							? "✅"
							: result.score.total >= 50
								? "⚠️"
								: "❌";
					lines.push(`${emoji} ${result.slug}: ${result.score.total}/100`);
					lines.push(
						`  Findings: ${result.score.metrics["findingsHigh"]}H / ${result.score.metrics["findingsMedium"]}M / ${result.score.metrics["findingsLow"]}L`,
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

				// Hint when config.json doesn't exist
				if (!configExists(__dirname)) {
					lines.push("");
					lines.push(
						"ℹ️ Расширение работает на дефолтах. Настройка: /session-analytics init",
					);
				}

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(
					`Session analytics error: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}

// ============================================================================
// Init Wizard
// ============================================================================

async function handleInitWizard(
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"UI not available. Edit config.json manually or copy config.example.json.",
		);
		return;
	}

	const extensionDir = __dirname;
	const hasExistingConfig = configExists(extensionDir);

	const cancelled = () => {
		ctx.ui.notify("⚙️ Init wizard cancelled.");
		ctx.ui.setWidget("session-analytics", undefined);
	};

	ctx.ui.setWidget("session-analytics", [
		"⚙️ SESSION ANALYTICS — Configuration Wizard",
		"",
		"Answer the questions below to configure session analytics.",
		"Press Esc to cancel at any time.",
	]);

	// Check existing config
	if (hasExistingConfig) {
		const overwrite = await ctx.ui.confirm(
			"Config exists",
			"config.json already exists. Overwrite?",
		);
		if (!overwrite) {
			ctx.ui.notify("Keeping existing config.json.");
			ctx.ui.setWidget("session-analytics", undefined);
			return;
		}
	}

	// Load current (or default) values for pre-filling
	const currentCfg = await loadConfig(extensionDir, cwd);

	// 1. Auto-analyze on session end (reserved, phase C)
	const autoAnalyzeChoice = await ctx.ui.select("Auto-analyze on session end (Phase C, reserved)", [
		`Off (current: ${currentCfg.autoAnalyze.enabled ? "on" : "off"})`,
		"On",
	]);
	if (autoAnalyzeChoice === undefined) {
		cancelled();
		return;
	}
	const autoAnalyzeEnabled = autoAnalyzeChoice.startsWith("On");

	// 2. Weekly batch
	const weeklyBatchChoice = await ctx.ui.select("Weekly batch analysis", [
		`Off (current: ${currentCfg.weeklyBatch.enabled ? "on" : "off"})`,
		"On",
	]);
	if (weeklyBatchChoice === undefined) {
		cancelled();
		return;
	}
	const weeklyBatchEnabled = weeklyBatchChoice.startsWith("On");

	// 3. Coordination overhead threshold
	const overheadStr = await ctx.ui.input(
		`Coordination overhead warn threshold (0.1-1.0, current: ${currentCfg.orchestration.overheadRatioWarn})`,
		String(currentCfg.orchestration.overheadRatioWarn),
	);
	if (overheadStr === undefined) {
		cancelled();
		return;
	}
	let overheadRatioWarn = parseFloat(overheadStr);
	if (Number.isNaN(overheadRatioWarn)) {
		overheadRatioWarn = DEFAULT_CONFIG.orchestration.overheadRatioWarn;
	}
	overheadRatioWarn = Math.max(0.1, Math.min(1.0, overheadRatioWarn));

	// 4. Heavy skills list
	const defaultSkills = currentCfg.orchestration.heavySkills;
	const editSkillsChoice = await ctx.ui.select(
		`Heavy skills (${defaultSkills.length} configured: ${defaultSkills.slice(0, 3).join(", ")}${defaultSkills.length > 3 ? "..." : ""})`,
		["Keep current list", "Edit list"],
	);
	if (editSkillsChoice === undefined) {
		cancelled();
		return;
	}

	let heavySkills = [...defaultSkills];
	if (editSkillsChoice.startsWith("Edit")) {
		ctx.ui.setWidget("session-analytics", [
			"⚙️ Heavy Skills Editor",
			"",
			"For each skill: Keep or Remove. Then add new ones.",
		]);

		const editedSkills: string[] = [];
		for (let i = 0; i < defaultSkills.length; i++) {
			const skill = defaultSkills[i];
			const action = await ctx.ui.select(
				`[${i + 1}/${defaultSkills.length}] "${skill}"`,
				["Keep", "Remove"],
			);
			if (action === undefined) {
				cancelled();
				return;
			}
			if (action === "Keep") {
				editedSkills.push(skill);
			}
		}

		// Add new skills
		let addMore = true;
		while (addMore) {
			const addChoice = await ctx.ui.select("Add new heavy skill?", [
				"Yes",
				"No",
			]);
			if (addChoice === undefined) {
				cancelled();
				return;
			}
			if (addChoice === "No") {
				addMore = false;
			} else {
				const newSkill = await ctx.ui.input("Enter skill name", "");
				if (newSkill === undefined) {
					cancelled();
					return;
				}
				const trimmed = newSkill.trim();
				if (trimmed && !editedSkills.includes(trimmed)) {
					editedSkills.push(trimmed);
				}
			}
		}

		heavySkills = editedSkills;
	}

	// 5. Reports directory
	const reportsDir = await ctx.ui.input(
		`Reports directory (current: ${currentCfg.reports.dir})`,
		currentCfg.reports.dir,
	);
	if (reportsDir === undefined) {
		cancelled();
		return;
	}
	const reportsDirFinal = reportsDir.trim() || DEFAULT_CONFIG.reports.dir;

	// 6. Judge model (reserved, phase B)
	ctx.ui.setWidget("session-analytics", [
		"⚙️ Judge Model (Phase B, reserved)",
		"",
		"Enter provider and model for the LLM judge.",
		"Leave empty to skip (will use defaults when Phase B is implemented).",
	]);

	const judgeProvider = await ctx.ui.input(
		"Judge provider (e.g. anthropic, openai)",
		currentCfg.judge.provider || "",
	);
	if (judgeProvider === undefined) {
		cancelled();
		return;
	}

	const judgeModel = await ctx.ui.input(
		"Judge model ID (e.g. claude-sonnet-4-20250514)",
		currentCfg.judge.model || "",
	);
	if (judgeModel === undefined) {
		cancelled();
		return;
	}

	// Validate judge model against registry (if available)
	let judgeModelWarning: string | undefined;
	if (judgeProvider.trim() && judgeModel.trim()) {
		try {
			ctx.modelRegistry.refresh();
			const found = ctx.modelRegistry.find(
				judgeProvider.trim(),
				judgeModel.trim(),
			);
			if (!found) {
				judgeModelWarning = `⚠️ Model "${judgeProvider.trim()}/${judgeModel.trim()}" not found in registry. Saved anyway — will be validated when Phase B is implemented.`;
			}
		} catch {
			judgeModelWarning =
				"⚠️ Could not validate model against registry. Saved anyway.";
		}
	}

	// Build config object
	const newConfig: AnalyticsConfig = {
		judge: {
			...(judgeProvider.trim()
				? { provider: judgeProvider.trim() }
				: {}),
			...(judgeModel.trim() ? { model: judgeModel.trim() } : {}),
			batchMaxSteps: currentCfg.judge.batchMaxSteps,
			batchMaxChars: currentCfg.judge.batchMaxChars,
			excerptLimit: currentCfg.judge.excerptLimit,
		},
		autoAnalyze: {
			enabled: autoAnalyzeEnabled,
			mode: currentCfg.autoAnalyze.mode,
		},
		weeklyBatch: {
			enabled: weeklyBatchEnabled,
			silent: currentCfg.weeklyBatch.silent,
		},
		filters: { ...currentCfg.filters },
		orchestration: {
			...currentCfg.orchestration,
			overheadRatioWarn,
			heavySkills,
		},
		reports: { dir: reportsDirFinal },
	};

	// Validate
	const validation = validateConfig(newConfig);
	if (!validation.valid) {
		ctx.ui.notify(
			`❌ Config validation failed:\n${validation.errors.join("\n")}`,
			"error",
		);
		ctx.ui.setWidget("session-analytics", undefined);
		return;
	}

	// Save (atomic)
	const result = await saveConfig(extensionDir, newConfig);
	if (!result.success) {
		ctx.ui.notify(`❌ Failed to save config: ${result.error}`, "error");
		ctx.ui.setWidget("session-analytics", undefined);
		return;
	}

	// Show confirmation
	const confirmLines: string[] = [
		"✅ Configuration saved!",
		"",
		`📄 ${getConfigPath(extensionDir)}`,
		"",
		"Summary:",
		`  Auto-analyze: ${autoAnalyzeEnabled ? "ON" : "OFF"}`,
		`  Weekly batch: ${weeklyBatchEnabled ? "ON" : "OFF"}`,
		`  Overhead threshold: ${overheadRatioWarn}`,
		`  Heavy skills: ${heavySkills.length} (${heavySkills.slice(0, 3).join(", ")}${heavySkills.length > 3 ? "..." : ""})`,
		`  Reports dir: ${reportsDirFinal}`,
	];

	if (judgeProvider.trim() || judgeModel.trim()) {
		confirmLines.push(
			`  Judge model: ${judgeProvider.trim() || "?"}/${judgeModel.trim() || "?"} (Phase B)`,
		);
	}

	if (judgeModelWarning) {
		confirmLines.push("", judgeModelWarning);
	}

	if (validation.warnings.length > 0) {
		confirmLines.push("", "Warnings:");
		for (const w of validation.warnings) {
			confirmLines.push(`  ⚠️ ${w}`);
		}
	}

	ctx.ui.notify(confirmLines.join("\n"));
	ctx.ui.setWidget("session-analytics", undefined);
}

// ============================================================================
// Config View
// ============================================================================

async function handleConfigView(
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const extensionDir = __dirname;
	const { config, sources, configJsonPath, projectConfigPath, hasConfigJson, hasProjectConfig } =
		await loadConfigWithSources(extensionDir, cwd);

	const sourceLabel = (src: string): string => {
		switch (src) {
			case "defaults":
				return "📋 defaults";
			case "config.json":
				return "📄 config.json";
			case "project":
				return "📁 project override";
			default:
				return src;
		}
	};

	const lines: string[] = [];
	lines.push("--- Session Analytics Configuration ---");
	lines.push("");

	// File paths
	lines.push(`Config: ${configJsonPath} ${hasConfigJson ? "✅" : "❌ not found"}`);
	if (projectConfigPath) {
		lines.push(`Project: ${projectConfigPath} ${hasProjectConfig ? "✅" : "❌ not found"}`);
	}
	lines.push("");

	// Judge
	lines.push(`[${sourceLabel(sources.judge || "defaults")}] judge:`);
	if (config.judge.provider) {
		lines.push(`  provider: ${config.judge.provider}`);
	}
	if (config.judge.model) {
		lines.push(`  model: ${config.judge.model}`);
	}
	lines.push(`  batchMaxSteps: ${config.judge.batchMaxSteps}`);
	lines.push(`  batchMaxChars: ${config.judge.batchMaxChars}`);
	lines.push(`  excerptLimit: ${config.judge.excerptLimit}`);
	lines.push("");

	// Auto-analyze
	lines.push(`[${sourceLabel(sources.autoAnalyze || "defaults")}] autoAnalyze:`);
	lines.push(`  enabled: ${config.autoAnalyze.enabled}`);
	lines.push(`  mode: ${config.autoAnalyze.mode}`);
	lines.push("");

	// Weekly batch
	lines.push(`[${sourceLabel(sources.weeklyBatch || "defaults")}] weeklyBatch:`);
	lines.push(`  enabled: ${config.weeklyBatch.enabled}`);
	lines.push(`  silent: ${config.weeklyBatch.silent}`);
	lines.push("");

	// Filters
	lines.push(`[${sourceLabel(sources.filters || "defaults")}] filters:`);
	lines.push(`  excludePathPatterns: ${JSON.stringify(config.filters.excludePathPatterns)}`);
	lines.push(`  minEntries: ${config.filters.minEntries}`);
	lines.push("");

	// Orchestration
	lines.push(`[${sourceLabel(sources.orchestration || "defaults")}] orchestration:`);
	lines.push(`  overheadRatioWarn: ${config.orchestration.overheadRatioWarn}`);
	lines.push(`  heavySkills: ${JSON.stringify(config.orchestration.heavySkills)}`);
	lines.push(`  smallChangeLines: ${config.orchestration.smallChangeLines}`);
	lines.push(`  smallChangeFiles: ${config.orchestration.smallChangeFiles}`);
	lines.push(`  retryPromptSimilarity: ${config.orchestration.retryPromptSimilarity}`);
	lines.push(`  patternMinSessions: ${config.orchestration.patternMinSessions}`);
	lines.push("");

	// Reports
	lines.push(`[${sourceLabel(sources.reports || "defaults")}] reports:`);
	lines.push(`  dir: ${config.reports.dir}`);
	lines.push("");

	lines.push("--------------------------------------");

	ctx.ui.notify(lines.join("\n"), "info");
}
