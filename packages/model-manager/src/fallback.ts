import type { ModelRoute } from "./types.js";

/**
 * FallbackChain — executes a request against primary model, falls back on failure.
 *
 * Skeleton implementation: calls primary only.
 * Phase 2 will add retry logic, error classification, and multi-hop fallback.
 */
export class FallbackChain {
	execute(
		_route: ModelRoute,
		_fallback: ModelRoute | undefined,
		_fn: (route: ModelRoute) => Promise<unknown>,
	): Promise<unknown> {
		// TODO Phase 2: Implement retry + fallback logic
		// For now, just call the primary route
		return _fn(_route);
	}
}
