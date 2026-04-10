import type { TaskType, ModelRoute, RoutingPreset, RoutingRuleData, ModelSettingData, ProviderRouterOptions } from "./types.js";
import * as db from "./db.js";

/** Default routing presets as fallback when no DB rules match */
const DEFAULT_PRESETS: RoutingPreset[] = [
	{
		name: "coding",
		route: { provider: "anthropic", model: "claude-sonnet-4-20250514", temperature: 0.2 },
		fallback: { provider: "anthropic", model: "claude-haiku-3-5-20241022" },
	},
	{
		name: "quick",
		route: { provider: "ollama", model: "llama3", temperature: 0.5 },
		fallback: { provider: "openai", model: "gpt-4o-mini" },
	},
	{
		name: "analysis",
		route: { provider: "openai", model: "gpt-4o", temperature: 0.3 },
		fallback: { provider: "google", model: "gemini-2.5-pro" },
	},
	{
		name: "chat",
		route: { provider: "google", model: "gemini-2.5-pro", temperature: 0.7 },
		fallback: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
	},
];

export class ProviderRouter {
	private customPresets: Map<string, RoutingPreset>;
	private dbRules: RoutingRuleData[] = [];
	private modelSettings: Map<string, ModelSettingData> = new Map();
	private dbAdapter: ProviderRouterOptions["db"];
	private loaded = false;

	constructor(options?: ProviderRouterOptions) {
		this.dbAdapter = options?.db;
		this.customPresets = new Map();
		if (options?.presets) {
			for (const p of options.presets) {
				this.customPresets.set(p.name, p);
			}
		}
	}

	/** Map raw DB rule to RoutingRuleData (normalizes null → undefined) */
	private normalizeRule(raw: { id: string; name: string; provider: string; model: string; fallback?: string | null; enabled: boolean }): RoutingRuleData {
		return { ...raw, fallback: raw.fallback ?? undefined };
	}

	/** Map raw DB setting to ModelSettingData (normalizes null → undefined) */
	private normalizeSetting(raw: { id: string; provider: string; model: string; temperature: number | null; maxTokens: number | null; thinking: string | null; isDefault: boolean; priority: number | null }): ModelSettingData {
		return { ...raw, priority: raw.priority ?? 0 };
	}

	/** Load rules and settings from DB. Called lazily or via rebuild(). */
	async load(): Promise<void> {
		try {
			let rawRules: Array<{ id: string; name: string; provider: string; model: string; fallback: string | null | undefined; enabled: boolean }>;
			let rawSettings: Array<{ id: string; provider: string; model: string; temperature: number | null; maxTokens: number | null; thinking: string | null; isDefault: boolean; priority: number | null }>;

			if (this.dbAdapter) {
				rawRules = await this.dbAdapter.getRoutingRules() as typeof rawRules;
				rawSettings = await this.dbAdapter.getAllModelSettings() as typeof rawSettings;
			} else {
				rawRules = await db.getRoutingRules() as typeof rawRules;
				rawSettings = await db.getAllModelSettings() as typeof rawSettings;
			}

			this.dbRules = rawRules.map(r => this.normalizeRule(r));
			this.modelSettings.clear();
			for (const s of rawSettings) {
				const normalized = this.normalizeSetting(s);
				this.modelSettings.set(`${normalized.provider}/${normalized.model}`, normalized);
			}
			this.loaded = true;
		} catch {
			// DB not available — continue with empty DB rules
			this.dbRules = [];
			this.modelSettings.clear();
			this.loaded = true;
		}
	}

