import { describe, expect, it } from "vitest";
import { DEFAULT_QUEUE_MAX_SIZE, InMemoryMessageQueue } from "../message-queue.js";

// ============================================================================
// Unit tests — InMemoryMessageQueue (F-2.4)
// ============================================================================

describe("InMemoryMessageQueue", () => {
	it("TC-F-2.4-1: FIFO order is preserved (A, B, C → A, B, C)", async () => {
		const queue = new InMemoryMessageQueue<string>();

		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");
		await queue.enqueue("sess-1", "C");

		const first = await queue.dequeue("sess-1");
		const second = await queue.dequeue("sess-1");
		const third = await queue.dequeue("sess-1");

		expect(first?.message).toBe("A");
		expect(second?.message).toBe("B");
		expect(third?.message).toBe("C");

		// Timestamps must be recorded and non-decreasing (FIFO enqueue order).
		expect(first!.timestamp).toBeLessThanOrEqual(second!.timestamp);
		expect(second!.timestamp).toBeLessThanOrEqual(third!.timestamp);
	});

	it("TC-F-2.4-2: sessions are independent; dequeue on empty queue returns null", async () => {
		const queue = new InMemoryMessageQueue<string>();

		await queue.enqueue("sess-1", "a1");
		await queue.enqueue("sess-1", "a2");
		await queue.enqueue("sess-2", "b1");

		// Drain sess-1: only its own messages come out, in order.
		expect((await queue.dequeue("sess-1"))?.message).toBe("a1");
		expect((await queue.dequeue("sess-1"))?.message).toBe("a2");
		// sess-1 is now empty → null (documented contract).
		expect(await queue.dequeue("sess-1")).toBeNull();

		// sess-2 is untouched.
		expect(await queue.size("sess-2")).toBe(1);
		expect((await queue.dequeue("sess-2"))?.message).toBe("b1");
		expect(await queue.dequeue("sess-2")).toBeNull();

		// Dequeue on a session that never had a queue → null.
		expect(await queue.dequeue("sess-never")).toBeNull();
	});

	it("10 concurrent enqueues lose nothing (size === 10)", async () => {
		const queue = new InMemoryMessageQueue<number>();

		await Promise.all(Array.from({ length: 10 }, (_, i) => queue.enqueue("sess-1", i)));

		expect(await queue.size("sess-1")).toBe(10);

		// All 10 items are retrievable — nothing lost under concurrency.
		const seen = new Set<number>();
		for (let i = 0; i < 10; i++) {
			const item = await queue.dequeue("sess-1");
			expect(item).not.toBeNull();
			seen.add(item!.message);
		}
		expect(seen.size).toBe(10);
		expect(await queue.size("sess-1")).toBe(0);
	});

	it("concurrent enqueue + dequeue interleavings never lose or duplicate items", async () => {
		const queue = new InMemoryMessageQueue<number>();
		const enqueued = Array.from({ length: 20 }, (_, i) => i);
		const dequeued: number[] = [];

		// Run producers and a consumer concurrently against the same session.
		const producers = enqueued.map((n) => queue.enqueue("sess-1", n));
		const consumer = (async () => {
			// Poll until all 20 items have been consumed.
			while (dequeued.length < enqueued.length) {
				const item = await queue.dequeue("sess-1");
				if (item !== null) {
					dequeued.push(item.message);
				} else {
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			}
		})();

		await Promise.all([...producers, consumer]);

		expect([...dequeued].sort((a, b) => a - b)).toEqual(enqueued);
		expect(await queue.size("sess-1")).toBe(0);
	});

	it("peek returns the head without removing it", async () => {
		const queue = new InMemoryMessageQueue<string>();

		// peek on missing/empty queue → null.
		expect(await queue.peek("sess-1")).toBeNull();

		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");

		const peeked1 = await queue.peek("sess-1");
		const peeked2 = await queue.peek("sess-1");
		expect(peeked1?.message).toBe("A");
		expect(peeked2?.message).toBe("A");
		// Size unchanged — peek must not remove.
		expect(await queue.size("sess-1")).toBe(2);

		// After dequeue, peek sees the next head.
		await queue.dequeue("sess-1");
		expect((await queue.peek("sess-1"))?.message).toBe("B");
	});

	it("size returns 0 for a session with no queue", async () => {
		const queue = new InMemoryMessageQueue<string>();
		expect(await queue.size("unknown")).toBe(0);

		await queue.enqueue("sess-1", "A");
		expect(await queue.size("sess-1")).toBe(1);
		await queue.dequeue("sess-1");
		expect(await queue.size("sess-1")).toBe(0);
	});

	it("dequeueOldest returns the globally-oldest message across sessions (F-2.5)", async () => {
		const queue = new InMemoryMessageQueue<string>();

		// Empty → null.
		expect(await queue.dequeueOldest()).toBeNull();

		// Enqueue in order: sess-2 first, then sess-1, then sess-2 again.
		await queue.enqueue("sess-2", "b1");
		await queue.enqueue("sess-1", "a1");
		await queue.enqueue("sess-2", "b2");

		// Global FIFO by timestamp: b1 (oldest) → a1 → b2.
		const first = await queue.dequeueOldest();
		expect(first?.sessionId).toBe("sess-2");
		expect(first?.item.message).toBe("b1");

		const second = await queue.dequeueOldest();
		expect(second?.sessionId).toBe("sess-1");
		expect(second?.item.message).toBe("a1");

		const third = await queue.dequeueOldest();
		expect(third?.sessionId).toBe("sess-2");
		expect(third?.item.message).toBe("b2");

		expect(await queue.dequeueOldest()).toBeNull();
	});

	describe("overflow protection (F-2.15)", () => {
		it("TC-F-2.15-1: 51st message is rejected when the queue holds 50 (default limit); size stays 50", async () => {
			const queue = new InMemoryMessageQueue<string>();
			expect(queue.maxSize).toBe(DEFAULT_QUEUE_MAX_SIZE);
			expect(DEFAULT_QUEUE_MAX_SIZE).toBe(50);

			// Fill the queue to the default limit.
			for (let i = 1; i <= DEFAULT_QUEUE_MAX_SIZE; i++) {
				const position = await queue.enqueue("sess-1", `m${i}`);
				expect(position).toBe(i);
			}
			expect(await queue.size("sess-1")).toBe(50);

			// 51st message → rejected (null), queue unchanged.
			const rejected = await queue.enqueue("sess-1", "overflow");
			expect(rejected).toBeNull();
			expect(await queue.size("sess-1")).toBe(50);

			// The rejected message must NOT be retrievable; head is still m1.
			expect((await queue.peek("sess-1"))?.message).toBe("m1");
		});

		it("after dequeue, enqueue succeeds again (limit is not a hard stop)", async () => {
			const queue = new InMemoryMessageQueue<string>({ maxSize: 2 });

			expect(await queue.enqueue("sess-1", "A")).toBe(1);
			expect(await queue.enqueue("sess-1", "B")).toBe(2);
			expect(await queue.enqueue("sess-1", "C")).toBeNull();

			// Free one slot → enqueue works again.
			expect((await queue.dequeue("sess-1"))?.message).toBe("A");
			expect(await queue.enqueue("sess-1", "C")).toBe(2);
			expect(await queue.size("sess-1")).toBe(2);

			// FIFO preserved: B, then C.
			expect((await queue.dequeue("sess-1"))?.message).toBe("B");
			expect((await queue.dequeue("sess-1"))?.message).toBe("C");
			expect(await queue.dequeue("sess-1")).toBeNull();
		});

		it("limit is configurable via constructor and applies per session", async () => {
			const queue = new InMemoryMessageQueue<string>({ maxSize: 2 });
			expect(queue.maxSize).toBe(2);

			await queue.enqueue("sess-1", "a1");
			await queue.enqueue("sess-1", "a2");
			expect(await queue.enqueue("sess-1", "a3")).toBeNull();

			// Other sessions are unaffected by sess-1 being full.
			expect(await queue.enqueue("sess-2", "b1")).toBe(1);
			expect(await queue.enqueue("sess-2", "b2")).toBe(2);
			expect(await queue.enqueue("sess-2", "b3")).toBeNull();
		});

		it("rejects invalid maxSize (non-integer / < 1)", () => {
			expect(() => new InMemoryMessageQueue({ maxSize: 0 })).toThrow();
			expect(() => new InMemoryMessageQueue({ maxSize: -1 })).toThrow();
			expect(() => new InMemoryMessageQueue({ maxSize: 1.5 })).toThrow();
		});
	});
});
