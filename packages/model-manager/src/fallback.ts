import type { FallbackChainOptions, FallbackConfig, FallbackResult, ModelRoute } from "./types.js";
import { FallbackError } from "./types.js";

const DEFAULT_CONFIG: FallbackConfig = {
	maxRetries: 1,
	retryableErrors: [
		"rate_limit",
		"rate limit",
		"429",
		"timeout",
		"timed out",
		"overloaded",
		"503",
		"500",
		"502",
		"bad gateway",
		"service unavailable",
		"too many requests",
		"capacity",
		"ECONNRESET",
		"ECONNREFUSED",
		"ENOTFOUND",
	],
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	backoffFactor: 2,
};

export class FallbackChain {
	private config: FallbackConfig;

	constructor(options?: FallbackChainOptions) {
		this.config = { ...DEFAULT_CONFIG, ...options?.config };
	}

	/**
	 * Execute a function with fallback retry logic.
	 * Tries the primary route first, then fallback routes on retryable errors.
	 *
	 * @param primaryRoute - The primary route to try first
	 * @param fallbackRoutes - Array of fallback routes to try on failure
	 * @param fn - Async function to execute with a route
	 * @param config - Optional per-execution config overrides
	 * @returns FallbackResult with the successful route and result
	 * @throws FallbackError if all routes are exhausted
	 */
	async execute<T>(
		primaryRoute: ModelRoute,
		fallbackRoutes: ModelRoute[],
		fn: (route: ModelRoute) => Promise<T>,
		config?: Partial<FallbackConfig>,
	): Promise<FallbackResult<T>> {
		const execConfig = { ...this.config, ...config };
		const allRoutes = [primaryRoute, ...fallbackRoutes];
		const maxAttempts = Math.min(allRoutes.length, execConfig.maxRetries + 1);
		const errors: Array<{ route: ModelRoute; error: unknown }> = [];

		for (let i = 0; i < maxAttempts; i++) {
			const route = allRoutes[i];

			try {
				const result = await fn(route);
				return {
					route,
					attempts: i + 1,
					result,
				};
			} catch (error) {
				errors.push({ route, error });

				// If this is the last attempt, throw FallbackError
				if (i === maxAttempts - 1) {
					throw new FallbackError(allRoutes.slice(0, maxAttempts), errors);
				}

				// Classify error — if not retryable, throw immediately
				if (!this.isRetryable(error, execConfig)) {
					throw new FallbackError(allRoutes.slice(0, i + 1), errors);
				}

				// Wait with exponential backoff + jitter before next attempt
				const delay = this.calculateDelay(i, execConfig);
				await this.sleep(delay);
			}
		}

		// Should not reach here, but just in case
		throw new FallbackError(allRoutes.slice(0, maxAttempts), errors);
	}

	/**
	 * Classify an error as retryable or permanent.
	 */
	classifyError(error: unknown): "retryable" | "permanent" | "unknown" {
		return this.isRetryable(error, this.config) ? "retryable" : "permanent";
	}

	/**
	 * Check if an error is retryable based on message/content patterns.
	 */
	private isRetryable(error: unknown, config: FallbackConfig): boolean {
		if (!error) return false;

		const errorStr = this.stringifyError(error);
		if (!errorStr) return false;

		const lower = errorStr.toLowerCase();

		for (const pattern of config.retryableErrors) {
			if (lower.includes(pattern.toLowerCase())) {
				return true;
			}
		}

		// Check for common error object shapes
		// OpenAI/Anthropic style: error.status or error.statusCode
		const errorObj = error as any;
		const status = errorObj?.status ?? errorObj?.statusCode ?? errorObj?.code;
		if (typeof status === "number") {
			if (status === 429 || (status >= 500 && status < 600)) {
				return true;
			}
		}
		if (
			typeof status === "string" &&
			["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].includes(status.toUpperCase())
		) {
			return true;
		}

		return false;
	}

	/**
	 * Convert an error to a string for pattern matching.
	 */
	private stringifyError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		if (typeof error === "string") {
			return error;
		}
		// Try to extract message from common error shapes
		const obj = error as any;
		if (obj?.message) return String(obj.message);
		if (obj?.error?.message) return String(obj.error.message);
		if (obj?.body?.message) return String(obj.body.message);
		return String(error);
	}

	/**
	 * Calculate delay with exponential backoff + jitter.
	 */
	private calculateDelay(attempt: number, config: FallbackConfig): number {
		const baseDelay = config.baseDelayMs * config.backoffFactor ** attempt;
		const clampedDelay = Math.min(baseDelay, config.maxDelayMs);
		// Add jitter: ±25%
		const jitter = clampedDelay * 0.25;
		const delay = clampedDelay + (Math.random() * jitter * 2 - jitter);
		return Math.max(0, Math.round(delay));
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
