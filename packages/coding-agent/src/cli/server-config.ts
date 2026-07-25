/**
 * Server configuration resolution (server mode).
 *
 * Priority: CLI flag > environment variable > built-in default.
 */

export const DEFAULT_SERVER_PORT = 3456;

/**
 * Resolve the server port.
 *
 * Priority: `--port` CLI flag > `PORT` env var > default (3456).
 * An unset, empty, or non-numeric `PORT` is ignored (never yields NaN).
 */
export function resolvePort(cliPort?: number, envPort: string | undefined = process.env.PORT): number {
	if (cliPort !== undefined) {
		return cliPort;
	}
	const trimmed = envPort?.trim();
	if (trimmed) {
		const parsed = Number(trimmed);
		if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
			return parsed;
		}
	}
	return DEFAULT_SERVER_PORT;
}
