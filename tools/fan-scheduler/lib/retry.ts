import { FanApiError } from "./client.js";

/** Default total attempts per task (F-4.10). */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base backoff delay in ms (F-4.10): 2s, 4s, 8s for attempts 1..3. */
export const DEFAULT_BASE_DELAY_MS = 2000;

/** Exponential backoff formula (F-4.10): delay = baseDelayMs * 2^(attempt-1). */
export function computeBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	return baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Retryability classification (F-4.10):
 * - retryable: network errors (fetch failures/timeouts — any non-HTTP error),
 *   HTTP 5xx, HTTP 429 (rate limited);
 * - non-retryable: HTTP 4xx other than 429 — the request itself is rejected,
 *   repeating it unchanged would fail again, so fail immediately.
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof FanApiError) {
		if (error.status === 429) return true;
		if (error.status >= 500) return true;
		if (error.status >= 400 && error.status < 500) return false;
		return true;
	}
	// Network failures, timeouts and unexpected errors are transient by default.
	return true;
}

/** Thrown by withRetry when all attempts are exhausted; carries the attempt count. */
export class RetryExhaustedError extends Error {
	readonly attempts: number;
	readonly cause: unknown;

	constructor(attempts: number, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "RetryExhaustedError";
		this.attempts = attempts;
		this.cause = cause;
	}
}

/** Emitted after every failed attempt (including the final one). */
export interface RetryEvent {
	/** 1-based attempt that just failed. */
	attempt: number;
	/** Backoff delay computed for this failure (baseDelayMs * 2^(attempt-1)). */
	delayMs: number;
	/** The error that failed the attempt. */
	error: unknown;
	/** false when this was the last allowed attempt (no retry follows the delay). */
	willRetry: boolean;
}

export interface RetryOptions {
	/** Total attempts (default 3). */
	maxRetries?: number;
	/** Base backoff delay in ms (default 2000). */
	baseDelayMs?: number;
	/** Sleep override — inject for fast tests (default setTimeout-based). */
	sleep?: (ms: number) => Promise<void>;
	/** Retryability override (default isRetryableError). */
	isRetryable?: (error: unknown) => boolean;
	/** Observer called after each failed attempt — used for logging. */
	onRetry?: (event: RetryEvent) => void;
}

/** Successful outcome of withRetry: the value plus how many attempts it took. */
export interface RetryOutcome<T> {
	value: T;
	attempts: number;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff (F-4.10).
 *
 * Runs fn up to maxRetries times (default 3). After every failed attempt the
 * backoff delay `baseDelayMs * 2^(attempt-1)` (2s, 4s, 8s, …) is applied —
 * including after the final attempt, so the full 2/4/8s sequence is always
 * observed before giving up (spec TC-F-4.10-2: delays = 2s, 4s, 8s).
 *
 * - Non-retryable errors (HTTP 4xx except 429) are rethrown immediately,
 *   without any backoff delay.
 * - When all attempts fail, a RetryExhaustedError is thrown carrying the
 *   attempt count and the last error as `cause`.
 * - On success, resolves with { value, attempts }.
 */
export async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const sleep = options.sleep ?? defaultSleep;
	const isRetryable = options.isRetryable ?? isRetryableError;

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const value = await fn(attempt);
			return { value, attempts: attempt };
		} catch (error) {
			lastError = error;
			if (!isRetryable(error)) {
				throw error;
			}
			const delayMs = computeBackoffDelayMs(baseDelayMs, attempt);
			const willRetry = attempt < maxRetries;
			options.onRetry?.({ attempt, delayMs, error, willRetry });
			await sleep(delayMs);
		}
	}
	throw new RetryExhaustedError(maxRetries, lastError);
}
