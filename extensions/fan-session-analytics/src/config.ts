import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyticsConfig } from "./types.js";

export const DEFAULT_CONFIG: AnalyticsConfig = {
	judge: {
		batchMaxSteps: 30,
		batchMaxChars: 60000,
		excerptLimit: 500,
	},
	autoAnalyze: { enabled: false, mode: "metrics" },
	weeklyBatch: { enabled: false, silent: false },
	filters: {
		excludePathPatterns: ["Temp", "\\.tmp"],
		minEntries: 5,
	},
	orchestration: {
		overheadRatioWarn: 0.4,
		heavySkills: [
			"feature-pipeline",
			"feature-roadmap",
			"dev-docs-pack",
			"research-spec-generator",
		],
		smallChangeLines: 100,
		smallChangeFiles: 3,
		retryPromptSimilarity: 0.9,
		patternMinSessions: 3,
	},
	reports: { dir: ".fan/reports/session-analytics" },
};

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
	const result = { ...base };
	for (const key of Object.keys(override) as (keyof T)[]) {
		const val = override[key];
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof result[key] === "object" &&
			!Array.isArray(result[key])
		) {
			result[key] = deepMerge(
				result[key] as Record<string, unknown>,
				val as Record<string, unknown>
			) as T[keyof T];
		} else if (val !== undefined) {
			result[key] = val as T[keyof T];
		}
	}
	return result;
}

export async function loadConfig(extensionDir: string, cwd?: string): Promise<AnalyticsConfig> {
	let cfg = { ...DEFAULT_CONFIG };

	// Try loading from extension directory
	try {
		const extCfgPath = join(extensionDir, "config.json");
		const raw = await readFile(extCfgPath, "utf-8");
		const parsed = JSON.parse(raw);
		cfg = deepMerge(cfg, parsed);
	} catch {
		// No config.json in extension dir — use defaults
	}

	// Try project-level override
	if (cwd) {
		try {
			const projCfgPath = join(cwd, ".fan", "session-analytics.config.json");
			const raw = await readFile(projCfgPath, "utf-8");
			const parsed = JSON.parse(raw);
			cfg = deepMerge(cfg, parsed);
		} catch {
			// No project-level config
		}
	}

	return cfg;
}
