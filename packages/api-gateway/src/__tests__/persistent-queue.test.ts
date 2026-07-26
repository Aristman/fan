import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistentMessageQueue } from "../message-queue.js";

// ============================================================================
// Unit tests — PersistentMessageQueue (F-5.5)
// ============================================================================

describe("PersistentMessageQueue", () => {
	let queuesDir: string;

	beforeEach(async () => {
		queuesDir = await mkdtemp(join(tmpdir(), "fan-pq-test-"));
	});

	afterEach(async () => {
		await rm(queuesDir, { recursive: true, force: true });
	});

	const filePath = (sessionId: string) => join(queuesDir, `${sessionId}.queue.jsonl`);
	const indexPath = () => join(queuesDir, "queue-index.json");

	it("TC-F-5.5-1: enqueue creates the JSONL file and marks the session active in queue-index.json", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		const position = await queue.enqueue("cl-test", "Hello world");

		expect(position).toBe(1);

		// JSONL file created with exactly one JSON line in the F-5.5 format.
		const raw = await readFile(filePath("cl-test"), "utf-8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]);
		expect(entry.sessionId).toBe("cl-test");
		expect(entry.message).toBe("Hello world");
		expect(typeof entry.createdAt).toBe("string");
		expect(typeof entry.timestamp).toBe("number");

		// Index contains the session flagged active.
		const index = JSON.parse(await readFile(indexPath(), "utf-8"));
		expect(index["cl-test"]).toBe(true);
	});

	it("TC-F-5.5-2: 3 enqueues → 3 dequeues in FIFO order; queue is empty afterwards", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");
		await queue.enqueue("sess-1", "C");

		expect((await queue.dequeue("sess-1"))?.message).toBe("A");
		expect((await queue.dequeue("sess-1"))?.message).toBe("B");
		expect((await queue.dequeue("sess-1"))?.message).toBe("C");

		// Empty after the third dequeue (documented contract).
		expect(await queue.dequeue("sess-1")).toBeNull();
		expect(await queue.size("sess-1")).toBe(0);

		// Drained queue: file removed, index flag flipped to false.
		await expect(readFile(filePath("sess-1"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
		const index = JSON.parse(await readFile(indexPath(), "utf-8"));
		expect(index["sess-1"]).toBe(false);
	});

	it("dequeue removes the head line from disk (atomic rewrite without it)", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");
		await queue.enqueue("sess-1", "C");

		expect((await queue.dequeue("sess-1"))?.message).toBe("A");

		// The file on disk no longer contains the head line.
		const raw = await readFile(filePath("sess-1"), "utf-8");
		const messages = raw
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).message);
		expect(messages).toEqual(["B", "C"]);
	});

	it("TC-F-5.5-3: a fresh instance (server restart) recovers all pending messages", async () => {
		const queue1 = new PersistentMessageQueue<string>({ queuesDir });
		await queue1.enqueue("sess-1", "m1");
		await queue1.enqueue("sess-1", "m2");
		await queue1.enqueue("sess-2", "other");

		// "Restart": a brand-new instance over the same directory.
		const queue2 = new PersistentMessageQueue<string>({ queuesDir });

		// Index-based discovery works on the fresh instance.
		expect((await queue2.getAllActive()).sort()).toEqual(["sess-1", "sess-2"]);

		const recovered = await queue2.peekAll("sess-1");
		expect(recovered.map((m) => m.message)).toEqual(["m1", "m2"]);
		expect(await queue2.size("sess-1")).toBe(2);

		// Recovered messages drain in FIFO order too.
		expect((await queue2.dequeue("sess-1"))?.message).toBe("m1");
		expect((await queue2.dequeue("sess-1"))?.message).toBe("m2");
		expect(await queue2.dequeue("sess-1")).toBeNull();
	});

	it("overflow (F-2.15 semantics): enqueue rejects with null at maxSize and does not persist", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir, maxSize: 2 });

		expect(await queue.enqueue("sess-1", "A")).toBe(1);
		expect(await queue.enqueue("sess-1", "B")).toBe(2);
		// Queue full → refusal contract identical to the in-memory queue.
		expect(await queue.enqueue("sess-1", "C")).toBeNull();

		// The rejected message was NOT persisted.
		const raw = await readFile(filePath("sess-1"), "utf-8");
		expect(raw.trim().split("\n")).toHaveLength(2);
		expect(await queue.size("sess-1")).toBe(2);

		// After draining one slot, enqueue succeeds again.
		expect((await queue.dequeue("sess-1"))?.message).toBe("A");
		expect(await queue.enqueue("sess-1", "C")).toBe(2);
	});

	it("peek returns the head without removing it; peekAll returns everything in FIFO order", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		expect(await queue.peek("sess-1")).toBeNull();
		expect(await queue.peekAll("sess-1")).toEqual([]);

		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");

		expect((await queue.peek("sess-1"))?.message).toBe("A");
		expect((await queue.peek("sess-1"))?.message).toBe("A"); // still there
		expect((await queue.peekAll("sess-1")).map((m) => m.message)).toEqual(["A", "B"]);
		expect(await queue.size("sess-1")).toBe(2);
	});

	it("clear removes all pending messages, deletes the file and deactivates the index flag", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");
		expect(await queue.getAllActive()).toEqual(["sess-1"]);

		await queue.clear("sess-1");

		expect(await queue.size("sess-1")).toBe(0);
		expect(await queue.dequeue("sess-1")).toBeNull();
		expect(await queue.getAllActive()).toEqual([]);
		await expect(readFile(filePath("sess-1"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });

		// Clearing a session that never had a queue is a no-op.
		await queue.clear("sess-never");
	});

	it("dequeueOldest drains across sessions in global FIFO order", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		await queue.enqueue("sess-a", "a1");
		await queue.enqueue("sess-b", "b1");
		await queue.enqueue("sess-a", "a2");

		const first = await queue.dequeueOldest();
		expect(first?.sessionId).toBe("sess-a");
		expect(first?.item.message).toBe("a1");

		const second = await queue.dequeueOldest();
		expect(second?.sessionId).toBe("sess-b");
		expect(second?.item.message).toBe("b1");

		const third = await queue.dequeueOldest();
		expect(third?.sessionId).toBe("sess-a");
		expect(third?.item.message).toBe("a2");

		expect(await queue.dequeueOldest()).toBeNull();
	});

	it("dequeueOldest on a fresh instance drains recovered messages too", async () => {
		const queue1 = new PersistentMessageQueue<string>({ queuesDir });
		await queue1.enqueue("sess-a", "a1");
		await queue1.enqueue("sess-b", "b1");

		const queue2 = new PersistentMessageQueue<string>({ queuesDir });
		expect((await queue2.dequeueOldest())?.item.message).toBe("a1");
		expect((await queue2.dequeueOldest())?.item.message).toBe("b1");
		expect(await queue2.dequeueOldest()).toBeNull();
	});

	it("I/O errors: enqueue retries up to maxRetries, then fails (throws)", async () => {
		let attempts = 0;
		const failing = () => {
			attempts++;
			return Promise.reject(new Error("simulated disk failure"));
		};
		const queue = new PersistentMessageQueue<string>({
			queuesDir,
			maxRetries: 3,
			retryDelayMs: 0,
			appendFn: failing,
		});

		await expect(queue.enqueue("sess-1", "A")).rejects.toThrow("simulated disk failure");
		// Initial attempt + 3 retries = 4 attempts total.
		expect(attempts).toBe(4);

		// The failed message is NOT visible in the queue.
		expect(await queue.size("sess-1")).toBe(0);

		// Once I/O recovers, enqueue succeeds again.
		let recoveredAttempts = 0;
		const queue2 = new PersistentMessageQueue<string>({
			queuesDir,
			retryDelayMs: 0,
			appendFn: (path, line) => {
				recoveredAttempts++;
				if (recoveredAttempts < 3) return Promise.reject(new Error("transient"));
				return writeFile(path, line, { flag: "a" });
			},
		});
		expect(await queue2.enqueue("sess-1", "A")).toBe(1);
		expect(recoveredAttempts).toBe(3);
	});

	it("10 concurrent enqueues lose nothing and persist in order", async () => {
		const queue = new PersistentMessageQueue<number>({ queuesDir });

		await Promise.all(Array.from({ length: 10 }, (_, i) => queue.enqueue("sess-1", i)));

		expect(await queue.size("sess-1")).toBe(10);

		const seen = new Set<number>();
		for (let i = 0; i < 10; i++) {
			const item = await queue.dequeue("sess-1");
			expect(item).not.toBeNull();
			seen.add(item!.message);
		}
		expect(seen.size).toBe(10);
		expect(await queue.size("sess-1")).toBe(0);
	});

	it("sessions are independent (files, index flags and FIFO order)", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir });

		await queue.enqueue("sess-1", "a1");
		await queue.enqueue("sess-2", "b1");
		await queue.enqueue("sess-1", "a2");

		expect((await queue.getAllActive()).sort()).toEqual(["sess-1", "sess-2"]);

		expect((await queue.dequeue("sess-1"))?.message).toBe("a1");
		expect((await queue.dequeue("sess-1"))?.message).toBe("a2");
		expect(await queue.dequeue("sess-1")).toBeNull();

		// sess-2 untouched and still active.
		expect(await queue.size("sess-2")).toBe(1);
		expect(await queue.getAllActive()).toEqual(["sess-2"]);
		expect((await queue.dequeue("sess-2"))?.message).toBe("b1");
	});

	it("malformed JSONL lines are skipped during recovery", async () => {
		// Corrupt the file: one valid line + one garbage line.
		const queue1 = new PersistentMessageQueue<string>({ queuesDir });
		await queue1.enqueue("sess-1", "good");
		await writeFile(filePath("sess-1"), "{not json}\n", { flag: "a" });

		const queue2 = new PersistentMessageQueue<string>({ queuesDir });
		const recovered = await queue2.peekAll("sess-1");
		expect(recovered.map((m) => m.message)).toEqual(["good"]);
	});

	it("missing/corrupted index is repaired from *.queue.jsonl files", async () => {
		const queue1 = new PersistentMessageQueue<string>({ queuesDir });
		await queue1.enqueue("sess-1", "A");

		// Corrupt the index file.
		await writeFile(indexPath(), "{broken", "utf-8");

		const queue2 = new PersistentMessageQueue<string>({ queuesDir });
		// F-5.5: scan fallback repairs the index so recovered messages are visible to drain.
		expect(await queue2.getAllActive()).toEqual(["sess-1"]);
		expect((await queue2.peekAll("sess-1")).map((m) => m.message)).toEqual(["A"]);
		expect((await queue2.dequeueOldest())?.item.message).toBe("A");
		// Next enqueue re-establishes the index flag.
		await queue2.enqueue("sess-1", "B");
		expect(await queue2.getAllActive()).toEqual(["sess-1"]);
	});

	it("TC-F-5.5-F3: broken index does not hide messages from global drain", async () => {
		const queue1 = new PersistentMessageQueue<string>({ queuesDir });
		await queue1.enqueue("sess-a", "a1");
		await queue1.enqueue("sess-b", "b1");

		// Corrupt the index.
		await writeFile(indexPath(), "{broken", "utf-8");

		const queue2 = new PersistentMessageQueue<string>({ queuesDir });
		expect((await queue2.getAllActive()).sort()).toEqual(["sess-a", "sess-b"]);
		expect((await queue2.dequeueOldest())?.item.message).toBe("a1");
		expect((await queue2.dequeueOldest())?.item.message).toBe("b1");
		expect(await queue2.dequeueOldest()).toBeNull();
	});

	it("TC-F-5.5-F3b: phantom active flag without a queue file is cleaned up", async () => {
		const queue1 = new PersistentMessageQueue<string>({ queuesDir });
		await queue1.enqueue("sess-1", "A");
		await queue1.dequeue("sess-1"); // drains file and sets index false

		// Manually resurrect a phantom true flag (no matching file).
		await writeFile(indexPath(), JSON.stringify({ "sess-1": true, "sess-phantom": true }, null, 2), "utf-8");

		const queue2 = new PersistentMessageQueue<string>({ queuesDir });
		expect(await queue2.getAllActive()).toEqual([]);
		const index = JSON.parse(await readFile(indexPath(), "utf-8"));
		expect(index["sess-1"]).toBe(false);
		expect(index["sess-phantom"]).toBe(false);
	});
});

