import { Mutex } from "./mutex.js";

/**
 * InMemoryMessageQueue — per-session FIFO message queue (F-2.4).
 *
 * Each `sessionId` owns an independent queue (`Array<QueuedMessage>`) guarded
 * by its own {@link Mutex}, so concurrent `enqueue`/`dequeue` calls from the
 * WebSocket handler (F-2.5) are async-safe and never corrupt the order.
 *
 * Semantics:
 * - FIFO: `dequeue()` returns messages in the exact order they were enqueued.
 * - Empty queue: `dequeue()` and `peek()` return `null` (documented contract).
 * - `peek()` reads the head WITHOUT removing it.
 * - `size()` returns the queue length for the session (0 if the session has
 *   no queue).
 *
 * Known limitations (MVP):
 * - **In-memory only**: all queued messages are LOST on server restart.
 *   Persistence is out of scope for MVP.
 * - **No overflow limit**: queues grow unbounded. Overflow protection
 *   (default limit 50, `QUEUE_OVERFLOW` rejection) is implemented
 *   separately in F-2.15, which will extend this class. This is an
 *   intentional decision to keep the base implementation clean.
 */

/** A single queued message with its enqueue timestamp (ms since epoch). */
export interface QueuedMessage<T = unknown> {
	/** The raw message payload (WS message from the client). */
	message: T;
	/** Timestamp (Date.now()) when the message was enqueued. */
	timestamp: number;
	/** Monotonic global insertion counter — breaks timestamp ties so the
	 *  global dequeue order is a true FIFO even for same-millisecond enqueues. */
	seq: number;
}

/** Message queue interface — per-session FIFO operations. */
export interface MessageQueue<T = unknown> {
	/** Append a message to the tail of the session's queue.
	 *  Returns the 1-based position of the message in the session's queue. */
	enqueue(sessionId: string, message: T): Promise<number>;
	/** Remove and return the head message, or `null` if the queue is empty. */
	dequeue(sessionId: string): Promise<QueuedMessage<T> | null>;
	/** Return the head message WITHOUT removing it, or `null` if empty. */
	peek(sessionId: string): Promise<QueuedMessage<T> | null>;
	/** Number of queued messages for the session (0 if none). */
	size(sessionId: string): Promise<number>;
}

export class InMemoryMessageQueue<T = unknown> implements MessageQueue<T> {
	private readonly queues = new Map<string, Array<QueuedMessage<T>>>();
	private readonly mutexes = new Map<string, Mutex>();
	private seq = 0;

	/** Get (or lazily create) the mutex guarding the session's queue. */
	private mutexFor(sessionId: string): Mutex {
		let mutex = this.mutexes.get(sessionId);
		if (!mutex) {
			mutex = new Mutex();
			this.mutexes.set(sessionId, mutex);
		}
		return mutex;
	}

	/** Append `message` to the tail of the session's queue (FIFO).
	 *  Returns the 1-based position of the message in the session's queue. */
	async enqueue(sessionId: string, message: T): Promise<number> {
		return this.mutexFor(sessionId).withLock(() => {
			let queue = this.queues.get(sessionId);
			if (!queue) {
				queue = [];
				this.queues.set(sessionId, queue);
			}
			queue.push({ message, timestamp: Date.now(), seq: this.seq++ });
			return queue.length;
		});
	}

	/** Remove and return the head of the session's queue, or `null` if empty. */
	async dequeue(sessionId: string): Promise<QueuedMessage<T> | null> {
		return this.mutexFor(sessionId).withLock(() => {
			const queue = this.queues.get(sessionId);
			if (!queue || queue.length === 0) {
				return null;
			}
			const item = queue.shift() ?? null;
			// Housekeeping: drop the array once drained so the map does not
			// accumulate empty queues for long-lived servers. The mutex entry
			// is kept (it is cheap and avoids re-creation races).
			if (queue.length === 0) {
				this.queues.delete(sessionId);
			}
			return item;
		});
	}

	/** Return the head of the session's queue WITHOUT removing it, or `null` if empty. */
	async peek(sessionId: string): Promise<QueuedMessage<T> | null> {
		return this.mutexFor(sessionId).withLock(() => {
			const queue = this.queues.get(sessionId);
			if (!queue || queue.length === 0) {
				return null;
			}
			return queue[0];
		});
	}

	/** Number of queued messages for the session (0 if the session has no queue). */
	async size(sessionId: string): Promise<number> {
		return this.mutexFor(sessionId).withLock(() => {
			return this.queues.get(sessionId)?.length ?? 0;
		});
	}

	/**
	 * Remove and return the globally-oldest queued message across ALL sessions
	 * (smallest insertion sequence wins — global FIFO). Returns `null` when
	 * every queue is empty.
	 *
	 * Added for F-2.5: the background dequeue processor in ws-handler drains
	 * queued messages in global FIFO-by-timestamp order (NOT per-session), so a
	 * message for project A enqueued before a message for project B is always
	 * executed first.
	 *
	 * Race-safety note: the head scan reads `this.queues` without holding every
	 * per-session mutex. This is safe for the intended usage because (a)
	 * concurrent `enqueue()` calls only APPEND — they never replace the head of
	 * a non-empty queue — and (b) the only concurrent dequeuer is the single
	 * drain loop in ws-handler, serialized by its `draining` flag. The actual
	 * removal is mutex-guarded via {@link dequeue}.
	 */
	async dequeueOldest(): Promise<{ sessionId: string; item: QueuedMessage<T> } | null> {
		let oldestSessionId: string | null = null;
		let oldestSeq = Number.POSITIVE_INFINITY;
		for (const [sessionId, queue] of this.queues) {
			if (queue.length > 0 && queue[0].seq < oldestSeq) {
				oldestSeq = queue[0].seq;
				oldestSessionId = sessionId;
			}
		}
		if (!oldestSessionId) return null;
		const item = await this.dequeue(oldestSessionId);
		return item ? { sessionId: oldestSessionId, item } : null;
	}
}
