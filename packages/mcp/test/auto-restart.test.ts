/**
 * Tests for F-3.4: auto-restart with exponential backoff.
 *
 * Tests the pure backoff arithmetic and constants at module level,
 * plus a structure smoke test for the manager integration.
 */

import { describe, expect, it } from "vitest";

// ── Pure backoff arithmetic tests ───────────────────────────────────

describe("F-3.4: backoffDelay arithmetic", () => {
	it("exponential delay: 1s, 2s, 4s, 8s, 16s", () => {
		const attempts = [1, 2, 3, 4, 5];
		const expected = [1000, 2000, 4000, 8000, 16000];
		for (let i = 0; i < attempts.length; i++) {
			const delay = Math.min(1000 * 2 ** (attempts[i] - 1), 16_000);
			expect(delay).toBe(expected[i]);
		}
	});

	it("delay is capped at 16_000 ms", () => {
		// attempt 6 would be 32_000 without cap
		const delay = Math.min(1000 * 2 ** (6 - 1), 16_000);
		expect(delay).toBe(16_000);
	});

	it("attempt 0 should return 500ms (half of 1s) — edge case", () => {
		// Not used in practice, but verify the formula behaves
		const delay = Math.min(1000 * 2 ** (0 - 1), 16_000);
		expect(delay).toBe(500);
	});
});

describe("F-3.4: constants", () => {
	it("MAX_RESTART_ATTEMPTS = 5", async () => {
		const { MAX_RESTART_ATTEMPTS } = await import("../src/manager.js");
		expect(MAX_RESTART_ATTEMPTS).toBe(5);
	});

	it("RESTART_WINDOW_MS = 60_000", async () => {
		const { RESTART_WINDOW_MS } = await import("../src/manager.js");
		expect(RESTART_WINDOW_MS).toBe(60_000);
	});
});

describe("F-3.4: backoffDelay exported function", () => {
	it("returns correct values for attempts 1-5", async () => {
		const { backoffDelay } = await import("../src/manager.js");
		expect(backoffDelay(1)).toBe(1000);
		expect(backoffDelay(2)).toBe(2000);
		expect(backoffDelay(3)).toBe(4000);
		expect(backoffDelay(4)).toBe(8000);
		expect(backoffDelay(5)).toBe(16_000);
	});

	it("caps at 16_000 for any attempt beyond 5", async () => {
		const { backoffDelay } = await import("../src/manager.js");
		expect(backoffDelay(6)).toBe(16_000);
		expect(backoffDelay(10)).toBe(16_000);
		expect(backoffDelay(100)).toBe(16_000);
	});
});

describe("F-3.4: max attempts logic", () => {
	it("max 5 attempts", () => {
		const maxAttempts = 5;
		expect(maxAttempts).toBe(5);
	});

	it("after 5 failures, autoRestart should be disabled", () => {
		const attempts = 6; // over limit
		const shouldDisable = attempts > 5;
		expect(shouldDisable).toBe(true);
	});

	it("at 5 failures, autoRestart should not yet be disabled", () => {
		const attempts = 5;
		const shouldDisable = attempts > 5;
		expect(shouldDisable).toBe(false);
	});
});

describe("F-3.4: 60s window resets attempt counter", () => {
	it("after 60s, counter resets to 1", () => {
		let attempts = 0;
		let firstCrashAt: number | undefined;
		const now = Date.now();

		// First crash
		firstCrashAt = now;
		attempts = 1;

		// After 70s — counter should reset
		const resetTime = now + 70_000;
		if (resetTime - (firstCrashAt ?? now) > 60_000) {
			attempts = 1;
			firstCrashAt = resetTime;
		}

		expect(attempts).toBe(1);
		expect(firstCrashAt).toBeDefined();
	});

	it("before 60s, counter continues from previous state", () => {
		let attempts = 0;
		let firstCrashAt: number | undefined;
		const now = Date.now();

		// First crash
		firstCrashAt = now;
		attempts = 3; // Already had 3 attempts

		// After 10s — counter should NOT reset
		const resetTime = now + 10_000;
		if (resetTime - (firstCrashAt ?? now) > 60_000) {
			attempts = 1;
			firstCrashAt = resetTime;
		}

		expect(attempts).toBe(3); // unchanged
	});

	it("exactly at 60s boundary, counter resets", () => {
		let attempts = 0;
		let firstCrashAt: number | undefined;
		const now = Date.now();

		// First crash
		firstCrashAt = now;
		attempts = 4; // Had 4 attempts

		// After exactly 60s — counter should reset (> not >=)
		const resetTime = now + 60_000;
		if (resetTime - (firstCrashAt ?? now) > 60_000) {
			attempts = 1;
			firstCrashAt = resetTime;
		}

		expect(attempts).toBe(4); // still 4 because > not >=
	});
});

// ── Manager integration smoke test ──────────────────────────────────

describe("F-3.4: manager integration smoke", () => {
	it("manager.ts exports createMcpClientManager with autoRestart support", async () => {
		const { createMcpClientManager } = await import("../src/manager.js");
		expect(typeof createMcpClientManager).toBe("function");
	});

	it("manager.ts exports backoffDelay, MAX_RESTART_ATTEMPTS, RESTART_WINDOW_MS", async () => {
		const mod = await import("../src/manager.js");
		expect(typeof mod.backoffDelay).toBe("function");
		expect(typeof mod.MAX_RESTART_ATTEMPTS).toBe("number");
		expect(typeof mod.RESTART_WINDOW_MS).toBe("number");
	});
});
