/**
 * withTimeout — generic Promise timeout helper (F-1.13).
 *
 * Races a promise against a timer. Returns the resolved value or throws
 * TimeoutError after `ms` milliseconds. If an external AbortSignal is
 * provided and fires before the timeout, the signal's reason is thrown.
 */

/**
 * Error thrown when a withTimeout promise exceeds the deadline.
 */
export class TimeoutError extends Error {
	constructor(ms: number) {
		super(`Operation timed out after ${ms}ms`);
		this.name = "TimeoutError";
	}
}

/**
 * Race a promise against a configurable timeout.
 *
 * @param promise - The async operation to wrap
 * @param ms - Timeout in milliseconds
 * @param signal - Optional external AbortSignal for cancellation
 * @returns The resolved value of `promise`
 * @throws {TimeoutError} If `ms` milliseconds elapse before `promise` settles
 * @throws {any} The reason of `signal` if it is aborted before timeout
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	return new Promise<T>((resolve, reject) => {
		const cleanup = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = (): void => {
			cleanup();
			reject(signal!.reason ?? new Error("Aborted"));
		};

		// If the signal is already aborted, reject immediately
		if (signal) {
			if (signal.aborted) {
				reject(signal.reason ?? new Error("Aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		// Start the timeout timer
		timer = setTimeout(() => {
			cleanup();
			reject(new TimeoutError(ms));
		}, ms);

		// Race the original promise
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(err) => {
				cleanup();
				reject(err);
			},
		);
	});
}
