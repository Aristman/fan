/**
 * F-46 Iteration budget — AgentSession hooks (integration tests).
 *
 * Source of truth:
 *  - docs/features/super-orchestrator/depth-and-dashboard-3/roadmap.md §F-46
 *
 * The session wires ModelManager's per-iteration budget into the agent event
 * stream (synchronous hooks in AgentSession._handleAgentEvent):
 *
 *   agent_start / turn_start → check leftovers, then resetIteration()
 *   message_end (assistant)  → trackIterationUsage(tokens, cost)
 *   turn_end                 → checkIterationBudget(); on exceed:
 *                              emit `iteration_budget_exceeded` + abort (I1 drain)
 *
 * Behavior on exceed: the run stops BEFORE the next API call, the session
 * stays usable — the next prompt() starts a fresh iteration window.
 */

import { ModelManager } from "@fan/model-manager";
import type { AgentTool } from "@seaagents/fan-agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { createHarness, createHarnessWithExtensions, type Harness } from "./test-harness.js";

// ============================================================================
// Helpers
// ============================================================================

/** Mock DB adapter (same pattern as model-manager budget tests). */
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
	};
}

function makeModelManager(iterationBudgetTokens: number): ModelManager {
	return new ModelManager({
		budget: { db: createMockBudgetDb(), iterationBudgetTokens },
	});
}

function isBudgetExceeded(event: AgentSessionEvent): boolean {
	return (event as { type?: string }).type === "iteration_budget_exceeded";
}

/** Microtask-only polling helper (same style as agent-session-loop-detector tests). */
async function waitForEvent(
	events: AgentSessionEvent[],
	predicate: (e: AgentSessionEvent) => boolean,
	maxIterations = 2000,
): Promise<AgentSessionEvent | undefined> {
	for (let i = 0; i < maxIterations; i++) {
		const found = events.find(predicate);
		if (found) return found;
		await Promise.resolve();
	}
	return events.find(predicate);
}

/** Schedule a prompt on the next microtask so the caller can race listeners. */
function schedulePrompt(harness: Harness, text: string): Promise<unknown> {
	return new Promise((resolve) => {
		queueMicrotask(() => {
			harness.session.prompt(text).then(
				() => resolve(undefined),
				() => resolve(undefined),
			);
		});
	});
}

