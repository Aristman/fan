import { describe, expect, it } from "vitest";
import { ProviderRouter } from "../router.js";
import type { ModelSettingData, RoutingRuleData } from "../types.js";

// Mock DB adapter
function createMockDb(rules: RoutingRuleData[] = [], settings: ModelSettingData[] = []) {
	return {
		getRoutingRules: async () => rules,
		upsertRoutingRule: async (data: any) => ({ id: "test-id", ...data }),
		deleteRoutingRule: async () => {},
		toggleRoutingRule: async () => {},
		getModelSetting: async (provider: string, model: string) =>
			settings.find((s) => s.provider === provider && s.model === model) ?? null,
		getAllModelSettings: async () => settings,
	};
}

describe("ProviderRouter", () => {
	it("resolves default preset for 'coding' task type", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const route = await router.resolve("coding");
		expect(route.provider).toBe("anthropic");
		expect(route.model).toBe("claude-sonnet-4-20250514");
	});

	it("resolves default preset for 'quick' task type", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const route = await router.resolve("quick");
		expect(route.provider).toBe("ollama");
		expect(route.model).toBe("llama3");
	});

	it("resolves default preset for 'analysis' task type", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const route = await router.resolve("analysis");
		expect(route.provider).toBe("openai");
		expect(route.model).toBe("gpt-4o");
	});

	it("resolves default preset for 'chat' task type", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const route = await router.resolve("chat");
		expect(route.provider).toBe("google");
		expect(route.model).toBe("gemini-2.5-pro");
	});

	it("falls back to 'coding' for unknown task type", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const route = await router.resolve("unknown_task");
		expect(route.provider).toBe("anthropic");
		expect(route.model).toBe("claude-sonnet-4-20250514");
	});

	it("DB rules override default presets when enabled", async () => {
		const rules: RoutingRuleData[] = [
			{
				id: "rule-1",
				name: "coding",
				provider: "openai",
				model: "gpt-4o-mini",
				enabled: true,
			},
		];
		const router = new ProviderRouter({ db: createMockDb(rules) });
		const route = await router.resolve("coding");
		expect(route.provider).toBe("openai");
		expect(route.model).toBe("gpt-4o-mini");
	});

	it("disabled DB rules are ignored", async () => {
		const rules: RoutingRuleData[] = [
			{
				id: "rule-1",
				name: "coding",
				provider: "openai",
				model: "gpt-4o-mini",
				enabled: false,
			},
		];
		const router = new ProviderRouter({ db: createMockDb(rules) });
		const route = await router.resolve("coding");
		expect(route.provider).toBe("anthropic");
		expect(route.model).toBe("claude-sonnet-4-20250514");
	});

	it("custom presets take highest priority", async () => {
		const router = new ProviderRouter({
			db: createMockDb([
				{
					id: "rule-1",
					name: "coding",
					provider: "openai",
					model: "gpt-4o-mini",
					enabled: true,
				},
			]),
			presets: [{ name: "coding", route: { provider: "google", model: "gemini-flash" } }],
		});
		const route = await router.resolve("coding");
		expect(route.provider).toBe("google");
		expect(route.model).toBe("gemini-flash");
	});

	it("resolveWithSettings returns settings when available", async () => {
		const settings: ModelSettingData[] = [
			{
				id: "s-1",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				temperature: 0.5,
				maxTokens: 4096,
				thinking: "low",
				isDefault: false,
				priority: 0,
			},
		];
		const router = new ProviderRouter({ db: createMockDb([], settings) });
		const { route, settings: modelSettings } = await router.resolveWithSettings("coding");
		expect(route.provider).toBe("anthropic");
		expect(modelSettings).not.toBeNull();
		expect(modelSettings!.temperature).toBe(0.5);
		expect(modelSettings!.maxTokens).toBe(4096);
	});

	it("resolveWithSettings returns null settings when not configured", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const { settings } = await router.resolveWithSettings("coding");
		expect(settings).toBeNull();
	});

	it("getFallback returns fallback from default preset", async () => {
		const router = new ProviderRouter({ db: createMockDb() });
		const fallback = await router.getFallback("coding");
		expect(fallback).not.toBeNull();
		expect(fallback!.provider).toBe("anthropic");
		expect(fallback!.model).toBe("claude-haiku-3-5-20241022");
	});

	it("listPresets includes default and DB rules", async () => {
		const rules: RoutingRuleData[] = [
			{
				id: "rule-1",
				name: "custom-task",
				provider: "ollama",
				model: "codellama",
				enabled: true,
			},
		];
		const router = new ProviderRouter({ db: createMockDb(rules) });
		const presets = await router.listPresets();
		const names = presets.map((p) => p.name);
		expect(names).toContain("coding");
		expect(names).toContain("quick");
		expect(names).toContain("analysis");
		expect(names).toContain("chat");
		expect(names).toContain("custom-task");
	});

	it("gracefully handles DB errors", async () => {
		const badDb = {
			...createMockDb(),
			getRoutingRules: async () => {
				throw new Error("DB down");
			},
			getAllModelSettings: async () => {
				throw new Error("DB down");
			},
		};
		const router = new ProviderRouter({ db: badDb });
		// Should fall back to default presets
		const route = await router.resolve("coding");
		expect(route.provider).toBe("anthropic");
	});

	it("addRule and removeRule work", async () => {
		let rules: RoutingRuleData[] = [];
		const db = {
			...createMockDb(),
			upsertRoutingRule: async (data: any) => {
				const rule = { id: "new-id", ...data };
				rules.push(rule);
				return rule;
			},
			deleteRoutingRule: async (name: string) => {
				rules = rules.filter((r) => r.name !== name);
			},
			getRoutingRules: async () => [...rules],
		};
		const router = new ProviderRouter({ db });

		await router.addRule({ name: "test", provider: "ollama", model: "llama3", enabled: true });
		const route = await router.resolve("test");
		expect(route.provider).toBe("ollama");

		await router.removeRule("test");
		await router.rebuild();
		const fallback = await router.resolve("test");
		expect(fallback.provider).toBe("anthropic"); // falls back to coding default
	});
});