	/** Ensure DB is loaded (lazy init) */
	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) {
			await this.load();
		}
	}

	/** Resolve a ModelRoute for a task type. Priority: custom preset → DB rule (enabled) → DEFAULT_PRESETS → "coding" fallback */
	async resolve(taskType: TaskType | string): Promise<ModelRoute> {
		await this.ensureLoaded();

		// 1. Check custom presets first
		const customPreset = this.customPresets.get(taskType);
		if (customPreset) return customPreset.route;

		// 2. Check enabled DB rules matching taskType
		const dbRule = this.dbRules.find(r => r.name === taskType && r.enabled);
		if (dbRule) {
			return { provider: dbRule.provider, model: dbRule.model };
		}

		// 3. Check DEFAULT_PRESETS
		const defaultPreset = DEFAULT_PRESETS.find(p => p.name === taskType);
		if (defaultPreset) return defaultPreset.route;

		// 4. Fallback to "coding"
		const codingPreset = this.customPresets.get("coding") ?? DEFAULT_PRESETS.find(p => p.name === "coding");
		return codingPreset?.route ?? { provider: "anthropic", model: "claude-sonnet-4-20250514" };
	}

	/** Resolve route and also get model settings overrides */
	async resolveWithSettings(taskType: TaskType | string): Promise<{ route: ModelRoute; settings: Partial<ModelSettingData> | null }> {
		const route = await this.resolve(taskType);
		const settingKey = `${route.provider}/${route.model}`;
		const setting = this.modelSettings.get(settingKey);
		if (setting) {
			return {
				route,
				settings: {
					temperature: setting.temperature,
					maxTokens: setting.maxTokens,
					thinking: setting.thinking ?? undefined,
				}
			};
		}
		return { route, settings: null };
	}

	/** Get fallback route for a task type */
	async getFallback(taskType: TaskType | string): Promise<ModelRoute | null> {
		await this.ensureLoaded();

		// Check custom presets
		const customPreset = this.customPresets.get(taskType);
		if (customPreset?.fallback) return customPreset.fallback;

		// Check DB rules
		const dbRule = this.dbRules.find(r => r.name === taskType && r.enabled);
		if (dbRule?.fallback) {
			return this.parseFallbackString(dbRule.fallback, dbRule.provider);
		}

		// Check DEFAULT_PRESETS
		const defaultPreset = DEFAULT_PRESETS.find(p => p.name === taskType);
		if (defaultPreset?.fallback) return defaultPreset.fallback;

		return null;
	}

	/** Get preset by name */
	async getPreset(taskType: TaskType | string): Promise<RoutingPreset | null> {
		await this.ensureLoaded();

		const customPreset = this.customPresets.get(taskType);
		if (customPreset) return customPreset;

		return DEFAULT_PRESETS.find(p => p.name === taskType) ?? null;
	}

	/** List all available presets (default + custom + DB rules) */
	async listPresets(): Promise<RoutingPreset[]> {
		await this.ensureLoaded();

		const presets: RoutingPreset[] = [...DEFAULT_PRESETS];
		for (const custom of this.customPresets.values()) {
			presets.push(custom);
		}
		for (const rule of this.dbRules) {
			if (!presets.find(p => p.name === rule.name)) {
				presets.push({
					name: rule.name as TaskType,
					route: { provider: rule.provider, model: rule.model },
					fallback: rule.fallback ? this.parseFallbackString(rule.fallback, rule.provider) : undefined,
				});
			}
		}
		return presets;
	}

	/** Set a custom preset (stored in memory only) */
	setCustomPreset(name: string, route: ModelRoute, fallback?: ModelRoute): void {
		this.customPresets.set(name, { name: name as TaskType, route, fallback });
	}

	/** Remove a custom preset */
	removeCustomPreset(name: string): void {
		this.customPresets.delete(name);
	}

	/** Add a routing rule to DB */
	async addRule(rule: Omit<RoutingRuleData, "id">): Promise<void> {
		if (this.dbAdapter) {
			await this.dbAdapter.upsertRoutingRule(rule);
		} else {
			await db.upsertRoutingRule(rule);
		}
		await this.load(); // reload
	}

	/** Remove a routing rule from DB */
	async removeRule(name: string): Promise<void> {
		if (this.dbAdapter) {
			await this.dbAdapter.deleteRoutingRule(name);
		} else {
			await db.deleteRoutingRule(name);
		}
		await this.load();
	}

	/** Enable a routing rule */
	async enableRule(name: string): Promise<void> {
		if (this.dbAdapter) {
			await this.dbAdapter.toggleRoutingRule(name, true);
		} else {
			await db.toggleRoutingRule(name, true);
		}
		await this.load();
	}

	/** Disable a routing rule */
	async disableRule(name: string): Promise<void> {
		if (this.dbAdapter) {
			await this.dbAdapter.toggleRoutingRule(name, false);
		} else {
			await db.toggleRoutingRule(name, false);
		}
		await this.load();
	}

	/** Get all DB rules */
	getRules(): RoutingRuleData[] {
		return [...this.dbRules];
	}

	/** Get model settings */
	getAllSettings(): ModelSettingData[] {
		return [...this.modelSettings.values()];
	}

	/** Get a specific model setting */
	getSetting(provider: string, model: string): ModelSettingData | null {
		return this.modelSettings.get(`${provider}/${model}`) ?? null;
	}

	/** Reload rules and settings from DB */
	async rebuild(): Promise<void> {
		this.loaded = false;
		await this.load();
	}

	/** Parse fallback string to ModelRoute */
	private parseFallbackString(fallback: string, defaultProvider: string): ModelRoute {
		const parts = fallback.split("/");
		if (parts.length === 2) {
			return { provider: parts[0], model: parts[1] };
		}
		return { provider: defaultProvider, model: fallback };
	}
}