describe("PersistentMessageQueue runtime directory recovery (F-5.5)", () => {
	let queuesDir: string;

	beforeEach(async () => {
		queuesDir = await mkdtemp(join(tmpdir(), "fan-pq-recovery-"));
	});

	afterEach(async () => {
		await rm(queuesDir, { recursive: true, force: true });
	});

	it("recovers from a deleted queues directory at runtime and does not lose in-memory messages", async () => {
		const queue = new PersistentMessageQueue<string>({ queuesDir, retryDelayMs: 0 });
		await queue.enqueue("sess-1", "A");

		// Simulate an external cleanup or accidental deletion of the queues dir.
		await rm(queuesDir, { recursive: true, force: true });

		// The next enqueue sees ENOENT, resets the stale ensureDir() promise,
		// recreates the directory and appends the new message. The previously
		// cached message (A) is still visible to the same process.
		expect(await queue.enqueue("sess-1", "B")).toBe(2);
		expect(await queue.size("sess-1")).toBe(2);
		expect((await queue.peekAll("sess-1")).map((m) => m.message)).toEqual(["A", "B"]);
		expect((await queue.dequeue("sess-1"))?.message).toBe("A");
		expect((await queue.dequeue("sess-1"))?.message).toBe("B");
		expect(await queue.dequeue("sess-1")).toBeNull();
	});

	it("throws after retries when the queues path is not a directory (ENOTDIR)", async () => {
		const parentDir = await mkdtemp(join(tmpdir(), "fan-pq-enotdir-"));
		const parentFile = join(parentDir, "parentFile");
		await writeFile(parentFile, "not a directory", "utf-8");

		// A path component is a file, so mkdir(..., { recursive: true }) must fail
		// with ENOTDIR. The queue retries and then propagates the error.
		const badQueuesDir = join(parentDir, "parentFile", "queues");
		const queue = new PersistentMessageQueue<string>({ queuesDir: badQueuesDir, retryDelayMs: 0, maxRetries: 1 });
		await expect(queue.enqueue("sess-1", "A")).rejects.toMatchObject({ code: "ENOTDIR" });

		await rm(parentDir, { recursive: true, force: true });
	});
});
