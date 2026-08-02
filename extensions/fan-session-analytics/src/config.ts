import { readFile, writeFile, rename, access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
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
	detectors: {
		idleThresholdMin: 15,
		d12Enabled: true,
	},
};

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(override)) {
		const val = override[key];
		const baseVal = result[key];
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			baseVal !== null &&
			typeof baseVal === "object" &&
			!Array.isArray(baseVal)
		) {
			result[key] = deepMerge(
				baseVal as Record<string, unknown>,
				val as Record<string, unknown>,
			);
		} else if (val !== undefined) {
			result[key] = val;
		}
	}
	return result;
}

function deepClone<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj));
}

export async function loadConfig(extensionDir: string, cwd?: string): Promise<AnalyticsConfig> {
	let cfg: Record<string, unknown> = deepClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;

	// Try loading from extension directory
	try {
		const extCfgPath = join(extensionDir, "config.json");
		const raw = await readFile(extCfgPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		cfg = deepMerge(cfg, parsed);
	} catch {
		// No config.json in extension dir — use defaults
	}

	// Try project-level override
	if (cwd) {
		try {
			const projCfgPath = join(cwd, ".fan", "session-analytics.config.json");
			const raw = await readFile(projCfgPath, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			cfg = deepMerge(cfg, parsed);
		} catch {
			// No project-level config
		}
	}

	return cfg as unknown as AnalyticsConfig;
}

/** Get path to config.json in the extension directory. */
export function getConfigPath(extensionDir: string): string {
	return join(extensionDir, "config.json");
}

/** Check whether config.json exists in the extension directory. */
export function configExists(extensionDir: string): boolean {
	return existsSync(getConfigPath(extensionDir));
}

/** Result of loading config with source tracking. */
export interface ConfigWithSources {
	config: AnalyticsConfig;
	/** Per-section source: "defaults" | "config.json" | "project" */
	sources: Record<string, string>;
	configJsonPath: string;
	projectConfigPath: string | undefined;
	hasConfigJson: boolean;
	hasProjectConfig: boolean;
}

/** Load config and track which source each top-level section came from. */
export async function loadConfigWithSources(
	extensionDir: string,
	cwd?: string,
): Promise<ConfigWithSources> {
	const sources: Record<string, string> = {};
	const topLevelKeys: (keyof AnalyticsConfig)[] = [
		"judge",
		"autoAnalyze",
		"weeklyBatch",
		"filters",
		"orchestration",
		"reports",
		"detectors",
	];

	// Start with defaults
	let cfg: Record<string, unknown> = deepClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
	for (const key of topLevelKeys) {
		sources[key] = "defaults";
	}

	const configJsonPath = getConfigPath(extensionDir);
	const hasConfigJson = existsSync(configJsonPath);

	// Try extension config.json
	if (hasConfigJson) {
		try {
			const raw = await readFile(configJsonPath, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			cfg = deepMerge(cfg, parsed);
			for (const key of topLevelKeys) {
				if (key in parsed) {
					sources[key] = "config.json";
				}
			}
		} catch {
			// Parse error — keep defaults
		}
	}

	// Try project-level override
	let projectConfigPath: string | undefined;
	let hasProjectConfig = false;
	if (cwd) {
		projectConfigPath = join(cwd, ".fan", "session-analytics.config.json");
		hasProjectConfig = existsSync(projectConfigPath);
		if (hasProjectConfig) {
			try {
				const raw = await readFile(projectConfigPath, "utf-8");
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				cfg = deepMerge(cfg, parsed);
				for (const key of topLevelKeys) {
					if (key in parsed) {
						sources[key] = "project";
					}
				}
			} catch {
				// Parse error — keep previous merge
			}
		}
	}

	return {
		config: cfg as unknown as AnalyticsConfig,
		sources,
		configJsonPath,
		projectConfigPath,
		hasConfigJson,
		hasProjectConfig,
	};
}

/** Validation result. */
export interface ConfigValidationResult {
	valid: boolean;
	warnings: string[];
	errors: string[];
}

const KNOWN_TOP_KEYS = new Set<string>([
	"judge",
	"autoAnalyze",
	"weeklyBatch",
	"filters",
	"orchestration",
	"reports",
	"detectors",
]);

const KNOWN_JUDGE_KEYS = new Set<string>([
	"provider",
	"model",
	"batchMaxSteps",
	"batchMaxChars",
	"excerptLimit",
]);

const KNOWN_AUTO_ANALYZE_KEYS = new Set<string>(["enabled", "mode"]);
const KNOWN_WEEKLY_BATCH_KEYS = new Set<string>(["enabled", "silent"]);
const KNOWN_FILTERS_KEYS = new Set<string>(["excludePathPatterns", "minEntries"]);
const KNOWN_ORCHESTRATION_KEYS = new Set<string>([
	"overheadRatioWarn",
	"heavySkills",
	"smallChangeLines",
	"smallChangeFiles",
	"retryPromptSimilarity",
	"patternMinSessions",
]);
const KNOWN_REPORTS_KEYS = new Set<string>(["dir"]);
const KNOWN_DETECTORS_KEYS = new Set<string>(["idleThresholdMin", "d12Enabled"]);

/** Validate a config object. Unknown keys produce warnings, not errors. */
export function validateConfig(obj: unknown): ConfigValidationResult {
	const warnings: string[] = [];
	const errors: string[] = [];

	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
		errors.push("Config must be a JSON object");
		return { valid: false, warnings, errors };
	}

	const record = obj as Record<string, unknown>;

	// Check for unknown top-level keys
	for (const key of Object.keys(record)) {
		if (!KNOWN_TOP_KEYS.has(key)) {
			warnings.push(`Unknown top-level key "${key}" — will be preserved but ignored`);
		}
	}

	// Type checks for known sections
	if ("judge" in record) {
		if (typeof record.judge !== "object" || record.judge === null || Array.isArray(record.judge)) {
			errors.push('"judge" must be an object');
		} else {
			const j = record.judge as Record<string, unknown>;
			for (const k of Object.keys(j)) {
				if (!KNOWN_JUDGE_KEYS.has(k)) {
					warnings.push(`Unknown key "judge.${k}"`);
				}
			}
			if ("batchMaxSteps" in j && typeof j.batchMaxSteps !== "number") {
				errors.push('"judge.batchMaxSteps" must be a number');
			}
			if ("batchMaxChars" in j && typeof j.batchMaxChars !== "number") {
				errors.push('"judge.batchMaxChars" must be a number');
			}
			if ("excerptLimit" in j && typeof j.excerptLimit !== "number") {
				errors.push('"judge.excerptLimit" must be a number');
			}
			if ("provider" in j && typeof j.provider !== "string") {
				errors.push('"judge.provider" must be a string');
			}
			if ("model" in j && typeof j.model !== "string") {
				errors.push('"judge.model" must be a string');
			}
		}
	}

	if ("autoAnalyze" in record) {
		if (typeof record.autoAnalyze !== "object" || record.autoAnalyze === null || Array.isArray(record.autoAnalyze)) {
			errors.push('"autoAnalyze" must be an object');
		} else {
			const a = record.autoAnalyze as Record<string, unknown>;
			for (const k of Object.keys(a)) {
				if (!KNOWN_AUTO_ANALYZE_KEYS.has(k)) {
					warnings.push(`Unknown key "autoAnalyze.${k}"`);
				}
			}
			if ("enabled" in a && typeof a.enabled !== "boolean") {
				errors.push('"autoAnalyze.enabled" must be a boolean');
			}
			if ("mode" in a && a.mode !== "metrics" && a.mode !== "full") {
				errors.push('"autoAnalyze.mode" must be "metrics" or "full"');
			}
		}
	}

	if ("weeklyBatch" in record) {
		if (typeof record.weeklyBatch !== "object" || record.weeklyBatch === null || Array.isArray(record.weeklyBatch)) {
			errors.push('"weeklyBatch" must be an object');
		} else {
			const w = record.weeklyBatch as Record<string, unknown>;
			for (const k of Object.keys(w)) {
				if (!KNOWN_WEEKLY_BATCH_KEYS.has(k)) {
					warnings.push(`Unknown key "weeklyBatch.${k}"`);
				}
			}
			if ("enabled" in w && typeof w.enabled !== "boolean") {
				errors.push('"weeklyBatch.enabled" must be a boolean');
			}
			if ("silent" in w && typeof w.silent !== "boolean") {
				errors.push('"weeklyBatch.silent" must be a boolean');
			}
		}
	}

	if ("filters" in record) {
		if (typeof record.filters !== "object" || record.filters === null || Array.isArray(record.filters)) {
			errors.push('"filters" must be an object');
		} else {
			const f = record.filters as Record<string, unknown>;
			for (const k of Object.keys(f)) {
				if (!KNOWN_FILTERS_KEYS.has(k)) {
					warnings.push(`Unknown key "filters.${k}"`);
				}
			}
			if ("excludePathPatterns" in f && !Array.isArray(f.excludePathPatterns)) {
				errors.push('"filters.excludePathPatterns" must be an array');
			}
			if ("minEntries" in f && typeof f.minEntries !== "number") {
				errors.push('"filters.minEntries" must be a number');
			}
		}
	}

	if ("orchestration" in record) {
		if (typeof record.orchestration !== "object" || record.orchestration === null || Array.isArray(record.orchestration)) {
			errors.push('"orchestration" must be an object');
		} else {
			const o = record.orchestration as Record<string, unknown>;
			for (const k of Object.keys(o)) {
				if (!KNOWN_ORCHESTRATION_KEYS.has(k)) {
					warnings.push(`Unknown key "orchestration.${k}"`);
				}
			}
			if ("overheadRatioWarn" in o) {
				if (typeof o.overheadRatioWarn !== "number" || !Number.isFinite(o.overheadRatioWarn)) {
					errors.push('"orchestration.overheadRatioWarn" must be a finite number');
				} else if (o.overheadRatioWarn < 0 || o.overheadRatioWarn > 1) {
					errors.push('"orchestration.overheadRatioWarn" must be in range 0..1');
				}
			}
			if ("heavySkills" in o) {
				if (!Array.isArray(o.heavySkills)) {
					errors.push('"orchestration.heavySkills" must be an array');
				} else if (!(o.heavySkills as unknown[]).every((s) => typeof s === "string")) {
					errors.push('"orchestration.heavySkills" must be an array of strings');
				}
			}
			if ("smallChangeLines" in o && typeof o.smallChangeLines !== "number") {
				errors.push('"orchestration.smallChangeLines" must be a number');
			}
			if ("smallChangeFiles" in o && typeof o.smallChangeFiles !== "number") {
				errors.push('"orchestration.smallChangeFiles" must be a number');
			}
			if ("retryPromptSimilarity" in o) {
				if (typeof o.retryPromptSimilarity !== "number" || !Number.isFinite(o.retryPromptSimilarity)) {
					errors.push('"orchestration.retryPromptSimilarity" must be a finite number');
				} else if (o.retryPromptSimilarity < 0 || o.retryPromptSimilarity > 1) {
					errors.push('"orchestration.retryPromptSimilarity" must be in range 0..1');
				}
			}
			if ("patternMinSessions" in o) {
				if (typeof o.patternMinSessions !== "number") {
					errors.push('"orchestration.patternMinSessions" must be a number');
				} else if (!Number.isInteger(o.patternMinSessions) || o.patternMinSessions < 1) {
					errors.push('"orchestration.patternMinSessions" must be an integer ≥ 1');
				}
			}
		}
	}

	if ("reports" in record) {
		if (typeof record.reports !== "object" || record.reports === null || Array.isArray(record.reports)) {
			errors.push('"reports" must be an object');
		} else {
			const r = record.reports as Record<string, unknown>;
			for (const k of Object.keys(r)) {
				if (!KNOWN_REPORTS_KEYS.has(k)) {
					warnings.push(`Unknown key "reports.${k}"`);
				}
			}
			if ("dir" in r && typeof r.dir !== "string") {
				errors.push('"reports.dir" must be a string');
			}
		}
	}

	if ("detectors" in record) {
		if (typeof record.detectors !== "object" || record.detectors === null || Array.isArray(record.detectors)) {
			errors.push('"detectors" must be an object');
		} else {
			const d = record.detectors as Record<string, unknown>;
			for (const k of Object.keys(d)) {
				if (!KNOWN_DETECTORS_KEYS.has(k)) {
					warnings.push(`Unknown key "detectors.${k}"`);
				}
			}
			if ("idleThresholdMin" in d && typeof d.idleThresholdMin !== "number") {
				errors.push('"detectors.idleThresholdMin" must be a number');
			}
			if ("d12Enabled" in d && typeof d.d12Enabled !== "boolean") {
				errors.push('"detectors.d12Enabled" must be a boolean');
			}
		}
	}

	return {
		valid: errors.length === 0,
		warnings,
		errors,
	};
}

/**
 * Save config to config.json in the extension directory.
 * Atomic: writes to .tmp file, then renames.
 */
export async function saveConfig(
	extensionDir: string,
	config: Partial<AnalyticsConfig>,
): Promise<{ success: boolean; error?: string }> {
	const configPath = getConfigPath(extensionDir);
	const tmpPath = configPath + ".tmp";

	try {
		// Validate before writing
		const validation = validateConfig(config);
		if (!validation.valid) {
			return {
				success: false,
				error: `Validation failed: ${validation.errors.join("; ")}`,
			};
		}

		const json = JSON.stringify(config, null, 2) + "\n";
		await writeFile(tmpPath, json, "utf-8");
		await rename(tmpPath, configPath);
		return { success: true };
	} catch (err) {
		// Clean up tmp on failure
		try {
			await access(tmpPath, constants.F_OK);
			const { unlink } = await import("node:fs/promises");
			await unlink(tmpPath);
		} catch {
			// tmp doesn't exist or already cleaned up
		}
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
