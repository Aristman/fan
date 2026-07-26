import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FanApiError } from "./client.js";
import {
	DEFAULT_BASE_DELAY_MS,
	DEFAULT_MAX_RETRIES,
	RetryExhaustedError,
	computeBackoffDelayMs,
	isRetryableError,
	withRetry,
} from "./retry.js";

/** Injected sleep that records delays instead of waiting — keeps tests fast. */
function createSleepRecorder() {
	const delays: number[] = [];
	const sleep = vi.fn(async (ms: number) => {
		delays.push(ms);
	});
	return { sleep, delays };
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("computeBackoffDelayMs / defaults (F-4.10)", () => {
	it("delay = baseDelayMs * 2^(attempt-1) → 2s, 4s, 8s for attempts 1..3", () => {
		expect(DEFAULT_MAX_RETRIES).toBe(3);
		expect(DEFAULT_BASE_DELAY_MS).toBe(2000);
		expect(computeBackoffDelayMs(2000, 1)).toBe(2000);
		expect(computeBackoffDelayMs(2000, 2)).toBe(4000);
		expect(computeBackoffDelayMs(2000, 3)).toBe(8000);
	});
});

describe("isRetryableError (F-4.10)", () => {
	it("HTTP 5xx and 429 are retryable", () => {
		expect(isRetryableError(new FanApiError(500, "Internal Server Error"))).toBe(true);
		expect(isRetryableError(new FanApiError(502, "Bad Gateway"))).toBe(true);
		expect(isRetryableError(new FanApiError(503, "Service Unavailable"))).toBe(true);
		expect(isRetryableError(new FanApiError(429, "Too Many Requests"))).toBe(true);
	});

	it("HTTP 4xx other than 429 is NOT retryable", () => {
		expect(isRetryableError(new FanApiError(400, "Bad Request"))).toBe(false);
		expect(isRetryableError(new FanApiError(401, "Unauthorized"))).toBe(false);
		expect(isRetryableError(new FanApiError(403, "Forbidden"))).toBe(false);
		expect(isRetryableError(new FanApiError(404, "Not Found"))).toBe(false);
	});

	it("network/timeout/unexpected errors are retryable", () => {
		expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
		expect(isRetryableError(new Error("socket hang up"))).toBe(true);
		expect(isRetryableError("string failure")).toBe(true);
	});
});

describe("withRetry (F-4.10)", () => {
	// TC-F-4.10-1: first attempt fails, second succeeds.
	it("TC-F-4.10-1: error then success → attempts=2, backoff delay ~2s between attempts", async () => {
		const { sleep, delays } = createSleepRecorder();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new FanApiError(500, "Internal Server Error"))
			.mockResolvedValue("ok");

		const outcome = await withRetry(fn, { sleep });

		expect(outcome.value).toBe("ok");
		expect(outcome.attempts).toBe(2);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(delays).toEqual([2000]);
	});

	// TC-F-4.10-2: all attempts fail → exhausted.
	it("TC-F-4.10-2: always HTTP 500 → 3 attempts, delays 2s/4s/8s, RetryExhaustedError", async () => {
		const { sleep, delays } = createSleepRecorder();
		const fn = vi.fn().mockRejectedValue(new FanApiError(500, "Internal Server Error"));
		const events: Array<{ attempt: number; delayMs: number; willRetry: boolean }> = [];

		const promise = withRetry(fn, {
			sleep,
			onRetry: ({ attempt, delayMs, willRetry }) => events.push({ attempt, delayMs, willRetry }),
		});

		await expect(promise).rejects.toThrow(RetryExhaustedError);
		await expect(promise).rejects.toThrow("Internal Server Error");
		expect(fn).toHaveBeenCalledTimes(3);
		// Backoff sequence 2s, 4s, 8s — one delay per failed attempt.
		expect(delays).toEqual([2000, 4000, 8000]);
		expect(events).toEqual([
			{ attempt: 1, delayMs: 2000, willRetry: true },
			{ attempt: 2, delayMs: 4000, willRetry: true },
			{ attempt: 3, delayMs: 8000, willRetry: false },
		]);
		// The exhausted error carries the attempt count and the last error.
		const error = await promise.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RetryExhaustedError);
		expect((error as RetryExhaustedError).attempts).toBe(3);
		expect((error as RetryExhaustedError).cause).toBeInstanceOf(FanApiError);
	});

	it("HTTP 400 → fails immediately after 1 attempt, no backoff delay", async () => {
		const { sleep, delays } = createSleepRecorder();
		const badRequest = new FanApiError(400, "Bad Request");
		const fn = vi.fn().mockRejectedValue(badRequest);

		await expect(withRetry(fn, { sleep })).rejects.toBe(badRequest);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(delays).toEqual([]);
	});

	it("HTTP 429 → retryable: succeeds on the 3rd attempt with delays 2s/4s", async () => {
		const { sleep, delays } = createSleepRecorder();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new FanApiError(429, "Too Many Requests"))
			.mockRejectedValueOnce(new FanApiError(429, "Too Many Requests"))
			.mockResolvedValue("ok");

		const outcome = await withRetry(fn, { sleep });

		expect(outcome.value).toBe("ok");
		expect(outcome.attempts).toBe(3);
		expect(fn).toHaveBeenCalledTimes(3);
		expect(delays).toEqual([2000, 4000]);
	});

	it("network error (fetch failed) → retryable", async () => {
		const { sleep, delays } = createSleepRecorder();
		const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue("ok");

		const outcome = await withRetry(fn, { sleep });

		expect(outcome.attempts).toBe(2);
		expect(delays).toEqual([2000]);
	});

	it("success on the first attempt → attempts=1, no sleep", async () => {
		const { sleep, delays } = createSleepRecorder();
		const fn = vi.fn().mockResolvedValue("ok");

		const outcome = await withRetry(fn, { sleep });

		expect(outcome).toEqual({ value: "ok", attempts: 1 });
		expect(delays).toEqual([]);
	});

	it("respects maxRetries/baseDelayMs overrides", async () => {
		const { sleep, delays } = createSleepRecorder();
		const fn = vi.fn().mockRejectedValue(new FanApiError(500, "boom"));

		const promise = withRetry(fn, { sleep, maxRetries: 2, baseDelayMs: 100 });

		await expect(promise).rejects.toThrow(RetryExhaustedError);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(delays).toEqual([100, 200]);
	});
});
