/**
 * Dangerous command detection for the Orchestrator.
 *
 * Provides a single exported function `isDangerousCommand` that inspects
 * a bash/shell command string and returns a human-readable reason if the
 * command is considered dangerous, or `null` when it appears safe.
 *
 * Covered danger categories:
 *  1. `rm -rf` — recursive forced delete
 *  2. `git push --force` — force push to remote
 *  3. `npm|yarn|pnpm publish` — publishing to a registry
 *  4. SQL destructive ops — DROP / TRUNCATE / DELETE FROM
 *  5. Disk format/partition — format, mkfs, fdisk
 *  6. System power — shutdown, reboot, halt, poweroff
 *  7. Recursive chmod/chown on root
 *  8. `find -delete`
 */

/**
 * Check whether a shell command is dangerous.
 *
 * @param cmd - The raw command string to evaluate.
 * @returns A human-readable danger reason, or `null` if the command is safe.
 */
export function isDangerousCommand(cmd: string): string | null {
	// Strip quoted content to avoid false positives from grep/echo/cat of dangerous strings
	const stripped = cmd.replace(/'(?:[^'\\]|\\.)*'/g, '""').replace(/"(?:[^"\\]|\\.)*"/g, '""');

	// 1. rm recursive + force (any flag ordering)
	if (
		/\brm\s+.*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive).*\s+.*(?:-[a-zA-Z]*f[a-zA-Z]*|--force)/i.test(stripped) ||
		/\brm\s+.*(?:-[a-zA-Z]*f[a-zA-Z]*|--force).*\s+.*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i.test(stripped)
	) {
		return "Recursive forced delete (rm -rf)";
	}
	// Also catch rm -rf (combined short flags)
	if (/\brm\s+.*-[a-zA-Z]*rf[a-zA-Z]*/i.test(stripped) || /\brm\s+.*-[a-zA-Z]*fr[a-zA-Z]*/i.test(stripped)) {
		return "Recursive forced delete (rm -rf)";
	}

	// 2. git push --force
	if (/\bgit\s+push\s+.*(?:--force\b|-f\b|--force-with-lease\b)/i.test(stripped)) {
		return "Force push to remote";
	}

	// 3. npm/yarn/pnpm publish
	if (/\b(?:npm|yarn|pnpm)\s+publish\b/i.test(stripped)) {
		return "Publishing package to registry";
	}

	// 4. SQL destructive operations
	if (/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(stripped) || /\bDELETE\s+FROM\b/i.test(stripped)) {
		return "Destructive SQL operation";
	}

	// 5. Disk format
	if (/\b(?:format|mkfs|fdisk)\s/i.test(stripped)) {
		return "Disk format/partition operation";
	}

	// 6. System shutdown/reboot
	if (/\b(?:shutdown|reboot|halt|poweroff)\b/i.test(stripped) && !/\bservice\b/i.test(stripped)) {
		return "System power operation";
	}

	// 7. chmod/chown recursive on root
	if (/\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b.*\/(?:\s|$)/i.test(stripped)) {
		return "Recursive permission change on root directory";
	}

	// 8. find -delete
	if (/\bfind\b.*\s-delete\b/i.test(stripped)) {
		return "Find with delete operation";
	}

	return null;
}
