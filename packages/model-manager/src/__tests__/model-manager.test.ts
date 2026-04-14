import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelManager } from "../model-manager.js";
import type { BudgetAlert, ModelSettingData, RoutingRuleData } from "../types.js";

function createMockDbs() {
	const rules: RoutingRuleData[] = [];
	const settings: ModelSettingData[] = [];
	const budgets: any[] = [];
	let idCounter = 0;

	const routerDb = {
		getRoutingRules: async () => [...rules],
		upsertRoutingRule: async (data: any) => {
			const rule = { id: `rule-${++idCounter}`, ...data };
			const idx = rules.findIndex((r) => r.name === data.name);
			if (idx >= 0) rules[idx] = rule;
			else rules.push(rule);
			return rule;
		},
		deleteRoutingRule: async (name: string) => {
			const idx = rules.findIndex((r) => r.name === name);
			if (idx >= 0) rules.splice(idx, 1);
		},
		toggleRoutingRule: async (name: string, enabled: boolean) => {
			const rule = rules.find((r) => r.name === name);
			if (rule) rule.enabled = enabled;
		},
		getModelSetting: async (provider: string, model: string) =>
			settings.find((s) => s.provider === provider && s.model === model) ?? null,
		getAllModelSettings: async () => [...settings],
	};

	const budgetDb = {
		getAllBudgets: async () => [...budgets],
		getBudget: async (provider: string | null, period: string) =>
			budgets.find((b) => (b.provider ?? "all") === (provider ?? "all") && b.period === period),
		upsertBudgetConfig: async (data: any) => {
			const key = `${data.provider ?? "all"}/${data.period}`;
			let existing = budgets.find((b) => `${b.provider ?? "all"}/${b.period}` === key);
			if (existing) Object.assign(existing, data);
			else {
				existing = { id: `budget-${++idCounter}`, tokensUsed: 0, costUsed: 0, resetAt: new Date(), ...data };
				budgets.push(existing);
			}
			return existing;
		},
		updateBudgetUsage: async (id: string, tokens: number, cost: number) => {
			const budget = budgets.find((b) => b.id === id);
			if (budget) {
				budget.tokensUsed = (budget.tokensUsed ?? 0) + tokens;
				budget.costUsed = (budget.costUsed ?? 0) + cost;
			}
			return budget;
		},
		resetBudget: async (id: string) => {
			const budget = budgets.find((b) => b.id === id);
			if (budget) {
				budget.tokensUsed = 0;
				budget.costUsed = 0;
				budget.resetAt = new Date();
			}
		},
	};

	return {
		routerDb,
		budgetDb,
		get rules() {
			return rules;
		},
		get settings() {
			return settings;
		},
		get budgets() {
			return budgets;
		},
	};
}

describe("ModelManager", () => {
	it("resolves task with default presets", async () => {
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});
		const { primary } = await mm.resolveForTask("coding");
		expect(primary.provider).toBe("anthropic");
		expect(primary.model).toBe("claude-sonnet-4-20250514");
	});

	it("executeWithFallback succeeds on primary", async () => {
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});
		const fn = vi.fn().mockResolvedValue("ok");
		const result = await mm.executeWithFallback("coding", fn);
		expect(result.result).toBe("ok");
		expect(result.attempts).toBe(1);
	});

	it("executeWithFallback falls back on retryable error", async () => {
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
			fallback: { config: { maxRetries: 1, baseDelayMs: 1 } },
		});
		const fn = vi.fn().mockRejectedValueOnce(new Error("429 rate limit")).mockResolvedValueOnce("recovered");
		const result = await mm.executeWithFallback("coding", fn);
		expect(result.result).toBe("recovered");
		expect(result.attempts).toBe(2);
	});

	it("tracks usage via budget", async () => {
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});
		const { status } = await mm.trackUsage("anthropic", 1000, 0.5);
		expect(status.tokensUsed).toBe(1000);
		expect(status.costUsed).toBe(0.5);
	});

	it("applies per-model settings to options", () => {
		const dbs = createMockDbs();
		dbs.settings.push({
			id: "s-1",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			temperature: 0.3,
			maxTokens: 2048,
			thinking: "low",
			isDefault: false,
			priority: 0,
		});
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});
		// Need to trigger load
		mm.getRouter()["loaded"] = true;
		for (const s of dbs.settings) {
			mm.getRouter()["modelSettings"].set(`${s.provider}/${s.model}`, s);
		}

		const route = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
		const options = mm.applySettingsToOptions(route, { someExisting: "value" });
		expect(options.someExisting).toBe("value");
		expect((options as any).temperature).toBe(0.3);
		expect((options as any).maxTokens).toBe(2048);
		expect((options as any).thinking).toBe("low");
	});

	it("does not override explicitly set values in applySettingsToOptions", () => {
		const dbs = createMockDbs();
		dbs.settings.push({
			id: "s-1",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			temperature: 0.3,
			maxTokens: 2048,
			thinking: "low",
			isDefault: false,
			priority: 0,
		});
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});
		mm.getRouter()["loaded"] = true;
		for (const s of dbs.settings) {
			mm.getRouter()["modelSettings"].set(`${s.provider}/${s.model}`, s);
		}

		const route = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
		const options = mm.applySettingsToOptions(route, { temperature: 0.9 });
		expect((options as any).temperature).toBe(0.9); // Explicit value preserved
		expect((options as any).maxTokens).toBe(2048); // DB setting applied
	});

	it("manages routing rules", async () => {
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});

		await mm.addRoutingRule({ name: "test", provider: "ollama", model: "llama3", enabled: true });
		let rules = await mm.getRoutingRules();
		expect(rules.some((r) => r.name === "test")).toBe(true);

		await mm.removeRoutingRule("test");
		rules = await mm.getRoutingRules();
		expect(rules.some((r) => r.name === "test")).toBe(false);
	});

	it("emits budget alerts via onBudgetAlert", async () => {
		const alertHandler = vi.fn();
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
			onAlert: alertHandler,
		});
		await mm.configureBudget({ provider: "anthropic", period: "daily", costLimit: 1.0 });
		await mm.trackUsage("anthropic", 10000, 1.5);
		expect(alertHandler).toHaveBeenCalledTimes(1);
		expect((alertHandler.mock.calls[0][0] as BudgetAlert).type).toBe("exceeded");
	});

	it("exposes subsystem accessors", () => {
		const dbs = createMockDbs();
		const mm = new ModelManager({
			router: { db: dbs.routerDb },
			budget: { db: dbs.budgetDb },
		});
		expect(mm.getRouter()).toBeDefined();
		expect(mm.getFallbackChain()).toBeDefined();
		expect(mm.getBudgetTracker()).toBeDefined();
	});
});
