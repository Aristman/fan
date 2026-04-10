import { describe, it, expect, vi, beforeEach } from "vitest";
import { BudgetTracker } from "../budget.js";
import type { BudgetAlert } from "../types.js";

function createMockBudgetDb() {
	const budgets: any[] = [];
	let idCounter = 0;

	return {
		getAllBudgets: async () => [...budgets],
		getBudget: async (provider: string | null, period: string) =>
			budgets.find((b) => (b.provider ?? "all") === (provider ?? "all") && b.period === period),
		upsertBudgetConfig: async (data: any) => {
			const key = `${data.provider ?? "all"}/${data.period}`;
			let existing = budgets.find((b) => `${b.provider ?? "all"}/${b.period}` === key);
			if (existing) {
				Object.assign(existing, data);
			} else {
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
		_getBudgets: () => budgets,
	};
}

describe("BudgetTracker", () => {
	let alertHandler: ReturnType<typeof vi.fn>;
	let mockDb: ReturnType<typeof createMockBudgetDb>;

	beforeEach(() => {
		alertHandler = vi.fn();
		mockDb = createMockBudgetDb();
	});

	it("starts with zero usage when no budget configured", async () => {
		const tracker = new BudgetTracker({ db: mockDb });
		const status = await tracker.check("anthropic", "daily");
		expect(status.tokensUsed).toBe(0);
		expect(status.costUsed).toBe(0);
		expect(status.exceeded).toBe(false);
	});

	it("tracks usage and returns updated status", async () => {
		const tracker = new BudgetTracker({ db: mockDb });
		const { status } = await tracker.track("anthropic", 100, 0.05);
		expect(status.tokensUsed).toBe(100);
		expect(status.costUsed).toBe(0.05);
	});

	it("accumulates usage across multiple tracks", async () => {
		const tracker = new BudgetTracker({ db: mockDb });
		await tracker.track("anthropic", 100, 0.05);
		await tracker.track("anthropic", 50, 0.025);
		const status = await tracker.check("anthropic");
		expect(status.tokensUsed).toBe(150);
		expect(status.costUsed).toBeCloseTo(0.075, 3);
	});

	it("fires warning alert at 80% threshold", async () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			onAlert: alertHandler,
			thresholds: { warning: 0.8, critical: 0.95, exceeded: 1.0 },
		});
		// Configure limit
		await tracker.configure({ provider: "anthropic", period: "daily", costLimit: 1.0 });
		// Track to 80% = $0.80
		await tracker.track("anthropic", 1000, 0.80);
		expect(alertHandler).toHaveBeenCalledTimes(1);
		expect((alertHandler.mock.calls[0][0] as BudgetAlert).type).toBe("warning");
	});

	it("fires exceeded alert at 100%", async () => {
		const tracker = new BudgetTracker({
			db: mockDb,
			onAlert: alertHandler,
			thresholds: { warning: 0.8, critical: 0.95, exceeded: 1.0 },
		});
		await tracker.configure({ provider: "anthropic", period: "daily", costLimit: 1.0 });
		await tracker.track("anthropic", 1000, 1.5);
		expect(alertHandler).toHaveBeenCalledTimes(1);
		expect((alertHandler.mock.calls[0][0] as BudgetAlert).type).toBe("exceeded");
	});

	it("detects exceeded status", async () => {
		const tracker = new BudgetTracker({ db: mockDb });
		await tracker.configure({ provider: "anthropic", period: "daily", tokenLimit: 100 });
		await tracker.track("anthropic", 150, 0);
		expect(await tracker.isExceeded("anthropic")).toBe(true);
	});

	it("reset clears counters", async () => {
		const tracker = new BudgetTracker({ db: mockDb });
		await tracker.track("anthropic", 500, 1.0);
		await tracker.reset("anthropic");
		const status = await tracker.check("anthropic");
		expect(status.tokensUsed).toBe(0);
		expect(status.costUsed).toBe(0);
	});

	it("checkAll returns all configured budgets", async () => {
		const tracker = new BudgetTracker({ db: mockDb });
		await tracker.track("anthropic", 100, 0.05);
		await tracker.track("openai", 200, 0.10);
		const all = await tracker.checkAll();
		expect(all.length).toBeGreaterThanOrEqual(2);
	});

	it("handles DB errors gracefully", async () => {
		const badDb = {
			...mockDb,
			getAllBudgets: async () => {
				throw new Error("DB down");
			},
			upsertBudgetConfig: async () => {
				throw new Error("DB down");
			},
		};
		const tracker = new BudgetTracker({ db: badDb, onAlert: alertHandler });
		// Should not throw
		const status = await tracker.check("anthropic");
		expect(status.tokensUsed).toBe(0);
	});

	it("onAlert returns unsubscribe function", () => {
		const tracker = new BudgetTracker();
		const unsub = tracker.onAlert(alertHandler);
		unsub();
		// No error on unsubscribe
	});
});
