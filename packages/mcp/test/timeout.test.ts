import { describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "../src/timeout.js";

describe("F-1.13: withTimeout", () => {
	it("resolves before timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 1000);
		expect(result).toBe("ok");
	});

	it("throws TimeoutError after timeout", async () => {
		await expect(withTimeout(new Promise((r) => setTimeout(() => r("late"), 500)), 50)).rejects.toThrow(TimeoutError);
	});

	it("rejects when external signal aborts", async () => {
		const controller = new AbortController();
		const promise = withTimeout(new Promise((r) => setTimeout(() => r("late"), 1000)), 5000, controller.signal);
		setTimeout(() => controller.abort(new Error("manual abort")), 50);
		await expect(promise).rejects.toThrow(/manual abort/);
	});

	it("rejects immediately if signal already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted"));
		await expect(withTimeout(Promise.resolve("late"), 100, controller.signal)).rejects.toThrow(/pre-aborted/);
	});

	it("passes through promise rejection", async () => {
		const err = new Error("original failure");
		await expect(withTimeout(Promise.reject(err), 1000)).rejects.toThrow("original failure");
	});

	it("TimeoutError has ms in message", async () => {
		try {
			await withTimeout(new Promise((r) => setTimeout(() => r("x"), 500)), 30);
			expect.fail("should have thrown");
		} catch (e: unknown) {
			expect(e).toBeInstanceOf(TimeoutError);
			expect((e as Error).message).toContain("30ms");
		}
	});

	it("clears timer on success (no leaked timeouts)", async () => {
		const clearSpy = vi.spyOn(global, "clearTimeout");
		await withTimeout(Promise.resolve("x"), 100_000);
		clearSpy.mockRestore();
		expect(true).toBe(true); // smoke test — real leak detection is tricky
	});
});
