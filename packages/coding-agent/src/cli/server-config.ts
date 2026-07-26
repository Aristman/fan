import { homedir } from "node:os";
import { join } from "node:path";
import { isPublicMode } from "@fan/api-gateway";

/**
 * Server configuration resolution (server mode).
 *
 * Priority: CLI flag > environment variable > built-in default.
 */

export const DEFAULT_SERVER_PORT = 3456;
export const DEFAULT_SERVER_HOST = "localhost";

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

/**
 * Resolve the server bind host.
 *
 * Priority: `--host` CLI flag > `HOST` env var > default ("localhost").
 * An unset, empty, or whitespace-only `HOST` is ignored.
 * Any non-empty string is accepted as-is (hostname, IPv4, IPv6).
 */
export function resolveHost(cliHost?: string, envHost: string | undefined = process.env.HOST): string {
	if (cliHost !== undefined) {
		return cliHost;
	}
	const trimmed = envHost?.trim();
	if (trimmed) {
		return trimmed;
	}
	return DEFAULT_SERVER_HOST;
}

/**
 * Resolve the default workspace root for server mode (F-1.11).
 *
 * Priority: `FAN_WORKSPACE_ROOT` env var > built-in default (`~/projects`).
 * An unset, empty, or whitespace-only `FAN_WORKSPACE_ROOT` is ignored.
 *
 * Full fallback chain for session creation (applied at the call site):
 * explicit `cwd` in the request > `FAN_WORKSPACE_ROOT` > `~/projects`.
 *
 * The resolved directory is NOT required to exist — in container deployments
 * (docker-compose sets `FAN_WORKSPACE_ROOT=/data/repos`) the path is created
 * by a volume mount. Callers should warn (never fail) when it is missing.
 *
 * `home` is injectable for tests.
 */
export function resolveWorkspaceRoot(
	envValue: string | undefined = process.env.FAN_WORKSPACE_ROOT,
	home: string = homedir(),
): string {
	const trimmed = envValue?.trim();
	if (trimmed) {
		return trimmed;
	}
	return join(home, "projects");
}

/**
 * Public mode check. Re-exported from `@fan/api-gateway`; see its JSDoc for
 * the accepted `FAN_PUBLIC` values and fail-closed semantics.
 */
export { isPublicMode };

/**
 * Apply the auth policy for server mode.
 *
 * - Public mode (`FAN_PUBLIC=1`): auth is mandatory — `FAN_NO_AUTH` is removed
 *   from the environment so it is ignored even if set explicitly.
 * - Local mode (default): `FAN_NO_AUTH=1` is set automatically unless already
 *   present (legacy behavior — local server requires no auth).
 */
export function applyAuthPolicy(env: NodeJS.ProcessEnv = process.env): void {
	if (isPublicMode(env.FAN_PUBLIC)) {
		delete env.FAN_NO_AUTH;
		return;
	}
	if (!env.FAN_NO_AUTH) {
		env.FAN_NO_AUTH = "1";
	}
}
