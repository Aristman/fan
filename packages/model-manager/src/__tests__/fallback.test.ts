import { describe, expect, it, vi } from "vitest";
import { FallbackChain } from "../fallback.js";
import type { ModelRoute } from "../types.js";
import { FallbackError } from "../types.js";

describe("FallbackChain", () => {
	const primary: ModelRoute = { provider: "anthropic", model: "claude-sonnet" };
	const fallback1: ModelRoute = { provider: "openai", model: "gpt-4o" };
	const fallback2: ModelRoute = { provider: "google", model: "gemini" };

	it("executes primary route successfully without fallback", async () => {
		const chain = new FallbackChain();
		const fn = vi.fn().mockResolvedValue("success");

		const result = await chain.execute(primary, [fallback1], fn);
		expect(result.result).toBe("success");
		expect(result.route).toEqual(primary);
		expect(result.attempts).toBe(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith(primary);
	});

	it("falls back on retryable error", async () => {
		const chain = new FallbackChain({ config: { maxRetries: 1, baseDelayMs: 1 } }); // minimal delay for tests
		const fn = vi.fn().mockRejectedValueOnce(new Error("429 rate limit exceeded")).mockResolvedValueOnce("recovered");

		const result = await chain.execute(primary, [fallback1], fn);
		expect(result.result).toBe("recovered");
		expect(result.route).toEqual(fallback1);
		expect(result.attempts).toBe(2);
	});

	it("throws FallbackError when all routes exhausted", async () => {
		const chain = new FallbackChain({ config: { maxRetries: 1, baseDelayMs: 1 } });
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("429 rate limit"))
			.mockRejectedValueOnce(new Error("503 service unavailable"));

		await expect(chain.execute(primary, [fallback1], fn)).rejects.toThrow(FallbackError);
	});

	it("throws immediately on non-retryable error", async () => {
		const chain = new FallbackChain({ config: { maxRetries: 2, baseDelayMs: 1 } });
		const fn = vi.fn().mockRejectedValue(new Error("401 unauthorized"));

		await expect(chain.execute(primary, [fallback1, fallback2], fn)).rejects.toThrow(FallbackError);
		expect(fn).toHaveBeenCalledTimes(1); // Should not retry
	});

	it("classifies rate limit errors as retryable", () => {
		const chain = new FallbackChain();
		expect(chain.classifyError(new Error("429 too many requests"))).toBe("retryable");
		expect(chain.classifyError(new Error("rate limit exceeded"))).toBe("retryable");
	});

	it("classifies server errors as retryable", () => {
		const chain = new FallbackChain();
		expect(chain.classifyError(new Error("500 internal server error"))).toBe("retryable");
		expect(chain.classifyError(new Error("503 service unavailable"))).toBe("retryable");
		expect(chain.classifyError(new Error("overloaded"))).toBe("retryable");
	});

	it("classifies auth errors as permanent", () => {
		const chain = new FallbackChain();
		expect(chain.classifyError(new Error("401 unauthorized"))).toBe("permanent");
		expect(chain.classifyError(new Error("authentication failed"))).toBe("permanent");
	});

	it("handles errors with status codes", () => {
		const chain = new FallbackChain();
		expect(chain.classifyError({ status: 429, message: "rate limited" })).toBe("retryable");
		expect(chain.classifyError({ status: 500, message: "server error" })).toBe("retryable");
		expect(chain.classifyError({ status: 403, message: "forbidden" })).toBe("permanent");
	});

	it("respects maxRetries limit", async () => {
		const chain = new FallbackChain({ config: { maxRetries: 0, baseDelayMs: 1 } });
		const fn = vi.fn().mockRejectedValue(new Error("429 rate limit"));

		await expect(chain.execute(primary, [fallback1, fallback2], fn)).rejects.toThrow();
		expect(fn).toHaveBeenCalledTimes(1); // maxRetries=0 means only primary
	});
});
