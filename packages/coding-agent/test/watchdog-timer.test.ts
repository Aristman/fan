/**
 * Unit tests for the WatchdogTimer class.
 *
 * These tests exercise the timer manager in isolation — no AgentSession,
 * no Agent, no faux model — just the WatchdogTimer with controlled callbacks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WatchdogTimeoutEvent, WatchdogTimer } from "../src/core/watchdog-timer.js";

describe("WatchdogTimer (unit)", () => {
	let timeouts: WatchdogTimeoutEvent[];
	let wd: WatchdogTimer;

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		timeouts = [];
		wd = new WatchdogTimer({
			onTimeout: (e) => timeouts.push(e),
			getTimeoutMs: () => 1000,
			isEnabled: () => true,
		});
	});

	afterEach(() => {
		wd.dispose();
		vi.useRealTimers();
	});

	it("fires onTimeout with correct metadata after the timeout elapses", async () => {
		wd.arm("tc-1", "bash");
		await vi.advanceTimersByTimeAsync(1000);

		expect(timeouts).toHaveLength(1);
		expect(timeouts[0].toolCallId).toBe("tc-1");
		expect(timeouts[0].toolName).toBe("bash");
		expect(timeouts[0].elapsedMs).toBeGreaterThanOrEqual(1000);
	});

	it("cancel stops a single timer without affecting others", async () => {
		wd.arm("tc-1", "bash");
		wd.arm("tc-2", "read");

		// Cancel only tc-1.
		wd.cancel("tc-1");

		await vi.advanceTimersByTimeAsync(1200);

		expect(timeouts).toHaveLength(1);
		expect(timeouts[0].toolCallId).toBe("tc-2");
		expect(timeouts[0].toolName).toBe("read");
	});

	it("dispose cancels all active timers", async () => {
		wd.arm("tc-1", "bash");
		wd.arm("tc-2", "read");
		wd.arm("tc-3", "write");

		wd.dispose();

		await vi.advanceTimersByTimeAsync(5000);

		expect(timeouts).toHaveLength(0);
		expect(wd.size).toBe(0);
	});

	it("reset extends only the target timer's deadline", async () => {
		wd.arm("tc-1", "bash");
		wd.arm("tc-2", "read");

		// At t=800, reset tc-1 only.
		await vi.advanceTimersByTimeAsync(800);
		wd.reset("tc-1");

		// At t=1200 (400 ms after reset), tc-1 should NOT have fired
		// (its deadline is now t=1800), but tc-2 should have fired at t=1000.
		await vi.advanceTimersByTimeAsync(400);
		expect(timeouts).toHaveLength(1);
		expect(timeouts[0].toolCallId).toBe("tc-2");

		// At t=1800, tc-1 fires.
		await vi.advanceTimersByTimeAsync(600);
		expect(timeouts).toHaveLength(2);
		expect(timeouts[1].toolCallId).toBe("tc-1");
	});

	it("elapsedMs is measured from the last reset, not from arm", async () => {
		wd.arm("tc-1", "bash");

		// Reset at t=500.
		await vi.advanceTimersByTimeAsync(500);
		wd.reset("tc-1");

		// Fire at t=1500 (1000 ms after reset at t=500).
		await vi.advanceTimersByTimeAsync(1000);
		expect(timeouts).toHaveLength(1);
		// elapsedMs should be ~1000 (from last reset), not ~1500 (from arm).
		expect(timeouts[0].elapsedMs).toBeGreaterThanOrEqual(1000);
		expect(timeouts[0].elapsedMs).toBeLessThan(1500);
	});

	it("does not arm when isEnabled returns false", async () => {
		const wd2 = new WatchdogTimer({
			onTimeout: (e) => timeouts.push(e),
			getTimeoutMs: () => 1000,
			isEnabled: () => false,
		});

		wd2.arm("tc-1", "bash");
		expect(wd2.size).toBe(0);

		await vi.advanceTimersByTimeAsync(2000);
		expect(timeouts).toHaveLength(0);

		wd2.dispose();
	});

	it("does not arm when timeoutMs is <= 0", async () => {
		const wd2 = new WatchdogTimer({
			onTimeout: (e) => timeouts.push(e),
			getTimeoutMs: () => 0,
			isEnabled: () => true,
		});

		wd2.arm("tc-1", "bash");
		expect(wd2.size).toBe(0);

		await vi.advanceTimersByTimeAsync(2000);
		expect(timeouts).toHaveLength(0);

		wd2.dispose();
	});
});