/** Trivial bash replacement so toolCall turns execute deterministically. */
function makeOkTool(): AgentTool {
	return {
		name: "bash",
		label: "bash",
		description: "ok tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

// ============================================================================
// Tests
// ============================================================================

describe("F-46 Iteration budget (AgentSession hooks)", () => {
	let harnesses: Harness[] = [];

	beforeEach(() => {
		harnesses = [];
	});

	afterEach(() => {
		for (const h of harnesses) {
			try {
				h.session.agent.abort();
			} catch {
				/* agent may already be disposed */
			}
			h.cleanup();
		}
		harnesses = [];
	});

	it("tracks usage from assistant message_end via trackIterationUsage", async () => {
		const modelManager = makeModelManager(10_000);
		const harness = createHarness({
			responses: [{ text: "ok", usage: { totalTokens: 150, cost: { ...ZERO_COST, total: 0.25 } } }],
			modelManager,
		});
		harnesses.push(harness);

		await harness.session.prompt("hi");

		const usage = modelManager.getIterationUsage();
		expect(usage.tokensUsed).toBe(150);
		expect(usage.costUsed).toBe(0.25);

		// Within budget — no exceeded event.
		expect(harness.events.filter(isBudgetExceeded)).toHaveLength(0);
	});

	it("turn_end exceed → iteration_budget_exceeded + abort before next API call + agent_end", async () => {
		const modelManager = makeModelManager(100);
		const okTool = makeOkTool();
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: {} }], usage: { totalTokens: 150 } },
				{ text: "final", usage: { totalTokens: 10 } },
			],
			tools: [okTool],
			baseToolsOverride: { bash: okTool },
			modelManager,
		});
		harnesses.push(harness);

		const promptPromise = schedulePrompt(harness, "run bash");

		const exceeded = await waitForEvent(harness.events, isBudgetExceeded);
		expect(exceeded).toBeDefined();
		expect((exceeded as unknown as { tokensUsed: number }).tokensUsed).toBe(150);
		expect((exceeded as unknown as { remaining: number }).remaining).toBe(-50);
		expect((exceeded as unknown as { message: string }).message).toContain("Iteration budget exceeded");

		// The run ends cleanly via agent_end; the session is NOT crashed.
		await waitForEvent(harness.events, (e) => e.type === "agent_end");
		expect(harness.events.some((e) => e.type === "agent_end")).toBe(true);

		// I1 drain: stopped BEFORE the next API call — "final" never requested.
		expect(harness.faux.callCount).toBe(1);

		await promptPromise.catch(() => {});
	});

	it("session stays usable after exceed: next prompt works with a fresh window", async () => {
		const modelManager = makeModelManager(100);
		const harness = createHarness({
			responses: [
				{ text: "first", usage: { totalTokens: 150 } }, // exceeds at turn_end
				{ text: "recovered", usage: { totalTokens: 10 } },
			],
			modelManager,
		});
		harnesses.push(harness);

		// Run 1: exceeds the iteration budget at turn_end.
		await harness.session.prompt("first prompt");
		expect(harness.events.filter(isBudgetExceeded)).toHaveLength(1);

		// Counters were reset by the exceed handler — fresh window.
		expect(modelManager.getIterationUsage().tokensUsed).toBe(0);

		// Run 2: session is alive, next prompt completes normally.
		await harness.session.prompt("second prompt");
		const assistantTexts = harness.session.messages
			.filter((m) => m.role === "assistant")
			.map((m) => (m.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text);
		expect(assistantTexts).toContain("recovered");

		// The small second run did NOT trigger another exceed.
		expect(harness.events.filter(isBudgetExceeded)).toHaveLength(1);
		expect(modelManager.getIterationUsage().tokensUsed).toBe(10);
	});

	it("resetIteration on new turn: per-turn windows do not accumulate within one run", async () => {
		const modelManager = makeModelManager(1_000);
		const okTool = makeOkTool();
		const harness = createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: {} }], usage: { totalTokens: 600 } },
				{ text: "done", usage: { totalTokens: 600 } },
			],
			tools: [okTool],
			baseToolsOverride: { bash: okTool },
			modelManager,
		});
		harnesses.push(harness);

		await harness.session.prompt("two turns");

		// Each turn used 600 (< 1000). Without the turn_start reset the
		// cumulative 1200 would have exceeded — the run must complete normally.
		expect(harness.events.filter(isBudgetExceeded)).toHaveLength(0);
		expect(harness.faux.callCount).toBe(2);
		expect(harness.events.some((e) => e.type === "agent_end")).toBe(true);
	});

	it("forwards iteration_budget_exceeded to extensions via fan.on", async () => {
		const modelManager = makeModelManager(100);
		const received: Array<{ tokensUsed: number; costUsed: number; remaining: number; message: string }> = [];

		const harness = await createHarnessWithExtensions({
			responses: [{ text: "x", usage: { totalTokens: 150 } }],
			modelManager,
			extensionFactories: [
				{
					path: "<f46-probe>",
					factory: (fan) => {
						fan.on("iteration_budget_exceeded", (event) => {
							received.push({
								tokensUsed: event.tokensUsed,
								costUsed: event.costUsed,
								remaining: event.remaining,
								message: event.message,
							});
						});
					},
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("hi");

		// Drain microtasks so the fire-and-forget extension emit settles.
		for (let i = 0; i < 100 && received.length === 0; i++) {
			await Promise.resolve();
		}

		expect(received).toHaveLength(1);
		expect(received[0].tokensUsed).toBe(150);
		expect(received[0].remaining).toBe(-50);
		expect(received[0].message).toContain("Iteration budget exceeded");
	});
});
