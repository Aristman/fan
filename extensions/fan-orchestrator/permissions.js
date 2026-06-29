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
 * Check common patterns on a plain text string.
 */
function checkPatterns(text) {
    // 1. rm recursive + force (any flag ordering)
    if (/\brm\s+.*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive).*\s+.*(?:-[a-zA-Z]*f[a-zA-Z]*|--force)/i.test(text) ||
        /\brm\s+.*(?:-[a-zA-Z]*f[a-zA-Z]*|--force).*\s+.*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i.test(text)) {
        return "Recursive forced delete (rm -rf)";
    }
    // Also catch rm -rf (combined short flags)
    if (/\brm\s+.*-[a-zA-Z]*rf[a-zA-Z]*/i.test(text) || /\brm\s+.*-[a-zA-Z]*fr[a-zA-Z]*/i.test(text)) {
        return "Recursive forced delete (rm -rf)";
    }
    // 2. git push --force
    if (/\bgit\s+push\s+.*(?:--force\b|-f\b|--force-with-lease\b)/i.test(text)) {
        return "Force push to remote";
    }
    // 3. npm/yarn/pnpm publish
    if (/\b(?:npm|yarn|pnpm)\s+publish\b/i.test(text)) {
        return "Publishing package to registry";
    }
    // 4. SQL destructive operations
    if (/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(text) || /\bDELETE\s+FROM\b/i.test(text)) {
        return "Destructive SQL operation";
    }
    // 5. Disk format (mkfs, mkfs.ext4, mkfs.xfs, fdisk, format)
    if (/\b(?:format|fdisk)\s/i.test(text) || /\bmkfs(?:\.\w+)?\s/i.test(text)) {
        return "Disk format/partition operation";
    }
    // 6. System shutdown/reboot
    if (/\b(?:shutdown|reboot|halt|poweroff)\b/i.test(text) && !/\bservice\b/i.test(text)) {
        return "System power operation";
    }
    // 7. chmod/chown recursive on root
    if (/\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b.*\/(?:\s|$)/i.test(text)) {
        return "Recursive permission change on root directory";
    }
    // 8. find -delete
    if (/\bfind\b.*\s-delete\b/i.test(text)) {
        return "Find with delete operation";
    }
    return null;
}

/**
 * Strip quoted content from a command to avoid false positives
 * from commands like echo "rm -rf /" or grep "rm -rf" log.txt.
 */
function stripQuotes(cmd) {
    return cmd
        .replace(/'(?:[^'\\]|\\.)*'/g, '""')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Extract inner command from subshell invocations:
 * bash -c "rm -rf /", sh -c 'mkfs.ext4 /dev/sda1', eval 'rm -rf /'
 */
function extractSubshell(cmd) {
    // Match: bash -c "...", sh -c '...', zsh -c "...", eval '...'
    const match = cmd.match(/(?:bash|sh|zsh)\s+-c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i)
        || cmd.match(/\beval\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i);
    if (match) {
        return (match[1] || match[2] || match[3] || "").trim();
    }
    return null;
}

/**
 * Check whether a shell command is dangerous.
 *
 * Detection order:
 *  1. Strip quotes → check patterns (catches bash -c "rm -rf /" after stripping inner quotes)
 *  2. Extract subshell → check inner command (catches bash -c 'rm -rf /')
 *  3. Check original command (catches bare rm -rf / without quotes)
 *
 * @param cmd - The raw command string to evaluate.
 * @returns A human-readable danger reason, or `null` if the command is safe.
 */
export function isDangerousCommand(cmd, customPatterns = []) {
    // 0. Check custom patterns from config.dangerousCommands
    for (const pattern of customPatterns) {
        if (typeof pattern === "string" && pattern) {
            // Simple substring match for custom entries
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            try {
                if (new RegExp(`\\b${escaped}\\b`, "i").test(cmd)) {
                    return `Custom dangerous command: ${pattern}`;
                }
            } catch { /* skip invalid patterns */ }
        }
    }

    // 1. Check stripped version first (removes quoted content like echo "rm -rf /")
    const stripped = stripQuotes(cmd);
    const strippedResult = checkPatterns(stripped);
    if (strippedResult) return strippedResult;

    // 2. Check subshell/eval inner command
    const subshell = extractSubshell(cmd);
    if (subshell) {
        const subResult = checkPatterns(subshell);
        if (subResult) return `Subshell: ${subResult}`;
    }

    return null;
}
//# sourceMappingURL=permissions.js.map
