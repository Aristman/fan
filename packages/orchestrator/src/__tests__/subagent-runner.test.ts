import { describe, it, expect } from "vitest";
import { formatTokens, formatUsageStats, getFinalOutput } from "../subagent-runner.js";

describe("formatTokens", () => {
	it("formats small numbers", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats thousands with k suffix", () => {
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("formats large numbers with k suffix", () => {
		expect(formatTokens(100000)).toBe("100k");
	});
});

describe("formatUsageStats", () => {
	it("formats empty stats", () => {
		expect(formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBe("");
	});

	it("formats with turns and tokens", () => {
		const result = formatUsageStats({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, cost: 0.01, turns: 3, contextTokens: 10000 });
		expect(result).toContain("3 turns");
		expect(result).toContain("↑1.0k");
		expect(result).toContain("↓500");
		expect(result).toContain("$0.0100");
	});

	it("includes model when provided", () => {
		const result = formatUsageStats({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 }, "test-model");
		expect(result).toContain("test-model");
	});
});

describe("getFinalOutput", () => {
	it("returns empty string for empty messages", () => {
		expect(getFinalOutput([])).toBe("");
	});

	it("returns last assistant text", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "response 1" }] },
			{ role: "assistant", content: [{ type: "text", text: "final response" }] },
		];
		expect(getFinalOutput(messages as any)).toBe("final response");
	});

	it("returns empty for user-only messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		];
		expect(getFinalOutput(messages as any)).toBe("");
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("runs items with concurrency limit", async () => {
		const { mapWithConcurrencyLimit } = await import("../subagent-runner.js");
		const executionOrder: number[] = [];
		const results = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (item) => {
			executionOrder.push(item);
			return item * 10;
		});
		expect(results).toEqual([10, 20, 30, 40]);
		expect(executionOrder).toHaveLength(4);
	});

	it("returns empty for empty input", async () => {
		const { mapWithConcurrencyLimit } = await import("../subagent-runner.js");
		const results = await mapWithConcurrencyLimit([], 2, async (item) => item);
		expect(results).toEqual([]);
	});
});
