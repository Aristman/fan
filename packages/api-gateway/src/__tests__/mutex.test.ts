import { describe, expect, it } from "vitest";
import { Mutex } from "../mutex.js";

// ============================================================================
// Unit tests — InMemoryMutex (F-2.3)
// ============================================================================

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Mutex", () => {
	it("TC-F-2.3-1: two parallel withLock calls are serialized (strict order)", async () => {
		const mutex = new Mutex();
		const order: string[] = [];

		const first = mutex.withLock(async () => {
			order.push("first:start");
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("first:end");
			return "first";
		});

		// Ensure the first caller has acquired the lock before the second starts.
		await tick();

		const second = mutex.withLock(async () => {
			order.push("second:start");
			order.push("second:end");
			return "second";
		});

		const [r1, r2] = await Promise.all([first, second]);

		expect(r1).toBe("first");
		expect(r2).toBe("second");
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("TC-F-2.3-2: withLock returns the value produced by fn", async () => {
		const mutex = new Mutex();
		const result = await mutex.withLock(() => 42);
		expect(result).toBe(42);
	});

	it("exception in fn releases the lock; the next withLock still runs", async () => {
		const mutex = new Mutex();
		const order: string[] = [];

		const failing = mutex.withLock(async () => {
			order.push("failing");
			throw new Error("boom");
		});
		// Attach the rejection handler immediately to avoid unhandled rejections.
		const failingAssertion = expect(failing).rejects.toThrow("boom");

		await tick();

		const succeeding = mutex.withLock(async () => {
			order.push("succeeding");
			return "ok";
		});

		await failingAssertion;
		await expect(succeeding).resolves.toBe("ok");
		expect(order).toEqual(["failing", "succeeding"]);

		// Lock must be fully usable afterwards.
		await expect(mutex.withLock(() => "after")).resolves.toBe("after");
	});

	it("FIFO order is preserved for 3+ waiters", async () => {
		const mutex = new Mutex();
		const order: number[] = [];

		// Hold the lock so that all subsequent callers queue up.
		let releaseHolder: () => void;
		const holder = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holderLock = mutex.withLock(async () => {
			await holder;
		});

		await tick();

		const waiters = [0, 1, 2, 3].map((i) =>
			mutex.withLock(() => {
				order.push(i);
			}),
		);

		await tick();
		releaseHolder!();

		await Promise.all([holderLock, ...waiters]);
		expect(order).toEqual([0, 1, 2, 3]);
	});

	it("acquire/release manage the locked state manually", async () => {
		const mutex = new Mutex();
		const order: string[] = [];

		await mutex.acquire();
		const pending = (async () => {
			await mutex.acquire();
			order.push("acquired");
			mutex.release();
		})();

		await tick();
		expect(order).toEqual([]); // still waiting — lock held

		mutex.release();
		await pending;
		expect(order).toEqual(["acquired"]);
	});
});
