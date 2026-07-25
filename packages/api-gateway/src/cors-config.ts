// ============================================================================
// CORS Configuration (F-0.4)
// ============================================================================

/** Default allowed origins — full openness for local dev (backward compatibility). */
export const DEFAULT_ALLOWED_ORIGINS = ["*"];

/**
 * Resolve the list of allowed CORS origins from `ALLOWED_ORIGINS`.
 *
 * The env var is a comma-separated list (whitespace around entries is
 * trimmed, empty entries are dropped). When unset or empty after parsing,
 * falls back to `DEFAULT_ALLOWED_ORIGINS` (`["*"]`) — local dev behavior.
 *
 * @example
 *   ALLOWED_ORIGINS="https://a.com, https://b.com" → ["https://a.com", "https://b.com"]
 *   (unset) → ["*"]
 */
export function resolveAllowedOrigins(envOrigins: string | undefined = process.env.ALLOWED_ORIGINS): string[] {
	if (envOrigins === undefined) {
		return [...DEFAULT_ALLOWED_ORIGINS];
	}
	const origins = envOrigins
		.split(",")
		.map((o) => o.trim())
		.filter((o) => o.length > 0);
	return origins.length > 0 ? origins : [...DEFAULT_ALLOWED_ORIGINS];
}

/**
 * Build the `origin` option for Hono's cors middleware.
 *
 * - If the resolved list contains `*`, returns the string `"*"` (full openness).
 * - Otherwise returns the array — Hono reflects the request Origin only when
 *   it matches an entry; disallowed origins get no `Access-Control-Allow-Origin`
 *   header at all (browser blocks the response).
 */
export function resolveCorsOrigin(envOrigins: string | undefined = process.env.ALLOWED_ORIGINS): string | string[] {
	const origins = resolveAllowedOrigins(envOrigins);
	return origins.includes("*") ? "*" : origins;
}
