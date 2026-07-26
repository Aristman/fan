/**
 * InMemoryMutex — minimal asynchronous mutex (F-2.3).
 *
 * Roadmap places this module at `packages/coding-agent/src/workspace/mutex.ts`,
 * but its consumer (MessageQueue, F-2.4) lives in `@fan/api-gateway`, which
 * does NOT depend on `@seaagents/fan-coding-agent`. To avoid introducing a
 * cross-package dependency, the mutex is implemented here, next to its
 * consumer. Deviation from the roadmap is documented and approved.
 *
 * Guarantees:
 * - `acquire()`/`release()` manage the internal locked state.
 * - Waiters are served in FIFO order.
 * - `withLock(fn)` acquires the lock, runs `fn`, and ALWAYS releases
 *   the lock in a `finally` block; the result (or exception) of `fn`
 *   is propagated to the caller.
 */

/** Resolve callback for a pending waiter in the FIFO queue. */
type PromiseResolver = () => void;

export class Mutex {
	private locked = false;
	private queue: PromiseResolver[] = [];

	/** Acquire the lock. Resolves immediately if free, otherwise waits in FIFO order. */
	async acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true;
			return;
		}
		await new Promise<void>((resolve) => {
			this.queue.push(resolve);
		});
	}

	/** Release the lock and wake the next waiter (FIFO), if any. */
	release(): void {
		const next = this.queue.shift();
		if (next) {
			// Ownership is handed directly to the next waiter; `locked` stays true.
			next();
		} else {
			this.locked = false;
		}
	}

	/**
	 * Run `fn` inside the critical section.
	 * Acquires the lock, executes `fn`, releases the lock in `finally`,
	 * and returns (or rethrows) the outcome of `fn`.
	 */
	async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}
