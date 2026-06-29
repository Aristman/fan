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
export declare function isDangerousCommand(cmd: string): string | null;
//# sourceMappingURL=permissions.d.ts.map