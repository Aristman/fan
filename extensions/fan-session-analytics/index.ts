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
import {
	discoverInstalledSkills,
	groupModelsByProvider,
	type DiscoveredSkill,
	type ModelChoice,
	type ProviderChoice,
} from "./src/discovery.js";

export default function sessionAnalyticsExtension(fan: ExtensionAPI) {
	// --- Tool: session_analyze ---
	fan.registerTool({
		name: "session_analyze",
		label: "Session Analyze",
		description:
			"Анализирует завершённые сессии и формирует отчёт качества с метриками и находками. " +
			"Читает JSONL-сессии (read-only), запускает детерминированные детекторы и генерирует markdown-отчёт.",
		parameters: Type.Object({
			target: Type.String({
				description:
					'Цель анализа: "last" (последняя сессия для текущего cwd), ' +
					'"dir" (все сессии в каталоге cwd, с учётом since/batchSize), ' +
					"или явный путь к .jsonl файлу сессии.",
			}),
			mode: Type.Union([Type.Literal("metrics"), Type.Literal("full")], {
				description:
					'"metrics" = только детерминированные метрики; "full" = метрики + примечание об LLM-судье (этап B).',
				default: "metrics" as any,
			}),
			since: Type.Optional(
				Type.String({
					description: "ISO-дата — анализировать только сессии, изменённые после этой даты (режим dir).",
				}),
			),
			batchSize: Type.Optional(
				Type.Number({
					description: "Макс. кол-во сессий для анализа в режиме dir. По умолчанию: 20.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const cwd = ctx.cwd || process.cwd();
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
				chatLines.push("### Аналитика сессий");
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
						`  Находки: ${result.score.metrics["findingsHigh"]} выс. / ${result.score.metrics["findingsMedium"]} ср. / ${result.score.metrics["findingsLow"]} низ.`,
					);
					chatLines.push(`  Отчёт: \`${result.reportPath}\``);

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
					chatLines.push("Сессии не найдены.");
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
							text: `Ошибка аналитики сессий: ${err instanceof Error ? err.message : String(err)}`,
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
			"Аналитика сессий — /session-analytics [last|dir|init|config|<путь>]",
		getArgumentCompletions(prefix: string) {
			const completions = ["last", "dir", "init", "config"];
			const filtered = completions.filter((c) => c.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((c) => ({ value: c, label: c }))
				: null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			try {
				const cwd = ctx.cwd || process.cwd();
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
						"Использование: /session-analytics [last|dir|init|config|<путь-к-jsonl>] [metrics|full]",
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

				ctx.ui.notify("Запуск аналитики сессий...", "info");

				const { results, summary } = await runPipeline(opts);

				// Print summary to UI
				const lines: string[] = [];
				lines.push("--- Аналитика сессий ---");
				lines.push(`Проанализировано сессий: ${results.length}`);
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
						`  Находки: ${result.score.metrics["findingsHigh"]} выс. / ${result.score.metrics["findingsMedium"]} ср. / ${result.score.metrics["findingsLow"]} низ.`,
					);
					lines.push(`  Отчёт: ${result.reportPath}`);

					const top = result.score.findings
						.filter((f) => f.severity === "high")
						.slice(0, 3);
					for (const f of top) {
						lines.push(`  🔴 [${f.detectorId}] ${f.title}`);
					}

					lines.push("");
				}

				if (results.length === 0) {
					lines.push("Сессии не найдены или все были отфильтрованы.");
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
					`Ошибка аналитики сессий: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}

// ============================================================================
// Multiselect через select (нет встроенного checkbox-примитива)
// ============================================================================

/**
 * Мультиселект на основе циклического select.
 * Каждый пункт можно отметить/снять (✔/☐). Пункт «Готово» завершает выбор.
 * Возвращает массив выбранных значений или undefined при отмене.
 */
async function multiSelect(
	ctx: ExtensionCommandContext,
	title: string,
	items: string[],
	preSelected: Set<string>,
): Promise<string[] | undefined> {
	const selected = new Set(preSelected);

	while (true) {
		const options: string[] = items.map((item) =>
			selected.has(item) ? `✔ ${item}` : `☐ ${item}`,
		);
		options.push("---");
		const doneLabel = `✔ Готово (${selected.size} выбрано)`;
		options.push(doneLabel);
		options.push("❌ Отмена");

		const choice = await ctx.ui.select(
			`${title}\n(Пробел/Enter — отметить/снять)`,
			options,
		);

		if (choice === undefined) return undefined; // Esc

		if (choice === "❌ Отмена") return undefined;

		if (choice === doneLabel) {
			return items.filter((item) => selected.has(item));
		}

		if (choice === "---") continue;

		// Toggle item
		const isMarked = choice.startsWith("✔ ");
		const itemName = choice.slice(2);
		if (isMarked) {
			selected.delete(itemName);
		} else {
			selected.add(itemName);
		}
	}
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
			"UI недоступен. Отредактируйте config.json вручную или скопируйте config.example.json.",
		);
		return;
	}

	const extensionDir = __dirname;
	const hasExistingConfig = configExists(extensionDir);

	const cancelled = () => {
		ctx.ui.notify("⚙️ Мастер настройки отменён.");
		ctx.ui.setWidget("session-analytics", undefined);
	};

	ctx.ui.setWidget("session-analytics", [
		"⚙️ АНАЛИТИКА СЕССИЙ — Мастер настройки",
		"",
		"Ответьте на вопросы для настройки расширения.",
		"Нажмите Esc для отмены в любой момент.",
	]);

	// Check existing config
	if (hasExistingConfig) {
		const overwrite = await ctx.ui.confirm(
			"Конфигурация существует",
			"config.json уже существует. Перезаписать?",
		);
		if (!overwrite) {
			ctx.ui.notify("Сохранён существующий config.json.");
			ctx.ui.setWidget("session-analytics", undefined);
			return;
		}
	}

	// Load current (or default) values for pre-filling
	const currentCfg = await loadConfig(extensionDir, cwd);

	// 1. Auto-analyze on session end (reserved, phase C)
	const autoAnalyzeChoice = await ctx.ui.select("Автоанализ при завершении сессии (этап C, зарезервировано)", [
		`Выкл. (сейчас: ${currentCfg.autoAnalyze.enabled ? "вкл" : "выкл"})`,
		"Вкл.",
	]);
	if (autoAnalyzeChoice === undefined) {
		cancelled();
		return;
	}
	const autoAnalyzeEnabled = autoAnalyzeChoice.startsWith("Вкл");

	// 2. Weekly batch
	const weeklyBatchChoice = await ctx.ui.select("Еженедельный пакетный анализ", [
		`Выкл. (сейчас: ${currentCfg.weeklyBatch.enabled ? "вкл" : "выкл"})`,
		"Вкл.",
	]);
	if (weeklyBatchChoice === undefined) {
		cancelled();
		return;
	}
	const weeklyBatchEnabled = weeklyBatchChoice.startsWith("Вкл");

	// 3. Coordination overhead threshold
	const overheadStr = await ctx.ui.input(
		`Порог предупреждения о coordination overhead (0.1–1.0, сейчас: ${currentCfg.orchestration.overheadRatioWarn})`,
		String(currentCfg.orchestration.overheadRatioWarn),
	);
	if (overheadStr === undefined) {
		cancelled();
		return;
	}
	let overheadRatioWarn = parseFloat(overheadStr);
	if (Number.isNaN(overheadRatioWarn)) {
		overheadRatioWarn = currentCfg.orchestration.overheadRatioWarn;
	}
	overheadRatioWarn = Math.max(0.1, Math.min(1.0, overheadRatioWarn));

	// 4. Heavy skills list — интерактивный выбор из установленных скилов
	const heavySkills = await selectHeavySkills(ctx, cwd, currentCfg);
	if (heavySkills === undefined) {
		cancelled();
		return;
	}

	// 5. Reports directory
	const reportsDir = await ctx.ui.input(
		`Каталог отчётов (сейчас: ${currentCfg.reports.dir})`,
		currentCfg.reports.dir,
	);
	if (reportsDir === undefined) {
		cancelled();
		return;
	}
	const reportsDirFinal = reportsDir.trim() || currentCfg.reports.dir;

	// 6. Judge model — интерактивный выбор из доступных моделей
	const judgeResult = await selectJudgeModel(ctx, currentCfg);
	if (judgeResult === undefined) {
		cancelled();
		return;
	}

	// Build config object — preserve existing values on skip
	const finalProvider = judgeResult.provider || currentCfg.judge.provider;
	const finalModel = judgeResult.model || currentCfg.judge.model;

	const newConfig: AnalyticsConfig = {
		judge: {
			...(finalProvider ? { provider: finalProvider } : {}),
			...(finalModel ? { model: finalModel } : {}),
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
			`❌ Ошибка валидации конфигурации:\n${validation.errors.join("\n")}`,
			"error",
		);
		ctx.ui.setWidget("session-analytics", undefined);
		return;
	}

	// Save (atomic)
	const result = await saveConfig(extensionDir, newConfig);
	if (!result.success) {
		ctx.ui.notify(`❌ Не удалось сохранить конфигурацию: ${result.error}`, "error");
		ctx.ui.setWidget("session-analytics", undefined);
		return;
	}

	// Show confirmation
	const confirmLines: string[] = [
		"✅ Конфигурация сохранена!",
		"",
		`📄 ${getConfigPath(extensionDir)}`,
		"",
		"Сводка:",
		`  Автоанализ: ${autoAnalyzeEnabled ? "ВКЛ" : "ВЫКЛ"}`,
		`  Еженедельный пакет: ${weeklyBatchEnabled ? "ВКЛ" : "ВЫКЛ"}`,
		`  Порог overhead: ${overheadRatioWarn}`,
		`  Тяжёлые скилы: ${heavySkills.length} (${heavySkills.slice(0, 3).join(", ")}${heavySkills.length > 3 ? "..." : ""})`,
		`  Каталог отчётов: ${reportsDirFinal}`,
	];

	if (finalProvider || finalModel) {
		const preserved = (judgeResult.provider || judgeResult.model) ? "" : " (сохранено из конфига)";
		confirmLines.push(
			`  Модель-судья: ${finalProvider || "?"}/${finalModel || "?"} (этап B)${preserved}`,
		);
	}

	if (judgeResult.warning) {
		confirmLines.push("", judgeResult.warning);
	}

	if (validation.warnings.length > 0) {
		confirmLines.push("", "Предупреждения:");
		for (const w of validation.warnings) {
			confirmLines.push(`  ⚠️ ${w}`);
		}
	}

	ctx.ui.notify(confirmLines.join("\n"));
	ctx.ui.setWidget("session-analytics", undefined);
}

// ============================================================================
// Выбор тяжёлых скилов (мультиселект)
// ============================================================================

async function selectHeavySkills(
	ctx: ExtensionCommandContext,
	cwd: string,
	currentCfg: AnalyticsConfig,
): Promise<string[] | undefined> {
	const defaultSkills = currentCfg.orchestration.heavySkills;

	// Обнаружить установленные скилы
	const discovered = discoverInstalledSkills(cwd);

	if (discovered.length === 0) {
		// Fallback — текстовый ввод
		ctx.ui.notify(
			"Установленные скилы не найдены. Введите имена тяжёлых скилов через запятую.",
			"warning",
		);
		const raw = await ctx.ui.input(
			"Тяжёлые скилы (через запятую)",
			defaultSkills.join(", "),
		);
		if (raw === undefined) return undefined;
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	// Мультиселект из обнаруженных скилов
	ctx.ui.setWidget("session-analytics", [
		"⚙️ Выбор тяжёлых скилов",
		"",
		"Выберите скилы, которые считаются «тяжёлыми» (мультиселект).",
		"Нажмите «Готово» для подтверждения выбора.",
	]);

	const allSkillNames = discovered.map((s) => s.name);
	// Включить в список скилы из конфига, которых нет в обнаруженных
	for (const s of defaultSkills) {
		if (!allSkillNames.includes(s)) {
			allSkillNames.push(s);
		}
	}
	allSkillNames.sort();

	const preSelected = new Set(
		defaultSkills.filter((s) => allSkillNames.includes(s)),
	);

	return multiSelect(ctx, "Тяжёлые скилы (выбор из установленных)", allSkillNames, preSelected);
}

// ============================================================================
// Выбор провайдера/модели судьи
// ============================================================================

interface JudgeModelResult {
	provider: string;
	model: string;
	warning?: string;
}

async function selectJudgeModel(
	ctx: ExtensionCommandContext,
	currentCfg: AnalyticsConfig,
): Promise<JudgeModelResult | undefined> {
	ctx.ui.setWidget("session-analytics", [
		"⚙️ Модель-судья (этап B, зарезервировано)",
		"",
		"Выберите провайдера и модель для LLM-судьи.",
		"Можно пропустить — настройте позже через /session-analytics init.",
	]);

	// Получить доступные модели из registry
	let availableModels: Array<{ provider: string; id: string; name: string; contextWindow?: number; cost?: { input: number } }> = [];
	try {
		ctx.modelRegistry.refresh();
		availableModels = ctx.modelRegistry.getAvailable();
	} catch {
		// registry недоступен
	}

	if (availableModels.length === 0) {
		ctx.ui.notify(
			"Доступные модели не найдены в registry. Шаг настройки модели-судьи пропущен.",
			"warning",
		);
		return { provider: "", model: "" };
	}

	const { providers, modelsByProvider } = groupModelsByProvider(availableModels);

	// Шаг 1: выбрать провайдера
	const skipOption = "Не настраивать (этап B)";
	const providerOptions = [
		skipOption,
		...providers.map((p) => p.label),
	];

	const providerChoice = await ctx.ui.select("Провайдер модели-судьи", providerOptions);
	if (providerChoice === undefined) return undefined; // Esc — отмена всего мастера
	if (providerChoice === skipOption) {
		return { provider: "", model: "" };
	}

	// Определить выбранный провайдер
	const selectedProvider = providers.find((p) => p.label === providerChoice);
	if (!selectedProvider) {
		return { provider: "", model: "" };
	}

	// Шаг 2: выбрать модель
	const models = modelsByProvider.get(selectedProvider.provider) || [];
	const modelOptions = models.map((m) => formatModelLabel(m));

	const modelChoice = await ctx.ui.select(
		`Модель ${selectedProvider.provider}`,
		modelOptions,
	);
	if (modelChoice === undefined) return undefined; // Esc

	// Определить выбранную модель
	const selectedModel = models.find((m) => formatModelLabel(m) === modelChoice);
	if (!selectedModel) {
		return { provider: selectedProvider.provider, model: "" };
	}

	// Валидация (find в registry)
	let warning: string | undefined;
	try {
		const found = ctx.modelRegistry.find(selectedProvider.provider, selectedModel.id);
		if (!found) {
			warning = `⚠️ Модель "${selectedProvider.provider}/${selectedModel.id}" не найдена в registry. Сохранена — будет проверена при реализации этапа B.`;
		}
	} catch {
		warning = "⚠️ Не удалось проверить модель в registry. Сохранена как есть.";
	}

	return {
		provider: selectedProvider.provider,
		model: selectedModel.id,
		warning,
	};
}

function formatModelLabel(m: ModelChoice): string {
	const parts: string[] = [m.name || m.id];
	if (m.contextWindow) {
		const ctxK = Math.round(m.contextWindow / 1000);
		parts.push(`${ctxK}k ctx`);
	}
	if (m.costInput !== undefined && m.costInput > 0) {
		parts.push(`$${m.costInput}/M in`);
	}
	return parts.length > 1 ? `${parts[0]} [${parts.slice(1).join(", ")}]` : parts[0];
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
				return "📋 дефолты";
			case "config.json":
				return "📄 config.json";
			case "project":
				return "📁 проектный override";
			default:
				return src;
		}
	};

	const lines: string[] = [];
	lines.push("--- Конфигурация аналитики сессий ---");
	lines.push("");

	// File paths
	lines.push(`Конфиг: ${configJsonPath} ${hasConfigJson ? "✅" : "❌ не найден"}`);
	if (projectConfigPath) {
		lines.push(`Проектный: ${projectConfigPath} ${hasProjectConfig ? "✅" : "❌ не найден"}`);
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
